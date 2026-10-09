"use strict";

const EventEmitter = require("events");
const SIP = require("sip.js");

// SIP.js 0.13's URL parser rejects userinfo, although WebSocket accepts it.
// Validate the endpoint without credentials, then retain the authenticated URL
// for the actual socket. The SIP route still uses the endpoint's host.
class TicketTransport extends SIP.Web.Transport {
  constructor(logger, options) {
    const url = new URL(options.wsServers);
    url.username = "";
    url.password = "";
    super(logger, { ...options, wsServers: url.href });
    this.server.wsUri = options.wsServers;
  }

  connect(options) {
    // UA.start() ignores this promise in 0.13. Report failures through the
    // lifecycle instead of leaving a rejected promise unhandled.
    return super.connect(options).catch(() => this.emit("transportError"));
  }
}

/** One instance owns one outbound call and cannot be restarted. */
class BasixWebCall extends EventEmitter {
  constructor() {
    super();
    this.state = "idle";
    this.ua = null;
    this.session = null;
    this.audio = null;
    this._listeners = [];
    this._finishing = false;
    this._dialed = false;
    this._onPageHide = () => this.hangup();
  }

  /** Resolve after the call ends and transport closes; reject on failure. */
  start(args = {}) {
    if (this.state !== "idle") {
      return Promise.reject(new Error("This instance has already been used"));
    }
    if (typeof args.ws_ticket !== "string" || !args.ws_ticket.trim()) {
      return Promise.reject(new TypeError("ws_ticket must be a non-empty string"));
    }
    if (typeof args.destination !== "string" || !/^[+0-9*#]+$/.test(args.destination)) {
      return Promise.reject(new TypeError("destination must be a dial string"));
    }
    this.state = "connecting";
    this._destination = args.destination;
    this._completion = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });

