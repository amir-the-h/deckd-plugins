// Hyprland Shader — cycle or toggle Hyprland screen shaders from a Stream Deck (Node >= 22, no deps).
//
// Shaders are `.glsl` files in ~/.config/hypr/shaders (or its `animated/` folder). One action, two modes:
//   * dial:   turning picks a shader from the folder; pushing (or a key press / strip tap) turns it on or off.
//   * toggle: one fixed shader; press to turn it on or off.
// Shaders are applied with `hyprctl eval 'hl.config{...}'`, since the Lua config parser rejects
// `hyprctl keyword`; `keyword` is tried as a fallback for legacy (hyprlang) configs.

// --------------------------------------------------------------------------- startup

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

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

// --------------------------------------------------------------------------- shaders

const EXCLUDE = new Set(["test-passthrough.glsl", "common.glsl"]);
const POLL_MS = 4_000;

function shadersDir(folder) {
  const base = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "hypr/shaders");
  return !folder || folder.includes("..") ? base : path.join(base, folder);
}

/** Sorted [{ name, path }] for a shader folder. */
function listShaders(folder) {
  let names;
  try {
    names = fs.readdirSync(shadersDir(folder));
  } catch {
    return [];
  }
  return names
    .filter((f) => f.endsWith(".glsl") && !EXCLUDE.has(f))
    .map((f) => ({ name: f.slice(0, -5), path: path.join(shadersDir(folder), f) }))
    .filter((s) => fs.existsSync(s.path)) // also skips broken symlinks
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function hyprctl(...argv) {
  return new Promise((resolve) => {
    execFile("hyprctl", argv, { timeout: 3_000 }, (err, stdout) => resolve(err && !stdout ? null : String(stdout).trim()));
  });
}

/** The active screen shader path, "" when none, or null if Hyprland didn't answer. */
async function activeShader() {
  const out = await hyprctl("getoption", "decoration:screen_shader");
  if (out == null) return null;
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^str:\s*(.*)$/);
    if (m) return ["[[EMPTY]]", "UNSET", ""].includes(m[1].trim()) ? "" : m[1].trim();
  }
  return "";
}

async function setOption(section, key, value, isString) {
  const lua = isString ? `[==[${value}]==]` : value;
  const out = (await hyprctl("eval", `hl.config({ ${section} = { ${key} = ${lua} } })`)) || "";
  // Legacy (hyprlang) configs don't have eval.
  if (out.includes("unknown request") || out.includes("Invalid")) {
    await hyprctl("keyword", `${section}:${key}`, isString && !value ? "[[EMPTY]]" : value);
  }
}

/** Applies a shader, or clears it when `file` is empty. */
async function applyShader(file) {
  if (!file) {
    await setOption("decoration", "screen_shader", "", true);
    // 2 = full damage tracking, Hyprland's default.
    await setOption("debug", "damage_tracking", "2", false);
  } else {
    // Screen shaders only re-composite damaged regions, so static layers keep
    // unshaded pixels; full redraws keep the whole output shaded.
    await setOption("debug", "damage_tracking", "0", false);
    await setOption("decoration", "screen_shader", file, true);
  }
}

// --------------------------------------------------------------------------- state

const instances = new Map(); // context -> { controller, settings }
const lastImage = new Map(); // context -> data URI, to skip redundant redraws
let active = null; // active shader path once known
let poll = null;

function remember(msg) {
  const inst = instances.get(msg.context) || {};
  inst.controller = msg.payload?.controller || inst.controller || "Keypad";
  inst.settings = msg.payload?.settings || {};
  instances.set(msg.context, inst);
  return inst;
}

/** { mode, folder, index, shader } with the built-in defaults. */
function settingsOf(inst) {
  const s = inst.settings;
  return { mode: s.mode === "toggle" ? "toggle" : "dial", folder: s.folder || "", index: Number(s.index) || 0, shader: s.shader || "" };
}

async function refresh() {
  const now = await activeShader();
  if (now == null || now === active) return;
  active = now;
  for (const context of instances.keys()) draw(context);
}

function startPolling() {
  if (!poll) poll = setInterval(refresh, POLL_MS);
}

