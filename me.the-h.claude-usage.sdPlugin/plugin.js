// Claude Usage — shows Claude Code plan limits and token counts on a Stream Deck (Node >= 22, no deps).
//
// Each button picks an *account*: a Claude Code config dir (~/.claude by default, or
// the CLAUDE_CONFIG_DIR of a second login, e.g. ~/.claude-work). Per account there are two data sources:
//   * Limits: GET https://api.anthropic.com/api/oauth/usage — the (undocumented) endpoint behind Claude Code's /usage.
//     Authenticated with the OAuth token Claude Code keeps in <dir>/.credentials.json. We only ever
//     *read* that file; refreshing the token ourselves would rotate the refresh token and log Claude Code out.
//   * Tokens: the per-message `usage` blocks in Claude Code's transcripts under <dir>/projects/**.jsonl,
//     read incrementally so each poll only parses lines appended since the last one.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// --------------------------------------------------------------------------- startup

const args = {};
for (let i = 2; i + 1 < process.argv.length; i += 2) args[process.argv[i].replace(/^-/, "")] = process.argv[i + 1];

const ws = new WebSocket(`ws://127.0.0.1:${args.port}`);
const send = (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
const log = (message) => { console.log(message); send({ event: "logMessage", payload: { message } }); };

ws.onopen = () => send({ event: args.registerEvent, uuid: args.pluginUUID });
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

const HOME = os.homedir();
const DEFAULT_DIR = "~/.claude";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

const POLL_MS = 5 * 60_000;     // the usage endpoint rate-limits aggressive polling
const MANUAL_MIN_MS = 30_000;   // a key press refreshes at most this often
const REDRAW_MS = 30_000;       // countdowns tick locally between polls
const HOUR = 3600_000;
const KEEP_MS = 8 * 24 * HOUR;  // tokens: a week window plus slack

const ACTION = (suffix) => `${args.pluginUUID}.${suffix}`;
const expand = (p) => path.resolve(String(p || DEFAULT_DIR).trim().replace(/^~(?=$|\/)/, HOME));

// --------------------------------------------------------------------------- accounts

const accounts = new Map(); // resolved config dir -> account

function account(dir) {
  let a = accounts.get(dir);
  if (!a) {
    a = {
      dir,
      usage: { data: null, error: null, fetchedAt: 0, backoffUntil: 0 },
      files: new Map(),    // transcript path -> { offset, rest }
      messages: new Map(), // `${message.id}:${requestId}` -> { ts, input, output, cacheWrite, cacheRead }
      refreshing: null,
    };
    accounts.set(dir, a);
  }
  return a;
}

const accountOf = (inst) => account(expand(inst.settings.configDir));

// Config dirs that hold a Claude login, for the settings panel's account picker.
function detectAccounts() {
  const found = [];
  for (const name of fs.readdirSync(HOME)) {
    if (!name.startsWith(".claude") || name === ".claude.json" || name.startsWith(".claude.json")) continue;
    try {
      const oauth = JSON.parse(fs.readFileSync(path.join(HOME, name, ".credentials.json"), "utf8")).claudeAiOauth;
      if (oauth?.accessToken) found.push({ dir: `~/${name}`, plan: oauth.subscriptionType || "" });
    } catch {}
  }
  return found;
}

// --------------------------------------------------------------------------- limits (API)

function readToken(a) {
  const oauth = JSON.parse(fs.readFileSync(path.join(a.dir, ".credentials.json"), "utf8")).claudeAiOauth;
  if (!oauth?.accessToken) throw Object.assign(new Error("no Claude login"), { code: "login" });
  if (oauth.expiresAt && oauth.expiresAt < Date.now()) {
    // Claude Code refreshes it the next time it runs.
    throw Object.assign(new Error("token expired"), { code: "expired" });
  }
  return oauth.accessToken;
}

async function fetchUsage(a) {
  const usage = a.usage;
  if (Date.now() < usage.backoffUntil) return;
  try {
    let token;
    try { token = readToken(a); } catch (e) { throw e.code ? e : Object.assign(e, { code: "login" }); }
    const res = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after")) || 600;
      usage.backoffUntil = Date.now() + retry * 1000;
      throw Object.assign(new Error(`rate limited for ${retry}s`), { code: "rate" });
    }
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`HTTP ${res.status}`), { code: "expired" });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { code: "error" });
    usage.data = await res.json();
    usage.error = null;
    usage.fetchedAt = Date.now();
  } catch (e) {
    usage.error = e.code || (e.name === "TimeoutError" ? "offline" : e.cause ? "offline" : "error");
    log(`${a.dir}: usage fetch failed: ${e.message}`);
  }
}

