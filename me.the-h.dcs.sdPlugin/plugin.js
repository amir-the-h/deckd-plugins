// DCS World cockpit: keys and dials that work like the real switches, lights and knobs of the
// aircraft you're flying (Node >= 22, no deps).
//
//   switch  any clickable cockpit control on a key: flips switches, steps multi-position
//           switches, holds buttons; shows the live position, with an optional lamp
//   light   any cockpit lamp as a lit/dark annunciator; can also press a control (e.g. reset)
//   knob    a rotary on a dial: turn to adjust (volume, brightness, channels, baro), push for its
//           button; the touch strip shows the value
//   command one of DCS's own input commands (e.g. throttle IDLE / OFF)
//   readout values from a cockpit display (engine RPM, fuel…) on a key or the touch strip
//   picker  a dial that picks one of several buttons (a display's side, the UFC keypad) and
//           pushes it; the touch strip shows them all, or a display's text above them
//   status  hook and link state; settings to install the hook into DCS and scan aircraft
//
// The deck also follows the flight: each aircraft's overlay can name a page per phase (parked,
// taxiing, airborne) and a page to jump to while a warning or caution light is on.
//
// The in-game side is lua/hook.lua, loaded from Saved Games/DCS/Scripts/Export.lua. The controls
// come from each aircraft's own cockpit scripts, scanned on this machine by lua/scan.lua.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const controls = require("./lib/controls.js");
const art = require("./lib/draw.js");
const install = require("./lib/install.js");
const { Catalog, findAircraft, findLua } = require("./lib/catalog.js");
const { DcsLink } = require("./lib/link.js");
const { parseIndication } = require("./lib/protocol.js");
const phases = require("./lib/phases.js");
const displays = require("./lib/displays.js");


// --------------------------------------------------------------------------- startup

const args = {};
for (let i = 2; i + 1 < process.argv.length; i += 2) args[process.argv[i].replace(/^-/, "")] = process.argv[i + 1];
const UUID = args.pluginUUID || "me.the-h.dcs";

const ws = new WebSocket(`ws://127.0.0.1:${args.port}`);
const send = (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
const log = (message) => { console.log(message); send({ event: "logMessage", payload: { message } }); };

ws.onopen = () => {
  send({ event: args.registerEvent, uuid: UUID });
  send({ event: "getGlobalSettings", context: UUID });
};
ws.onclose = () => process.exit(0);
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  try {
    handle(msg);
  } catch (e) {
    log(`error handling ${msg.event}: ${e.stack || e}`);
  }
};

const LUA_DIR = path.join(__dirname, "lua");
const dataDir = process.platform === "linux"
  ? path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "deckd/plugin-data", UUID)
  : path.join(__dirname, "data");
const catalog = new Catalog({ dataDir, luaDir: LUA_DIR, overlayDir: path.join(__dirname, "overlays"), log });

// --------------------------------------------------------------------------- state

let globals = null;
let link = null;
let linkKey = "";
let dcs = { root: null, savedGames: null };
let device = null;          // a deck id for switchToProfile
let lastForward = 0;
let follower = new phases.PageFollower();
let shownPage = null;       // the page deckd shows now, when its API tells us
let pageTimer = null;
let followTimer = null;
const dcsLog = [];          // recent log lines from the hook
const optimistic = new Map(); // arg -> { value, until }
const instances = new Map();  // context -> { kind, controller, settings, span, device }
const lastImage = new Map();

const kindOf = (action) => String(action || "").slice(UUID.length + 1);
const intSetting = (v, fallback) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : fallback);

function startLink() {
  const listenPort = intSetting(globals?.listenPort, 7790);
  const sendPort = intSetting(globals?.sendPort, 7791);
  const key = `${listenPort}/${sendPort}`;
  if (link && key === linkKey) return;
  link?.stop();
  linkKey = key;
  link = new DcsLink({ listenPort, sendPort, log });
  link.on("status", drawAll);
  link.on("unit", onUnit);
  link.on("values", (changed) => { onValues(changed); scheduleFollow(); });
  link.on("flight", scheduleFollow);
  link.on("text", onText);
  link.on("log", (text) => { dcsLog.push(text); if (dcsLog.length > 20) dcsLog.shift(); });
  link.on("scanned", (msg) => {
    if (msg.ok && msg.unit && catalog.importFromDcs(msg.unit, dcs.savedGames)) { log(`scanned ${msg.unit} inside DCS`); refreshWatch(); drawAll(); }
    else if (!msg.ok) log(`scan inside DCS failed: ${msg.error}`);
  });
  link.start();
}

