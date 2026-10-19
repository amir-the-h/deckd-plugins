// Discord Voice — mute, deafen, push-to-talk and voice volumes for the Discord desktop app
// (Node >= 22, no deps). Talks to Discord's local RPC socket (discord-ipc-N).
//
// Discord only lets an app use the voice RPC scopes for its own developers and testers, so each user
// creates their own app in the Discord developer portal and pastes its client ID and secret into the
// settings panel. The first connection shows an "Authorize" prompt inside Discord; after that the
// stored token (refreshed when it expires) signs in silently.

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
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

const kindOf = (action) => action.slice(args.pluginUUID.length + 1);

const SCOPES = ["rpc", "rpc.voice.read", "rpc.voice.write"];
// Must be listed under OAuth2 → Redirects in the Discord app; RPC never actually opens it.
const REDIRECT_URI = "http://localhost";
const RETRY_MS = 10_000;
const COMMAND_TIMEOUT_MS = 10_000;
const AUTHORIZE_TIMEOUT_MS = 120_000; // the user has to click "Authorize" in Discord

/** { clientId, clientSecret, accessToken, refreshToken, expiresAt } */
let globals = null;
const saveGlobals = () => send({ event: "setGlobalSettings", context: args.pluginUUID, payload: globals });

// --------------------------------------------------------------------------- IPC transport

/** Where Discord (native, Flatpak or Snap) puts its RPC sockets. */
function socketPaths() {
  const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || "/tmp";
  const dirs = [base, path.join(base, "app/com.discordapp.Discord"), path.join(base, "snap.discord"), path.join(base, ".flatpak/dev.vencord.Vesktop/xdg-run")];
  const out = [];
  for (const dir of dirs) for (let i = 0; i < 10; i++) out.push(path.join(dir, `discord-ipc-${i}`));
  return out.filter((p) => { try { return fs.statSync(p).isSocket(); } catch { return false; } });
}

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

function encode(op, data) {
  const body = Buffer.from(JSON.stringify(data));
  const head = Buffer.alloc(8);
  head.writeUInt32LE(op, 0);
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

const rpc = {
  sock: null,
  ready: false, // signed in and subscribed
  status: "", // what the buttons show when not ready
  pending: new Map(), // nonce -> { resolve, reject, timer }
  retry: null,
  buf: Buffer.alloc(0),
};

/** What Discord reports; buttons draw from this. */
const voice = { mute: false, deaf: false, input: 100, output: 100 };

function connect() {
  clearTimeout(rpc.retry);
  if (rpc.sock || !globals || !instances.size) return;
  if (!globals.clientId || !globals.clientSecret) return setStatus("set up app");
  const paths = socketPaths();
  if (!paths.length) return retryLater("Discord closed");
  const sock = net.createConnection(paths[0]);
  rpc.sock = sock;
  rpc.buf = Buffer.alloc(0);
  sock.on("connect", () => sock.write(encode(OP.HANDSHAKE, { v: 1, client_id: globals.clientId })));
  sock.on("data", (chunk) => onData(sock, chunk));
  sock.on("error", () => {}); // close follows
  sock.on("close", () => {
    if (rpc.sock !== sock) return;
    rpc.sock = null;
    rpc.ready = false;
    for (const p of rpc.pending.values()) p.reject(new Error("Discord disconnected"));
    rpc.pending.clear();
    retryLater(rpc.status && rpc.status !== "connecting…" ? rpc.status : "Discord closed");
  });
  setStatus("connecting…");
}

function disconnect() {
  clearTimeout(rpc.retry);
  const sock = rpc.sock;
  rpc.sock = null;
  rpc.ready = false;
  sock?.destroy();
}

function retryLater(status) {
  setStatus(status);
  if (instances.size) rpc.retry = setTimeout(connect, RETRY_MS);
}

function setStatus(status) {
  rpc.status = status;
  drawAll();
}

function onData(sock, chunk) {
  rpc.buf = Buffer.concat([rpc.buf, chunk]);
  while (rpc.buf.length >= 8) {
    const op = rpc.buf.readUInt32LE(0);
    const len = rpc.buf.readUInt32LE(4);
    if (rpc.buf.length < 8 + len) return;
    const data = JSON.parse(rpc.buf.subarray(8, 8 + len).toString());
    rpc.buf = rpc.buf.subarray(8 + len);
    if (op === OP.PING) sock.write(encode(OP.PONG, data));
    else if (op === OP.CLOSE) {
      log(`Discord closed the connection: ${data.message || data.code}`);
      rpc.status = data.code === 4000 ? "check client ID" : "Discord closed";
      sock.destroy();
    } else if (op === OP.FRAME) onFrame(data);
  }
}

function onFrame(msg) {
  if (msg.cmd === "DISPATCH" && msg.evt === "READY") {
    signIn().catch((e) => {
      log(`sign-in failed: ${e.message}`);
      setStatus(e.status || "sign-in failed");
    });
    return;
  }
  if (msg.cmd === "DISPATCH" && msg.evt === "VOICE_SETTINGS_UPDATE") {
    applyVoice(msg.data);
    return;
  }
  const p = msg.nonce && rpc.pending.get(msg.nonce);
  if (!p) return;
  rpc.pending.delete(msg.nonce);
  clearTimeout(p.timer);
  if (msg.evt === "ERROR") p.reject(Object.assign(new Error(`${msg.cmd}: ${msg.data?.message}`), { code: msg.data?.code }));
  else p.resolve(msg.data || {});
}

function command(cmd, cmdArgs = {}, evt, timeout = COMMAND_TIMEOUT_MS) {
  if (!rpc.sock) return Promise.reject(new Error("not connected to Discord"));
  const nonce = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rpc.pending.delete(nonce);
      reject(new Error(`${cmd}: timed out`));
    }, timeout);
    rpc.pending.set(nonce, { resolve, reject, timer });
    rpc.sock.write(encode(OP.FRAME, { cmd, args: cmdArgs, evt, nonce }));
  });
}

