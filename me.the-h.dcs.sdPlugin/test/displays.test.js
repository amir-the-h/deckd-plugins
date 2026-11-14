const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { legendsIn, buttonLegends } = require("../lib/displays.js");
const { pbLabelsFrom } = require("../lib/catalog.js");

// A display's parsed text: element name -> text.
const shows = (entries) => new Map(entries);

test("finds main legends in a display's elements", () => {
  const items = shows([["MENU_1__id:1", "3446"], ["RDR_1__id:57", ""], ["PRI_2__id:58", ""], ["Radar_mode", "RWS"], [" DATA_1__id:9", ""]]);
  assert.deepEqual([...legendsIn(items)].sort(), ["DATA", "MENU", "RDR"]);
});

test("places each legend using the page that matches what's showing", () => {
  const pages = [
    { occ: [["MENU", 18]] },
    { occ: [["RDR", 3], ["SURF", 4], ["ERASE", 15], ["MODE", 19]] }, // the radar page
    { occ: [["TCN", 6], ["MODE", 3], ["ERASE", 2], ["WYPT", 11]] },  // another page with some of the same words
  ];
  const radar = buttonLegends(pages, shows([["MENU_1__id:1", ""], ["RDR_1__id:10", ""], ["SURF_1__id:11", ""], ["ERASE_1__id:12", ""], ["MODE_1__id:13", ""]]));
  assert.deepEqual(Object.fromEntries(radar), { 3: "RDR", 4: "SURF", 15: "ERASE", 19: "MODE", 18: "MENU" });
  const hsi = buttonLegends(pages, shows([["TCN_1__id:20", ""], ["WYPT_1__id:23", ""], ["MODE_1__id:21", ""], ["MENU_1__id:1", ""]]));
  assert.equal(hsi.get(3), "MODE", "MODE sits where the matching page puts it");
  assert.equal(hsi.get(6), "TCN");
});

test("a legend on several buttons of one page is placed between its neighbours", () => {
  // as on a stores page: MAN can be on button 2, 3 or 4 depending on the fuze options;
  // here button 2 shows DRAG and button 4 NOSE, so the MAN showing must be button 3's
  const page = { occ: [["DRAG", 2], ["MAN", 2], ["EFUZ", 3], ["CCIP", 3], ["MAN", 3], ["MFUZ", 4], ["NOSE", 4], ["MAN", 4]] };
  const r = buttonLegends([page], shows([["DRAG_1__id:30", ""], ["MAN_1__id:36", ""], ["NOSE_1__id:39", ""]]));
  assert.deepEqual(Object.fromEntries(r), { 2: "DRAG", 3: "MAN", 4: "NOSE" });
});

test("a legend from another page script doesn't order this one's", () => {
  // MENU comes from the shared menu script, whose element numbers restart at 1
  const pages = [
    { occ: [["MENU", 18]] },
    { occ: [["MENU", 18], ["DRAG", 2], ["MAN", 2], ["EFUZ", 3], ["MAN", 3], ["NOSE", 4], ["MAN", 4]] },
  ];
  const r = buttonLegends(pages, shows([["MENU_1__id:1", ""], ["DRAG_1__id:30", ""], ["MAN_1__id:36", ""], ["NOSE_1__id:39", ""]]));
  assert.deepEqual(Object.fromEntries(r), { 18: "MENU", 2: "DRAG", 3: "MAN", 4: "NOSE" });
});

