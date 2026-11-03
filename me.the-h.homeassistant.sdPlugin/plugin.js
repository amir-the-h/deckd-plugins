// Home Assistant: live entity states and controls over Home Assistant's WebSocket API (Node >= 22, no deps).
//
//   entity   any entity's state. Press does the natural thing for its type (toggle a light or switch,
//            run a script, activate a scene, start or dock a vacuum, play/pause media, lock/unlock…).
//            On a dial, turning adjusts it (brightness, fan speed, volume, target temperature, cover
//            position, number value) and touching the strip presses it.
//   service  calls any service with your own data, optionally showing an entity's state.
//   vacuum   a robot vacuum: state, battery and charging. Press to clean (the room picked on a dial, or
//            everywhere) or pause/resume; hold to stop and send it to its dock. On a dial, turn to pick a
//            room from the vacuum's map.

const tls = require("node:tls");
const { HomeAssistant } = require("./ha.js");

// Home Assistant behind a reverse proxy often uses a private CA from the OS trust store, which Node
// ignores unless NODE_EXTRA_CA_CERTS is set. Trust the system store as well (Node >= 22.19).
try {
  tls.setDefaultCACertificates([...tls.getCACertificates("default"), ...tls.getCACertificates("system")]);
} catch {}

// --------------------------------------------------------------------------- startup

const args = {};
for (let i = 2; i + 1 < process.argv.length; i += 2) args[process.argv[i].replace(/^-/, "")] = process.argv[i + 1];

