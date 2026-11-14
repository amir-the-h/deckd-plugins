// Reading a display's pushbutton legends from its live text.
//
// list_indication names a legend's element "<legend>_<line>__id:<n>" ("RDR_1__id:57"); line 1 is
// the main legend, and <n> counts up in the order the page script created its elements. Each page
// script starts its own count, so element numbers only compare between legends of the same script. Which
// button a legend sits on comes from the display page scripts (catalog.pbPages, see pbLabelsFrom):
//
//  1. The page script matching the most legends showing is trusted first (the same legend can sit
//     on different buttons on different pages).
//  2. Within it, legends that occur once, in an order their element numbers agree with, are placed
//     directly and become anchors.
//  3. A legend that occurs more than once, or one the display fills in while flying (""), is placed
//     between the anchors its element number falls between: in order, when as many are showing as
//     there are free slots for it there; otherwise only if one slot fits. Anything else keeps its
//     number rather than show a guess.

const LEGEND = /^(.*?)_1__id:(\d+)$/;

// Display text on one line. Legends beside the side buttons are written one letter per line
// ("S\nE\nQ\n1"); those are joined back into the word.
function tidy(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1 && lines.every((l) => l.length === 1)) return lines.join("");
  return lines.join(" ");
}

// The main legends showing: [{ key, legend, uid, value }], sorted by element number.
function visibleLegends(items) {
  const out = [];
  for (const [name, value] of items) {
    const m = LEGEND.exec(name);
    if (m) out.push({ key: name, legend: m[1].trim(), uid: Number(m[2]), value: tidy(value) });
  }
  return out.sort((a, b) => a.uid - b.uid);
}

// Distinct non-empty legends showing (kept for callers that only need the words).
function legendsIn(items) {
  return new Set(visibleLegends(items).map((v) => v.legend).filter(Boolean));
}

// Places one page script's legends. Fills `out` (button -> legend) and `taken` (elements used).
function placePage(page, visible, out, taken) {
  const occ = page.occ || [];
  const words = new Set(occ.map(([l]) => l));
  const mine = visible.filter((v) => !taken.has(v.key) && words.has(v.legend) && (v.legend || v.value));
  const count = new Map();
  for (const [l] of occ) count.set(l, (count.get(l) || 0) + 1);

  // Anchors: legends that occur once in this script, keeping the longest run whose element
  // numbers rise in the script's order. A legend drawn by another script (whose numbers start
  // over) breaks that order and drops out.
  const candidates = mine
    .filter((v) => v.legend && count.get(v.legend) === 1)
    .map((v) => ({ v, index: occ.findIndex(([l]) => l === v.legend) }))
    .sort((a, b) => a.index - b.index);
  const anchors = longestRising(candidates);
  for (const a of anchors) place(out, taken, occ[a.index][1], a.v.legend, a.v.key);

  // The rest, between their neighbouring anchors: per legend, the elements showing pair up in
  // order with the free slots for that legend; if the counts differ, only a single slot is sure.
  const groups = new Map();
  for (const v of mine) {
    if (taken.has(v.key)) continue;
    const before = anchors.filter((a) => a.v.uid < v.uid).reduce((m, a) => Math.max(m, a.index), -1);
    const after = anchors.filter((a) => a.v.uid > v.uid).reduce((m, a) => Math.min(m, a.index), occ.length);
    const g = `${before}|${after}|${v.legend}`;
    if (!groups.has(g)) groups.set(g, { before, after, legend: v.legend, elements: [] });
    groups.get(g).elements.push(v);
  }
  for (const { before, after, legend, elements } of groups.values()) {
    const slots = [];
    for (let i = before + 1; i < after; i++) if (occ[i][0] === legend && !out.has(occ[i][1])) slots.push(occ[i][1]);
    elements.sort((a, b) => a.uid - b.uid);
    if (slots.length === elements.length) elements.forEach((v, i) => place(out, taken, slots[i], v.legend || v.value, v.key));
    else if (new Set(slots).size === 1 && elements.length === 1) place(out, taken, slots[0], legend || elements[0].value, elements[0].key);
  }
}

// Longest run of candidates (already in script order) whose element numbers rise.
function longestRising(list) {
  const best = list.map(() => 1);
  const prev = list.map(() => -1);
  for (let i = 0; i < list.length; i++) {
    for (let j = 0; j < i; j++) {
      if (list[j].v.uid < list[i].v.uid && best[j] + 1 > best[i]) { best[i] = best[j] + 1; prev[i] = j; }
    }
  }
  let end = best.indexOf(Math.max(0, ...best));
  const run = [];
  while (end >= 0) { run.unshift(list[end]); end = prev[end]; }
  return run;
}

function place(out, taken, pb, label, key) {
  taken.add(key);
  if (label && !out.has(pb)) out.set(pb, label);
}

// -> Map(button number -> legend) for what a display shows. `items`: its parsed text.
function buttonLegends(pbPages, items) {
  const visible = visibleLegends(items);
  const present = new Set(visible.map((v) => v.legend).filter(Boolean));
  const scored = (pbPages || [])
    .map((page) => ({ page, score: new Set((page.occ || []).map(([l]) => l).filter((l) => present.has(l))).size }))
    .filter((p) => p.score > 0 || (p.page.named || []).some(([n]) => items.has(n)))
    .sort((a, b) => b.score - a.score);
  const out = new Map();
  const taken = new Set();
  for (const { page } of scored) placePage(page, visible, out, taken);
  // legends drawn straight at a button, by element name
  for (const { page } of scored) {
    for (const [name, pb, text] of page.named || []) {
      if (!items.has(name) || out.has(pb)) continue;
      const v = tidy(items.get(name)) || text;
      if (v) out.set(pb, v);
    }
  }
  return out;
}

module.exports = { visibleLegends, legendsIn, buttonLegends };
