const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { LUA_DIR, lua, needLua } = require("./helpers.js");

function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-hook-"));
  const r = spawnSync(lua, [path.join(__dirname, "hook_driver.lua"), path.join(LUA_DIR, "hook.lua"), tmp], { encoding: "utf8" });
  fs.rmSync(tmp, { recursive: true });
  assert.equal(r.status, 0, r.stderr);
  // group output lines by step
  const steps = {};
  let cur = "load";
  for (const line of r.stdout.trim().split("\n")) {
    if (line.startsWith("-- ")) { cur = line.slice(3); steps[cur] = []; } else (steps[cur] ||= []).push(line);
  }
  return steps;
}

test("keeps the export functions defined before it", needLua, () => {
  const s = run();
  assert.equal(s.start[0], "PREV start");
  assert.equal(s["no aircraft"][0], "PREV after");
  assert.equal(s.start.filter((l) => l === "PREV start").length, 1, "loading twice must not chain twice");
});

test("says hello, streams watched arguments and only sends changes", needLua, () => {
  const s = run();
  assert.ok(s.start.includes("BIND 127.0.0.1 7791"));
  assert.ok(s["no aircraft"].includes("SEND 7790 H - 1"));
  assert.ok(s["in aircraft"].includes("SEND 7790 H TestJet 1"));
  assert.ok(s["in aircraft"].includes("SEND 7790 A 49=1 50=0.5"));
  assert.deepEqual(s.unchanged, ["PREV after"]);
  assert.ok(s.changed.includes("SEND 7790 A 49=0"));
  assert.deepEqual(s["too soon"], ["PREV after"], "sends at most `rate` times a second");
  assert.ok(s.stop.includes("SEND 7790 H - 1"));
});

test("runs clickable actions and reports what DCS offers", needLua, () => {
  const s = run();
  assert.ok(s["in aircraft"].includes("CLICK 23 3003 1"));
  assert.ok(s["in aircraft"].some((l) => l.startsWith("SEND 7790 L caps GetDevice=true")));
});

test("finds a display by its marker and sends its text when it changes", needLua, () => {
  const s = run();
  assert.ok(s["in aircraft"].includes("SEND 7790 T ufc "), "named after the watch, not DCS's runtime id");
  assert.ok(s["in aircraft"].includes(" 7"));
  assert.ok(s["text changed"].includes(" 8"));
  assert.ok(!s.unchanged.some((l) => l.startsWith("SEND 7790 T")), "unchanged text isn't sent again");
});

test("reports height above ground, airspeed and ground speed, '-' when unknown", needLua, () => {
  const s = run();
  assert.ok(s["in aircraft"].includes("SEND 7790 F agl=0.5 ias=- gs=-"), "no speed before a second position");
  assert.ok(s["text changed"].includes("SEND 7790 F agl=0.5 ias=- gs=10"), "ground speed from position changes");
});