function locateDcs() {
  dcs = install.locate(globals || {});
  return dcs;
}

// Keep an installed hook in step with this plugin version.
function repairHook() {
  if (!dcs.savedGames) return;
  if (install.status(dcs.savedGames, LUA_DIR) === "outdated") {
    try { log(`dcs hook: ${install.install(dcs.savedGames, LUA_DIR, portOptions())}`); } catch (e) { log(`dcs hook: ${e.message}`); }
  }
}

const portOptions = () => ({ sendPort: intSetting(globals?.listenPort, 7790), listenPort: intSetting(globals?.sendPort, 7791) });

// Scan aircraft once when there are none yet.
function ensureCatalog() {
  if (catalog.units().length || !dcs.root || !findLua()) return;
  setTimeout(() => { catalog.scanAll(dcs); drawAll(); }, 50);
}

// --------------------------------------------------------------------------- aircraft and pages

const unitNow = () => link?.unit || null;

function aircraftOf(inst) {
  return inst.settings.aircraft || unitNow() || catalog.units()[0] || null;
}

function controlOf(inst) {
  const a = catalog.get(aircraftOf(inst));
  return a ? a.byId.get(inst.settings.control) || null : null;
}

function lightOf(inst) {
  const a = catalog.get(aircraftOf(inst));
  const arg = Number(inst.settings.arg);
  if (!a || !Number.isFinite(arg) || inst.settings.arg === "" || inst.settings.arg == null) return null;
  return a.lights.find((l) => l.arg === arg) || { arg, name: `arg ${arg}`, label: `arg ${arg}`, lamp: true };
}

function pageFor(unit) {
  const map = String(globals?.pages || "");
  for (const line of map.split(/\r?\n/)) {
    const [k, v] = line.split("=").map((s) => s?.trim());
    if (k && v && k === unit) return v;
  }
  return catalog.get(unit)?.page || unit;
}

function switchPage(page) {
  if (!page) return;
  send({ event: "switchToProfile", context: UUID, device: device || "", payload: { profile: page } });
}

function onUnit(unit) {
  log(unit ? `in ${unit}` : "out of the cockpit");
  if (unit && !catalog.get(unit)) scanUnit(unit);
  follower.reset();
  refreshWatch();
  drawAll();
  watchPages(!!unit);
  if (globals?.follow === false) return;
  if (!unit) {
    if (globals?.home !== "") switchPage(globals?.home || "DCS");
    return;
  }
  lastForward = Date.now();
  const a = catalog.get(unit);
  if (!a?.phases) return switchPage(pageFor(unit));
  // With phases, the first one decides the page; if it can't be told soon, use the main page.
  setTimeout(() => { if (unitNow() === unit && !follower.phase && !follower.alert) switchPage(pageFor(unit)); }, 3000);
}

// --------------------------------------------------------------------------- following the flight

const flightCtx = (a) => ({ value, flight: link?.flight || {}, groundBelowSpeed: a.groundBelowSpeed });

function scheduleFollow() {
  if (followTimer) return;
  followTimer = setTimeout(() => { followTimer = null; follow(); }, 200);
}

function follow() {
  const unit = unitNow();
  const a = unit && catalog.get(unit);
  if (!a || (!a.phases && !a.alerts) || globals?.follow === false) return;
  const r = follower.update(a, flightCtx(a), Date.now(), shownPage);
  if (!r) return;
  log(`page ${r.page} (${r.reason})`);
  lastForward = Date.now();
  switchPage(r.page);
}

// The page deckd shows right now, from its API (null on other hosts).
async function readShownPage() {
  if (!args.port) return null;
  try {
    const base = `http://127.0.0.1:${args.port}/api/devices`;
    const list = await (await fetch(base, { signal: AbortSignal.timeout(800) })).json();
    const serial = (list.find((d) => d.serial === device) || list[0])?.serial;
    if (!serial) return null;
    const info = await (await fetch(`${base}/${serial}`, { signal: AbortSignal.timeout(800) })).json();
    return typeof info.current === "string" ? info.current : null;
  } catch {
    return null;
  }
}

