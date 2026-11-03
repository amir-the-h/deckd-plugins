// Meeting Countdown: the next meeting from an iCalendar (.ics) feed, with a live countdown
// (Node >= 22, no deps). All buttons share one feed, set in the plugin-wide settings.
//
// Key: shows the meeting that's on now or up next, or with Position 2, 3, … the ones after it. Press to join it (when it has a meeting link and
// starts within 15 minutes or is on now); otherwise press refreshes.
// Dial: turn to step through the coming meetings, push to join the one shown, tap the strip to refresh.

const ics = require("./ics.js");

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

// --------------------------------------------------------------------------- config

let globals = null; // until the host sends them; nothing is fetched before that

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const DRAW_MS = 15_000;
const FETCH_TIMEOUT_MS = 60_000;
const DEFAULT_REFRESH_MIN = 10;
const MIN_REFRESH_MIN = 5;
const LOOKAHEAD = 8 * DAY; // how far ahead "next meeting" looks
const SOON = 5 * MINUTE; // a meeting this close takes over from one still running
const JOIN_WINDOW = 15 * MINUTE; // pressing joins a meeting starting within this
const WARN = 10 * MINUTE; // amber from here
const URGENT = 2 * MINUTE; // red from here

const refreshMs = () => Math.max(MIN_REFRESH_MIN, Number(globals?.refresh) || DEFAULT_REFRESH_MIN) * MINUTE;
const feedUrl = () => (globals?.url || "").trim();

// --------------------------------------------------------------------------- feed

// `list` holds the meetings from a day back to LOOKAHEAD ahead, worked out once per fetch.
const feed = { cal: null, list: [], error: null, fetchedAt: 0, url: null, loading: null };

async function load() {
  const url = feedUrl();
  if (!url) {
    Object.assign(feed, { cal: null, list: [], error: "no calendar", url });
    return;
  }
  try {
    const res = await fetch(url.replace(/^webcal:/i, "https:"), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cal = ics.parse(await res.text());
    const now = Date.now();
    Object.assign(feed, { cal, list: ics.occurrences(cal, now - DAY, now + LOOKAHEAD, globals?.email), error: null, url });
  } catch (e) {
    if (feed.url !== url) Object.assign(feed, { cal: null, list: [] }); // don't keep showing a different calendar
    Object.assign(feed, { error: "offline", url });
    log(`calendar: ${e.message}`); // never the URL: it is a secret
  }
}

function refresh() {
  if (!globals) return Promise.resolve();
  if (feed.loading) return feed.loading;
  feed.loading = load()
    .catch((e) => log(`calendar: ${e.stack || e}`))
    .finally(() => {
      feed.fetchedAt = Date.now();
      feed.loading = null;
      drawAll();
    });
  return feed.loading;
}

// Meetings still to come or running now, soonest first.
function upcoming(now) {
  return feed.list.filter((m) => m.end > now);
}

// What a key shows: a meeting about to start, else the one running (latest started), else the next.
function current(list, now) {
  const next = list.find((m) => m.start > now);
  const running = list.filter((m) => m.start <= now).at(-1);
  if (next && (!running || next.start - now <= SOON)) return next;
  return running || null;
}

// Which meeting a button shows: 1 = the one on now or up next (see current), 2 = the one after it, …
const position = (inst) => Math.max(1, Math.floor(Number(inst.settings.position) || 1));

// Index into `list` of the meeting a button shows, or -1. A dial starts at its position and moves with the
// turns, clamped at the ends.
function shownIndex(inst, list, now) {
  if (!list.length) return -1;
  const base = Math.max(0, list.indexOf(current(list, now))) + position(inst) - 1;
  if (inst.controller !== "Encoder") return base < list.length ? base : -1;
  const i = Math.min(list.length - 1, Math.max(0, base + (inst.cursor || 0)));
  inst.cursor = i - base;
  return i;
}

// The small label: NOW while it runs, NEXT for the first meeting still to start, THEN for later ones.
const heading = (list, m, now) => (m.start <= now ? "NOW" : m === list.find((x) => x.start > now) ? "NEXT" : "THEN");

// --------------------------------------------------------------------------- formatting

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const svgUri = (svg) => "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
const FONT = `font-family="Inter, 'Noto Sans', sans-serif"`;
const RED = "#e05a5a", AMBER = "#e0a030", GREEN = "#4caf7d", BLUE = "#5aa9e6";
const GREY = "#555", TEXT = "#f2f2f2", DIM = "#9a9a9a", SOFT = "#d8d8d8";

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const weekdayName = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

function when(ms, now) {
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / DAY);
  const t = clock.format(ms);
  if (days === 0) return t;
  if (days === 1) return `tmrw ${t}`;
  return `${weekdayName.format(ms)} ${t}`;
}

