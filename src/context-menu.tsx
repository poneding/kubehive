import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, X } from "lucide-react";
import { Button, cn } from "./ui";
import { t, type AppLanguage } from "./preferences";

export type ContextMenuItem =
  | { type: "item"; id: string; label: string; danger?: boolean; disabled?: boolean; onSelect: () => void }
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
  const native: ContextMenuItem[] = [
    { type: "separator" },
    { type: "item", id: "reload", label: "Reload", onSelect: () => window.location.reload() },
    {
      type: "item",
      id: "inspect",
      label: "Inspect Element",
      onSelect: () => {
        // Mirror Tauri/WebView native entry; open DevTools when the host allows it.
        try {
          const tauri = (window as Window & { __TAURI__?: { core?: { invoke?: (cmd: string) => Promise<unknown> } } }).__TAURI__;
          void tauri?.core?.invoke?.("plugin:webview|internal_toggle_devtools");
        } catch {
          /* Browser prototype / restricted host: use the DevTools shortcut. */
        }
      },
    },
  ];
  openHandler?.({ x: event.clientX, y: event.clientY, items: [...items, ...native] });
}

export function ContextMenuHost() {
  const [menu, setMenu] = useState<MenuState>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  useEffect(() => {
    openHandler = setMenu;
    return () => { if (openHandler === setMenu) openHandler = null; };
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
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
          className={cn(item.danger && "danger")}
          onClick={() => { setMenu(null); if (!item.disabled) item.onSelect(); }}
        >
          {item.label}
        </button>)}
    </div>,
    document.body,
  );
}

export function ClusterHoverCard({ cluster, color, anchor }: {
  cluster: { name: string; provider: string; region: string; version: string; status: string; nodes: number; cpu: number; memory: number };
  color: string;
  anchor: DOMRect;
}) {
  const left = Math.min(anchor.right + 10, window.innerWidth - 240);
  const top = Math.min(Math.max(8, anchor.top + anchor.height / 2 - 70), window.innerHeight - 160);
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
        <span>Status<strong>{cluster.status}</strong></span>
        <span>Version<strong>{cluster.version}</strong></span>
        <span>Nodes<strong>{cluster.nodes}</strong></span>
        <span>CPU<strong>{cluster.cpu}%</strong></span>
        <span>Memory<strong>{cluster.memory}%</strong></span>
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
  return createPortal(
    <div className="modal-backdrop panel-dialog-backdrop" onMouseDown={() => { if (!busy) onClose(); }}>
      <section className="cluster-color-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <header><h2>{t(language, "clusterSettings")}</h2><Button type="button" variant="ghost" size="icon" className="cluster-color-close" disabled={busy} onClick={onClose} aria-label="Close cluster settings"><X size={14}/></Button></header>
        <div className="cluster-color-body">
          <label><span>{t(language, "clusterName")}</span><input className="cluster-name-input" autoFocus value={draftName} maxLength={128} onChange={(event) => setDraftName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submit(); } }}/></label>
          <label>
            <span>{t(language, "themeColor")}</span>
            <div className="cluster-color-row">
              <input type="color" aria-label={t(language, "themeColor")} value={draftColor} onChange={(event) => setDraftColor(event.target.value)} />
              <input type="text" aria-label="Cluster color value" value={draftColor} onChange={(event) => { if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(event.target.value)) setDraftColor(event.target.value); }} />
            </div>
          </label>
          <div className="cluster-color-presets">
            {presets.map((preset) => (
              <button key={preset} type="button" className={cn(draftColor.toLowerCase() === preset.toLowerCase() && "active")} style={{ background: preset }} onClick={() => setDraftColor(preset)} aria-label={`Use ${preset}`}/>
            ))}
          </div>
          <div className="cluster-color-preview" style={{ ["--cluster-accent" as string]: draftColor }}><span>Rail swatch</span><div className="cluster-color-preview-pane">Workspace accent</div></div>
          {error && <div className="cluster-settings-error" role="alert">{error}</div>}
        </div>
        <footer><Button type="button" variant="outline" size="sm" disabled={busy} onClick={onClose}>{t(language, "cancel")}</Button><Button type="button" size="sm" disabled={busy || !draftName.trim()} onClick={() => void submit()}>{busy && <LoaderCircle className="spin" size={13}/>} {t(language, "save")}</Button></footer>
      </section>
    </div>,
    document.body,
  );
}
