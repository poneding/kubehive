import { ScrollArea } from "@/components/ui";
import { cn } from "@/lib/utils";
import { ArrowDown, ArrowUp, Bell, Info, Play, Plus, Power, Settings, Trash2 } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import kubeHiveMark from "../assets/kubehive-mark-512.png";
import { ClusterHoverCard, openContextMenu, type ContextMenuItem } from "../context-menu";
import { clusterAccent, clusterConnectionStatus, type Cluster } from "../data";
import { tr } from "../i18n";
import { t, type AppLanguage } from "../preferences";
import { StatusDot } from "./app-controls";

function clusterActionMenuItems({ cluster, language, busy, onConnect, onCloseConnection, onSettings, onRemove }: { cluster: Cluster; language: AppLanguage; busy: boolean; onConnect: () => void; onCloseConnection: () => void; onSettings: () => void; onRemove: () => void }): ContextMenuItem[] {
  return [
    { type: "item", id: "connect", label: cluster.disconnected ? t(language, "connect") : t(language, "openOverview"), icon: Play, disabled: busy, onSelect: onConnect },
    ...(!cluster.disconnected ? [{ type: "item" as const, id: "close-connection", label: t(language, "closeConnection"), icon: Power, hoverDestructive: true, disabled: busy, onSelect: onCloseConnection }] : []),
    { type: "separator" },
    { type: "item", id: "settings", label: t(language, "settings"), icon: Settings, onSelect: onSettings },
    { type: "item", id: "remove", label: t(language, "remove"), icon: Trash2, hoverDestructive: true, onSelect: onRemove },
  ];
}

