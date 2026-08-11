import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronsUpDown, Search, X, type LucideIcon } from "lucide-react";
import { revealTabInRail } from "./tab-scroll";
import { tr, type AppLanguage } from "./i18n";
import { t } from "./preferences";
import { ScrollArea } from "@/components/ui";
import { cn } from "@/lib/utils";

export type ComboboxOption = { value: string; label: string; description?: string; group?: string; icon?: LucideIcon };

function useOptionsOverflow(open: boolean, contentKey: string) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [hasOverflow, setHasOverflow] = useState(false);
  useLayoutEffect(() => {
    if (!open) {
      setHasOverflow(false);
      return;
    }
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => setHasOverflow(viewport.scrollHeight > viewport.clientHeight + 0.5);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [contentKey, open]);
  return { hasOverflow, viewportRef };
}

export function Combobox({ value, options, onChange, label, ariaLabel, searchable = true, className, leadingIcon: LeadingIcon, language }: { value: string; options: ComboboxOption[]; onChange: (value: string) => void; label?: string; ariaLabel?: string; searchable?: boolean; className?: string; leadingIcon?: LucideIcon; language?: AppLanguage }) {
  const displayLanguage = language ?? (document.documentElement.lang === "zh-TW" ? "zh-TW" : document.documentElement.lang === "zh-CN" ? "zh-CN" : "en");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];
  const SelectedIcon = selected?.icon ?? LeadingIcon;
  const filtered = searchable ? options.filter((option) => `${option.label} ${option.description ?? ""}`.toLowerCase().includes(query.toLowerCase())) : options;
  const optionGroups = filtered.reduce<Array<{ label?: string; options: ComboboxOption[] }>>((groups, option) => {
    const previous = groups.at(-1);
    if (previous && previous.label === option.group) previous.options.push(option);
    else groups.push({ label: option.group, options: [option] });
    return groups;
  }, []);
  const optionsContentKey = filtered.map((option) => `${option.value}\u0000${option.label}\u0000${option.description ?? ""}\u0000${option.group ?? ""}`).join("\u0001");
  const { hasOverflow: hasOptionsOverflow, viewportRef: optionsViewportRef } = useOptionsOverflow(open, optionsContentKey);

  useEffect(() => {
    const close = () => { setOpen(false); setQuery(""); };
    const closeOnOutsideClick = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    window.addEventListener("mousedown", closeOnOutsideClick);
    window.addEventListener("kubehive:combobox-open", close);
    return () => {
      window.removeEventListener("mousedown", closeOnOutsideClick);
      window.removeEventListener("kubehive:combobox-open", close);
    };
  }, []);

  return <div className={cn("combobox", !searchable && "without-search", open && "open", className)} ref={root}>
    <button type="button" className="combobox-trigger" aria-label={ariaLabel ?? label} aria-expanded={open} onClick={() => {
      if (open) { setOpen(false); setQuery(""); }
      else { window.dispatchEvent(new Event("kubehive:combobox-open")); setOpen(true); }
    }}>
      {SelectedIcon && <SelectedIcon className="combobox-leading-icon" size={12} aria-hidden="true" />}{label && <span>{label}</span>}<strong>{selected?.label}</strong><ChevronsUpDown className="combobox-chevron" size={12} />
    </button>
    {open && <div className="combobox-popover">
      {searchable && <div className="combobox-search"><Search size={13} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr(displayLanguage, "searchPlaceholder")} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }} /></div>}
      <ScrollArea className="combobox-options overflow-visible" data-scrollbar-gutter={hasOptionsOverflow ? "true" : undefined} verticalScrollbarOffset={-10} viewportClassName="combobox-options-viewport" viewportRef={optionsViewportRef}>
        <div className="combobox-options-content">{optionGroups.map((group, index) => <div className="combobox-option-group" role={group.label ? "group" : undefined} aria-label={group.label} key={`${group.label ?? "options"}-${index}`}>{group.label && <div className="combobox-group-label">{group.label}</div>}{group.options.map((option) => { const OptionIcon = option.icon; return <button key={option.value} onClick={() => { onChange(option.value); setOpen(false); setQuery(""); }}>{OptionIcon && <OptionIcon className="combobox-option-icon" size={13} aria-hidden="true" />}<span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span><Check size={13} className={cn("combobox-option-check", option.value !== value && "invisible")} /></button>; })}</div>)}{filtered.length === 0 && <p>{tr(displayLanguage, "noOptionsFound")}</p>}</div>
      </ScrollArea>
    </div>}
  </div>;
}

const ALL_NAMESPACES = "All namespaces";
// A short token still contributes one visible slot, so every addition grows the trigger until its CSS max-width.
const NAMESPACE_SELECTION_BASE_WIDTH = 180;
const NAMESPACE_SELECTION_STEP_WIDTH = 24;

