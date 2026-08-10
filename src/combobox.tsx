import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronsUpDown, Search, X, type LucideIcon } from "lucide-react";
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
  const allSelected = selected.length === 0;
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

  const toggle = (value: string) => {
    if (value === ALL_NAMESPACES) {
      onChange([]);
      return;
    }
    if (selected.includes(value)) {
      onChange(selected.filter((item) => item !== value));
      return;
    }
    onChange([...selected, value]);
  };

  const remove = (value: string) => {
    onChange(selected.filter((item) => item !== value));
  };

  return <div className={cn("combobox", "table-namespace-combobox", "multi", open && "open", className)} ref={root}>
    <button
      type="button"
      className="combobox-trigger"
      aria-label={t(language, "namespace")}
      aria-expanded={open}
      onClick={() => {
        if (open) { setOpen(false); setQuery(""); }
        else { window.dispatchEvent(new Event("kubehive:combobox-open")); setOpen(true); }
      }}
    >
      <span>{t(language, "namespace")}</span>
      <div className="namespace-multi-values">
        {allSelected
          ? <strong className="namespace-multi-all">{t(language, "allNamespaces")}</strong>
          : selected.map((item) => (
            <span key={item} className="namespace-chip" onClick={(event) => event.stopPropagation()}>
              <em>{item}</em>
              <i
                role="button"
                tabIndex={0}
                aria-label={`${tr(language, "clear")} ${item}`}
                onClick={(event) => { event.stopPropagation(); remove(item); }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    event.stopPropagation();
                    remove(item);
                  }
                }}
              ><X size={10} /></i>
            </span>
          ))}
      </div>
      <ChevronsUpDown className="combobox-chevron" size={12} />
    </button>
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