// deckd's own API says which page is showing, so an alert can go back to it afterwards. Other
// hosts don't have it; then the deck goes back to the flight phase's page instead.
function watchPages(on) {
  clearInterval(pageTimer);
  pageTimer = null;
  shownPage = null;
  if (!on || !args.port) return;
  const read = async () => { shownPage = await readShownPage(); };
  read();
  pageTimer = setInterval(read, 1000);
}

function scanUnit(unit) {
  if (catalog.importFromDcs(unit, dcs.savedGames)) return;
  const dir = findAircraft([dcs.savedGames, dcs.root].filter(Boolean)).get(unit);
  if (!dir) return log(`${unit}: no clickable cockpit found (Flaming Cliffs aircraft have none)`);
  if (findLua()) {
    catalog.scanAll(dcs);
  } else {
    // DCS runs under Wine/Proton, where the Linux root is drive Z:.
    const winDir = process.platform === "win32" ? dir : "Z:" + dir.replace(/\//g, "\\");
    link.requestScan(winDir);
  }
}

// --------------------------------------------------------------------------- live values

function value(arg) {
  const o = optimistic.get(arg);
  if (o && o.until > Date.now()) return o.value;
  return link?.values.get(arg);
}

function argsOf(inst) {
  const out = [];
  const kind = kindOf(inst.action);
  if (kind === "light") {
    const l = lightOf(inst);
    if (l) out.push(l.arg);
  }
  const c = controlOf(inst);
  if (c) {
    out.push(c.arg);
    if (c.axis) out.push(c.axis.arg);
    if (c.display?.args) out.push(...c.display.args);
    if (c.display?.drums) out.push(...c.display.drums.map((d) => d.arg));
  }
  if (inst.settings.lamp !== undefined && inst.settings.lamp !== "") out.push(Number(inst.settings.lamp));
  return out.filter(Number.isFinite);
}

// The watch entry for an instance's display text: a numeric indicator id, or a name the aircraft's
// overlay maps to a marker element ("ufc" -> the indicator holding UFC_mask).
// The overlay names displays either by a marker element only they have ("ufc": "UFC_mask") or by
// DCS's indicator number where several share element names ("lddi": 2).
function textWatchFor(inst, name) {
  if (name === undefined || name === null || name === "") return null;
  if (/^\d+$/.test(String(name))) return String(name);
  const marker = catalog.get(aircraftOf(inst))?.indicators?.[name];
  if (typeof marker === "number") return String(marker);
  return marker ? `${name}=${marker}` : null;
}

// The key the hook sends a display's text under.
function textKeyFor(inst, name) {
  const w = textWatchFor(inst, name);
  return w ? w.split("=")[0] : null;
}

const textWatchOf = (inst) => textWatchFor(inst, inst.settings.textIndicator);

function displayItems(inst, name) {
  const key = textKeyFor(inst, name);
  const text = key && link?.texts.get(key);
  return text == null ? null : parseIndication(text);
}

function refreshWatch() {
  if (!link) return;
  const unit = unitNow();
  const argsSet = new Set();
  const texts = new Set();
  for (const inst of instances.values()) {
    if (!unit || aircraftOf(inst) !== unit) continue;
    for (const a of argsOf(inst)) argsSet.add(a);
    for (const t of [textWatchOf(inst), textWatchFor(inst, inst.settings.pbDisplay)]) if (t) texts.add(t);
  }
  const a = unit && catalog.get(unit);
  if (a && globals?.follow !== false) for (const x of phases.argsOf(a.phases, a.alerts)) argsSet.add(x);
  link.watch(argsSet, texts);
}

function onValues(changed) {
  for (const [context, inst] of instances) {
    if (argsOf(inst).some((a) => changed.has(a))) draw(context);
  }
}

// Text from a cockpit display, when a knob/switch is set to show it.
function indicatorText(inst, element = inst.settings.textElement) {
  const items = displayItems(inst, inst.settings.textIndicator);
  if (!items) return null;
  const v = element ? items.get(element) : [...items.values()][0];
  return v == null ? (element ? "" : null) : v.replace(/\s+/g, " ").trim();
}

function onText() {
  for (const [context, inst] of instances) if (inst.settings.textIndicator || inst.settings.pbDisplay) draw(context);
}

// --------------------------------------------------------------------------- drawing

function linkState() {
  if (!link?.connected) return { live: false, why: "no DCS" };
  if (!unitNow()) return { live: false, why: "no aircraft" };
  return { live: true };
}

function controlView(inst) {
  const c = controlOf(inst);
  const s = inst.settings;
  if (!catalog.units().length) return { label: "DCS", value: "scan", dim: true };
  if (!c) return { label: s.label || "Cockpit", value: "pick", dim: true };
  const state = linkState();
  const live = state.live && aircraftOf(inst) === unitNow();
  const v = live ? value(c.arg) : undefined;
  const axisV = live && c.axis ? value(c.axis.arg) : undefined;
  const lampArg = s.lamp !== undefined && s.lamp !== "" ? Number(s.lamp) : null;
  const lampValue = live && lampArg != null ? value(lampArg) : undefined;
  // On a dial (or for a plain knob) show the axis; otherwise the switch position.
  const forAxis = !!c.axis && (c.kind === "axis" || inst.controller === "Encoder");
  const shown = forAxis ? axisV : v;
  const text = live ? indicatorText(inst) ?? (c.display ? controls.displayValue(c.display, value) : null) : null;
  let valueText;
  if (!live) valueText = "—";
  else if (text != null) valueText = text;
  else if (forAxis && c.axis.relative) valueText = ""; // a relative knob has no position to show
  else if (c.kind === "button" || (c.kind === "spring" && (s.mode || inst.controller === "Encoder"))) valueText = ""; // nothing to read out; a lamp, if any, is its state
  else valueText = controls.format(c, shown);
  const cue = live && s.textCue ? indicatorText(inst, s.textCue) : null;
  return {
    label: s.label || c.label,
    value: valueText,
    on: live && (cue != null ? cue !== "" : controls.isOn(c, v)),
    color: s.color || "green",
    level: live ? controls.level(c, shown) : null,
    lamp: lampArg != null ? { lit: (lampValue ?? 0) > 0.1, color: s.lampColor || "amber" } : null,
    dim: !live,
  };
}

function lightView(inst) {
  const l = lightOf(inst);
  const s = inst.settings;
  if (!l) return { label: s.label || "pick a light", lit: false, dim: true };
  const live = linkState().live && aircraftOf(inst) === unitNow();
  const v = live ? value(l.arg) : undefined;
  const threshold = Number.isFinite(Number(s.threshold)) && s.threshold !== "" ? Number(s.threshold) : 0.1;
  return { label: s.label || l.label, lit: live && (v ?? 0) > threshold, color: s.color || l.color || art.lampColor(l.name), dim: !live };
}

// A key command has no state of its own: a button cap with its label, dimmed while not flying.
function commandView(inst) {
  const s = inst.settings;
  const set = Number.isFinite(Number(s.command)) && s.command !== "" && s.command != null;
  const live = linkState().live && (!s.aircraft || s.aircraft === unitNow());
  return { label: s.label || (set ? `Command ${s.command}` : "pick a command"), value: live ? "" : "—", sub: s.sub || "", dim: !live || !set };
}

// A picker's buttons: "pnt_120=0, pnt_111=1" or one per line.
function pickerItems(inst) {
  return String(inst.settings.items || "").split(/[\n,]+/).map((x) => x.trim()).filter(Boolean).map((x) => {
    const [id, ...label] = x.split("=");
    return { id: id.trim(), label: label.join("=").trim() || id.trim() };
  });
}

function pickerView(inst) {
  const items = pickerItems(inst);
  const live = linkState().live && aircraftOf(inst) === unitNow();
  if (!items.length) return { label: inst.settings.label || "Picker", items: [], index: 0, dim: true };
  inst.index = ((inst.index ?? Number(inst.settings.start ?? 0)) % items.length + items.length) % items.length;
  // A display's side: show each button's live legend where it's known, else its number.
  let labels = items.map((i) => i.label);
  const shown = live && inst.settings.pbDisplay ? displayItems(inst, inst.settings.pbDisplay) : null;
  if (shown) {
    const a = catalog.get(aircraftOf(inst));
    const legends = displays.buttonLegends(a?.pbPages, shown);
    labels = items.map((i) => legends.get(Number(i.label)) ?? i.label);
  }
  return { label: inst.settings.label || "", text: live ? indicatorText(inst) : null, items: labels, index: inst.index, dim: !live };
}

// Read-out: "{txt_RPM_L}  {txt_RPM_R}" filled from a display's elements.
function readoutView(inst) {
  const s = inst.settings;
  const live = linkState().live && aircraftOf(inst) === unitNow();
  const items = live ? displayItems(inst, s.textIndicator) : null;
  const value = items
    ? String(s.template || "{}").replace(/\{([^}]*)\}/g, (_, name) => {
        const v = name ? items.get(name) : [...items.values()].find(Boolean);
        return v == null ? "—" : v.replace(/\s+/g, " ").trim();
      })
    : "—";
  return { label: s.label || "Read-out", value, sub: s.sub || "", on: false, dim: !items };
}