const ws = new WebSocket(`ws://127.0.0.1:${args.port}`);
const send = (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
const log = (message) => { console.log(message); send({ event: "logMessage", payload: { message } }); };

ws.onopen = () => {
  send({ event: args.registerEvent, uuid: args.pluginUUID });
  send({ event: "getGlobalSettings", context: args.pluginUUID });
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

// --------------------------------------------------------------------------- connection

let globals = null;
let ha = null;
let haKey = "";

function connect() {
  const key = JSON.stringify([globals?.url || "", globals?.token || ""]);
  if (ha && key === haKey) return;
  ha?.close();
  haKey = key;
  ha = new HomeAssistant({
    url: globals?.url,
    token: globals?.token,
    log,
    onStatus: (status) => { if (status === "connected") loadServices(); drawAll(); },
    onChange: (ids) => {
      if (!ids) return drawAll();
      const set = new Set(ids);
      for (const [context, inst] of instances) if (set.has(shownEntity(inst))) draw(context);
    },
  });
}

const stateOf = (id) => (id && ha?.states.get(id)) || null;

// --------------------------------------------------------------------------- what each entity does

const domainOf = (id) => String(id || "").split(".")[0];

// The service a press calls for an entity, or null when pressing it does nothing.
function pressService(id, s) {
  const domain = domainOf(id);
  const state = s?.state;
  switch (domain) {
    case "light": case "switch": case "fan": case "input_boolean": case "siren": case "humidifier":
    case "automation": case "cover": case "climate": case "water_heater": case "remote":
      return `${domain}.toggle`;
    case "script": case "scene": return `${domain}.turn_on`;
    case "button": case "input_button": return `${domain}.press`;
    case "lock": return state === "locked" ? "lock.unlock" : "lock.lock";
    case "media_player": return "media_player.media_play_pause";
    case "vacuum": return state === "cleaning" || state === "returning" ? "vacuum.return_to_base" : "vacuum.start";
    case "lawn_mower": return state === "mowing" ? "lawn_mower.dock" : "lawn_mower.start_mowing";
    case "valve": return "valve.toggle";
    default: return null;
  }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const roundTo = (v, step) => Math.round(v / step) * step;

// What turning a dial by `ticks` does to an entity: [service, data, optimistic attribute changes], or null.
function turn(id, s, ticks) {
  const a = s?.attributes || {};
  switch (domainOf(id)) {
    case "light": {
      const pct = clamp(Math.round(((a.brightness ?? 0) / 255) * 100) + ticks * 5, 0, 100);
      return pct === 0 ? ["light.turn_off", {}, { brightness: 0 }, "off"] : ["light.turn_on", { brightness_pct: pct }, { brightness: Math.round((pct / 100) * 255) }, "on"];
    }
    case "fan": {
      const step = a.percentage_step || 10;
      const pct = clamp(roundTo((a.percentage ?? 0) + ticks * step, step), 0, 100);
      return ["fan.set_percentage", { percentage: pct }, { percentage: pct }, pct ? "on" : "off"];
    }
    case "media_player": {
      const vol = clamp(Math.round(((a.volume_level ?? 0) + ticks * 0.02) * 100) / 100, 0, 1);
      return ["media_player.volume_set", { volume_level: vol }, { volume_level: vol }];
    }
    case "climate": case "water_heater": {
      const step = a.target_temp_step || (a.temperature_unit === "°F" ? 1 : 0.5);
      const cur = a.temperature ?? a.target_temp_low ?? a.current_temperature ?? 20;
      const t = clamp(roundTo(cur + ticks * step, step), a.min_temp ?? -100, a.max_temp ?? 100);
      return [`${domainOf(id)}.set_temperature`, { temperature: t }, { temperature: t }];
    }
    case "cover": {
      if (a.current_position == null) return null;
      const pos = clamp(a.current_position + ticks * 5, 0, 100);
      return ["cover.set_cover_position", { position: pos }, { current_position: pos }];
    }
    case "number": case "input_number": {
      const step = Number(a.step) || 1;
      const v = clamp(roundTo(Number(s.state) + ticks * step, step), a.min ?? -Infinity, a.max ?? Infinity);
      return [`${domainOf(id)}.set_value`, { value: v }, {}, String(v)];
    }
    default: return null;
  }
}

// --------------------------------------------------------------------------- describing a state

const RED = "#e05a5a", AMBER = "#e0a030", GREEN = "#4caf7d", BLUE = "#5aa9e6", YELLOW = "#f2c94c";
const GREY = "#555", TEXT = "#f2f2f2", DIM = "#9a9a9a", SOFT = "#d8d8d8";
const ON_STATES = new Set(["on", "open", "opening", "unlocked", "playing", "cleaning", "home", "heat", "cool", "heat_cool", "auto", "dry", "fan_only", "active", "mowing"]);

const nice = (s) => String(s).replace(/_/g, " ");
const num = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return Math.abs(n) >= 100 || Number.isInteger(n) ? String(Math.round(n)) : n.toFixed(1);
};

// -> { big, small, color, level (0..1 or null) }
function describe(id, s, attribute) {
  if (!s) return { big: "?", small: "not found", color: GREY, level: null };
  const a = s.attributes || {};
  if (s.state === "unavailable" || s.state === "unknown") return { big: nice(s.state), small: "", color: GREY, level: null };
  if (attribute) {
    const v = a[attribute];
    const unit = /battery|percent|level/.test(attribute) && Number.isFinite(Number(v)) && Number(v) <= 100 ? "%" : "";
    return { big: v == null ? "—" : `${num(v)}${unit}`, small: nice(attribute), color: TEXT, level: unit === "%" ? Number(v) / 100 : null };
  }
  const on = ON_STATES.has(s.state);
  switch (domainOf(id)) {
    case "light": {
      const pct = on && a.brightness != null ? Math.round((a.brightness / 255) * 100) : null;
      return { big: on ? (pct != null ? `${pct}%` : "ON") : "OFF", small: "", color: on ? YELLOW : GREY, level: on ? (pct ?? 100) / 100 : 0 };
    }
    case "fan":
      return { big: on ? (a.percentage != null ? `${a.percentage}%` : "ON") : "OFF", small: a.preset_mode ? nice(a.preset_mode) : "", color: on ? BLUE : GREY, level: on ? (a.percentage ?? 100) / 100 : 0 };
    case "media_player": {
      const title = a.media_title || a.app_name || "";
      return { big: nice(s.state).toUpperCase(), small: title, color: s.state === "playing" ? GREEN : s.state === "off" ? GREY : SOFT, level: a.volume_level ?? null };
    }
    case "climate": case "water_heater": {
      const cur = a.current_temperature, target = a.temperature;
      return { big: cur != null ? `${num(cur)}°` : nice(s.state), small: s.state === "off" ? "off" : target != null ? `→ ${num(target)}° ${nice(s.state)}` : nice(s.state), color: s.state === "off" ? GREY : a.hvac_action === "heating" ? AMBER : a.hvac_action === "cooling" ? BLUE : TEXT, level: null };
    }
    case "cover":
      return { big: a.current_position != null ? `${a.current_position}%` : nice(s.state).toUpperCase(), small: nice(s.state), color: on ? BLUE : GREY, level: a.current_position != null ? a.current_position / 100 : null };
    case "vacuum": {
      const battery = a.battery_level;
      return { big: nice(s.state).toUpperCase(), small: battery != null ? `battery ${battery}%` : "", color: s.state === "cleaning" ? GREEN : s.state === "error" ? RED : s.state === "returning" ? BLUE : SOFT, level: battery != null ? battery / 100 : null };
    }
    case "lock":
      return { big: nice(s.state).toUpperCase(), small: "", color: s.state === "locked" ? GREEN : s.state === "jammed" ? RED : AMBER, level: null };
    case "binary_sensor":
      return { big: on ? "ON" : "OFF", small: a.device_class ? nice(a.device_class) : "", color: on ? AMBER : GREY, level: null };
    case "person": case "device_tracker":
      return { big: s.state === "home" ? "HOME" : s.state === "not_home" ? "AWAY" : nice(s.state), small: "", color: s.state === "home" ? GREEN : DIM, level: null };
    case "sensor": case "number": case "input_number": case "counter": {
      const unit = a.unit_of_measurement || "";
      const isNum = Number.isFinite(Number(s.state));
      return { big: isNum ? `${num(s.state)}${unit === "%" ? "%" : ""}` : nice(s.state), small: isNum && unit !== "%" ? unit : "", color: TEXT, level: unit === "%" && isNum ? Number(s.state) / 100 : null };
    }
    case "script": case "automation":
      return { big: domainOf(id) === "script" ? (on ? "RUNNING" : "RUN") : on ? "ON" : "OFF", small: "", color: on ? GREEN : SOFT, level: null };
    case "scene": case "button": case "input_button":
      return { big: domainOf(id) === "scene" ? "SCENE" : "PRESS", small: "", color: SOFT, level: null };
    default:
      return { big: ["on", "off"].includes(s.state) ? s.state.toUpperCase() : nice(s.state), small: "", color: on ? GREEN : s.state === "off" ? GREY : TEXT, level: null };
  }
}

// --------------------------------------------------------------------------- vacuums

// Rooms from the vacuum's `rooms` attribute, as [{ id, name }]. Integrations publish it as a list, as
// { map name: list } (the selected map wins), or as { id: name }.
function vacuumRooms(s) {
  const a = s?.attributes || {};
  let r = a.rooms;
  if (!r || typeof r !== "object") return [];
  if (!Array.isArray(r)) {
    const values = Object.values(r);
    if (values.every((v) => Array.isArray(v))) r = r[a.selected_map] || values.flat();
    else r = Object.entries(r).map(([id, name]) => ({ id, name: typeof name === "string" ? name : name?.name }));
  }
  return r
    .map((x) => ({ id: x.id ?? x.segment_id ?? x.room_id, name: x.name || x.room_name || `Room ${x.id}` }))
    .filter((x) => x.id != null);
}

const vacuumBattery = (s) => {
  const a = s?.attributes || {};
  const b = a.battery_level ?? a.battery;
  return Number.isFinite(Number(b)) ? Number(b) : null;
};

// -> { word, color, charging }
function vacuumStatus(s) {
  const a = s?.attributes || {};
  const state = s?.state;
  const charging = a.charging === true || /charging(?!_completed)/.test(a.vacuum_state || a.charging_status || "");
  if (!s || state === "unavailable" || state === "unknown") return { word: s ? nice(state) : "not found", color: GREY, charging: false };
  if (state === "error" || a.has_error === true) return { word: "Error", color: RED, charging };
  if (state === "cleaning") return { word: a.segment_cleaning ? "Cleaning room" : "Cleaning", color: GREEN, charging: false };
  if (state === "returning") return { word: "Returning", color: BLUE, charging: false };
  if (state === "paused") return { word: "Paused", color: AMBER, charging: false };
  if (charging) return { word: "Charging", color: BLUE, charging };
  if (state === "docked") return { word: "Docked", color: SOFT, charging };
  return { word: nice(state).replace(/^./, (c) => c.toUpperCase()), color: SOFT, charging };
}

// The room a vacuum dial points at: null for everywhere.
function vacuumChoice(inst, rooms) {
  const i = clamp(inst.cursor || 0, 0, rooms.length);
  inst.cursor = i;
  return i ? rooms[i - 1] : null;
}

// The service that cleans one room: the button's own setting, else what the vacuum's integration offers.
function roomCall(inst, room) {
  const sub = (v) => (v === "$room" ? room.id : Array.isArray(v) ? v.map(sub) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)])) : v);
  if (inst.settings.roomService) {
    const data = parseData(inst.settings.roomData);
    if (!data) throw new Error("room data isn't a JSON object");
    return [inst.settings.roomService, sub(data)];
  }
  if (services.has("dreame_vacuum.vacuum_clean_segment")) return ["dreame_vacuum.vacuum_clean_segment", { segments: [room.id] }];
  if (services.has("roborock.vacuum_clean_segment")) return ["roborock.vacuum_clean_segment", { segments: [room.id] }];
  return ["vacuum.send_command", { command: "app_segment_clean", params: [room.id] }]; // Xiaomi / Roborock firmware
}