function stopPollingIfIdle() {
  if (poll && instances.size === 0) {
    clearInterval(poll);
    poll = null;
  }
}

async function toggle(file) {
  const target = active === file ? "" : file;
  // Show the result straight away; the follow-up query confirms it.
  active = target;
  for (const context of instances.keys()) draw(context);
  await applyShader(target);
  await refresh();
}

/** The shader an input acts on, or null. */
function selected(inst) {
  const s = settingsOf(inst);
  if (s.mode === "toggle") return s.shader || null;
  const list = listShaders(s.folder);
  return list.length ? list[s.index % list.length].path : null;
}

// --------------------------------------------------------------------------- drawing

const FONT = `font-family="sans-serif"`;
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const svgUri = (svg) => "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");

/** Name, ON/OFF and position, coloured like the original StreamController plugin. */
function view(inst) {
  const s = settingsOf(inst);
  if (s.mode === "dial") {
    const list = listShaders(s.folder);
    if (!list.length) return { top: ["No shaders", "#b45050"] };
    const i = s.index % list.length;
    return shaderView(list[i].name, list[i].path, `${i + 1} / ${list.length}`, s.folder);
  }
  if (!s.shader) return { top: ["No shader", "#969696"], center: ["configure", "#646464", 16] };
  return shaderView(path.basename(s.shader, ".glsl"), s.shader, "shader", s.folder);
}

function shaderView(name, file, counter, folder) {
  const accent = folder === "animated" ? ["#50b4ff", "#00b4ff"] : ["#50dc50", "#00f000"];
  const on = active === file;
  return {
    top: [name.replace(/[-_]/g, " ").slice(0, 18), on ? accent[0] : "#d2d2d2"],
    center: [on ? "ON" : "OFF", on ? accent[1] : "#a0a0a0", 22],
    bottom: [counter, "#6e6e6e"],
  };
}

function render(inst) {
  const v = view(inst);
  const [w, h] = inst.controller === "Encoder" ? [200, 100] : [144, 144];
  const text = (line, y, size) =>
    line ? `<text x="${w / 2}" y="${y}" ${FONT} font-size="${line[2] || size}" font-weight="700" text-anchor="middle" fill="${line[1]}">${esc(line[0])}</text>` : "";
  const scale = h / 100;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" fill="#141414"/>
${text(v.top, 26 * scale, 15 * Math.min(scale, 1.2))}
${text(v.center && [v.center[0], v.center[1], v.center[2] * Math.min(scale, 1.3)], 60 * scale, 22)}
${text(v.bottom, 90 * scale, 14 * Math.min(scale, 1.2))}
</svg>`;
}

function draw(context) {
  const inst = instances.get(context);
  if (!inst) return;
  const image = svgUri(render(inst));
  if (lastImage.get(context) === image) return;
  lastImage.set(context, image);
  send({ event: "setImage", context, payload: { image } });
}

// --------------------------------------------------------------------------- events

function handle(msg) {
  switch (msg.event) {
    case "willAppear":
      remember(msg);
      lastImage.delete(msg.context);
      draw(msg.context);
      startPolling();
      refresh();
      break;
    case "willDisappear":
      instances.delete(msg.context);
      lastImage.delete(msg.context);
      stopPollingIfIdle();
      break;
    case "didReceiveSettings":
      remember(msg);
      draw(msg.context);
      break;

    case "dialRotate": {
      const inst = remember(msg);
      const s = settingsOf(inst);
      const n = listShaders(s.folder).length;
      if (s.mode !== "dial" || !n) break;
      inst.settings = { ...inst.settings, index: (((s.index + msg.payload.ticks) % n) + n) % n };
      send({ event: "setSettings", context: msg.context, payload: inst.settings });
      draw(msg.context);
      break;
    }
    case "keyUp": // act on release, so tap/hold triggers configured in deckd behave naturally
    case "dialDown":
    case "touchTap": {
      const file = selected(remember(msg));
      if (file) toggle(file);
      break;
    }

    case "sendToPlugin": // the settings panel asks for a folder's shaders
      if (msg.payload?.command === "list") {
        send({ event: "sendToPropertyInspector", context: msg.context, payload: { shaders: listShaders(msg.payload.folder || "") } });
      }
      break;
  }
}
