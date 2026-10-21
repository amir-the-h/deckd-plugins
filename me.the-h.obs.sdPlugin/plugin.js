// OBS Control — scenes, recording, streaming, replay buffer, audio inputs and stats for OBS Studio
// (Node >= 22, no deps). Talks to OBS's built-in WebSocket server (obs-websocket 5.x; OBS 28 or newer).
//
// One connection serves every button. State comes from OBS's events, so buttons stay in sync when
// you change things in OBS itself. The connection stays open when the buttons leave the deck (OBS
// announces every connect and disconnect), but is only retried while a button is visible.

const crypto = require("node:crypto");

// --------------------------------------------------------------------------- startup

const args = {};
for (let i = 2; i + 1 < process.argv.length; i += 2) args[process.argv[i].replace(/^-/, "")] = process.argv[i + 1];

const host = new WebSocket(`ws://127.0.0.1:${args.port}`);
const send = (msg) => host.readyState === WebSocket.OPEN && host.send(JSON.stringify(msg));
const log = (message) => { console.log(message); send({ event: "logMessage", payload: { message } }); };

host.onopen = () => {
  send({ event: args.registerEvent, uuid: args.pluginUUID });
  send({ event: "getGlobalSettings", context: args.pluginUUID });
};
host.onclose = () => process.exit(0);
host.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  try {
    handle(msg);
  } catch (e) {
    log(`error handling ${msg.event}: ${e.stack || e}`);
  }
};

// --------------------------------------------------------------------------- config

const ACTION = (suffix) => `${args.pluginUUID}.${suffix}`;
const kindOf = (action) => action.slice(args.pluginUUID.length + 1);

const RETRY_MS = 5_000;
const STATS_MS = 2_000;
const REQUEST_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 10_000;
// Event subscriptions: Scenes (4) | Inputs (8) | Outputs (64).
const EVENTS = 4 | 8 | 64;

let globals = null; // { host, port, password }, from the settings panel
const obsUrl = () => `ws://${globals?.host || "127.0.0.1"}:${Number(globals?.port) || 4455}`;

// --------------------------------------------------------------------------- obs-websocket

const obs = {
  ws: null,
  ready: false,
  error: "", // why we're not connected, for the buttons
  nextId: 1,
  pending: new Map(), // requestId -> { resolve, reject, timer }
  retry: null,
  handshake: null, // gives up on a connection attempt that never completes
  waiters: new Set(), // { resolve, reject, timer } waiting for the connection
};

/** What OBS currently reports; buttons draw from this. */
const live = {
  scene: "",
  record: false,
  stream: false,
  replay: false,
  inputs: new Map(), // input name -> { muted, db }
  stats: null,
};

function connect() {
  clearTimeout(obs.retry);
  if (obs.ws || !globals) return;
  const ws = new WebSocket(obsUrl());
  obs.ws = ws;
  ws.onmessage = (m) => onObsMessage(ws, JSON.parse(m.data));
  ws.onclose = (e) => closed(ws, e.code);
  ws.onerror = () => {}; // onclose follows and handles it
  // A socket opened while OBS is still starting can sit in CONNECTING forever, and nothing would
  // replace it, since connect() keeps the socket it has.
  clearTimeout(obs.handshake);
  obs.handshake = setTimeout(() => {
    if (obs.ws !== ws || obs.ready) return;
    log("OBS didn't answer; retrying");
    closed(ws);
    ws.close();
  }, CONNECT_TIMEOUT_MS);
}

function closed(ws, code) {
  if (obs.ws !== ws) return;
  clearTimeout(obs.handshake);
  obs.ws = null;
  obs.ready = false;
  // 4009 = authentication failed; a missing password was already flagged in onObsMessage.
  if (code === 4009) {
    obs.error = "password";
    log("OBS rejected the password");
  } else if (obs.error !== "password") {
    obs.error = "offline";
  }
  for (const p of obs.pending.values()) p.reject(new Error("disconnected"));
  obs.pending.clear();
  for (const w of obs.waiters) w.reject(new Error(OFFLINE[obs.error] || "not connected to OBS"));
  drawAll();
  if (instances.size) obs.retry = setTimeout(connect, RETRY_MS);
}

function disconnect() {
  clearTimeout(obs.retry);
  clearTimeout(obs.handshake);
  const ws = obs.ws;
  obs.ws = null;
  obs.ready = false;
  ws?.close();
}