function statusView() {
  const hook = dcs.savedGames ? install.status(dcs.savedGames, LUA_DIR) : "missing";
  if (!dcs.root && !dcs.savedGames) return { title: "DCS", line1: "not found", line2: "set paths", state: "error" };
  if (hook === "missing" || hook === "unlinked") return { title: "DCS", line1: "no hook", line2: "install in settings", state: "error" };
  if (!link?.connected) return { title: "DCS", line1: "waiting", line2: "start a mission", state: "wait" };
  const unit = unitNow();
  if (!unit) return { title: "DCS", line1: "connected", line2: "not in a cockpit", state: "wait" };
  return { title: "DCS", line1: catalog.get(unit)?.name || unit, line2: catalog.get(unit) ? "press: aircraft page" : "no clickable cockpit", state: "ok" };
}

function render(inst) {
  const kind = kindOf(inst.action);
  const strip = inst.controller === "Encoder";
  if (kind === "status") return strip ? art.statusStrip(statusView(), inst.span) : art.statusKey(statusView());
  if (kind === "light") return art.lightKey(lightView(inst));
  if (kind === "command") return art.switchKey(commandView(inst));
  if (kind === "picker") return art.pickerStrip(pickerView(inst), strip ? inst.span : 1, !strip);
  if (kind === "readout") return strip ? art.knobStrip(readoutView(inst), inst.span) : art.switchKey(readoutView(inst));
  const view = controlView(inst);
  return strip ? art.knobStrip(view, inst.span) : art.switchKey(view);
}