// { percent, resetsAt (ms) | null } for "five_hour" / "seven_day", or null before the first fetch.
function limit(a, key) {
  const w = a.usage.data?.[key];
  if (!w) return null;
  const resetsAt = w.resets_at ? Date.parse(w.resets_at) : null;
  // Once the reset time passes the window is empty until the next fetch says otherwise.
  if (resetsAt && resetsAt <= Date.now()) return { percent: 0, resetsAt: null };
  return { percent: Math.round(w.utilization ?? 0), resetsAt };
}

// --------------------------------------------------------------------------- tokens (local logs)

function* jsonlFiles(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* jsonlFiles(p);
    else if (e.name.endsWith(".jsonl")) yield p;
  }
}

function ingest(a, line) {
  if (!line.includes('"usage"')) return;
  let entry;
  try { entry = JSON.parse(line); } catch { return; }
  const u = entry.message?.usage;
  const ts = Date.parse(entry.timestamp);
  if (!u || !ts || Date.now() - ts > KEEP_MS) return;
  // Streaming writes the same message more than once; the last copy has the final counts.
  const key = `${entry.message.id ?? entry.uuid}:${entry.requestId ?? ""}`;
  a.messages.set(key, {
    ts,
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
  });
}

function scanTokens(a) {
  const cutoff = Date.now() - KEEP_MS;
  for (const p of jsonlFiles(path.join(a.dir, "projects"))) {
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.mtimeMs < cutoff) continue;
    let f = a.files.get(p);
    if (!f || st.size < f.offset) f = { offset: 0, rest: "" }; // new or truncated
    if (st.size > f.offset) {
      const fd = fs.openSync(p, "r");
      try {
        const buf = Buffer.alloc(st.size - f.offset);
        fs.readSync(fd, buf, 0, buf.length, f.offset);
        const lines = (f.rest + buf.toString("utf8")).split("\n");
        f.rest = lines.pop(); // incomplete last line, finished on a later scan
        for (const line of lines) ingest(a, line);
        f.offset = st.size;
      } finally {
        fs.closeSync(fd);
      }
    }
    a.files.set(p, f);
  }
  for (const [k, m] of a.messages) if (m.ts < cutoff) a.messages.delete(k);
}

