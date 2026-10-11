# basix_webcall.js

A browser JavaScript library for one audio call to the Basix IP-PBX using SIP.js.
Each instance connects, dials once, then closes its SIP WebSocket and releases
its media resources when the call ends. It does not register a SIP extension.

Install with `npm install`, then import the library in your browser application
using a CommonJS-compatible bundler. It uses the same pinned SIP.js 0.13.8 fork
as `basix_webphone.js`.
Its transitive `crypto-js` dependency is overridden to version 4.2 or later.

```javascript
const BasixWebCall = require("basix_webcall");

const call = new BasixWebCall();
call.on("progress", response => console.log("Call progress", response.statusCode));
call.on("accepted", () => console.log("Call answered"));
call.on("ended", ({ cause, error }) => console.log("Call ended", cause, error));
call.on("audioError", error => console.log("Audio playback needs attention", error));

// Run from a Call button handler on an HTTPS page.
async function onCallButtonClick(ws_ticket) {
  try {
    await call.start({ ws_ticket, destination: "0312341234" });
    // The call has ended and the SIP transport has closed.
  } catch (error) {
    console.error("Unable to complete the call", error);
  }
}

// Run from a Hang up button handler.
function onHangupButtonClick() {
  call.hangup();
}
```

`start({ ws_ticket, destination, audioElement? })` returns a promise that resolves
with `{ cause }` after shutdown, or rejects for connection, microphone, or call
failures (including busy/rejected calls). Use a new instance for each call.
`ws_ticket` is passed as the URL-encoded `ticket` query parameter in
`wss://bcs.brastel.com/basix/api/ws_sip?ticket=<encoded ticket>`.
The SIP INVITE also includes `X-DestTicket: <ticket>` with the same original
ticket value. Tickets must not contain whitespace or control characters.
Optional `basix_base_url` changes the HTTP base URL used to derive the WebSocket
endpoint (default `https://bcs.brastel.com/basix`). It must use HTTPS.
The destination is a string of digits, optionally including `+`, `*`, or `#`;
leading zeroes are preserved. Calls use `sip:<destination>@anything`, matching
the PBX routing convention used by the webphone.
The Request-URI and To header use the actual destination; the ticket is carried
separately in `X-DestTicket`.
SIP.js creates the WebRTC offer with `voiceActivityDetection: false` to request
that browser silence suppression be disabled. This does not disable Gemini or
Pipecat VAD. Verify negotiated SDP and media flow when diagnosing audio delays,
because behavior depends on the browser and receiving media server.

See [sample_app](sample_app/README.md) for a Node web app that obtains tickets
on the server and places calls from the browser.

The live browser test helper lives in
`/usr/local/src/git/brastel/basix_tests/browser_webcall`. It runs this library
in headless Chromium and is used by
`basix/centrex/tests/functional_new2/cti.basix_webcall.test.js` to verify a real
call, audio RTP in both directions, DTMF, and WebSocket closure. See the helper's
README for its one-time dependency and Chromium installation.

The library creates and removes an autoplay audio element by default. You may
supply an existing audio element; it is paused and detached during cleanup but
not removed. If the browser blocks playback, handle `audioError` by showing a
button that calls `call.audio.play()` while the call is active. Microphone access
requires HTTPS (or localhost) and the user's permission.

Events: `connected` (transport ready and INVITE created), `progress` (SIP
provisional response), `accepted` (answered), `audioError` (playback failure),
and `ended` (`{ cause, error }` after cleanup). `call.state` is one of `idle`,
`connecting`, `calling`, `talking`, `closing`, or `ended`.

`hangup()` cancels setup or hangs up an answered call and returns the same
completion promise. It is safe to call repeatedly. Leaving the page also triggers
hangup. Connection setup has a ten-second limit; shutdown allows five seconds for
SIP transactions before forcing transport closure. Automatic reconnect is disabled.
The library terminates its own connection and resources; it does not close the
browser tab.

`sendDTMF(key)` sends one `0`–`9`, `*`, or `#` digit to an answered call for IVR
interaction. It throws if the digit is invalid or the call is not in `talking`
state. It uses WebRTC RTP telephone-event DTMF, with SIP.js's INFO fallback when
the browser cannot send RTP DTMF.

Run `npm test` for lifecycle tests with mocked SIP and browser objects. A live
browser call with a valid ticket is still needed to verify PBX routing, microphone
permissions, and two-way audio.