/** obs-websocket 5 auth: base64(sha256(base64(sha256(password + salt)) + challenge)). */
function authString(password, { salt, challenge }) {
  const sha = (s) => crypto.createHash("sha256").update(s).digest("base64");
  return sha(sha(password + salt) + challenge);
}

function onObsMessage(ws, { op, d }) {
  switch (op) {
    case 0: { // Hello
      const identify = { rpcVersion: 1, eventSubscriptions: EVENTS };
      if (d.authentication) {
        if (!globals?.password) {
          obs.error = "password";
          ws.close();
          return;
        }
        identify.authentication = authString(globals.password, d.authentication);
      }
      ws.send(JSON.stringify({ op: 1, d: identify }));
      break;
    }
    case 2: // Identified
      clearTimeout(obs.handshake);
      obs.ready = true;
      obs.error = "";
      for (const w of obs.waiters) w.resolve();
      log(`connected to OBS at ${obsUrl()}`);
      loadState().catch((e) => log(`reading OBS state: ${e.message}`));
      break;
    case 5: // Event
      onObsEvent(d.eventType, d.eventData || {});
      break;
    case 7: { // RequestResponse
      const p = obs.pending.get(d.requestId);
      if (!p) return;
      obs.pending.delete(d.requestId);
      clearTimeout(p.timer);
      if (d.requestStatus?.result) p.resolve(d.responseData || {});
      else p.reject(new Error(`${d.requestType}: ${d.requestStatus?.comment || `code ${d.requestStatus?.code}`}`));
      break;
    }
  }
}

/** Connects if needed and resolves once OBS has accepted us. */
function whenReady() {
  if (obs.ready) return Promise.resolve();
  connect();
  return new Promise((resolve, reject) => {
    const w = {
      resolve: () => { clearTimeout(w.timer); obs.waiters.delete(w); resolve(); },
      reject: (e) => { clearTimeout(w.timer); obs.waiters.delete(w); reject(e); },
    };
    w.timer = setTimeout(() => w.reject(new Error(OFFLINE[obs.error] || "not connected to OBS")), REQUEST_TIMEOUT_MS);
    obs.waiters.add(w);
  });
}

function request(requestType, requestData) {
  if (!obs.ready) return Promise.reject(new Error("not connected to OBS"));
  const requestId = String(obs.nextId++);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      obs.pending.delete(requestId);
      reject(new Error(`${requestType}: timed out`));
    }, REQUEST_TIMEOUT_MS);
    obs.pending.set(requestId, { resolve, reject, timer });
    obs.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
  });
}

/** Reads everything the visible buttons show; events keep it current afterwards. */
async function loadState() {
  const optional = (p) => p.catch(() => null); // e.g. the replay buffer isn't enabled
  const [scene, record, stream, replay] = await Promise.all([
    request("GetCurrentProgramScene"),
    request("GetRecordStatus"),
    request("GetStreamStatus"),
    optional(request("GetReplayBufferStatus")),
  ]);
  live.scene = scene.currentProgramSceneName ?? scene.sceneName ?? "";
  live.record = !!record.outputActive;
  live.stream = !!stream.outputActive;
  live.replay = !!replay?.outputActive;
  live.inputs.clear();
  await Promise.all(inputsInUse().map(loadInput));
  if (has("stats")) await refreshStats();
  drawAll();
}

async function loadInput(name) {
  try {
    const [mute, vol] = await Promise.all([request("GetInputMute", { inputName: name }), request("GetInputVolume", { inputName: name })]);
    live.inputs.set(name, { muted: !!mute.inputMuted, db: vol.inputVolumeDb });
  } catch (e) {
    live.inputs.set(name, { missing: true });
    log(`input "${name}": ${e.message}`);
  }
}

function onObsEvent(type, data) {
  switch (type) {
    case "CurrentProgramSceneChanged":
      live.scene = data.sceneName;
      return drawKind("scene");
    case "RecordStateChanged":
      live.record = !!data.outputActive;
      return drawKind("record");
    case "StreamStateChanged":
      live.stream = !!data.outputActive;
      return drawKind("stream");
    case "ReplayBufferStateChanged":
      live.replay = !!data.outputActive;
      return drawKind("replay");
    case "InputMuteStateChanged":
    case "InputVolumeChanged": {
      const input = live.inputs.get(data.inputName);
      if (!input) return;
      if ("inputMuted" in data) input.muted = data.inputMuted;
      if ("inputVolumeDb" in data) input.db = data.inputVolumeDb;
      return drawKind("input");
    }
    case "InputNameChanged":
    case "SceneNameChanged":
      return loadState().catch(() => {});
  }
}

