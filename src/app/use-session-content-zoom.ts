import { useEffect, useRef, useState } from "react";
import { contentZoomModifierActive, nextContentZoomFactor, normalizeContentWheelDelta, settleContentZoomFactor } from "../zoom";
import { platform } from "./app-platform";

// How long the content-zoom control lingers after the text size returns to
// 100% before it fades away, so the user still sees the confirmed reset.
const CONTENT_ZOOM_HIDE_DELAY_MS = 5_000;
// Sustained trackpad streams are capped to one 5% text-size step per interval.
// A normal mouse notch still applies immediately, while fling bursts are dropped
// instead of being replayed after the gesture ends.
const CONTENT_ZOOM_STEP_INTERVAL_MS = 80;
// WKWebView can drop Command flags from later notches and emit a false Meta
// keyup after the first event. Keep a macOS Command gesture armed across the
// whole held-scroll stream; a genuine release ends it immediately (see
// onModifierKeyUp), and this idle timeout only guards keyups we cannot verify.
const CONTENT_ZOOM_MAC_ARM_IDLE_MS = 1_000;

function useSessionContentZoom(contentZoom: number, contentFontSize: number, onContentZoom: (next: number) => void) {
  const [contentZoomActive, setContentZoomActive] = useState(false);
  const [contentZoomLinger, setContentZoomLinger] = useState(false);
  const contentZoomRef = useRef(contentZoom);
  const contentWheelRemainderRef = useRef(0);
  const contentZoomFrameRef = useRef<number | undefined>(undefined);
  const contentZoomSettleTimerRef = useRef<number | undefined>(undefined);
  const contentZoomLingerTimerRef = useRef<number | undefined>(undefined);
  const contentZoomLastStepAtRef = useRef(Number.NEGATIVE_INFINITY);
  const contentZoomRateTimerRef = useRef<number | undefined>(undefined);
  const contentZoomMacArmTimerRef = useRef<number | undefined>(undefined);
  const contentZoomPendingDirectionRef = useRef<-1 | 0 | 1>(0);
  const contentZoomHeldModifiersRef = useRef({ metaKey: false, ctrlKey: false, macCommandArmed: false });
  contentZoomRef.current = contentZoom;
  const clearContentZoomLinger = () => {
    window.clearTimeout(contentZoomLingerTimerRef.current);
    contentZoomLingerTimerRef.current = undefined;
    setContentZoomLinger(false);
  };
  // Applies a new content zoom and manages the floating control's visibility.
  // Returning to 100% keeps the control on screen for a few seconds before it
  // fades; any further change (or a non-100% value) cancels that pending hide.
  const applyContentZoom = (next: number) => {
    contentZoomRef.current = next;
    onContentZoom(next);
    if (Math.round(next * 100) === 100) {
      if (contentZoomLingerTimerRef.current === undefined) {
        setContentZoomLinger(true);
        contentZoomLingerTimerRef.current = window.setTimeout(() => {
          contentZoomLingerTimerRef.current = undefined;
          setContentZoomLinger(false);
        }, CONTENT_ZOOM_HIDE_DELAY_MS);
      }
    } else {
      clearContentZoomLinger();
    }
  };
  // The wheel effect below is registered once and always calls the latest
  // applyContentZoom via this ref, so re-renders (e.g. a language change) never
  // tear down the listener or a pending linger timer mid-gesture.
  const applyContentZoomRef = useRef(applyContentZoom);
  applyContentZoomRef.current = applyContentZoom;
  // Cmd/Ctrl + wheel scales terminal/log/editor text with strict platform
  // isolation: Command on macOS, Control on Windows/Linux. Physical modifier
  // key state is tracked separately because WKWebView can mislabel a macOS
  // Command+wheel event as ctrlKey-only or release Meta early during a wheel
  // stream. Input units are normalized and queued through a one-step rate
  // limiter, allowing continuous scrolling without a large fling jump.
  useEffect(() => {
    const flush = () => {
      contentZoomFrameRef.current = undefined;
      applyContentZoomRef.current(contentZoomRef.current);
    };
    const scheduleFlush = () => {
      if (contentZoomFrameRef.current === undefined) contentZoomFrameRef.current = window.requestAnimationFrame(flush);
    };
    const clearPendingRateStep = () => {
      window.clearTimeout(contentZoomRateTimerRef.current);
      contentZoomRateTimerRef.current = undefined;
      contentZoomPendingDirectionRef.current = 0;
    };
    const flushPendingRateStep = () => {
      contentZoomRateTimerRef.current = undefined;
      const direction = contentZoomPendingDirectionRef.current;
      contentZoomPendingDirectionRef.current = 0;
      if (!direction) return;
      const next = settleContentZoomFactor(contentZoomRef.current + direction * 0.05);
      if (next === contentZoomRef.current) return;
      contentZoomRef.current = next;
      contentZoomLastStepAtRef.current = performance.now();
      scheduleFlush();
    };
    const queueRateLimitedStep = (direction: -1 | 1, delay: number) => {
      contentZoomPendingDirectionRef.current = direction;
      if (contentZoomRateTimerRef.current === undefined) {
        contentZoomRateTimerRef.current = window.setTimeout(flushPendingRateStep, Math.max(0, delay));
      }
    };
    const clearMacCommandArm = () => {
      window.clearTimeout(contentZoomMacArmTimerRef.current);
      contentZoomMacArmTimerRef.current = undefined;
      contentZoomHeldModifiersRef.current.macCommandArmed = false;
    };
    const refreshMacCommandArm = () => {
      contentZoomHeldModifiersRef.current.macCommandArmed = true;
      window.clearTimeout(contentZoomMacArmTimerRef.current);
      contentZoomMacArmTimerRef.current = window.setTimeout(clearMacCommandArm, CONTENT_ZOOM_MAC_ARM_IDLE_MS);
    };
    const settle = () => {
      contentZoomSettleTimerRef.current = undefined;
      if (contentZoomRateTimerRef.current !== undefined) {
        window.clearTimeout(contentZoomRateTimerRef.current);
        contentZoomRateTimerRef.current = undefined;
        const direction = contentZoomPendingDirectionRef.current;
        contentZoomPendingDirectionRef.current = 0;
        if (direction) contentZoomRef.current = settleContentZoomFactor(contentZoomRef.current + direction * 0.05);
      }
      if (contentZoomFrameRef.current !== undefined) { window.cancelAnimationFrame(contentZoomFrameRef.current); contentZoomFrameRef.current = undefined; }
      contentWheelRemainderRef.current = 0;
      applyContentZoomRef.current(settleContentZoomFactor(contentZoomRef.current));
      // Do not clear macCommandArmed here. WKWebView often drops Command flags
      // between notches; the arm idle timer owns gesture expiry instead.
      setContentZoomActive(false);
    };
    const onModifierKeyDown = (event: KeyboardEvent) => {
      const current = contentZoomHeldModifiersRef.current;
      const ctrlKey = event.ctrlKey || event.key === "Control";
      if (platform === "macos" && event.key === "Control") clearMacCommandArm();
      contentZoomHeldModifiersRef.current = {
        metaKey: event.metaKey || event.key === "Meta",
        ctrlKey,
        macCommandArmed: platform === "macos"
          ? event.key === "Control" ? false : event.key === "Meta" ? true : current.macCommandArmed
          : false,
      };
      if (platform === "macos" && event.key === "Meta") {
        window.clearTimeout(contentZoomMacArmTimerRef.current);
        contentZoomMacArmTimerRef.current = window.setTimeout(clearMacCommandArm, CONTENT_ZOOM_MAC_ARM_IDLE_MS);
      }
    };
    const onModifierKeyUp = (event: KeyboardEvent) => {
      const current = contentZoomHeldModifiersRef.current;
      // WKWebView emits a false Meta keyup after the first notch while Command
      // is still physically held, so a keyup alone must not end the arm. But
      // getModifierState reflects the live keyboard rather than the dropped
      // event flags, which distinguishes that false keyup from a genuine
      // release: the latter ends the gesture immediately instead of leaving
      // the arm live for the full idle window (a later plain wheel would zoom).
      const metaReallyUp = platform === "macos" && event.key === "Meta" && event.getModifierState?.("Meta") === false;
      if (metaReallyUp) clearMacCommandArm();
      contentZoomHeldModifiersRef.current = {
        metaKey: event.key === "Meta" ? false : event.metaKey,
        ctrlKey: event.key === "Control" ? false : event.ctrlKey,
        macCommandArmed: metaReallyUp ? false : current.macCommandArmed,
      };
    };
    const clearHeldModifiers = () => {
      window.clearTimeout(contentZoomMacArmTimerRef.current);
      contentZoomMacArmTimerRef.current = undefined;
      contentZoomHeldModifiersRef.current = { metaKey: false, ctrlKey: false, macCommandArmed: false };
    };
    const onWheel = (event: WheelEvent) => {
      const held = contentZoomHeldModifiersRef.current;
      // Prefer KeyboardEvent-tracked keys, then WheelEvent flags, then
      // getModifierState. WKWebView often drops metaKey after the first notch.
      const wheelMetaKey = event.metaKey || event.getModifierState?.("Meta") === true;
      const wheelCtrlKey = event.ctrlKey || event.getModifierState?.("Control") === true;
      if (!contentZoomModifierActive(platform, wheelMetaKey, wheelCtrlKey, held.metaKey, held.ctrlKey, held.macCommandArmed)) return;
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".terminal-output, .editor-layout, .manifest-editor, .cm-editor, .container-terminal, .file-text-editor")) return;
      event.preventDefault();
      event.stopPropagation();
      // Arm from the first accepted Command wheel itself. Meta keydown is not
      // reliable when focus is inside CodeMirror/xterm, so continuous notches
      // must not depend on a prior keydown event.
      if (platform === "macos" && !held.ctrlKey && (held.metaKey || wheelMetaKey || held.macCommandArmed)) {
        refreshMacCommandArm();
      }
      const legacyWheelDeltaY = (event as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
      const deltaY = normalizeContentWheelDelta(event.deltaY, event.deltaMode, window.innerHeight, legacyWheelDeltaY);
      if (!deltaY) return;
      setContentZoomActive(true);
      const result = nextContentZoomFactor(contentZoomRef.current, deltaY, contentWheelRemainderRef.current);
      const now = performance.now();
      if (result.factor !== contentZoomRef.current) {
        const elapsed = now - contentZoomLastStepAtRef.current;
        const direction = result.factor > contentZoomRef.current ? 1 : -1;
        if (elapsed < CONTENT_ZOOM_STEP_INTERVAL_MS) {
          // Keep one pending step so a sustained mouse-wheel stream continues at
          // the controlled rate instead of dropping every event after the first.
          contentWheelRemainderRef.current = 0;
          queueRateLimitedStep(direction, CONTENT_ZOOM_STEP_INTERVAL_MS - elapsed);
        } else {
          clearPendingRateStep();
          contentZoomLastStepAtRef.current = now;
          contentZoomRef.current = result.factor;
          contentWheelRemainderRef.current = result.remainder;
          scheduleFlush();
        }
      } else {
        contentWheelRemainderRef.current = result.remainder;
        scheduleFlush();
      }
      window.clearTimeout(contentZoomSettleTimerRef.current);
      contentZoomSettleTimerRef.current = window.setTimeout(settle, 180);
    };
    window.addEventListener("keydown", onModifierKeyDown, true);
    window.addEventListener("keyup", onModifierKeyUp, true);
    window.addEventListener("blur", clearHeldModifiers);
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => {
      window.removeEventListener("keydown", onModifierKeyDown, true);
      window.removeEventListener("keyup", onModifierKeyUp, true);
      window.removeEventListener("blur", clearHeldModifiers);
      window.removeEventListener("wheel", onWheel, { capture: true });
      window.clearTimeout(contentZoomSettleTimerRef.current);
      window.clearTimeout(contentZoomRateTimerRef.current);
      contentZoomRateTimerRef.current = undefined;
      contentZoomPendingDirectionRef.current = 0;
      window.clearTimeout(contentZoomMacArmTimerRef.current);
      contentZoomMacArmTimerRef.current = undefined;
      window.clearTimeout(contentZoomLingerTimerRef.current);
      contentZoomLingerTimerRef.current = undefined;
      if (contentZoomFrameRef.current !== undefined) window.cancelAnimationFrame(contentZoomFrameRef.current);
    };
  }, []);
  const contentZoomPercent = Math.round(contentZoom * 100);
  const zoomWidgetVisible = contentZoomActive || contentZoomLinger || contentZoomPercent !== 100;
  const scaledContentFontSize = Math.round(contentFontSize * contentZoom * 100) / 100;
  return { applyContentZoom, contentZoomPercent, contentZoomRef, scaledContentFontSize, zoomWidgetVisible };
}

export { useSessionContentZoom };
