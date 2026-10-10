"use strict";

const BasixWebCall = require("basix_webcall");
const form = document.querySelector("#call-form");
const destination = document.querySelector("#destination");
const peerName = document.querySelector("#peer-name");
const callButton = document.querySelector("#call-button");
const hangupButton = document.querySelector("#hangup-button");
const clearButton = document.querySelector("#clear-button");
const backspaceButton = document.querySelector("#backspace-button");
const playButton = document.querySelector("#play-audio-button");
const audio = document.querySelector("#remote-audio");
const status = document.querySelector("#status");
const keypad = document.querySelector("#keypad");
const keypadHint = document.querySelector("#keypad-hint");
let activeCall = null;
let request = null;
let keypadAudio = null;
let pageClosing = false;
const pressTimers = new Map();
let heartbeatTimer = null;
let heartbeatRequest = null;

async function heartbeat() {
  if (heartbeatRequest) return;
  const controller = new AbortController();
  heartbeatRequest = controller;
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    await fetch("./api/health", { cache: "no-store", signal: controller.signal });
  } catch (_) {
    // Retry on the next interval without interrupting calls or their status.
  } finally {
    clearTimeout(timeout);
    if (heartbeatRequest === controller) heartbeatRequest = null;
  }
}

function startHeartbeat() {
  if (heartbeatTimer !== null) return;
  heartbeat();
  heartbeatTimer = setInterval(heartbeat, 5 * 60 * 1000);
}

startHeartbeat();
window.addEventListener("pageshow", () => { pageClosing = false; startHeartbeat(); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") heartbeat();
});
const toneFrequencies = {
  "1": [697, 1209], "2": [697, 1336], "3": [697, 1477],
  "4": [770, 1209], "5": [770, 1336], "6": [770, 1477],
  "7": [852, 1209], "8": [852, 1336], "9": [852, 1477],
  "*": [941, 1209], "0": [941, 1336], "#": [941, 1477],
};

async function toneContext() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext || pageClosing) return null;
  if (!keypadAudio) keypadAudio = new AudioContext();
  if (keypadAudio.state === "suspended") await keypadAudio.resume();
  return keypadAudio && keypadAudio.state === "running" && !pageClosing ? keypadAudio : null;
}

function scheduleTone(context, frequency, start, duration) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = frequency;
  // Fade feedback tones in and out to avoid audible clicks.
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(0.06, start + 0.005);
  gain.gain.setValueAtTime(0.06, start + duration - 0.02);
  gain.gain.linearRampToValueAtTime(0, start + duration);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  oscillator.start(start);
  oscillator.stop(start + duration);
}

async function playKeyTone(key) {
  const context = await toneContext();
  if (!context) return;
  for (const frequency of toneFrequencies[key]) {
    scheduleTone(context, frequency, context.currentTime, 0.12);
  }
}

async function playDisconnectTone() {
  const context = await toneContext();
  if (!context) return;
  const now = context.currentTime;
  scheduleTone(context, 480, now, 0.15);
  scheduleTone(context, 320, now + 0.2, 0.2);
}

async function playFailureTone() {
  const context = await toneContext();
  if (!context) return;
  const now = context.currentTime;
  for (const delay of [0, 0.3]) {
    scheduleTone(context, 425, now + delay, 0.18);
    scheduleTone(context, 325, now + delay, 0.18);
  }
}

function showKeyPress(button) {
  clearTimeout(pressTimers.get(button));
  button.classList.add("pressed");
  pressTimers.set(button, setTimeout(() => {
    button.classList.remove("pressed");
    pressTimers.delete(button);
  }, 160));
}

