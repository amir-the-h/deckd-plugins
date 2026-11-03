// Docker Engine API access, either directly (a unix socket or a TCP URL such as a socket proxy) or
// through Portainer, which forwards the same API at /api/endpoints/<id>/docker.

const http = require("node:http");
const https = require("node:https");

const TIMEOUT_MS = 10_000;
const RESTART_TIMEOUT_MS = 90_000; // the container gets 10 s to stop, then needs time to start

// connection({ url, token, environment }) -> { request(method, path), describe }
//   url "unix:///var/run/docker.sock" or "/var/run/docker.sock" -> local socket
//   url + token                                                -> Portainer
//   url alone                                                  -> Docker API over HTTP(S)
function connection({ url, token, environment }) {
  url = String(url || "").trim() || "unix:///var/run/docker.sock";
  const socketPath = url.startsWith("unix://") ? url.slice(7) : url.startsWith("/") ? url : null;
  const base = socketPath ? null : new URL(url.replace(/\/+$/, ""));
  const headers = token ? { "X-API-Key": String(token).trim() } : {};
  let prefix = null; // the Portainer environment's Docker path, found on first use

  function raw(method, path, timeout = TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const opts = socketPath
        ? { socketPath, path, method, headers }
        : { protocol: base.protocol, hostname: base.hostname, port: base.port, path: base.pathname.replace(/\/$/, "") + path, method, headers };
      const req = (opts.protocol === "https:" ? https : http).request(opts, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode >= 400) {
            let msg = body;
            try { msg = JSON.parse(body).message || JSON.parse(body).details || body; } catch {}
            const code = res.statusCode === 401 || res.statusCode === 403 ? "auth" : "error";
            return reject(Object.assign(new Error(`HTTP ${res.statusCode}: ${String(msg).slice(0, 200)}`), { code }));
          }
          try { resolve(body ? JSON.parse(body) : null); } catch { resolve(body); }
        });
      });
      req.setTimeout(timeout, () => req.destroy(Object.assign(new Error("timed out"), { code: "offline" })));
      req.on("error", (e) => reject(Object.assign(e, { code: e.code === "auth" ? "auth" : "offline" })));
      req.end();
    });
  }

  async function dockerPrefix() {
    if (!token) return "";
    if (prefix) return prefix;
    const envs = await raw("GET", "/api/endpoints");
    const want = String(environment || "").trim();
    const env = want ? envs.find((e) => String(e.Id) === want || e.Name === want) : envs.find((e) => e.Type === 1 || e.Type === 2) || envs[0];
    if (!env) throw Object.assign(new Error(want ? `no Portainer environment "${want}"` : "no Portainer environments"), { code: "error" });
    prefix = `/api/endpoints/${env.Id}/docker`;
    return prefix;
  }

  return {
    async request(method, path, timeout) {
      return raw(method, (await dockerPrefix()) + path, timeout);
    },
    key: JSON.stringify([url, token || "", environment || ""]),
  };
}

// --------------------------------------------------------------------------- containers

// The container list, reduced to what the buttons need.
async function containers(conn) {
  const list = await conn.request("GET", "/containers/json?all=1");
  return list.map((c) => {
    const status = c.Status || "";
    const health = /\(unhealthy\)/.test(status) ? "unhealthy" : /\(health: starting\)/.test(status) ? "starting" : /\(healthy\)/.test(status) ? "healthy" : null;
    const net = c.HostConfig?.NetworkMode || "";
    return {
      id: c.Id,
      name: (c.Names?.[0] || c.Id.slice(0, 12)).replace(/^\//, ""),
      project: c.Labels?.["com.docker.compose.project"] || null,
      service: c.Labels?.["com.docker.compose.service"] || null,
      image: c.Image || "",
      state: c.State, // running | exited | created | restarting | paused | dead | removing
      health,
      status, // "Up 3 hours (healthy)", "Exited (0) 2 days ago"
      netFrom: net.startsWith("container:") ? net.slice(10) : null, // shares another container's network
    };
  });
}

const restart = (conn, c) => conn.request("POST", `/containers/${c.id}/restart?t=10`, RESTART_TIMEOUT_MS);
const start = (conn, c) => conn.request("POST", `/containers/${c.id}/start`, RESTART_TIMEOUT_MS);
const stop = (conn, c) => conn.request("POST", `/containers/${c.id}/stop?t=10`, RESTART_TIMEOUT_MS);

// Restart a group of containers. Containers whose network others join (network_mode: container:X,
// e.g. a VPN gateway) go first, and the running containers that join them are restarted afterwards
// even if they weren't asked for: a container left on a restarted container's old network has none.
// Everything else restarts in parallel.
async function restartAll(conn, list, all) {
  const byRef = (ref) => all.find((c) => c.id === ref || c.id.startsWith(ref) || c.name === ref);
  const providerOf = (c) => (c.netFrom ? byRef(c.netFrom) : null);
  const providers = new Set(all.map((c) => providerOf(c)?.id).filter(Boolean));
  const first = list.filter((c) => providers.has(c.id));
  const firstIds = new Set(first.map((c) => c.id));
  const dependants = all.filter((c) => c.state === "running" && firstIds.has(providerOf(c)?.id));
  const rest = [...new Map([...list.filter((c) => !providers.has(c.id)), ...dependants].map((c) => [c.id, c])).values()];
  for (const c of first) await restart(conn, c);
  const results = await Promise.allSettled(rest.map((c) => restart(conn, c)));
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length) throw failed[0].reason;
}

// Start containers that aren't running: network providers first, then the rest in parallel.
async function startAll(conn, list, all) {
  const providerIds = providers(all);
  const todo = list.filter((c) => c.state !== "running");
  for (const c of todo.filter((c) => providerIds.has(c.id))) await start(conn, c);
  await settle(todo.filter((c) => !providerIds.has(c.id)).map((c) => start(conn, c)));
}

// Stop running containers: the ones joining another's network first, then the providers.
async function stopAll(conn, list, all) {
  const providerIds = providers(all);
  const todo = list.filter((c) => c.state === "running" || c.state === "restarting");
  await settle(todo.filter((c) => !providerIds.has(c.id)).map((c) => stop(conn, c)));
  for (const c of todo.filter((c) => providerIds.has(c.id))) await stop(conn, c);
}

// Ids of containers whose network other containers join.
function providers(all) {
  const byRef = (ref) => all.find((c) => c.id === ref || c.id.startsWith(ref) || c.name === ref);
  return new Set(all.map((c) => (c.netFrom ? byRef(c.netFrom)?.id : null)).filter(Boolean));
}

async function settle(promises) {
  const failed = (await Promise.allSettled(promises)).filter((r) => r.status === "rejected");
  if (failed.length) throw failed[0].reason;
}

module.exports = { connection, containers, restart, restartAll, startAll, stopAll };
