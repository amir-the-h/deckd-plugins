// qBittorrent — transfer speeds and pause/resume for your qBittorrent client, through its WebUI API
// (Node >= 22, no deps). Press to stop or start every torrent; on a dial, tap the strip to toggle the
// alternative speed limits.

// --------------------------------------------------------------------------- startup

// A WebUI behind a reverse proxy may use a private CA installed in the OS trust store, which Node ignores
// unless NODE_EXTRA_CA_CERTS is set. Trust the system store directly as well (Node >= 22.19).
const tls = require("node:tls");
try {
  tls.setDefaultCACertificates([...tls.getCACertificates("default"), ...tls.getCACertificates("system")]);
} catch {}

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

// --------------------------------------------------------------------------- config

// The default WebUI URL is set from any button's settings panel; a button's own URL overrides it.
const FALLBACK_URL = "http://localhost:8080";
let globals = null; // until the host sends them; nothing is fetched before that
const qbitUrl = (s) => s.url || globals?.url || FALLBACK_URL;

const TICK_MS = 2_000;
const INTERVAL_S = 3;
const TIMEOUT_MS = 8_000;

const ACTION = (suffix) => `${args.pluginUUID}.${suffix}`;
const trimSlash = (u) => String(u).trim().replace(/\/+$/, "");

// --------------------------------------------------------------------------- formatting

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const svgUri = (svg) => "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
const FONT = `font-family="Inter, 'Noto Sans', sans-serif"`;

const AMBER = "#e0a030", GREEN = "#4caf7d", GREY = "#555", TEXT = "#f2f2f2", DIM = "#9a9a9a";

function scaled(v, base, units, decimals) {
  let i = 0;
  while (Math.abs(v) >= base && i < units.length - 1) { v /= base; i++; }
  const d = decimals ?? (Math.abs(v) >= 100 || i === 0 ? 0 : Math.abs(v) >= 10 ? 1 : 2);
  return v.toFixed(d) + units[i];
}


// --------------------------------------------------------------------------- qbittorrent

const qbitSessions = new Map(); // base url -> SID cookie