// --------------------------------------------------------------------------- sign-in

async function tokenRequest(params) {
  const res = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: globals.clientId, client_secret: globals.clientSecret, ...params }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`token request: ${body.error_description || body.error || res.status}`), { status: body.error === "invalid_client" ? "check secret" : "sign-in failed" });
  globals = { ...globals, accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: Date.now() + body.expires_in * 1000 };
  saveGlobals();
}

/** Uses the stored token, refreshes it, or asks the user to authorize in Discord — in that order. */
async function signIn() {
  if (globals.accessToken && globals.expiresAt > Date.now() + 60_000) {
    try {
      await command("AUTHENTICATE", { access_token: globals.accessToken });
      return afterSignIn();
    } catch (e) {
      log(`stored token rejected: ${e.message}`);
    }
  }
  if (globals.refreshToken) {
    try {
      await tokenRequest({ grant_type: "refresh_token", refresh_token: globals.refreshToken });
      await command("AUTHENTICATE", { access_token: globals.accessToken });
      return afterSignIn();
    } catch (e) {
      log(`token refresh failed: ${e.message}`);
    }
  }
  setStatus("authorize in Discord");
  const { code } = await command("AUTHORIZE", { client_id: globals.clientId, scopes: SCOPES }, undefined, AUTHORIZE_TIMEOUT_MS);
  await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI });
  await command("AUTHENTICATE", { access_token: globals.accessToken });
  return afterSignIn();
}

async function afterSignIn() {
  applyVoice(await command("GET_VOICE_SETTINGS"));
  await command("SUBSCRIBE", {}, "VOICE_SETTINGS_UPDATE");
  rpc.ready = true;
  log("signed in to Discord");
  setStatus("");
}

function applyVoice(d) {
  if ("mute" in d) voice.mute = d.mute;
  if ("deaf" in d) voice.deaf = d.deaf;
  if (d.input?.volume != null) voice.input = d.input.volume;
  if (d.output?.volume != null) voice.output = d.output.volume;
  drawAll();
}

const setVoice = (change) => command("SET_VOICE_SETTINGS", change).then(applyVoice);

// --------------------------------------------------------------------------- drawing

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const svgUri = (svg) => "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
const FONT = `font-family="Inter, 'Noto Sans', sans-serif"`;
const RED = "#e5534b", BLURPLE = "#5865f2", GREEN = "#4caf7d", DIM = "#9a9a9a", TEXT = "#f2f2f2", BG = "#141414";

