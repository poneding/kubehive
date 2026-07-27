import { useEffect, useRef, useState } from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { cn } from "./ui";

export type ComboboxOption = { value: string; label: string; description?: string };

export function Combobox({ value, options, onChange, label, className }: { value: string; options: ComboboxOption[]; onChange: (value: string) => void; label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];
  const filtered = options.filter((option) => `${option.label} ${option.description ?? ""}`.toLowerCase().includes(query.toLowerCase()));

  useEffect(() => {
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, []);

  return <div className={cn("combobox", open && "open", className)} ref={root}>
    <button type="button" className="combobox-trigger" aria-label={label} aria-expanded={open} onClick={() => setOpen((current) => !current)}>
      {label && <span>{label}</span>}<strong>{selected?.label}</strong><ChevronsUpDown size={12} />
    </button>
    {open && <div className="combobox-popover">
      <div className="combobox-search"><Search size={13} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search..." onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }} /></div>
      <div className="combobox-options">{filtered.map((option) => <button key={option.value} onClick={() => { onChange(option.value); setOpen(false); setQuery(""); }}><Check size={13} className={cn(option.value !== value && "invisible")} /><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span></button>)}{filtered.length === 0 && <p>No options found</p>}</div>
    </div>}
  </div>;
}
