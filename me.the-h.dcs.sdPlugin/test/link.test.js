const test = require("node:test");
const assert = require("node:assert/strict");
const dgram = require("node:dgram");
const { once } = require("node:events");
const { DcsLink } = require("../lib/link.js");

// A fake hook: a UDP socket standing in for DCS.
async function setup() {
  const hook = dgram.createSocket("udp4");
  hook.bind(0, "127.0.0.1");
  await once(hook, "listening");
  const probe = dgram.createSocket("udp4");
  probe.bind(0, "127.0.0.1");
  await once(probe, "listening");
  const listenPort = probe.address().port;
  probe.close();
  const link = new DcsLink({ listenPort, sendPort: hook.address().port });
  link.start();
  await once(link.socket, "listening");
  const received = [];
  hook.on("message", (b) => received.push(b.toString()));
  const say = (text) => hook.send(text, listenPort, "127.0.0.1");
  const settle = () => new Promise((r) => setTimeout(r, 50));
  return { hook, link, received, say, settle, close: () => { link.stop(); hook.close(); } };
}

test("follows the aircraft and re-sends its watch list on hello", async () => {
  const t = await setup();
  t.link.watch([49, 13]);
  const unit = once(t.link, "unit");
  t.say("H FA-18C_hornet 1");
  assert.deepEqual(await unit, ["FA-18C_hornet"]);
  await t.settle();
  assert.equal(t.link.connected, true);
  assert.ok(t.received.includes("W 13,49"));
  t.close();
});

test("collects argument values and reports what changed", async () => {
  const t = await setup();
  const changed = once(t.link, "values");
  t.say("A 49=1 13=0");
  assert.deepEqual([...(await changed)[0]], [49, 13]);
  assert.equal(t.link.values.get(49), 1);
  t.say("A 49=1 13=1");
  const again = await once(t.link, "values");
  assert.deepEqual([...again[0]], [13]);
  t.close();
});

test("sends clickable actions and asks for a resync when watching more", async () => {
  const t = await setup();
  t.link.click(23, 3001, 1);
  t.link.watch([1]);
  t.link.watch([1]);
  await t.settle();
  assert.deepEqual(t.received, ["C 23 3001 1", "W 1", "WT ", "R"]);
  t.close();
});

test("drops the aircraft when DCS goes quiet", async () => {
  const t = await setup();
  t.say("H FA-18C_hornet 1");
  await once(t.link, "unit");
  t.link.lastHeard = Date.now() - 10000;
  const gone = once(t.link, "unit");
  t.link.checkAlive();
  assert.deepEqual(await gone, [null]);
  assert.equal(t.link.connected, false);
  t.close();
});
