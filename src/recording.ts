import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Commands, Events } from "@/lib/ipc";
import { formatElapsed, type StatusPayload } from "@/lib/types";

const indicatorElement = document.querySelector<HTMLElement>(
  ".recording-indicator",
);
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
const canvas = document.querySelector<HTMLCanvasElement>("#voice-canvas");

let startedAt = performance.now();
let offsetSeconds = 0;
let timer: number | undefined;

// EMA smoothing — one-pole filter over the audio-level events the backend
// emits every 80 ms (12.5 Hz). Cheaper than a ring buffer of raw samples and
// hides mic jitter without a visible lag. Tune ALPHA up for snappier.
const LEVEL_ALPHA = 0.18;
const REDUCED_MOTION = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;
const LIGHT_THEME = window.matchMedia("(prefers-color-scheme: light)").matches;

// Ring buffer of smoothed amplitudes — one sample per rAF tick. The buffer
// width matches the canvas columns, so each entry is one vertical slice of
// the scrolling trace. Newest sample at the right edge, scrolling left.
const SAMPLES = 168;
const levels = new Float32Array(SAMPLES);
let smoothedLevel = 0;
let rafId: number | undefined;

type Theme = {
  // Amplitude trace fill gradient stops (top → center → bottom mirrored).
  trace: [string, string, string];
  // Radial glow behind the dot, painted under the trace.
  glow: string;
};

const THEME: Theme = LIGHT_THEME
  ? {
      trace: [
        "rgba(232, 58, 77, 0.0)",
        "rgba(232, 116, 76, 0.55)",
        "rgba(207, 51, 68, 0.0)",
      ],
      glow: "rgba(232, 90, 90, 0.10)",
    }
  : {
      trace: [
        "rgba(255, 138, 92, 0.0)",
        "rgba(255, 77, 94, 0.62)",
        "rgba(255, 60, 110, 0.0)",
      ],
      glow: "rgba(255, 77, 94, 0.16)",
    };

function resetVoiceLevel(): void {
  smoothedLevel = 0;
  levels.fill(0);
  stopVisualizer();
  if (canvas) {
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

type AudioLevelPayload = { level?: unknown };

function pushVoiceLevel(raw: number): void {
  // Only react while the recording dot is on screen; ignore stray events
  // during error/idle so the visualizer never lies about state.
  if (recordingState.hidden) return;

  const target = Math.min(1, Math.max(0, raw));
  smoothedLevel = smoothedLevel + (target - smoothedLevel) * LEVEL_ALPHA;
}

function startVisualizer(): void {
  if (!canvas || rafId !== undefined) return;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Size the backing store to device pixels once; the pill is fixed-size so
  // no ResizeObserver needed. Cap dpr at 2 — beyond that is wasted fill on
  // a 168px surface.
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(168 * dpr);
  canvas.height = Math.round(44 * dpr);
  ctx.scale(dpr, dpr);

  const W = 168;
  const H = 44;
  const MID = H / 2;

  const draw = (): void => {
    // Scroll the buffer left by one; append the latest smoothed level.
    // Under reduced motion we skip the scroll and only redraw when the
    // level changes — a calm static silhouette of recent amplitude.
    if (!REDUCED_MOTION) {
      levels.copyWithin(0, 1);
      levels[SAMPLES - 1] = smoothedLevel;
    } else if (levels[SAMPLES - 1] === smoothedLevel) {
      rafId = window.requestAnimationFrame(draw);
      return;
    } else {
      levels[SAMPLES - 1] = smoothedLevel;
    }

    ctx.clearRect(0, 0, W, H);

    // Soft radial glow centered on the recording dot — ties the trace to
    // the pulsing red dot and gives silence a faint heartbeat.
    const glowR = 16 + smoothedLevel * 26;
    const glow = ctx.createRadialGradient(22, MID, 0, 22, MID, glowR);
    glow.addColorStop(0, THEME.glow);
    glow.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 60, H);

    // Mirrored amplitude waveform: filled from center upward and downward.
    // Amplitude mapped with a slight gamma so quiet speech still reads.
    const colW = W / SAMPLES;
    for (let i = 0; i < SAMPLES; i++) {
      const v = levels[i];
      // Age fade: newest columns brightest, oldest trail off — gives the
      // scrolling motion a sense of direction without per-pixel alpha math.
      const age = i / SAMPLES;
      const amp = v ** 0.75 * age;
      const h = amp * (H * 0.46);
      if (h < 0.15) continue;
      const x = i * colW;
      const grad = ctx.createLinearGradient(0, MID - h, 0, MID + h);
      grad.addColorStop(0, THEME.trace[0]);
      grad.addColorStop(0.5, THEME.trace[1]);
      grad.addColorStop(1, THEME.trace[2]);
      ctx.fillStyle = grad;
      ctx.fillRect(x, MID - h, colW + 0.5, h * 2);
    }

    rafId = window.requestAnimationFrame(draw);
  };

  rafId = window.requestAnimationFrame(draw);
}

function stopVisualizer(): void {
  if (rafId !== undefined) {
    window.cancelAnimationFrame(rafId);
    rafId = undefined;
  }
}

function render(seconds: number): void {
  const total = Math.max(0, Math.floor(seconds));
  time.textContent = formatElapsed(total);
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
  startVisualizer();
}

function showError(): void {
  stop();
  recordingState.hidden = true;
  errorState.hidden = false;
  indicator.classList.remove("is-loading");
  indicator.classList.add("is-error");
  resetVoiceLevel();
}

function applyStatus(payload: StatusPayload): void {
  if (payload.kind === "recording") {
    showRecording(payload.elapsedSeconds ?? 0);
  } else if (payload.kind === "error") {
    showError();
  } else {
    stop();
    resetVoiceLevel();
  }
}

// Listener setup can reject when the IPC bridge is unavailable; the overlay
// is a passive display, so failures leave it in its initial hidden state.
void listen<AudioLevelPayload>(Events.audioLevel, ({ payload }) => {
  const level =
    payload && typeof payload === "object" && "level" in payload
      ? typeof payload.level === "number"
        ? payload.level
        : 0
      : 0;
  pushVoiceLevel(level);
}).catch(() => undefined);

let receivedLiveStatus = false;

void listen<StatusPayload>(Events.status, ({ payload }) => {
  receivedLiveStatus = true;
  applyStatus(payload);
}).catch(() => undefined);

void invoke<StatusPayload>(Commands.getStatus)
  .then((payload) => {
    if (!receivedLiveStatus) applyStatus(payload);
  })
  .catch(() => {
    if (!receivedLiveStatus) showRecording();
  });