// Material Design Icons (Apache 2.0), 24x24.
const PATHS = {
  mic: "M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z",
  micOff: "M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z",
  headset: "M12 1a9 9 0 0 0-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h3c1.66 0 3-1.34 3-3v-7a9 9 0 0 0-9-9z",
  headsetOff: "M12 4c3.87 0 7 3.13 7 7v2h-2.92L21 17.92V11c0-4.97-4.03-9-9-9-1.95 0-3.76.62-5.23 1.68l1.44 1.44C9.3 4.41 10.6 4 12 4zM2.27 1.72L1 3l3.22 3.22C3.43 7.6 3 9.25 3 11v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-1.15.27-2.24.77-3.2l9.96 9.96c.08.34.27.65.53.88V21h3c.45 0 .87-.1 1.25-.28L21 22.27 2.27 1.72z",
  speaker: "M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z",
};

const icon = (p, color, x, y, size) => `<path transform="translate(${x} ${y}) scale(${size / 24})" fill="${color}" d="${p}"/>`;

function keySvg({ label, path: p, color, status, statusColor = DIM, border }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
<rect width="144" height="144" fill="${BG}"/>
${border ? `<rect x="3" y="3" width="138" height="138" rx="12" fill="none" stroke="${border}" stroke-width="6"/>` : ""}
<text x="72" y="28" ${FONT} font-size="17" font-weight="600" text-anchor="middle" fill="${TEXT}">${esc(label)}</text>
${icon(p, color, 44, 40, 56)}
<text x="72" y="128" ${FONT} font-size="16" font-weight="600" text-anchor="middle" fill="${statusColor}">${esc(status)}</text>
</svg>`;
}

function stripSvg({ label, path: p, color, status, statusColor = TEXT, bar }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
<rect width="200" height="100" fill="${BG}"/>
${icon(p, color, 8, 22, 44)}
<text x="194" y="30" ${FONT} font-size="16" font-weight="600" text-anchor="end" fill="${DIM}">${esc(label)}</text>
<text x="194" y="64" ${FONT} font-size="24" font-weight="700" text-anchor="end" fill="${statusColor}">${esc(status)}</text>
${bar == null ? "" : `<rect x="8" y="80" width="186" height="8" rx="4" fill="#2a2a2a"/><rect x="8" y="80" width="${Math.max(0, Math.min(1, bar)) * 186}" height="8" rx="4" fill="${color}"/>`}
</svg>`;
}

const TITLES = { mute: "Mute", deafen: "Deafen", ptt: "Talk", volume: "Volume" };

function view(inst) {
  const kind = kindOf(inst.action);
  const s = inst.settings;
  const label = s.label || (kind === "volume" ? (s.target === "input" ? "Mic" : "Output") : TITLES[kind]);
  if (!rpc.ready) {
    const p = kind === "deafen" ? PATHS.headset : kind === "volume" && s.target !== "input" ? PATHS.speaker : PATHS.mic;
    return { label, path: p, color: "#555", status: rpc.status || "…", statusColor: DIM };
  }
  switch (kind) {
    case "mute":
      return voice.mute
        ? { label, path: PATHS.micOff, color: RED, status: "MUTED", statusColor: RED, border: RED }
        : { label, path: PATHS.mic, color: TEXT, status: "on", statusColor: DIM };
    case "deafen":
      return voice.deaf
        ? { label, path: PATHS.headsetOff, color: RED, status: "DEAFENED", statusColor: RED, border: RED }
        : { label, path: PATHS.headset, color: TEXT, status: "on", statusColor: DIM };
    case "ptt": {
      const talking = !!pttHeld;
      return { label, path: voice.mute ? PATHS.micOff : PATHS.mic, color: talking ? GREEN : voice.mute ? DIM : TEXT, status: talking ? "TALKING" : voice.mute ? "hold to talk" : "mic on", statusColor: talking ? GREEN : DIM, border: talking && GREEN };
    }
    case "volume": {
      const input = s.target === "input";
      const off = input ? voice.mute : voice.deaf;
      const vol = input ? voice.input : voice.output;
      const max = input ? 100 : 200;
      return {
        label,
        path: input ? (off ? PATHS.micOff : PATHS.mic) : off ? PATHS.headsetOff : PATHS.speaker,
        color: off ? RED : BLURPLE,
        status: off ? (input ? "MUTED" : "DEAFENED") : `${Math.round(vol)}%`,
        statusColor: off ? RED : TEXT,
        bar: off ? 0 : vol / max,
      };
    }
  }
  return { label: "?", path: PATHS.mic, color: DIM, status: "" };
}

