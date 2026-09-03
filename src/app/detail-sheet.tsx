import { Badge, Button, ScrollArea } from "@/components/ui";
import { cn } from "@/lib/utils";
import { AlertTriangle, Copy, Droplets, FolderOpen, LogOut, MoreHorizontal, PaintBucket, Pause, Pencil, Play, RefreshCw, Scaling, ScrollText, SquareTerminal, Trash2, X, Zap } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { nativeBackendAvailable, type PortForwardSession } from "../backend";
import { openContextMenu } from "../context-menu";
import { ContainerConfigurationSection, HelmValuesSection, MetricsSection, PropertiesSection, RelationLoadingNotice, ResourceDataSection, ServicePortsSection, StatusSection, type DetailCopyHandler, type MetricsKind, type MetricsRange } from "../detail-panels";
import { tr } from "../i18n";
import { t, type AppLanguage } from "../preferences";
import type { ResourceRow } from "../resource-catalog";
import { buildResourceDetailSections, getContainerDetailSection, getResourceConditions, type ResourceDetailLink } from "../resource-details";
import { statusTone } from "../status";
import { StatusDot } from "./app-controls";
import { podSessionUnavailableReason } from "./pod-session-targets";
import { forwardablePortsFor } from "./resource-browser";
import { resourceKindIcon } from "./resource-icons";
import type { BottomRequest, DetailItem } from "./types";

const DETAIL_SHEET_MIN_WIDTH = 320;
const DETAIL_SHEET_MAX_WIDTH = 840;

function detailSheetWidthBounds() {
  const maximum = Math.max(280, Math.min(DETAIL_SHEET_MAX_WIDTH, window.innerWidth - 80));
  return { minimum: Math.min(DETAIL_SHEET_MIN_WIDTH, maximum), maximum };
}

function clampDetailSheetWidth(value: number) {
  const { minimum, maximum } = detailSheetWidthBounds();
  return Math.max(minimum, Math.min(maximum, value));
}

