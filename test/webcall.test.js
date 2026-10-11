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
      session.dtmfKeys = [];
      session.dtmf = key => { session.dtmfKeys.push(key); };
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
  mod.require = name => name === "sip.js" ? { ...require("sip.js"), UA } : require(name);
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
    "wss://bcs.brastel.com/basix/api/ws_sip?ticket=test%3Aticket%2F%40");
  const wsUrl = new URL(ua.config.transportOptions.wsServers);
  assert.equal(wsUrl.username, "");
  assert.equal(wsUrl.password, "");
  assert.equal(wsUrl.searchParams.get("ticket"), args.ws_ticket);
  assert.equal(ua.config.register, false);
  assert.equal(ua.config.transportOptions.maxReconnectionAttempts, 0);
  assert.equal(ua.config.dtmfType, "rtp");
  assert.equal(ua.calls.length, 0);
  ua.transport.emit("connected");
  ua.transport.emit("connected");
  assert.equal(ua.calls.length, 1);
  assert.equal(ua.calls[0].target, "sip:0312341234@anything");
  assert.equal(ua.calls[0].options.sessionDescriptionHandlerOptions.RTCOfferOptions.voiceActivityDetection, false);
  assert.deepEqual(ua.calls[0].options.extraHeaders, [`X-DestTicket: ${wsUrl.searchParams.get("ticket")}`]);
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
  await assert.rejects(call.start({ ...args, ws_ticket: "ticket\r\nX-Injected: value" }), /ws_ticket/);
  assert.equal(uas.length, 0);
  assert.equal(call.state, "idle");
});

test("sends keypad tones only during an answered call", async t => {
  const { call, uas } = setup(t);
  assert.throws(() => call.sendDTMF("1"), /answered call/);
  const completion = call.start(args);
  uas[0].transport.emit("connected");
  assert.throws(() => call.sendDTMF("1"), /answered call/);
  const session = uas[0].calls[0].session;
  session.emit("accepted", {});
  for (const key of "123456789*0#") call.sendDTMF(key);
  assert.deepEqual(session.dtmfKeys, [..."123456789*0#"]);
  for (const key of ["12", "A", "", 1]) assert.throws(() => call.sendDTMF(key), /DTMF key/);
  call.hangup();
  await completion;
  assert.throws(() => call.sendDTMF("1"), /answered call/);
});

test("real SIP.js DTMF sends IVR digits through the WebRTC media handler", async t => {
  const { call, uas } = setup(t);
  const completion = call.start(args);
  uas[0].transport.emit("connected");
  const session = uas[0].calls[0].session;
  const { Session } = require("sip.js/lib/Session");
  const { SessionStatus } = require("sip.js/lib/Enums");
  const sent = [];
  session.ua = { configuration: uas[0].config };
  session.status = SessionStatus.STATUS_CONFIRMED;
  session.sessionDescriptionHandler.sendDtmf = (tones, options) => {
    sent.push(tones);
    return true;
  };
  session.dtmf = Session.prototype.dtmf;
  session.emit("accepted", {});
  for (const key of "1*#") call.sendDTMF(key);
  assert.deepEqual(sent, ["1", "*", "#"]);
  assert.equal(session.tones, undefined); // No SIP INFO tone queue was used.
  call.hangup();
  await completion;
});

test("dials the actual destination with a configured Basix server", async t => {
  const { call, uas } = setup(t);
  const completion = call.start({ ...args,
    destination: "0312341234",
    basix_base_url: "https://qabcs.brastel.com/basix/",
  });
  assert.equal(uas[0].config.transportOptions.wsServers,
    "wss://qabcs.brastel.com/basix/api/ws_sip?ticket=test%3Aticket%2F%40");
  uas[0].transport.emit("connected");
  assert.equal(uas[0].calls[0].target, "sip:0312341234@anything");
  assert.deepEqual(uas[0].calls[0].options.extraHeaders, [`X-DestTicket: ${args.ws_ticket}`]);
  call.hangup();
  await completion;
});

