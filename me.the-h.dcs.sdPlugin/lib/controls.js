// Turns the raw clickable elements read from an aircraft's cockpit scripts (lua/scan.lua) into
// deck controls, and works out the clickable actions a key press or dial turn sends.
//
// Each element has 1-3 "sides" (left click, right click, wheel in the cockpit). A side is one of:
//   momentary  a push button: press sends a value, release sends the stop value
//   step       a switch or knob position: sends the new position's value
//   axis       a continuous knob: absolute (sends the new value) or relative (sends a delta)

const MOMENTARY = new Set(["BTN", "BTN_FIX", "SNGBTN"]);
const STEP = new Set(["TUMB", "MULTY_TUMB"]);
const AXIS = new Set(["LEV", "MOVABLE_LEV"]);

const EPS = 1e-3;
const MAX_POSITIONS = 41;

const round = (v) => Math.round(v * 10000) / 10000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const at = (list, i) => (Array.isArray(list) ? list[i] : undefined);

function sidesOf(el) {
  const sides = [];
  (el.class || []).forEach((cls, i) => {
    const action = at(el.action, i);
    if (!Number.isFinite(action) || action === 0) return;
    const type = MOMENTARY.has(cls) ? "momentary" : STEP.has(cls) ? "step" : AXIS.has(cls) ? "axis" : null;
    if (!type) return;
    const lim = at(el.arg_lim, i) || [0, 1];
    const side = {
      index: i,
      type,
      action,
      arg: at(el.arg, i) ?? at(el.arg, 0),
      value: at(el.arg_value, i) ?? 1,
      lim: [Math.min(lim[0], lim[1]), Math.max(lim[0], lim[1])],
    };
    if (type === "momentary") {
      if (at(el.release, i) !== false) {
        const stop = at(el.stop_action, i);
        side.release = { action: Number.isFinite(stop) && stop !== 0 ? stop : action, value: at(el.stop_value, i) ?? 0 };
      }
    } else if (type === "axis") {
      side.gain = at(el.gain, i) ?? 0.1;
      side.relative = cls === "LEV" && at(el.relative, i) === true;
    } else {
      side.cycle = el.cycle === true;
    }
    sides.push(side);
  });
  return sides;
}

// Evenly spaced positions from lo to hi, or null when there is no sensible step.
function spaced(lo, hi, step) {
  if (!(step > EPS) || !(hi >= lo)) return null;
  const count = Math.round((hi - lo) / step) + 1;
  if (count < 2 || count > MAX_POSITIONS) return null;
  const list = Array.from({ length: count }, (_, k) => round(lo + k * step)).filter((v) => v <= hi + EPS);
  return list.length >= 2 ? list : null;
}

function minStep(sides) {
  const steps = sides.map((s) => Math.abs(s.value)).filter((v) => v > EPS);
  return steps.length ? Math.min(...steps) : null;
}

// "Master Arm Switch, ARM/SAFE" -> ["ARM", "SAFE"]. Toggle switches list their positions from the
// top (highest value) down; rotary knobs, which step in small increments, from the lowest up.
function hintPositions(hint) {
  const comma = String(hint || "").lastIndexOf(",");
  if (comma < 0) return null;
  const tail = hint.slice(comma + 1);
  if (/[()]/.test(tail) || !tail.includes("/")) return null;
  const names = tail.split("/").map((s) => s.trim()).filter(Boolean);
  return names.length >= 2 ? names : null;
}

// "Master Arm Switch, ARM/SAFE" -> "Master Arm"
function shortLabel(hint) {
  let s = String(hint || "").split(/,| - /)[0].trim();
  s = s.replace(/\s+(Switch|Pushbutton|Push Button|Button|Knob|Control|Selector|Handle|Lever)$/i, "");
  s = s.replace(/\s+(Switch|Control|Selector)$/i, "");
  return s || String(hint || "");
}

const prettyDevice = (name) => String(name || "").replace(/_/g, " ").replace(/\bINTERFACE\b/, "").trim();

