import { memo, useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import Anser from "anser";
import { cn } from "@/lib/utils";
import type { TextMatch } from "./text-search";

/**
 * One rendered slice of a log buffer. Slices are memoised on their text, so
 * appended output only re-parses and re-paints the last one -- and a selection
 * the reader made inside an untouched slice survives the refresh.
 */
export type LogChunk = {
  /** Stable across refreshes so React keeps this slice's DOM nodes. */
  id: number;
  text: string;
  /** SGR codes still in effect where the slice starts, replayed so colours carry over. */
  carry: string;
};

type IndexedMatch = TextMatch & { matchIndex: number };
type ChunkSpan = { start: number; end: number };

const chunkLines = 200;
const carryLimit = 512;
const escape = String.fromCharCode(27);
const sgrPattern = new RegExp(`${escape}\[[0-9;]*m`, "g");
const noChunkMatches: IndexedMatch[] = [];

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

/** Cuts the buffer on line boundaries every `chunkLines` lines, newline kept with its line. */
function sliceLogText(text: string) {
  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start;
    for (let line = 0; line < chunkLines; line += 1) {
      const next = text.indexOf("\n", end);
      if (next === -1) { end = text.length; break; }
      end = next + 1;
    }
    pieces.push(text.slice(start, end));
    start = end;
  }
  return pieces;
}

/** Length in the plain-text projection the search indexes; escape-free logs skip Anser. */
function plainLength(text: string) {
  if (!text.includes(escape) && !text.includes("\r")) return text.length;
  return ansiToPlainText(text).length;
}

/** SGR codes left open by `text`, so the next slice can replay the same styling. */
function carryAfter(carry: string, text: string) {
  if (!text.includes(escape)) return carry;
  let next = carry;
  for (const match of text.matchAll(sgrPattern)) {
    const code = match[0];
    if (code === `${escape}[0m` || code === `${escape}[m`) next = "";
    else next = next.length > carryLimit ? code : next + code;
  }
  return next;
}

/** Chunk list for a whole buffer, used by the one-shot log fetch. */
export function buildLogChunks(text: string): LogChunk[] {
  let carry = "";
  return sliceLogText(text).map((piece, index) => {
    const chunk: LogChunk = { id: index, text: piece, carry };
    carry = carryAfter(carry, piece);
    return chunk;
  });
}

/** Appends streamed lines to the trailing slice, starting a new one every `chunkLines`. */
export function appendLogChunks(chunks: LogChunk[], openLines: number, lines: string[]) {
  if (lines.length === 0) return { chunks, openLines };
  const next = chunks.slice();
  let open = openLines;
  let cursor = 0;
  // Grouped per slice: a line-at-a-time concat allocates one intermediate string
  // and one object per line, which a full tail replay makes measurable.
  while (cursor < lines.length) {
    const tail = next[next.length - 1];
    const room = tail && open < chunkLines ? chunkLines - open : 0;
    const take = Math.min(room || chunkLines, lines.length - cursor);
    const group = `${lines.slice(cursor, cursor + take).join("\n")}\n`;
    if (room === 0) {
      next.push({ id: (tail?.id ?? -1) + 1, text: group, carry: tail ? carryAfter(tail.carry, tail.text) : "" });
      open = take;
    } else {
      next[next.length - 1] = { ...tail, text: `${tail.text}${group}` };
      open += take;
    }
    cursor += take;
  }
  return { chunks: next, openLines: open };
}

/**
 * Drops whole slices off the front once the buffer no longer needs them.
 *
 * A slice is only released while the remainder still covers `maxLines`: dropping
 * on `total > maxLines` instead undershoots by up to a slice, which collapses the
 * pane to a handful of lines whenever `maxLines` is near `chunkLines`.
 * Retained lines therefore stay within [maxLines, maxLines + chunkLines).
 */
export function trimLogChunks(chunks: LogChunk[], openLines: number, maxLines: number) {
  const sealed = Math.max(0, chunks.length - 1);
  let total = sealed * chunkLines + openLines;
  let first = 0;
  while (first < sealed && total - chunkLines >= maxLines) {
    total -= chunkLines;
    first += 1;
  }
  return first === 0 ? chunks : chunks.slice(first);
}

