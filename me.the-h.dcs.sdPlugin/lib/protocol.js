// The text messages exchanged with the Lua hook in DCS, one per UDP datagram. See lua/hook.lua.

const PROTOCOL = 1;

// One datagram from DCS -> { type, ... } or null when it isn't one of ours.
function parse(text) {
  const s = String(text);
  const space = s.indexOf(" ");
  const kind = space < 0 ? s : s.slice(0, space);
  const rest = space < 0 ? "" : s.slice(space + 1);
  switch (kind) {
    case "H": {
      const [unit = "-", protocol = "0"] = rest.split(" ");
      return { type: "hello", unit: unit === "-" ? null : unit, protocol: Number(protocol) || 0 };
    }
    case "A": {
      const values = new Map();
      for (const item of rest.split(" ")) {
        const eq = item.indexOf("=");
        if (eq < 1) continue;
        const arg = Number(item.slice(0, eq));
        const value = Number(item.slice(eq + 1));
        if (Number.isFinite(arg) && Number.isFinite(value)) values.set(arg, value);
      }
      return { type: "args", values };
    }
    case "T": {
      const sp = rest.indexOf(" ");
      const key = sp < 0 ? rest : rest.slice(0, sp);
      if (!key) return null;
      return { type: "text", id: key, text: sp < 0 ? "" : rest.slice(sp + 1) };
    }
    case "F": {
      const out = { type: "flight", agl: null, ias: null, gs: null };
      for (const item of rest.split(" ")) {
        const [k, v] = item.split("=");
        if (k in out && k !== "type" && v !== "-" && v !== "" && Number.isFinite(Number(v))) out[k] = Number(v);
      }
      return out;
    }
    case "L":
      return { type: "log", text: rest };
    case "S": {
      const [unit, status, ...error] = rest.split(" ");
      return { type: "scanned", unit: unit === "-" ? null : unit, ok: status === "ok", error: error.join(" ") };
    }
    default:
      return null;
  }
}

const num = (v) => {
  const n = Math.round(Number(v) * 10000) / 10000;
  return Object.is(n, -0) ? "0" : String(n);
};

const encode = {
  watch: (args) => `W ${[...args].map(Number).filter(Number.isFinite).sort((a, b) => a - b).join(",")}`,
  // ids: numeric indicator ids, or "name=marker" for the indicator whose text contains marker
  watchText: (ids) => `WT ${[...ids].map(String).filter((x) => /^\d+$|^\w+=\S+$/.test(x)).sort().join(",")}`,
  click: (device, command, value) => `C ${Math.trunc(device)} ${Math.trunc(command)} ${num(value)}`,
  key: (command, value) => (value == null ? `K ${Math.trunc(command)}` : `K ${Math.trunc(command)} ${num(value)}`),
  resync: () => "R",
  scan: (dir) => `S ${dir}`,
  dump: () => "D",
};

// list_indication() text -> Map(element name -> text). DCS separates elements with a line of dashes,
// each holding the element's name and then its text (which may span lines). Elements that hold
// others get a "children are {" line, and each nesting level ends with a "}" line after its last
// child's text; neither is part of any text.
function parseIndication(text) {
  const out = new Map();
  for (const block of String(text || "").split(/\r?\n-{5,}\r?\n?/)) {
    const lines = block.replace(/^-{5,}\r?\n?/, "").split(/\r?\n/);
    const name = lines.shift()?.trim();
    if (!name) continue;
    const kept = lines.filter((l) => { const t = l.trim(); return t !== "}" && t !== "children are {"; });
    out.set(name, kept.join("\n").replace(/^\s*\n|\s+$/g, ""));
  }
  return out;
}

module.exports = { PROTOCOL, parse, encode, parseIndication };