function span(ms) {
  const mins = Math.max(0, Math.ceil(ms / MINUTE));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// The big line and its colour.
function status(m, now) {
  if (m.start <= now) return { big: `${span(m.end - now)} left`, color: BLUE };
  const until = m.start - now;
  if (until >= DAY) return { big: when(m.start, now), color: SOFT };
  return { big: until < MINUTE ? "now" : `in ${span(until)}`, color: until <= URGENT ? RED : until <= WARN ? AMBER : TEXT };
}

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// Word-wrap into at most `lines` lines of `width` characters; the last line ends in … if cut.
function wrap(text, width, lines) {
  const out = [];
  for (const w of text.replace(/\s+/g, " ").trim().split(" ")) {
    const cur = out.at(-1);
    if (cur !== undefined && (cur + " " + w).length <= width) out[out.length - 1] = cur + " " + w;
    else if (out.length < lines) out.push(w);
    else { out[lines - 1] = trunc(cur + " " + w, width); break; }
  }
  return out.map((l) => trunc(l, width));
}

// --------------------------------------------------------------------------- drawing

function placeholder(inst) {
  if (!globals || (!feed.cal && !feed.error)) return "…";
  if (!feed.cal) return feed.error;
  return null;
}

function key(inst, now) {
  const text = placeholder(inst);
  const label = (s) => `<text x="72" y="22" ${FONT} font-size="14" font-weight="600" letter-spacing="1.5" text-anchor="middle" fill="${DIM}">${esc(trunc((inst.settings.label || s).toUpperCase(), 14))}</text>`;
  const stale = feed.error && feed.cal ? `<circle cx="134" cy="12" r="4" fill="${AMBER}"/>` : "";
  const open = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144"><rect width="144" height="144" fill="#141414"/>${stale}`;
  if (text) return `${open}${label("NEXT")}<text x="72" y="82" ${FONT} font-size="20" text-anchor="middle" fill="${GREY}">${esc(text)}</text></svg>`;

  const list = upcoming(now);
  const m = list[shownIndex(inst, list, now)];
  if (!m) {
    const [word, color] = position(inst) === 1 ? ["free", GREEN] : ["none", GREY];
    return `${open}${label(position(inst) === 1 ? "NEXT" : "THEN")}<text x="72" y="84" ${FONT} font-size="30" font-weight="700" text-anchor="middle" fill="${color}">${word}</text></svg>`;
  }

  const st = status(m, now);
  const title = wrap(m.title, 15, 2);
  const bigSize = st.big.length > 8 ? 24 : 30;
  const pending = m.response === "NEEDS-ACTION" || m.response === "TENTATIVE" ? `<text x="10" y="22" ${FONT} font-size="16" font-weight="700" fill="${AMBER}">?</text>` : "";
  return `${open}${label(heading(list, m, now))}${pending}
<text x="72" y="60" ${FONT} font-size="${bigSize}" font-weight="700" text-anchor="middle" fill="${st.color}">${esc(st.big)}</text>
${title.map((l, i) => `<text x="72" y="${88 + i * 19}" ${FONT} font-size="16" text-anchor="middle" fill="${SOFT}">${esc(l)}</text>`).join("")}
<text x="72" y="136" ${FONT} font-size="14" text-anchor="middle" fill="${DIM}">${esc(when(m.start, now))}${m.link ? " · join" : ""}</text>
</svg>`;
}

function strip(inst, now) {
  const text = placeholder(inst);
  const open = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="200" height="100" fill="#141414"/>`;
  const label = (s) => `<text x="6" y="18" ${FONT} font-size="13" font-weight="600" letter-spacing="1.2" fill="${DIM}">${esc(trunc((inst.settings.label || s).toUpperCase(), 16))}</text>`;
  if (text) return `${open}${label("NEXT")}<text x="100" y="64" ${FONT} font-size="20" text-anchor="middle" fill="${GREY}">${esc(text)}</text></svg>`;

  const list = upcoming(now);
  if (!list.length) return `${open}${label("NEXT")}<text x="100" y="66" ${FONT} font-size="26" font-weight="700" text-anchor="middle" fill="${GREEN}">free</text></svg>`;

  const i = shownIndex(inst, list, now);
  const m = list[i];
  const st = status(m, now);
  return `${open}${label(heading(list, m, now))}
<text x="194" y="18" ${FONT} font-size="15" font-weight="700" text-anchor="end" fill="${st.color}">${esc(st.big)}</text>
${wrap(m.title, 21, 2).map((l, j) => `<text x="6" y="${44 + j * 20}" ${FONT} font-size="15" fill="${j ? SOFT : TEXT}">${esc(l)}</text>`).join("")}
<text x="6" y="93" ${FONT} font-size="13" fill="${DIM}">${esc(when(m.start, now))}–${esc(clock.format(m.end))}${m.link ? " · join" : ""}</text>
<text x="194" y="93" ${FONT} font-size="13" text-anchor="end" fill="${DIM}">${i + 1}/${list.length}</text>
</svg>`;
}

// --------------------------------------------------------------------------- instances

const instances = new Map(); // context -> { action, controller, settings, cursor }
const lastImage = new Map(); // context -> data URI, to skip redundant redraws

function draw(context, now = Date.now()) {
  const inst = instances.get(context);
  if (!inst) return;
  const image = svgUri(inst.controller === "Encoder" ? strip(inst, now) : key(inst, now));
  if (lastImage.get(context) === image) return;
  lastImage.set(context, image);
  send({ event: "setImage", context, payload: { image } });
}

function drawAll() {
  const now = Date.now();
  for (const context of instances.keys()) draw(context, now);
}

let ticker = null;

function startTicking() {
  if (ticker) return;
  ticker = setInterval(() => {
    if (globals && Date.now() - feed.fetchedAt >= refreshMs()) refresh();
    drawAll();
  }, DRAW_MS);
}

function stopTicking() {
  clearInterval(ticker);
  ticker = null;
}

// The meeting a press acts on: the one shown on the key, or the one the dial points at.
function pressed(inst, now) {
  const list = upcoming(now);
  return list[shownIndex(inst, list, now)] || null;
}

async function press(context) {
  const inst = instances.get(context);
  if (!inst) return;
  const now = Date.now();
  const m = feed.cal && pressed(inst, now);
  if (m?.link && m.start - now <= JOIN_WINDOW) {
    send({ event: "openUrl", payload: { url: m.link } });
    return;
  }
  await refresh();
  send({ event: feed.error ? "showAlert" : "showOk", context });
}

function remember(msg) {
  const inst = instances.get(msg.context) || { cursor: 0 };
  inst.action = msg.action;
  inst.controller = msg.payload?.controller || inst.controller || "Keypad";
  inst.settings = msg.payload?.settings || {};
  instances.set(msg.context, inst);
  return inst;
}

// --------------------------------------------------------------------------- events

function handle(msg) {
  switch (msg.event) {
    case "willAppear":
      remember(msg);
      lastImage.delete(msg.context);
      draw(msg.context);
      if (!feed.fetchedAt) refresh();
      startTicking();
      break;
    case "willDisappear":
      instances.delete(msg.context);
      lastImage.delete(msg.context);
      if (!instances.size) stopTicking();
      break;
    case "didReceiveSettings": {
      const inst = instances.get(msg.context);
      if (inst && String(inst.settings.position ?? "") !== String(msg.payload?.settings?.position ?? "")) inst.cursor = 0;
      remember(msg);
      draw(msg.context);
      break;
    }
    case "keyUp":
    case "dialDown":
      remember(msg);
      press(msg.context);
      break;
    case "dialRotate": {
      const inst = remember(msg);
      inst.cursor = (inst.cursor || 0) + (msg.payload?.ticks || 0);
      draw(msg.context);
      break;
    }
    case "touchTap":
      remember(msg);
      refresh().then(() => send({ event: feed.error ? "showAlert" : "showOk", context: msg.context }));
      break;
    case "didReceiveGlobalSettings": {
      const before = `${feedUrl()} ${globals?.email || ""}`;
      globals = msg.payload?.settings || {};
      if (!feed.fetchedAt || `${feedUrl()} ${globals.email || ""}` !== before) refresh();
      else drawAll();
      break;
    }
  }
}
