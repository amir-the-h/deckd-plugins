const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluate, phaseOf, alertOn, argsOf, PageFollower } = require("../lib/phases.js");

const aircraft = {
  phases: [
    { name: "parked", page: "Start", when: { all: [{ ground: true }, { gs: { below: 1.5 } }] } },
    { name: "taxi", page: "Systems", when: { ground: true } },
    { name: "air", page: "Main", when: { ground: false } },
  ],
  alerts: { page: "Lights", triggers: [{ args: [13], skipPhases: ["parked"] }, { args: [10] }] },
};
const ctx = (flight, args = {}) => ({ flight, value: (a) => args[a], groundBelowSpeed: 35 });

test("tells parked, taxiing and airborne apart", () => {
  assert.equal(phaseOf(aircraft.phases, ctx({ agl: 0.5, gs: 0 })).name, "parked");
  assert.equal(phaseOf(aircraft.phases, ctx({ agl: 0.5, gs: 6 })).name, "taxi");
  assert.equal(phaseOf(aircraft.phases, ctx({ agl: 300, gs: 150 })).name, "air");
});

test("falls back to ground speed when the server hides height above ground", () => {
  assert.equal(phaseOf(aircraft.phases, ctx({ agl: null, gs: 10 })).name, "taxi");
  assert.equal(phaseOf(aircraft.phases, ctx({ agl: null, gs: 120 })).name, "air");
});

test("doesn't guess while data is missing", () => {
  assert.equal(phaseOf(aircraft.phases, ctx({ agl: null, gs: null })), null);
  assert.equal(phaseOf(aircraft.phases, ctx({ agl: 0.5, gs: null })), null, "on the ground, but parked or taxiing is unknown");
});

test("conditions on cockpit arguments, with all/any/not", () => {
  const c = ctx({}, { 404: 1, 307: 0.8 });
  assert.equal(evaluate({ arg: 404, above: 0.5 }, c), true);
  assert.equal(evaluate({ any: [{ arg: 404, below: 0.5 }, { arg: 307, above: 0.1 }] }, c), true);
  assert.equal(evaluate({ not: { arg: 307, above: 0.1 } }, c), false);
  assert.equal(evaluate({ arg: 999, above: 0 }, c), null, "unknown argument");
});

test("alerts, except the ones expected while parked", () => {
  assert.equal(alertOn(aircraft.alerts, ctx({}, { 13: 1 }), "air"), true);
  assert.equal(alertOn(aircraft.alerts, ctx({}, { 13: 1 }), "parked"), false);
  assert.equal(alertOn(aircraft.alerts, ctx({}, { 10: 1 }), "parked"), true, "fire always counts");
  assert.deepEqual([...argsOf(aircraft.phases, aircraft.alerts)].sort(), [10, 13]);
});

test("follows phases once they settle, and alerts at once", () => {
  const f = new PageFollower({ settle: 3000 });
  const air = ctx({ agl: 300, gs: 150 });
  assert.deepEqual(f.update(aircraft, ctx({ agl: 0.5, gs: 0 }), 0), { page: "Start", reason: "parked" }, "first phase straight away");
  assert.equal(f.update(aircraft, ctx({ agl: 0.5, gs: 6 }), 1000), null, "taxi not settled yet");
  assert.equal(f.update(aircraft, ctx({ agl: 0.5, gs: 0 }), 1500), null, "stopped again: stays");
  assert.equal(f.update(aircraft, ctx({ agl: 0.5, gs: 6 }), 2000), null);
  assert.deepEqual(f.update(aircraft, ctx({ agl: 0.5, gs: 6 }), 5100), { page: "Systems", reason: "taxi" });
  assert.equal(f.update(aircraft, ctx({ agl: 0.5, gs: 6 }), 9000), null, "no repeat while the phase holds");

  // An alert in the air jumps at once and returns to the page you were on.
  f.update(aircraft, air, 10000);
  assert.deepEqual(f.update(aircraft, air, 13100), { page: "Main", reason: "air" });
  assert.deepEqual(f.update(aircraft, ctx({ agl: 300, gs: 150 }, { 13: 1 }), 14000, "Hornet Nav"), { page: "Lights", reason: "alert" });
  assert.equal(f.update(aircraft, ctx({ agl: 300, gs: 150 }, { 13: 1 }), 15000), null, "stays while lit");
  assert.deepEqual(f.update(aircraft, air, 16000), { page: "Hornet Nav", reason: "alert cleared" });
});

test("after an alert with no known page to return to, goes to the phase's page", () => {
  const f = new PageFollower();
  f.update(aircraft, ctx({ agl: 300, gs: 150 }), 0);
  f.update(aircraft, ctx({ agl: 300, gs: 150 }, { 10: 1 }), 100, null);
  assert.deepEqual(f.update(aircraft, ctx({ agl: 300, gs: 150 }), 200), { page: "Main", reason: "alert cleared" });
});