async function vacuumPress(inst) {
  const id = inst.settings.entity;
  const s = stateOf(id);
  if (s?.state === "cleaning") return ha.call("vacuum.pause", id);
  if (s?.state === "paused") return ha.call("vacuum.start", id);
  const room = inst.controller === "Encoder" ? vacuumChoice(inst, vacuumRooms(s)) : null;
  if (!room) return ha.call("vacuum.start", id);
  const [service, data] = roomCall(inst, room);
  log(`cleaning ${room.name}`);
  return ha.call(service, id, data);
}

const vacuumHold = (inst) => ha.call(inst.settings.hold === "stop" ? "vacuum.stop" : "vacuum.return_to_base", inst.settings.entity);

// Services Home Assistant offers, to pick the right room-cleaning call. Loaded once per connection.
let services = new Set();
async function loadServices() {
  try {
    const all = await ha.request({ type: "get_services" });
    services = new Set(Object.entries(all).flatMap(([domain, list]) => Object.keys(list).map((x) => `${domain}.${x}`)));
  } catch {}
}

// --------------------------------------------------------------------------- drawing

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const svgUri = (svg) => "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
const FONT = `font-family="Inter, 'Noto Sans', sans-serif"`;
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

const kindOf = (inst) => inst.action.slice(args.pluginUUID.length + 1);
const shownEntity = (inst) => (kindOf(inst) === "service" ? inst.settings.show || inst.settings.entity : inst.settings.entity) || "";