function ClusterRail({ clusters, active, language, alertCount, alertsDisabled, updateAvailable, onHome, onConnect, onAlerts, onAbout, onSettings, onAdd, onClusterSettings, onCloseConnection, onMove, onReorder, onRemove }: {
  clusters: Cluster[];
  active: Cluster | null;
  language: AppLanguage;
  alertCount: number;
  alertsDisabled: boolean;
  updateAvailable: boolean;
  onHome: () => void;
  onConnect: (cluster: Cluster) => void;
  onAlerts: () => void;
  onAbout: () => void;
  onSettings: () => void;
  onAdd: () => void;
  onClusterSettings: (cluster: Cluster) => void;
  onCloseConnection: (cluster: Cluster) => void;
  onMove: (clusterId: string, direction: -1 | 1) => void;
  onReorder: (clusterId: string, insertionIndex: number) => void;
  onRemove: (cluster: Cluster) => void;
}) {
  const [hover, setHover] = useState<{ cluster: Cluster; rect: DOMRect } | null>(null);
  const [draggedClusterId, setDraggedClusterId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const clusterListRef = useRef<HTMLDivElement>(null);
  const pointerDragRef = useRef<{ clusterId: string; pointerId: number; startX: number; startY: number; dragging: boolean } | null>(null);
  const dropIndexRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const visibleClusters = clusters.filter((cluster) => cluster.id !== "unconfigured");
  useEffect(() => () => document.body.classList.remove("reordering-clusters"), []);
  const setInsertionIndex = (index: number | null) => { dropIndexRef.current = index; setDropIndex(index); };
  const insertionIndexAt = (clientY: number) => {
    const icons = [...(clusterListRef.current?.querySelectorAll<HTMLButtonElement>(".cluster-icon:not(.add)") ?? [])];
    const index = icons.findIndex((icon) => { const rect = icon.getBoundingClientRect(); return clientY < rect.top + rect.height / 2; });
    return index < 0 ? icons.length : index;
  };
  const beginPointerDrag = (event: ReactPointerEvent<HTMLButtonElement>, clusterId: string) => {
    if (event.button !== 0) return;
    pointerDragRef.current = { clusterId, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dragging: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const movePointerDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = pointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.dragging && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
    if (!drag.dragging) {
      drag.dragging = true;
      setDraggedClusterId(drag.clusterId);
      setHover(null);
      document.body.classList.add("reordering-clusters");
    }
    event.preventDefault();
    setInsertionIndex(insertionIndexAt(event.clientY));
  };
  const endPointerDrag = (event: ReactPointerEvent<HTMLButtonElement>, cancelled = false) => {
    const drag = pointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (drag.dragging && !cancelled && dropIndexRef.current !== null) {
      event.preventDefault();
      suppressClickRef.current = true;
      onReorder(drag.clusterId, dropIndexRef.current);
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    }
    pointerDragRef.current = null;
    setDraggedClusterId(null);
    setInsertionIndex(null);
    document.body.classList.remove("reordering-clusters");
  };
  const dropLine = (index: number) => <div className={cn("cluster-drop-line", draggedClusterId && dropIndex === index && "active")} data-drop-index={index} />;
  return <aside className="cluster-rail">
    <div className="rail-drag-region titlebar-chrome" data-tauri-drag-region aria-hidden="true" />
    <div className="rail-header"><button type="button" className="brand-mark" title={t(language, "clusters")} aria-label={t(language, "clusters")} onClick={onHome}><img src={kubeHiveMark} alt="" /></button><div className="rail-divider" /></div>
    <ScrollArea className="cluster-list-scroll-area" viewportClassName={cn("cluster-list", draggedClusterId && "is-reordering")} viewportRef={clusterListRef}>
      <div className="cluster-list-content">
        {dropLine(0)}
        {visibleClusters.map((cluster, index) => {
          const color = clusterAccent(cluster);
          return <Fragment key={cluster.id}><button
            type="button"
            aria-label={`${cluster.disconnected ? t(language, "connect") : t(language, "openOverview")} ${cluster.name}`}
            className={cn("cluster-icon", "reorderable", active?.id === cluster.id && "active", cluster.disconnected && "disconnected", draggedClusterId === cluster.id && "dragging")}
            style={{ ["--cluster-accent" as string]: color }}
            onClick={(event) => { if (suppressClickRef.current) { event.preventDefault(); event.stopPropagation(); return; } onConnect(cluster); }}
            onPointerDown={(event) => beginPointerDrag(event, cluster.id)}
            onPointerMove={movePointerDrag}
            onPointerUp={(event) => endPointerDrag(event)}
            onPointerCancel={(event) => endPointerDrag(event, true)}
            onMouseEnter={(event) => { if (!draggedClusterId) setHover({ cluster, rect: event.currentTarget.getBoundingClientRect() }); }}
            onMouseLeave={() => setHover((current) => current?.cluster.id === cluster.id ? null : current)}
            onContextMenu={(event) => {
              setHover(null);
              const actions = clusterActionMenuItems({ cluster, language, busy: false, onConnect: () => onConnect(cluster), onCloseConnection: () => onCloseConnection(cluster), onSettings: () => onClusterSettings(cluster), onRemove: () => onRemove(cluster) });
              const removeIndex = actions.findIndex((item) => item.type === "item" && item.id === "remove");
              openContextMenu(event, [
                ...actions.slice(0, removeIndex),
                { type: "item", id: "move-up", label: t(language, "moveUp"), icon: ArrowUp, disabled: index === 0, onSelect: () => onMove(cluster.id, -1) },
                { type: "item", id: "move-down", label: t(language, "moveDown"), icon: ArrowDown, disabled: index === visibleClusters.length - 1, onSelect: () => onMove(cluster.id, 1) },
                ...actions.slice(removeIndex),
              ]);
            }}
          ><span>{cluster.name.slice(0, 2).toUpperCase()}</span><StatusDot status={clusterConnectionStatus(cluster)} /></button>{dropLine(index + 1)}</Fragment>;
        })}
        <button type="button" className="cluster-icon add" title={t(language, "addCluster")} aria-label={t(language, "addCluster")} onClick={onAdd}><Plus size={16} /></button>
      </div>
    </ScrollArea>
    <div className="rail-footer"><button type="button" className="rail-button alert-button" title={alertsDisabled ? t(language, "connectForAlerts") : tr(language, "alerts")} aria-label={tr(language, "alerts")} disabled={alertsDisabled} onClick={onAlerts}><Bell size={16} />{!alertsDisabled && alertCount > 0 && <i>{alertCount > 99 ? "99+" : alertCount}</i>}</button><button type="button" className={cn("rail-button", "about-button")} title={tr(language, "about")} aria-label={tr(language, "about")} onClick={onAbout}><Info size={16} />{updateAvailable && <i className="update-dot" />}</button><button type="button" className="rail-button" title={t(language, "settings")} aria-label={t(language, "settings")} onClick={onSettings}><Settings size={16} /></button></div>
    {hover && <ClusterHoverCard cluster={hover.cluster} color={clusterAccent(hover.cluster)} anchor={hover.rect} language={language} />}
  </aside>;
}

export { ClusterRail, clusterActionMenuItems };