const lastImage = new Map();

function draw(context) {
  const inst = instances.get(context);
  if (!inst) return;
  const v = view(inst);
  const image = svgUri(inst.controller === "Encoder" ? stripSvg(v) : keySvg(v));
  if (lastImage.get(context) === image) return;
  lastImage.set(context, image);
  send({ event: "setImage", context, payload: { image } });
}

const drawAll = () => instances.forEach((_, ctx) => draw(ctx));

// --------------------------------------------------------------------------- actions

const instances = new Map(); // context -> { action, controller, settings }
let pttHeld = null; // context of the push-to-talk key being held, and the mute state to restore
let pttWasMuted = false;

async function press(inst) {
  const s = inst.settings;
  switch (kindOf(inst.action)) {
    case "mute": return setVoice({ mute: !voice.mute });
    case "deafen": return setVoice({ deaf: !voice.deaf });
    case "volume": return setVoice(s.target === "input" ? { mute: !voice.mute } : { deaf: !voice.deaf });
  }
}

async function turn(inst, ticks) {
  if (kindOf(inst.action) !== "volume") return;
  const input = inst.settings.target === "input";
  const step = Number(inst.settings.step) || 5;
  const max = input ? 100 : 200;
  const vol = Math.max(0, Math.min(max, (input ? voice.input : voice.output) + ticks * step));
  if (input) voice.input = vol;
  else voice.output = vol;
  drawAll();
  await setVoice(input ? { input: { volume: vol } } : { output: { volume: vol } });
}

function run(ctx, promise) {
  promise.catch((e) => {
    log(e.message);
    send({ event: "showAlert", context: ctx });
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
    case "willAppear":
      remember(msg);
      lastImage.delete(ctx);
      draw(ctx);
      connect();
      break;
    case "willDisappear":
      instances.delete(ctx);
      lastImage.delete(ctx);
      if (!instances.size) disconnect();
      break;
    case "didReceiveSettings":
      remember(msg);
      draw(ctx);
      break;
    case "didReceiveGlobalSettings": {
      const before = globals && `${globals.clientId}:${globals.clientSecret}`;
      globals = msg.payload?.settings || {};
      // A different app means a different sign-in.
      if (before !== null && before !== `${globals.clientId}:${globals.clientSecret}`) {
        globals = { clientId: globals.clientId, clientSecret: globals.clientSecret };
        saveGlobals();
        disconnect();
      }
      connect();
      break;
    }
    case "keyDown": {
      const inst = remember(msg);
      // Push-to-talk unmutes while held and restores the previous state on release.
      if (kindOf(inst.action) === "ptt" && rpc.ready && !pttHeld) {
        pttHeld = ctx;
        pttWasMuted = voice.mute;
        run(ctx, setVoice({ mute: false }));
      }
      break;
    }
    case "keyUp": {
      const inst = remember(msg);
      if (kindOf(inst.action) === "ptt") {
        if (pttHeld === ctx) {
          pttHeld = null;
          run(ctx, setVoice({ mute: pttWasMuted }));
        }
      } else {
        run(ctx, press(inst));
      }
      break;
    }
    case "dialDown":
    case "touchTap":
      run(ctx, press(remember(msg)));
      break;
    case "dialRotate":
      run(ctx, turn(remember(msg), msg.payload.ticks || 0));
      break;
    case "sendToPlugin":
      if (msg.payload?.command === "status") {
        send({ event: "sendToPropertyInspector", context: ctx, payload: { status: rpc.ready ? "Connected" : rpc.status || "Not connected" } });
      }
      break;
  }
}