function titleOf(inst) {
  const id = shownEntity(inst);
  return inst.settings.label || stateOf(id)?.attributes?.friendly_name || id.split(".")[1]?.replace(/_/g, " ") || (kindOf(inst) === "service" ? inst.settings.service || "service" : "entity");
}

function placeholder(inst) {
  if (!globals) return "…";
  if (!globals.token) return "set token";
  if (ha?.status === "auth") return "bad token";
  if (ha?.status !== "connected") return ha?.status === "offline" ? "offline" : "…";
  if (kindOf(inst) === "service" && !inst.settings.service) return "pick a service";
  if (kindOf(inst) !== "service" && !inst.settings.entity) return kindOf(inst) === "vacuum" ? "pick a vacuum" : "pick an entity";
  return null;
}

// What a button shows: the entity's state, or for a service button without one, the service name.
function view(inst) {
  const id = shownEntity(inst);
  if (kindOf(inst) === "service" && !id) return { big: "RUN", small: inst.settings.service.split(".")[1]?.replace(/_/g, " ") || "", color: SOFT, level: null };
  return describe(id, stateOf(id), inst.settings.attribute);
}

function vacuumKey(inst) {
  const title = titleOf(inst);
  const open = (color) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144"><rect width="144" height="144" fill="#141414"/>${color ? `<rect width="144" height="6" fill="${color}"/>` : ""}<text x="72" y="32" ${FONT} font-size="16" font-weight="600" text-anchor="middle" fill="${TEXT}">${esc(trunc(title, 15))}</text>`;
  const text = placeholder(inst);
  if (text) return `${open()}<text x="72" y="86" ${FONT} font-size="18" text-anchor="middle" fill="${GREY}">${esc(text)}</text></svg>`;
  const s = stateOf(inst.settings.entity);
  const st = vacuumStatus(s), battery = vacuumBattery(s);
  const word = trunc(st.word, 12);
  return `${open(st.color === SOFT ? null : st.color)}
<text x="72" y="74" ${FONT} font-size="${word.length > 8 ? 20 : 26}" font-weight="700" text-anchor="middle" fill="${st.color}">${esc(word)}</text>
${battery != null ? `<text x="72" y="108" ${FONT} font-size="20" font-weight="600" text-anchor="middle" fill="${battery <= 20 ? RED : SOFT}">${st.charging ? "⚡" : ""}${battery}%</text>
<rect x="22" y="122" width="100" height="6" rx="3" fill="#2a2a2a"/><rect x="22" y="122" width="${battery}" height="6" rx="3" fill="${battery <= 20 ? RED : GREEN}"/>` : ""}
</svg>`;
}

