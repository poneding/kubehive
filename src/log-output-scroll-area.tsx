import { useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import { AnsiHighlightedText, type LogChunk } from "./ansi-log";
import type { TextMatch } from "./text-search";
import { ScrollArea } from "@/components/ui";
import { cn } from "@/lib/utils";

/** Rounding slack (fractional zoom, line heights) that still counts as resting on the newest line. */
const bottomEdgeSlack = 8;

export function LogOutputScrollArea({
  ariaLabel,
  chunks,
  currentIndex,
  fontFamily,
  fontSize,
  matches,
  targetKey = "",
  wrapLines,
}: {
  ariaLabel: string;
  /** Memoised slices of the log buffer; see LogChunk. */
  chunks: LogChunk[];
  currentIndex: number;
  fontFamily: CSSProperties["fontFamily"];
  fontSize: number;
  matches: TextMatch[];
  /** Identity of the log being read; a new value tails the newest line again. */
  targetKey?: string;
  wrapLines: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const tailing = useRef(true);

  // Tailing follows the scrollbar: scrolling up to read older lines pauses it and
  // returning to the bottom edge resumes it, so a log refresh never yanks the view.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const trackTail = () => {
      tailing.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= bottomEdgeSlack;
    };
    viewport.addEventListener("scroll", trackTail, { passive: true });
    return () => viewport.removeEventListener("scroll", trackTail);
  }, []);

  // A newly opened session, pod or container always starts on the newest line.
  useLayoutEffect(() => { tailing.current = true; }, [targetKey]);

  // Re-anchor before paint whenever the rendered log changes height: refreshed
  // output, a wrap toggle or a zoom step all move the bottom edge.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && tailing.current) viewport.scrollTop = viewport.scrollHeight;
  }, [chunks, fontSize, targetKey, wrapLines]);

  return <ScrollArea
    className="terminal-output logs-scroll-area"
    style={{ fontFamily }}
    viewportClassName={cn("logs-output", wrapLines && "wrap-lines")}
    viewportRef={viewportRef}
    scrollbars="both"
    viewportProps={{
      tabIndex: 0,
      role: "region",
      "aria-label": ariaLabel,
      onMouseDown: (event) => {
        if (event.button === 0) event.currentTarget.focus();
      },
    }}
  >
    <pre style={{ fontSize }}><AnsiHighlightedText chunks={chunks} matches={matches} currentIndex={currentIndex} /></pre>
  </ScrollArea>;
}
