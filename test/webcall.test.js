"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("events");
const Module = require("module");
const fs = require("node:fs");
const path = require("node:path");

// Inject SIP at the module boundary; exercise the public API and lifecycle.
function setup(t, { delayedClose = false, inviteError = false, realTransport = false } = {}) {
  const uas = [];
  const sockets = [];
  class WebSocket extends EventEmitter {
    constructor(url) { super(); this.url = url; sockets.push(this); }
    addEventListener(name, cb) { this.on(name, cb); }
    removeEventListener(name, cb) { this.removeListener(name, cb); }
    close() {
      this.closed = true;
      queueMicrotask(() => this.emit("close", { code: 1000 }));
    }
    send() {}
  }
  class UA extends EventEmitter {
    constructor(config) {
      super();
      this.config = config;
      if (realTransport) {
        this.transport = new config.transportConstructor(
          { log() {}, warn() {}, error() {}, debug() {} }, config.transportOptions
        );
      } else {
        this.transport = new EventEmitter();
        this.transport.disconnect = () => {
          this.transport.emit("disconnected");
          return Promise.resolve();
        };
      }
      this.calls = [];
      this.stops = 0;
      uas.push(this);
    }
    start() {
      this.emit("transportCreated", this.transport);
      if (realTransport) this.transport.connect().catch(() => {});
    }
    invite(target, options) {
      if (inviteError) throw new Error("invite failed");
      const session = new EventEmitter();
      session.sessionDescriptionHandler = {
        peerConnection: { getReceivers: () => [{ track: { id: "remote" } }] },
        close: () => { session.mediaClosed = true; },
      };
      this.calls.push({ target, options, session });
      return session;
    }
    stop() {
      this.stops++;
      if (this.calls[0]) this.calls[0].session.emit("terminated");
      if (realTransport) this.transport.disconnect().catch(() => {});
      else if (!delayedClose) this.transport.emit("disconnected");
    }
  }
  const filename = path.resolve(__dirname, "../index.js");
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  mod.require = name => name === "sip.js" ? { UA, Web: require("sip.js").Web } : require(name);
  mod._compile(fs.readFileSync(filename, "utf8"), filename);

  const original = { window: global.window, document: global.document, MediaStream: global.MediaStream,
    WebSocket: global.WebSocket };
  const listeners = new Map();
  const audio = {
    srcObject: null, plays: 0, paused: false, removed: false,
    play() { this.plays++; return Promise.resolve(); },
    pause() { this.paused = true; },
    remove() { this.removed = true; },
  };
  global.window = {
    WebSocket,
    addEventListener: (name, cb) => listeners.set(name, cb),
    removeEventListener: name => listeners.delete(name),
  };
  global.WebSocket = WebSocket;
  global.document = { createElement: () => audio, body: { appendChild() {} } };
  global.MediaStream = class {
    constructor() { this.tracks = []; }
    getTracks() { return this.tracks; }
    addTrack(track) { this.tracks.push(track); }
  };
  t.after(() => Object.assign(global, original));
  return { call: new mod.exports(), uas, audio, listeners, sockets };
}

const args = { ws_ticket: "test:ticket/@", destination: "0312341234" };

test("connects with ticket, dials exactly once, plays audio, closes after remote hangup", async t => {
  const { call, uas, audio, listeners } = setup(t);
  let ended = 0;
  call.on("ended", () => ended++);
  const completion = call.start(args);
  const ua = uas[0];
  assert.equal(ua.config.transportOptions.wsServers,
    "wss://ws_ticket:test%3Aticket%2F%40@bcs.brastel.com/basix/api/ws_sip");
  assert.equal(ua.config.register, false);
  assert.equal(ua.config.transportOptions.maxReconnectionAttempts, 0);
  assert.equal(ua.calls.length, 0);
  ua.transport.emit("connected");
  ua.transport.emit("connected");
  assert.equal(ua.calls.length, 1);
  assert.equal(ua.calls[0].target, "sip:0312341234@anything");
  const session = ua.calls[0].session;
  session.emit("trackAdded");
  session.emit("accepted", {});
  assert.equal(call.state, "talking");
  assert.equal(audio.srcObject.getTracks().length, 1);
  assert.ok(audio.plays > 0);
  session.emit("terminated", {}, "BYE");
  assert.deepEqual(await completion, { cause: "BYE" });
  assert.equal(call.state, "ended");
  assert.equal(ua.stops, 1);
  assert.equal(ended, 1);
  assert.ok(audio.paused && audio.removed && session.mediaClosed);
  assert.equal(audio.srcObject, null);
  assert.equal(listeners.size, 0);
  assert.equal(ua.transport.listenerCount("connected"), 0);
  await assert.rejects(call.start(args), /already been used/);
});

