// Aircraft catalogs: which aircraft are installed, scanning their cockpit scripts (lua/scan.lua),
// and caching the result per DCS unit name, e.g. FA-18C_hornet.json.
//
// Scans run with a Lua found on this machine (LuaJIT or 5.1 preferred, as DCS uses 5.1). Without
// one, the hook in DCS runs the same scanner and writes Saved Games/DCS/Scripts/deckd/catalog/.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildAircraft } = require("./controls.js");

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// Unit name -> Cockpit/Scripts folder, from each aircraft mod's entry.lua:
//   make_flyable('FA-18C_hornet', current_mod_path..'/Cockpit/Scripts/', ...)
function findAircraft(modRoots) {
  const out = new Map();
  for (const root of modRoots) {
    const dir = path.join(root, "Mods/aircraft");
    let mods = [];
    try { mods = fs.readdirSync(dir); } catch { continue; }
    for (const mod of mods) {
      let text;
      try { text = fs.readFileSync(path.join(dir, mod, "entry.lua"), "utf8"); } catch { continue; }
      for (const m of text.matchAll(/make_flyable\(\s*['"]([^'"]+)['"]\s*,\s*current_mod_path\s*\.\.\s*['"]([^'"]+)['"]/g)) {
        const scripts = path.join(dir, mod, m[2]);
        if (isDir(scripts) && fs.existsSync(path.join(scripts, "clickabledata.lua")) && !out.has(m[1])) out.set(m[1], scripts);
      }
    }
  }
  return out;
}

let luaBin;
function findLua() {
  if (luaBin !== undefined) return luaBin;
  luaBin = null;
  for (const bin of ["luajit", "lua5.1", "lua"]) {
    const r = spawnSync(bin, ["-v"], { encoding: "utf8", timeout: 3000 });
    if (!r.error) { luaBin = bin; break; }
  }
  return luaBin;
}

function runScan(scriptsDir, dcsRoot, luaDir) {
  const lua = findLua();
  if (!lua) throw new Error("no Lua interpreter (install luajit or lua5.1)");
  const r = spawnSync(lua, [path.join(luaDir, "scan.lua"), scriptsDir, dcsRoot || ""], { encoding: "utf8", timeout: 30000, maxBuffer: 64 << 20 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || "scan failed").trim().split("\n").pop());
  return JSON.parse(r.stdout);
}

// Display pushbutton legends, per display page script, in the order the script creates them:
//   [{ occ: [["RDR", 2], ["", 7], ["MAN", 2], ["MAN", 3], ...], named: [["RTS_Label", 5, "RTS"], ...] }, ...]
// Some cockpits (the F/A-18C's DDIs and AMPCD) place a button's legend with
//   add_PB_label(<button number>, {"<legend>", ...}, {"<second line>", ...})
// in one script per display page; only the first, main legend is taken ("" when the display fills
// it in while flying). A few legends are drawn straight at a button's position instead
// (addStrokeText("RTS_Label", "RTS", ..., {PB_positions[5][1] ...})); those are kept by element name.
// Read as text: nothing runs.
function pbLabelsFrom(scriptsDir) {
  const pages = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith(".lua")) continue;
      let text;
      try { text = fs.readFileSync(p, "utf8"); } catch { continue; }
      if (!text.includes("PB")) continue;
      const occ = [];
      for (const m of text.matchAll(/^(?![ \t]*--)[^\n]*?\badd_PB_label\w*\(\s*(\d+)\s*,\s*(?:\{\s*)?"([^"\n]*)"/gm)) {
        const pb = Number(m[1]);
        const label = m[2].trim();
        if (pb < 1 || pb > 20 || /_|^%/.test(label)) continue;
        occ.push([label, pb]);
      }
      const named = [];
      for (const m of text.matchAll(/^(?![ \t]*--)[^\n]*?\baddStrokeText\(\s*"([^"\n]+)"\s*,\s*(?:"([^"\n]*)"|nil)[^\n]*?PB_positions\[(\d+)\]/gm)) {
        const pb = Number(m[3]);
        if (pb >= 1 && pb <= 20) named.push([m[1], pb, (m[2] || "").trim()]);
      }
      if (occ.length || named.length) pages.push({ occ, named });
    }
  };
  walk(scriptsDir);
  return pages;
}

class Catalog {
  constructor({ dataDir, luaDir, overlayDir, log = () => {} }) {
    this.dataDir = path.join(dataDir, "aircraft");
    this.luaDir = luaDir;
    this.overlayDir = overlayDir;
    this.log = log;
    this.cache = new Map(); // unit -> built aircraft
  }

  file(unit) { return path.join(this.dataDir, `${unit.replace(/[^\w.-]/g, "_")}.json`); }

  // Units with a saved scan.
  units() {
    try {
      return fs.readdirSync(this.dataDir).filter((f) => f.endsWith(".json")).map((f) => readJson(path.join(this.dataDir, f))?.unit).filter(Boolean).sort();
    } catch { return []; }
  }

  overlay(unit) { return readJson(path.join(this.overlayDir, `${unit}.json`)) || {}; }

  save(unit, raw, source) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.file(unit), JSON.stringify({ unit, source, scanned: new Date().toISOString(), ...raw }));
    this.cache.delete(unit);
  }

  // Scan every installed clickable aircraft. Returns { scanned: [units], failed: [[unit, error]] }.
  scanAll({ root, savedGames }) {
    const scanned = [], failed = [];
    const aircraft = findAircraft([savedGames, root].filter(Boolean));
    for (const [unit, dir] of aircraft) {
      try {
        const raw = runScan(dir, root, this.luaDir);
        if (!raw.elements?.length) throw new Error(raw.errors?.[0] || "no clickable elements found");
        raw.pbPages = pbLabelsFrom(dir);
        this.save(unit, raw, dir);
        scanned.push(unit);
      } catch (e) {
        failed.push([unit, e.message]);
      }
    }
    this.log(`scanned ${scanned.length} aircraft${failed.length ? `; failed: ${failed.map((f) => f.join(": ")).join(", ")}` : ""}`);
    return { scanned, failed, found: [...aircraft.keys()] };
  }

  // A scan the hook wrote inside DCS (when this machine has no Lua).
  importFromDcs(unit, savedGames) {
    const raw = savedGames && readJson(path.join(savedGames, "Scripts/deckd/catalog", `${unit}.json`));
    if (!raw?.elements?.length) return false;
    this.save(unit, raw, "dcs");
    return true;
  }

  get(unit) {
    if (!unit) return null;
    if (this.cache.has(unit)) return this.cache.get(unit);
    const raw = readJson(this.file(unit));
    if (!raw) return null;
    const built = buildAircraft(unit, raw, this.overlay(unit));
    this.cache.set(unit, built);
    return built;
  }
}

module.exports = { Catalog, findAircraft, findLua, runScan, pbLabelsFrom };