test("filled-in legends pair up in order with the empty slots between two anchors", () => {
  // the F/A-18C HSI page: buttons 6, 8 and 9 are filled in (position keeping, scale, markpoint),
  // 15 is the waypoint sequence; MENU comes from another script whose numbers restart at 1
  const hsi = { occ: [["VEC", 2], ["MODE", 3], ["ILS", 4], ["TCN", 5], ["", 6], ["UPDT", 7], ["", 8], ["", 9], ["DATA", 10],
    ["WYPT", 11], ["WPDSG", 14], ["", 15], ["AUTO", 16], ["TIMEUFC", 17], ["STD HDG", 19], ["SENSORS", 20], ["TCN", 7], ["AUTO", 8]] };
  const menu = { occ: [["MENU", 18]] };
  const r = buttonLegends([hsi, menu], shows([["MENU_1__id:1", ""], ["VEC_1__id:1", ""], ["MODE_1__id:3", ""], ["TCN_1__id:6", ""],
    ["_1__id:8", "POS/AINS"], ["_1__id:10", "SCL/40"], ["_1__id:11", "MK1"], ["DATA_1__id:12", ""], ["WYPT_1__id:13", ""],
    ["WPDSG_1__id:17", ""], ["_1__id:18", "S\nE\nQ\n1"], ["AUTO_1__id:20", ""], ["TIMEUFC_1__id:22", ""], ["SENSORS_1__id:26", ""]]));
  assert.deepEqual(Object.fromEntries([...r].sort((a, b) => a[0] - b[0])), {
    2: "VEC", 3: "MODE", 5: "TCN", 6: "POS/AINS", 8: "SCL/40", 9: "MK1", 10: "DATA", 11: "WYPT", 14: "WPDSG",
    15: "SEQ1", 16: "AUTO", 17: "TIMEUFC", 18: "MENU", 20: "SENSORS",
  });
});

test("legends the display fills in while flying are placed the same way", () => {
  const page = { occ: [["NONE", 6], ["", 7], ["MODE", 8], ["", 9], ["NTR", 10]] };
  const r = buttonLegends([page], shows([["NONE_1__id:5", ""], ["_1__id:6", "VOICE"], ["MODE_1__id:7", ""], ["_1__id:8", "S\nE\nQ\n1"], ["NTR_1__id:9", ""]]));
  assert.deepEqual(Object.fromEntries(r), { 6: "NONE", 7: "VOICE", 8: "MODE", 9: "SEQ1", 10: "NTR" }, "side legends are written one letter per line");
});

test("keeps the number rather than guess when several positions fit", () => {
  const page = { occ: [["A", 1], ["", 2], ["", 3], ["B", 4]] };
  const r = buttonLegends([page], shows([["A_1__id:1", ""], ["_1__id:2", "X"], ["B_1__id:9", ""]]));
  assert.equal(r.has(2) || r.has(3), false);
  assert.equal(r.get(1), "A");
});

test("legends drawn straight at a button are found by element name", () => {
  const page = { occ: [["RDR", 2]], named: [["RTS_Label", 5, "RTS"], ["Radar_mode", 5, ""]] };
  assert.equal(buttonLegends([page], shows([["RDR_1__id:3", ""], ["RTS_Label", ""]])).get(5), "RTS");
  assert.equal(buttonLegends([page], shows([["RDR_1__id:3", ""], ["Radar_mode", "RWS"]])).get(5), "RWS");
});

test("reads legends from page scripts in order, one entry per script", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-"));
  fs.mkdirSync(path.join(dir, "Pages"));
  fs.writeFileSync(path.join(dir, "Pages/RADAR.lua"), [
    'add_PB_label(2, {"RDR", nil, {{"MPD_RDR_Show"}}}, {"PRI", nil, {{"MPD_RDR_Show"}}})',
    'local x = add_PB_label_RDR(17, "CHAN")',
    'add_PB_label(6, {"1B", "ElevBarScan_Main"})',
    '-- add_PB_label(9, {"OLD"})',
    'add_PB_label(7, {"", parent, {{"MPD_Filled_In"}}})',
    'add_PB_label(18, {"MENU"})',
    'addStrokeText("RTS_Label", "RTS", FONT, "LeftCenter", {PB_positions[5][1] + 10, 365}, nil, {{"MPD_RTS"}})',
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "Pages/none.lua"), "print('no legends here')");
  assert.deepEqual(pbLabelsFrom(dir), [{
    occ: [["RDR", 2], ["CHAN", 17], ["1B", 6], ["", 7], ["MENU", 18]],
    named: [["RTS_Label", 5, "RTS"]],
  }]);
  fs.rmSync(dir, { recursive: true });
});