/** Buckets matches into chunk-local coordinates; chunks keep no absolute offset,
 *  so trimming the front of the buffer never invalidates a memoised slice. */
function bucketMatches(spans: ChunkSpan[], matches: TextMatch[]) {
  const buckets: IndexedMatch[][] = spans.map(() => noChunkMatches);
  if (matches.length === 0) return buckets;
  let cursor = 0;
  spans.forEach((span, index) => {
    while (cursor < matches.length && matches[cursor].end <= span.start) cursor += 1;
    const bucket: IndexedMatch[] = [];
    for (let scan = cursor; scan < matches.length && matches[scan].start < span.end; scan += 1) {
      const match = matches[scan];
      if (match.end > span.start) bucket.push({ start: match.start - span.start, end: match.end - span.start, matchIndex: scan });
    }
    if (bucket.length) buckets[index] = bucket;
  });
  return buckets;
}

function sameMatches(left: IndexedMatch[], right: IndexedMatch[]) {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((match, index) => match.start === right[index].start && match.end === right[index].end && match.matchIndex === right[index].matchIndex);
}

const LogChunkView = memo(function LogChunkView({ carry, currentIndex, matches, text }: { carry: string; currentIndex: number; matches: IndexedMatch[]; text: string }) {
  const entries = useMemo(() => Anser.ansiToJson(carry + text).filter((entry) => entry.content.length > 0), [carry, text]);
  let offset = 0;
  const nodes: ReactNode[] = [];
  entries.forEach((entry, entryIndex) => {
    const content = entry.content.replace(/\r/g, "");
    const start = offset;
    const end = start + content.length;
    const children: ReactNode[] = [];
    let cursor = 0;
    matches.filter((match) => match.end > start && match.start < end).forEach((match) => {
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
  return <>{nodes}</>;
}, (previous, next) => previous.text === next.text
  && previous.carry === next.carry
  && previous.currentIndex === next.currentIndex
  && sameMatches(previous.matches, next.matches));

export function AnsiHighlightedText({ chunks, currentIndex, matches }: { chunks: LogChunk[]; currentIndex: number; matches: TextMatch[] }) {
  const rootRef = useRef<HTMLSpanElement>(null);
  // Slices are immutable, so their plain length is measured once. Without this the
  // pane re-scans the whole buffer on every appended batch.
  const plainLengths = useRef(new WeakMap<LogChunk, number>());
  const spans = useMemo(() => {
    let start = 0;
    return chunks.map((chunk) => {
      let length = plainLengths.current.get(chunk);
      if (length === undefined) {
        length = plainLength(chunk.text);
        plainLengths.current.set(chunk, length);
      }
      const span: ChunkSpan = { start, end: start + length };
      start = span.end;
      return span;
    });
  }, [chunks]);
  const buckets = useMemo(() => bucketMatches(spans, matches), [spans, matches]);
  const current = matches[currentIndex];

  // Keyed on where the active match sits, not on the match array: streamed output
  // rebuilds that array every batch, and depending on it dragged the viewport back
  // to the match several times a second, making a live log unreadable while a query
  // was open. Appending shifts nothing ahead of the match, so this only fires when
  // the reader navigates matches (or trimming moves the buffer under them).
  useEffect(() => {
    rootRef.current?.querySelector("mark.current")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [currentIndex, current?.start, current?.end]);

  return <span ref={rootRef}>{chunks.map((chunk, index) => {
    // Only the slice holding the active match needs to know about it, so stepping
    // through matches re-renders two slices instead of the whole buffer.
    const holdsCurrent = Boolean(current) && current.end > spans[index].start && current.start < spans[index].end;
    return <LogChunkView key={chunk.id} carry={chunk.carry} currentIndex={holdsCurrent ? currentIndex : -1} matches={buckets[index]} text={chunk.text} />;
  })}</span>;
}
