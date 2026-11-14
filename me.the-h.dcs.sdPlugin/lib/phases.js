// Flight phases and alerts, described per aircraft in its overlay file:
//
//   "phases": [                                  first phase whose condition holds wins
//     { "name": "parked", "page": "Hornet Start",   "when": { "all": [{ "ground": true }, { "gs": { "below": 1.5 } }] } },
//     { "name": "taxi",   "page": "Hornet Systems", "when": { "ground": true } },
//     { "name": "air",    "page": "Hornet",         "when": { "ground": false } }
//   ],
//   "groundBelowSpeed": 35,                      without height above ground: on the ground below this (m/s)
//   "alerts": { "page": "Hornet Lights", "triggers": [
//     { "args": [13], "skipPhases": ["parked"] },  master caution comes on during every start-up
//     { "args": [10, 26, 29] }                     fire lights always count
//   ] }
//
// Conditions: { "arg": n, "above": v } / { "arg": n, "below": v }, { "gs"|"agl"|"ias": { "above"|"below": v } },
// { "ground": true|false }, { "all": [...] }, { "any": [...] }, { "not": cond }.
// They are three-valued: null means "can't tell yet" (data hidden or not arrived), and a phase is
// only chosen when every phase before it is definitely false, so a missing value never picks a
// wrong page.

const GROUND_AGL = 3; // metres

// ctx: { value(arg) -> number|undefined, flight: { agl, ias, gs }, groundBelowSpeed }
function isGround(ctx) {
  const f = ctx.flight || {};
  if (f.agl != null) return f.agl < GROUND_AGL;
  if (f.gs != null && ctx.groundBelowSpeed != null) return f.gs < ctx.groundBelowSpeed;
  return null;
}

function compare(v, test) {
  if (v == null) return null;
  if (test.above != null && !(v > test.above)) return false;
  if (test.below != null && !(v < test.below)) return false;
  return true;
}

function evaluate(cond, ctx) {
  if (!cond || typeof cond !== "object") return true;
  if (Array.isArray(cond.all)) {
    let unknown = false;
    for (const c of cond.all) {
      const r = evaluate(c, ctx);
      if (r === false) return false;
      if (r === null) unknown = true;
    }
    return unknown ? null : true;
  }
  if (Array.isArray(cond.any)) {
    let unknown = false;
    for (const c of cond.any) {
      const r = evaluate(c, ctx);
      if (r === true) return true;
      if (r === null) unknown = true;
    }
    return unknown ? null : false;
  }
  if (cond.not) {
    const r = evaluate(cond.not, ctx);
    return r === null ? null : !r;
  }
  if (cond.ground != null) {
    const g = isGround(ctx);
    return g === null ? null : g === !!cond.ground;
  }
  for (const k of ["gs", "agl", "ias"]) {
    if (cond[k]) return compare(ctx.flight?.[k], cond[k]);
  }
  if (cond.arg != null) return compare(ctx.value(Number(cond.arg)), cond);
  return true;
}

// The current phase ({ name, page, ... }) or null when it can't be told yet.
function phaseOf(phases, ctx) {
  for (const p of phases || []) {
    const r = evaluate(p.when, ctx);
    if (r === true) return p;
    if (r === null) return null;
  }
  return null;
}

// Whether any alert light is on, given the current phase name.
function alertOn(alerts, ctx, phaseName) {
  for (const t of alerts?.triggers || []) {
    if (phaseName && (t.skipPhases || []).includes(phaseName)) continue;
    const threshold = t.threshold ?? 0.1;
    if ((t.args || []).some((a) => (ctx.value(Number(a)) ?? 0) > threshold)) return true;
  }
  return false;
}

// Every argument the rules read, so the hook is asked to send them.
function argsOf(phases, alerts) {
  const out = new Set();
  const walk = (c) => {
    if (!c || typeof c !== "object") return;
    if (c.arg != null) out.add(Number(c.arg));
    for (const x of [...(c.all || []), ...(c.any || [])]) walk(x);
    if (c.not) walk(c.not);
  };
  for (const p of phases || []) walk(p.when);
  for (const t of alerts?.triggers || []) for (const a of t.args || []) out.add(Number(a));
  return out;
}

// Decides page switches over time: a phase must hold for `settle` ms before the deck follows it,
// alerts jump straight away and go back to `returnTo` (or the phase's page) once they clear.
class PageFollower {
  constructor({ settle = 3000 } = {}) {
    this.settle = settle;
    this.phase = null;      // the phase the deck last followed
    this.pending = null;    // { name, since }
    this.alert = false;
    this.returnTo = null;
  }

  // -> { page, reason } to switch to, or null. `current` is the page shown now, when known.
  update(aircraft, ctx, now, current = null) {
    const phase = phaseOf(aircraft.phases, ctx);
    const alert = alertOn(aircraft.alerts, ctx, phase?.name ?? this.phase?.name);

    if (alert && !this.alert) {
      this.alert = true;
      this.returnTo = current && current !== aircraft.alerts.page ? current : null;
      return { page: aircraft.alerts.page, reason: "alert" };
    }
    if (!alert && this.alert) {
      this.alert = false;
      const back = this.returnTo || phase?.page || this.phase?.page || null;
      this.returnTo = null;
      if (phase) { this.phase = phase; this.pending = null; }
      return back ? { page: back, reason: "alert cleared" } : null;
    }
    if (this.alert || !phase) return null;

    if (this.phase?.name === phase.name) { this.pending = null; return null; }
    if (this.pending?.name !== phase.name) { this.pending = { name: phase.name, since: now }; }
    if (this.phase && now - this.pending.since < this.settle) return null;
    // The first phase after getting in is followed at once; later changes once they've settled.
    this.phase = phase;
    this.pending = null;
    return { page: phase.page, reason: phase.name };
  }

  reset() {
    this.phase = null;
    this.pending = null;
    this.alert = false;
    this.returnTo = null;
  }
}

module.exports = { evaluate, phaseOf, alertOn, argsOf, isGround, PageFollower };
