import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * Session-only zoom controls (no persistence; every launch starts fresh):
 *
 * - Window zoom (Cmd/Ctrl +/-/0) scales the entire app shell through the
 *   native webview, falling back to a CSS root font size in the browser
 *   prototype.
 * - Content font zoom (Cmd/Ctrl + wheel) enlarges or shrinks terminals, logs,
 *   and editors independently of the configured base size.
 */

export const windowZoomMin = 0.5;
export const windowZoomMax = 2.5;
export const windowZoomStep = 0.1;

export const contentZoomMin = 0.5;
export const contentZoomMax = 2.5;

/** Snaps to whole steps so repeated presses land on round percentages. */
export function stepWindowZoom(current: number, direction: 1 | -1): number {
  const next = direction === 1
    ? Math.ceil((current + windowZoomStep / 2) / windowZoomStep) * windowZoomStep
    : Math.floor((current - windowZoomStep / 2) / windowZoomStep) * windowZoomStep;
  return clamp(Math.round(next * 100) / 100, windowZoomMin, windowZoomMax);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

let windowZoomFactor = 1;

export function getWindowZoomFactor(): number {
  return windowZoomFactor;
}

export async function applyWindowZoom(factor: number): Promise<number> {
  const next = clamp(Math.round(factor * 100) / 100, windowZoomMin, windowZoomMax);
  windowZoomFactor = next;
  if (isTauri()) {
    await invoke("set_window_zoom", { factor: next });
  } else {
    // Browser prototype: scale the whole shell via the root font size (rem).
    document.documentElement.style.fontSize = next === 1 ? "" : `${next * 100}%`;
  }
  return next;
}

export function resetWindowZoom(): Promise<number> {
  return applyWindowZoom(1);
}

/**
 * Converts a Cmd/Ctrl+wheel gesture into the next content zoom factor. This is
 * deliberately rate-controlled rather than a raw pixel mapping:
 *
 * - Line-wheel mice fire many tiny |deltaY| events, which are accumulated
 *   until they cross one notch (~100px) so one physical click = one step.
 * - Trackpads fire a continuous stream, so magnitude maps to a capped
 *   exponential that can grow at most ~9% per event no matter how large the
 *   reported delta is. Both paths snap to 5% increments.
 */
const wheelNotchPx = 100;
const trackpadRate = 0.0022;
const trackpadMaxPerEvent = 0.09;

export function nextContentZoomFactor(current: number, deltaY: number, remainder: number): { factor: number; remainder: number } {
  let next = current;
  let rest = remainder;
  if (Math.abs(deltaY) < 1) {
    // Line-mode wheel: accumulate notches until a full step is reached.
    rest += deltaY;
    if (Math.abs(rest) >= wheelNotchPx) {
      const steps = Math.trunc(rest / wheelNotchPx);
      next = current * Math.pow(1.1, -steps);
      rest -= steps * wheelNotchPx;
    }
  } else {
    rest = 0;
    const direction = deltaY < 0 ? 1 : -1;
    const magnitude = Math.min(Math.abs(deltaY) * trackpadRate, trackpadMaxPerEvent);
    next = current * Math.exp(direction * magnitude);
  }
  const snapped = Math.round(clamp(next, contentZoomMin, contentZoomMax) * 20) / 20;
  return { factor: snapped, remainder: rest };
}