function DetailSheet({ tab, language, onClose, onAction, onCopy, onMetricsRange, onOpenResource, onOpenLink, onPortForward, portForwardSessions, onOpenPortForward, onPausePortForward, onResumePortForward, onStopPortForward }: { tab: DetailItem; language: AppLanguage; onClose: () => void; onAction: (action: string) => void; onCopy: DetailCopyHandler; onMetricsRange: (row: ResourceRow, range: MetricsRange) => void; onOpenResource: (row: ResourceRow) => void; onOpenLink: (link: ResourceDetailLink) => void; onPortForward: (row: ResourceRow, port: number) => void; portForwardSessions: PortForwardSession[]; onOpenPortForward: (session: PortForwardSession) => void; onPausePortForward: (session: PortForwardSession) => void; onResumePortForward: (session: PortForwardSession) => void; onStopPortForward: (session: PortForwardSession) => Promise<boolean> }) {
  const related = tab.related;
  const actionKind = tab.row?.kind ?? tab.kind ?? "Resource";
  const canDelete = !nativeBackendAvailable || Boolean(tab.row?.descriptor?.verbs.includes("delete"));
  const editAction = [{ label: "Edit", icon: Pencil, mode: "edit" as const }];
  const deleteAction = actionKind !== "HelmRelease" && canDelete ? [{ label: "Delete", icon: Trash2 }] : [];
  const fileAction = ["Pod", "Deployment", "StatefulSet", "DaemonSet"].includes(actionKind) ? [{ label: "Files", icon: FolderOpen }] : [];
  const nodeCordoned = actionKind === "Node" ? Boolean((tab.row?.backend?.object as { spec?: { unschedulable?: boolean } } | undefined)?.spec?.unschedulable) : false;
  const cronJobSuspended = actionKind === "CronJob" ? Boolean((tab.row?.backend?.object as { spec?: { suspend?: boolean } } | undefined)?.spec?.suspend) : false;
  const headerActions: Array<{ label: string; icon: typeof Play; mode?: BottomRequest["mode"] }> = tab.type === "related"
    ? []
    : actionKind === "Pod"
      ? [...editAction, { label: "Terminal", icon: SquareTerminal, mode: "terminal" }, { label: "Logs", icon: ScrollText, mode: "logs" }, ...fileAction, { label: "Evict", icon: LogOut }, ...deleteAction]
      : actionKind === "DaemonSet"
        ? [...editAction, { label: "Logs", icon: ScrollText, mode: "logs" }, ...fileAction, { label: "Restart", icon: RefreshCw }, ...deleteAction]
        : actionKind === "CronJob"
          ? [...editAction, { label: "Trigger", icon: Zap }, { label: cronJobSuspended ? "Resume" : "Suspend", icon: cronJobSuspended ? Play : Pause }, ...deleteAction]
          : actionKind === "StatefulSet"
            ? [...editAction, { label: "Terminal", icon: SquareTerminal, mode: "terminal" }, { label: "Logs", icon: ScrollText, mode: "logs" }, ...fileAction, { label: "Scale", icon: Scaling }, ...deleteAction]
            : actionKind === "Deployment"
              ? [...editAction, { label: "Terminal", icon: SquareTerminal, mode: "terminal" }, { label: "Logs", icon: ScrollText, mode: "logs" }, ...fileAction, { label: "Scale", icon: Scaling }, { label: "Restart", icon: RefreshCw }, ...deleteAction]
              : actionKind === "Node"
                ? [...editAction, { label: "Terminal", icon: SquareTerminal, mode: "terminal" }, { label: "Files", icon: FolderOpen, mode: "files" }, { label: nodeCordoned ? "Uncordon" : "Cordon", icon: nodeCordoned ? Play : Pause }, { label: "Drain", icon: Droplets }, { label: "Taints", icon: PaintBucket }, ...deleteAction]
                : [...editAction, ...deleteAction];
  const actionLabel = (action: string) => action === "Edit" ? tr(language, "edit") : action === "Delete" ? tr(language, "delete") : action === "Files" ? (actionKind === "Node" ? tr(language, "nodeFiles") : tr(language, "files")) : action === "Terminal" ? tr(language, "terminal") : action === "Logs" ? tr(language, "logs") : action === "Evict" ? tr(language, "evict") : action === "Scale" ? tr(language, "scale") : action === "Restart" ? tr(language, "restartRollout") : action === "Cordon" ? tr(language, "cordon") : action === "Uncordon" ? tr(language, "uncordon") : action === "Drain" ? tr(language, "drain") : action === "Taints" ? tr(language, "taints") : action === "Trigger" ? tr(language, "triggerCronJob") : action === "Suspend" ? tr(language, "suspendCronJob") : action === "Resume" ? tr(language, "resumeCronJob") : action;
  // Terminal / Logs / Files attach to a Pod. A workload reporting none has
  // nothing to attach to, so those entry points grey out and say why.
  const podSessionBlocked = podSessionUnavailableReason(language, tab.row);
  const actionBlocked = (action: string) => Boolean(podSessionBlocked) && ["Terminal", "Logs", "Files"].includes(action);
  const actionTitle = (action: string) => actionBlocked(action) ? `${actionLabel(action)} · ${podSessionBlocked}` : actionLabel(action);
  const overflowHeaderActions = headerActions.slice(2);
  const [width, setWidth] = useState(() => clampDetailSheetWidth(Number(localStorage.getItem("kubehive.detailWidth")) || 410));
  const sheetRef = useRef<HTMLElement>(null);
  const resize = useRef<{ startX: number; startWidth: number; currentWidth: number } | null>(null);
  const widthBounds = detailSheetWidthBounds();
  useEffect(() => localStorage.setItem("kubehive.detailWidth", String(width)), [width]);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!resize.current || !sheetRef.current) return;
      const next = clampDetailSheetWidth(resize.current.startWidth + resize.current.startX - event.clientX);
      resize.current.currentWidth = next;
      sheetRef.current.style.width = `${next}px`;
    };
    const stop = () => {
      if (!resize.current) return;
      const finalWidth = resize.current.currentWidth;
      resize.current = null;
      setWidth(finalWidth);
      document.body.classList.remove("resizing-sheet");
    };
    const clampOnViewportResize = () => setWidth((current) => clampDetailSheetWidth(current));
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("resize", clampOnViewportResize);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("resize", clampOnViewportResize);
      document.body.classList.remove("resizing-sheet");
    };
  }, []);
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const currentWidth = sheetRef.current?.getBoundingClientRect().width ?? width;
    resize.current = { startX: event.clientX, startWidth: currentWidth, currentWidth };
    document.body.classList.add("resizing-sheet");
  };
  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 16;
    let next: number | undefined;
    if (event.key === "ArrowLeft") next = width + step;
    if (event.key === "ArrowRight") next = width - step;
    if (event.key === "Home") next = widthBounds.minimum;
    if (event.key === "End") next = widthBounds.maximum;
    if (next === undefined) return;
    event.preventDefault();
    setWidth(clampDetailSheetWidth(next));
  };
  const status = related?.status ?? tab.row?.status ?? tab.status ?? "Ready";
  const kindLabel = related?.kind ?? tab.row?.kind ?? tab.kind ?? (tab.type === "crd" ? "CR" : "Resource");
  // The header identifies the resource with its kind icon and its name; the
  // kind itself is what the icon stands for.
  const KindIcon = resourceKindIcon(kindLabel);
  const detailSections = tab.row ? buildResourceDetailSections(tab.row) : [];
  const containerSection = tab.row ? getContainerDetailSection(tab.row) : null;
  const conditions = getResourceConditions(tab.row);
  const eventGroup = (tab.relations ?? []).find((group) => group.id === "events");
  const portRows = tab.row && ["Pod", "Service"].includes(tab.row.kind) ? forwardablePortsFor(tab.row) : [];
  const [metricKind, setMetricKind] = useState<MetricsKind>("cpu");
  const [metricRange, setMetricRange] = useState<MetricsRange>(tab.metricsRange ?? 1);
  useEffect(() => { setMetricKind("cpu"); setMetricRange(tab.metricsRange ?? 1); }, [tab.id]);
  const openLink = (link: ResourceDetailLink) => onOpenLink(link);
  const podSheet = tab.row?.kind === "Pod";
  const renderDetailSections = () => detailSections.map((detailSection) => <section className="detail-section detail-kind-section" key={detailSection.id} data-detail-section={detailSection.id}><div className="detail-section-heading"><h3>{detailSection.title}</h3>{detailSection.description && <span>{detailSection.description}</span>}</div><div className="detail-field-grid">{detailSection.fields.map((entry) => <div key={`${detailSection.id}-${entry.label}`} className={cn("detail-field", entry.wide && "wide")}><span>{entry.label}</span><strong className={cn(entry.tone && `tone-${entry.tone}`)}>{entry.value}{entry.copyable && entry.value !== "—" && <button type="button" aria-label={`Copy ${entry.label.toLowerCase()}`} title={`Copy ${entry.label.toLowerCase()}`} onClick={() => onCopy(entry.value, entry.label)}><Copy size={11} /></button>}</strong></div>)}</div></section>);
  return <aside ref={sheetRef} className="sheet sheet-right" style={{ width }}>
    <div
      className="sheet-resize-edge vertical"
      aria-label={tr(language, "resizeDetails")}
      aria-orientation="vertical"
      aria-valuemin={Math.round(widthBounds.minimum)}
      aria-valuemax={Math.round(widthBounds.maximum)}
      aria-valuenow={Math.round(width)}
      aria-valuetext={`${Math.round(width)} pixels`}
      role="separator"
      tabIndex={0}
      onKeyDown={resizeWithKeyboard}
      onPointerDown={startResize}
    />
    <div className="drawer-head detail-sheet-header"><div className="resource-kind" role="img" aria-label={kindLabel} title={kindLabel}><KindIcon size={15} aria-hidden="true" /></div><div className="sheet-title-stack"><h2>{tab.label}</h2></div><div className="detail-header-actions">{headerActions.map(({ label, icon: Icon }, index) => <Button key={label} variant="ghost" size="icon" className={cn(index >= 2 && "detail-header-secondary", label === "Delete" && "hover-destructive", label === "Evict" && "hover-warning")} aria-label={actionLabel(label)} title={actionTitle(label)} disabled={actionBlocked(label)} onClick={() => onAction(label)}><Icon size={13} /></Button>)}{overflowHeaderActions.length > 0 && <Button variant="ghost" size="icon" className="detail-header-overflow" aria-label={t(language, "actions")} title={t(language, "actions")} aria-haspopup="menu" onClick={(event) => openContextMenu(event, overflowHeaderActions.map(({ label, icon: Icon }) => ({ type: "item" as const, id: `detail-${label.toLowerCase()}`, label: actionLabel(label), icon: Icon, hoverDestructive: label === "Delete", hoverWarning: label === "Evict", disabled: actionBlocked(label), title: actionBlocked(label) ? podSessionBlocked : undefined, onSelect: () => onAction(label) })))}><MoreHorizontal size={14} /></Button>}</div><Button variant="ghost" size="icon" aria-label={tr(language, "close")} onClick={onClose}><X size={14} /></Button></div>
    <ScrollArea className="drawer-body-scroll-area" viewportClassName={cn("drawer-body", related ? "detail-drawer-legacy" : "detail-drawer-sections")}>
      {related ? <><div className="detail-status"><StatusDot status={status} /><div><strong>{status}</strong><span>Reverse link · {related.relation}</span></div><Badge tone={statusTone(status)}>{related.relation}</Badge></div><h3>{tr(language, "resources")}</h3><dl>{(related.meta ?? []).map((entry) => <div key={entry.label}><dt>{entry.label}</dt><dd>{entry.value}</dd></div>)}{related.from && <div><dt>Opened from</dt><dd>{related.from}</dd></div>}</dl>{tab.error && <div className="related-empty">{tab.error}</div>}</> : tab.row ? <>
        {tab.error && <div className="detail-load-error"><AlertTriangle size={13} /><span>{tab.error}</span></div>}
        {(tab.metrics || tab.metricsLoading) && (tab.row.kind === "Pod" || tab.row.kind === "Node") && <MetricsSection metrics={tab.metrics} active={metricKind} range={metricRange} loading={tab.metricsLoading} error={tab.metricsError} onMetric={setMetricKind} onRange={(range) => { setMetricRange(range); onMetricsRange(tab.row!, range); }} />}
        {podSheet ? <>
          <PropertiesSection row={tab.row} relations={tab.relations} onOpenResource={openLink} onCopy={onCopy} />
          <ContainerConfigurationSection row={tab.row} section={containerSection} sessions={portForwardSessions} onOpenResource={openLink} onCopy={onCopy} onPortForward={onPortForward} onOpenPortForward={onOpenPortForward} onPausePortForward={onPausePortForward} onResumePortForward={onResumePortForward} onStopPortForward={onStopPortForward} />
          <StatusSection row={tab.row} conditions={conditions} fallbackStatus={status} eventGroup={eventGroup} onOpenResource={onOpenResource} onCopy={onCopy} />
        </> : <>
          <PropertiesSection row={tab.row} relations={tab.relations} onOpenResource={openLink} onCopy={onCopy} />
          {renderDetailSections()}
          {tab.row.kind === "HelmRelease" && <HelmValuesSection release={tab.helmValues} loading={tab.helmValuesLoading} error={tab.helmValuesError} onCopy={onCopy} />}
          <ContainerConfigurationSection row={tab.row} section={containerSection} sessions={portForwardSessions} onOpenResource={openLink} onCopy={onCopy} onPortForward={onPortForward} onOpenPortForward={onOpenPortForward} onPausePortForward={onPausePortForward} onResumePortForward={onResumePortForward} onStopPortForward={onStopPortForward} />
          <ResourceDataSection row={tab.row} onCopy={onCopy} />
          {tab.row.kind === "Service" && <ServicePortsSection row={tab.row} ports={portRows.map((port) => ({ port: port.port, protocol: port.protocol, name: port.name, target: port.target, forwardable: port.forwardable }))} sessions={portForwardSessions} onCopy={onCopy} onPortForward={onPortForward} onOpenPortForward={onOpenPortForward} onPausePortForward={onPausePortForward} onResumePortForward={onResumePortForward} onStopPortForward={onStopPortForward} />}
          <RelationLoadingNotice loading={tab.relationsLoading} error={tab.relationsError} />
          <StatusSection row={tab.row} conditions={conditions} fallbackStatus={status} eventGroup={eventGroup} onOpenResource={onOpenResource} onCopy={onCopy} />
        </>}
      </> : <div className="detail-container-empty">Resource details are unavailable.</div>}
    </ScrollArea>
  </aside>;

}

export { DetailSheet };
