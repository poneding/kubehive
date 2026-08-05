import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CaseSensitive, ChevronDown, ChevronUp, Regex, Search, WholeWord, X } from "lucide-react";
import { tr, type AppLanguage } from "./i18n";
import { cn } from "./ui";

export type TextMatch = { start: number; end: number };
export type TextSearchController = {
  query: string;
  setQuery: (query: string) => void;
  caseSensitive: boolean;
  setCaseSensitive: (enabled: boolean) => void;
  regularExpression: boolean;
  setRegularExpression: (enabled: boolean) => void;
  wholeWord: boolean;
  setWholeWord: (enabled: boolean) => void;
  matches: TextMatch[];
  currentIndex: number;
  setCurrentIndex: (index: number) => void;
  next: () => void;
  previous: () => void;
  error: string;
};

type SearchOptions = { caseSensitive: boolean; regularExpression: boolean; wholeWord: boolean };

const wordCharacter = /[\p{L}\p{N}_]/u;
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function findTextMatches(text: string, query: string, options: SearchOptions): { matches: TextMatch[]; error: string } {
  if (!query) return { matches: [], error: "" };
  let expression: RegExp;
  try {
    expression = new RegExp(options.regularExpression ? query : escapeRegExp(query), `g${options.caseSensitive ? "" : "i"}u`);
  } catch (error) {
    return { matches: [], error: error instanceof Error ? error.message : String(error) };
  }
  const matches: TextMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = expression.exec(text)) && matches.length < 20_000) {
    const start = match.index;
    const end = start + match[0].length;
    const before = start > 0 ? text[start - 1] : "";
    const after = end < text.length ? text[end] : "";
    if (!options.wholeWord || (!wordCharacter.test(before) && !wordCharacter.test(after))) matches.push({ start, end });
    if (match[0].length === 0) expression.lastIndex += 1;
  }
  return { matches, error: "" };
}

export function useTextSearch(text: string): TextSearchController {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regularExpression, setRegularExpression] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const result = useMemo(
    () => findTextMatches(text, query, { caseSensitive, regularExpression, wholeWord }),
    [text, query, caseSensitive, regularExpression, wholeWord],
  );

  useEffect(() => {
    setCurrentIndex((current) => result.matches.length === 0 ? 0 : Math.min(current, result.matches.length - 1));
  }, [result.matches.length, query, caseSensitive, regularExpression, wholeWord]);

  const move = (step: number) => {
    if (result.matches.length === 0) return;
    setCurrentIndex((current) => (current + step + result.matches.length) % result.matches.length);
  };

  return {
    query,
    setQuery,
    caseSensitive,
    setCaseSensitive,
    regularExpression,
    setRegularExpression,
    wholeWord,
    setWholeWord,
    matches: result.matches,
    currentIndex,
    setCurrentIndex,
    next: () => move(1),
    previous: () => move(-1),
    error: result.error,
  };
}

export function TextSearchPopover({ open, onClose, search, language, focusRequest = 0 }: { open: boolean; onClose: () => void; search: TextSearchController; language: AppLanguage; focusRequest?: number }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    // Remember who owned the focus (e.g. the manifest editor) so closing the
    // popover can hand it back instead of dropping it on <body>.
    const active = document.activeElement;
    if (active instanceof HTMLElement && !active.closest(".text-search-popover")) restoreFocusRef.current = active;
    const timer = window.setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 0);
    return () => window.clearTimeout(timer);
  }, [open, focusRequest]);
  const close = () => {
    const target = restoreFocusRef.current;
    onClose();
    if (target?.isConnected && !target.closest(".text-search-popover")) target.focus();
  };
  if (!open) return null;
  const count = search.matches.length;
  return <div className="text-search-popover" role="search" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
  }}>
    <Search size={13}/>
    <input
      ref={inputRef}
      aria-label={tr(language, "findText")}
      value={search.query}
      onChange={(event) => { search.setQuery(event.target.value); search.setCurrentIndex(0); }}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); event.shiftKey ? search.previous() : search.next(); }
      }}
      placeholder={tr(language, "find")}
    />
    <span className={cn("text-search-count", search.error && "error")} title={search.error || undefined}>{search.error ? tr(language, "invalidRegex") : count ? `${search.currentIndex + 1}/${count}` : "0/0"}</span>
    <button type="button" className={cn(search.caseSensitive && "active")} aria-label={tr(language, "matchCase")} aria-pressed={search.caseSensitive} onClick={() => search.setCaseSensitive(!search.caseSensitive)}><CaseSensitive size={13}/></button>
    <button type="button" className={cn(search.wholeWord && "active")} aria-label={tr(language, "wholeWord")} aria-pressed={search.wholeWord} onClick={() => search.setWholeWord(!search.wholeWord)}><WholeWord size={13}/></button>
    <button type="button" className={cn(search.regularExpression && "active")} aria-label={tr(language, "regularExpression")} aria-pressed={search.regularExpression} onClick={() => search.setRegularExpression(!search.regularExpression)}><Regex size={13}/></button>
    <button type="button" aria-label={tr(language, "previousMatch")} disabled={!count} onClick={search.previous}><ChevronUp size={13}/></button>
    <button type="button" aria-label={tr(language, "nextMatch")} disabled={!count} onClick={search.next}><ChevronDown size={13}/></button>
    <button type="button" aria-label={tr(language, "closeSearch")} onClick={close}><X size={13}/></button>
  </div>;
}

export function HighlightedText({ text, matches, currentIndex }: { text: string; matches: TextMatch[]; currentIndex: number }) {
  const rootRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    rootRef.current?.querySelector("mark.current")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [currentIndex, matches]);
  if (matches.length === 0) return text;
  const content: ReactNode[] = [];
  let cursor = 0;
  matches.forEach((match, index) => {
    if (match.start > cursor) content.push(text.slice(cursor, match.start));
    content.push(<mark key={`${match.start}-${match.end}-${index}`} className={cn(index === currentIndex && "current")}>{text.slice(match.start, match.end)}</mark>);
    cursor = Math.max(cursor, match.end);
  });
  if (cursor < text.length) content.push(text.slice(cursor));
  return <span ref={rootRef}>{content}</span>;
}
