import { useEffect, useRef } from "react";

/**
 * Maps either a regular wheel gesture or Shift+wheel to horizontal movement
 * while the pointer is over an overflowing tab rail. At either edge, leave the
 * event uncancelled so scrolling can continue through the surrounding page.
 */
export function scrollTabRailOnWheel(rail: HTMLDivElement, event: WheelEvent) {
  if (rail.scrollWidth <= rail.clientWidth) return;

  const delta = event.shiftKey
    ? event.deltaY || event.deltaX
    : Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (!delta) return;

  const distance = event.deltaMode === 1 ? delta * 16 : event.deltaMode === 2 ? delta * rail.clientWidth : delta;
  const previous = rail.scrollLeft;
  rail.scrollLeft += distance;
  if (rail.scrollLeft !== previous) event.preventDefault();
}

/** Both rails mark their selected tab with `active` on the tab button. */
const ACTIVE_TAB_SELECTOR = "button.active";

/** Keeps a revealed tab off the rail's edges so a neighbour stays hinted at. */
const TAB_REVEAL_PADDING = 8;

/**
 * Brings a tab fully inside the rail's scrollport by the smallest distance that
 * clears the nearest edge, leaving an already visible tab untouched.
 */
export function revealTabInRail(rail: HTMLElement, tab: HTMLElement, behavior: ScrollBehavior = "smooth") {
  if (rail.scrollWidth <= rail.clientWidth) return;

  const railBox = rail.getBoundingClientRect();
  const tabBox = tab.getBoundingClientRect();
  const leading = tabBox.left - railBox.left - TAB_REVEAL_PADDING;
  const trailing = tabBox.right - railBox.right + TAB_REVEAL_PADDING;
  const distance = leading < 0 ? leading : trailing > 0 ? trailing : 0;
  if (!distance) return;

  const left = Math.max(0, Math.min(rail.scrollWidth - rail.clientWidth, rail.scrollLeft + distance));
  if (left === rail.scrollLeft) return;
  rail.scrollTo({ left, behavior });
}

/**
 * Wires wheel-to-horizontal scrolling on a tab rail and, when `activeTabKey` is
 * supplied, scrolls the active tab back into view whenever it changes — so a
 * newly opened tab is never stranded past the rail's right edge.
 */
export function useHorizontalTabRail(activeTabKey?: string) {
  const railRef = useRef<HTMLDivElement>(null);
  const revealedRef = useRef(false);
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const handleWheel = (event: WheelEvent) => scrollTabRailOnWheel(rail, event);
    rail.addEventListener("wheel", handleWheel, { passive: false });
    return () => rail.removeEventListener("wheel", handleWheel);
  }, []);
  useEffect(() => {
    const rail = railRef.current;
    if (!rail || activeTabKey === undefined) return;
    const active = rail.querySelector<HTMLElement>(ACTIVE_TAB_SELECTOR);
    if (!active) return;
    // Restored tab state lands in place; later switches animate across the rail.
    revealTabInRail(rail, active, revealedRef.current ? "smooth" : "auto");
    revealedRef.current = true;
  }, [activeTabKey]);
  return railRef;
}
