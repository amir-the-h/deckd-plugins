// Docker Control: health of compose stacks and containers, with hold-to-restart (Node >= 22, no deps).
// Talks to the Docker API on a local socket, over HTTP(S), or through Portainer.
//
//   stack      a compose project: running / total containers, and which are down or unhealthy
//   container  one container: up, unhealthy, starting or stopped, and for how long
//   overview   every container: how many run, are stopped or unhealthy
//
// A press starts or stops a stack or container (or, if set to, just refreshes). Holding it about a
// second restarts it. On a stack dial, turn to pick the whole stack or one of its containers first.
// The Portainer container the plugin talks through is never stopped.

const tls = require("node:tls");
const docker = require("./docker.js");

// Docker hosts behind a reverse proxy often use a private CA from the OS trust store, which Node
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

// --------------------------------------------------------------------------- config and data

let globals = null; // until the host sends them; nothing is fetched before that

const TICK_MS = 1_000;
const DEFAULT_INTERVAL_S = 10;
const MIN_INTERVAL_S = 3;
const HOLD_MS = 900;

const intervalMs = () => Math.max(MIN_INTERVAL_S, Number(globals?.interval) || DEFAULT_INTERVAL_S) * 1000;
const ignored = () => new Set(String(globals?.ignore || "").split(/[\s,]+/).filter(Boolean));

let conn = null;
const data = { list: null, error: null, fetchedAt: 0, loading: null };

function connectionFor() {
  const next = docker.connection(globals || {});
  if (!conn || conn.key !== next.key) {
    conn = next;
    Object.assign(data, { list: null, error: null, fetchedAt: 0 });
  }
  return conn;
}

function refresh() {
  if (!globals) return Promise.resolve();
  if (data.loading) return data.loading;
  const c = connectionFor();
  data.loading = docker.containers(c)
    .then((list) => { if (c === conn) Object.assign(data, { list, error: null }); })
    .catch((e) => {
      if (c !== conn) return;
      data.error = { auth: "sign in", offline: "offline" }[e.code] || "error";
      log(`docker: ${e.message}`);
    })
    .finally(() => {
      data.fetchedAt = Date.now();
      data.loading = null;
      drawAll();
    });
  return data.loading;
}

const byName = (a, b) => a.name.localeCompare(b.name);
const stackNames = () => [...new Set((data.list || []).map((c) => c.project).filter(Boolean))].sort();
const stackContainers = (project) => (data.list || []).filter((c) => c.project === project).sort(byName);
const findContainer = (name) => (data.list || []).find((c) => c.name === name) || null;

// How a set of containers is doing; ignored containers don't count against it.
function summary(list) {
  const skip = ignored();
  const watched = list.filter((c) => !skip.has(c.name));
  const down = watched.filter((c) => c.state !== "running");
  const unhealthy = watched.filter((c) => c.state === "running" && c.health === "unhealthy");
  const starting = watched.filter((c) => c.state === "running" && c.health === "starting");
  return { watched, running: watched.length - down.length, down, unhealthy, starting };
}

// --------------------------------------------------------------------------- drawing

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const svgUri = (svg) => "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
const FONT = `font-family="Inter, 'Noto Sans', sans-serif"`;
const RED = "#e05a5a", AMBER = "#e0a030", GREEN = "#4caf7d", BLUE = "#5aa9e6";
const GREY = "#555", TEXT = "#f2f2f2", DIM = "#9a9a9a", SOFT = "#d8d8d8";
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

const summaryColor = (s) => (s.down.length ? RED : s.unhealthy.length ? AMBER : s.starting.length ? BLUE : s.watched.length ? GREEN : GREY);

function summaryDetail(s) {
  if (s.down.length) return s.down.length === 1 ? `${s.down[0].service || s.down[0].name} down` : `${s.down.length} down`;
  if (s.unhealthy.length) return s.unhealthy.length === 1 ? `${s.unhealthy[0].service || s.unhealthy[0].name} sick` : `${s.unhealthy.length} unhealthy`;
  if (s.starting.length) return `${s.starting.length} starting`;
  return s.watched.length ? "all up" : "no containers";
}

function containerState(c) {
  if (!c) return { word: "MISSING", color: GREY };
  if (ignored().has(c.name) && c.state !== "running") return { word: "STOPPED", color: GREY };
  if (c.state === "restarting") return { word: "RESTARTING", color: BLUE };
  if (c.state !== "running") return { word: c.state === "paused" ? "PAUSED" : "STOPPED", color: RED };
  if (c.health === "unhealthy") return { word: "UNHEALTHY", color: AMBER };
  if (c.health === "starting") return { word: "STARTING", color: BLUE };
  return { word: "UP", color: GREEN };
}