function tokensSince(a, start, withCacheReads) {
  const t = { total: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  for (const m of a.messages.values()) {
    if (m.ts < start) continue;
    t.input += m.input; t.output += m.output; t.cacheWrite += m.cacheWrite; t.cacheRead += m.cacheRead;
  }
  t.total = t.input + t.output + t.cacheWrite + (withCacheReads ? t.cacheRead : 0);
  return t;
}

// Start of the requested window, derived from the API's reset times so it matches Claude's own windows.
function windowStart(a, win) {
  if (win === "today") { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  if (win === "week") {
    const w = limit(a, "seven_day");
    return w?.resetsAt ? w.resetsAt - 7 * 24 * HOUR : Date.now() - 7 * 24 * HOUR;
  }
  const s = limit(a, "five_hour");
  if (s && !s.resetsAt) return Infinity; // no session running
  return s?.resetsAt ? s.resetsAt - 5 * HOUR : Date.now() - 5 * HOUR;
}

// --------------------------------------------------------------------------- formatting

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

function fmtTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e8 ? 0 : n >= 1e7 ? 1 : 2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + "k";
  return String(n);
}

function fmtCountdown(ms) {
  if (ms == null) return "idle";
  const m = Math.max(0, Math.round((ms - Date.now()) / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const ERR_TEXT = { login: "log in", expired: "open CC", rate: "rate ltd", offline: "offline", error: "error" };
const color = (p) => (p >= 85 ? "#e5534b" : p >= 60 ? "#e0a030" : "#4caf7d");
const svgUri = (svg) => "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
const FONT = `font-family="Inter, 'Noto Sans', sans-serif"`;

// --------------------------------------------------------------------------- drawing

function gaugeKey(a, label, lim) {
  const r = 40, c = 2 * Math.PI * r;
  const stale = a.usage.error && lim;
  const pct = lim?.percent ?? 0;
  const col = lim ? color(pct) : "#555";
  const center = lim ? `${pct}%` : "—";
  const bottom = lim ? fmtCountdown(lim.resetsAt) : ERR_TEXT[a.usage.error] || "…";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
<rect width="144" height="144" fill="#141414"/>
<text x="72" y="24" ${FONT} font-size="16" font-weight="600" letter-spacing="2" text-anchor="middle" fill="#9a9a9a">${esc(label)}</text>
<circle cx="72" cy="74" r="${r}" fill="none" stroke="#2a2a2a" stroke-width="10"/>
<circle cx="72" cy="74" r="${r}" fill="none" stroke="${col}" stroke-width="10" stroke-linecap="round"
  stroke-dasharray="${(c * Math.min(pct, 100)) / 100} ${c}" transform="rotate(-90 72 74)"/>
<text x="72" y="85" ${FONT} font-size="${center.length > 3 ? 26 : 30}" font-weight="700" text-anchor="middle" fill="#f2f2f2">${center}</text>
<text x="72" y="137" ${FONT} font-size="19" text-anchor="middle" fill="${stale ? "#777" : "#d8d8d8"}">${esc(bottom)}</text>
${stale ? `<circle cx="132" cy="12" r="5" fill="#e0a030"/>` : ""}
</svg>`;
}

const WIN_LABEL = { session: "SESSION", week: "WEEK", today: "TODAY" };

function tokensKey(a, settings) {
  const win = settings.window || "session";
  const t = tokensSince(a, windowStart(a, win), !!settings.cacheReads);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
<rect width="144" height="144" fill="#141414"/>
<text x="72" y="24" ${FONT} font-size="16" font-weight="600" letter-spacing="2" text-anchor="middle" fill="#9a9a9a">${esc(settings.label || WIN_LABEL[win])}</text>
<text x="72" y="84" ${FONT} font-size="40" font-weight="700" text-anchor="middle" fill="#d97757">${fmtTokens(t.total)}</text>
<text x="72" y="106" ${FONT} font-size="15" text-anchor="middle" fill="#9a9a9a">tokens</text>
<text x="72" y="134" ${FONT} font-size="16" text-anchor="middle" fill="#d8d8d8">out ${fmtTokens(t.output)}</text>
</svg>`;
}

function bar(a, y, label, lim, w = 112, x = 34) {
  const pct = lim?.percent ?? 0;
  const right = lim ? `${pct}% · ${fmtCountdown(lim.resetsAt)}` : ERR_TEXT[a.usage.error] || "…";
  return `<text x="4" y="${y + 9}" ${FONT} font-size="14" font-weight="600" fill="#9a9a9a">${label}</text>
<rect x="${x}" y="${y}" width="${w}" height="10" rx="5" fill="#2a2a2a"/>
<rect x="${x}" y="${y}" width="${Math.max(lim ? 10 : 0, (w * Math.min(pct, 100)) / 100)}" height="10" rx="5" fill="${lim ? color(pct) : "#555"}"/>
<text x="${x}" y="${y + 28}" ${FONT} font-size="15" fill="#d8d8d8">${esc(right)}</text>`;
}

// Dial strips get a wide image, which deckd stretches across the whole touch-strip segment.
function overviewStrip(a, settings) {
  const t = tokensSince(a, windowStart(a, settings.window || "session"), !!settings.cacheReads);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
<rect width="200" height="100" fill="#141414"/>
${bar(a, 8, "5h", limit(a, "five_hour"), 160)}
${bar(a, 56, "7d", limit(a, "seven_day"), 160)}
<text x="196" y="36" ${FONT} font-size="15" font-weight="700" text-anchor="end" fill="#d97757">${fmtTokens(t.total)}</text>
${settings.label ? `<text x="196" y="84" ${FONT} font-size="13" text-anchor="end" fill="#9a9a9a">${esc(settings.label)}</text>` : ""}
</svg>`;
}

function overviewKey(a) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
<rect width="144" height="144" fill="#141414"/>
${bar(a, 14, "5h", limit(a, "five_hour"), 104)}
${bar(a, 78, "7d", limit(a, "seven_day"), 104)}
</svg>`;
}

const lastImage = new Map(); // context -> data URI, to skip redundant redraws

function draw(context) {
  const inst = instances.get(context);
  if (!inst) return;
  const a = accountOf(inst);
  const label = inst.settings.label;
  let svg;
  switch (inst.action) {
    case ACTION("session"): svg = gaugeKey(a, label || "SESSION", limit(a, "five_hour")); break;
    case ACTION("weekly"): svg = gaugeKey(a, label || "WEEKLY", limit(a, "seven_day")); break;
    case ACTION("tokens"): svg = tokensKey(a, inst.settings); break;
    case ACTION("overview"): svg = inst.controller === "Encoder" ? overviewStrip(a, inst.settings) : overviewKey(a); break;
    default: return;
  }
  const image = svgUri(svg);
  if (lastImage.get(context) === image) return;
  lastImage.set(context, image);
  send({ event: "setImage", context, payload: { image } });
}

const drawAll = () => instances.forEach((_, ctx) => draw(ctx));

// --------------------------------------------------------------------------- polling

// Only accounts some visible button uses; forget the rest so their caches don't linger.
function activeAccounts() {
  const used = new Set([...instances.values()].map((inst) => accountOf(inst)));
  for (const [dir, a] of accounts) if (!used.has(a)) accounts.delete(dir);
  return [...used];
}

function scan(a) {
  try { scanTokens(a); } catch (e) { log(`${a.dir}: token scan failed: ${e.stack || e}`); }
}

function refresh(a) {
  if (a.refreshing) return a.refreshing; // coalesce overlapping requests
  a.refreshing = (async () => {
    await fetchUsage(a);
    scan(a);
    drawAll();
  })().finally(() => { a.refreshing = null; });
  return a.refreshing;
}

let pollTimer = null, redrawTimer = null;

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => activeAccounts().forEach(refresh), POLL_MS);
  redrawTimer = setInterval(() => {
    activeAccounts().forEach(scan);
    drawAll();
  }, REDRAW_MS);
}

function stopPolling() {
  clearInterval(pollTimer); clearInterval(redrawTimer);
  pollTimer = redrawTimer = null;
}

// First sight of an account (new button, or a button switched to another account): fetch right away.
function ensureFresh(a) {
  if (!a.usage.fetchedAt && !a.usage.error && !a.refreshing) refresh(a);
}

async function manualRefresh(context) {
  const inst = instances.get(context);
  const a = accountOf(inst);
  if (Date.now() - a.usage.fetchedAt < MANUAL_MIN_MS) {
    scan(a);
    drawAll();
  } else {
    await refresh(a);
  }
  send({ event: a.usage.error ? "showAlert" : "showOk", context });
}

// --------------------------------------------------------------------------- events

const instances = new Map(); // context -> { action, controller, settings }

function remember(msg) {
  const inst = instances.get(msg.context) || {};
  inst.action = msg.action;
  inst.controller = msg.payload?.controller || inst.controller || "Keypad";
  inst.settings = msg.payload?.settings || {};
  instances.set(msg.context, inst);
  return inst;
}

function handle(msg) {
  switch (msg.event) {
    case "willAppear":
      ensureFresh(accountOf(remember(msg)));
      lastImage.delete(msg.context);
      draw(msg.context);
      startPolling();
      break;
    case "willDisappear":
      instances.delete(msg.context);
      lastImage.delete(msg.context);
      if (!instances.size) stopPolling();
      break;
    case "didReceiveSettings":
      ensureFresh(accountOf(remember(msg)));
      draw(msg.context);
      break;
    case "keyUp":
    case "dialDown":
    case "touchTap":
      remember(msg);
      manualRefresh(msg.context);
      break;
    case "propertyInspectorDidAppear":
      send({ event: "sendToPropertyInspector", context: msg.context, payload: { accounts: detectAccounts() } });
      break;
    case "sendToPlugin":
      if (msg.payload?.command === "getAccounts") {
        send({ event: "sendToPropertyInspector", context: msg.context, payload: { accounts: detectAccounts() } });
      }
      break;
  }
}
