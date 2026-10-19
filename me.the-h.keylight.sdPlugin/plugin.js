// Key Light Control — Elgato Key Light family controls from a deck (Node >= 22, no deps).
//
// Five actions share one "selected" light: a dial to pick it, a key to toggle it (hold to blink it),
// a key to blink it, and dials for brightness and colour temperature. Lights are found over mDNS
// and/or listed by address in the settings panel; the choice is kept in the plugin's global settings.

const lights = require("./lights");

// --------------------------------------------------------------------------- startup

const args = {};
for (let i = 2; i + 1 < process.argv.length; i += 2) args[process.argv[i].replace(/^-/, "")] = process.argv[i + 1];

const log = (...msg) => console.log(new Date().toISOString(), ...msg);

const ws = new WebSocket(`ws://127.0.0.1:${args.port}`);
const send = (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

ws.onopen = () => {
  send({ event: args.registerEvent, uuid: args.pluginUUID });
  send({ event: "getGlobalSettings", context: args.pluginUUID });
};
ws.onclose = () => process.exit(0);
ws.onmessage = (m) => {
  let msg;
  try { msg = JSON.parse(m.data); } catch { return; }
  handle(msg).catch((e) => log(`${msg.event} failed:`, e.stack || e));
};

// --------------------------------------------------------------------------- config

const ACTION = (suffix) => `${args.pluginUUID}.${suffix}`;
const SELECT = ACTION("select");
const IDENTIFY = ACTION("identify");
const TOGGLE = ACTION("toggle");
const BRIGHTNESS = ACTION("brightness");
const TEMPERATURE = ACTION("temperature");
const STATEFUL = [SELECT, TOGGLE, BRIGHTNESS, TEMPERATURE];

const LONG_PRESS_MS = 500;
const POLL_MS = 5000;
const KELVIN_MIN = 2900;
const KELVIN_MAX = 7000;

// Material Design Icons (Apache 2.0), 24x24.
const PATHS = {
  bulbOn: "M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7z",
  bulbOff: "M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7zm2.85 11.1l-.85.6V16h-4v-2.3l-.85-.6A4.997 4.997 0 0 1 7 9c0-2.76 2.24-5 5-5s5 2.24 5 5c0 1.63-.8 3.16-2.15 4.1z",
  identify: "M7 2v11h3v9l7-12h-4l4-8z",
  list: "M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z",
  brightness: "M20 15.31L23.31 12 20 8.69V4h-4.69L12 .69 8.69 4H4v4.69L.69 12 4 15.31V20h4.69L12 23.31 15.31 20H20v-4.69zM12 18V6c3.31 0 6 2.69 6 6s-2.69 6-6 6z",
  temperature: "M15 13V5c0-1.66-1.34-3-3-3S9 3.34 9 5v8c-1.21.91-2 2.37-2 4 0 2.76 2.24 5 5 5s5-2.24 5-5c0-1.63-.79-3.09-2-4zm-4-8c0-.55.45-1 1-1s1 .45 1 1h-1v1h1v2h-1v1h1v2h-2V5z",
};

// Default colours per action; the settings panel (pi/index.html) uses the same keys.
const DEFAULTS = {
  [TOGGLE]: { onColor: "#ffc83d", offColor: "#6a6a6a", onBackground: "", offBackground: "" },
  [IDENTIFY]: { color: "#ffffff", background: "" },
  [SELECT]: { iconColor: "#ffffff", titleColor: "#ffffff", valueColor: "#ffffff" },
  [BRIGHTNESS]: { iconColor: "#ffc83d", titleColor: "#ffffff", valueColor: "#ffffff", barColor: "#ffc83d" },
  [TEMPERATURE]: { iconColor: "#ffffff", titleColor: "#ffffff", valueColor: "#ffffff", barColor: "#ffffff" },
};

/** A colour setting, or its default when unset or malformed ("" means "none" for backgrounds). */
function colorOf(ctx, key) {
  const v = contexts.get(ctx)?.settings?.[key];
  if (typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v)) return v;
  return DEFAULTS[contexts.get(ctx)?.action]?.[key] ?? "#ffffff";
}

const svgUri = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

/** A key picture: the icon centred, on an optional background. */
function keyImage(path, color, background) {
  const bg = background ? `<rect width="144" height="144" fill="${background}"/>` : "";
  return svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">${bg}<path transform="translate(30 30) scale(3.5)" fill="${color}" d="${path}"/></svg>`);
}

