import type { KeyboardEvent } from "react";

/** Implements the WAI-ARIA Tabs arrow/Home/End keyboard pattern. */
export function handleResultTabKeyDown(event: KeyboardEvent<HTMLElement>): void {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(
    '[role="tab"]:not([disabled])',
  )];
  if (tabs.length === 0) return;
  const active = tabs.findIndex((tab) => tab === event.target);
  if (active < 0) return;
  const next = event.key === "Home"
    ? tabs[0]
    : event.key === "End"
      ? tabs.at(-1)
      : tabs[(active + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
  if (next === undefined) return;
  event.preventDefault();
  next.focus();
  next.click();
}
