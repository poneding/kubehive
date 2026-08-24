import { cn } from "@/lib/utils";
import { Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import type { ResourceRow } from "../resource-catalog";

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
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  clearLabel: string;
  handleRef?: RefObject<TableSearchHandle | null>;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Collapsed to an icon-only toggle until activated (click or Cmd/Ctrl+F).
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (active) focusTableSearchInput(inputRef.current);
  }, [active]);

  const focus = useCallback(() => {
    setActive(true);
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
    focusTableSearchInput(inputRef.current);
  };

  return <div className={cn("table-search table-search-collapsible", active && "active", value && "has-value", className)}>
    <button type="button" className="table-search-toggle" aria-label={ariaLabel} onMouseDown={(event) => event.preventDefault()} onClick={() => setActive(true)}><Search size={14} aria-hidden="true" /></button>
    <Search size={14} aria-hidden="true" className="table-search-icon" />
    <input ref={inputRef} value={value} onChange={(event) => onChange(event.target.value)} onBlur={(event) => { if (!value && !event.currentTarget.contains(event.relatedTarget as Node | null)) setActive(false); }} onKeyDown={(event) => { if (event.key === "Escape") setActive(false); }} aria-label={ariaLabel} placeholder={placeholder} />
    {value ? <button type="button" className="table-search-clear" aria-label={clearLabel} onMouseDown={(event) => event.preventDefault()} onClick={clear}><X size={12} /></button> : null}
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
