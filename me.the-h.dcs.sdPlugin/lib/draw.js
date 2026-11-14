// SVG drawing for keys (144x144) and touch-strip segments (200 per segment x 100).

const FONT = `font-family="Inter, 'Noto Sans', sans-serif"`;
const BG = "#141414", TEXT = "#f2f2f2", DIM = "#8a8a8a", OFF = "#3a3a3a";
const COLORS = { green: "#4cd07d", amber: "#f0a830", red: "#f04848", blue: "#5aa9e6", white: "#f2f2f2" };

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const svgUri = (svg) => "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
const trunc = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));
const color = (c, fallback = COLORS.green) => COLORS[c] || (/^#[0-9a-f]{3,8}$/i.test(c || "") ? c : fallback);

// Split a label into at most `lines` lines of about `width` characters.
function wrap(text, width, lines) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const out = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= width) cur += " " + w;
    else { out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  if (out.length > lines) {
    const kept = out.slice(0, lines);
    kept[lines - 1] = trunc(out.slice(lines - 1).join(" "), width);
    return kept;
  }
  return out.map((l) => trunc(l, width));
}

const fit = (text, base, max) => (String(text).length > max ? Math.max(14, Math.round((base * max) / String(text).length)) : base);

// A switch, button or knob on a key.
// view: { label, value, on, color, lamp: null|{lit, color}, level: null|0..1, dim }
function switchKey(view) {
  if (!view.value && !view.dim) return buttonKey(view);
  const accent = color(view.color);
  const lines = wrap(view.label, 13, 2);
  const valueText = trunc(view.value ?? "", 10);
  const valueColor = view.dim ? OFF : view.on ? accent : TEXT;
  const labelY = lines.length > 1 ? [26, 46] : [34];
  const lamp = view.lamp
    ? `<circle cx="124" cy="20" r="9" fill="${view.lamp.lit ? color(view.lamp.color, COLORS.amber) : "#262626"}" stroke="#000" stroke-width="2"/>` : "";
  const bar = view.level != null && !view.dim
    ? `<rect x="22" y="122" width="100" height="6" rx="3" fill="#2a2a2a"/><rect x="22" y="122" width="${Math.round(view.level * 100)}" height="6" rx="3" fill="${accent}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144"><rect width="144" height="144" fill="${BG}"/>
${view.on && !view.dim ? `<rect x="0" y="0" width="6" height="144" fill="${accent}"/>` : ""}
${lines.map((l, i) => `<text x="72" y="${labelY[i]}" ${FONT} font-size="17" font-weight="600" text-anchor="middle" fill="${view.dim ? DIM : TEXT}">${esc(l)}</text>`).join("")}
<text x="72" y="${bar ? 100 : 104}" ${FONT} font-size="${fit(valueText, 30, 6)}" font-weight="700" text-anchor="middle" fill="${valueColor}">${esc(valueText)}</text>
${bar}${lamp}</svg>`;
}

// A push button with nothing to read out: a button cap with its legend, outlined in its lamp's colour
// while the lamp is lit.
function buttonKey(view) {
  const lit = view.lamp?.lit;
  const edge = lit ? color(view.lamp.color, COLORS.amber) : "#3a3a3a";
  const lines = wrap(view.label, 9, 3);
  const size = lines.length > 2 ? 18 : 22;
  const top = 72 - ((lines.length - 1) * (size + 2)) / 2 + size / 3 - (view.sub ? 10 : 0);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144"><rect width="144" height="144" fill="${BG}"/>
<rect x="16" y="16" width="112" height="112" rx="14" fill="#222" stroke="${edge}" stroke-width="${lit ? 6 : 3}"/>
${lines.map((l, i) => `<text x="72" y="${top + i * (size + 2)}" ${FONT} font-size="${size}" font-weight="800" text-anchor="middle" fill="${lit ? edge : TEXT}">${esc(l)}</text>`).join("")}
${view.sub ? `<text x="72" y="112" ${FONT} font-size="12" text-anchor="middle" fill="${DIM}">${esc(trunc(view.sub, 20))}</text>` : ""}
</svg>`;
}

// An annunciator light: a lit or dark panel with its legend.
function lightKey({ label, lit, color: c, dim }) {
  const fill = lit && !dim ? color(c, COLORS.amber) : "#1e1e1e";
  const ink = lit && !dim ? "#111" : dim ? "#333" : "#5a5a5a";
  const lines = wrap(label, 9, 3);
  const size = lines.length > 2 ? 18 : 22;
  const top = 72 - ((lines.length - 1) * (size + 2)) / 2 + size / 3;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144"><rect width="144" height="144" fill="${BG}"/>
<rect x="10" y="22" width="124" height="100" rx="8" fill="${fill}" stroke="${lit && !dim ? fill : "#333"}" stroke-width="3"/>
${lit && !dim ? `<rect x="10" y="22" width="124" height="100" rx="8" fill="#fff" opacity="0.12"/>` : ""}
${lines.map((l, i) => `<text x="72" y="${top + i * (size + 2)}" ${FONT} font-size="${size}" font-weight="800" text-anchor="middle" fill="${ink}">${esc(l)}</text>`).join("")}
</svg>`;
}

