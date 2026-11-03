// GitHub Pull Requests: counts of the open PRs that need you, scoped to one or more organisations
// (Node >= 22, no deps). Every button shares one GraphQL fetch per organisation scope.
//
//   review        PRs where your review is requested, directly or through one of your teams
//   needsreviews  your PRs with fewer approvals than the configured minimum
//   attention     your PRs with failed CI, a merge conflict or requested changes
//   ready         your PRs that are approved, green and mergeable
//   overview      all four counts on one button
//
// Key: press to refresh. Dial: turn to step through the PRs; push or tap the strip to refresh.

const gh = require("./github.js");

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

const TICK_MS = 5_000;
const DEFAULT_INTERVAL_S = 60;
const MIN_INTERVAL_S = 30;

const intervalS = () => Math.max(MIN_INTERVAL_S, Number(globals?.interval) || DEFAULT_INTERVAL_S);
const minApprovals = () => Math.max(1, Number(globals?.minApprovals) || 1);
const orgsOf = (inst) => (inst.settings.org || globals?.org || "").trim();

// --------------------------------------------------------------------------- kinds

const RED = "#e05a5a", AMBER = "#e0a030", GREEN = "#4caf7d", BLUE = "#5aa9e6";
const GREY = "#555", TEXT = "#f2f2f2", DIM = "#9a9a9a", SOFT = "#d8d8d8";

const KINDS = {
  review: { list: "review", label: "REVIEW", color: BLUE, detail: reviewDetail },
  needsreviews: { list: "needsReviews", label: "NEEDS REVIEWS", color: AMBER, detail: needsDetail },
  attention: { list: "attention", label: "ATTENTION", color: RED, detail: attentionDetail },
  ready: { list: "ready", label: "READY TO MERGE", color: GREEN, detail: firstPrDetail },
  overview: { overview: true, label: "PULL REQUESTS" },
};

const OVERVIEW = [
  { kind: "review", short: "review" },
  { kind: "attention", short: "fix" },
  { kind: "needsreviews", short: "waiting" },
  { kind: "ready", short: "merge" },
];

const kindName = (inst) => inst.action.slice(args.pluginUUID.length + 1);
const kindOf = (inst) => KINDS[kindName(inst)];

function reviewDetail(prs) {
  const direct = prs.filter((p) => p.direct).length;
  const team = prs.length - direct;
  return [direct && `${direct} you`, team && `${team} team`].filter(Boolean).join(" · ");
}

function needsDetail(prs) {
  const missing = prs.reduce((n, p) => n + p.missing, 0);
  return `${missing} approval${missing === 1 ? "" : "s"} short`;
}

function attentionDetail(prs) {
  const counts = {};
  for (const p of prs) for (const r of p.reasons) counts[r] = (counts[r] || 0) + 1;
  return Object.entries(counts).map(([r, n]) => (n > 1 ? `${r} ${n}` : r)).join(" · ");
}

function firstPrDetail(prs) {
  return prs.length ? prLabel(prs[0]) : "";
}

// --------------------------------------------------------------------------- shared fetching

const scopes = new Map(); // orgs -> { data, error, fetchedAt, refreshing }

const scopeKey = (inst) => orgsOf(inst);

function scopeOf(inst) {
  const key = scopeKey(inst);
  if (!scopes.has(key)) scopes.set(key, { data: null, error: null, fetchedAt: 0, refreshing: null });
  return scopes.get(key);
}

async function fetchScope(orgs) {
  const sc = scopes.get(orgs);
  let tok = await gh.token(globals?.token);
  if (!tok) {
    sc.error = "sign in";
    return;
  }
  try {
    sc.data = await gh.fetchPrs(tok, orgs);
    sc.error = null;
  } catch (e) {
    // The GitHub CLI may have refreshed its login since we cached the token.
    if (e.code === "auth" && !globals?.token && (tok = await gh.token("", { fresh: true }))) {
      try {
        sc.data = await gh.fetchPrs(tok, orgs);
        sc.error = null;
        return;
      } catch (e2) { e = e2; }
    }
    sc.error = { auth: "sign in", limit: "rate limit" }[e.code] || "offline";
    log(`github: ${e.message}`);
  }
}