// One raw element (+ optional overlay entry) -> a control the deck can use.
function describe(el, devices = {}, overlay = {}) {
  const sides = sidesOf(el);
  const main = sides[0];
  const control = {
    id: el.id,
    hint: el.hint || el.id,
    label: overlay.label || shortLabel(el.hint || el.id),
    device: el.device,
    group: overlay.group || prettyDevice(devices[el.device]) || "Other",
    sides,
    arg: main ? main.arg : null,
    kind: "none",
  };
  if (!main) return control;

  const onMain = sides.filter((s) => s.arg === main.arg && s.type !== "axis");
  const steps = onMain.filter((s) => s.type === "step");
  const lo = Math.min(...onMain.map((s) => s.lim[0]));
  const hi = Math.max(...onMain.map((s) => s.lim[1]));
  const step = minStep(steps) ?? minStep(onMain);

  if (onMain.length) control.positions = spaced(lo, hi, step);
  if (steps.length) {
    const slo = Math.min(...steps.map((s) => s.lim[0]));
    const shi = Math.max(...steps.map((s) => s.lim[1]));
    control.stepPositions = (control.positions || []).filter((v) => v >= slo - EPS && v <= shi + EPS);
    if (control.stepPositions.length < 2) control.stepPositions = null;
  }

  if (main.type === "axis") control.kind = "axis";
  else if (control.stepPositions) control.kind = "switch";
  else if (onMain.filter((s) => s.type === "momentary").length > 1) control.kind = "spring";
  else control.kind = "button";

  // A dial turns the control's axis, unless that axis is a separate function of a switch (a gear
  // handle's emergency pull), in which case it steps the switch.
  const axis = sides.find((s) => s.type === "axis") || null;
  control.axis = axis && (!control.stepPositions || axis.arg === main.arg) ? axis : null;
  control.extraAxis = axis && !control.axis ? axis : null;
  control.push = sides.find((s) => s.type === "momentary") || null;

  // Position names: overlay {value: name} wins, else the names in the hint (highest value first).
  if (control.positions) {
    const names = {};
    if (overlay.positions) {
      for (const [v, name] of Object.entries(overlay.positions)) names[round(Number(v))] = name;
    } else {
      const fromHint = hintPositions(el.hint);
      if (fromHint && fromHint.length === control.positions.length) {
        const knob = Math.abs(control.positions[1] - control.positions[0]) < 0.5;
        const order = knob ? control.positions : [...control.positions].reverse();
        order.forEach((v, i) => (names[v] = fromHint[i]));
      }
    }
    if (Object.keys(names).length) control.names = names;
  }
  if (overlay.step) control.step = overlay.step;
  if (overlay.display) control.display = overlay.display;
  if (overlay.core) control.core = true;
  return control;
}

function nearestIndex(list, value) {
  let best = 0;
  for (let i = 1; i < list.length; i++) if (Math.abs(list[i] - value) < Math.abs(list[best] - value)) best = i;
  return best;
}

// The side that moves the switch to `target`: a step side whose range holds it, preferring one that
// moves the same way (a gear handle has separate UP and DOWN actions).
function stepSideFor(control, target, current) {
  const fits = control.sides.filter((s) => s.type === "step" && s.arg === control.arg && target >= s.lim[0] - EPS && target <= s.lim[1] + EPS);
  const dir = Math.sign(target - (current ?? target));
  return fits.find((s) => dir && Math.sign(s.value) === dir) || fits[0] || control.sides.find((s) => s.type === "step");
}

const click = (control, action, value) => ({ device: control.device, action, value: round(value) });

function setPosition(control, target, current) {
  const side = stepSideFor(control, target, current);
  return side ? [click(control, side.action, target)] : [];
}

// Move a switch by `delta` positions. wrap: go round from the last position to the first.
function stepBy(control, current, delta, wrap) {
  const list = control.stepPositions;
  if (!list) return [];
  let i = nearestIndex(list, current ?? list[0]) + delta;
  if (wrap) i = ((i % list.length) + list.length) % list.length;
  else i = clamp(i, 0, list.length - 1);
  if (Math.abs(list[i] - (current ?? NaN)) < EPS) return [];
  return setPosition(control, list[i], current);
}

// One side used directly ("side:N" mode).
function sidePress(control, side, current) {
  if (!side) return [];
  if (side.type === "momentary") return [click(control, side.action, side.value)];
  if (side.type === "step") {
    let target = (current ?? side.lim[0]) + side.value;
    if (target > side.lim[1] + EPS || target < side.lim[0] - EPS) {
      if (!side.cycle) target = clamp(target, side.lim[0], side.lim[1]);
      else target = side.value > 0 ? side.lim[0] : side.lim[1];
    }
    return [click(control, side.action, target)];
  }
  return axisTurn(control, side, current, 1);
}