test("completion waits for transport closure and repeated hangup is harmless", async t => {
  const { call, uas } = setup(t, { delayedClose: true });
  const completion = call.start(args);
  uas[0].transport.emit("connected");
  let settled = false;
  completion.then(() => { settled = true; });
  call.hangup();
  call.hangup();
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(call.state, "closing");
  assert.equal(uas[0].stops, 1);
  uas[0].transport.emit("disconnected");
  await completion;
  assert.equal(call.state, "ended");
});

test("hangup before connection prevents dialing", async t => {
  const { call, uas } = setup(t);
  const completion = call.start(args);
  call.hangup();
  uas[0].transport.emit("connected");
  await completion;
  assert.equal(uas[0].calls.length, 0);
});

test("failed/rejected/terminated sequence rejects once and cleans up", async t => {
  const { call, uas } = setup(t);
  const completion = call.start(args);
  uas[0].transport.emit("connected");
  const session = uas[0].calls[0].session;
  session.emit("rejected", { statusCode: 486 }, "Busy");
  session.emit("failed", { statusCode: 486 }, "Busy");
  session.emit("terminated", {}, "Busy");
  await assert.rejects(completion, error => error.statusCode === 486 && error.cause === "Busy");
  assert.equal(uas[0].stops, 1);
});

test("transport failure rejects and never dials", async t => {
  const { call, uas } = setup(t);
  const completion = call.start(args);
  uas[0].transport.emit("transportError");
  await assert.rejects(completion, /connection failed/);
  assert.equal(uas[0].calls.length, 0);
});

test("invite exception closes the connection", async t => {
  const { call, uas } = setup(t, { inviteError: true });
  const completion = call.start(args);
  uas[0].transport.emit("connected");
  await assert.rejects(completion, /invite failed/);
  assert.equal(uas[0].stops, 1);
});

test("pagehide hangs up and preserves supplied audio element", async t => {
  const { call, audio, listeners } = setup(t);
  const completion = call.start({ ...args, audioElement: audio });
  listeners.get("pagehide")();
  await completion;
  assert.ok(audio.paused);
  assert.equal(audio.removed, false);
});

test("invalid parameters do not create a user agent", async t => {
  const { call, uas } = setup(t);
  await assert.rejects(call.start({ destination: args.destination }), /ws_ticket/);
  await assert.rejects(call.start({ ...args, destination: "123@host" }), /destination/);
  assert.equal(uas.length, 0);
  assert.equal(call.state, "idle");
});

test("real pinned SIP.js transport closes promptly despite suppressed disconnected event", async t => {
  const { call, uas, sockets } = setup(t, { realTransport: true });
  const completion = call.start(args);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, uas[0].config.transportOptions.wsServers);
  sockets[0].emit("open");
  assert.equal(uas[0].calls.length, 1);
  let disconnected = false;
  uas[0].transport.on("disconnected", () => { disconnected = true; });
  call.hangup();
  await completion;
  assert.equal(disconnected, false);
  assert.ok(sockets[0].closed);
  assert.equal(call.state, "ended");
});

test("real transport can close while WebSocket is still connecting", async t => {
  const { call, sockets } = setup(t, { realTransport: true });
  const completion = call.start(args);
  await new Promise(resolve => setImmediate(resolve));
  call.hangup();
  await completion;
  assert.ok(sockets[0].closed);
  assert.equal(call.state, "ended");
});