function refreshScope(key) {
  const sc = scopes.get(key);
  if (!sc || !globals) return Promise.resolve();
  if (sc.refreshing) return sc.refreshing; // coalesce overlapping requests
  sc.refreshing = fetchScope(key)
    .catch((e) => log(`github: ${e.stack || e}`))
    .finally(() => {
      sc.fetchedAt = Date.now();
      sc.refreshing = null;
      for (const [context, inst] of instances) if (scopeKey(inst) === key) draw(context);
    });
  return sc.refreshing;
}

function refresh(context) {
  const inst = instances.get(context);
  if (!inst || !globals) return Promise.resolve();
  scopeOf(inst);
  return refreshScope(scopeKey(inst));
}

const listsOf = (inst) => gh.categorize(scopeOf(inst).data, minApprovals());

// --------------------------------------------------------------------------- drawing

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const svgUri = (svg) => "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
const FONT = `font-family="Inter, 'Noto Sans', sans-serif"`;
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const prLabel = (pr) => `${pr.repo.split("/")[1]}#${pr.number}`;

// What the button says instead of a count: not loaded yet, or the fetch failed.
function statusText(inst) {
  const sc = scopeOf(inst);
  if (!globals || (!sc.data && !sc.error)) return "…";
  if (sc.error && !sc.data) return sc.error;
  return null;
}

function key(inst) {
  const kind = kindOf(inst);
  const label = esc(trunc((inst.settings.label || kind.label).toUpperCase(), 14));
  const status = statusText(inst);
  const stale = scopeOf(inst).error && scopeOf(inst).data;
  const head = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
<rect width="144" height="144" fill="#141414"/>
<text x="72" y="24" ${FONT} font-size="14" font-weight="600" letter-spacing="1.5" text-anchor="middle" fill="${DIM}">${label}</text>
${stale ? `<circle cx="134" cy="12" r="4" fill="${AMBER}"/>` : ""}`;

  if (status) {
    return `${head}<text x="72" y="84" ${FONT} font-size="22" text-anchor="middle" fill="${GREY}">${esc(status)}</text></svg>`;
  }

  const lists = listsOf(inst);
  if (kind.overview) {
    const cells = OVERVIEW.map((o, i) => {
      const n = lists[KINDS[o.kind].list].length;
      const x = i % 2 ? 108 : 36, y = i < 2 ? 70 : 122;
      return `<text x="${x}" y="${y}" ${FONT} font-size="32" font-weight="700" text-anchor="middle" fill="${n ? KINDS[o.kind].color : GREY}">${n}</text>
<text x="${x}" y="${y + 14}" ${FONT} font-size="12" text-anchor="middle" fill="${DIM}">${o.short}</text>`;
    });
    return `${head}${cells.join("\n")}</svg>`;
  }

  const prs = lists[kind.list];
  const n = prs.length;
  return `${head}
<text x="72" y="96" ${FONT} font-size="58" font-weight="700" text-anchor="middle" fill="${n ? kind.color : GREY}">${n}</text>
<text x="72" y="132" ${FONT} font-size="15" text-anchor="middle" fill="${SOFT}">${esc(trunc(n ? kind.detail(prs) : "", 18))}</text>
</svg>`;
}

function strip(inst) {
  const kind = kindOf(inst);
  const label = esc(trunc((inst.settings.label || kind.label).toUpperCase(), 16));
  const status = statusText(inst);
  const head = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
<rect width="200" height="100" fill="#141414"/>
<text x="6" y="18" ${FONT} font-size="13" font-weight="600" letter-spacing="1.2" fill="${DIM}">${label}</text>`;

  if (status) {
    return `${head}<text x="100" y="66" ${FONT} font-size="22" text-anchor="middle" fill="${GREY}">${esc(status)}</text></svg>`;
  }

  const lists = listsOf(inst);
  if (kind.overview) {
    const cells = OVERVIEW.map((o, i) => {
      const n = lists[KINDS[o.kind].list].length;
      const x = 25 + i * 50;
      return `<text x="${x}" y="66" ${FONT} font-size="30" font-weight="700" text-anchor="middle" fill="${n ? KINDS[o.kind].color : GREY}">${n}</text>
<text x="${x}" y="88" ${FONT} font-size="12" text-anchor="middle" fill="${DIM}">${o.short}</text>`;
    });
    return `${head}${cells.join("\n")}</svg>`;
  }

  const prs = lists[kind.list];
  const n = prs.length;
  const count = `<text x="194" y="18" ${FONT} font-size="15" font-weight="700" text-anchor="end" fill="${n ? kind.color : GREY}">${n}</text>`;
  if (!n) {
    return `${head}${count}<text x="100" y="66" ${FONT} font-size="20" text-anchor="middle" fill="${GREY}">none</text></svg>`;
  }
  const i = ((inst.cursor || 0) % n + n) % n;
  const pr = prs[i];
  const why = pr.reasons ? pr.reasons.join(" · ") : pr.missing ? `${pr.approvals}/${minApprovals()} approvals` : pr.direct === false ? `team: ${pr.requestedTeams.join(", ")}` : "";
  return `${head}${count}
<text x="6" y="46" ${FONT} font-size="17" font-weight="700" fill="${TEXT}">${esc(trunc(prLabel(pr), 20))}</text>
<text x="6" y="68" ${FONT} font-size="14" fill="${SOFT}">${esc(trunc(pr.title, 26))}</text>
<text x="6" y="92" ${FONT} font-size="13" fill="${kind.color}">${esc(trunc(why, 20))}</text>
<text x="194" y="92" ${FONT} font-size="13" text-anchor="end" fill="${DIM}">${i + 1}/${n}</text>
</svg>`;
}