    try {
      this.audio = args.audioElement || document.createElement("audio");
      this._ownsAudio = !args.audioElement;
      this.audio.autoplay = true;
      if (this._ownsAudio) document.body.appendChild(this.audio);
      window.addEventListener("pagehide", this._onPageHide);

      this.ua = new SIP.UA({
        uri: "webcall@anything",
        transportConstructor: TicketTransport,
        transportOptions: {
          wsServers: `wss://ws_ticket:${encodeURIComponent(args.ws_ticket)}@bcs.brastel.com/basix/api/ws_sip`,
          maxReconnectionAttempts: 0,
          // SIP.js 0.13 uses seconds for this value.
          connectionTimeout: 10,
        },
        register: false,
        autostart: false,
        autostop: false,
        noAnswerTimeout: 180,
        // The configuration contains the ticket; never log it.
        log: { builtinEnabled: false },
        sessionDescriptionHandlerFactoryOptions: {
          constraints: { audio: true, video: false },
          peerConnectionOptions: { iceCheckingTimeout: 500 },
        },
      });
      this._listen(this.ua, "transportCreated", transport => {
        this._transport = transport;
        this._listen(transport, "connected", () => this._dial());
        this._listen(transport, "disconnecting", () => {
          // This fork suppresses 'disconnected' for a requested close.
          // Wait a microtask for SIP.js to assign its disconnection promise.
          Promise.resolve().then(() => transport.disconnect()).then(() => {
            if (this._finishing) this._complete();
          }).catch(() => {}); // The shutdown timer handles a failed disconnect.
        });
        this._listen(transport, "transportError", () => {
          this._finish(new Error("SIP WebSocket connection failed"));
        });
        this._listen(transport, "disconnected", () => {
          if (this._finishing) this._complete();
          else this._finish(new Error("SIP WebSocket disconnected"));
        });
      });
      // This library only originates one call, never accepts incoming calls.
      this._listen(this.ua, "invite", session => session.reject());
      this._connectionTimer = setTimeout(() => {
        this._finish(new Error("SIP WebSocket connection timed out"));
      }, 10000);
      this.ua.start();
    } catch (error) {
      this._finish(error);
    }
    return this._completion;
  }

  /** Cancel dialing or send BYE for an answered call. Safe to call repeatedly. */
  hangup() {
    if (this.state !== "idle") this._finish();
    return this._completion || Promise.resolve();
  }

  _listen(emitter, event, listener) {
    emitter.on(event, listener);
    this._listeners.push(() => emitter.removeListener(event, listener));
  }

  _dial() {
    if (this._dialed || this._finishing) return;
    this._dialed = true;
    clearTimeout(this._connectionTimer);
    this.state = "calling";
    try {
      this.session = this.ua.invite(`sip:${this._destination}@anything`, {
        sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } },
      });
      this._listen(this.session, "progress", response => {
        if (!this._finishing) this.emit("progress", response);
      });
      this._listen(this.session, "accepted", response => {
        if (this._finishing) return;
        this.state = "talking";
        this._attachAudio();
        this.emit("accepted", response);
      });
      this._listen(this.session, "trackAdded", () => this._attachAudio());
      const failed = (response, cause) => {
        this._callError = new Error(`Call failed: ${cause || "unknown cause"}`);
        this._callError.cause = cause;
        this._callError.statusCode = response && response.statusCode;
        // Let SIP.js finish processing its response before stopping the UA.
        Promise.resolve().then(() => this._finish(this._callError));
      };
      this._listen(this.session, "failed", failed);
      this._listen(this.session, "rejected", failed);
      this._listen(this.session, "terminated", (message, cause) => {
        this._finish(this._callError, cause);
      });
    } catch (error) {
      this._finish(error);
      return;
    }
    this.emit("connected");
  }

  _attachAudio() {
    if (this._finishing || !this.session || !this.audio) return;
    const handler = this.session.sessionDescriptionHandler;
    if (!handler || !handler.peerConnection) return;
    try {
      const stream = this.audio.srcObject || new MediaStream();
      const ids = new Set(stream.getTracks().map(track => track.id));
      handler.peerConnection.getReceivers().forEach(({ track }) => {
        if (track && !ids.has(track.id)) stream.addTrack(track);
      });
      this.audio.srcObject = stream;
      const playing = this.audio.play();
      if (playing && playing.catch) {
        playing.catch(error => {
          if (!this._finishing && error.name !== "AbortError") this.emit("audioError", error);
        });
      }
    } catch (error) {
      this.emit("audioError", error);
    }
  }

  _finish(error, cause) {
    if (this._finishing) return;
    this._finishing = true;
    this.state = "closing";
    this._result = { cause: cause || (error && error.cause) || "ended" };
    this._error = error;
    clearTimeout(this._connectionTimer);
    // Allow SIP transactions to finish, then force closure if the PBX is silent.
    this._closeTimer = setTimeout(() => {
      const transport = this._transport;
      if (transport) {
        try {
          Promise.resolve(transport.disconnect({ force: true })).then(
            () => this._complete(),
            () => this._complete()
          );
        } catch (_) {
          this._complete();
        }
      } else this._complete();
    }, 5000);
    try {
      if (this.ua) this.ua.stop();
    } catch (stopError) {
      this._error = this._error || stopError;
    }
    if (!this._transport) this._complete();
  }

  _complete() {
    if (this.state === "ended") return;
    this.state = "ended";
    clearTimeout(this._closeTimer);
    clearTimeout(this._connectionTimer);
    this._listeners.splice(0).forEach(remove => remove());
    if (typeof window !== "undefined") window.removeEventListener("pagehide", this._onPageHide);
    try {
      if (this.audio) {
        this.audio.pause();
        this.audio.srcObject = null;
        if (this._ownsAudio) this.audio.remove();
      }
    } catch (error) {
      this._error = this._error || error;
    }
    try {
      // SIP.js normally closes this on termination; also cover interrupted setup.
      if (this.session && this.session.sessionDescriptionHandler) {
        this.session.sessionDescriptionHandler.close();
      }
    } catch (error) {
      this._error = this._error || error;
    }
    this.session = null;
    this.ua = null;
    this._transport = null;
    this.audio = null;
    if (this._error) this._reject(this._error);
    else this._resolve(this._result);
    this.emit("ended", { ...this._result, error: this._error });
  }
}

module.exports = BasixWebCall;
