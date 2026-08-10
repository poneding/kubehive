import type { CSSProperties } from "react";
import { AnsiHighlightedText } from "./ansi-log";
import type { TextMatch } from "./text-search";
import { ScrollArea } from "@/components/ui";
import { cn } from "@/lib/utils";

export function LogOutputScrollArea({
  ariaLabel,
  currentIndex,
  fontFamily,
  fontSize,
  matches,
  output,
  wrapLines,
}: {
  ariaLabel: string;
  currentIndex: number;
  fontFamily: CSSProperties["fontFamily"];
  fontSize: number;
  matches: TextMatch[];
  output: string;
  wrapLines: boolean;
}) {
  return <ScrollArea
    className="terminal-output logs-scroll-area"
    style={{ fontFamily }}
    viewportClassName={cn("logs-output", wrapLines && "wrap-lines")}
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
    <pre style={{ fontSize }}><AnsiHighlightedText text={output} matches={matches} currentIndex={currentIndex} /></pre>
  </ScrollArea>;
}