// "Up 3 hours (healthy)" -> "3 hours"; "Exited (137) 2 days ago" -> "2 days ago"
const age = (c) => (c?.status || "").replace(/\s*\(.*?\)\s*/g, " ").replace(/^(Up|Exited|Created|Restarting)\s*/i, "").trim();

function placeholder() {
  if (!globals || (!data.list && !data.error)) return "…";
  if (!data.list) return data.error;
  return null;
}

const keyOpen = (title, color) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144"><rect width="144" height="144" fill="#141414"/>${color ? `<rect width="144" height="6" fill="${color}"/>` : ""}<text x="72" y="30" ${FONT} font-size="16" font-weight="600" text-anchor="middle" fill="${TEXT}">${esc(trunc(title, 15))}</text>`;
const stripOpen = (title, color) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="200" height="100" fill="#141414"/>${color ? `<rect width="4" height="100" fill="${color}"/>` : ""}<text x="10" y="22" ${FONT} font-size="16" font-weight="600" fill="${TEXT}">${esc(trunc(title, 20))}</text>`;
const busyKey = (title, busy) => `${keyOpen(title, BLUE)}<text x="72" y="86" ${FONT} font-size="18" font-weight="700" text-anchor="middle" fill="${BLUE}">${busy}…</text></svg>`;

function stackKey(inst) {
  const name = inst.settings.stack || "";
  const title = inst.settings.label || name || "stack";
  if (inst.busy) return busyKey(title, inst.busy);
  const text = placeholder() || (!name ? "pick a stack" : null);
  if (text) return `${keyOpen(title)}<text x="72" y="86" ${FONT} font-size="18" text-anchor="middle" fill="${GREY}">${esc(text)}</text></svg>`;
  const s = summary(stackContainers(name));
  const color = summaryColor(s);
  return `${keyOpen(title, color)}
<text x="72" y="90" ${FONT} font-size="40" font-weight="700" text-anchor="middle" fill="${color}">${s.running}/${s.watched.length}</text>
<text x="72" y="128" ${FONT} font-size="15" text-anchor="middle" fill="${SOFT}">${esc(trunc(summaryDetail(s), 17))}</text>
</svg>`;
}

function containerKey(inst) {
  const name = inst.settings.container || "";
  const title = inst.settings.label || name || "container";
  if (inst.busy) return busyKey(title, inst.busy);
  const text = placeholder() || (!name ? "pick one" : null);
  if (text) return `${keyOpen(title)}<text x="72" y="86" ${FONT} font-size="18" text-anchor="middle" fill="${GREY}">${esc(text)}</text></svg>`;
  const c = findContainer(name);
  const st = containerState(c);
  return `${keyOpen(title, st.color)}
<text x="72" y="84" ${FONT} font-size="${st.word.length > 8 ? 19 : 26}" font-weight="700" text-anchor="middle" fill="${st.color}">${st.word}</text>
<text x="72" y="122" ${FONT} font-size="15" text-anchor="middle" fill="${SOFT}">${esc(trunc(age(c), 17))}</text>
</svg>`;
}

function overviewKey(inst) {
  const title = inst.settings.label || "docker";
  const text = placeholder();
  if (text) return `${keyOpen(title)}<text x="72" y="86" ${FONT} font-size="18" text-anchor="middle" fill="${GREY}">${esc(text)}</text></svg>`;
  const s = summary(data.list);
  const cell = (x, y, n, label, color) => `<text x="${x}" y="${y}" ${FONT} font-size="30" font-weight="700" text-anchor="middle" fill="${n ? color : GREY}">${n}</text><text x="${x}" y="${y + 15}" ${FONT} font-size="12" text-anchor="middle" fill="${DIM}">${label}</text>`;
  return `${keyOpen(title, summaryColor(s))}
