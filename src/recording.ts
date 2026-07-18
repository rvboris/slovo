import { listen } from "@tauri-apps/api/event";

type RuntimeStatus = { kind: string; elapsedSeconds?: number };

const timeElement = document.querySelector<HTMLTimeElement>("#recording-time");
if (!timeElement) throw new Error("Missing #recording-time");
const time: HTMLTimeElement = timeElement;

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

void listen<RuntimeStatus>("slovo://status", ({ payload }) => {
  if (payload.kind === "recording") start(payload.elapsedSeconds ?? 0);
  else stop();
});

start();
