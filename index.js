"use strict";

const EventEmitter = require("events");
const SIP = require("sip.js");

class CallTransport extends SIP.Web.Transport {
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
    this._pendingMessages = new Set();
    this._onPageHide = () => this.hangup();
  }

  /** Resolve after the call ends and transport closes; reject on failure. */
  start(args = {}) {
    if (this.state !== "idle") {
      return Promise.reject(new Error("This instance has already been used"));
    }
    if (typeof args.ws_ticket !== "string" || !args.ws_ticket || /[\x00-\x20\x7f]/.test(args.ws_ticket)) {
      return Promise.reject(new TypeError("ws_ticket must be a non-empty string without whitespace or control characters"));
    }
    if (typeof args.destination !== "string" ||
        !/^[+0-9*#]+$/.test(args.destination)) {
      return Promise.reject(new TypeError("destination must be a dial string"));
    }
    let endpoint;
    try {
      endpoint = new URL(args.basix_base_url || "https://bcs.brastel.com/basix");
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw new Error("invalid endpoint");
      }
      endpoint.protocol = "wss:";
      endpoint.pathname = endpoint.pathname.replace(/\/$/, "") + "/api/ws_sip";
      endpoint.searchParams.set("ticket", args.ws_ticket);
    } catch (_) {
      return Promise.reject(new TypeError("basix_base_url must be an HTTPS URL without credentials, query, or fragment"));
    }
    this.state = "connecting";
    this._destination = args.destination;
    this._wsTicket = args.ws_ticket;
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
        transportConstructor: CallTransport,
        transportOptions: {
          wsServers: endpoint.href,
          maxReconnectionAttempts: 0,
          // SIP.js 0.13 uses seconds for this value.
          connectionTimeout: 10,
        },
        register: false,
        autostart: false,
        autostop: false,
        noAnswerTimeout: 180,
        // Send IVR digits over the negotiated WebRTC telephone-event media.
        // SIP.js falls back to INFO if the browser has no RTP DTMF sender.
        dtmfType: "rtp",
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
      // SIP.js delivers MESSAGE at the UA and automatically replies 200.
      this._listen(this.ua, "message", message => {
        const request = message.request;
        const dialog = this.session && this.session.dialog;
        if (this.state !== "talking" || !dialog || !request ||
            request.callId !== dialog.id.callId ||
            request.fromTag !== dialog.id.remoteTag ||
            request.toTag !== dialog.id.localTag) return;
        this.emit("message", {
          body: message.body || "",
          contentType: message.contentType || "text/plain",
          request,
        });
      });
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

  /** Send one keypad digit using RTP DTMF (SIP.js INFO fallback). */
  sendDTMF(key) {
    if (typeof key !== "string" || !/^[0-9*#]$/.test(key)) {
      throw new TypeError("DTMF key must be one digit, * or #");
    }
    if (this.state !== "talking" || !this.session) {
      throw new Error("DTMF requires an answered call");
    }
    return this.session.dtmf(key);
  }

  /** Send MESSAGE in the answered call's dialog; resolve on a 2xx response. */
  sendMessage(body, { contentType = "text/plain" } = {}) {
    if (typeof body !== "string") {
      return Promise.reject(new TypeError("MESSAGE body must be a string"));
    }
    if (typeof contentType !== "string" || /[\x00-\x1f\x7f]/.test(contentType) ||
        !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?: *;.+)?$/i.test(contentType)) {
      return Promise.reject(new TypeError("MESSAGE contentType must be a MIME type without control characters"));
    }
    if (this.state !== "talking" || !this.session || !this.session.dialog) {
      return Promise.reject(new Error("MESSAGE requires an answered call"));
    }
    const session = this.session;
    const dialog = session.dialog;
    return new Promise((resolve, reject) => {
      const settle = (error, response) => {
        if (!this._pendingMessages.delete(settle)) return;
        if (error) reject(error);
        else resolve(response);
      };
      this._pendingMessages.add(settle);
      try {
        // Build with toUri explicitly: this pinned SIP.js has a ToUri typo in
        // Session.sendRequest(), which otherwise substitutes the Contact URI.
        const request = new SIP.OutgoingRequest("MESSAGE", dialog.remoteTarget, session.ua, {
          cseq: ++dialog.localSeqnum,
          callId: dialog.id.callId,
          fromUri: dialog.localUri,
          fromTag: dialog.id.localTag,
          toUri: dialog.remoteUri,
          toTag: dialog.id.remoteTag,
          routeSet: dialog.routeSet,
        }, [`Content-Type: ${contentType}`], body);
        request.dialog = dialog;
        new SIP.RequestSender({
          request,
          onRequestTimeout: () => settle(new Error("SIP MESSAGE timed out")),
          onTransportError: () => settle(new Error("SIP MESSAGE transport failed")),
          receiveResponse: response => {
            if (response.statusCode < 200) return;
            if (response.statusCode < 300) settle(null, response);
            else {
              const error = new Error(`SIP MESSAGE rejected: ${response.statusCode}`);
              error.statusCode = response.statusCode;
              error.response = response;
              settle(error);
            }
          },
        }, session.ua).send();
      } catch (error) {
        settle(error);
      }
    });
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
        extraHeaders: [`X-DestTicket: ${this._wsTicket}`],
        sessionDescriptionHandlerOptions: {
          constraints: { audio: true, video: false },
          // Request continuous audio rather than WebRTC silence suppression.
          RTCOfferOptions: { voiceActivityDetection: false },
        },
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
    for (const settle of this._pendingMessages) settle(new Error("Call ended before SIP MESSAGE completed"));
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
    this._wsTicket = null;
    this.audio = null;
    if (this._error) this._reject(this._error);
    else this._resolve(this._result);
    this.emit("ended", { ...this._result, error: this._error });
  }
}

module.exports = BasixWebCall;
