const test = require("node:test");
const assert = require("node:assert/strict");
const { runScan, findAircraft, Catalog } = require("../lib/catalog.js");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { FIXTURES, JET, LUA_DIR, needLua } = require("./helpers.js");

test("finds aircraft through make_flyable in entry.lua", () => {
  const found = findAircraft([FIXTURES]);
  assert.deepEqual([...found.keys()], ["TestJet"]);
  assert.equal(found.get("TestJet"), path.join(FIXTURES, "Mods/aircraft/TestJet/Cockpit/Scripts/"));
});

test("scans clickable elements, devices and gauges", needLua, () => {
  const raw = runScan(JET, null, LUA_DIR);
  assert.deepEqual(raw.errors, []);
  assert.deepEqual(raw.devices.map((d) => d.name), ["ELECTRIC", "WEAPONS", "GEAR", "RADIO"]);
  assert.equal(raw.elements.length, 9);
  const arm = raw.elements.find((e) => e.id === "pnt_10");
  assert.deepEqual(arm, {
    id: "pnt_10", hint: "Master Arm Switch, ARM/SAFE", device: 2, class: ["TUMB", "TUMB"], action: [3001, 3001],
    arg: [10, 10], arg_value: [-1, 1], arg_lim: [[0, 1], [0, 1]],
  });
  const channel = raw.elements.find((e) => e.id === "pnt_31");
  assert.deepEqual(channel.stop_action, [3003, 0]);
  assert.deepEqual(channel.relative, [false, true]);
});

test("names gauges by their global or by the light constant they show", needLua, () => {
  const raw = runScan(JET, null, LUA_DIR);
  const names = Object.fromEntries(raw.gauges.map((g) => [g.arg, g.name]));
  assert.deepEqual(names, { 50: "Altimeter", 51: "Baro_0", 60: "LT_MASTER_CAUTION", 61: "LT_FIRE", 62: "LT_GEAR", 70: "Console_lt" });
  assert.equal(raw.gauges.find((g) => g.arg === 60).source, "lamps.lua");
});

test("catalog saves scans and applies overlays", needLua, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-cat-"));
  const overlays = path.join(dir, "overlays");
  fs.mkdirSync(overlays);
  fs.writeFileSync(path.join(overlays, "TestJet.json"), JSON.stringify({ page: "Jet", controls: { pnt_10: { label: "ARM", core: true } }, lights: { 60: { color: "amber" } } }));
  const cat = new Catalog({ dataDir: dir, luaDir: LUA_DIR, overlayDir: overlays });
  const r = cat.scanAll({ root: null, savedGames: FIXTURES });
  assert.deepEqual(r.scanned, ["TestJet"]);
  assert.deepEqual(cat.units(), ["TestJet"]);
  const jet = cat.get("TestJet");
  assert.equal(jet.page, "Jet");
  assert.equal(jet.byId.get("pnt_10").label, "ARM");
  assert.equal(jet.byId.get("pnt_10").core, true);
  assert.equal(jet.lights.find((l) => l.arg === 60).color, "amber");
  assert.equal(jet.lights[0].lamp, true, "lamps are listed before other gauges");
  fs.rmSync(dir, { recursive: true });
});