// A knob on the touch strip: label, value and an optional bar; `span` segments wide.
function knobStrip({ label, value, on, color: c, level, dim, sub }, span = 1) {
  const w = 200 * Math.max(1, span);
  const accent = color(c);
  const maxLabel = 15 * span + (span - 1) * 4;
  const bar = level != null && !dim
    ? `<rect x="10" y="86" width="${w - 20}" height="6" rx="3" fill="#2a2a2a"/><rect x="10" y="86" width="${Math.round(level * (w - 20))}" height="6" rx="3" fill="${accent}"/>` : "";
  const valueText = trunc(value ?? "", 9 * span + 3);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 100"><rect width="${w}" height="100" fill="${BG}"/>
${on && !dim ? `<rect width="4" height="100" fill="${accent}"/>` : ""}
<text x="10" y="22" ${FONT} font-size="16" font-weight="600" fill="${dim ? DIM : TEXT}">${esc(trunc(label, maxLabel))}</text>
${sub ? `<text x="${w - 8}" y="22" ${FONT} font-size="13" text-anchor="end" fill="${DIM}">${esc(trunc(sub, 10))}</text>` : ""}
<text x="10" y="${bar ? 70 : 74}" ${FONT} font-size="${fit(valueText, 32, 8 * span)}" font-weight="700" fill="${dim ? OFF : on ? accent : TEXT}">${esc(valueText)}</text>
${bar}</svg>`;
}

// A picker on the touch strip. Up to six buttons sit side by side (a display's side), the picked
// one lit; more (a keypad) turn like a drum, the picked one large between its neighbours. `text`
// is a display's line shown at the top right (the scratchpad).
function pickerStrip({ label, text, items, index, dim }, span = 1, asKey = false) {
  if (asKey) {
    return switchKey({ label: label || "Picker", value: items[index] ?? "—", on: !dim, color: "amber", dim });
  }
  const w = 200 * Math.max(1, span);
  const accent = COLORS.amber;
  const head = `<text x="10" y="20" ${FONT} font-size="14" font-weight="600" fill="${dim ? DIM : TEXT}">${esc(trunc(label || "", 14 * span))}</text>
${text ? `<text x="${w - 8}" y="21" font-family="ui-monospace, 'Noto Sans Mono', monospace" font-size="15" font-weight="700" text-anchor="end" fill="${dim ? OFF : COLORS.green}">${esc(trunc(text, 10 * span))}</text>` : ""}`;
  if (!items.length) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 100"><rect width="${w}" height="100" fill="${BG}"/>${head}
<text x="${w / 2}" y="66" ${FONT} font-size="16" text-anchor="middle" fill="${DIM}">set its buttons</text></svg>`;
  }
  let body;
  if (items.length <= 6) {
    const cell = (w - 12) / items.length;
    body = items.map((it, i) => {
      const x = 6 + i * cell;
      const on = i === index && !dim;
      const t = trunc(it, Math.max(5, Math.floor(cell / 8)));
      // ~0.6em per character: shrink the label until it fits its cell
      const size = Math.max(9, Math.min(16, Math.floor((cell - 8) / (0.72 * Math.max(1, t.length)))));
      return `<rect x="${x + 2}" y="34" width="${cell - 4}" height="58" rx="6" fill="${on ? accent : "#222"}" stroke="${on ? accent : "#3a3a3a"}" stroke-width="2"/>
<text x="${x + cell / 2}" y="69" ${FONT} font-size="${size}" font-weight="700" text-anchor="middle" fill="${on ? "#111" : dim ? OFF : TEXT}">${esc(t)}</text>`;
    }).join("");
  } else {
    const at = (d) => items[(index + d + items.length) % items.length];
    // Short labels (digits) show two neighbours a side; longer ones one, in the space beside the box.
    const short = items.every((x) => String(x).length <= 2);
    const room = (w / 2 - 40) / (short ? 2 : 1);
    const side = (d, x) => {
      const t = trunc(at(d), short ? 3 : Math.max(3, Math.floor(room / 10)));
      return `<text x="${x}" y="72" ${FONT} font-size="${Math.min(18, Math.floor(room / (0.62 * t.length)))}" font-weight="600" text-anchor="middle" fill="${OFF}">${esc(t)}</text>`;
    };
    body = short
      ? `${side(-2, room / 2 + 4)}${side(-1, room * 1.5 + 4)}${side(1, w - room * 1.5 - 4)}${side(2, w - room / 2 - 4)}`
      : `${side(-1, room / 2 + 4)}${side(1, w - room / 2 - 4)}`;
    body += `
<rect x="${w / 2 - 34}" y="38" width="68" height="52" rx="8" fill="${dim ? "#222" : accent}"/>
<text x="${w / 2}" y="74" ${FONT} font-size="${String(at(0)).length > 3 ? 18 : 28}" font-weight="800" text-anchor="middle" fill="${dim ? OFF : "#111"}">${esc(trunc(at(0), 6))}</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 100"><rect width="${w}" height="100" fill="${BG}"/>${head}${body}</svg>`;
}

