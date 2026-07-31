import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
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

function placePopover(anchor: DOMRect, popover: DOMRect): CSSProperties {
  const gap = 8;
  const margin = 8;
  const width = popover.width || 220;
  const height = popover.height || 280;
  let left = anchor.right - width;
  left = Math.min(Math.max(margin, left), window.innerWidth - width - margin);
  const spaceBelow = window.innerHeight - anchor.bottom - margin;
  const spaceAbove = anchor.top - margin;
  const preferBelow = spaceBelow >= height + gap || spaceBelow >= spaceAbove;
  const top = preferBelow
    ? Math.min(anchor.bottom + gap, window.innerHeight - height - margin)
    : Math.max(margin, anchor.top - height - gap);
  return {
    position: "fixed",
    top: Math.max(margin, top),
    left,
    right: "auto",
    zIndex: 220,
  };
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
  const popoverRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ position: "fixed", top: -9999, left: -9999, visibility: "hidden" });

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (root.current?.contains(target) || popoverRef.current?.contains(target)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    const onScroll = (event: Event) => {
      // Keep the panel open while scrolling its own list; only external page/workspace scrolls dismiss it.
      const target = event.target;
      if (target instanceof Node && popoverRef.current?.contains(target)) return;
      close();
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !root.current || !popoverRef.current) return;
    const update = () => {
      if (!root.current || !popoverRef.current) return;
      setStyle(placePopover(root.current.getBoundingClientRect(), popoverRef.current.getBoundingClientRect()));
    };
    update();
    // Second pass after list content paints to final size.
    const frame = window.requestAnimationFrame(update);
    return () => window.cancelAnimationFrame(frame);
  }, [open, defs.length, resource]);

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
    {open && createPortal(
      <div
        ref={popoverRef}
        className="column-picker-popover"
        role="menu"
        aria-label={t(language, "columns")}
        style={style}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
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
      </div>,
      document.body,
    )}
  </div>;
}
