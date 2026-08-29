import { cn } from "@/lib/utils";
import { Clock3, Search, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { tr } from "../i18n";
import type { AppLanguage } from "../preferences";
import type { ResourceRow } from "../resource-catalog";

const SEARCH_HISTORY_LIMIT = 8;
const searchHistoryStorageKey = (scope: string) => `kubehive.searchHistory.${scope}`;

function readSearchHistory(scope: string): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(searchHistoryStorageKey(scope)) ?? "[]") as unknown;
    if (!Array.isArray(saved)) return [];
    return saved.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, SEARCH_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function writeSearchHistory(scope: string, history: string[]) {
  try {
    localStorage.setItem(searchHistoryStorageKey(scope), JSON.stringify(history));
  } catch {
    // Search remains available when local storage is disabled.
  }
}

function withRecentSearch(history: string[], query: string): string[] {
  const normalized = query.trim();
  if (!normalized) return history;
  return [normalized, ...history.filter((item) => item.toLocaleLowerCase() !== normalized.toLocaleLowerCase())].slice(0, SEARCH_HISTORY_LIMIT);
}

const resourceSearchTextCache = new WeakMap<ResourceRow, string>();

function resourceSearchText(row: ResourceRow) {
  const cached = resourceSearchTextCache.get(row);
  if (cached) return cached;
  const value = `${row.name} ${row.namespace} ${row.kind} ${Object.values(row.data).join(" ")}`.toLowerCase();
  resourceSearchTextCache.set(row, value);
  return value;
}

function isFindShortcut(event: KeyboardEvent | ReactKeyboardEvent) {
  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f";
}

function isInsideSessionDock(node: EventTarget | null) {
  return node instanceof Element && Boolean(node.closest(".session-dock"));
}

function isInsideExpandedSessionDock(node: EventTarget | null) {
  if (!(node instanceof Element)) return false;
  const dock = node.closest(".session-dock");
  return Boolean(dock && !dock.classList.contains("collapsed"));
}

/** Last pointer target inside the bottom sheet (tabs count) owns Cmd/Ctrl+F until the user clicks elsewhere. */
let sessionDockFindContextActive = false;

function noteSessionDockFindContext(target: EventTarget | null) {
  sessionDockFindContextActive = isInsideSessionDock(target);
}

function sessionDockFindEnabled() {
  return Boolean(document.querySelector(".session-dock[data-session-find='true']"));
}

function isSessionFindContext(eventTarget: EventTarget | null = null) {
  if (!sessionDockFindEnabled()) return false;
  if (isInsideExpandedSessionDock(eventTarget) || isInsideExpandedSessionDock(document.activeElement)) return true;
  return sessionDockFindContextActive;
}

function useSessionDockFindContextTracking() {
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => noteSessionDockFindContext(event.target);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, []);
}

function focusTableSearchInput(input: HTMLInputElement | null) {
  if (!input) return;
  input.focus();
  input.select();
}

/** Focus a list/filter search box on Cmd/Ctrl+F unless the bottom sheet owns the shortcut. */
function useResourceListFindShortcut(focusSearch: () => boolean | void) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!isFindShortcut(event)) return;
      if (isSessionFindContext(event.target)) return;
      const active = document.activeElement;
      if (active instanceof Element && active.closest(".modal-backdrop, [role='dialog'], .text-search-popover, .command-modal")) return;
      if (focusSearch() === false) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [focusSearch]);
}

type TableSearchHandle = { focus: () => boolean };

/**
 * Marks the table toolbar as "pinned" once it locks flush under the tab strip,
 * so it can shed its top border and corners (the tab strip's own border takes
 * over). The toolbar keeps its rounded, bordered look while at rest.
 */
function useToolbarPinned(toolbarRef: RefObject<HTMLDivElement | null>): boolean {
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    const toolbar = toolbarRef.current;
    const scroller = toolbar?.closest(".workspace-scroll, .cluster-home-scroll") as HTMLElement | null;
    if (!toolbar || !scroller) return;
    if (getComputedStyle(toolbar).position !== "sticky") {
      setPinned(false);
      return;
    }
    const update = () => {
      const toolbarTop = toolbar.getBoundingClientRect().top;
      const scrollportTop = scroller.getBoundingClientRect().top;
      setPinned(toolbarTop <= scrollportTop + 0.5);
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      scroller.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [toolbarRef]);
  return pinned;
}

