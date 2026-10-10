import { LogicalSize, PhysicalPosition, getCurrentWindow } from "@tauri-apps/api/window";
import type { StatusPayload as RuntimeStatus } from "./lib/types";
import { formatElapsed } from "./lib/types";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const PILL_HEIGHT = 44;
const WINDOW_PADDING = 4;
const MIN_AMPLITUDE = 0.15;
const MILLISECONDS_PER_SECOND = 1000;
const TIMER_INTERVAL = 250;
const ZERO = 0;
const ONE = 1;
const MIRROR_FACTOR = 2;
const MAX_PIXEL_RATIO = 2;
const GLOW_BASE_RADIUS = 16;
const GLOW_LEVEL_RADIUS = 26;
const GLOW_CENTER_X = 22;
const GLOW_WIDTH = 60;
const AMPLITUDE_GAMMA = 0.75;
const AMPLITUDE_HEIGHT_RATIO = 0.46;
const GRADIENT_MIDPOINT = 0.5;
const COLUMN_OVERLAP = 0.5;
function requireElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) {
    throw new Error("Missing recording overlay elements");
  }
  return element;
}
const indicator = requireElement(".recording-indicator");
const recordingState = requireElement("#recording-state");
const errorState = requireElement("#error-state");
const processingState = requireElement("#processing-state");
const processingLabel = requireElement("#processing-label");
const errorLabel = requireElement("#error-label");
const time = document.querySelector<HTMLTimeElement>("#recording-time");
if (time === null) {
  throw new Error("Missing recording overlay elements");
}
const timeElement = time;
const canvas = document.querySelector<HTMLCanvasElement>("#voice-canvas");
const context = canvas?.getContext("2d") ?? null;
let startedAt = performance.now();
let offsetSeconds = ZERO;
const animation: { rafId?: number; timer?: ReturnType<typeof globalThis.setInterval> } = {};
// Ponytail: EMA smoothing — one-pole filter, ~150ms at the ~60fps event rate.
const LEVEL_ALPHA = 0.18;
const REDUCED_MOTION = globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
const LIGHT_THEME = globalThis.matchMedia("(prefers-color-scheme: light)").matches;
const SAMPLES = 168;
const LAST_SAMPLE = SAMPLES - ONE;
const MIDPOINT = PILL_HEIGHT / MIRROR_FACTOR;
const COLUMN_WIDTH = SAMPLES / SAMPLES;
const levels = new Float32Array(SAMPLES);
let smoothedLevel = ZERO;
interface Theme {
  readonly glow: string;
  readonly trace: readonly [string, string, string];
}
function getTheme(): Theme {
  if (LIGHT_THEME) {
    return {
      glow: "rgba(232, 90, 90, 0.10)",
      trace: ["rgba(232, 58, 77, 0.0)", "rgba(232, 116, 76, 0.55)", "rgba(207, 51, 68, 0.0)"],
    };
  }
  return {
    glow: "rgba(255, 77, 94, 0.16)",
    trace: ["rgba(255, 138, 92, 0.0)", "rgba(255, 77, 94, 0.62)", "rgba(255, 60, 110, 0.0)"],
  };
}
const THEME = getTheme();
function stopVisualizer(): void {
  if (animation.rafId !== undefined) {
    globalThis.cancelAnimationFrame(animation.rafId);
    animation.rafId = undefined;
  }
}
function resetVoiceLevel(): void {
  smoothedLevel = ZERO;
  levels.fill(ZERO);
  stopVisualizer();
  if (canvas !== null) {
    canvas.getContext("2d")?.clearRect(ZERO, ZERO, canvas.width, canvas.height);
  }
}
function pushVoiceLevel(raw: number): void {
  // Ignore stray events while the recording dot is hidden.
  if (recordingState.hidden === true) {
    return;
  }
  const target = Math.min(ONE, Math.max(ZERO, raw));
  smoothedLevel += (target - smoothedLevel) * LEVEL_ALPHA;
}
function drawGlow(): void {
  if (context === null) {
    return;
  }
  const radius = GLOW_BASE_RADIUS + smoothedLevel * GLOW_LEVEL_RADIUS;
  const glow = context.createRadialGradient(
    GLOW_CENTER_X,
    MIDPOINT,
    ZERO,
    GLOW_CENTER_X,
    MIDPOINT,
    radius,
  );
  glow.addColorStop(ZERO, THEME.glow);
  glow.addColorStop(ONE, "rgba(0, 0, 0, 0)");
  context.fillStyle = glow;
  context.fillRect(ZERO, ZERO, GLOW_WIDTH, PILL_HEIGHT);
}
function fillColumn(index: number, height: number): void {
  if (context === null) {
    return;
  }
  const gradient = context.createLinearGradient(ZERO, MIDPOINT - height, ZERO, MIDPOINT + height);
  const [top, center, bottom] = THEME.trace;
  gradient.addColorStop(ZERO, top);
  gradient.addColorStop(GRADIENT_MIDPOINT, center);
  gradient.addColorStop(ONE, bottom);
  context.fillStyle = gradient;
  context.fillRect(
    index * COLUMN_WIDTH,
    MIDPOINT - height,
    COLUMN_WIDTH + COLUMN_OVERLAP,
    height * MIRROR_FACTOR,
  );
}
function drawColumn(index: number): void {
  const height =
    levels[index] ** AMPLITUDE_GAMMA * (index / SAMPLES) * (PILL_HEIGHT * AMPLITUDE_HEIGHT_RATIO);
  if (height < MIN_AMPLITUDE) {
    return;
  }
  fillColumn(index, height);
}
function drawFrame(): void {
  if (context === null) {
    return;
  }
  context.clearRect(ZERO, ZERO, SAMPLES, PILL_HEIGHT);
  drawGlow();
  for (let index = ZERO; index < SAMPLES; index += ONE) {
    drawColumn(index);
  }
}
function animate(): void {
  if (!REDUCED_MOTION) {
    levels.copyWithin(ZERO, ONE);
    levels[LAST_SAMPLE] = smoothedLevel;
    drawFrame();
  } else if (levels[LAST_SAMPLE] !== smoothedLevel) {
    levels[LAST_SAMPLE] = smoothedLevel;
    drawFrame();
  }
  animation.rafId = globalThis.requestAnimationFrame(animate);
}
function startVisualizer(): void {
  if (canvas === null || animation.rafId !== undefined) {
    return;
  }
  if (context === null) {
    return;
  }
  const pixelRatio = Math.min(MAX_PIXEL_RATIO, globalThis.devicePixelRatio || ONE);
  canvas.width = Math.round(SAMPLES * pixelRatio);
  canvas.height = Math.round(PILL_HEIGHT * pixelRatio);
  context.scale(pixelRatio, pixelRatio);
  animation.rafId = globalThis.requestAnimationFrame(animate);
}
function render(seconds: number): void {
  const total = Math.max(ZERO, Math.floor(seconds));
  timeElement.textContent = formatElapsed(total);
  timeElement.dateTime = `PT${total}S`;
}
function start(elapsedSeconds = ZERO): void {
  offsetSeconds = elapsedSeconds;
  startedAt = performance.now();
  render(offsetSeconds);
  if (animation.timer !== undefined) {
    globalThis.clearInterval(animation.timer);
  }
  animation.timer = globalThis.setInterval(() => {
    render(offsetSeconds + (performance.now() - startedAt) / MILLISECONDS_PER_SECOND);
  }, TIMER_INTERVAL);
}
function stop(): void {
  if (animation.timer !== undefined) {
    globalThis.clearInterval(animation.timer);
  }
  animation.timer = undefined;
  render(ZERO);
}
const OVERLAY_W = 172;
const OVERLAY_H = 48;
const MAX_ERROR_W = 340;
const MIN_PILL_W = 44;
let overlayWidened = false;
/** Resize the Tauri window, keeping its horizontal center fixed.
    Wayland ignores setPosition (compositor-owned) — the pill simply grows
    rightward there; acceptable ceiling. */