/** Multi-select namespace filter. Empty selection means "All namespaces". */
export function NamespaceMultiCombobox({
  values,
  namespaces,
  onChange,
  language,
  className,
}: {
  values: string[];
  namespaces: string[];
  onChange: (values: string[]) => void;
  language: AppLanguage;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const selected = values.filter((value) => value && value !== ALL_NAMESPACES);
  const [caretIndex, setCaretIndex] = useState(selected.length);
  const [allTokensSelected, setAllTokensSelected] = useState(false);
  const tokenViewportRef = useRef<HTMLDivElement>(null);
  const tokenInputRef = useRef<HTMLInputElement>(null);
  const restoreTokenFocusRef = useRef(false);
  const previousSelectedLengthRef = useRef(selected.length);
  const allSelected = selected.length === 0;
  const minimumCaretIndex = allSelected ? 0 : 1;
  const clampCaretIndex = (position: number, count = selected.length) => Math.max(count > 0 ? 1 : 0, Math.min(position, count));
  const selectedSignature = selected.join("\u0000");
  const selectedWidthFloor = `${NAMESPACE_SELECTION_BASE_WIDTH + selected.length * NAMESPACE_SELECTION_STEP_WIDTH}px`;
  const triggerSizingStyle = !allSelected
    ? ({ "--namespace-selection-min-width": selectedWidthFloor } as CSSProperties)
    : undefined;
  const filtered = namespaces.filter((item) => item.toLowerCase().includes(query.toLowerCase()));
  const optionsContentKey = filtered.join("\u0000");
  const { hasOverflow: hasOptionsOverflow, viewportRef: optionsViewportRef } = useOptionsOverflow(open, optionsContentKey);

  useEffect(() => {
    const close = () => { setOpen(false); setQuery(""); };
    const closeOnOutsideClick = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    window.addEventListener("mousedown", closeOnOutsideClick);
    window.addEventListener("kubehive:combobox-open", close);
    return () => {
      window.removeEventListener("mousedown", closeOnOutsideClick);
      window.removeEventListener("kubehive:combobox-open", close);
    };
  }, []);

  useEffect(() => {
    const viewport = tokenViewportRef.current;
    if (!viewport) return;
    const scrollTokensOnWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || viewport.scrollWidth <= viewport.clientWidth) return;
      const delta = event.shiftKey
        ? event.deltaY || event.deltaX
        : Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      const distance = event.deltaMode === 1 ? delta * 16 : event.deltaMode === 2 ? delta * viewport.clientWidth : delta;
      viewport.scrollLeft += distance;
      event.preventDefault();
      event.stopPropagation();
    };
    viewport.addEventListener("wheel", scrollTokensOnWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", scrollTokensOnWheel);
  }, []);

  useLayoutEffect(() => {
    const previousLength = previousSelectedLengthRef.current;
    previousSelectedLengthRef.current = selected.length;
    setCaretIndex((position) => position === previousLength ? selected.length : clampCaretIndex(position));
    setAllTokensSelected(false);
  }, [selected.length, selectedSignature]);

  useLayoutEffect(() => {
    const viewport = tokenViewportRef.current;
    const input = tokenInputRef.current;
    if (!viewport || !input) return;
    if (restoreTokenFocusRef.current) {
      input.focus({ preventScroll: true });
      restoreTokenFocusRef.current = false;
    }
    revealTabInRail(viewport, input, "auto");
  }, [caretIndex, selectedSignature]);

  const openOptions = () => {
    if (open) return;
    window.dispatchEvent(new Event("kubehive:combobox-open"));
    setOpen(true);
  };

  const toggleOptions = () => {
    if (open) { setOpen(false); setQuery(""); }
    else openOptions();
  };

  const focusCaretAt = (position: number) => {
    tokenInputRef.current?.focus({ preventScroll: true });
    restoreTokenFocusRef.current = true;
    setAllTokensSelected(false);
    setCaretIndex(clampCaretIndex(position));
  };

  const removeAt = (index: number) => {
    if (index < 0 || index >= selected.length) return;
    const next = selected.filter((_, currentIndex) => currentIndex !== index);
    restoreTokenFocusRef.current = true;
    setAllTokensSelected(false);
    setCaretIndex((position) => clampCaretIndex(index < position ? position - 1 : Math.min(position, next.length), next.length));
    onChange(next);
  };

  const removeAll = () => {
    restoreTokenFocusRef.current = true;
    setAllTokensSelected(false);
    setCaretIndex(0);
    onChange([]);
  };

  const toggle = (value: string) => {
    if (value === ALL_NAMESPACES) {
      removeAll();
      return;
    }
    const selectedIndex = selected.indexOf(value);
    if (selectedIndex >= 0) {
      removeAt(selectedIndex);
      return;
    }
    restoreTokenFocusRef.current = true;
    setAllTokensSelected(false);
    setCaretIndex(selected.length + 1);
    onChange([...selected, value]);
  };

  const onTokenKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const key = event.key;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && key.toLowerCase() === "a") {
      event.preventDefault();
      event.stopPropagation();
      setAllTokensSelected(selected.length > 0);
      return;
    }
    if (key === "ArrowLeft" || key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      restoreTokenFocusRef.current = true;
      if (allTokensSelected) {
        setAllTokensSelected(false);
        setCaretIndex(key === "ArrowLeft" ? minimumCaretIndex : selected.length);
      } else {
        setCaretIndex((position) => key === "ArrowLeft" ? Math.max(minimumCaretIndex, position - 1) : Math.min(selected.length, position + 1));
      }
      return;
    }
    if (key === "Home" || key === "End") {
      event.preventDefault();
      event.stopPropagation();
      restoreTokenFocusRef.current = true;
      setAllTokensSelected(false);
      setCaretIndex(key === "Home" ? minimumCaretIndex : selected.length);
      return;
    }
    if (key === "Backspace" || key === "Delete") {
      event.preventDefault();
      event.stopPropagation();
      if (allTokensSelected) {
        removeAll();
        return;
      }
      const removeIndex = key === "Backspace"
        ? caretIndex - 1
        : caretIndex < selected.length ? caretIndex : selected.length - 1;
      removeAt(removeIndex);
      return;
    }
    if (key === "Enter" || key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      openOptions();
      return;
    }
    if (key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setQuery("");
    }
  };

  const renderTokenCaret = (atEnd = false) => <input
    key="namespace-token-caret"
    ref={tokenInputRef}
    className={cn("namespace-token-input", atEnd && "at-end")}
    type="text"
    value=""
    autoComplete="off"
    spellCheck={false}
    aria-label={t(language, "namespace")}
    onChange={() => undefined}
    onClick={(event) => event.stopPropagation()}
    onFocus={() => { setAllTokensSelected(false); }}
    onKeyDown={onTokenKeyDown}
  />;

  return <div className={cn("combobox", "table-namespace-combobox", "multi", open && "open", !allSelected && "has-selection", className)} style={triggerSizingStyle} ref={root}>
    <div className={cn("combobox-trigger", "namespace-multi-trigger", !allSelected && "has-selection")} role="group" aria-label={t(language, "namespace")} onClick={toggleOptions}>
      <span>{t(language, "namespace")}</span>
      <ScrollArea className="namespace-token-scroll-area" scrollbars="horizontal" hideScrollbars type="hover" viewportClassName="namespace-multi-values" viewportRef={tokenViewportRef}>
        <div className={cn("namespace-token-list", !allSelected && "has-selection")} onClick={(event) => {
          if (allSelected) return;
          event.stopPropagation();
          focusCaretAt(selected.length);
        }}>
          {allSelected
            ? <strong className="namespace-multi-all">{t(language, "allNamespaces")}</strong>
            : selected.flatMap((item, index) => [
              caretIndex === index ? renderTokenCaret() : null,
              <span key={item} className={cn("namespace-chip", allTokensSelected && "keyboard-selected")} onClick={(event) => { event.stopPropagation(); focusCaretAt(index + 1); }}>
                <em>{item}</em>
                <i
                  role="button"
                  tabIndex={0}
                  aria-label={`${tr(language, "clear")} ${item}`}
                  onClick={(event) => { event.stopPropagation(); removeAt(index); }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      removeAt(index);
                    }
                  }}
                ><X size={10} /></i>
              </span>,
            ])}
          {!allSelected && caretIndex === selected.length && renderTokenCaret(true)}
        </div>
      </ScrollArea>
      <button type="button" className="namespace-combobox-toggle" aria-label={t(language, "namespace")} aria-expanded={open} onClick={(event) => { event.stopPropagation(); toggleOptions(); }}><ChevronsUpDown size={12} /></button>
    </div>
    {open && <div className="combobox-popover">
      <div className="combobox-search"><Search size={13} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr(language, "searchPlaceholder")} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }} /></div>
      <ScrollArea className="combobox-options overflow-visible" data-scrollbar-gutter={hasOptionsOverflow ? "true" : undefined} verticalScrollbarOffset={-10} viewportClassName="combobox-options-viewport" viewportRef={optionsViewportRef}>
        <div className="combobox-options-content">
        <button type="button" onClick={() => toggle(ALL_NAMESPACES)}>
          <span><strong>{t(language, "allNamespaces")}</strong></span>
          <Check size={13} className={cn("combobox-option-check", !allSelected && "invisible")} />
        </button>
        {filtered.map((item) => (
          <button type="button" key={item} onClick={() => toggle(item)}>
            <span><strong>{item}</strong></span>
            <Check size={13} className={cn("combobox-option-check", !selected.includes(item) && "invisible")} />
          </button>
        ))}
        {filtered.length === 0 && <p>{tr(language, "noOptionsFound")}</p>}
        </div>
      </ScrollArea>
    </div>}
  </div>;
}