function busy(value) {
  destination.disabled = value;
  peerName.disabled = value;
  callButton.disabled = value;
  hangupButton.disabled = !value;
  clearButton.disabled = value;
  backspaceButton.disabled = value;
  keypadHint.textContent = value
    ? "Digits go to the voice menu once the call is answered."
    : "Enter the destination here. During an answered call, digits go to the voice menu.";
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (request || activeCall) return;
  // Unlock feedback audio during the Call click, before asynchronous work.
  toneContext().catch(() => {});
  busy(true);
  playButton.hidden = true;
  status.textContent = "Obtaining a call ticket…";
  const controller = new AbortController();
  request = controller;
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch("./api/ws-ticket", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        destination: destination.value.trim(),
        peer_name: peerName.value,
      }),
      signal: controller.signal,
    });
    const args = await response.json();
    if (!response.ok) throw new Error(args.error || "Could not obtain a call ticket");
    if (controller.signal.aborted) return;
    clearTimeout(timeout);
    request = null;
    const call = new BasixWebCall();
    activeCall = call;
    call.on("connected", () => { status.textContent = "Calling…"; });
    call.on("progress", response => {
      if (response.statusCode === 180) status.textContent = "Ringing…";
    });
    call.on("accepted", () => {
      keypadHint.textContent = "Digits go to the voice menu.";
      status.textContent = "Connected. Your call is in progress.";
    });
    call.on("audioError", () => { playButton.hidden = false; });
    status.textContent = "Connecting…";
    await call.start({ ...args, audioElement: audio });
    playDisconnectTone().catch(() => {});
    status.textContent = "Call ended.";
  } catch (error) {
    status.textContent = controller.signal.aborted ? "Call cancelled or ticket request timed out." : error.message;
    if (controller.signal.reason !== "cancelled") playFailureTone().catch(() => {});
  } finally {
    clearTimeout(timeout);
    request = null;
    activeCall = null;
    playButton.hidden = true;
    busy(false);
  }
});

hangupButton.addEventListener("click", () => {
  status.textContent = "Ending call…";
  hangupButton.disabled = true;
  if (request) request.abort("cancelled");
  if (activeCall) activeCall.hangup().catch(() => {});
});

clearButton.addEventListener("click", () => {
  if (request || activeCall) return;
  destination.setRangeText("", 0, destination.value.length, "end");
  destination.focus();
  status.textContent = "Ready to call.";
});

backspaceButton.addEventListener("click", () => {
  if (request || activeCall) return;
  const start = destination.selectionStart ?? destination.value.length;
  const end = destination.selectionEnd ?? start;
  destination.setRangeText("", start === end ? Math.max(0, start - 1) : start, end, "end");
  destination.focus();
  status.textContent = "Ready to call.";
});

keypad.addEventListener("click", event => {
  const button = event.target.closest("button[data-dtmf]");
  if (!button) return;
  showKeyPress(button);
  playKeyTone(button.dataset.dtmf).catch(error => {
    console.warn("Keypad sound unavailable:", error.name);
  });
  if (!request && !activeCall) {
    const start = destination.selectionStart ?? destination.value.length;
    const end = destination.selectionEnd ?? start;
    if (destination.value.length - (end - start) >= destination.maxLength) return;
    destination.setRangeText(button.dataset.dtmf, start, end, "end");
    destination.focus();
    status.textContent = "Ready to call.";
    return;
  }
  // Keep the dialpad responsive while dialing, without changing a booked
  // destination or sending DTMF before the SIP session is answered.
  if (!activeCall || activeCall.state !== "talking") return;
  try {
    activeCall.sendDTMF(button.dataset.dtmf);
    status.textContent = `Sent ${button.dataset.dtmf}. Your call is in progress.`;
  } catch (error) {
    status.textContent = `Could not send keypad tone: ${error.message}`;
  }
});

playButton.addEventListener("click", async () => {
  try { await audio.play(); playButton.hidden = true; }
  catch (_) { status.textContent = "Audio playback is blocked. Check your browser's permissions."; }
});

window.addEventListener("pagehide", () => {
  pageClosing = true;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  if (heartbeatRequest) {
    heartbeatRequest.abort();
    heartbeatRequest = null;
  }
  if (request) request.abort();
  for (const [button, timer] of pressTimers) {
    clearTimeout(timer);
    button.classList.remove("pressed");
  }
  pressTimers.clear();
  if (keypadAudio) {
    keypadAudio.close().catch(() => {});
    keypadAudio = null;
  }
});