// Name and battery on top, state in the middle, then the room a press will clean (or, while cleaning,
// the area and time so far).
function vacuumStrip(inst) {
  const title = titleOf(inst);
  const open = (color) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="200" height="100" fill="#141414"/>${color ? `<rect width="4" height="100" fill="${color}"/>` : ""}<text x="10" y="20" ${FONT} font-size="15" font-weight="600" fill="${TEXT}">${esc(trunc(title, 14))}</text>`;
  const text = placeholder(inst);
  if (text) return `${open()}<text x="100" y="64" ${FONT} font-size="18" text-anchor="middle" fill="${GREY}">${esc(text)}</text></svg>`;
  const s = stateOf(inst.settings.entity);
  const a = s?.attributes || {};
  const st = vacuumStatus(s), battery = vacuumBattery(s);
  const rooms = vacuumRooms(s);
  const room = vacuumChoice(inst, rooms);
  const busy = s?.state === "cleaning" || s?.state === "paused";
  const recentlyTurned = Date.now() - (inst.turnedAt || 0) < 4000;
  const bottom = busy && !recentlyTurned && a.cleaned_area != null
    ? `<text x="10" y="88" ${FONT} font-size="14" fill="${SOFT}">${num(a.cleaned_area)} m² · ${num(a.cleaning_time ?? 0)} min</text>`
    : `<text x="10" y="88" ${FONT} font-size="15" fill="${room ? TEXT : SOFT}">▸ ${esc(trunc(room ? room.name : "Whole home", 16))}</text>${rooms.length ? `<text x="194" y="88" ${FONT} font-size="12" text-anchor="end" fill="${DIM}">${inst.cursor || 0}/${rooms.length}</text>` : ""}`;
  return `${open(st.color === SOFT ? null : st.color)}
${battery != null ? `<text x="194" y="20" ${FONT} font-size="15" font-weight="600" text-anchor="end" fill="${battery <= 20 ? RED : SOFT}">${st.charging ? "⚡" : ""}${battery}%</text>` : ""}
<text x="10" y="54" ${FONT} font-size="24" font-weight="700" fill="${st.color}">${esc(trunc(st.word, 13))}</text>
${bottom}
${battery != null ? `<rect x="10" y="94" width="184" height="3" rx="1.5" fill="#2a2a2a"/><rect x="10" y="94" width="${Math.round(battery * 1.84)}" height="3" rx="1.5" fill="${battery <= 20 ? RED : GREEN}"/>` : ""}
</svg>`;
}

function key(inst) {
  if (kindOf(inst) === "vacuum") return vacuumKey(inst);
  const title = titleOf(inst);
  const open = (color) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144"><rect width="144" height="144" fill="#141414"/>${color ? `<rect width="144" height="6" fill="${color}"/>` : ""}<text x="72" y="32" ${FONT} font-size="16" font-weight="600" text-anchor="middle" fill="${TEXT}">${esc(trunc(title, 15))}</text>`;
  const text = placeholder(inst);
  if (text) return `${open()}<text x="72" y="86" ${FONT} font-size="18" text-anchor="middle" fill="${GREY}">${esc(text)}</text></svg>`;
  const v = view(inst);
  const big = trunc(v.big, 10);
  const bar = v.level != null ? `<rect x="22" y="124" width="100" height="6" rx="3" fill="#2a2a2a"/><rect x="22" y="124" width="${Math.round(clamp(v.level, 0, 1) * 100)}" height="6" rx="3" fill="${v.color}"/>` : "";
  return `${open(v.color === GREY ? null : v.color)}
<text x="72" y="84" ${FONT} font-size="${big.length > 6 ? 22 : 32}" font-weight="700" text-anchor="middle" fill="${v.color}">${esc(big)}</text>
<text x="72" y="${bar ? 110 : 120}" ${FONT} font-size="14" text-anchor="middle" fill="${SOFT}">${esc(trunc(v.small, 18))}</text>
${bar}</svg>`;
}