async function resizeOverlay(width: number): Promise<void> {
  const win = getCurrentWindow();
  try {
    const [pos, inner, scale] = [
      await win.outerPosition(),
      await win.innerSize(),
      await win.scaleFactor(),
    ];
    await win.setSize(new LogicalSize(width, OVERLAY_H));
    const dx = Math.round((width * scale - inner.width) / MIRROR_FACTOR);
    if (dx !== ZERO) {
      await win.setPosition(new PhysicalPosition(pos.x - dx, pos.y));
    }
  } catch {
    // Non-fatal: pill falls back to in-window ellipsis.
  }
}
/** Widen the pill and window so an error message fits (clamped). */
function fitErrorText(): void {
  indicator.style.width = "max-content";
  const measured = indicator.offsetWidth;
  const width = Math.min(Math.max(measured, MIN_PILL_W), MAX_ERROR_W);
  indicator.style.width = `${width}px`;
  if (width > OVERLAY_W - WINDOW_PADDING) {
    overlayWidened = true;
    void resizeOverlay(width + WINDOW_PADDING);
  }
}
function resetPillSize(): void {
  indicator.style.width = "";
  if (overlayWidened) {
    overlayWidened = false;
    void resizeOverlay(OVERLAY_W);
  }
}
function showRecording(elapsedSeconds = ZERO): void {
  indicator.classList.remove("is-loading", "is-error", "is-correcting");
  resetPillSize();
  recordingState.hidden = false;
  errorState.hidden = true;
  start(elapsedSeconds);
  startVisualizer();
}
function showError(label = "Ошибка — подробности в главном окне"): void {
  errorState.setAttribute("aria-label", label);
  errorLabel.textContent = label;
  stop();
  recordingState.hidden = true;
  errorState.hidden = false;
  indicator.classList.remove("is-loading", "is-correcting");
  indicator.classList.add("is-error");
  fitErrorText();
  resetVoiceLevel();
}
function showProcessing(kind: "transcribing" | "correcting"): void {
  stop();
  resetVoiceLevel();
  recordingState.hidden = true;
  errorState.hidden = true;
  indicator.classList.remove("is-loading", "is-error");
  indicator.classList.toggle("is-correcting", kind === "correcting");
  resetPillSize();
  processingLabel.textContent = { correcting: "Корректирую…", transcribing: "Распознаю…" }[kind];
  processingState.hidden = false;
}
function showIdle(): void {
  stop();
  resetVoiceLevel();
  recordingState.hidden = true;
  errorState.hidden = true;
  indicator.classList.add("is-loading");
  indicator.classList.remove("is-error", "is-correcting");
  resetPillSize();
}
function resultLabel(payload: Readonly<RuntimeStatus>): string {
  let label = "Текст вставлен";
  if (payload.kind === "copied") {
    label = "Скопировано — вставьте вручную";
  }
  if ((payload.correctionWarning ?? "") !== "") {
    label += " · Без корректировки";
  }
  return label;
}
function showResult(payload: Readonly<RuntimeStatus>): void {
  showIdle();
  indicator.classList.remove("is-loading");
  indicator.classList.add("is-result");
  processingState.hidden = false;
  processingLabel.textContent = resultLabel(payload);
  fitErrorText();
}
function applyStatus(payload: Readonly<RuntimeStatus>): void {
  processingState.hidden = true;
  indicator.classList.remove("is-result");
  if (payload.kind === "recording") {
    showRecording(payload.elapsedSeconds ?? ZERO);
  } else if (payload.kind === "transcribing" || payload.kind === "correcting") {
    showProcessing(payload.kind);
  } else if (payload.kind === "error") {
    showError();
  } else if (payload.kind === "inserted" || payload.kind === "copied") {
    showResult(payload);
  } else {
    showIdle();
  }
}
const lifecycle = { cancelled: false, revision: -1 };
const disposers: (() => void)[] = [];
function retainListener(dispose: () => void): void {
  if (lifecycle.cancelled) {
    dispose();
  } else {
    disposers.push(dispose);
  }
}
function acceptStatus(payload: Readonly<RuntimeStatus>): void {
  if (lifecycle.cancelled || payload.revision <= lifecycle.revision) {
    return;
  }
  lifecycle.revision = payload.revision;
  applyStatus(payload);
}
async function subscribeAudio(): Promise<void> {
  try {
    retainListener(
      await listen<unknown>("slovo://audio-level", (event: { readonly payload: unknown }) => {
        if (lifecycle.cancelled) {
          return;
        }
        const { payload } = event;
        let level = ZERO;
        if (
          payload !== null &&
          typeof payload === "object" &&
          "level" in payload &&
          typeof payload.level === "number"
        ) {
          ({ level } = payload);
        }
        pushVoiceLevel(level);
      }),
    );
  } catch {
    // Status remains available without audio levels.
  }
}
void subscribeAudio();
async function loadInitialStatus(): Promise<void> {
  try {
    retainListener(
      await listen<Readonly<RuntimeStatus>>(
        "slovo://status",
        (event: { readonly payload: Readonly<RuntimeStatus> }) => {
          acceptStatus(event.payload);
        },
      ),
    );
    if (lifecycle.cancelled) {
      return;
    }
    acceptStatus(await invoke<RuntimeStatus>("get_status"));
  } catch {
    if (!lifecycle.cancelled && lifecycle.revision < ZERO) {
      showError("Не удалось синхронизировать состояние");
    }
  }
}
globalThis.addEventListener(
  "pagehide",
  () => {
    lifecycle.cancelled = true;
    for (const dispose of disposers) {
      dispose();
    }
    stop();
  },
  { once: true },
);
showIdle();
void loadInitialStatus();
