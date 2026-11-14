// The UDP link to the hook running inside DCS: receives heartbeats, argument values and indicator
// text, and sends watch lists and clickable actions.

const dgram = require("node:dgram");
const { EventEmitter } = require("node:events");
const { parse, encode } = require("./protocol.js");

const TIMEOUT_MS = 3500; // the hook says hello every second

class DcsLink extends EventEmitter {
  constructor({ host = "127.0.0.1", listenPort = 7790, sendPort = 7791, log = () => {} } = {}) {
    super();
    this.host = host;
    this.listenPort = listenPort;
    this.sendPort = sendPort;
    this.log = log;
    this.unit = null;          // DCS unit name of the aircraft you're in, or null
    this.connected = false;    // heard from the hook recently
    this.lastHeard = 0;
    this.values = new Map();   // arg -> value
    this.texts = new Map();    // indicator key ("7" or a name like "ufc") -> text
    this.flight = { agl: null, ias: null, gs: null }; // metres above ground, m/s; null when unknown
    this.watched = new Set();
    this.watchedTexts = new Set();
    this.socket = null;
    this.timer = null;
  }

  start() {
    if (this.socket) return;
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    socket.on("message", (buf) => this.receive(buf.toString("utf8")));
    socket.on("error", (e) => {
      this.log(`dcs link: ${e.message}`);
      this.emit("error", e);
    });
    socket.bind(this.listenPort, this.host);
    this.socket = socket;
    this.timer = setInterval(() => this.checkAlive(), 1000);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    try { this.socket?.close(); } catch {}
    this.socket = null;
  }

  send(text) {
    if (!this.socket) return;
    this.socket.send(Buffer.from(text, "utf8"), this.sendPort, this.host, (e) => e && this.log(`dcs link send: ${e.message}`));
  }

  receive(text) {
    const msg = parse(text);
    if (!msg) return;
    this.lastHeard = Date.now();
    if (!this.connected) {
      this.connected = true;
      this.emit("status");
    }
    switch (msg.type) {
      case "hello":
        if (msg.unit !== this.unit) {
          this.unit = msg.unit;
          this.values.clear();
          this.texts.clear();
          this.flight = { agl: null, ias: null, gs: null };
          this.emit("unit", this.unit);
        }
        // Re-send what we watch on every hello: the hook may have restarted with a new mission.
        this.sendWatch();
        break;
      case "args": {
        const changed = new Set();
        for (const [arg, value] of msg.values) {
          if (this.values.get(arg) !== value) changed.add(arg);
          this.values.set(arg, value);
        }
        if (changed.size) this.emit("values", changed);
        break;
      }
      case "text":
        if (this.texts.get(msg.id) !== msg.text) {
          this.texts.set(msg.id, msg.text);
          this.emit("text", msg.id);
        }
        break;
      case "flight":
        this.flight = { agl: msg.agl, ias: msg.ias, gs: msg.gs };
        this.emit("flight", this.flight);
        break;
      case "log":
        this.log(`dcs: ${msg.text}`);
        this.emit("log", msg.text);
        break;
      case "scanned":
        this.emit("scanned", msg);
        break;
    }
  }

  checkAlive() {
    if (this.connected && Date.now() - this.lastHeard > TIMEOUT_MS) {
      this.connected = false;
      if (this.unit !== null) {
        this.unit = null;
        this.emit("unit", null);
      }
      this.values.clear();
      this.emit("status");
    }
  }

  // Watch exactly these arguments and indicators; only sends when the sets change (or on hello).
  watch(args, texts = []) {
    const a = new Set([...args].filter(Number.isFinite));
    const t = new Set([...texts].map(String).filter(Boolean));
    const same = (x, y) => x.size === y.size && [...x].every((v) => y.has(v));
    if (same(a, this.watched) && same(t, this.watchedTexts)) return;
    const added = [...a].some((v) => !this.watched.has(v));
    this.watched = a;
    this.watchedTexts = t;
    this.sendWatch();
    if (added) this.send(encode.resync());
  }

  sendWatch() {
    this.send(encode.watch(this.watched));
    this.send(encode.watchText(this.watchedTexts));
  }

  click(device, action, value) { this.send(encode.click(device, action, value)); }
  keyCommand(command, value) { this.send(encode.key(command, value)); }
  requestScan(dir) { this.send(encode.scan(dir)); }
  dumpIndicators() { this.send(encode.dump()); }
}

module.exports = { DcsLink, TIMEOUT_MS };
