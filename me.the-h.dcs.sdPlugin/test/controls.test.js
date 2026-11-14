const test = require("node:test");
const assert = require("node:assert/strict");
const c = require("../lib/controls.js");

// Raw elements in the shape lua/scan.lua returns.
const el = (id, hint, cls, extra) => ({ id, hint, device: 7, class: cls, ...extra });
const toggle = el("t", "Master Arm Switch, ARM/SAFE", ["TUMB", "TUMB"], { action: [3001, 3001], arg: [10, 10], arg_value: [-1, 1], arg_lim: [[0, 1], [0, 1]] });
const threeWay = el("w", "Battery Switch, ON/OFF/ORIDE", ["TUMB", "TUMB"], { action: [3002, 3002], arg: [11, 11], arg_value: [-1, 1], arg_lim: [[-1, 1], [-1, 1]] });
const rotary = el("r", "INS Knob, OFF/CV/GND/NAV", ["TUMB", "TUMB"], { action: [3003, 3003], arg: [12, 12], arg_value: [-0.1, 0.1], arg_lim: [[0, 0.3], [0, 0.3]] });
const button = el("b", "Reset Button - Push to reset", ["BTN"], { action: [3004], stop_action: [3004], arg: [13], arg_value: [1], arg_lim: [[0, 1]], release: [true] });
const spring = el("s", "Crank Switch, LEFT/OFF/RIGHT", ["BTN", "BTN"], { action: [3005, 3006], stop_action: [3005, 3006], arg: [14, 14], arg_value: [-1, 1], arg_lim: [[-1, 0], [0, 1]], release: [true, true] });
const gear = el("g", "Gear Handle, (RMB)UP/(LMB)DOWN", ["TUMB", "TUMB", "LEV"], { action: [3007, 3008, 3009], arg: [20, 20, 21], arg_value: [-1, 1, 1], arg_lim: [[0, 1], [0, 1], [0, 1]], gain: [1, 1, -1], relative: [false, false, true] });
const volume = el("v", "Volume Knob", ["LEV"], { action: [3010], arg: [30], arg_value: [0], arg_lim: [[0, 1]], gain: [0.1], relative: [false] });
const baro = el("p", "Altimeter Pressure Knob", ["LEV"], { action: [3011], arg: [31], arg_value: [0.04], arg_lim: [[0, 1]], gain: [0.2], relative: [true] });
const channel = el("k", "COMM 1 Channel Knob", ["BTN", "LEV"], { action: [3012, 3013], stop_action: [3012, 0], arg: [32, 33], arg_value: [1, 1], arg_lim: [[0, 1], [0, 1]], gain: [1, 0.2], relative: [false, true], release: [true, false] });

const at = (map) => (arg) => map[arg];
const click = (action, value) => ({ device: 7, action, value });

test("works out the kind of control", () => {
  assert.equal(c.describe(toggle).kind, "switch");
  assert.equal(c.describe(rotary).kind, "switch");
  assert.equal(c.describe(button).kind, "button");
  assert.equal(c.describe(spring).kind, "spring");
  assert.equal(c.describe(volume).kind, "axis");
  assert.equal(c.describe(gear).kind, "switch");
  assert.equal(c.describe(channel).kind, "button");
});

test("names positions from the hint: toggles top down, knobs low to high", () => {
  assert.deepEqual(c.describe(toggle).names, { 0: "SAFE", 1: "ARM" });
  assert.deepEqual(c.describe(threeWay).names, { "-1": "ORIDE", 0: "OFF", 1: "ON" });
  assert.deepEqual(c.describe(rotary).names, { 0: "OFF", 0.1: "CV", 0.2: "GND", 0.3: "NAV" });
  assert.equal(c.describe(gear).names, undefined, "hints with mouse-button notes aren't guessed");
  assert.deepEqual(c.describe(gear, {}, { positions: { 0: "UP", 1: "DOWN" } }).names, { 0: "UP", 1: "DOWN" });
});

test("short labels drop the switch type and positions", () => {
  assert.equal(c.shortLabel("Master Arm Switch, ARM/SAFE"), "Master Arm");
  assert.equal(c.shortLabel("Reset Button - Push to reset"), "Reset");
  assert.equal(c.shortLabel("COMM 1 Channel Selector Knob"), "COMM 1 Channel");
});

test("a key press flips a toggle and cycles a multi-position switch", () => {
  const t = c.describe(toggle);
  assert.deepEqual(c.press(t, at({ 10: 0 })), [click(3001, 1)]);
  assert.deepEqual(c.press(t, at({ 10: 1 })), [click(3001, 0)]);
  const w = c.describe(threeWay);
  assert.deepEqual(c.press(w, at({ 11: 1 })), [click(3002, -1)], "wraps round");
  assert.deepEqual(c.press(w, at({ 11: 0 }), { mode: "next" }), [click(3002, 1)]);
  assert.deepEqual(c.press(w, at({ 11: 1 }), { mode: "next" }), [], "next stops at the end");
  assert.deepEqual(c.press(w, at({ 11: 1 }), { mode: "prev" }), [click(3002, 0)]);
  assert.deepEqual(c.press(c.describe(rotary), at({ 12: 0.1 }), { mode: "set", position: "0.3" }), [click(3003, 0.3)]);
  assert.deepEqual(c.release(t), [], "switches send nothing on release");
});

test("switches with separate up and down actions use the one for the direction", () => {
  const g = c.describe(gear);
  assert.deepEqual(c.press(g, at({ 20: 0 })), [click(3008, 1)]);
  assert.deepEqual(c.press(g, at({ 20: 1 })), [click(3007, 0)]);
  assert.deepEqual(c.rotate(g, at({ 20: 1 }), -1), [click(3007, 0)], "a dial steps the handle, not its emergency pull");
});

