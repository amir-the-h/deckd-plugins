// Homelab — Prometheus stats, service health and qBittorrent on a Stream Deck (Node >= 22, no deps).
//
// Three actions:
//   * stat:        any PromQL query rendered as a number or gauge, coloured by warn/crit thresholds.
//                  Home Assistant exports to the same Prometheus, so this covers health sensors too.
//   * services:    HTTP up/down dots for a list of URLs (anything answering < 500 counts as up).
//   * qbittorrent: transfer speeds; press stops/starts every torrent, a strip tap toggles alt limits.

// --------------------------------------------------------------------------- startup

// Self-hosted services often use a private CA installed in the OS trust store, which Node ignores
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

// Plugin-wide defaults, set from any button's settings panel; a button's own URL overrides them.
const FALLBACK = { prometheus: "http://localhost:9090", qbittorrent: "http://localhost:8080" };
let globals = null; // until the host sends them; nothing is fetched before that
const promServer = (s) => s.server || globals?.prometheus || FALLBACK.prometheus;
const qbitUrl = (s) => s.url || globals?.qbittorrent || FALLBACK.qbittorrent;

const TICK_MS = 2_000;
const STAT_INTERVAL_S = 30;
const SERVICES_INTERVAL_S = 60;
const QBIT_INTERVAL_S = 3;
const TIMEOUT_MS = 8_000;

const ACTION = (suffix) => `${args.pluginUUID}.${suffix}`;
const num = (v) => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const trimSlash = (u) => String(u).trim().replace(/\/+$/, "");

// --------------------------------------------------------------------------- formatting

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const svgUri = (svg) => "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
const FONT = `font-family="Inter, 'Noto Sans', sans-serif"`;

const RED = "#e5534b", AMBER = "#e0a030", GREEN = "#4caf7d", GREY = "#555", TEXT = "#f2f2f2", DIM = "#9a9a9a";

function scaled(v, base, units, decimals) {
  let i = 0;
  while (Math.abs(v) >= base && i < units.length - 1) { v /= base; i++; }
  const d = decimals ?? (Math.abs(v) >= 100 || i === 0 ? 0 : Math.abs(v) >= 10 ? 1 : 2);
  return v.toFixed(d) + units[i];
}

function fmt(v, format, decimals) {
  if (v == null) return "—";
  switch (format) {
    case "percent": return v.toFixed(decimals ?? 0) + "%";
    case "bytes": return scaled(v, 1024, ["B", "K", "M", "G", "T", "P"], decimals);
    case "bytes_rate": return scaled(v, 1024, ["B", "K", "M", "G"], decimals) + "/s";
    case "bitrate": return scaled(v, 1000, ["b", "k", "M", "G"], decimals);
    case "ok": return v >= 1 ? "OK" : "FAIL";
    default:
      if (Math.abs(v) >= 10_000) return scaled(v, 1000, ["", "k", "M", "B"], decimals ?? 1);
      return v.toFixed(decimals ?? 0);
  }
}

// "crit" | "warn" | null. `dir: below` means low values are the bad ones.
function level(v, s) {
  if (v == null) return null;
  if (s.format === "ok") return v >= 1 ? null : "crit";
  const below = s.dir === "below";
  const hit = (t) => t != null && (below ? v <= t : v >= t);
  if (hit(num(s.crit))) return "crit";
  if (hit(num(s.warn))) return "warn";
  return null;
}

const levelColor = (lvl, base) => (lvl === "crit" ? RED : lvl === "warn" ? AMBER : base);
const valueSize = (text) => (text.length <= 3 ? 46 : text.length === 4 ? 40 : text.length === 5 ? 34 : text.length === 6 ? 29 : 24);

// --------------------------------------------------------------------------- prometheus

async function promQuery(server, query) {
  const url = `${trimSlash(server)}/api/v1/query?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.status !== "success") throw new Error(body.error || "query failed");
  const { resultType, result } = body.data;
  if (resultType === "scalar") return Number(result[1]);
  if (resultType === "vector") return result.length ? Number(result[0].value[1]) : null;
  throw new Error(`unsupported result type ${resultType}`);
}

async function refreshStat(inst) {
  const s = inst.settings;
  if (!s.query) { inst.state = { error: "no query" }; return; }
  try {
    const [value, detail] = await Promise.all([
      promQuery(promServer(s), s.query),
      s.detailQuery ? promQuery(promServer(s), s.detailQuery) : null,
    ]);
    inst.state = { value: value ?? num(s.empty), detail, error: null };
  } catch (e) {
    inst.state = { ...inst.state, error: e.name === "TimeoutError" || e.cause ? "offline" : "error" };
    log(`stat "${s.label || s.query}": ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ""}`);
  }
}

function statDetail(inst) {
  const s = inst.settings, st = inst.state || {};
  if (st.error && st.value == null) return st.error;
  if (!s.detailQuery && !s.detailText) return "";
  const v = st.detail;
  const text = s.detailText || "{v}";
  return text.replace("{v}", fmt(v, s.detailFormat, num(s.detailDecimals) ?? undefined));
}

function statKey(inst) {
  const s = inst.settings, st = inst.state || {};
  const v = st.value ?? null;
  const lvl = level(v, s);
  const col = v == null ? GREY : levelColor(lvl, s.color || TEXT);
  const text = fmt(v, s.format, num(s.decimals) ?? undefined);
  const unit = v == null ? "" : s.unit || "";
  const detail = statDetail(inst);
  const max = num(s.max);
  const stale = st.error && v != null;
  let body;
  if (max) {
    const r = 40, c = 2 * Math.PI * r;
    const frac = v == null ? 0 : Math.max(0, Math.min(1, v / max));
    const ring = v == null ? GREY : levelColor(lvl, s.color || GREEN);
    const size = Math.min(30, valueSize(text) - 10);
    body = `<circle cx="72" cy="74" r="${r}" fill="none" stroke="#2a2a2a" stroke-width="10"/>