function draw(context) {
  const inst = instances.get(context);
  if (!inst) return;
  const image = art.svgUri(render(inst));
  if (lastImage.get(context) === image) return;
  lastImage.set(context, image);
  send({ event: "setImage", context, payload: { image } });
}

function drawAll() { for (const context of instances.keys()) draw(context); }

// --------------------------------------------------------------------------- input

function sendCommands(cmds, control) {
  if (!cmds.length) return false;
  if (cmds.some((c) => c.release)) {
    // Nudges: press, let go a moment later, then the next one.
    cmds.forEach((c, i) => {
      setTimeout(() => link?.click(c.device, c.action, c.value), i * 160);
      if (c.release) setTimeout(() => link?.click(c.release.device, c.release.action, c.release.value), i * 160 + 80);
    });
    return true;
  }
  for (const c of cmds) {
    link.click(c.device, c.action, c.value);
    // Show the new position right away for switches and absolute knobs.
    const side = control.sides.find((s) => s.action === c.action && s.type !== "momentary" && !s.relative);
    if (side) optimistic.set(side.arg, { value: c.value, until: Date.now() + 700 });
  }
  return true;
}

function canAct(context, inst, c) {
  if (!c || !linkState().live || aircraftOf(inst) !== unitNow()) {
    send({ event: "showAlert", context });
    return false;
  }
  return true;
}