async function refreshStats() {
  try {
    live.stats = await request("GetStats");
  } catch {
    live.stats = null;
  }
  drawKind("stats");
}

setInterval(() => {
  if (obs.ready && has("stats")) refreshStats();
}, STATS_MS);

// --------------------------------------------------------------------------- drawing

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const svgUri = (svg) => "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
const FONT = `font-family="Inter, 'Noto Sans', sans-serif"`;
const RED = "#e5534b", GREEN = "#4caf7d", BLUE = "#5aa9e6", AMBER = "#e0a030", DIM = "#9a9a9a", TEXT = "#f2f2f2", BG = "#141414";

// Material Design Icons (Apache 2.0), 24x24.
const PATHS = {
  scene: "M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z",
  record: "M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0-5C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z",
  stream: "M7.76 16.24C6.67 15.16 6 13.66 6 12s.67-3.16 1.76-4.24l1.42 1.42C8.45 9.9 8 10.9 8 12c0 1.1.45 2.1 1.17 2.83l-1.41 1.41zm8.48 0C17.33 15.16 18 13.66 18 12s-.67-3.16-1.76-4.24l-1.42 1.42C15.55 9.9 16 10.9 16 12c0 1.1-.45 2.1-1.17 2.83l1.41 1.41zM12 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm8 2c0 2.21-.9 4.21-2.35 5.65l1.42 1.42C20.88 17.26 22 14.76 22 12s-1.12-5.26-2.93-7.07l-1.42 1.42C19.1 7.79 20 9.79 20 12zM6.35 6.35L4.93 4.93C3.12 6.74 2 9.24 2 12s1.12 5.26 2.93 7.07l1.42-1.42C4.9 16.21 4 14.21 4 12s.9-4.21 2.35-5.65z",
  replay: "M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z",
  save: "M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z",
  mic: "M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z",
  micOff: "M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z",
  stats: "M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z",
};

const icon = (path, color, x, y, size) => `<path transform="translate(${x} ${y}) scale(${size / 24})" fill="${color}" d="${path}"/>`;

/** A key: label on top, icon in the middle, status text at the bottom. */
function keySvg({ label, path, color, status, statusColor = DIM, border }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
<rect width="144" height="144" fill="${BG}"/>
${border ? `<rect x="3" y="3" width="138" height="138" rx="12" fill="none" stroke="${border}" stroke-width="6"/>` : ""}
<text x="72" y="28" ${FONT} font-size="17" font-weight="600" text-anchor="middle" fill="${TEXT}">${esc(label)}</text>
${icon(path, color, 44, 40, 56)}
<text x="72" y="128" ${FONT} font-size="16" font-weight="600" text-anchor="middle" fill="${statusColor}">${esc(status)}</text>
</svg>`;
}

/** A dial strip: icon on the left, label and value on the right, optional bar. Without a label the
 *  value is centred. */
function stripSvg({ label, stripLabel = label, path, color, value, valueColor = TEXT, bar, border }) {
  const x = border ? 188 : 194; // keep text clear of the border
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
<rect width="200" height="100" fill="${BG}"/>
${border ? `<rect x="3" y="3" width="194" height="94" rx="10" fill="none" stroke="${border}" stroke-width="5"/>` : ""}
${icon(path, color, 8, 22, 44)}
${stripLabel ? `<text x="${x}" y="30" ${FONT} font-size="16" font-weight="600" text-anchor="end" fill="${DIM}">${esc(stripLabel)}</text>` : ""}
<text x="${x}" y="${stripLabel ? 64 : 58}" ${FONT} font-size="${stripLabel ? 24 : 22}" font-weight="700" text-anchor="end" fill="${valueColor}">${esc(value)}</text>
${bar == null ? "" : `<rect x="8" y="80" width="186" height="8" rx="4" fill="#2a2a2a"/><rect x="8" y="80" width="${Math.max(0, Math.min(1, bar)) * 186}" height="8" rx="4" fill="${color}"/>`}
</svg>`;
}