<circle cx="72" cy="74" r="${r}" fill="none" stroke="${ring}" stroke-width="10" stroke-linecap="round"
  stroke-dasharray="${c * frac} ${c}" transform="rotate(-90 72 74)"/>
<text x="72" y="${unit ? 78 : 84}" ${FONT} font-size="${size}" font-weight="700" text-anchor="middle" fill="${TEXT}">${esc(text)}</text>
${unit ? `<text x="72" y="96" ${FONT} font-size="13" text-anchor="middle" fill="${DIM}">${esc(unit)}</text>` : ""}`;
  } else {
    body = `<text x="72" y="${unit ? 82 : 90}" ${FONT} font-size="${valueSize(text)}" font-weight="700" text-anchor="middle" fill="${col}">${esc(text)}</text>
${unit ? `<text x="72" y="106" ${FONT} font-size="15" text-anchor="middle" fill="${DIM}">${esc(unit)}</text>` : ""}`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
<rect width="144" height="144" fill="#141414"/>
${lvl === "crit" ? `<rect x="2" y="2" width="140" height="140" rx="10" fill="none" stroke="${RED}" stroke-width="4"/>` : ""}
<text x="72" y="24" ${FONT} font-size="16" font-weight="600" letter-spacing="2" text-anchor="middle" fill="${DIM}">${esc((s.label || "").toUpperCase())}</text>
${body}
<text x="72" y="136" ${FONT} font-size="17" text-anchor="middle" fill="${stale ? "#777" : "#d8d8d8"}">${esc(detail)}</text>
${stale ? `<circle cx="132" cy="12" r="5" fill="${AMBER}"/>` : ""}
</svg>`;
}

// Dial strips get a wide image, which deckd stretches across the whole touch-strip segment.
function statStrip(inst) {
  const s = inst.settings, st = inst.state || {};
  const v = st.value ?? null;
  const lvl = level(v, s);
  const text = fmt(v, s.format, num(s.decimals) ?? undefined) + (v == null || !s.unit ? "" : ` ${s.unit}`);
  const max = num(s.max);
  const frac = v == null || !max ? 0 : Math.max(0, Math.min(1, v / max));
  const barCol = v == null ? GREY : levelColor(lvl, s.color || GREEN);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
<rect width="200" height="100" fill="#141414"/>
<text x="6" y="20" ${FONT} font-size="15" font-weight="600" letter-spacing="1.5" fill="${DIM}">${esc((s.label || "").toUpperCase())}</text>
<text x="194" y="${max ? 54 : 64}" ${FONT} font-size="${text.length > 8 ? 26 : 32}" font-weight="700" text-anchor="end" fill="${max ? TEXT : levelColor(lvl, v == null ? GREY : s.color || TEXT)}">${esc(text)}</text>
${max ? `<rect x="6" y="64" width="188" height="10" rx="5" fill="#2a2a2a"/>
<rect x="6" y="64" width="${Math.max(v == null ? 0 : 10, 188 * frac)}" height="10" rx="5" fill="${barCol}"/>` : ""}
<text x="6" y="94" ${FONT} font-size="14" fill="${st.error && v != null ? "#777" : "#d8d8d8"}">${esc(statDetail(inst))}</text>
</svg>`;
}

// --------------------------------------------------------------------------- services

function parseServices(text) {
  return String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf("=");
    return i > 0 ? { name: l.slice(0, i).trim(), url: l.slice(i + 1).trim() } : { name: l.replace(/^https?:\/\//, "").split(/[./:]/)[0], url: l };
  });
}

async function checkUrl(url) {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
    res.body?.cancel();
    return res.status < 500;
  } catch {
    return false;
  }
}

async function refreshServices(inst) {
  const list = parseServices(inst.settings.services);
  const results = await Promise.all(list.map(async (svc) => ({ ...svc, up: await checkUrl(svc.url) })));
  inst.state = { results };
}

function servicesGrid(inst, w, h, top, cols) {
  const results = inst.state?.results || parseServices(inst.settings.services).map((s) => ({ ...s, up: null }));
  if (!results.length) return `<text x="${w / 2}" y="${(h + top) / 2}" ${FONT} font-size="15" text-anchor="middle" fill="${DIM}">add services</text>`;
  const rows = Math.ceil(results.length / cols) || 1;
  const cw = w / cols, rh = Math.min(30, (h - top) / rows);
  return results.map((r, i) => {
    const x = (i % cols) * cw + 6, y = top + Math.floor(i / cols) * rh + rh / 2;
    const col = r.up == null ? GREY : r.up ? GREEN : RED;
    return `<circle cx="${x + 6}" cy="${y}" r="6" fill="${col}"/>
<text x="${x + 17}" y="${y + 5}" ${FONT} font-size="14" fill="${r.up === false ? "#ff9b94" : "#d8d8d8"}">${esc(r.name.slice(0, 7))}</text>`;
  }).join("\n");
}

