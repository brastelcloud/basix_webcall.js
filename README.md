# basix_webcall.js

A browser JavaScript library for one audio call to the Basix IP-PBX using SIP.js.
Each instance connects, dials once, then closes its SIP WebSocket and releases
its media resources when the call ends. It does not register a SIP extension.

Install with `npm install`, then import the library in your browser application
using a CommonJS-compatible bundler. It uses the same pinned SIP.js 0.13.8 fork
as `basix_webphone.js`.
Its transitive `crypto-js` dependency is overridden to version 4.2 or later.
An internal transport adapter supports credentials in the WebSocket URL, which
the legacy SIP.js URL validator otherwise rejects.

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
`ws_ticket` is used as the password in
`wss://ws_ticket:<encoded ticket>@bcs.brastel.com/basix/api/ws_sip`.
The destination is a string of digits, optionally including `+`, `*`, or `#`;
leading zeroes are preserved. Calls use `sip:<destination>@anything`, matching
the PBX routing convention used by the webphone.

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

Run `npm test` for lifecycle tests with mocked SIP and browser objects. A live
browser call with a valid ticket is still needed to verify PBX routing, microphone
permissions, and two-way audio.