// --------------------------------------------------------------------------- instances

const instances = new Map(); // context -> { action, controller, settings, cursor }
const lastImage = new Map(); // context -> data URI, to skip redundant redraws

function draw(context) {
  const inst = instances.get(context);
  if (!inst || !kindOf(inst)) return;
  const image = svgUri(inst.controller === "Encoder" ? strip(inst) : key(inst));
  if (lastImage.get(context) === image) return;
  lastImage.set(context, image);
  send({ event: "setImage", context, payload: { image } });
}

let ticker = null;

function startTicking() {
  if (ticker) return;
  ticker = setInterval(() => {
    if (!globals) return;
    const now = Date.now();
    const keys = new Set([...instances.values()].map(scopeKey));
    for (const k of keys) {
      const sc = scopes.get(k);
      if (sc && now - sc.fetchedAt >= intervalS() * 1000) refreshScope(k);
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
  await refresh(context);
  send({ event: scopeOf(inst).error ? "showAlert" : "showOk", context });
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
      if (!scopeOf(instances.get(msg.context)).fetchedAt) refresh(msg.context);
      startTicking();
      break;
    case "willDisappear":
      instances.delete(msg.context);
      lastImage.delete(msg.context);
      if (!instances.size) stopTicking();
      break;
    case "didReceiveSettings": {
      const before = instances.get(msg.context) && scopeKey(instances.get(msg.context));
      const inst = remember(msg);
      draw(msg.context);
      if (scopeKey(inst) !== before) refresh(msg.context);
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
      press(msg.context);
      break;
    case "didReceiveGlobalSettings":
      globals = msg.payload?.settings || {};
      for (const context of instances.keys()) { draw(context); refresh(context); }
      break;
  }
}