function keyDown(context, inst) {
  const kind = kindOf(inst.action);
  if (kind === "status") {
    const unit = unitNow();
    if (unit) switchPage(follower.phase?.page || pageFor(unit));
    else send({ event: "showAlert", context });
    return;
  }
  if (kind === "readout") return; // shows values only
  if (kind === "picker") {
    const item = pickerItems(inst)[inst.index ?? 0];
    const a = catalog.get(aircraftOf(inst));
    const c = item && a?.byId.get(item.id);
    if (!canAct(context, inst, c)) return;
    inst.down = true;
    inst.pressed = c;
    inst.pressOpts = {};
    sendCommands(controls.press(c, value, {}), c);
    return;
  }
  if (kind === "command") {
    const s = inst.settings;
    const command = Number(s.command);
    if (!linkState().live || s.command === "" || s.command == null || !Number.isFinite(command) || (s.aircraft && s.aircraft !== unitNow())) {
      send({ event: "showAlert", context });
      return;
    }
    const v = s.value === "" || s.value == null ? undefined : Number(s.value);
    link.keyCommand(command, Number.isFinite(v) ? v : undefined);
    inst.down = true;
    return;
  }
  const c = controlOf(inst);
  if (kind === "light" && !c) return; // a light without a control to press
  if (!canAct(context, inst, c)) return;
  inst.down = true;
  const opts = { mode: inst.settings.mode, position: inst.settings.position, step: Number(inst.settings.step) || undefined };
  if (inst.controller === "Encoder" && c.push && !inst.settings.mode) opts.mode = `side:${c.push.index}`;
  inst.pressOpts = opts;
  sendCommands(controls.press(c, value, opts), c);
  draw(context);
}

function keyUp(context, inst) {
  if (!inst.down) return;
  inst.down = false;
  if (kindOf(inst.action) === "picker") {
    if (inst.pressed && link) sendCommands(controls.release(inst.pressed, {}), inst.pressed);
    inst.pressed = null;
    return;
  }
  if (kindOf(inst.action) === "command") {
    const release = Number(inst.settings.release);
    if (inst.settings.release !== "" && inst.settings.release != null && Number.isFinite(release) && link) link.keyCommand(release);
    return;
  }
  const c = controlOf(inst);
  if (c && link) sendCommands(controls.release(c, inst.pressOpts || {}), c);
  draw(context);
}

function rotate(context, inst, ticks) {
  if (kindOf(inst.action) === "picker") {
    const n = pickerItems(inst).length;
    if (!n || !ticks) return;
    inst.index = (((inst.index ?? 0) + ticks) % n + n) % n;
    draw(context);
    return;
  }
  const c = controlOf(inst);
  if (!c || !ticks || !linkState().live || aircraftOf(inst) !== unitNow()) return;
  const step = Number(inst.settings.step) || undefined;
  sendCommands(controls.rotate(c, value, ticks, { step }), c);
  draw(context);
}

// --------------------------------------------------------------------------- settings panel

function catalogPayload(unit) {
  const a = catalog.get(unit);
  if (!a) return null;
  return {
    unit: a.unit,
    name: a.name,
    controls: a.controls.map((c) => ({
      id: c.id, label: c.label, hint: c.hint, group: c.group, kind: c.kind, core: !!c.core,
      positions: c.stepPositions || null, names: c.names || null, arg: c.arg,
      sides: c.sides.map((s) => ({ index: s.index, type: s.type, value: s.value, relative: !!s.relative })),
    })),
    lights: a.lights,
  };
}

function statusPayload() {
  return {
    root: dcs.root, savedGames: dcs.savedGames,
    hook: dcs.savedGames ? install.status(dcs.savedGames, LUA_DIR) : "missing",
    lua: findLua(), connected: !!link?.connected, unit: unitNow(),
    units: catalog.units(), log: dcsLog.slice(-6),
    found: [...findAircraft([dcs.savedGames, dcs.root].filter(Boolean)).keys()],
  };
}

function toInspector(context, payload) {
  send({ event: "sendToPropertyInspector", context, payload });
}