// The link status key: what's connected and which aircraft you're in.
function statusKey({ title, line1, line2, state }) {
  const c = state === "ok" ? COLORS.green : state === "wait" ? COLORS.amber : state === "error" ? COLORS.red : DIM;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144"><rect width="144" height="144" fill="${BG}"/>
<rect x="0" y="0" width="144" height="6" fill="${c}"/>
<text x="72" y="40" ${FONT} font-size="20" font-weight="800" text-anchor="middle" fill="${TEXT}">${esc(trunc(title, 11))}</text>
<text x="72" y="82" ${FONT} font-size="${fit(line1, 20, 11)}" font-weight="700" text-anchor="middle" fill="${c}">${esc(trunc(line1, 14))}</text>
<text x="72" y="112" ${FONT} font-size="14" text-anchor="middle" fill="${DIM}">${esc(trunc(line2 || "", 18))}</text>
</svg>`;
}

function statusStrip(view, span = 1) {
  const w = 200 * Math.max(1, span);
  const c = view.state === "ok" ? COLORS.green : view.state === "wait" ? COLORS.amber : view.state === "error" ? COLORS.red : DIM;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 100"><rect width="${w}" height="100" fill="${BG}"/>
<rect width="4" height="100" fill="${c}"/>
<text x="10" y="22" ${FONT} font-size="16" font-weight="600" fill="${TEXT}">${esc(view.title)}</text>
<text x="10" y="62" ${FONT} font-size="24" font-weight="700" fill="${c}">${esc(trunc(view.line1, 12 * span))}</text>
<text x="10" y="88" ${FONT} font-size="14" fill="${DIM}">${esc(trunc(view.line2 || "", 22 * span))}</text>
</svg>`;
}

// Default colour for a lamp from its name (overlays can set their own).
function lampColor(name) {
  const n = String(name || "").toUpperCase();
  if (/FIRE|WARN|NO_GO|MASTER_CAUTION|SHOOT|LOCK|RED|FAIL|AAA|SAM|_AI$|LOW_ALT|LDG_GEAR_HANDLE/.test(n)) return "red";
  if (/(^|_)GO$|READY|_GEAR$|HALF_FLAPS|FULL_FLAPS|GREEN|_AA$|_AG$|DISCH/.test(n)) return "green";
  return "amber";
}

module.exports = { svgUri, switchKey, lightKey, knobStrip, pickerStrip, statusKey, statusStrip, lampColor, COLORS };
