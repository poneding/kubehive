import { useEffect, useRef, useState } from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { cn } from "./ui";

export type ComboboxOption = { value: string; label: string; description?: string; group?: string };

export function Combobox({ value, options, onChange, label, ariaLabel, searchable = true, className }: { value: string; options: ComboboxOption[]; onChange: (value: string) => void; label?: string; ariaLabel?: string; searchable?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];
  const filtered = searchable ? options.filter((option) => `${option.label} ${option.description ?? ""}`.toLowerCase().includes(query.toLowerCase())) : options;
  const optionGroups = filtered.reduce<Array<{ label?: string; options: ComboboxOption[] }>>((groups, option) => {
    const previous = groups.at(-1);
    if (previous && previous.label === option.group) previous.options.push(option);
    else groups.push({ label: option.group, options: [option] });
    return groups;
  }, []);

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
      {label && <span>{label}</span>}<strong>{selected?.label}</strong><ChevronsUpDown size={12} />
    </button>
    {open && <div className="combobox-popover">
      {searchable && <div className="combobox-search"><Search size={13} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search..." onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }} /></div>}
      <div className="combobox-options">{optionGroups.map((group, index) => <div className="combobox-option-group" role={group.label ? "group" : undefined} aria-label={group.label} key={`${group.label ?? "options"}-${index}`}>{group.label && <div className="combobox-group-label">{group.label}</div>}{group.options.map((option) => <button key={option.value} onClick={() => { onChange(option.value); setOpen(false); setQuery(""); }}><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span><Check size={13} className={cn(option.value !== value && "invisible")} /></button>)}</div>)}{filtered.length === 0 && <p>No options found</p>}</div>
    </div>}
  </div>;
}