const short = (s, n = 12) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const OFFLINE = { offline: "OBS offline", password: "check password" };

/** What a button shows, as { label, path, color, status, statusColor, value, bar, border }. */
function view(inst) {
  const s = inst.settings;
  const kind = kindOf(inst.action);
  if (!obs.ready) {
    const status = globals ? OFFLINE[obs.error] || "connecting…" : "…";
    return { label: s.label || TITLES[kind], path: PATHS[kind === "input" ? "mic" : kind] || PATHS.scene, color: "#555", status, value: status, valueColor: DIM };
  }
  switch (kind) {
    case "scene": {
      const on = s.scene && live.scene === s.scene;
      return { label: s.label || short(s.scene || "Scene"), path: PATHS.scene, color: on ? GREEN : DIM, status: s.scene ? (on ? "LIVE" : "") : "choose scene", statusColor: GREEN, border: on && GREEN,
        // On a dial the name is the only text; green and a border mark the live scene.
        stripLabel: "", value: short(s.label || s.scene || "—", 11), valueColor: on ? GREEN : TEXT };
    }
    case "record":
      return toggleView(s.label || "Record", PATHS.record, live.record, "REC", RED);
    case "stream":
      return toggleView(s.label || "Stream", PATHS.stream, live.stream, "LIVE", RED);
    case "replay":
      return toggleView(s.label || "Replay", PATHS.replay, live.replay, "ON", AMBER);
    case "save":
      return { label: s.label || "Save replay", path: PATHS.save, color: live.replay ? TEXT : "#555", status: live.replay ? "" : "buffer off", value: live.replay ? "ready" : "buffer off", valueColor: DIM };
    case "input": {
      const input = live.inputs.get(s.input);
      const name = s.label || short(s.input || "Input");
      if (!s.input) return { label: name, path: PATHS.mic, color: "#555", status: "choose input", value: "choose input", valueColor: DIM };
      if (!input || input.missing) return { label: name, path: PATHS.micOff, color: "#555", status: "not found", value: "not found", valueColor: DIM };
      const db = input.db <= -100 ? "-∞ dB" : `${input.db.toFixed(1)} dB`;
      // -60 dB .. 0 dB across the bar.
      const bar = input.muted ? 0 : (Math.max(-60, input.db) + 60) / 60;
      return { label: name, path: input.muted ? PATHS.micOff : PATHS.mic, color: input.muted ? RED : GREEN, status: input.muted ? "MUTED" : db, statusColor: input.muted ? RED : DIM, value: input.muted ? "Muted" : db, valueColor: input.muted ? RED : TEXT, bar };
    }
    case "stats": {
      const st = live.stats;
      const fps = st ? `${Math.round(st.activeFps)} fps` : "—";
      const dropped = st ? st.outputSkippedFrames + st.renderSkippedFrames : 0;
      const detail = st ? `CPU ${st.cpuUsage.toFixed(0)}%${dropped ? ` · ${dropped} drop` : ""}` : "";
      return { label: s.label || "OBS", path: PATHS.stats, color: BLUE, status: `${fps}`, statusColor: TEXT, value: fps, bar: null, detail };
    }
  }
  return { label: "?", path: PATHS.scene, color: DIM, status: "", value: "" };
}

const TITLES = { scene: "Scene", record: "Record", stream: "Stream", replay: "Replay", save: "Save replay", input: "Input", stats: "OBS" };

function toggleView(label, path, on, onText, onColor) {
  return { label, path, color: on ? onColor : DIM, status: on ? onText : "off", statusColor: on ? onColor : DIM, border: on && onColor, value: on ? onText : "off", valueColor: on ? onColor : DIM };
}

const lastImage = new Map(); // context -> data URI, to skip redundant redraws

function draw(context) {
  const inst = instances.get(context);
  if (!inst) return;
  const v = view(inst);
  let svg;
  if (inst.controller === "Encoder") {
    svg = stripSvg(v);
  } else if (kindOf(inst.action) === "stats" && v.detail) {
    svg = keySvg(v).replace("</svg>", `<text x="72" y="108" ${FONT} font-size="14" text-anchor="middle" fill="${DIM}">${esc(v.detail)}</text></svg>`);
  } else {
    svg = keySvg(v);
  }
  const image = svgUri(svg);
  if (lastImage.get(context) === image) return;
  lastImage.set(context, image);
  send({ event: "setImage", context, payload: { image } });
}

