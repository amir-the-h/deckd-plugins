// A small Home Assistant WebSocket API client: authenticates with a long-lived access token, keeps
// every entity's state current through `subscribe_entities`, calls services, and reconnects with
// backoff when the connection drops.

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const PING_MS = 30_000;
const CALL_TIMEOUT_MS = 15_000;

class HomeAssistant {
  // onChange(entityIds | null) is called after states change (null = everything, e.g. on connect);
  // onStatus(status) with "connecting" | "connected" | "auth" (bad token) | "offline".
  constructor({ url, token, onChange, onStatus, log }) {
    this.url = String(url || "").trim().replace(/\/+$/, "");
    this.token = String(token || "").trim();
    this.onChange = onChange;
    this.onStatus = onStatus;
    this.log = log || (() => {});
    this.states = new Map(); // entity_id -> { state, attributes, last_changed }
    this.status = "connecting";
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.backoff = RECONNECT_MIN_MS;
    this.closed = false;
    this.connect();
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.onStatus?.(status);
  }

  connect() {
    if (this.closed) return;
    if (!this.url || !this.token) return this.setStatus("auth");
    let ws;
    try {
      ws = new WebSocket(this.url.replace(/^http/i, "ws") + "/api/websocket");
    } catch (e) {
      this.log(`home assistant: ${e.message}`);
      return this.retry();
    }
    this.ws = ws;
    ws.onmessage = (m) => {
      let msg;
      try { msg = JSON.parse(m.data); } catch { return; }
      for (const one of Array.isArray(msg) ? msg : [msg]) this.receive(one);
    };
    // A failed handshake (e.g. a proxy answering 502 while Home Assistant restarts) fires only
    // "error", never "close", and leaves the socket CONNECTING for good; a dead connection may
    // never close either. Every way of losing the socket goes through lost(), which retries once.
    ws.onclose = () => this.lost(ws);
    ws.onerror = () => this.lost(ws);
    clearTimeout(this.handshake);
    this.handshake = setTimeout(() => {
      if (this.ws === ws && this.status !== "connected") this.lost(ws);
    }, CALL_TIMEOUT_MS);
  }

  // Drops `ws` (if it is still the current socket) and schedules a reconnect.
  lost(ws) {
    if (this.ws !== ws) return;
    this.ws = null;
    clearTimeout(this.handshake);
    clearInterval(this.pinger);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("disconnected")); }
    this.pending.clear();
    try { ws.close(); } catch {}
    if (this.status !== "auth") this.setStatus("offline");
    this.retry();
  }

  retry() {
    if (this.closed || this.status === "auth") return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(RECONNECT_MAX_MS, this.backoff * 2);
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  receive(msg) {
    switch (msg.type) {
      case "auth_required":
        this.send({ type: "auth", access_token: this.token });
        break;
      case "auth_invalid":
        this.log(`home assistant: ${msg.message || "invalid token"}`);
        this.setStatus("auth");
        this.lost(this.ws);
        break;
      case "auth_ok":
        this.backoff = RECONNECT_MIN_MS;
        this.states.clear();
        this.subscription = this.nextId;
        this.send({ id: this.nextId++, type: "subscribe_entities" });
        clearInterval(this.pinger);
        this.pinger = setInterval(() => {
          const ws = this.ws;
          this.request({ type: "ping" }).catch(() => this.lost(ws));
        }, PING_MS);
        break;
      case "event":
        if (msg.id === this.subscription) this.applyEvent(msg.event);
        break;
      case "result":
      case "pong": {
        const p = this.pending.get(msg.id);
        if (!p) break;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.type === "pong" || msg.success) p.resolve(msg.result);
        else p.reject(new Error(msg.error?.message || "failed"));
        break;
      }
    }
  }

  // subscribe_entities sends compressed updates: a = added (full), c = changed ("+" merges, "-"
  // removes attributes), r = removed.
  applyEvent(ev) {
    const changed = [];
    for (const [id, s] of Object.entries(ev.a || {})) {
      this.states.set(id, { state: s.s, attributes: s.a || {}, last_changed: s.lc });
      changed.push(id);
    }
    for (const [id, diff] of Object.entries(ev.c || {})) {
      const cur = this.states.get(id);
      if (!cur) continue;
      const plus = diff["+"] || {}, minus = diff["-"] || {};
      const next = { ...cur, attributes: { ...cur.attributes } };
      if ("s" in plus) next.state = plus.s;
      if ("lc" in plus) next.last_changed = plus.lc;
      Object.assign(next.attributes, plus.a || {});
      for (const k of minus.a || []) delete next.attributes[k];
      this.states.set(id, next);
      changed.push(id);
    }
    for (const id of ev.r || []) {
      this.states.delete(id);
      changed.push(id);
    }
    if (ev.a && this.status !== "connected") {
      this.setStatus("connected");
      this.onChange?.(null);
    } else if (changed.length) {
      this.onChange?.(changed);
    }
  }

  request(msg) {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN || (this.status !== "connected" && msg.type !== "ping")) {
        return reject(new Error("not connected"));
      }
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("timed out")); }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, ...msg });
    });
  }

  // call("light.toggle", "light.desk", { brightness_pct: 50 })
  call(service, entityId, data = {}) {
    const [domain, name] = String(service).split(".");
    const msg = { type: "call_service", domain, service: name, service_data: data };
    if (entityId) msg.target = { entity_id: entityId };
    return this.request(msg);
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.handshake);
    clearInterval(this.pinger);
    this.ws?.close();
  }
}

module.exports = { HomeAssistant };