test("buttons and spring-loaded switches are held while the key is", () => {
  const b = c.describe(button);
  assert.deepEqual(c.press(b, at({})), [click(3004, 1)]);
  assert.deepEqual(c.release(b), [click(3004, 0)]);
  const s = c.describe(spring);
  assert.deepEqual(c.press(s, at({}), { mode: "side:1" }), [click(3006, 1)]);
  assert.deepEqual(c.release(s, { mode: "side:1" }), [click(3006, 0)]);
  assert.deepEqual(c.press(s, at({}), { mode: "side:0" }), [click(3005, -1)]);
});

test("dials turn absolute knobs within their range and relative ones by a delta", () => {
  const v = c.describe(volume);
  assert.deepEqual(c.rotate(v, at({ 30: 0.5 }), 2), [click(3010, 0.7)]);
  assert.deepEqual(c.rotate(v, at({ 30: 0.95 }), 3), [click(3010, 1)]);
  assert.deepEqual(c.rotate(v, at({ 30: 1 }), 1), [], "already at the end");
  assert.deepEqual(c.rotate(v, at({ 30: 0.5 }), -1, { step: 0.25 }), [click(3010, 0.25)]);
  const p = c.describe(baro);
  assert.deepEqual(c.rotate(p, at({}), -3), [click(3011, -0.12)]);
  const k = c.describe(channel);
  assert.deepEqual(c.rotate(k, at({}), 1), [click(3013, 1)], "channel knob turns its relative axis");
  assert.deepEqual(c.press(k, at({}), { mode: "side:0" }), [click(3012, 1)], "and pushes its button");
  assert.deepEqual(c.release(k, { mode: "side:0" }), [click(3012, 0)]);
});

test("latch mode presses a held switch and leaves it, pressing again lets it go", () => {
  const s = c.describe(spring);
  assert.deepEqual(c.press(s, at({ 14: 0 }), { mode: "latch:1" }), [click(3006, 1)]);
  assert.deepEqual(c.release(s, { mode: "latch:1" }), [], "nothing on letting go of the key");
  assert.deepEqual(c.press(s, at({ 14: 1 }), { mode: "latch:1" }), [click(3006, 0)], "already there: back to off");
  assert.deepEqual(c.press(s, at({ 14: -1 }), { mode: "latch:1" }), [click(3006, 1)], "on the other side: still goes to this one");
});

test("a dial nudges a spring-loaded rocker once per click, then lets go", () => {
  const s = c.describe(spring);
  const up = c.rotate(s, at({}), 2);
  assert.equal(up.length, 2);
  assert.deepEqual(up[0], { ...click(3006, 1), release: click(3006, 0) });
  assert.deepEqual(c.rotate(s, at({}), -1), [{ ...click(3005, -1), release: click(3005, 0) }]);
});

test("shows state: on/off, position names, percentages and bars", () => {
  const t = c.describe(toggle);
  assert.equal(c.isOn(t, 1), true);
  assert.equal(c.isOn(t, 0), false);
  assert.equal(c.format(t, 1), "ARM");
  const w = c.describe(threeWay);
  assert.equal(c.isOn(w, -1), true, "anything but the off position counts as on");
  assert.equal(c.format(w, 0.02), "OFF", "values snap to the nearest position");
  const v = c.describe(volume);
  assert.equal(c.format(v, 0.25), "25%");
  assert.equal(c.level(v, 0.25), 0.25);
  assert.equal(c.level(t, 1), null, "no bar for two-position switches");
  assert.equal(c.format(c.describe(button), 1), "ON");
  assert.equal(c.format(t, undefined), "—");
});

test("reads an altimeter setting from drums with their own ranges", () => {
  const kollsman = { type: "drums", drums: [{ arg: 223, min: 26, max: 31 }, { arg: 222, min: 0, max: 10 }, { arg: 221, min: 0, max: 10 }], decimals: 2 };
  assert.equal(c.displayValue(kollsman, at({ 223: 0.6, 222: 0.9, 221: 0.2 })), "29.92");
  assert.equal(c.displayValue(kollsman, at({ 223: 0.6, 222: 0.999, 221: 0.0 })), "29.00", "a tenths drum at the end of its turn reads 0");
  assert.equal(c.displayValue(kollsman, at({ 223: 0.8, 222: 0.0, 221: 0.1 })), "30.01");
  assert.equal(c.displayValue(kollsman, at({ 223: 0.6, 222: 0.9 })), null, "unknown until every drum is in");
});

test("reads a value from drum arguments", () => {
  const value = at({ 1: 0.2, 2: 0.9, 3: 0.9, 4: 0.2 });
  assert.equal(c.displayValue({ type: "digits", args: [1, 2, 3, 4], decimals: 2 }, value), "29.92");
  assert.equal(c.displayValue({ type: "digits", args: [1, 9] }, value), null, "unknown until every drum is known");
});

test("lists lamps first, with readable labels", () => {
  const lights = c.lightsOf([
    { arg: 5, name: "Airspeed", source: "mainpanel_init.lua" },
    { arg: 9, name: "CPT_LTS_MASTER_CAUTION", source: "lamps.lua" },
  ], { 9: { color: "amber" } });
  assert.deepEqual(lights.map((l) => [l.arg, l.label, l.lamp, l.color]), [[9, "MASTER CAUTION", true, "amber"], [5, "Airspeed", false, null]]);
});
