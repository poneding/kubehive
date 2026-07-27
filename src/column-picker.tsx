import { useEffect, useRef, useState } from "react";
import { Columns3 } from "lucide-react";
import { Button, cn } from "./ui";
import { getColumnDefs, loadVisibleColumns, saveVisibleColumns, type ColumnDef } from "./resource-catalog";
import { t, type AppLanguage } from "./preferences";

export function useVisibleColumns(resource: string) {
  const defs = getColumnDefs(resource);
  const [visible, setVisible] = useState<string[]>(() => loadVisibleColumns(resource));

  useEffect(() => {
    setVisible(loadVisibleColumns(resource));
  }, [resource]);

  const setColumnVisible = (id: string, next: boolean) => {
    const def = defs.find((item) => item.id === id);
    if (def?.required) return;
    setVisible((current) => {
      const updated = next
        ? defs.filter((item) => item.id === id || current.includes(item.id)).map((item) => item.id)
        : current.filter((item) => item !== id);
      const ensured = defs.filter((item) => item.required || updated.includes(item.id)).map((item) => item.id);
      saveVisibleColumns(resource, ensured);
      return ensured;
    });
  };

  const reset = () => {
    const defaults = defs.filter((item) => item.required || item.defaultVisible).map((item) => item.id);
    saveVisibleColumns(resource, defaults);
    setVisible(defaults);
  };

  const orderedVisible = defs.filter((item) => visible.includes(item.id));
  return { defs, visible: orderedVisible, setColumnVisible, reset, isVisible: (id: string) => visible.includes(id) };
}

export function ColumnPicker({ resource, language, defs, isVisible, onToggle, onReset }: {
  resource: string;
  language: AppLanguage;
  defs: ColumnDef[];
  isVisible: (id: string) => boolean;
  onToggle: (id: string, next: boolean) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  return <div className={cn("column-picker", open && "open")} ref={root} onClick={(event) => event.stopPropagation()}>
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="column-picker-trigger"
      aria-label={t(language, "columns")}
      title={t(language, "columns")}
      aria-expanded={open}
      onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}
    >
      <Columns3 size={14} />
    </Button>
    {open && <div className="column-picker-popover" role="menu" aria-label={t(language, "columns")}>
      <header>
        <strong>{t(language, "columns")}</strong>
        <button type="button" className="column-picker-reset" onClick={onReset}>{t(language, "resetColumns")}</button>
      </header>
      <div className="column-picker-list">
        {defs.map((column) => {
          const checked = isVisible(column.id);
          return <label key={column.id} className={cn(column.required && "required")}>
            <input
              type="checkbox"
              checked={checked}
              disabled={column.required}
              onChange={(event) => onToggle(column.id, event.target.checked)}
            />
            <span>{column.label}</span>
            {column.required && <small>{t(language, "requiredColumn")}</small>}
          </label>;
        })}
      </div>
    </div>}
  </div>;
}
