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
 * Converts a Cmd/Ctrl+wheel gesture into the next content zoom factor. Zoom is
 * locked to 5% steps, so the gesture never lands on an in-between ratio: the
 * incoming deltas are accumulated exponentially (trackpads glide, wheel notches
 * build up) and only shift the ratio once they cross one full step.
 *
 * `remainder` carries the not-yet-applied scroll between events so a slow,
 * steady scroll still advances one 5% step at a time instead of jumping.
 */
export const contentZoomStep = 0.05;

const wheelRate = 0.0013;
const wheelMaxPerEvent = 0.09;

export function nextContentZoomFactor(current: number, deltaY: number, remainder: number): { factor: number; remainder: number } {
  const direction = deltaY < 0 ? 1 : -1;
  const magnitude = Math.min(Math.abs(deltaY) * wheelRate, wheelMaxPerEvent);
  // Accumulate the raw gesture distance (as a signed delta on the factor), then
  // consume whole 5% steps from it. The signed leftover carries into the next
  // event, so a sustained scroll keeps advancing one step per event while a
  // single flick only ever moves a bounded amount.
  const accumulated = remainder + current * Math.expm1(direction * magnitude);
  const steps = Math.trunc(accumulated / contentZoomStep);
  const clampedSteps = clamp(steps, Math.round((contentZoomMin - current) / contentZoomStep), Math.round((contentZoomMax - current) / contentZoomStep));
  const factor = clamp(current + clampedSteps * contentZoomStep, contentZoomMin, contentZoomMax);
  const remainderOut = clampedSteps === steps ? accumulated - steps * contentZoomStep : 0;
  return { factor: snapToStep(factor), remainder: remainderOut };
}

/**
 * Rounds to the nearest 5% step using integer step counts so the result is an
 * exact, display-safe value (115, not 1.1500000000000001).
 */
function snapToStep(value: number): number {
  const steps = Math.round(value / contentZoomStep);
  const clampedSteps = clamp(steps, Math.round(contentZoomMin / contentZoomStep), Math.round(contentZoomMax / contentZoomStep));
  return clampedSteps * 5 / 100;
}

/** Snaps any content zoom factor to the nearest 5% step. */
export function settleContentZoomFactor(current: number): number {
  return snapToStep(current);
}
