const test = require("node:test");
const assert = require("node:assert/strict");
const { parse, encode, parseIndication } = require("../lib/protocol.js");

test("parses messages from the hook", () => {
  assert.deepEqual(parse("H FA-18C_hornet 1"), { type: "hello", unit: "FA-18C_hornet", protocol: 1 });
  assert.deepEqual(parse("H - 1"), { type: "hello", unit: null, protocol: 1 });
  assert.deepEqual([...parse("A 49=1 236=0.3 x=1 298=-0.5").values], [[49, 1], [236, 0.3], [298, -0.5]]);
  assert.deepEqual(parse("T 7 line one\nline two"), { type: "text", id: "7", text: "line one\nline two" });
  assert.deepEqual(parse("T ufc x"), { type: "text", id: "ufc", text: "x" });
  assert.deepEqual(parse("F agl=0.4 ias=61.2 gs=58"), { type: "flight", agl: 0.4, ias: 61.2, gs: 58 });
  assert.deepEqual(parse("F agl=- ias=12 gs=-"), { type: "flight", agl: null, ias: 12, gs: null });
  assert.deepEqual(parse("L hello there"), { type: "log", text: "hello there" });
  assert.deepEqual(parse("S FA-18C_hornet error bad file"), { type: "scanned", unit: "FA-18C_hornet", ok: false, error: "bad file" });
  assert.equal(parse("nonsense"), null);
});

test("encodes commands for the hook", () => {
  assert.equal(encode.watch(new Set([300, 49, 2])), "W 2,49,300");
  assert.equal(encode.watch([]), "W ");
  assert.equal(encode.watchText(["ufc=UFC_mask", "7", "bad entry"]), "WT 7,ufc=UFC_mask");
  assert.equal(encode.click(23, 3001, 1), "C 23 3001 1");
  assert.equal(encode.click(23, 3001, 0.1 + 0.2), "C 23 3001 0.3");
  assert.equal(encode.click(23, 3001, -0), "C 23 3001 0");
  assert.equal(encode.key(84), "K 84");
  assert.equal(encode.key(2001, 0.5), "K 2001 0.5");
});

test("splits indicator text into named elements", () => {
  const text = "\n-----------------------------------------\nUFC_Comm1Display\n 12\n-----------------------------------------\nUFC_ScratchPadNumberDisplay\n305.000\n";
  assert.deepEqual([...parseIndication(text)], [["UFC_Comm1Display", " 12"], ["UFC_ScratchPadNumberDisplay", "305.000"]]);
  assert.equal(parseIndication("").size, 0);
});

test("drops DCS's nesting lines from indicator text", () => {
  // as list_indication returns the F/A-18C UFC: containers, empty windows, and closing braces
  const ufc = [
    "-----------------------------------------", "UFC_MainDummy", "", "children are {",
    "-----------------------------------------", "UFC_mask", "", "children are {",
    "-----------------------------------------", "UFC_OptionDisplay1", "",
    "-----------------------------------------", "UFC_Comm1Display", " 1",
    "-----------------------------------------", "UFC_Comm2Display", " 1", "}", "}", "",
  ].join("\n");
  const m = parseIndication(ufc);
  assert.equal(m.get("UFC_MainDummy"), "");
  assert.equal(m.get("UFC_OptionDisplay1"), "");
  assert.equal(m.get("UFC_Comm1Display"), " 1");
  assert.equal(m.get("UFC_Comm2Display"), " 1", "no closing braces");
});