test("rejects unsafe or non-HTTPS Basix endpoints", async t => {
  const { call, uas } = setup(t);
  for (const basix_base_url of ["http://example.com", "https://user:secret@example.com", "https://example.com?secret=x"]) {
    await assert.rejects(call.start({ ...args, basix_base_url }), /HTTPS URL/);
  }
  assert.equal(uas.length, 0);
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

// Use the pinned SIP.js request serializer and transaction machinery, with only
// the transport replaced, to check the actual dialog headers on the wire.
function messageCall(t) {
  const fixture = setup(t);
  fixture.completion = fixture.call.start(args);
  fixture.uas[0].transport.emit("connected");
  const session = fixture.call.session;
  const SIP = require("sip.js");
  const ua = new SIP.UA({ uri: "webcall@anything", autostart: false, register: false,
    log: { builtinEnabled: false } });
  const sent = [];
  ua.transport = { send: message => { sent.push(message); return Promise.resolve(); } };
  session.ua = ua;
  session.dialog = {
    localSeqnum: 123,
    id: { callId: "existing-call-id", localTag: "local-tag", remoteTag: "remote-tag" },
    localUri: SIP.Utils.normalizeTarget("sip:webcall@anything"),
    remoteUri: SIP.Utils.normalizeTarget("sip:0312341234@anything"),
    remoteTarget: SIP.Utils.normalizeTarget("sip:contact@pbx.example.com"),
    routeSet: ["<sip:proxy.example.com;lr>"],
  };
  const transactions = () => Object.values(ua.transactions.nict);
  t.after(() => {
    for (const transaction of transactions()) transaction.dispose();
    fixture.call.hangup();
  });
  session.emit("accepted", {});
  return { ...fixture, sent, transactions };
}

test("SIP MESSAGE uses the existing dialog and resolves only on final success", async t => {
  const { call, sent, transactions, completion } = messageCall(t);
  const pending = call.sendMessage("Hello 日本語");
  assert.equal(sent.length, 1);
  const wire = sent[0];
  assert.ok(wire.startsWith("MESSAGE sip:contact@pbx.example.com SIP/2.0\r\n"));
  assert.ok(wire.includes("To: <sip:0312341234@anything>;tag=remote-tag\r\n"));
  assert.ok(wire.includes("From: <sip:webcall@anything>;tag=local-tag\r\n"));
  assert.ok(wire.includes("Call-ID: existing-call-id\r\n"));
  assert.ok(wire.includes("Route: <sip:proxy.example.com;lr>\r\n"));
  assert.ok(wire.includes("CSeq: 124 MESSAGE\r\n"));
  assert.ok(wire.includes("Content-Type: text/plain\r\n"));
  assert.ok(wire.includes(`Content-Length: ${Buffer.byteLength("Hello 日本語")}\r\n`));
  assert.ok(wire.endsWith("\r\n\r\nHello 日本語"));
  let settled = false;
  pending.then(() => { settled = true; });
  transactions()[0].receiveResponse({ statusCode: 100, method: "MESSAGE" });
  await Promise.resolve();
  assert.equal(settled, false);
  const response = { statusCode: 200, method: "MESSAGE" };
  transactions()[0].receiveResponse(response);
  assert.equal(await pending, response);
  assert.equal(call.state, "talking");
  const json = call.sendMessage('{"action":"hello"}', { contentType: "application/json" });
  assert.ok(sent[1].includes("CSeq: 125 MESSAGE\r\n"));
  assert.ok(sent[1].includes("Content-Type: application/json\r\n"));
  transactions().at(-1).receiveResponse({ statusCode: 202, method: "MESSAGE" });
  await json;
  call.hangup();
  await completion;
  await assert.rejects(call.sendMessage("after hangup"), /answered call/);
});

test("SIP MESSAGE validates body, content type, and answered-call state", async t => {
  const { call, uas } = setup(t);
  await assert.rejects(call.sendMessage("before start"), /answered call/);
  const completion = call.start(args);
  uas[0].transport.emit("connected");
  await assert.rejects(call.sendMessage("before answer"), /answered call/);
  for (const body of [null, {}, 123]) await assert.rejects(call.sendMessage(body), /body must be a string/);
  for (const contentType of [null, "", "text", "text/plain\r\nX-Injected: value"]) {
    await assert.rejects(call.sendMessage("hello", { contentType }), /contentType/);
  }
  call.hangup();
  await completion;
});

test("SIP MESSAGE rejection, timeout, transport error and hangup settle pending requests", async t => {
  const { call, transactions, completion } = messageCall(t);
  const rejected = call.sendMessage("rejected");
  transactions().at(-1).receiveResponse({ statusCode: 405, method: "MESSAGE" });
  await assert.rejects(rejected, error => error.statusCode === 405 && error.response.statusCode === 405);
  const timedOut = call.sendMessage("timeout");
  transactions().at(-1).timer_F();
  await assert.rejects(timedOut, /timed out/);
  const transportFailed = call.sendMessage("transport error");
  transactions().at(-1).onTransportError(new Error("offline"));
  await assert.rejects(transportFailed, /transport failed/);
  assert.equal(call.state, "talking");
  const first = call.sendMessage("one");
  const second = call.sendMessage("two");
  call.hangup();
  await assert.rejects(first, /Call ended/);
  await assert.rejects(second, /Call ended/);
  await completion;
  assert.equal(call._pendingMessages.size, 0);
});

test("incoming MESSAGE callbacks are limited to the active call dialog and removed on shutdown", async t => {
  const { call, uas } = setup(t);
  const received = [];
  call.on("message", message => received.push(message));
  const completion = call.start(args);
  const ua = uas[0];
  ua.transport.emit("connected");
  call.session.dialog = { id: { callId: "call-id", localTag: "local", remoteTag: "remote" } };
  const request = { callId: "call-id", fromTag: "remote", toTag: "local" };
  const message = { request, body: "Hello 日本語", contentType: "text/plain; charset=utf-8" };
  ua.emit("message", message); // Still ringing.
  assert.equal(received.length, 0);
  call.session.emit("accepted", {});
  for (const changed of [{ callId: "other" }, { fromTag: "other" }, { toTag: "other" }, { toTag: undefined }]) {
    ua.emit("message", { ...message, request: { ...request, ...changed } });
  }
  assert.equal(received.length, 0);
  ua.emit("message", message);
  assert.deepEqual(received, [{ body: message.body, contentType: message.contentType, request }]);
  ua.emit("message", { request });
  assert.deepEqual(received[1], { body: "", contentType: "text/plain", request });
  assert.equal(call.state, "talking");
  call.hangup();
  await completion;
  ua.emit("message", message);
  assert.equal(received.length, 2);
  assert.equal(ua.listenerCount("message"), 0);
});

test("pinned SIP.js acknowledges an incoming in-dialog MESSAGE and delivers its body to the callback", async t => {
  const { call, uas, sent, completion } = messageCall(t);
  const SIP = require("sip.js");
  const session = call.session;
  const ua = session.ua;
  const dialog = session.dialog;
  dialog.owner = session;
  dialog.checkInDialogRequest = SIP.Dialog.prototype.checkInDialogRequest;
  dialog.receiveRequest = SIP.Dialog.prototype.receiveRequest;
  session.receiveRequest = SIP.Session.prototype.receiveRequest;
  ua.dialogs[dialog.id.callId + dialog.id.localTag + dialog.id.remoteTag] = dialog;
  ua.on("message", message => uas[0].emit("message", message));
  t.after(() => Object.values(ua.transactions.nist).forEach(transaction => transaction.dispose()));
  const body = JSON.stringify({ text: "Hello 日本語" });
  const wire = [
    "MESSAGE sip:webcall@anything SIP/2.0",
    "Via: SIP/2.0/WSS pbx.example.com;branch=z9hG4bK-incoming-message",
    "Max-Forwards: 70",
    "From: <sip:0312341234@anything>;tag=remote-tag",
    "To: <sip:webcall@anything>;tag=local-tag",
    "Call-ID: existing-call-id",
    "CSeq: 200 MESSAGE",
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "", body,
  ].join("\r\n");
  const request = SIP.Parser.parseMessage(wire, ua);
  assert.ok(request);
  const received = [];
  call.on("message", message => received.push(message));
  ua.receiveRequest(request);
  assert.equal(received.length, 1);
  assert.equal(received[0].body, body);
  assert.equal(received[0].contentType, "application/json");
  assert.equal(received[0].request, request);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].startsWith("SIP/2.0 200 OK\r\n"));
  assert.ok(sent[0].includes("CSeq: 200 MESSAGE\r\n"));
  assert.equal(call.state, "talking");
  call.hangup();
  await completion;
});
