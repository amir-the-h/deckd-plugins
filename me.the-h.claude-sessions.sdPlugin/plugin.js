// Claude Code Sessions: what each running Claude Code session is doing (working, needs you, done),
// from the state files its hook writes (hooks/session-state.sh). Node >= 22, no deps.
//
//   session   one session: its project, state and how long it has been in it. Press to bring it up.
//   overview  how many sessions need you, are working or are done. Press to bring up the one that
//             has needed you longest (else the one done longest ago).
//
// Bringing a session up selects its tmux window and pane (when it runs in tmux) and focuses the
// terminal window on Hyprland. On a dial, turn to step through sessions and push to bring one up.

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

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

// --------------------------------------------------------------------------- sessions

// Must match the folder in hooks/session-state.sh.
const STATE_DIR = process.env.XDG_RUNTIME_DIR
  ? path.join(process.env.XDG_RUNTIME_DIR, "claude-deck-sessions")
  : `/tmp/claude-deck-sessions-${process.getuid()}`;

const HOME = process.env.HOME || "";
const DEFAULT_ACCOUNT = path.join(HOME, ".claude");

let sessions = []; // sorted by when they started

// A session whose process is gone (crashed, killed, or a machine restart without SessionEnd) is
// dropped and its file removed.
function alive(s) {
  if (!s.pid) return true;
  try {
    const stat = fs.readFileSync(`/proc/${s.pid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return !s.pidStart || start === String(s.pidStart);
  } catch (e) {
    return e.code !== "ENOENT"; // no /proc (macOS): keep it
  }
}

function scan() {
  let names = [];
  try {
    names = fs.readdirSync(STATE_DIR).filter((n) => n.endsWith(".json"));
  } catch {}
  const found = [];
  for (const name of names) {
    const file = path.join(STATE_DIR, name);
    let s;
    try {
      s = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue; // being written
    }
    if (!alive(s)) {
      fs.rm(file, { force: true }, () => {});
      continue;
    }
    found.push(s);
  }
  sessions = found.sort((a, b) => a.started - b.started || a.session.localeCompare(b.session));
  locateTmux();
}

// "session:window" for sessions in tmux, looked up in the background (tmux can move panes around).
const tmuxLabels = new Map(); // "socket pane" -> label
let locating = false;

async function locateTmux() {
  if (locating) return;
  locating = true;
  try {
    const seen = new Set();
    for (const s of sessions) {
      if (!s.tmux || !s.tmuxPane) continue;
      const socket = s.tmux.split(",")[0], k = `${socket} ${s.tmuxPane}`;
      seen.add(k);
      const out = await run("tmux", ["-S", socket, "display-message", "-p", "-t", s.tmuxPane, "#{session_name}:#{window_index}"]);
      const label = out?.trim() || null;
      if (tmuxLabels.get(k) !== label) { tmuxLabels.set(k, label); drawAll(); }
    }
    for (const k of tmuxLabels.keys()) if (!seen.has(k)) tmuxLabels.delete(k);
  } finally {
    locating = false;
  }
}

let watcher = null;
let rescan = null;

function watch() {
  if (watcher) return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    watcher = fs.watch(STATE_DIR, () => {
      clearTimeout(rescan);
      rescan = setTimeout(() => { scan(); drawAll(); }, 80);
    });
    watcher.on("error", () => { watcher = null; });
  } catch (e) {
    log(`can't watch ${STATE_DIR}: ${e.message}`);
  }
}

const accountOf = (s) => s.account || DEFAULT_ACCOUNT;
const sameDir = (a, b) => path.resolve(a.replace(/^~(?=$|\/)/, HOME)) === path.resolve(b.replace(/^~(?=$|\/)/, HOME));
const listFor = (inst) => (inst.settings.account ? sessions.filter((s) => sameDir(accountOf(s), inst.settings.account)) : sessions);

// --------------------------------------------------------------------------- bringing a session up

const run = (cmd, argv) => new Promise((resolve) => {
  execFile(cmd, argv, { timeout: 3000 }, (err, stdout) => resolve(err ? null : stdout));
});

function ancestors(pid) {
  const out = [];
  for (let p = Number(pid); p > 1 && out.length < 64; ) {
    out.push(p);
    try {
      p = Number(/^PPid:\s*(\d+)/m.exec(fs.readFileSync(`/proc/${p}/status`, "utf8"))[1]);
    } catch {
      break;
    }
  }
  return out;
}

// Select the session's tmux pane, switching an attached client to it if needed. Returns the pid of the
// tmux client showing it (whose terminal window is the one to focus), or null.
async function selectTmux(s) {
  if (!s.tmux || !s.tmuxPane) return null;
  const socket = s.tmux.split(",")[0];
  const tmux = (...a) => run("tmux", ["-S", socket, ...a]);
  const target = await tmux("display-message", "-p", "-t", s.tmuxPane, "#{session_name}");
  if (target === null) return null; // pane or server gone
  const name = target.trim();
  const clients = ((await tmux("list-clients", "-F", "#{client_pid}\t#{client_name}\t#{session_name}\t#{client_activity}")) || "")
    .trim().split("\n").filter(Boolean)
    .map((l) => { const [pid, client, session, activity] = l.split("\t"); return { pid: Number(pid), client, session, activity: Number(activity) }; });
  const client = clients.find((c) => c.session === name) || clients.sort((a, b) => b.activity - a.activity)[0];
  if (client && client.session !== name) await tmux("switch-client", "-c", client.client, "-t", s.tmuxPane);
  await tmux("select-window", "-t", s.tmuxPane);
  await tmux("select-pane", "-t", s.tmuxPane);
  return client ? client.pid : null;
}

// Focus the Hyprland window that owns one of these processes. Tries the Lua config's dispatcher first,
// then the classic one.
async function focusWindow(pids) {
  const out = await run("hyprctl", ["clients", "-j"]);
  if (!out) return false;
  let clients;
  try { clients = JSON.parse(out); } catch { return false; }
  const set = new Set(pids);
  const win = clients.find((c) => set.has(c.pid));
  if (!win) return false;
  if (win.workspace?.name?.startsWith("special")) {
    // A window on a hidden special workspace only shows once that workspace is toggled on.
    const monitors = JSON.parse((await run("hyprctl", ["monitors", "-j"])) || "[]");
    const shown = monitors.some((m) => m.specialWorkspace?.name === win.workspace.name);
    if (!shown) {
      const special = win.workspace.name.replace(/^special:?/, "");
      const lua = await run("hyprctl", ["dispatch", `hl.dsp.workspace.toggle_special(${special ? JSON.stringify(special) : ""})`]);
      if (!lua || !/ok/i.test(lua)) await run("hyprctl", ["dispatch", "togglespecialworkspace", special]);
    }
  }
  const lua = await run("hyprctl", ["dispatch", `hl.dsp.focus({ window = "address:${win.address}" })`]);
  if (lua && /ok/i.test(lua)) return true;
  const classic = await run("hyprctl", ["dispatch", "focuswindow", `address:${win.address}`]);
  return Boolean(classic && /ok/i.test(classic));
}

async function bringUp(s) {
  const client = await selectTmux(s);
  const pids = [...ancestors(client || s.pid)];
  if (s.kittyListen && s.kittyWindow) await run("kitten", ["@", "--to", s.kittyListen, "focus-window", "--match", `id:${s.kittyWindow}`]);
  const focused = await focusWindow(pids);
  return focused || client !== null;
}

// --------------------------------------------------------------------------- drawing

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const svgUri = (svg) => "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
const FONT = `font-family="Inter, 'Noto Sans', sans-serif"`;
const RED = "#e05a5a", AMBER = "#e0a030", GREEN = "#4caf7d", BLUE = "#5aa9e6";
const GREY = "#555", TEXT = "#f2f2f2", DIM = "#9a9a9a", SOFT = "#d8d8d8";

const STATES = {
  waiting: { word: "NEEDS YOU", short: "needs you", color: AMBER },
  working: { word: "WORKING", short: "working", color: BLUE },
  done: { word: "DONE", short: "done", color: GREEN },
  idle: { word: "IDLE", short: "idle", color: DIM },
  error: { word: "ERROR", short: "error", color: RED },
};
const stateOf = (s) => STATES[s.state] || STATES.idle;

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function ago(sec) {
  if (sec < 60) return `${Math.max(0, Math.floor(sec))}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d`;
}

// Project folder name, plus where it runs when two sessions share a folder.
function nameOf(s, list) {
  const base = path.basename(s.cwd || "") || "~";
  if (list.filter((o) => o.cwd === s.cwd).length < 2) return base;
  return `${base} ${where(s) || "#" + s.session.slice(0, 4)}`;
}

let blink = false; // flips each second while a session needs you
const waitingColor = () => (blink ? RED : AMBER);
const colorOf = (s) => (s.state === "waiting" ? waitingColor() : stateOf(s).color);

const position = (inst) => Math.max(1, Math.floor(Number(inst.settings.position) || 1));

// The session a button shows: its position in the list, moved by dial turns (clamped at the ends).
function shown(inst, list) {
  if (!list.length) return -1;
  const base = Math.min(list.length - 1, position(inst) - 1);
  if (inst.controller !== "Encoder" && position(inst) > list.length) return -1;
  const i = Math.min(list.length - 1, Math.max(0, base + (inst.cursor || 0)));
  inst.cursor = i - base;
  return i;
}

function sessionKey(inst, now) {
  const list = listFor(inst);
  const s = list[shown(inst, list)];
  const open = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144"><rect width="144" height="144" fill="#141414"/>`;
  if (!s) return `${open}<text x="72" y="22" ${FONT} font-size="14" font-weight="600" letter-spacing="1.5" text-anchor="middle" fill="${DIM}">${esc(trunc((inst.settings.label || "CLAUDE").toUpperCase(), 14))}</text><text x="72" y="84" ${FONT} font-size="20" text-anchor="middle" fill="${GREY}">no session</text></svg>`;
  const st = stateOf(s), color = colorOf(s);
  const word = st.word.length > 8 ? 20 : 24;
  return `${open}
<rect x="0" y="0" width="144" height="6" fill="${color}"/>
<text x="72" y="32" ${FONT} font-size="16" font-weight="600" text-anchor="middle" fill="${TEXT}">${esc(trunc(inst.settings.label || nameOf(s, list), 15))}</text>
<text x="72" y="82" ${FONT} font-size="${word}" font-weight="700" text-anchor="middle" fill="${color}">${esc(st.word)}</text>
<text x="72" y="112" ${FONT} font-size="16" text-anchor="middle" fill="${SOFT}">${esc(ago(now - s.since))}</text>
<text x="72" y="136" ${FONT} font-size="13" text-anchor="middle" fill="${DIM}">${esc(trunc(where(s), 18))}</text>
</svg>`;
}

// "work:4" style tmux location, else the account folder when it isn't the default.
function where(s) {
  const label = s.tmux && tmuxLabels.get(`${s.tmux.split(",")[0]} ${s.tmuxPane}`);
  if (label) return label;
  return accountOf(s) === DEFAULT_ACCOUNT ? "" : path.basename(accountOf(s));
}

function sessionStrip(inst, now) {
  const list = listFor(inst);
  const i = shown(inst, list);
  const s = list[i];
  const open = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="200" height="100" fill="#141414"/>`;
  if (!s) return `${open}<text x="6" y="18" ${FONT} font-size="13" font-weight="600" letter-spacing="1.2" fill="${DIM}">${esc(trunc((inst.settings.label || "CLAUDE").toUpperCase(), 16))}</text><text x="100" y="64" ${FONT} font-size="20" text-anchor="middle" fill="${GREY}">no session</text></svg>`;
  const st = stateOf(s), color = colorOf(s);
  return `${open}
<rect x="0" y="0" width="4" height="100" fill="${color}"/>
<text x="10" y="22" ${FONT} font-size="16" font-weight="600" fill="${TEXT}">${esc(trunc(nameOf(s, list), 20))}</text>
<text x="10" y="56" ${FONT} font-size="22" font-weight="700" fill="${color}">${esc(st.word)}</text>
<text x="194" y="56" ${FONT} font-size="15" text-anchor="end" fill="${SOFT}">${esc(ago(now - s.since))}</text>
<text x="10" y="90" ${FONT} font-size="13" fill="${DIM}">${esc(trunc(where(s), 22))}</text>
<text x="194" y="90" ${FONT} font-size="13" text-anchor="end" fill="${DIM}">${i + 1}/${list.length}</text>
</svg>`;
}

const counts = (list) => ({
  waiting: list.filter((s) => s.state === "waiting").length,
  working: list.filter((s) => s.state === "working").length,
  done: list.filter((s) => s.state === "done").length,
});

function overviewKey(inst) {
  const list = listFor(inst);
  const c = counts(list);
  const cell = (x, y, n, label, color) => `<text x="${x}" y="${y}" ${FONT} font-size="30" font-weight="700" text-anchor="middle" fill="${n ? color : GREY}">${n}</text><text x="${x}" y="${y + 15}" ${FONT} font-size="12" text-anchor="middle" fill="${DIM}">${label}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144"><rect width="144" height="144" fill="#141414"/>
${c.waiting ? `<rect x="0" y="0" width="144" height="6" fill="${waitingColor()}"/>` : ""}
<text x="72" y="26" ${FONT} font-size="14" font-weight="600" letter-spacing="1.5" text-anchor="middle" fill="${DIM}">${esc(trunc((inst.settings.label || "CLAUDE").toUpperCase(), 14))}</text>
${cell(72, 70, c.waiting, "need you", waitingColor())}
${cell(36, 116, c.working, "working", BLUE)}
${cell(108, 116, c.done, "done", GREEN)}
</svg>`;
}

// Up to three sessions as rows; turning moves the highlighted one.
function overviewStrip(inst, now) {
  const list = listFor(inst);
  const open = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="200" height="100" fill="#141414"/>`;
  if (!list.length) return `${open}<text x="6" y="18" ${FONT} font-size="13" font-weight="600" letter-spacing="1.2" fill="${DIM}">${esc(trunc((inst.settings.label || "CLAUDE").toUpperCase(), 16))}</text><text x="100" y="64" ${FONT} font-size="20" text-anchor="middle" fill="${GREY}">no sessions</text></svg>`;
  const i = shown(inst, list);
  const first = Math.max(0, Math.min(i - 1, list.length - 3));
  const rows = list.slice(first, first + 3).map((s, j) => {
    const y = 8 + j * 31, sel = first + j === i;
    return `${sel ? `<rect x="0" y="${y - 4}" width="200" height="30" fill="#262626"/>` : ""}
<circle cx="12" cy="${y + 11}" r="5" fill="${colorOf(s)}"/>
<text x="24" y="${y + 16}" ${FONT} font-size="15" font-weight="${sel ? 700 : 400}" fill="${sel ? TEXT : SOFT}">${esc(trunc(nameOf(s, list), 13))}</text>
<text x="194" y="${y + 16}" ${FONT} font-size="13" text-anchor="end" fill="${colorOf(s)}">${esc(stateOf(s).short)} ${esc(ago(now - s.since))}</text>`;
  });
  return `${open}${rows.join("\n")}</svg>`;
}

// --------------------------------------------------------------------------- instances

const instances = new Map(); // context -> { action, controller, settings, cursor }
const lastImage = new Map();

const kindOf = (inst) => inst.action.slice(args.pluginUUID.length + 1);

function draw(context, now = Date.now() / 1000) {
  const inst = instances.get(context);
  if (!inst) return;
  const dial = inst.controller === "Encoder";
  const svg = kindOf(inst) === "overview" ? (dial ? overviewStrip(inst, now) : overviewKey(inst)) : (dial ? sessionStrip(inst, now) : sessionKey(inst, now));
  const image = svgUri(svg);
  if (lastImage.get(context) === image) return;
  lastImage.set(context, image);
  send({ event: "setImage", context, payload: { image } });
}

function drawAll() {
  const now = Date.now() / 1000;
  for (const context of instances.keys()) draw(context, now);
}

let ticker = null;
let ticks = 0;

function startTicking() {
  if (ticker) return;
  watch();
  scan();
  ticker = setInterval(() => {
    blink = !blink && sessions.some((s) => s.state === "waiting");
    if (++ticks % 5 === 0) scan(); // catches exits that never ran SessionEnd
    drawAll();
  }, 1000);
}

function stopTicking() {
  clearInterval(ticker);
  ticker = null;
  watcher?.close();
  watcher = null;
}

// The overview key brings up the session that has needed you longest, else the one done longest ago.
function overviewTarget(list) {
  const oldest = (state) => list.filter((s) => s.state === state).sort((a, b) => a.since - b.since)[0];
  return oldest("waiting") || oldest("done") || oldest("error") || null;
}

async function press(context) {
  const inst = instances.get(context);
  if (!inst) return;
  const list = listFor(inst);
  const s = kindOf(inst) === "overview" && inst.controller !== "Encoder" ? overviewTarget(list) : list[shown(inst, list)];
  if (!s) return send({ event: "showAlert", context });
  const ok = await bringUp(s);
  if (!ok) send({ event: "showAlert", context });
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

// --------------------------------------------------------------------------- events

function handle(msg) {
  switch (msg.event) {
    case "willAppear":
      remember(msg);
      lastImage.delete(msg.context);
      startTicking();
      draw(msg.context);
      break;
    case "willDisappear":
      instances.delete(msg.context);
      lastImage.delete(msg.context);
      if (!instances.size) stopTicking();
      break;
    case "didReceiveSettings":
      remember(msg);
      draw(msg.context);
      break;
    case "keyUp":
    case "dialDown":
    case "touchTap":
      remember(msg);
      press(msg.context);
      break;
    case "dialRotate": {
      const inst = remember(msg);
      inst.cursor = (inst.cursor || 0) + (msg.payload?.ticks || 0);
      draw(msg.context);
      break;
    }
  }
}
