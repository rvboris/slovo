import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type RuntimeStatus = {
  kind: string;
  message?: string;
  elapsedSeconds?: number;
};

const indicatorElement =
  document.querySelector<HTMLElement>(".recording-indicator");
const recordingStateElement =
  document.querySelector<HTMLElement>("#recording-state");
const errorStateElement = document.querySelector<HTMLElement>("#error-state");
const timeElement = document.querySelector<HTMLTimeElement>("#recording-time");

if (
  !indicatorElement ||
  !recordingStateElement ||
  !errorStateElement ||
  !timeElement
) {
  throw new Error("Missing recording overlay elements");
}

const indicator = indicatorElement;
const recordingState = recordingStateElement;
const errorState = errorStateElement;
const time = timeElement;
const voiceLevel = document.querySelector<HTMLElement>("#voice-level");

let startedAt = performance.now();
let offsetSeconds = 0;
let timer: number | undefined;

function render(seconds: number): void {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60).toString().padStart(2, "0");
  const remainder = (total % 60).toString().padStart(2, "0");
  time.textContent = `${minutes}:${remainder}`;
  time.dateTime = `PT${total}S`;
}

function start(elapsedSeconds = 0): void {
  offsetSeconds = elapsedSeconds;
  startedAt = performance.now();
  render(offsetSeconds);
  if (timer !== undefined) window.clearInterval(timer);
  timer = window.setInterval(() => {
    render(offsetSeconds + (performance.now() - startedAt) / 1000);
  }, 250);
}

function stop(): void {
  if (timer !== undefined) window.clearInterval(timer);
  timer = undefined;
  render(0);
}

function showRecording(elapsedSeconds = 0): void {
  indicator.classList.remove("is-loading", "is-error");
  recordingState.hidden = false;
  errorState.hidden = true;
  start(elapsedSeconds);
}

function showError(): void {
  stop();
  recordingState.hidden = true;
  errorState.hidden = false;
  indicator.classList.remove("is-loading");
  indicator.classList.add("is-error");
  resetVoiceLevel();
}

function applyStatus(payload: RuntimeStatus): void {
  if (payload.kind === "recording") {
    showRecording(payload.elapsedSeconds ?? 0);
  } else if (payload.kind === "error") {
    showError();
  } else {
    stop();
    resetVoiceLevel();
  }
}

// ponytail: EMA smoothing — one-pole filter, ~150ms time constant at the
// ~60fps event rate backend emits. Cheaper than a ring buffer and hides
// mic jitter without a visible lag. Tune ALPHA up for snappier response.
const LEVEL_ALPHA = 0.18;
let smoothedLevel = 0;

function resetVoiceLevel(): void {
  smoothedLevel = 0;
  if (voiceLevel) voiceLevel.style.setProperty("--lvl", "0%");
}

type AudioLevelPayload = { level?: unknown };

function pushVoiceLevel(raw: number): void {
  // Only react while the recording dot is on screen; ignore stray events
  // during error/idle so the meter never lies about state.
  if (recordingState.hidden) return;

  if (voiceLevel) {
    const target = Math.min(1, Math.max(0, raw));
    smoothedLevel = smoothedLevel + (target - smoothedLevel) * LEVEL_ALPHA;
    // Quantize to 2% steps: enough resolution to feel alive, few enough to
    // let the CSS transition paper over the remaining jitter cheaply.
    voiceLevel.style.setProperty(
      "--lvl",
      `${Math.round(smoothedLevel * 50) * 2}%`,
    );
  }
}

void listen<AudioLevelPayload>("slovo://audio-level", ({ payload }) => {
  const level =
    payload && typeof payload === "object" && "level" in payload
      ? typeof payload.level === "number"
        ? payload.level
        : 0
      : 0;
  pushVoiceLevel(level);
});

let receivedLiveStatus = false;

void listen<RuntimeStatus>("slovo://status", ({ payload }) => {
  receivedLiveStatus = true;
  applyStatus(payload);
});

void invoke<RuntimeStatus>("get_status")
  .then((payload) => {
    if (!receivedLiveStatus) applyStatus(payload);
  })
  .catch(() => {
    if (!receivedLiveStatus) showRecording();
  });