const dialIcon = (path, color) => svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="${color}" d="${path}"/></svg>`);

// --------------------------------------------------------------------------- events

/** context -> { action, settings } for every action instance currently on the deck. */
const contexts = new Map();
/** context:kind -> last message sent, to skip redundant updates. */
const sent = new Map();
/** Plugin-wide settings: { light: selected light's name, addresses: "ip, ip" }. */
let globals = {};
let globalsLoaded = false;
let onGlobals;
const globalsReady = new Promise((resolve) => (onGlobals = resolve)); // the selected light depends on them

const contextsOf = (...actions) => [...contexts].filter(([, c]) => actions.includes(c.action)).map(([ctx]) => ctx);

/** Sends an update unless it's identical to the last one for that context and kind. */
function sendOnce(ctx, kind, msg) {
  const key = `${ctx}:${kind}`;
  const body = JSON.stringify(msg);
  if (sent.get(key) === body) return;
  sent.set(key, body);
  send(msg);
}

async function handle({ event, action, context: ctx, payload = {} }) {
  switch (event) {
    case "willAppear":
      contexts.set(ctx, { action, settings: payload.settings || {} });
      for (const k of [...sent.keys()]) if (k.startsWith(`${ctx}:`)) sent.delete(k);
      draw(ctx);
      refreshLight();
      break;
    case "willDisappear":
      contexts.delete(ctx);
      cancelPress(ctx);
      break;
    case "didReceiveSettings":
      if (contexts.has(ctx)) {
        contexts.get(ctx).settings = payload.settings || {};
        draw(ctx);
      }
      break;
    case "didReceiveGlobalSettings": {
      const before = globalsLoaded && manualAddresses().join();
      globals = payload.settings || {};
      // New manual addresses from the settings panel: search again so they show up.
      if (globalsLoaded && before !== manualAddresses().join()) discoverLights();
      globalsLoaded = true;
      onGlobals();
      break;
    }
    case "keyDown":
    case "dialDown":
      pressDown(ctx, action);
      break;
    case "keyUp":
    case "dialUp":
      pressUp(ctx, action);
      break;
    case "touchTap":
      if (action === SELECT) run(ctx, discoverLights);
      break;
    case "dialRotate":
      await rotate(ctx, action, payload.ticks || 0);
      break;
    case "sendToPlugin":
      if (payload.command === "lights") {
        send({ event: "sendToPropertyInspector", context: ctx, payload: { lights: state.list, selected: state.list[state.index]?.name } });
      }
      break;
  }
}

// --------------------------------------------------------------------------- presses

const presses = new Map(); // context -> { timer, long }

function cancelPress(ctx) {
  clearTimeout(presses.get(ctx)?.timer);
  presses.delete(ctx);
}

function pressDown(ctx, action) {
  cancelPress(ctx);
  const onLong = longPressAction(action);
  const p = { long: false, timer: null };
  if (onLong) p.timer = setTimeout(() => { p.long = true; run(ctx, onLong); }, LONG_PRESS_MS);
  presses.set(ctx, p);
}

function pressUp(ctx, action) {
  const p = presses.get(ctx);
  cancelPress(ctx);
  if (p?.long) return;
  const onShort = shortPressAction(action);
  if (onShort) run(ctx, onShort);
}

function run(ctx, fn) {
  fn(ctx).catch((e) => {
    log("action failed:", e.message || e);
    send({ event: "showAlert", context: ctx });
  });
}

function shortPressAction(action) {
  return {
    [TOGGLE]: toggleLight,
    [IDENTIFY]: identifyLight,
    [SELECT]: discoverLights,
    [BRIGHTNESS]: () => setLight({ brightness: 50 }),
    [TEMPERATURE]: () => setLight({ kelvin: Math.round((KELVIN_MIN + KELVIN_MAX) / 2) }),
  }[action];
}

function longPressAction(action) {
  return {
    [TOGGLE]: identifyLight,
    [BRIGHTNESS]: () => setLight({ brightness: 100 }),
    [TEMPERATURE]: () => setLight({ kelvin: KELVIN_MAX }),
  }[action];
}

async function rotate(ctx, action, ticks) {
  if (!ticks) return;
  if (action === SELECT) {
    if (!state.list.length) return;
    const n = state.list.length;
    state.index = (((state.index + ticks) % n) + n) % n;
    state.light = null;
    globals = { ...globals, light: state.list[state.index].name };
    send({ event: "setGlobalSettings", context: args.pluginUUID, payload: globals });
    drawAll(...STATEFUL);
    await refreshLight();
  } else if (action === BRIGHTNESS) {
    const cur = state.light?.brightness ?? 50;
    await setLight({ brightness: clamp(cur + ticks * 5, 0, 100) });
  } else if (action === TEMPERATURE) {
    const cur = state.light?.kelvin ?? 4950;
    await setLight({ kelvin: clamp(cur + ticks * 100, KELVIN_MIN, KELVIN_MAX) });
  }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// --------------------------------------------------------------------------- drawing

function drawAll(...actions) {
  for (const ctx of contextsOf(...actions)) draw(ctx);
}

/** Two-state key: one coloured picture per state, then the state that matches reality. */
function drawToggle(ctx, [offPath, onPath], on) {
  for (const [st, path, prefix] of [[0, offPath, "off"], [1, onPath, "on"]]) {
    const image = keyImage(path, colorOf(ctx, `${prefix}Color`), colorOf(ctx, `${prefix}Background`));
    sendOnce(ctx, `image${st}`, { event: "setImage", context: ctx, payload: { image, state: st, target: 0 } });
  }
  sendOnce(ctx, "state", { event: "setState", context: ctx, payload: { state: on ? 1 : 0 } });
}

function feedback(ctx, { icon, title, value, bar }) {
  const payload = {
    icon: dialIcon(icon, colorOf(ctx, "iconColor")),
    title: { value: title, color: colorOf(ctx, "titleColor") },
    value: { value, color: colorOf(ctx, "valueColor") },
  };
  if (bar) payload.indicator = { value: bar.value, range: { min: bar.min, max: bar.max }, bar_fill_c: colorOf(ctx, "barColor") };
  sendOnce(ctx, "feedback", { event: "setFeedback", context: ctx, payload });
}

function draw(ctx) {
  const c = contexts.get(ctx);
  if (!c) return;
  const light = state.list[state.index];
  const st = state.light;
  switch (c.action) {
    case TOGGLE:
      return drawToggle(ctx, [PATHS.bulbOff, PATHS.bulbOn], st?.on);
    case IDENTIFY:
      return sendOnce(ctx, "image", { event: "setImage", context: ctx, payload: { image: keyImage(PATHS.identify, colorOf(ctx, "color"), colorOf(ctx, "background")), target: 0 } });
    case SELECT:
      return feedback(ctx, {
        icon: PATHS.list,
        title: light ? light.name : state.searching ? "Searching…" : "No lights",
        value: light ? `${state.index + 1}/${state.list.length}` : "",
      });
    case BRIGHTNESS:
      return feedback(ctx, {
        icon: PATHS.brightness,
        title: "Brightness",
        value: st ? (st.on ? `${st.brightness}%` : "Off") : "—",
        bar: { value: st?.brightness ?? 0, min: 0, max: 100 },
      });
    case TEMPERATURE:
      return feedback(ctx, {
        icon: PATHS.temperature,
        title: "Temperature",
        value: st ? `${st.kelvin}K` : "—",
        bar: { value: st?.kelvin ?? KELVIN_MIN, min: KELVIN_MIN, max: KELVIN_MAX },
      });
  }
}

// --------------------------------------------------------------------------- lights

/** Found lights, the selected index, and the selected light's last known state. */
const state = { list: [], index: 0, light: null, searching: false };
let discovery = null;

const manualAddresses = () => String(globals.addresses || "").split(/[\s,]+/).filter(Boolean);

function discoverLights() {
  discovery ||= (async () => {
    await globalsReady;
    state.searching = true;
    drawAll(SELECT);
    try {
      state.list = await lights.findLights(manualAddresses());
      const i = state.list.findIndex((l) => l.name === globals.light);
      state.index = i >= 0 ? i : Math.min(state.index, Math.max(state.list.length - 1, 0));
      log(`found ${state.list.length} light(s)`);
    } finally {
      state.searching = false;
      discovery = null;
      drawAll(...STATEFUL);
    }
    await refreshLight(false);
  })();
  return discovery;
}

/** The selected light, searching first if none are known. */
async function selectedLight() {
  if (!state.list.length) await discoverLights();
  const light = state.list[state.index];
  if (!light) throw new Error("no light found");
  return light;
}

const toState = (l) => ({ on: l.on === 1, brightness: l.brightness, kelvin: lights.miredToKelvin(l.temperature) });

async function refreshLight(discover = true) {
  if (!discover && !state.list.length) return;
  try {
    const light = await selectedLight();
    state.light = toState((await lights.getState(light.ip)).lights[0]);
  } catch (e) {
    log("light state:", e.message);
  }
  drawAll(...STATEFUL);
}

async function toggleLight() {
  const light = await selectedLight();
  if (!state.light) await refreshLight();
  await setLight({ on: !state.light?.on }, light);
}

async function identifyLight() {
  await lights.identify((await selectedLight()).ip);
}

// Changes are applied locally at once and sent one request at a time, so fast dial turns
// don't queue up dozens of HTTP calls: only the latest wanted state goes out next.
let pushing = false;
let pushAgain = false;

async function setLight(change, light) {
  light ||= await selectedLight();
  if (!state.light) await refreshLight();
  if (!state.light) throw new Error("light state unknown");
  Object.assign(state.light, change);
  drawAll(...STATEFUL);
  if (pushing) { pushAgain = true; return; }
  pushing = true;
  try {
    do {
      pushAgain = false;
      const s = state.light;
      const res = await lights.setState(light.ip, { on: s.on ? 1 : 0, brightness: s.brightness, temperature: lights.kelvinToMired(s.kelvin) });
      if (!pushAgain && res?.lights?.[0]) state.light = toState(res.lights[0]);
    } while (pushAgain);
  } finally {
    pushing = false;
    drawAll(...STATEFUL);
  }
}

// --------------------------------------------------------------------------- polling

// Pick up changes made elsewhere (another app, the light's own button) while visible.
setInterval(() => {
  if (contextsOf(...STATEFUL).length && !pushing) refreshLight(false);
}, POLL_MS);