function strip(inst) {
  if (kindOf(inst) === "vacuum") return vacuumStrip(inst);
  const title = titleOf(inst);
  const open = (color) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="200" height="100" fill="#141414"/>${color ? `<rect width="4" height="100" fill="${color}"/>` : ""}<text x="10" y="22" ${FONT} font-size="16" font-weight="600" fill="${TEXT}">${esc(trunc(title, 20))}</text>`;
  const text = placeholder(inst);
  if (text) return `${open()}<text x="100" y="66" ${FONT} font-size="18" text-anchor="middle" fill="${GREY}">${esc(text)}</text></svg>`;
  const v = view(inst);
  const bar = v.level != null ? `<rect x="10" y="84" width="184" height="6" rx="3" fill="#2a2a2a"/><rect x="10" y="84" width="${Math.round(clamp(v.level, 0, 1) * 184)}" height="6" rx="3" fill="${v.color}"/>` : "";
  return `${open(v.color === GREY ? null : v.color)}
<text x="10" y="60" ${FONT} font-size="26" font-weight="700" fill="${v.color}">${esc(trunc(v.big, 11))}</text>
<text x="194" y="60" ${FONT} font-size="14" text-anchor="end" fill="${SOFT}">${esc(trunc(v.small, 12))}</text>
${bar}</svg>`;
}

// --------------------------------------------------------------------------- instances and input

const instances = new Map(); // context -> { action, controller, settings, ticks, turnTimer }
const lastImage = new Map();

function draw(context) {
  const inst = instances.get(context);
  if (!inst) return;
  const image = svgUri(inst.controller === "Encoder" ? strip(inst) : key(inst));
  if (lastImage.get(context) === image) return;
  lastImage.set(context, image);
  send({ event: "setImage", context, payload: { image } });
}

function drawAll() {
  for (const context of instances.keys()) draw(context);
}

function parseData(text) {
  if (!text || !String(text).trim()) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

async function press(context) {
  const inst = instances.get(context);
  if (!inst || placeholder(inst)) return send({ event: "showAlert", context });
  try {
    if (kindOf(inst) === "service") {
      const data = parseData(inst.settings.data);
      if (!data) throw new Error("service data isn't a JSON object");
      await ha.call(inst.settings.service, inst.settings.entity || null, data);
      // A key without a state to watch gets a check mark; one with a state shows the change itself.
      if (!shownEntity(inst)) send({ event: "showOk", context });
      return;
    }
    if (kindOf(inst) === "vacuum") return await vacuumPress(inst);
    const id = inst.settings.entity;
    const service = pressService(id, stateOf(id));
    if (!service) return send({ event: "showAlert", context }); // sensors and the like do nothing
    await ha.call(service, id);
  } catch (e) {
    log(`home assistant: ${e.message}`);
    send({ event: "showAlert", context });
  }
}

// Dial turns are gathered for a moment and sent as one change, shown right away.
function rotate(context, ticks) {
  const inst = instances.get(context);
  if (!inst || placeholder(inst)) return;
  if (kindOf(inst) === "vacuum") {
    inst.cursor = (inst.cursor || 0) + ticks;
    inst.turnedAt = Date.now();
    draw(context);
    clearTimeout(inst.redraw);
    inst.redraw = setTimeout(() => draw(context), 4100); // back to cleaning progress
    return;
  }
  if (kindOf(inst) !== "entity") return;
  const id = inst.settings.entity;
  const s = stateOf(id);
  const t = s && turn(id, s, ticks);
  if (!t) return;
  const [service, data, attrs, state] = t;
  ha.states.set(id, { ...s, state: state ?? s.state, attributes: { ...s.attributes, ...attrs } });
  draw(context);
  clearTimeout(inst.turnTimer);
  inst.pending = [service, data];
  inst.turnTimer = setTimeout(() => {
    const [svc, d] = inst.pending;
    ha.call(svc, id, d).catch((e) => { log(`home assistant: ${e.message}`); send({ event: "showAlert", context }); });
  }, 150);
}

// Vacuum buttons tell a press from a hold: letting go before HOLD_MS presses, holding past it holds.
const HOLD_MS = 800;

function down(context) {
  const inst = instances.get(context);
  if (!inst) return;
  clearTimeout(inst.holdTimer);
  inst.held = false;
  inst.holdTimer = setTimeout(async () => {
    inst.held = true;
    if (placeholder(inst)) return send({ event: "showAlert", context });
    try {
      await vacuumHold(inst);
      send({ event: "showOk", context });
    } catch (e) {
      log(`home assistant: ${e.message}`);
      send({ event: "showAlert", context });
    }
  }, HOLD_MS);
}

function up(context) {
  const inst = instances.get(context);
  if (!inst) return;
  clearTimeout(inst.holdTimer);
  if (!inst.held) press(context);
  inst.held = false;
}

function remember(msg) {
  const inst = instances.get(msg.context) || {};
  inst.action = msg.action;
  inst.controller = msg.payload?.controller || inst.controller || "Keypad";
  inst.settings = msg.payload?.settings || {};
  instances.set(msg.context, inst);
  return inst;
}

// The settings panel asks for the entities and services to offer.
async function sendNames(context) {
  let services = [];
  try {
    const all = await ha.request({ type: "get_services" });
    services = Object.entries(all).flatMap(([domain, list]) => Object.keys(list).map((s) => `${domain}.${s}`)).sort();
  } catch {}
  const entities = [...(ha?.states || new Map())].map(([id, s]) => [id, s.attributes?.friendly_name || ""]).sort((a, b) => a[0].localeCompare(b[0]));
  send({ event: "sendToPropertyInspector", context, payload: { entities, services, status: ha?.status || "connecting" } });
}

function handle(msg) {
  switch (msg.event) {
    case "willAppear":
      remember(msg);
      lastImage.delete(msg.context);
      draw(msg.context);
      break;
    case "willDisappear":
      clearTimeout(instances.get(msg.context)?.turnTimer);
      clearTimeout(instances.get(msg.context)?.holdTimer);
      clearTimeout(instances.get(msg.context)?.redraw);
      instances.delete(msg.context);
      lastImage.delete(msg.context);
      break;
    case "didReceiveSettings":
      remember(msg);
      draw(msg.context);
      break;
    case "keyDown":
    case "dialDown": {
      const inst = remember(msg);
      if (kindOf(inst) === "vacuum") down(msg.context);
      else if (msg.event === "dialDown") press(msg.context);
      break;
    }
    case "keyUp":
    case "dialUp": {
      const inst = remember(msg);
      if (kindOf(inst) === "vacuum") up(msg.context);
      else if (msg.event === "keyUp") press(msg.context);
      break;
    }
    case "touchTap":
      remember(msg);
      press(msg.context);
      break;
    case "dialRotate":
      remember(msg);
      rotate(msg.context, msg.payload?.ticks || 0);
      break;
    case "sendToPlugin":
      if (msg.payload?.request === "names" && ha) sendNames(msg.context);
      break;
    case "didReceiveGlobalSettings":
      globals = msg.payload?.settings || {};
      connect();
      drawAll();
      break;
  }
}