${cell(72, 72, s.running, "running", GREEN)}
${cell(36, 118, s.down.length, "down", RED)}
${cell(108, 118, s.unhealthy.length, "unhealthy", AMBER)}
</svg>`;
}

// Stack dial: position 0 is the whole stack, then each of its containers.
function stackSelection(inst) {
  const list = stackContainers(inst.settings.stack || "");
  const i = Math.min(list.length, Math.max(0, inst.cursor || 0));
  inst.cursor = i;
  return { list, i, container: i ? list[i - 1] : null };
}

function stackStrip(inst) {
  const name = inst.settings.stack || "";
  const title = inst.settings.label || name || "stack";
  const text = inst.busy ? `${inst.busy}…` : placeholder() || (!name ? "pick a stack" : null);
  if (text) return `${stripOpen(title, inst.busy ? BLUE : null)}<text x="100" y="66" ${FONT} font-size="18" text-anchor="middle" fill="${inst.busy ? BLUE : GREY}">${esc(text)}</text></svg>`;
  const s = summary(stackContainers(name));
  const { list, i, container } = stackSelection(inst);
  const color = summaryColor(s);
  const line = container
    ? `<text x="10" y="58" ${FONT} font-size="16" fill="${SOFT}">${esc(trunc(container.service || container.name, 13))}</text><text x="194" y="58" ${FONT} font-size="14" font-weight="700" text-anchor="end" fill="${containerState(container).color}">${containerState(container).word}</text>`
    : `<text x="10" y="58" ${FONT} font-size="16" fill="${SOFT}">whole stack</text><text x="194" y="58" ${FONT} font-size="14" text-anchor="end" fill="${color}">${esc(trunc(summaryDetail(s), 14))}</text>`;
  return `${stripOpen(title, color)}
<text x="194" y="22" ${FONT} font-size="16" font-weight="700" text-anchor="end" fill="${color}">${s.running}/${s.watched.length}</text>
${line}
<text x="10" y="90" ${FONT} font-size="12" fill="${DIM}">${pressToggles(inst) ? "press: start/stop" : "hold: restart"}</text>
<text x="194" y="90" ${FONT} font-size="12" text-anchor="end" fill="${DIM}">${i ? `${i}/${list.length}` : "all"}</text>
</svg>`;
}

function containerStrip(inst) {
  const name = inst.settings.container || "";
  const title = inst.settings.label || name || "container";
  const text = inst.busy ? `${inst.busy}…` : placeholder() || (!name ? "pick one" : null);
  if (text) return `${stripOpen(title, inst.busy ? BLUE : null)}<text x="100" y="66" ${FONT} font-size="18" text-anchor="middle" fill="${inst.busy ? BLUE : GREY}">${esc(text)}</text></svg>`;
  const c = findContainer(name);
  const st = containerState(c);
  return `${stripOpen(title, st.color)}
