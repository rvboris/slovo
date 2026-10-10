import type { JSX } from "react";

export function SlovoMark(): JSX.Element | null {
  return (
    <svg
      viewBox="0 0 24 24"
      className="slovo-mark relative z-10 h-5 w-5"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect
        className="slovo-bar slovo-bar-1"
        x="3"
        y="7"
        width="2.6"
        height="10"
        rx="1.3"
        fill="var(--accent-vivid)"
      />
      <rect
        className="slovo-bar slovo-bar-2"
        x="7"
        y="4"
        width="2.6"
        height="16"
        rx="1.3"
        fill="var(--accent-vivid)"
      />
      <rect
        className="slovo-bar slovo-bar-3"
        x="11"
        y="2.5"
        width="2.6"
        height="19"
        rx="1.3"
        fill="var(--accent-vivid)"
      />
      <rect
        className="slovo-bar slovo-bar-4"
        x="15"
        y="4"
        width="2.6"
        height="16"
        rx="1.3"
        fill="var(--accent-vivid)"
      />
      <rect
        className="slovo-bar slovo-bar-5"
        x="19"
        y="7"
        width="2.6"
        height="10"
        rx="1.3"
        fill="var(--accent-vivid)"
      />
    </svg>
  );
}