function onInspector(context, inst, payload) {
  const request = payload?.request;
  const reply = (extra = {}) => toInspector(context, { status: statusPayload(), ...extra });
  try {
    switch (request) {
      case "status": return reply();
      case "catalog": {
        const unit = payload.unit || (inst && aircraftOf(inst)) || catalog.units()[0];
        return reply({ catalog: catalogPayload(unit) });
      }
      case "install":
        locateDcs();
        return reply({ message: install.install(dcs.savedGames, LUA_DIR, portOptions()) });
      case "uninstall":
        return reply({ message: install.uninstall(dcs.savedGames) });
      case "rescan": {
        locateDcs();
        if (!findLua()) return reply({ message: "No Lua found here; aircraft will be scanned inside DCS when you fly them." });
        const r = catalog.scanAll(dcs);
        refreshWatch();
        drawAll();
        return reply({ message: `Scanned ${r.scanned.join(", ") || "nothing"}${r.failed.length ? `; failed: ${r.failed.map((f) => f.join(": ")).join("; ")}` : ""}` });
      }
      case "dump":
        if (!link?.connected) return reply({ message: "Start a mission first." });
        link.dumpIndicators();
        return reply({ message: "Written to Saved Games/DCS/Logs/deckd-indicators.txt" });
    }
  } catch (e) {
    reply({ message: e.message, error: true });
  }
}

// --------------------------------------------------------------------------- events

function remember(msg) {
  const inst = instances.get(msg.context) || {};
  inst.action = msg.action || inst.action;
  inst.controller = msg.payload?.controller || inst.controller || "Keypad";
  inst.settings = msg.payload?.settings || inst.settings || {};
  inst.span = msg.payload?.span || inst.span || 1;
  if (msg.device) device = msg.device;
  instances.set(msg.context, inst);
  return inst;
}

function handle(msg) {
  switch (msg.event) {
    case "deviceDidConnect":
      device = device || msg.device;
      break;
    case "willAppear": {
      const inst = remember(msg);
      lastImage.delete(msg.context);
      refreshWatch();
      draw(msg.context);
      // Back on the landing page while flying: go on to the aircraft's page. Only from the landing
      // page itself: a Status button on any other page (a menu) must not bounce you off it.
      if (kindOf(inst.action) === "status" && unitNow() && globals?.follow !== false && Date.now() - lastForward > 3000) {
        const landing = globals?.home || "DCS";
        readShownPage().then((page) => {
          if (page !== landing || !unitNow() || Date.now() - lastForward <= 3000) return;
          lastForward = Date.now();
          switchPage(follower.phase?.page || pageFor(unitNow()));
        });
      }
      break;
    }
    case "willDisappear": {
      const inst = instances.get(msg.context);
      if (inst?.down) keyUp(msg.context, inst);
      instances.delete(msg.context);
      lastImage.delete(msg.context);
      refreshWatch();
      break;
    }
    case "didReceiveSettings":
      remember(msg);
      refreshWatch();
      draw(msg.context);
      break;
    case "keyDown":
    case "dialDown":
      keyDown(msg.context, remember(msg));
      break;
    case "keyUp":
    case "dialUp":
      keyUp(msg.context, remember(msg));
      break;
    case "touchTap": {
      const inst = remember(msg);
      // On a picker that shows its buttons side by side, tapping one picks and presses it.
      const n = kindOf(inst.action) === "picker" ? pickerItems(inst).length : 0;
      const x = msg.payload?.tapPos?.[0];
      if (n && n <= 6 && Number.isFinite(x)) inst.index = Math.min(n - 1, Math.max(0, Math.floor(x / ((200 * (inst.span || 1)) / n))));
      keyDown(msg.context, inst);
      setTimeout(() => keyUp(msg.context, inst), 120);
      break;
    }
    case "dialRotate":
      rotate(msg.context, remember(msg), msg.payload?.ticks || 0);
      break;
    case "sendToPlugin":
      onInspector(msg.context, instances.get(msg.context), msg.payload);
      break;
    case "propertyInspectorDidAppear":
      toInspector(msg.context, { status: statusPayload() });
      break;
    case "didReceiveGlobalSettings":
      globals = msg.payload?.settings || {};
      locateDcs();
      startLink();
      repairHook();
      ensureCatalog();
      refreshWatch();
      drawAll();
      break;
  }
}
