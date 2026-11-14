// Finding DCS World and installing the cockpit hook into its Saved Games folder.
//
// DCS is found through Steam's library list each time (games move between drives), or through
// paths set in the plugin's settings. The hook goes in Saved Games/DCS/Scripts/deckd/ and is loaded
// by one line appended to Scripts/Export.lua, so any other export scripts keep working.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const DCS_APP_ID = 223750;
const MARKER = "-- deckd cockpit hook (me.the-h.dcs)";
const LOAD_LINE = `local ok, err = pcall(function() dofile(lfs.writedir() .. [[Scripts\\deckd\\hook.lua]]) end) if not ok and log and log.write then log.write("DECKD", log.ERROR, tostring(err)) end ${MARKER}`;
const HOOK_FILES = ["hook.lua", "scan.lua"];

const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// Steam library folders listed in libraryfolders.vdf (Steam's own folder is one of them).
function steamLibraries(home = os.homedir()) {
  const roots = [
    path.join(home, ".local/share/Steam"),
    path.join(home, ".steam/steam"),
    path.join(home, ".steam/root"),
    path.join(home, ".var/app/com.valvesoftware.Steam/.local/share/Steam"),
    "C:/Program Files (x86)/Steam",
  ];
  const libs = [];
  const add = (p) => { if (p && !libs.includes(p) && isDir(p)) libs.push(p); };
  for (const root of roots) {
    let text;
    try { text = fs.readFileSync(path.join(root, "steamapps/libraryfolders.vdf"), "utf8"); } catch { continue; }
    for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) add(m[1].replace(/\\\\/g, "\\"));
  }
  return libs;
}

// -> { root, savedGames } with whatever was found (either may be null).
function locate(settings = {}, home = os.homedir()) {
  let root = settings.dcsRoot && isDir(settings.dcsRoot) ? settings.dcsRoot : null;
  let savedGames = settings.savedGames && isDir(settings.savedGames) ? settings.savedGames : null;
  // The library holding DCS's app manifest is where Steam says the game is; try it first (while a
  // game is being moved to another drive, both drives have a copy).
  const hasManifest = (lib) => exists(path.join(lib, `steamapps/appmanifest_${DCS_APP_ID}.acf`));
  const libs = steamLibraries(home).sort((a, b) => hasManifest(b) - hasManifest(a));
  if (!root) {
    for (const lib of libs) {
      const p = path.join(lib, "steamapps/common/DCSWorld");
      if (isDir(path.join(p, "Mods"))) { root = p; break; }
    }
  }
  if (!savedGames && process.platform === "win32") {
    for (const name of ["DCS", "DCS.openbeta"]) {
      const p = path.join(home, "Saved Games", name);
      if (isDir(p)) { savedGames = p; break; }
    }
  }
  if (!savedGames) {
    // Prefer the library that holds the game itself; Proton keeps the prefix next to it.
    const ordered = root ? [...libs].sort((a, b) => (root.startsWith(b) ? 1 : 0) - (root.startsWith(a) ? 1 : 0)) : libs;
    for (const lib of ordered) {
      const base = path.join(lib, `steamapps/compatdata/${DCS_APP_ID}/pfx/drive_c/users/steamuser/Saved Games`);
      for (const name of ["DCS", "DCS.openbeta"]) {
        if (isDir(path.join(base, name))) { savedGames = path.join(base, name); break; }
      }
      if (savedGames) break;
    }
  }
  return { root, savedGames };
}

// Settings the hook reads (ports and rate), as a Lua file.
function configLua({ sendPort = 7790, listenPort = 7791, rate = 30 } = {}) {
  return `-- Written by the deckd DCS plugin; changes here are overwritten.\nreturn { host = "127.0.0.1", send_port = ${Number(sendPort)}, listen_port = ${Number(listenPort)}, rate = ${Number(rate)} }\n`;
}

// -> "missing" | "installed" | "outdated" | "unlinked" (files there, Export.lua line missing)
function status(savedGames, luaDir) {
  if (!savedGames) return "missing";
  const scripts = path.join(savedGames, "Scripts");
  const dir = path.join(scripts, "deckd");
  let exportText = "";
  try { exportText = fs.readFileSync(path.join(scripts, "Export.lua"), "utf8"); } catch {}
  const linked = exportText.includes(MARKER);
  const filesThere = HOOK_FILES.every((f) => exists(path.join(dir, f)));
  if (!linked && !filesThere) return "missing";
  if (!linked) return "unlinked";
  if (!filesThere) return "outdated";
  for (const f of HOOK_FILES) {
    try {
      if (fs.readFileSync(path.join(dir, f), "utf8") !== fs.readFileSync(path.join(luaDir, f), "utf8")) return "outdated";
    } catch { return "outdated"; }
  }
  return "installed";
}

// Install or repair: copy the hook, write its settings, and add the load line to Export.lua.
// Returns a short description of what changed.
function install(savedGames, luaDir, options = {}) {
  if (!savedGames || !isDir(savedGames)) throw new Error("DCS Saved Games folder not found");
  const scripts = path.join(savedGames, "Scripts");
  const dir = path.join(scripts, "deckd");
  fs.mkdirSync(dir, { recursive: true });
  for (const f of HOOK_FILES) fs.copyFileSync(path.join(luaDir, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, "config.lua"), configLua(options));

  const exportPath = path.join(scripts, "Export.lua");
  let text = null;
  try { text = fs.readFileSync(exportPath, "utf8"); } catch {}
  if (text == null) {
    fs.writeFileSync(exportPath, `${LOAD_LINE}\n`);
    return "created Export.lua";
  }
  if (text.includes(MARKER)) {
    // Refresh the line in case it changed between versions.
    const lines = text.split(/\r?\n/).map((l) => (l.includes(MARKER) ? LOAD_LINE : l));
    const updated = lines.join(text.includes("\r\n") ? "\r\n" : "\n");
    if (updated !== text) fs.writeFileSync(exportPath, updated);
    return "updated the hook";
  }
  const backup = `${exportPath}.before-deckd`;
  if (!exists(backup)) fs.copyFileSync(exportPath, backup);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const sep = text.length && !text.endsWith("\n") ? eol : "";
  fs.writeFileSync(exportPath, `${text}${sep}${LOAD_LINE}${eol}`);
  return "added the hook to your Export.lua (backup: Export.lua.before-deckd)";
}

// Remove our line and folder; Export.lua is deleted only if nothing else is left in it.
function uninstall(savedGames) {
  if (!savedGames) return "nothing to remove";
  const scripts = path.join(savedGames, "Scripts");
  const exportPath = path.join(scripts, "Export.lua");
  let text = null;
  try { text = fs.readFileSync(exportPath, "utf8"); } catch {}
  if (text != null && text.includes(MARKER)) {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const rest = text.split(/\r?\n/).filter((l) => !l.includes(MARKER)).join(eol);
    if (rest.trim() === "") fs.rmSync(exportPath);
    else fs.writeFileSync(exportPath, rest.endsWith(eol) ? rest : rest + eol);
  }
  fs.rmSync(path.join(scripts, "deckd"), { recursive: true, force: true });
  return "removed the hook";
}

module.exports = { DCS_APP_ID, MARKER, LOAD_LINE, steamLibraries, locate, configLua, status, install, uninstall };