const drawAll = () => instances.forEach((_, ctx) => draw(ctx));
const drawKind = (kind) => instances.forEach((inst, ctx) => kindOf(inst.action) === kind && draw(ctx));

// --------------------------------------------------------------------------- actions

const instances = new Map(); // context -> { action, controller, settings }

const has = (kind) => [...instances.values()].some((i) => kindOf(i.action) === kind);
const inputsInUse = () => [...new Set([...instances.values()].filter((i) => kindOf(i.action) === "input" && i.settings.input).map((i) => i.settings.input))];

async function press(inst) {
  const s = inst.settings;
  switch (kindOf(inst.action)) {
    case "scene":
      if (s.scene) await request("SetCurrentProgramScene", { sceneName: s.scene });
      return;
    case "record": return request("ToggleRecord");
    case "stream": return request("ToggleStream");
    case "replay": return request("ToggleReplayBuffer");
    case "save": return request("SaveReplayBuffer");
    case "input":
      if (s.input) await request("ToggleInputMute", { inputName: s.input });
      return;
    case "stats": return refreshStats();
  }
}

async function turn(inst, ticks) {
  if (kindOf(inst.action) !== "input" || !inst.settings.input) return;
  const input = live.inputs.get(inst.settings.input);
  if (!input || input.missing) return;
  const step = Number(inst.settings.step) || 1;
  input.db = Math.max(-100, Math.min(26, (input.db <= -100 ? -60 : input.db) + ticks * step));
  drawKind("input");
  await request("SetInputVolume", { inputName: inst.settings.input, inputVolumeDb: input.db });
}

function run(context, promise) {
  promise.catch((e) => {
    log(e.message);
    send({ event: "showAlert", context });
  });
}

// --------------------------------------------------------------------------- events

function remember(msg) {
  const inst = instances.get(msg.context) || {};
  inst.action = msg.action;
  inst.controller = msg.payload?.controller || inst.controller || "Keypad";
  inst.settings = msg.payload?.settings || {};
  instances.set(msg.context, inst);
  return inst;
}

function handle(msg) {
  const ctx = msg.context;
  switch (msg.event) {
    case "willAppear": {
      const inst = remember(msg);
      lastImage.delete(ctx);
      if (obs.ready && kindOf(inst.action) === "input" && inst.settings.input && !live.inputs.has(inst.settings.input)) {
        loadInput(inst.settings.input).then(() => draw(ctx));
      }
      draw(ctx);
      connect();
      break;
    }
    case "willDisappear":
      instances.delete(ctx);
      lastImage.delete(ctx);
      break;
    case "didReceiveSettings": {
      const inst = remember(msg);
      if (obs.ready && kindOf(inst.action) === "input" && inst.settings.input && !live.inputs.has(inst.settings.input)) {
        loadInput(inst.settings.input).then(() => draw(ctx));
      }
      draw(ctx);
      break;
    }
    case "didReceiveGlobalSettings": {
      const before = globals && JSON.stringify([obsUrl(), globals.password]);
      globals = msg.payload?.settings || {};
      if (before !== JSON.stringify([obsUrl(), globals.password])) {
        obs.error = "";
        disconnect();
        connect();
      }
      drawAll();
      break;
    }
    case "keyUp": // act on release, so tap/hold triggers configured in deckd behave naturally
    case "dialDown":
    case "touchTap":
      run(ctx, press(remember(msg)));
      break;
    case "dialRotate":
      run(ctx, turn(remember(msg), msg.payload.ticks || 0));
      break;
    case "sendToPlugin":
      // The settings panel asks for OBS's scenes and inputs to fill its pickers.
      if (msg.payload?.command === "lists") {
        whenReady()
          .then(() => Promise.all([request("GetSceneList"), request("GetInputList")]))
          .then(([scenes, inputs]) => ({
            scenes: scenes.scenes.map((s) => s.sceneName).reverse(), // OBS lists them bottom-up
            inputs: inputs.inputs.map((i) => i.inputName),
          }))
          .catch((e) => ({ error: e.message }))
          .then((payload) => send({ event: "sendToPropertyInspector", context: ctx, payload }));
      }
      break;
  }
}
