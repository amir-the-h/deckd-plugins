// Elgato Key Light family (Key Light, Key Light Air, Ring Light, Light Strip) over their local HTTP API.
// Lights are found with mDNS (avahi-browse) and/or listed by address in the plugin settings.

const { execFile } = require("node:child_process");

const PORT = 9123;
const TIMEOUT_MS = 3000;

/** Calls a light's HTTP API and returns its JSON reply ({} when empty). */
async function api(ip, path, method = "GET", body) {
  const res = await fetch(`http://${ip.includes(":") && !ip.startsWith("[") ? `[${ip}]` : ip}:${PORT}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

/** [{ name, ip }] announced over mDNS as _elg._tcp; [] when avahi isn't available. */
function browse(timeoutMs) {
  return new Promise((resolve) => {
    // -r resolves addresses, -t stops after the cache is dumped, -p is parsable output.
    execFile("avahi-browse", ["-prt", "_elg._tcp"], { timeout: timeoutMs }, (err, stdout) => {
      if (err && !stdout) return resolve([]);
      const found = new Map();
      for (const line of String(stdout).split("\n")) {
        // =;iface;IPv4;Elgato\032Key\032Light\0324181;_elg._tcp;local;host.local;192.168.1.20;9123;txt
        const p = line.split(";");
        if (p[0] !== "=" || p.length < 9) continue;
        const name = p[3].replace(/\\(\d{3})/g, (_, d) => String.fromCharCode(Number(d)));
        // Prefer IPv4: some lights answer badly on link-local IPv6.
        if (!found.has(name) || p[2] === "IPv4") found.set(name, { name, ip: p[7] });
      }
      resolve([...found.values()]);
    });
  });
}

/** Lights that answer, from mDNS plus any manual addresses, sorted by name. */
async function findLights(manual = [], timeoutMs = 3000) {
  const candidates = [...(await browse(timeoutMs)), ...manual.map((ip) => ({ name: ip, ip }))];
  const checked = await Promise.all(
    candidates.map(async (l) => {
      try {
        const info = await api(l.ip, "/elgato/accessory-info");
        return { name: info.displayName || info.productName || l.name, ip: l.ip };
      } catch {
        return null;
      }
    }),
  );
  const byIp = new Map(checked.filter(Boolean).map((l) => [l.ip, l]));
  return [...byIp.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// The API speaks colour temperature in mireds (143–344 ≈ 7000–2900 K).
const kelvinToMired = (k) => Math.round(1_000_000 / k);
const miredToKelvin = (m) => Math.round(1_000_000 / m);

const getState = (ip) => api(ip, "/elgato/lights");
const setState = (ip, light) => api(ip, "/elgato/lights", "PUT", { numberOfLights: 1, lights: [light] });
const identify = (ip) => api(ip, "/elgato/identify", "POST");

module.exports = { findLights, getState, setState, identify, kelvinToMired, miredToKelvin };
