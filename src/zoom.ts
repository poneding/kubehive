import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * Session-only zoom controls (no persistence; every launch starts fresh):
 *
 * - Window zoom (Cmd/Ctrl +/-/0) scales the entire app shell through the
 *   native webview, falling back to a CSS root font size in the browser
 *   prototype.
 * - Content font zoom (Cmd/Ctrl + wheel) enlarges or shrinks terminals, logs,
 *   and editors independently of the configured base size. It glides
 *   continuously during the gesture and snaps to a stable step on settle.
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
 * Converts a Cmd/Ctrl+wheel gesture into the next content zoom factor using a
 * continuous exponential so pinches and smooth wheels glide instead of jumping
 * in fixed steps. Rate control comes from the mapping itself:
 *
 * - Trackpads fire a stream of small |deltaY| pixel deltas; the per-event
 *   exponent is proportional to the delta and capped (~9%), so fast gestures
 *   accelerate smoothly without ever leaping.
 * - Line-wheel mice fire small fractional notches; the same per-pixel exponent
 *   applies, and one physical notch (~100px) lands near a comfortable ~12% step.
 *
 * The result is kept continuous (rounded to 0.1%) and only snapped to a round
 * percentage once the gesture settles, which keeps the live readout stable.
 */
const wheelRate = 0.0013;
const wheelMaxPerEvent = 0.09;

export function nextContentZoomFactor(current: number, deltaY: number, remainder: number): { factor: number; remainder: number } {
  void remainder;
  const direction = deltaY < 0 ? 1 : -1;
  const magnitude = Math.min(Math.abs(deltaY) * wheelRate, wheelMaxPerEvent);
  const next = current * Math.exp(direction * magnitude);
  const rounded = Math.round(clamp(next, contentZoomMin, contentZoomMax) * 1000) / 1000;
  return { factor: rounded, remainder: 0 };
}

/** Snaps a settled content zoom factor to a stable whole percentage. */
export function settleContentZoomFactor(current: number): number {
  return clamp(Math.round(current * 20) / 20, contentZoomMin, contentZoomMax);
}