function axisTurn(control, side, current, ticks, step) {
  if (!side || !ticks) return [];
  if (side.relative) {
    const per = step || Math.abs(side.value) || Math.abs(side.gain) || 0.1;
    const sign = side.gain < 0 ? -1 : 1;
    return [click(control, side.action, ticks * per * sign)];
  }
  const per = step || Math.abs(side.gain) || 0.05;
  const target = clamp((current ?? side.lim[0]) + ticks * per, side.lim[0], side.lim[1]);
  if (current != null && Math.abs(target - current) < EPS / 10) return [];
  return [click(control, side.action, target)];
}

const sideByMode = (control, mode) => {
  const m = /^side:(\d+)$/.exec(mode || "");
  return m ? control.sides.find((s) => s.index === Number(m[1])) : null;
};

// A held button that the aircraft keeps in place once pressed (an engine crank switch, held by a
// solenoid until the engine spools up): "latch:N" presses side N and leaves it there; pressing
// again while it's there lets it go.
const latchSide = (control, mode) => {
  const m = /^latch:(\d+)$/.exec(mode || "");
  return m ? control.sides.find((s) => s.index === Number(m[1]) && s.type === "momentary") : null;
};

// The commands for a key press. `value(arg)` returns an argument's current value (or undefined).
// opts: { mode: auto|toggle|next|prev|set|side:N|latch:N, position, step }
function press(control, value, opts = {}) {
  const mode = opts.mode || "auto";
  const current = value(control.arg);
  const latch = latchSide(control, mode);
  if (latch) {
    const there = current != null && Math.sign(current) === Math.sign(latch.value) && Math.abs(current) > 0.5;
    if (there && latch.release) return [click(control, latch.release.action, latch.release.value)];
    return [click(control, latch.action, latch.value)];
  }
  const side = sideByMode(control, mode);
  if (side) return sidePress(control, side, value(side.arg));
  switch (mode) {
    case "next": return stepBy(control, current, 1, false);
    case "prev": return stepBy(control, current, -1, false);
    case "set": return control.stepPositions ? setPosition(control, Number(opts.position), current) : [];
    default:
      if (control.kind === "switch") return stepBy(control, current, 1, true);
      if (control.push) return [click(control, control.push.action, control.push.value)];
      if (control.axis) return axisTurn(control, control.axis, value(control.axis.arg), 1, opts.step);
      return [];
  }
}

// The commands for letting go of a key: only momentary sides do anything.
function release(control, opts = {}) {
  const mode = opts.mode || "auto";
  let side = sideByMode(control, mode);
  if (!side && (mode === "auto" || mode === "") && control.kind !== "switch" && !(control.kind === "axis" && !control.push)) side = control.push;
  if (!side || side.type !== "momentary" || !side.release) return [];
  return [click(control, side.release.action, side.release.value)];
}

// The commands for turning a dial. A spring-loaded rocker (heading set, course set) is nudged once
// per click: each command then carries the `release` to send a moment later.
function rotate(control, value, ticks, opts = {}) {
  if (!ticks) return [];
  if (control.kind === "spring" && !control.axis) {
    const side = control.sides.find((s) => s.type === "momentary" && Math.sign(s.value) === Math.sign(ticks));
    if (!side) return [];
    const one = { ...click(control, side.action, side.value), release: side.release ? click(control, side.release.action, side.release.value) : null };
    return Array.from({ length: Math.min(Math.abs(ticks), 10) }, () => one);
  }
  if (control.axis) return axisTurn(control, control.axis, value(control.axis.arg), ticks, opts.step || control.step);
  if (control.stepPositions) return stepBy(control, value(control.arg), ticks, false);
  return [];
}

// --------------------------------------------------------------------------- showing state

// The value a control rests at when "off": 0 if it can be 0, else its lowest position.
function offValue(control) {
  const list = control.positions;
  if (!list) return 0;
  return list.some((v) => Math.abs(v) < EPS) ? 0 : list[0];
}

function isOn(control, v) {
  if (v == null) return false;
  if (control.kind === "button" || control.kind === "spring") return Math.abs(v) > 0.5;
  if (control.kind === "axis") return v > EPS;
  return Math.abs(v - offValue(control)) > EPS;
}