async function qbit(inst, path, form) {
  const base = trimSlash(qbitUrl(inst.settings));
  const go = () => fetch(base + path, {
    method: form ? "POST" : "GET",
    headers: {
      Referer: base,
      ...(qbitSessions.get(base) ? { Cookie: qbitSessions.get(base) } : {}),
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let res = await go();
  // Only needed when the WebUI doesn't bypass auth for this client.
  if (res.status === 403 && inst.settings.username) {
    const login = await fetch(base + "/api/v2/auth/login", {
      method: "POST",
      headers: { Referer: base, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: inst.settings.username, password: inst.settings.password || "" }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const sid = login.headers.get("set-cookie")?.match(/SID=[^;]+/)?.[0];
    if (sid) qbitSessions.set(base, sid);
    res = await go();
  }
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} for ${path}`), { status: res.status });
  return (res.headers.get("content-type") || "").includes("json") ? res.json() : res.text();
}

async function refreshQbit(inst) {
  try {
    const [info, running, alt] = await Promise.all([
      qbit(inst, "/api/v2/transfer/info"),
      qbit(inst, "/api/v2/torrents/info?filter=running").catch(() => qbit(inst, "/api/v2/torrents/info?filter=resumed")),
      qbit(inst, "/api/v2/transfer/speedLimitsMode"),
    ]);
    inst.state = { down: info.dl_info_speed, up: info.up_info_speed, running: running.length, alt: String(alt).trim() === "1", error: null };
  } catch (e) {
    inst.state = { ...inst.state, error: e.status === 403 ? "login" : "offline" };
    log(`qbittorrent: ${e.message}`);
  }
}

// qBittorrent 5 renamed pause/resume to stop/start; fall back for 4.x.
async function qbitToggleAll(inst) {
  const stop = (inst.state?.running ?? 1) > 0;
  try {
    await qbit(inst, `/api/v2/torrents/${stop ? "stop" : "start"}`, { hashes: "all" });
  } catch (e) {
    if (e.status !== 404) throw e;
    await qbit(inst, `/api/v2/torrents/${stop ? "pause" : "resume"}`, { hashes: "all" });
  }
}

function qbitStatus(st) {
  if (!st) return { text: "…", col: GREY };
  if (st.error && st.down == null) return { text: st.error, col: GREY };
  if (!st.running) return { text: "stopped", col: AMBER };
  return { text: `${st.running} active`, col: "#d8d8d8" };
}

const speed = (v) => (v == null ? "—" : scaled(v, 1024, ["B", "K", "M", "G"]) + "/s");

function qbitKey(inst) {
  const st = inst.state;
  const status = qbitStatus(st);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
<rect width="144" height="144" fill="#141414"/>
<text x="72" y="24" ${FONT} font-size="16" font-weight="600" letter-spacing="2" text-anchor="middle" fill="${DIM}">${esc((inst.settings.label || "QBITTORRENT").toUpperCase())}</text>
${st?.alt ? `<text x="138" y="22" ${FONT} font-size="12" font-weight="700" text-anchor="end" fill="${AMBER}">ALT</text>` : ""}
<text x="10" y="66" ${FONT} font-size="22" fill="#5aa9e6">↓</text>
<text x="134" y="66" ${FONT} font-size="26" font-weight="700" text-anchor="end" fill="${TEXT}">${esc(speed(st?.down))}</text>
<text x="10" y="100" ${FONT} font-size="22" fill="${GREEN}">↑</text>
<text x="134" y="100" ${FONT} font-size="22" font-weight="600" text-anchor="end" fill="#d8d8d8">${esc(speed(st?.up))}</text>
<text x="72" y="136" ${FONT} font-size="17" text-anchor="middle" fill="${status.col}">${esc(status.text)}</text>
</svg>`;
}

function qbitStrip(inst) {
  const st = inst.state;
  const status = qbitStatus(st);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
<rect width="200" height="100" fill="#141414"/>
<text x="6" y="20" ${FONT} font-size="15" font-weight="600" letter-spacing="1.5" fill="${DIM}">${esc((inst.settings.label || "QBITTORRENT").toUpperCase())}</text>
${st?.alt ? `<text x="194" y="20" ${FONT} font-size="13" font-weight="700" text-anchor="end" fill="${AMBER}">ALT</text>` : ""}
<text x="6" y="54" ${FONT} font-size="20" fill="#5aa9e6">↓</text>
<text x="194" y="54" ${FONT} font-size="26" font-weight="700" text-anchor="end" fill="${TEXT}">${esc(speed(st?.down))}</text>
<text x="6" y="92" ${FONT} font-size="18" fill="${GREEN}">↑ <tspan fill="#d8d8d8">${esc(speed(st?.up))}</tspan></text>
<text x="194" y="92" ${FONT} font-size="15" text-anchor="end" fill="${status.col}">${esc(status.text)}</text>
</svg>`;
}

// --------------------------------------------------------------------------- dispatch

const KINDS = {
  transfer: { refresh: refreshQbit, key: qbitKey, strip: qbitStrip, interval: () => INTERVAL_S },
};

const kindOf = (inst) => KINDS[inst.action.slice(args.pluginUUID.length + 1)];

const instances = new Map(); // context -> { action, controller, settings, state, fetchedAt, refreshing }
const lastImage = new Map(); // context -> data URI, to skip redundant redraws

function draw(context) {
  const inst = instances.get(context);
  const kind = inst && kindOf(inst);
  if (!kind) return;
  const image = svgUri(inst.controller === "Encoder" ? kind.strip(inst) : kind.key(inst));
  if (lastImage.get(context) === image) return;
  lastImage.set(context, image);
  send({ event: "setImage", context, payload: { image } });
}

function refresh(context) {
  const inst = instances.get(context);
  const kind = inst && kindOf(inst);
  if (!kind || !globals) return Promise.resolve();
  if (inst.refreshing) return inst.refreshing; // coalesce overlapping requests
  inst.refreshing = (async () => {
    try { await kind.refresh(inst); } catch (e) { log(`${inst.action}: ${e.stack || e}`); }
    inst.fetchedAt = Date.now();
    draw(context);
  })().finally(() => { inst.refreshing = null; });
  return inst.refreshing;
}

let ticker = null;

function startTicking() {
  if (ticker) return;
  ticker = setInterval(() => {
    const now = Date.now();
    for (const [context, inst] of instances) {
      if (now - (inst.fetchedAt || 0) >= kindOf(inst).interval(inst.settings) * 1000) refresh(context);
    }
  }, TICK_MS);
}

function stopTicking() {
  clearInterval(ticker);
  ticker = null;
}

async function press(context) {
  const inst = instances.get(context);
  if (!inst) return;
  try {
    if (inst.action === ACTION("transfer")) await qbitToggleAll(inst);
    await refresh(context);
    send({ event: inst.state?.error ? "showAlert" : "showOk", context });
  } catch (e) {
    log(`${inst.action} press: ${e.message}`);
    send({ event: "showAlert", context });
  }
}

async function tap(context) {
  const inst = instances.get(context);
  if (!inst) return;
  try {
    if (inst.action === ACTION("transfer")) await qbit(inst, "/api/v2/transfer/toggleSpeedLimitsMode", {});
    await refresh(context);
  } catch (e) {
    log(`${inst.action} tap: ${e.message}`);
    send({ event: "showAlert", context });
  }
}

// --------------------------------------------------------------------------- events

function remember(msg) {
  const inst = instances.get(msg.context) || {};
  inst.action = msg.action;
  inst.controller = msg.payload?.controller || inst.controller || "Keypad";
  const settings = msg.payload?.settings || {};
  if (JSON.stringify(settings) !== JSON.stringify(inst.settings)) inst.fetchedAt = 0; // refetch on change
  inst.settings = settings;
  instances.set(msg.context, inst);
  return inst;
}

function handle(msg) {
  switch (msg.event) {
    case "willAppear":
      remember(msg);
      lastImage.delete(msg.context);
      draw(msg.context);
      refresh(msg.context);
      startTicking();
      break;
    case "willDisappear":
      instances.delete(msg.context);
      lastImage.delete(msg.context);
      if (!instances.size) stopTicking();
      break;
    case "didReceiveSettings":
      remember(msg);
      draw(msg.context);
      refresh(msg.context);
      break;
    case "keyUp":
    case "dialDown":
      remember(msg);
      press(msg.context);
      break;
    case "touchTap":
      remember(msg);
      tap(msg.context);
      break;
    case "didReceiveGlobalSettings":
      globals = msg.payload?.settings || {};
      for (const context of instances.keys()) refresh(context);
      break;
  }
}
