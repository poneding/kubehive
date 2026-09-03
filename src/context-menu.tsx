import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, X, type LucideIcon } from "lucide-react";
import { Button, Dialog, DialogContent, DialogTitle, Input } from "@/components/ui";
import { cn } from "@/lib/utils";
import { tr } from "./i18n";
import { t, type AppLanguage } from "./preferences";
import { clusterConnectionStatus, type Cluster } from "./data";
import "./context-menu-icons.css";

export type ContextMenuItem =
  | { type: "item"; id: string; label: string; icon?: LucideIcon; hoverDestructive?: boolean; hoverWarning?: boolean; disabled?: boolean; /** Native tooltip; where a disabled item explains itself. */ title?: string; onSelect: () => void }
  | { type: "separator" };

type MenuState = {
  x: number;
  y: number;
  items: ContextMenuItem[];
} | null;

let openHandler: ((state: MenuState) => void) | null = null;

export function openContextMenu(event: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation?: () => void }, items: ContextMenuItem[]) {
  event.preventDefault();
  event.stopPropagation?.();
  openHandler?.({ x: event.clientX, y: event.clientY, items });
}

export function ContextMenuHost() {
  const [menu, setMenu] = useState<MenuState>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const openedAtRef = useRef(0);

  useEffect(() => {
    openHandler = setMenu;
    return () => { if (openHandler === setMenu) openHandler = null; };
  }, []);

  useEffect(() => {
    if (!menu) return;
    openedAtRef.current = performance.now();
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    const onScroll = () => {
      // The browser scrolls the context-menu target into view immediately
      // after dispatching contextmenu when the target is clipped by a scroll
      // container (visible when a resource table is wider than the viewport).
      // That native scroll must not close the menu it just opened.
      if (performance.now() - openedAtRef.current < 50) return;
      close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [menu]);

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const left = Math.min(menu.x, window.innerWidth - rect.width - 8);
    const top = Math.min(menu.y, window.innerHeight - rect.height - 8);
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [menu]);

  if (!menu) return null;

  return createPortal(
    <div
      ref={ref}
      className="app-context-menu"
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(event) => event.stopPropagation()}
      role="menu"
    >
      {menu.items.map((item, index) => item.type === "separator"
        ? <div key={`sep-${index}`} className="app-context-menu-sep" role="separator" />
        : <button
          key={item.id}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          title={item.title}
          className={cn(item.hoverDestructive && "hover-destructive", item.hoverWarning && "hover-warning")}
          onClick={() => { setMenu(null); if (!item.disabled) item.onSelect(); }}
        >
          {item.icon && <item.icon size={13} aria-hidden="true" />}
          {item.label}
        </button>)}
    </div>,
    document.body,
  );
}

export function ClusterHoverCard({ cluster, color, anchor, language }: {
  cluster: Cluster;
  color: string;
  anchor: DOMRect;
  language: AppLanguage;
}) {
  const left = Math.min(anchor.right + 10, window.innerWidth - 240);
  const top = Math.min(Math.max(8, anchor.top + anchor.height / 2 - 70), window.innerHeight - 160);
  const connectionStatus = clusterConnectionStatus(cluster);
  return createPortal(
    <div className="cluster-hover-card" style={{ left, top, ["--cluster-accent" as string]: color }}>
      <header>
        <span className="cluster-hover-swatch" />
        <div>
          <strong>{cluster.name}</strong>
          <small>{cluster.provider} · {cluster.region}</small>
        </div>
      </header>
      <div className="cluster-hover-meta">
        <span>{t(language, "status")}<strong>{t(language, connectionStatus)}</strong></span>
        <span>{t(language, "version")}<strong>{cluster.version}</strong></span>
        <span>{tr(language, "nodes")}<strong>{cluster.nodes}</strong></span>
        <span>CPU<strong>{cluster.cpu}%</strong></span>
        <span>{tr(language, "memory")}<strong>{cluster.memory}%</strong></span>
      </div>
    </div>,
    document.body,
  );
}

export function ClusterSettingsDialog({
  clusterName,
  color,
  language,
  onSave,
  onClose,
}: {
  clusterName: string;
  color: string;
  language: AppLanguage;
  onSave: (name: string, color: string) => Promise<void>;
  onClose: () => void;
}) {
  const [draftName, setDraftName] = useState(clusterName);
  const [draftColor, setDraftColor] = useState(color);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const presets = ["#55d49a", "#3b82f6", "#f59e0b", "#a78bfa", "#f472b6", "#22d3ee", "#fb7185", "#94a3b8"];
  const submit = async () => {
    const name = draftName.trim();
    if (!name || busy) return;
    setBusy(true); setError("");
    try { await onSave(name, draftColor); onClose(); }
    catch (nextError) { setError(String(nextError)); }
    finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent
      aria-describedby={undefined}
      className="cluster-color-dialog block w-auto max-w-none gap-0 p-0 text-inherit"
      overlayClassName="modal-backdrop panel-dialog-backdrop"
      showCloseButton={false}
    >
      <header><DialogTitle>{t(language, "clusterSettings")}</DialogTitle><Button type="button" variant="ghost" size="icon" className="cluster-color-close" disabled={busy} onClick={onClose} aria-label={tr(language, "close")}><X size={14}/></Button></header>
      <div className="cluster-color-body">
        <label><span>{t(language, "clusterName")}</span><Input className="cluster-name-input shadow-none" autoFocus value={draftName} maxLength={128} onChange={(event) => setDraftName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submit(); } }}/></label>
        <label>
          <span>{t(language, "themeColor")}</span>
          <div className="cluster-color-row">
            <input type="color" aria-label={t(language, "themeColor")} value={draftColor} onChange={(event) => setDraftColor(event.target.value)} />
            <Input className="shadow-none" type="text" aria-label={t(language, "themeColor")} value={draftColor} onChange={(event) => { if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(event.target.value)) setDraftColor(event.target.value); }} />
          </div>
        </label>
        <div className="cluster-color-presets">
          {presets.map((preset) => (
            <button key={preset} type="button" className={cn(draftColor.toLowerCase() === preset.toLowerCase() && "active")} style={{ background: preset }} onClick={() => setDraftColor(preset)} aria-label={`${tr(language, "select")} ${preset}`}/>
          ))}
        </div>
        <div className="cluster-color-preview" style={{ ["--cluster-accent" as string]: draftColor }}><span>{t(language, "themeColor")}</span><div className="cluster-color-preview-pane">{t(language, "application")}</div></div>
        {error && <div className="cluster-settings-error" role="alert">{error}</div>}
      </div>
      <footer><Button type="button" variant="outline" size="sm" disabled={busy} onClick={onClose}>{t(language, "cancel")}</Button><Button type="button" size="sm" disabled={busy || !draftName.trim()} onClick={() => void submit()}>{busy && <LoaderCircle className="spin" size={13}/>} {t(language, "save")}</Button></footer>
    </DialogContent>
  </Dialog>;
}
