import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import Anser from "anser";
import { cn } from "./ui";
import type { TextMatch } from "./text-search";

function ansiEntryStyle(entry: Anser.AnserJsonEntry): CSSProperties {
  const decorations = new Set(entry.decorations ?? (entry.decoration ? [entry.decoration] : []));
  let foreground = entry.fg_truecolor || entry.fg;
  let background = entry.bg_truecolor || entry.bg;
  if (decorations.has("reverse")) [foreground, background] = [background, foreground];
  return {
    color: foreground ? `rgb(${foreground})` : undefined,
    backgroundColor: background ? `rgb(${background})` : undefined,
    fontWeight: decorations.has("bold") ? 700 : undefined,
    fontStyle: decorations.has("italic") ? "italic" : undefined,
    textDecoration: [decorations.has("underline") && "underline", decorations.has("strikethrough") && "line-through"].filter(Boolean).join(" ") || undefined,
    opacity: decorations.has("dim") ? 0.65 : decorations.has("hidden") ? 0 : undefined,
  };
}

export function ansiToPlainText(text: string) {
  return Anser.ansiToText(text).replace(/\r/g, "");
}

export function AnsiHighlightedText({ text, matches, currentIndex }: { text: string; matches: TextMatch[]; currentIndex: number }) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const entries = useMemo(() => Anser.ansiToJson(text).filter((entry) => entry.content.length > 0), [text]);

  useEffect(() => {
    rootRef.current?.querySelector("mark.current")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [currentIndex, matches]);

  let offset = 0;
  const nodes: ReactNode[] = [];
  entries.forEach((entry, entryIndex) => {
    const content = entry.content.replace(/\r/g, "");
    const start = offset;
    const end = start + content.length;
    const entryMatches = matches
      .map((match, matchIndex) => ({ ...match, matchIndex }))
      .filter((match) => match.end > start && match.start < end);
    const children: ReactNode[] = [];
    let cursor = 0;
    entryMatches.forEach((match) => {
      const matchStart = Math.max(0, match.start - start);
      const matchEnd = Math.min(content.length, match.end - start);
      if (matchStart > cursor) children.push(content.slice(cursor, matchStart));
      if (matchEnd > matchStart) children.push(<mark key={`${entryIndex}-${match.matchIndex}-${matchStart}`} className={cn(match.matchIndex === currentIndex && "current")}>{content.slice(matchStart, matchEnd)}</mark>);
      cursor = Math.max(cursor, matchEnd);
    });
    if (cursor < content.length) children.push(content.slice(cursor));
    nodes.push(<span key={entryIndex} style={ansiEntryStyle(entry)}>{children}</span>);
    offset = end;
  });

  return <span ref={rootRef}>{nodes}</span>;
}