function TableSearchField({
  value,
  onChange,
  placeholder,
  ariaLabel,
  clearLabel,
  handleRef,
  className,
  language,
  historyScope,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  clearLabel: string;
  handleRef?: RefObject<TableSearchHandle | null>;
  className?: string;
  language: AppLanguage;
  historyScope: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const historyListId = `table-search-history-${useId()}`;
  // Collapsed to an icon-only toggle until activated (click or Cmd/Ctrl+F).
  const [active, setActive] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState(() => readSearchHistory(historyScope));
  const [selectedHistoryIndex, setSelectedHistoryIndex] = useState(-1);
  const matchingHistory = useMemo(() => {
    const normalized = value.trim().toLocaleLowerCase();
    if (!normalized) return history;
    return history.filter((item) => item.toLocaleLowerCase().includes(normalized) && item.toLocaleLowerCase() !== normalized);
  }, [history, value]);
  const showHistory = active && historyOpen && matchingHistory.length > 0;

  useEffect(() => {
    if (active) focusTableSearchInput(inputRef.current);
  }, [active]);

  useEffect(() => {
    setSelectedHistoryIndex(-1);
  }, [value, historyOpen, matchingHistory.length]);

  useEffect(() => {
    setHistory(readSearchHistory(historyScope));
  }, [historyScope]);

  const updateHistory = useCallback((next: string[]) => {
    setHistory(next);
    writeSearchHistory(historyScope, next);
  }, [historyScope]);

  const remember = useCallback((query: string) => {
    setHistory((current) => {
      const next = withRecentSearch(current, query);
      writeSearchHistory(historyScope, next);
      return next;
    });
  }, [historyScope]);

  const focus = useCallback(() => {
    setActive(true);
    setHistoryOpen(true);
    focusTableSearchInput(inputRef.current);
    return true;
  }, []);

  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = { focus };
    return () => { handleRef.current = null; };
  }, [focus, handleRef]);

  const clear = () => {
    onChange("");
    setHistoryOpen(true);
    setSelectedHistoryIndex(-1);
    focusTableSearchInput(inputRef.current);
  };

  const applyHistory = (query: string) => {
    onChange(query);
    remember(query);
    setHistoryOpen(false);
    focusTableSearchInput(inputRef.current);
  };

  const removeHistory = (query: string) => {
    updateHistory(history.filter((item) => item !== query));
  };

  return <div className={cn("table-search table-search-collapsible", active && "active", value && "has-value", showHistory && "history-open", className)} onBlur={(event) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    remember(value);
    setHistoryOpen(false);
    if (!value.trim()) setActive(false);
  }}>
    <button type="button" className="table-search-toggle" aria-label={ariaLabel} onMouseDown={(event) => event.preventDefault()} onClick={() => { setActive(true); setHistoryOpen(true); }}><Search size={14} aria-hidden="true" /></button>
    <Search size={14} aria-hidden="true" className="table-search-icon" />
    <input ref={inputRef} value={value} role="combobox" aria-expanded={showHistory} aria-controls={showHistory ? historyListId : undefined} aria-autocomplete="list" aria-activedescendant={showHistory && selectedHistoryIndex >= 0 ? `${historyListId}-${selectedHistoryIndex}` : undefined} onFocus={() => setHistoryOpen(true)} onChange={(event) => { onChange(event.target.value); setHistoryOpen(true); setSelectedHistoryIndex(-1); }} onKeyDown={(event) => {
      if (event.key === "ArrowDown" && matchingHistory.length) {
        event.preventDefault();
        setHistoryOpen(true);
        setSelectedHistoryIndex((current) => current < matchingHistory.length - 1 ? current + 1 : 0);
      } else if (event.key === "ArrowUp" && matchingHistory.length) {
        event.preventDefault();
        setHistoryOpen(true);
        setSelectedHistoryIndex((current) => current > 0 ? current - 1 : matchingHistory.length - 1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        const selected = selectedHistoryIndex >= 0 ? matchingHistory[selectedHistoryIndex] : undefined;
        if (selected) applyHistory(selected);
        else {
          remember(value);
          setHistoryOpen(false);
        }
      } else if (event.key === "Escape") {
        event.stopPropagation();
        if (historyOpen) setHistoryOpen(false);
        else setActive(false);
      }
    }} aria-label={ariaLabel} placeholder={placeholder} />
    {value ? <button type="button" className="table-search-clear" aria-label={clearLabel} onMouseDown={(event) => event.preventDefault()} onClick={clear}><X size={12} /></button> : null}
    {showHistory ? <div className="table-search-history" role="listbox" id={historyListId} aria-label={tr(language, "recentSearches")}>
      <div className="table-search-history-head"><span>{tr(language, "recentSearches")}</span><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => updateHistory([])}>{tr(language, "clearSearchHistory")}</button></div>
      <div className="table-search-history-list">{matchingHistory.map((query, index) => <div className={cn("table-search-history-option", selectedHistoryIndex === index && "selected")} key={query}>
        <button type="button" role="option" id={`${historyListId}-${index}`} aria-selected={selectedHistoryIndex === index} title={query} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setSelectedHistoryIndex(index)} onClick={() => applyHistory(query)}><Clock3 size={13} aria-hidden="true" /><span>{query}</span></button>
        <button type="button" className="table-search-history-remove" aria-label={tr(language, "removeSearchHistory", { query })} title={tr(language, "removeSearchHistory", { query })} onMouseDown={(event) => event.preventDefault()} onClick={() => removeHistory(query)}><X size={12} aria-hidden="true" /></button>
      </div>)}</div>
    </div> : null}
  </div>;
}

function useTableSearchFocus(handleRef: RefObject<TableSearchHandle | null>) {
  return useCallback(() => handleRef.current?.focus() ?? false, [handleRef]);
}

export {
  TableSearchField,
  isFindShortcut,
  isSessionFindContext,
  noteSessionDockFindContext,
  resourceSearchText,
  useResourceListFindShortcut,
  useSessionDockFindContextTracking,
  useTableSearchFocus,
  useToolbarPinned,
};
export type { TableSearchHandle };
