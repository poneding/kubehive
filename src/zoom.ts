import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * Session-only zoom controls (no persistence; every launch starts fresh):
 *
 * - Window zoom (Cmd/Ctrl +/-/0) scales the entire app shell through the
 *   native webview, falling back to a CSS root font size in the browser
 *   prototype.
 * - Content font zoom (Cmd/Ctrl + wheel) enlarges or shrinks terminals, logs,
 *   and editors independently of the configured base size. Wheel input is
 *   normalized across devices and applied in rate-limited 5% steps.
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
 * normalized incoming deltas are accumulated (trackpads glide, wheel notches
 * build up) and only shift the ratio once they cross one full step.
 *
 * `remainder` carries the not-yet-applied scroll between events so a slow,
 * steady scroll still advances one 5% step at a time instead of jumping.
 */
export const contentZoomStep = 0.05;

const wheelRate = 0.0013;
const wheelMaxPerEvent = 0.09;

/**
 * Keeps content-wheel modifiers isolated by desktop platform. Held keyboard
 * state takes precedence over WheelEvent flags because WKWebView can report a
 * physical Command+wheel gesture as ctrlKey-only, and can emit an early Meta
 * keyup during a continuous wheel gesture. A Command-armed gesture preserves
 * macOS semantics without enabling physical Control+wheel.
 */
export function contentZoomModifierActive(
  platform: "macos" | "windows" | "linux",
  wheelMetaKey: boolean,
  wheelCtrlKey: boolean,
  heldMetaKey = false,
  heldCtrlKey = false,
  macCommandArmed = false,
): boolean {
  if (platform === "macos") {
    if (heldCtrlKey) return false;
    if (heldMetaKey) return true;
    if (wheelMetaKey) return !wheelCtrlKey;
    // Once a physical Command keydown has armed the gesture, WKWebView may omit
    // every modifier flag from subsequent events in the same wheel stream.
    return macCommandArmed;
  }
  const hasHeldModifier = heldMetaKey || heldCtrlKey;
  const metaKey = hasHeldModifier ? heldMetaKey : wheelMetaKey;
  const ctrlKey = hasHeldModifier ? heldCtrlKey : wheelCtrlKey;
  return ctrlKey && !metaKey;
}

/**
 * Normalizes browser/WebView wheel units into pixel-like deltas. WKWebView can
 * report a physical mouse notch as deltaY=3 while exposing the traditional
 * 120-unit wheelDeltaY value; without normalization that takes roughly thirteen
 * notches before the first visible 5% change. Line/page modes are normalized as
 * well so the gesture feels consistent across macOS, Windows, and Linux.
 */
export function normalizeContentWheelDelta(deltaY: number, deltaMode = 0, viewportHeight = 800, legacyWheelDeltaY?: number): number {
  if (!Number.isFinite(deltaY)) return 0;
  const direction = deltaY === 0 && Number.isFinite(legacyWheelDeltaY)
    ? -Math.sign(legacyWheelDeltaY ?? 0)
    : Math.sign(deltaY);
  if (direction === 0) return 0;

  if (deltaMode === 1) return deltaY * 16;
  if (deltaMode === 2) return deltaY * Math.max(1, viewportHeight);

  const legacyMagnitude = Number.isFinite(legacyWheelDeltaY) ? Math.abs(legacyWheelDeltaY ?? 0) : 0;
  if (Math.abs(deltaY) < 40 && legacyMagnitude > Math.abs(deltaY)) return direction * legacyMagnitude;
  // Some WebViews omit wheelDeltaY but still use the old integer 1/3-unit
  // mouse-wheel convention. Treat those values as line deltas; fractional
  // high-resolution trackpad deltas retain their native precision.
  if (Number.isInteger(deltaY) && Math.abs(deltaY) <= 4) return deltaY * 16;
  return deltaY;
}

export function nextContentZoomFactor(current: number, deltaY: number, remainder: number): { factor: number; remainder: number } {
  if (!deltaY) return { factor: snapToStep(current), remainder };
  const direction = deltaY < 0 ? 1 : -1;
  const magnitude = Math.min(Math.abs(deltaY) * wheelRate, wheelMaxPerEvent);
  // Accumulate gesture distance independently of the current scale. Multiplying
  // by `current` made the 50% lower bound impossible to zoom away from because a
  // capped event could never accumulate one complete 5% step there.
  const accumulated = remainder + direction * magnitude;
  const requestedSteps = Math.trunc(accumulated / contentZoomStep);
  // One wheel event can move at most one 5% step, regardless of device delta or
  // the current scale. Excess from a fling is discarded rather than replayed on
  // later events, which keeps high-resolution trackpads and notched wheels calm.
  const rateLimitedSteps = clamp(requestedSteps, -1, 1);
  const clampedSteps = clamp(rateLimitedSteps, Math.round((contentZoomMin - current) / contentZoomStep), Math.round((contentZoomMax - current) / contentZoomStep));
  const factor = clamp(current + clampedSteps * contentZoomStep, contentZoomMin, contentZoomMax);
  const remainderOut = clampedSteps === requestedSteps ? accumulated - requestedSteps * contentZoomStep : 0;
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