<text x="10" y="62" ${FONT} font-size="24" font-weight="700" fill="${st.color}">${st.word}</text>
<text x="10" y="90" ${FONT} font-size="13" fill="${SOFT}">${esc(trunc(age(c), 26))}</text>
</svg>`;
}

function overviewStrip(inst) {
  const title = inst.settings.label || "docker";
  const text = placeholder();
  if (text) return `${stripOpen(title)}<text x="100" y="66" ${FONT} font-size="18" text-anchor="middle" fill="${GREY}">${esc(text)}</text></svg>`;
  const s = summary(data.list);
  const cell = (x, n, label, color) => `<text x="${x}" y="66" ${FONT} font-size="28" font-weight="700" text-anchor="middle" fill="${n ? color : GREY}">${n}</text><text x="${x}" y="88" ${FONT} font-size="12" text-anchor="middle" fill="${DIM}">${label}</text>`;
  return `${stripOpen(title, summaryColor(s))}${cell(40, s.running, "running", GREEN)}${cell(105, s.down.length, "down", RED)}${cell(165, s.unhealthy.length, "unhealthy", AMBER)}</svg>`;
}

const DRAW = {
  stack: { key: stackKey, strip: stackStrip },
  container: { key: containerKey, strip: containerStrip },
  overview: { key: overviewKey, strip: overviewStrip },
};

// --------------------------------------------------------------------------- instances

const instances = new Map(); // context -> { action, controller, settings, cursor, busy, holdTimer, held }
const lastImage = new Map();

const kindOf = (inst) => inst.action.slice(args.pluginUUID.length + 1);

function draw(context) {
  const inst = instances.get(context);
  const kind = inst && DRAW[kindOf(inst)];
  if (!kind) return;
  const image = svgUri(inst.controller === "Encoder" ? kind.strip(inst) : kind.key(inst));
  if (lastImage.get(context) === image) return;
  lastImage.set(context, image);
  send({ event: "setImage", context, payload: { image } });
}

function drawAll() {
  for (const context of instances.keys()) draw(context);
}

let ticker = null;

function startTicking() {
  if (ticker) return;
  ticker = setInterval(() => {
    if (globals && Date.now() - data.fetchedAt >= intervalMs()) refresh();
  }, TICK_MS);
}

function stopTicking() {
  clearInterval(ticker);
  ticker = null;
}

// The containers a stack or container button acts on, or null.
function target(inst) {
  const kind = kindOf(inst);
  if (kind === "container") {
    const c = findContainer(inst.settings.container || "");
    return c && { label: c.name, list: [c] };
  }
  if (kind === "stack") {
    const { list, container } = inst.controller === "Encoder" ? stackSelection(inst) : { list: stackContainers(inst.settings.stack || "") };
    if (container) return { label: container.name, list: [container] };
    return list.length ? { label: `stack ${inst.settings.stack}`, list } : null;
  }
  return null;
}

// Pressing starts or stops unless the button is set to refresh; the overview only refreshes.
const pressToggles = (inst) => kindOf(inst) !== "overview" && (inst.settings.press || "toggle") === "toggle";

// The Portainer container the plugin connects through: stopping it would cut the plugin off.
const isOwnPortainer = (c) => Boolean(globals?.token) && /(^|\/)portainer\/(portainer|portainer-ce|portainer-ee)(:|@|$)/.test(c.image);

async function act(context, what) {
  const inst = instances.get(context);
  if (!inst || inst.busy) return;
  const t = data.list && target(inst);
  if (!t) return send({ event: "showAlert", context });
  const all = data.list;
  let run, word;
  if (what === "restart") {
    [run, word] = [() => docker.restartAll(conn, t.list, all), "restarting"];
  } else if (t.list.some((c) => c.state === "running" || c.state === "restarting")) {
    const list = t.list.filter((c) => !isOwnPortainer(c));
    if (!list.length) return send({ event: "showAlert", context });
    [run, word] = [() => docker.stopAll(conn, list, all), "stopping"];
  } else {
    [run, word] = [() => docker.startAll(conn, t.list, all), "starting"];
  }
  inst.busy = word;
  draw(context);
  log(`${word} ${t.label}`);
  let ok = true;
  try {
    await run();
  } catch (e) {
    ok = false;
    log(`${word} ${t.label}: ${e.message}`);
  }
  inst.busy = null;
  await refresh();
  send({ event: ok ? "showOk" : "showAlert", context });
}

async function tap(context) {
  const inst = instances.get(context);
  if (inst && pressToggles(inst)) return act(context, "toggle");
  await refresh();
  send({ event: data.error ? "showAlert" : "showOk", context });
}

const hold = (context) => act(context, "restart");

// A press starts a timer; letting go before it fires is a tap, holding past it restarts.
function down(context) {
  const inst = instances.get(context);
  if (!inst) return;
  clearTimeout(inst.holdTimer);
  inst.held = false;
  inst.holdTimer = setTimeout(() => { inst.held = true; hold(context); }, HOLD_MS);
}

function up(context) {
  const inst = instances.get(context);
  if (!inst) return;
  clearTimeout(inst.holdTimer);
  if (!inst.held) tap(context);
  inst.held = false;
}

function remember(msg) {
  const inst = instances.get(msg.context) || { cursor: 0 };
  const before = inst.settings && JSON.stringify(inst.settings);
  inst.action = msg.action;
  inst.controller = msg.payload?.controller || inst.controller || "Keypad";
  inst.settings = msg.payload?.settings || {};
  if (before && before !== JSON.stringify(inst.settings)) inst.cursor = 0;
  instances.set(msg.context, inst);
  return inst;
}

// The settings panel asks for the stack and container names to offer.
function sendNames(context) {
  send({
    event: "sendToPropertyInspector",
    context,
    payload: { stacks: stackNames(), containers: (data.list || []).map((c) => c.name).sort(), error: data.list ? null : data.error },
  });
}

// --------------------------------------------------------------------------- events

function handle(msg) {
  switch (msg.event) {
    case "willAppear":
      remember(msg);
      lastImage.delete(msg.context);
      draw(msg.context);
      if (!data.fetchedAt) refresh();
      startTicking();
      break;
    case "willDisappear": {
      const inst = instances.get(msg.context);
      if (inst) clearTimeout(inst.holdTimer);
      instances.delete(msg.context);
      lastImage.delete(msg.context);
      if (!instances.size) stopTicking();
      break;
    }
    case "didReceiveSettings":
      remember(msg);
      draw(msg.context);
      break;
    case "keyDown":
    case "dialDown":
      remember(msg);
      down(msg.context);
      break;
    case "keyUp":
    case "dialUp":
      remember(msg);
      up(msg.context);
      break;
    case "touchTap":
      remember(msg);
      tap(msg.context);
      break;
    case "dialRotate": {
      const inst = remember(msg);
      if (kindOf(inst) === "stack") {
        inst.cursor = (inst.cursor || 0) + (msg.payload?.ticks || 0);
        draw(msg.context);
      }
      break;
    }
    case "sendToPlugin":
      if (msg.payload?.request === "names") {
        if (data.list) sendNames(msg.context);
        else refresh().then(() => sendNames(msg.context));
      }
      break;
    case "didReceiveGlobalSettings":
      globals = msg.payload?.settings || {};
      connectionFor();
      refresh();
      break;
  }
}