function servicesHeader(inst, x, anchor) {
  const results = inst.state?.results;
  if (!results) return "";
  const up = results.filter((r) => r.up).length;
  const col = up === results.length ? GREEN : up === 0 ? RED : AMBER;
  return `<text x="${x}" y="22" ${FONT} font-size="16" font-weight="700" text-anchor="${anchor}" fill="${col}">${up}/${results.length}</text>`;
}

function servicesKey(inst) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
<rect width="144" height="144" fill="#141414"/>
<text x="6" y="22" ${FONT} font-size="15" font-weight="600" letter-spacing="1.5" fill="${DIM}">${esc((inst.settings.label || "SERVICES").toUpperCase())}</text>
${servicesHeader(inst, 138, "end")}
${servicesGrid(inst, 144, 144, 36, 2)}
</svg>`;
}

function servicesStrip(inst) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
<rect width="200" height="100" fill="#141414"/>
<text x="6" y="22" ${FONT} font-size="15" font-weight="600" letter-spacing="1.5" fill="${DIM}">${esc((inst.settings.label || "SERVICES").toUpperCase())}</text>
${servicesHeader(inst, 194, "end")}
${servicesGrid(inst, 200, 100, 30, 3)}
</svg>`;
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

const speed = (v) => (v == null ? "—" : fmt(v, "bytes_rate"));

function qbitKey(inst) {
  const st = inst.state;
  const status = qbitStatus(st);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
<rect width="144" height="144" fill="#141414"/>
<text x="72" y="24" ${FONT} font-size="16" font-weight="600" letter-spacing="2" text-anchor="middle" fill="${DIM}">${esc((inst.settings.label || "TORRENT").toUpperCase())}</text>
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
<text x="6" y="20" ${FONT} font-size="15" font-weight="600" letter-spacing="1.5" fill="${DIM}">${esc((inst.settings.label || "TORRENT").toUpperCase())}</text>
${st?.alt ? `<text x="194" y="20" ${FONT} font-size="13" font-weight="700" text-anchor="end" fill="${AMBER}">ALT</text>` : ""}
<text x="6" y="54" ${FONT} font-size="20" fill="#5aa9e6">↓</text>
<text x="194" y="54" ${FONT} font-size="26" font-weight="700" text-anchor="end" fill="${TEXT}">${esc(speed(st?.down))}</text>
<text x="6" y="92" ${FONT} font-size="18" fill="${GREEN}">↑ <tspan fill="#d8d8d8">${esc(speed(st?.up))}</tspan></text>
<text x="194" y="92" ${FONT} font-size="15" text-anchor="end" fill="${status.col}">${esc(status.text)}</text>
</svg>`;
}

// --------------------------------------------------------------------------- dispatch

const KINDS = {
  stat: { refresh: refreshStat, key: statKey, strip: statStrip, interval: (s) => num(s.interval) || STAT_INTERVAL_S },
  services: { refresh: refreshServices, key: servicesKey, strip: servicesStrip, interval: (s) => num(s.interval) || SERVICES_INTERVAL_S },
  qbittorrent: { refresh: refreshQbit, key: qbitKey, strip: qbitStrip, interval: () => QBIT_INTERVAL_S },
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
    if (inst.action === ACTION("qbittorrent")) {
      await qbitToggleAll(inst);
    } else if (inst.action === ACTION("stat") && inst.settings.url) {
      send({ event: "openUrl", payload: { url: inst.settings.url } });
      return;
    }
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
    if (inst.action === ACTION("qbittorrent")) await qbit(inst, "/api/v2/transfer/toggleSpeedLimitsMode", {});
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
    case "sendToPlugin":
      if (msg.payload?.command === "test" && instances.has(msg.context)) {
        refresh(msg.context).then(() => {
          const inst = instances.get(msg.context);
          send({ event: "sendToPropertyInspector", context: msg.context, payload: { test: inst?.state || null } });
        });
      }
      break;
  }
}