// Text for a value: the position's name, else a percentage of the travel.
function format(control, v) {
  if (v == null) return "—";
  if (control.positions) {
    const p = control.positions[nearestIndex(control.positions, v)];
    if (control.names && control.names[p] != null) return control.names[p];
    if (control.kind === "button" || control.kind === "spring") return Math.abs(v) > 0.5 ? "ON" : "OFF";
    const i = control.positions.indexOf(p);
    return control.positions.length === 2 ? (i ? "ON" : "OFF") : `${i + 1}/${control.positions.length}`;
  }
  const side = control.axis;
  if (side && !side.relative) {
    const span = side.lim[1] - side.lim[0] || 1;
    return `${Math.round(((v - side.lim[0]) / span) * 100)}%`;
  }
  return String(round(v));
}

// 0..1 for drawing a bar, or null.
function level(control, v) {
  if (v == null) return null;
  const side = control.axis && !control.axis.relative ? control.axis : null;
  if (side) return clamp((v - side.lim[0]) / (side.lim[1] - side.lim[0] || 1), 0, 1);
  if (control.positions && control.positions.length > 2) {
    const lo = control.positions[0], hi = control.positions[control.positions.length - 1];
    return clamp((v - lo) / (hi - lo || 1), 0, 1);
  }
  return null;
}

// A value read from counter drums, e.g. an altimeter's pressure window.
//   { type: "digits", args: [most significant ... least], decimals }      each drum 0..1 = digit 0..9
//   { type: "drums", drums: [{ arg, min, max }, ...], decimals }          each drum 0..1 = min..max
// (the F/A-18C's Kollsman window: inches 26..31, then tenths and hundredths 0..10).
function displayValue(display, value) {
  if (!display) return null;
  let digits = "";
  if (display.type === "digits" && Array.isArray(display.args)) {
    for (const a of display.args) {
      const v = value(a);
      if (v == null) return null;
      digits += String(Math.round(v * 10) % 10);
    }
  } else if (display.type === "drums" && Array.isArray(display.drums)) {
    for (const d of display.drums) {
      const v = value(d.arg);
      if (v == null) return null;
      const span = d.max - d.min;
      let n = Math.round(d.min + v * span);
      if (span === 10) n %= 10; // a 0-9 drum wraps round
      digits += String(n);
    }
  } else {
    return null;
  }
  const d = display.decimals || 0;
  const text = d ? `${digits.slice(0, digits.length - d)}.${digits.slice(-d)}` : digits;
  return (display.prefix || "") + text + (display.suffix || "");
}

// --------------------------------------------------------------------------- lamps and gauges

const lampLabel = (name) => String(name || "").replace(/^CPT_LTS_/, "").replace(/_lt$/i, "").replace(/_/g, " ").trim();

function lightsOf(gauges, overlayLights = {}) {
  return (gauges || []).map((g) => {
    const o = overlayLights[g.arg] || {};
    return {
      arg: g.arg,
      name: g.name || `arg ${g.arg}`,
      label: o.label || lampLabel(g.name) || `arg ${g.arg}`,
      lamp: g.source === "lamps.lua" || /^CPT_LTS_|_lt$|lamp|light/i.test(g.name || ""),
      color: o.color || null,
    };
  }).sort((a, b) => (a.lamp === b.lamp ? a.arg - b.arg : a.lamp ? -1 : 1));
}

// A whole scanned aircraft (+ overlay) -> { unit, page, controls, lights }
function buildAircraft(unit, raw, overlay = {}) {
  const devices = Object.fromEntries((raw.devices || []).map((d) => [d.id, d.name]));
  const oc = overlay.controls || {};
  const controls = (raw.elements || []).map((el) => describe(el, devices, oc[el.id] || {})).filter((c) => c.kind !== "none");
  controls.sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
  return {
    unit,
    name: overlay.name || unit,
    page: overlay.page || unit,
    phases: overlay.phases || null,
    alerts: overlay.alerts || null,
    groundBelowSpeed: overlay.groundBelowSpeed ?? null,
    indicators: overlay.indicators || {},
    pbPages: raw.pbPages || [],
    controls,
    byId: new Map(controls.map((c) => [c.id, c])),
    lights: lightsOf(raw.gauges, overlay.lights || {}),
  };
}

module.exports = {
  sidesOf, describe, press, release, rotate, isOn, format, level, displayValue, lightsOf, buildAircraft, shortLabel, hintPositions,
};
