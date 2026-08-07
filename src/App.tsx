import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import {
  Activity, AlertTriangle, ArrowDown, ArrowUp, Bell, Box, Boxes, CheckCircle2, ChevronDown, ChevronRight, CircleDot, Code2,
  Command, Container, Copy, Cpu, Database, Download, Droplets, ExternalLink, FileCode2, FileKey, FilePen, FileUp, FolderOpen, Gauge, Globe2, HardDrive, Hexagon,
  Info,
  Layers3, LayoutDashboard, LoaderCircle, LogOut, Maximize2, Menu, Minimize2, Minus, MoreHorizontal, Network, PaintBucket,
  Pencil, Pause, Play, Plus, Power,
  RefreshCw, Scale, Scaling, ScrollText, Search, Server, Settings, ShieldCheck, Shuffle, SlidersHorizontal, Square, SquareTerminal, Trash2, Type, Upload,
  Users, Wifi, X, Zap, ZoomIn, ZoomOut, RotateCcw, Sun, Moon, Monitor, createLucideIcon
} from "lucide-react";
import { Fragment, Suspense, lazy, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { initialUpdateState, installAndRelaunch, checkForUpdate, updateProgress, type UpdateState } from "./app-update";
import "./about.css";
import { AnsiHighlightedText, ansiToPlainText } from "./ansi-log";
import kubeHiveMark from "./assets/kubehive-mark-512.png";
import kubeHiveLogo from "./assets/kubehive-logo.svg";
import { backend, descriptorForResource, nativeBackendAvailable, type ApiResourceDescriptor, type BackendResourceRecord, type BulkActionResult, type ClusterOverview as LiveClusterOverview, type ContainerFileTarget, type DrainNodeResult, type NodeTaint, type PortForwardSession, type PodMetricsResponse } from "./backend";
import "./bulk-actions.css";
import { ColumnPicker, useVisibleColumns } from "./column-picker";
import { Combobox, NamespaceMultiCombobox } from "./combobox";
import { ClusterHoverCard, ClusterSettingsDialog, ContextMenuHost, openContextMenu, type ContextMenuItem } from "./context-menu";
import { clusterAccent, navGroups, type Cluster, type CustomResourceDefinition } from "./data";
import "./final-alignment.css";
import "./index.css";
import { crdDefinitionFromRecord, rowFromBackend, valueFromJsonPath } from "./k8s-adapter";
import { convertManifest, firstManifestError, manifestHasErrors, validateManifestText, type ManifestFormat } from "./manifest-format";
import "./platform.css";
import { tr, localizedUpdateError } from "./i18n";
import { createDefaultPreferences, defaultContentFont, resolveContentFont, groupLabel, resourceLabel, t, contentFontOptions, contentFontSizes, type AppLanguage, type Preferences, type ContentTheme } from "./preferences";
import { applyWindowZoom, contentZoomModifierActive, getWindowZoomFactor, nextContentZoomFactor, normalizeContentWheelDelta, settleContentZoomFactor, stepWindowZoom } from "./zoom";
import "./refinements.css";
import "./resource-actions.css";
import type { ResourceLink, ResourceRow } from "./resource-catalog";
import { buildResourceDetailSections, getContainerDetailSection, getResourceConditions, type PodMetrics, type ResourceDetailLink } from "./resource-details";
import { ContainerConfigurationSection, PodMetricsSection, PropertiesSection, RelationLoadingNotice, ResourceDataSection, ServicePortsSection, StatusSection, type DetailCopyHandler, type MetricsKind, type MetricsRange } from "./detail-panels";
import "./resource-details.css";
import { resolveResourceLink, resolveResourceRelations, type ResourceRelationGroup } from "./resource-relations";
import "./session-settings-polish.css";
import "./settings.css";
import "./sheet-polish.css";
import "./tab-polish.css";
import { ContainerFileExplorer, type ContainerFileExplorerSnapshot } from "./container-file-explorer";
import { ContainerSquares, ResourceLinkButton, VirtualResourceTable, type VirtualTableColumn } from "./table-extras";
import { TextSearchPopover, useTextSearch } from "./text-search";
import { Badge, Button, Progress, cn } from "./ui";
import "./workbench.css";

type ResourceTab = { id: string; label: string; resource: string; crdKind?: string; crdName?: string; preview?: boolean };
type RelatedDetail = {
  relation: string;
  kind: string;
  name: string;
  namespace?: string;
  from?: string;
  status?: string;
  meta?: Array<{ label: string; value: string }>;
  relatedItems?: Array<{ name: string; kind: string; namespace?: string; status?: string }>;
};
type DetailItem = { id: string; label: string; subtitle: string; type: "resource" | "crd" | "related"; kind?: string; status?: string; related?: RelatedDetail; row?: ResourceRow; manifest?: string; loading?: boolean; error?: string; relations?: ResourceRelationGroup[]; relationsLoading?: boolean; relationsError?: string; metrics?: PodMetrics; metricsLoading?: boolean; metricsError?: string; metricsRange?: MetricsRange };
type BottomRequest = { mode: "create" | "edit" | "logs" | "terminal" | "files"; item?: DetailItem; sessionKey?: string; label?: string; manifest?: string; descriptor?: ApiResourceDescriptor; readOnlyReason?: string; terminalTarget?: "local" | "container" | "node" };
type BottomSession = BottomRequest & { id: string };
type BottomSessionCache = {
  manifestText?: string;
  manifestFormat?: ManifestFormat;
  output?: string;
  feedback?: string;
  selectedPodKey?: string;
  selectedContainer?: string;
  logTailLines?: number;
  logPrevious?: boolean;
  logFollow?: boolean;
  logTimestamps?: boolean;
  logWrapLines?: boolean;
  terminalReloadToken?: number;
  /** Resolved helper-Pod target for a Node file explorer session. */
  nodeFileTarget?: ContainerFileTarget;
  /** Node whose helper Pod the session owns (paired with `nodeFileTarget`). */
  nodeFileName?: string;
  /** Last fully loaded file view, retained while this session's tab is inactive. */
  fileExplorerSnapshot?: ContainerFileExplorerSnapshot;
};
/**
 * Lets either a regular wheel gesture or Shift+wheel pan an overflowing tab rail.
 * Scroll chaining remains available after the rail reaches either end.
 */
function scrollTabRailOnWheel(rail: HTMLDivElement, event: WheelEvent) {
  if (rail.scrollWidth <= rail.clientWidth) return;

  const delta = event.shiftKey
    ? event.deltaY || event.deltaX
    : Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (!delta) return;

  const distance = event.deltaMode === 1 ? delta * 16 : event.deltaMode === 2 ? delta * rail.clientWidth : delta;
  const previous = rail.scrollLeft;
  rail.scrollLeft += distance;
  if (rail.scrollLeft !== previous) event.preventDefault();
}

function useHorizontalTabRail() {
  const railRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const handleWheel = (event: WheelEvent) => scrollTabRailOnWheel(rail, event);
    rail.addEventListener("wheel", handleWheel, { passive: false });
    return () => rail.removeEventListener("wheel", handleWheel);
  }, []);
  return railRef;
}

type ClusterWorkspaceState = {
  tabs: ResourceTab[];
  activeTabId: string;
  /** Empty array means all namespaces. */
  namespaces: string[];
  bottomSessions: BottomSession[];
  activeBottomId: string;
  bottomCollapsed: boolean;
};
type BottomSessionCacheMap = Record<string, BottomSessionCache>;
type TerminalRuntimeMap = Record<string, TerminalRuntime>;
type RuntimeMapUpdater<T> = (update: (current: T) => T) => void;
type AppToast = { id: number; tone: "success" | "error"; message: string; filePath?: string };
type ForwardablePort = { port: number; protocol: string; label: string; target?: string; container?: string; name?: string; forwardable: boolean };
type PortForwardDialogState = { row: ResourceRow; ports: ForwardablePort[]; selectedPort: number; showPortSelect: boolean };
type PodSessionTarget = { key: string; namespace: string; pod: string; phase: string; ready: boolean; initContainers: string[]; containers: string[] };
type TerminalConnectionStatus = "idle" | "connecting" | "connected" | "disconnected";
type TerminalRuntime = { sessionId: string; output: string; status: TerminalConnectionStatus; feedback: string; connectionKey: string; targetLabel: string; podKey?: string; container?: string };
type DesktopPlatform = "macos" | "windows" | "linux";
type WorkspaceView = "clusters" | "cluster";
type ClusterConnectionPhase = "connecting" | "failed" | "unavailable";
type ClusterConnectionState = { clusterId: string; phase: ClusterConnectionPhase; operationId?: string; error?: string };
type TrayAction = "settings" | "about" | "check-updates";

const platform: DesktopPlatform = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "macos" : /Win/.test(navigator.userAgent) ? "windows" : "linux";
document.documentElement.classList.add(`platform-${platform}`);
const defaultPreferences = createDefaultPreferences(platform);
const ContainerTerminal = lazy(() => import("./container-terminal"));
const ManifestEditor = lazy(() => import("./manifest-editor"));
const unconfiguredCluster: Cluster = { id: "unconfigured", name: "No cluster configured", provider: "Local", region: "Add a kubeconfig to begin", version: "—", status: "offline", nodes: 0, cpu: 0, memory: 0, disconnected: true };
const clusterWorkspaceStorageKey = "kubehive.clusterWorkspaces";
const clusterOrderStorageKey = "kubehive.clusterOrder";
const clusterProbeRequestedEvent = "kubehive:probe-cluster";
const appVersion = __KUBEHIVE_VERSION__;

function requestClusterProbe(clusterId: string) {
  window.dispatchEvent(new CustomEvent(clusterProbeRequestedEvent, { detail: { clusterId } }));
}

function applySavedClusterOrder(items: Cluster[]): Cluster[] {
  try {
    const order = JSON.parse(localStorage.getItem(clusterOrderStorageKey) ?? "[]") as unknown;
    if (!Array.isArray(order)) return items;
    const rank = new Map(order.filter((id): id is string => typeof id === "string").map((id, index) => [id, index]));
    const original = new Map(items.map((item, index) => [item.id, index]));
    return [...items].sort((left, right) => (rank.get(left.id) ?? order.length + (original.get(left.id) ?? 0)) - (rank.get(right.id) ?? order.length + (original.get(right.id) ?? 0)));
  } catch { return items; }
}

function defaultClusterWorkspace(): ClusterWorkspaceState {
  return {
    tabs: [{ id: "overview", label: "Overview", resource: "Overview", preview: false }],
    activeTabId: "overview",
    namespaces: [],
    bottomSessions: [],
    activeBottomId: "",
    bottomCollapsed: false,
  };
}

function normalizeSelectedNamespaces(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0 && item !== "All namespaces"))];
  }
  if (typeof value === "string" && value && value !== "All namespaces") return [value];
  return [];
}

/** Namespace value sent to the list/watch API. Multi-select uses all-namespaces fetch + client filter. */
function apiNamespaceFilter(selected: string[]): string | undefined {
  return selected.length === 1 ? selected[0] : undefined;
}

function matchesNamespaceFilter(rowNamespace: string, selected: string[]) {
  return selected.length === 0 || selected.includes(rowNamespace);
}

function resourceTabId(resource: string, crd?: Pick<CustomResourceDefinition, "name" | "kind">) {
  return crd ? `crd/${crd.name}` : `resource/${resource.toLowerCase().replaceAll(" ", "-")}`;
}

function isPreviewTab(tab: ResourceTab) {
  return tab.id !== "overview" && tab.preview === true;
}

function normalizeBottomSessions(value: unknown): BottomSession[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const session = entry as Partial<BottomSession>;
    if (typeof session.id !== "string" || seen.has(session.id) || !["create", "edit", "logs", "terminal", "files"].includes(session.mode ?? "")) return [];
    seen.add(session.id);
    return [{
      id: session.id,
      mode: session.mode!,
      sessionKey: typeof session.sessionKey === "string" ? session.sessionKey : undefined,
      label: typeof session.label === "string" ? session.label : undefined,
      manifest: typeof session.manifest === "string" ? session.manifest : undefined,
      item: session.item && typeof session.item === "object" ? session.item : undefined,
      descriptor: session.descriptor && typeof session.descriptor === "object" ? session.descriptor : undefined,
      readOnlyReason: typeof session.readOnlyReason === "string" ? session.readOnlyReason : undefined,
      terminalTarget: session.terminalTarget === "container" || session.terminalTarget === "local" || session.terminalTarget === "node" ? session.terminalTarget : undefined,
    }];
  });
}

function normalizeClusterWorkspace(value: unknown): ClusterWorkspaceState {
  const candidate = value && typeof value === "object" ? value as Partial<ClusterWorkspaceState> : {};
  const tabs: ResourceTab[] = defaultClusterWorkspace().tabs;
  const seen = new Set(["overview"]);
  if (Array.isArray(candidate.tabs)) {
    candidate.tabs.forEach((entry) => {
      if (!entry || typeof entry !== "object") return;
      const tab = entry as Partial<ResourceTab>;
      if (typeof tab.id !== "string" || typeof tab.label !== "string" || typeof tab.resource !== "string" || seen.has(tab.id)) return;
      tabs.push({ id: tab.id, label: tab.label, resource: tab.resource, crdKind: typeof tab.crdKind === "string" ? tab.crdKind : undefined, crdName: typeof tab.crdName === "string" ? tab.crdName : undefined, preview: tab.preview === true });
      seen.add(tab.id);
    });
  }
  const activeTabId = typeof candidate.activeTabId === "string" && seen.has(candidate.activeTabId) ? candidate.activeTabId : "overview";
  // Prefer the multi-select field; fall back to the legacy single-namespace string.
  const namespaces = normalizeSelectedNamespaces(
    Array.isArray((candidate as { namespaces?: unknown }).namespaces)
      ? (candidate as { namespaces?: unknown }).namespaces
      : candidate.namespace,
  );
  const bottomSessions = normalizeBottomSessions(candidate.bottomSessions);
  const activeBottomId = typeof candidate.activeBottomId === "string" && bottomSessions.some((session) => session.id === candidate.activeBottomId)
    ? candidate.activeBottomId
    : bottomSessions[0]?.id ?? "";
  const bottomCollapsed = typeof candidate.bottomCollapsed === "boolean" ? candidate.bottomCollapsed : false;
  return { tabs, activeTabId, namespaces, bottomSessions, activeBottomId, bottomCollapsed };
}

function loadClusterWorkspaces(): Record<string, ClusterWorkspaceState> {
  try {
    const saved = JSON.parse(localStorage.getItem(clusterWorkspaceStorageKey) ?? "{}") as Record<string, unknown>;
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved).map(([clusterId, workspace]) => [clusterId, normalizeClusterWorkspace(workspace)]));
  } catch { return {}; }
}

function ToggleSwitch({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return <button type="button" aria-label={label} aria-pressed={checked} className={cn("settings-toggle", checked && "active")} onClick={() => onChange(!checked)}><i /></button>;
}

const clusterScopedResources = new Set([
  "Nodes", "Namespaces", "Priority Classes", "Runtime Classes", "Mutating Webhook Configs",
  "Validating Webhook Configs", "Ingress Classes", "Persistent Volumes", "Storage Classes",
  "Helm Charts", "Cluster Roles", "Cluster Role Bindings", "Pod Security Policies",
]);

const RotateCwFadingClock = createLucideIcon("rotate-cw-fading-clock", [
  ["path", { d: "M12 3a9.75 9.75 0 0 1 6.74 2.74", key: "1k3kxf" }],
  ["path", { d: "M18.74 5.74 21 8", key: "1eb40o" }],
  ["path", { d: "M21 8V3", key: "1et280" }],
  ["path", { d: "M7.5 19.794c-6-3.464-6-12.124 0-15.588", key: "19r0lp" }],
  ["path", { d: "M7.5 4.206A9 9 0 0 1 12 3", key: "s8r11" }],
  ["path", { d: "M12 7v5l4 2", key: "1fdv2h" }],
  ["path", { d: "M14 20.775A9 9 0 0 1 12 21", key: "184rgu" }],
  ["path", { d: "M19 17.656a9 9 0 0 1-1.5 1.456", key: "7qgp6l" }],
  ["path", { d: "M21 12a9 9 0 0 1-.228 2", key: "1h378y" }],
  ["path", { d: "M21 8h-5", key: "k0yzmk" }],
]);

const iconMap: Record<string, typeof Box> = {
  Overview: LayoutDashboard, Nodes: Server, Namespaces: Layers3, Events: Activity,
  Pods: Box, Deployments: Boxes, DaemonSets: Server, StatefulSets: Database,
  ReplicaSets: Boxes, "Replication Controllers": RefreshCw, Jobs: Zap, CronJobs: RotateCwFadingClock,
  Services: Network, Endpoints: Network, Ingresses: Network, "Ingress Classes": Network,
  "Network Policies": ShieldCheck, "Port Forwarding": Network,
  "Persistent Volume Claims": HardDrive, "Persistent Volumes": HardDrive, "Storage Classes": Database,
  "Config Maps": FileCode2, Secrets: FileKey, "Resource Quotas": Gauge, "Limit Ranges": Gauge,
  "Horizontal Pod Autoscalers": Scale, "Vertical Pod Autoscalers": Gauge,
  "Pod Disruption Budgets": ShieldCheck, "Priority Classes": Gauge, "Runtime Classes": Server,
  Leases: FilePen, "Mutating Webhook Configs": Code2, "Validating Webhook Configs": ShieldCheck,
  "Service Accounts": Users, "Cluster Roles": ShieldCheck, Roles: ShieldCheck,
  "Cluster Role Bindings": Users, "Role Bindings": Users, "Pod Security Policies": ShieldCheck,
  "Helm Charts": Hexagon, "Helm Releases": Hexagon, "Custom Resource Definitions": Code2,
};

function StatusDot({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const bad = normalized.includes("notready") || normalized.includes("crash") || normalized.includes("failed") || normalized.includes("error");
  return <span className={cn("status-dot", !bad && (normalized.includes("healthy") || normalized.includes("running") || normalized.includes("ready") || normalized.includes("synced") || normalized === "active") && "ok", (normalized.includes("warning") || normalized.includes("degraded") || normalized.includes("pending") || normalized.includes("issuing") || normalized.includes("outofsync")) && "warn", bad && "err", normalized === "offline" && "off")} />;
}

function clusterActionMenuItems({ cluster, language, busy, onConnect, onCloseConnection, onSettings, onRemove }: { cluster: Cluster; language: AppLanguage; busy: boolean; onConnect: () => void; onCloseConnection: () => void; onSettings: () => void; onRemove: () => void }): ContextMenuItem[] {
  return [
    { type: "item", id: "connect", label: cluster.disconnected ? t(language, "connect") : t(language, "openOverview"), icon: Play, disabled: busy, onSelect: onConnect },
    ...(!cluster.disconnected ? [{ type: "item" as const, id: "close-connection", label: t(language, "closeConnection"), icon: Power, hoverDestructive: true, disabled: busy, onSelect: onCloseConnection }] : []),
    { type: "separator" },
    { type: "item", id: "settings", label: t(language, "settings"), icon: Settings, onSelect: onSettings },
    { type: "item", id: "remove", label: t(language, "remove"), icon: Trash2, hoverDestructive: true, onSelect: onRemove },
  ];
}

function ClusterRail({ clusters, active, language, alertCount, alertsDisabled, onHome, onConnect, onAlerts, onAbout, onSettings, onAdd, onClusterSettings, onCloseConnection, onMove, onReorder, onRemove }: {
  clusters: Cluster[];
  active: Cluster | null;
  language: AppLanguage;
  alertCount: number;
  alertsDisabled: boolean;
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
    <div ref={clusterListRef} className={cn("cluster-list", draggedClusterId && "is-reordering")}>
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
        ><span>{cluster.name.slice(0, 2).toUpperCase()}</span><StatusDot status={cluster.disconnected ? "offline" : cluster.status} /></button>{dropLine(index + 1)}</Fragment>;
      })}
      <button type="button" className="cluster-icon add" title={t(language, "addCluster")} aria-label={t(language, "addCluster")} onClick={onAdd}><Plus size={16} /></button>
    </div>
    <div className="rail-footer"><button type="button" className="rail-button alert-button" title={alertsDisabled ? t(language, "connectForAlerts") : tr(language, "alerts")} aria-label={tr(language, "alerts")} disabled={alertsDisabled} onClick={onAlerts}><Bell size={16} />{!alertsDisabled && alertCount > 0 && <i>{alertCount > 99 ? "99+" : alertCount}</i>}</button><button type="button" className="rail-button" title={tr(language, "about")} aria-label={tr(language, "about")} onClick={onAbout}><Info size={16} /></button><button type="button" className="rail-button" title={t(language, "settings")} aria-label={t(language, "settings")} onClick={onSettings}><Settings size={16} /></button></div>
    {hover && <ClusterHoverCard cluster={hover.cluster} color={clusterAccent(hover.cluster)} anchor={hover.rect} language={language} />}
  </aside>;
}

function VisibilityCheckbox({ checked, indeterminate = false, label, onChange }: { checked: boolean; indeterminate?: boolean; label: string; onChange: (checked: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate; }, [indeterminate]);
  return <input ref={ref} type="checkbox" checked={checked} aria-label={label} onChange={(event) => onChange(event.target.checked)} />;
}

function ResourceTreeFilter({ language, hidden, onToggleItem, onToggleGroup, onReset }: {
  language: AppLanguage;
  hidden: Set<string>;
  onToggleItem: (item: string, visible: boolean) => void;
  onToggleGroup: (items: string[], visible: boolean) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", closeOnEscape); };
  }, [open]);
  return <div ref={root} className={cn("resource-tree-filter", open && "open")}>
    <Button type="button" variant="ghost" size="icon" className="resource-tree-filter-trigger" aria-label={t(language, "resourceVisibility")} title={t(language, "resourceVisibility")} aria-expanded={open} onClick={() => setOpen((value) => !value)}><SlidersHorizontal size={14} /></Button>
    {open && <div className="resource-tree-filter-popover" role="dialog" aria-label={t(language, "resourceVisibility")}>
      <header><div><strong>{t(language, "resourceVisibility")}</strong><small>{t(language, "resourceVisibilityHint")}</small></div><button type="button" onClick={onReset}>{t(language, "showAll")}</button></header>
      <div className="resource-tree-filter-list">{navGroups.map((group) => {
        const visibleCount = group.items.filter((item) => !hidden.has(item)).length;
        const checked = visibleCount === group.items.length;
        return <section key={group.label} data-filter-group={group.label}>
          <label className="resource-tree-filter-group"><VisibilityCheckbox checked={checked} indeterminate={visibleCount > 0 && !checked} label={`${t(language, "showGroup")} ${groupLabel(language, group.label)}`} onChange={(visible) => onToggleGroup(group.items, visible)} /><strong>{groupLabel(language, group.label)}</strong><small>{visibleCount}/{group.items.length}</small></label>
          <div>{group.items.map((item) => <label key={item}><VisibilityCheckbox checked={!hidden.has(item)} label={`${t(language, "showResource")} ${resourceLabel(language, item)}`} onChange={(visible) => onToggleItem(item, visible)} /><span>{resourceLabel(language, item)}</span></label>)}</div>
        </section>;
      })}</div>
    </div>}
  </div>;
}

function ResourceNav({ active, cluster, language, discovered, onSelect, onCloseCluster, closing, open, onClose, onCommand }: { active: string; cluster: Cluster; language: AppLanguage; discovered: ApiResourceDescriptor[]; onSelect: (item: string, permanent?: boolean) => void; onCloseCluster: () => void; closing: boolean; open: boolean; onClose: () => void; onCommand: () => void }) {
  const [query, setQuery] = useState("");
  const [hiddenItems, setHiddenItems] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("kubehive.resourceTreeHidden") ?? "[]") as string[]); }
    catch { return new Set(); }
  });
  const updateHiddenItems = (update: (current: Set<string>) => Set<string>) => setHiddenItems((current) => {
    const next = update(current);
    localStorage.setItem("kubehive.resourceTreeHidden", JSON.stringify([...next]));
    return next;
  });
  const served = (item: string) => {
    if (!nativeBackendAvailable || discovered.length === 0 || ["Overview", "Port Forwarding", "Helm Charts", "Helm Releases"].includes(item)) return true;
    const descriptor = descriptorForResource(item, discovered);
    return Boolean(descriptor && discovered.some((resource) => resource.kind === descriptor.kind && resource.apiVersion === descriptor.apiVersion));
  };
  const shortcutMod = platform === "macos" ? "⌘" : "Ctrl";
  return <aside className={cn("resource-nav", open && "mobile-open")}>
    <div className="nav-title"><span>{t(language, "resources")}</span><div className="nav-title-actions"><ResourceTreeFilter language={language} hidden={hiddenItems} onToggleItem={(item, visible) => updateHiddenItems((current) => { const next = new Set(current); if (visible) next.delete(item); else next.add(item); return next; })} onToggleGroup={(items, visible) => updateHiddenItems((current) => { const next = new Set(current); items.forEach((item) => visible ? next.delete(item) : next.add(item)); return next; })} onReset={() => updateHiddenItems(() => new Set())} /><Button variant="ghost" size="icon" className="mobile-only" aria-label={tr(language, "closeNavigation")} onClick={onClose}><X size={15} /></Button></div></div>
    <div className={cn("nav-search", query && "has-value")}>
      <Search size={13} aria-hidden="true" />
      <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t(language, "filterResources")} placeholder={t(language, "filterResources")} />
      {query
        ? <button type="button" className="table-search-clear" aria-label={tr(language, "clear")} onClick={() => setQuery("")}><X size={12} /></button>
        : <button type="button" className="nav-search-command" aria-label={t(language, "searchResources")} title={t(language, "searchResources")} onClick={onCommand}><span className="command-shortcut"><kbd>{shortcutMod}</kbd><kbd>K</kbd></span></button>}
    </div>
    <nav>{navGroups.map((group) => { const items = group.items.filter((item) => !hiddenItems.has(item) && `${item} ${resourceLabel(language, item)}`.toLowerCase().includes(query.toLowerCase())); if (!items.length) return null; return <section key={group.label}>{group.label !== "Overview" && <p>{groupLabel(language, group.label)}</p>}{items.map((item) => { const Icon = iconMap[item] ?? Box; const available = served(item); return <button key={item} type="button" aria-label={item} disabled={!available} title={available ? undefined : "This API is not served by the active cluster"} className={cn(active === item && "selected", !available && "unavailable")} onClick={() => { onSelect(item, false); onClose(); }} onDoubleClick={() => { onSelect(item, true); onClose(); }}><Icon size={14} /><span>{resourceLabel(language, item)}</span>{!available && <small>—</small>}</button>; })}</section>; })}</nav>
    <div className="cluster-summary" style={{ ["--cluster-accent" as string]: clusterAccent(cluster) }}><div className="cluster-summary-head"><span className="cluster-summary-icon">{cluster.name.slice(0, 2).toUpperCase()}</span><div><small>{t(language, "currentCluster")}</small><strong>{cluster.name}</strong></div><StatusDot status={cluster.status} /></div><div className="cluster-summary-meta"><span>{cluster.provider} · {cluster.region}</span><Badge>{cluster.version}</Badge></div><div className="cluster-summary-stats"><div className="cluster-summary-metrics"><span><strong>{cluster.nodes}</strong> nodes</span><span><strong>{cluster.cpu}%</strong> CPU</span></div><div className="cluster-summary-actions"><Button type="button" variant="ghost" size="icon" className="hover-destructive" disabled={closing} aria-label={closing ? t(language, "closingConnection") : t(language, "closeConnection")} title={closing ? t(language, "closingConnection") : t(language, "closeConnection")} onClick={onCloseCluster}><Power size={12} /></Button></div></div></div>
  </aside>;
}

function ClusterActionsMenu({ cluster, language, busy, onConnect, onCloseConnection, onSettings, onRemove }: { cluster: Cluster; language: AppLanguage; busy: boolean; onConnect: () => void; onCloseConnection: () => void; onSettings: () => void; onRemove: () => void }) {
  const actions = clusterActionMenuItems({ cluster, language, busy, onConnect, onCloseConnection, onSettings, onRemove });
  return <div className="cluster-actions" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
    <Button type="button" variant="ghost" size="icon" title={t(language, "actions")} aria-label={`${t(language, "actions")} ${cluster.name}`} aria-haspopup="menu" onClick={(event) => openContextMenu(event, actions)}><MoreHorizontal size={15} /></Button>
  </div>;
}

type ClusterListRow = ResourceRow & { source: Cluster };

function ClusterHome({ clusters, language, busyClusterId, onConnect, onCloseConnection, onSettings, onRemove, onAdd }: { clusters: Cluster[]; language: AppLanguage; busyClusterId: string | null; onConnect: (cluster: Cluster) => void; onCloseConnection: (cluster: Cluster) => void; onSettings: (cluster: Cluster) => void; onRemove: (cluster: Cluster) => void; onAdd: () => void }) {
  const [query, setQuery] = useState("");
  const toolbarRef = useRef<HTMLDivElement>(null);
  const toolbarPinned = useToolbarPinned(toolbarRef);
  const searchHandleRef = useRef<TableSearchHandle | null>(null);
  const focusSearch = useTableSearchFocus(searchHandleRef);
  useResourceListFindShortcut(focusSearch);
  const listed = clusters.filter((cluster) => cluster.id !== "unconfigured");
  const connected = listed.filter((cluster) => !cluster.disconnected).length;
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = listed.filter((item) => !normalizedQuery || [item.name, item.context, item.server, item.provider, item.region, item.sourcePath, item.version].some((value) => value?.toLowerCase().includes(normalizedQuery)));
  const rows = useMemo((): ClusterListRow[] => filtered.map((item) => ({
    key: item.id,
    name: item.name,
    namespace: "—",
    kind: "Cluster",
    status: item.disconnected ? "offline" : item.status,
    data: {
      provider: item.provider,
      location: item.region,
      kubeconfig: item.sourcePath || "—",
      version: item.version,
      connection: item.disconnected ? "disconnected" : "connected",
    },
    source: item,
  })), [filtered]);
  const columns = useMemo((): VirtualTableColumn<ClusterListRow>[] => [
    {
      id: "name",
      label: t(language, "cluster"),
      sortValue: (row) => row.name,
      render: (row) => <div className="cluster-home-identity"><button type="button" className="cluster-home-avatar" aria-label={`${row.source.disconnected ? t(language, "connect") : t(language, "openOverview")} ${row.name}`} style={{ ["--cluster-accent" as string]: clusterAccent(row.source) }} onClick={(event) => { event.stopPropagation(); if (busyClusterId !== row.source.id) onConnect(row.source); }}>{row.name.slice(0, 2).toUpperCase()}<StatusDot status={row.source.disconnected ? "offline" : row.source.status} /></button><div><strong>{row.name}</strong><small>{row.source.context || row.source.server || row.source.id}</small></div></div>,
    },
    { id: "provider", label: t(language, "provider"), sortValue: (row) => row.source.provider, render: (row) => row.source.provider },
    { id: "server", label: "APIServer", sortValue: (row) => row.source.server, render: (row) => <span className="cluster-home-server font-mono" title={row.source.server}>{row.source.server || "—"}</span> },
    { id: "kubeconfig", label: tr(language, "kubeconfigPath"), sortValue: (row) => row.source.sourcePath || "", render: (row) => <span className="cluster-home-kubeconfig font-mono" title={row.source.sourcePath || undefined}>{row.source.sourcePath || "—"}</span> },
    { id: "version", label: t(language, "version"), sortValue: (row) => row.source.version, render: (row) => <span className="cluster-home-version font-mono">{row.source.version}</span> },
    {
      id: "connection",
      label: t(language, "status"),
      sortValue: (row) => Number(!row.source.disconnected),
      render: (row) => <span className={cn("cluster-connection-state", !row.source.disconnected && "connected")}><i />{row.source.disconnected ? t(language, "disconnected") : t(language, "connected")}</span>,
    },
  ], [busyClusterId, language, onConnect]);
  return <main className="home-main">
    <div className="home-titlebar titlebar-chrome">
      <div className="home-titlebar-drag" data-tauri-drag-region aria-hidden="true" />
      <WindowControls language={language} />
    </div>
    <div className="cluster-home-scroll"><div className="cluster-home">
      <header className="cluster-home-head"><div><div className="eyebrow">KUBERNETES WORKSPACES</div><h1>{t(language, "clusters")}</h1><p>{t(language, "clusterHomeDescription")}</p></div><Button size="sm" onClick={onAdd}><Plus size={13} />{t(language, "addCluster")}</Button></header>
      {listed.length ? <>
        <div className="resource-list-block">
        <div ref={toolbarRef} className={cn("table-toolbar cluster-home-toolbar", toolbarPinned && "pinned")}><TableSearchField value={query} onChange={setQuery} handleRef={searchHandleRef} ariaLabel={t(language, "searchClusters")} placeholder={t(language, "searchClusters")} clearLabel={tr(language, "clearClusterSearch")} /><div className="toolbar-spacer" /><span><strong>{listed.length}</strong> {t(language, "configuredClusters")}</span><span><strong>{connected}</strong> {t(language, "connectedClusters")}</span></div>
        <div className="resource-table-panel cluster-home-table-panel" aria-label={t(language, "clusters")}>
          <VirtualResourceTable
            rows={rows}
            columns={columns}
            language={language}
            tableKey="clusters"
            rowClassName={(row) => cn(!row.source.disconnected && "cluster-connected", busyClusterId === row.source.id && "busy")}
            rowStyle={(row) => ({ ["--cluster-accent" as string]: clusterAccent(row.source) })}
            onRowDoubleClick={(row) => { if (busyClusterId !== row.source.id) onConnect(row.source); }}
            renderAction={(row) => <ClusterActionsMenu cluster={row.source} language={language} busy={busyClusterId === row.source.id} onConnect={() => onConnect(row.source)} onCloseConnection={() => onCloseConnection(row.source)} onSettings={() => onSettings(row.source)} onRemove={() => onRemove(row.source)} />}
            empty={<div className="empty-state"><strong>{t(language, "noMatchingClusters")}</strong><span>{t(language, "noMatchingClustersHint")}</span></div>}
          />
        </div>
        </div>
      </> : <div className="cluster-home-empty"><Hexagon size={32} /><strong>{t(language, "noClusters")}</strong><span>{t(language, "noClustersHint")}</span><Button size="sm" onClick={onAdd}><Plus size={13} />{t(language, "addCluster")}</Button></div>}
      <p className="cluster-home-tip"><Info size={12} />{t(language, "clusterConnectHint")}</p>
    </div></div>
  </main>;
}

function ClusterConnectionPage({ cluster, language, state, busy, onReconnect, onCancel, onClose }: { cluster: Cluster; language: AppLanguage; state: ClusterConnectionState; busy: boolean; onReconnect: () => void; onCancel: () => void; onClose: () => void }) {
  const connecting = state.phase === "connecting";
  const title = connecting ? t(language, "connectingCluster") : state.phase === "failed" ? t(language, "connectionFailed") : t(language, "connectionInterrupted");
  const message = connecting
    ? t(language, "connectingClusterHint")
    : state.phase === "failed"
      ? t(language, "connectionFailedHint")
      : t(language, "connectionInterruptedHint");
  return <main className="cluster-connection-page">
    <div className="home-titlebar titlebar-chrome">
      <div className="home-titlebar-drag" data-tauri-drag-region aria-hidden="true" />
      <WindowControls language={language} />
    </div>
    <section className="cluster-connection-card" aria-live="polite">
      <div className={cn("cluster-connection-icon", !connecting && "error")}>{connecting ? <LoaderCircle className="spin" size={26} /> : <Wifi size={26} />}</div>
      <div className="cluster-connection-copy"><span>{cluster.context || cluster.server || "KUBERNETES CLUSTER"}</span><h1>{title}</h1><p>{cluster.name}</p><small>{message}</small></div>
      {connecting && <div className="cluster-connection-progress" role="status" aria-label={title}><i /></div>}
      {connecting && <div className="cluster-connection-actions"><Button variant="outline" size="sm" onClick={onCancel}><X size={13} />{t(language, "cancel")}</Button></div>}
      {!connecting && state.error && <div className="cluster-connection-error" role="alert">{state.error}</div>}
      {!connecting && <div className="cluster-connection-actions"><Button variant="outline" size="sm" disabled={busy} onClick={onClose}><Power size={13} />{t(language, "closeConnection")}</Button><Button size="sm" disabled={busy} onClick={onReconnect}>{busy && <LoaderCircle className="spin" size={13} />}<RefreshCw size={13} />{t(language, "reconnect")}</Button></div>}
    </section>
  </main>;
}

/** Top window chrome height: blank pixels here can drag / double-click maximize. */
const TITLEBAR_GESTURE_HEIGHT = 42;

/**
 * Clicks inside these surfaces never dismiss the resource details sheet. Resource
 * instances swap the sheet's content, and overlays close it through their own handlers.
 */
const DETAIL_SHEET_PERSIST_SELECTOR = [
  ".sheet-right",
  ".resource-table tbody tr",
  ".compact-list",
  ".modal-backdrop",
  ".panel-dialog-backdrop",
  ".context-menu",
  ".app-context-menu",
  ".combobox-popover",
  "[role='dialog']",
  "[role='menu']",
].join(", ");

async function toggleWindowMaximize() {
  try { await getCurrentWindow().toggleMaximize(); } catch { /* Browser prototype. */ }
}

function isWindowChromeInteractiveTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return true;
  return Boolean(target.closest([
    "button",
    "a",
    "input",
    "textarea",
    "select",
    "label",
    "[role='button']",
    "[role='menuitem']",
    "[role='option']",
    "[contenteditable='true']",
    ".combobox",
    ".window-controls",
    ".cluster-icon",
    ".brand-mark",
    ".rail-button",
    ".modal-backdrop",
    ".panel-dialog-backdrop",
    ".context-menu",
    ".combobox-popover",
    "[role='dialog']",
    "[role='menu']",
  ].join(", ")));
}

/** Whole top strip: blank area drag + double-click maximize/restore (VS Code / native titlebar feel). */
function useTitlebarWindowGestures() {
  useEffect(() => {
    let dragListeners: (() => void) | null = null;

    const clearDragListeners = () => {
      dragListeners?.();
      dragListeners = null;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (event.clientY > TITLEBAR_GESTURE_HEIGHT) return;
      if (isWindowChromeInteractiveTarget(event.target)) return;

      const startX = event.clientX;
      const startY = event.clientY;
      let started = false;

      const onMove = (move: PointerEvent) => {
        if (started) return;
        if (Math.hypot(move.clientX - startX, move.clientY - startY) < 4) return;
        started = true;
        clearDragListeners();
        void getCurrentWindow().startDragging().catch(() => { /* Browser prototype. */ });
      };

      const onUp = () => clearDragListeners();
      clearDragListeners();
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp, { once: true });
      window.addEventListener("pointercancel", onUp, { once: true });
      dragListeners = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
    };

    const onDblClick = (event: MouseEvent) => {
      if (event.clientY > TITLEBAR_GESTURE_HEIGHT) return;
      if (isWindowChromeInteractiveTarget(event.target)) return;
      event.preventDefault();
      void toggleWindowMaximize();
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("dblclick", onDblClick);
    return () => {
      clearDragListeners();
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("dblclick", onDblClick);
    };
  }, []);
}

function WindowControls({ language }: { language: AppLanguage }) {
  if (platform === "macos") return null;
  const run = (action: "minimize" | "maximize" | "close") => async () => {
    try {
      const window = getCurrentWindow();
      if (action === "minimize") await window.minimize();
      if (action === "maximize") await window.toggleMaximize();
      if (action === "close") await window.close();
    } catch { /* Browser prototype: controls are visual only. */ }
  };
  return <div className="window-controls" aria-label={tr(language, "windowControls")}><button aria-label={tr(language, "minimize")} onClick={run("minimize")}><Minus size={13} /></button><button aria-label={tr(language, "maximize")} onClick={run("maximize")}><Square size={11} /></button><button className="close" aria-label={tr(language, "closeWindow")} onClick={run("close")}><X size={13} /></button></div>;
}

function WorkspaceTabs({ tabs, activeId, language, onActivate, onClose, onCloseOthers, onCloseAll, onKeepOpen, onMenu }: {
  tabs: ResourceTab[];
  activeId: string;
  language: AppLanguage;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onCloseAll: () => void;
  onKeepOpen: (id: string) => void;
  onMenu: () => void;
}) {
  const tabListRef = useHorizontalTabRail();
  return <div className="workspace-tabs titlebar-chrome">
    <Button variant="ghost" size="icon" className="mobile-only tabs-menu-button" onClick={onMenu}><Menu size={15} /></Button>
    <div ref={tabListRef} className="workspace-tab-list">{tabs.map((tab) => {
      const Icon = tab.crdKind ? Code2 : (iconMap[tab.resource] ?? Box);
      const preview = isPreviewTab(tab);
      return <button
        key={tab.id}
        type="button"
        className={cn(activeId === tab.id && "active", preview && "preview")}
        title={preview ? tr(language, "previewTab") : tab.label}
        onClick={() => onActivate(tab.id)}
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (preview) onKeepOpen(tab.id);
        }}
        onContextMenu={(event) => openContextMenu(event, [
          { type: "item", id: "keep-open", label: tr(language, "keepOpen"), disabled: !preview, onSelect: () => onKeepOpen(tab.id) },
          { type: "separator" },
          { type: "item", id: "close", label: tr(language, "close"), disabled: tab.id === "overview", onSelect: () => onClose(tab.id) },
          { type: "item", id: "close-others", label: tr(language, "closeOthers"), disabled: tabs.length <= 1, onSelect: () => onCloseOthers(tab.id) },
          { type: "item", id: "close-all", label: tr(language, "closeAll"), disabled: tabs.every((item) => item.id === "overview"), onSelect: onCloseAll },
        ])}
      ><Icon className="tab-icon" size={13} /><strong>{tab.crdKind ? tab.label : resourceLabel(language, tab.label)}</strong>{tab.id !== "overview" && <i role="button" aria-label={`${tr(language, "close")} ${tab.label}`} onClick={(event) => { event.stopPropagation(); onClose(tab.id); }}><X size={11} /></i>}</button>;
    })}</div>
    <WindowControls language={language} />
  </div>;
}

function MetricCard({ label, value, unit, percentage, icon: Icon, tone = "green", sub, language }: { label: string; value: string; unit: string; percentage: number; icon: typeof Cpu; tone?: "green" | "amber"; sub: string; language: AppLanguage }) {
  return <div className="metric-card"><div className="metric-top"><span><Icon size={14} />{label}</span><strong>{value}<small>{unit}</small></strong></div><Progress value={percentage} tone={tone} /><div className="metric-foot"><span>{percentage}% {tr(language, "allocated")}</span><span>{sub}</span></div></div>;
}

function Overview({ cluster, language, revision, onResource, onTerminal, onNavigate, onSnapshot }: { cluster: Cluster; language: AppLanguage; revision: number; onResource: (item: ResourceRow) => void; onTerminal: () => void; onNavigate: (resource: string) => void; onSnapshot: (snapshot: LiveClusterOverview) => void }) {
  const [snapshot, setSnapshot] = useState<LiveClusterOverview | null>(null);
  const [loading, setLoading] = useState(nativeBackendAvailable);
  const [error, setError] = useState(nativeBackendAvailable ? "" : tr(language, "nativeAppRequired"));
  const [reloadToken, setReloadToken] = useState(0);
  useEffect(() => {
    if (!nativeBackendAvailable) return;
    let cancelled = false;
    setLoading(true); setError("");
    backend.overview(cluster.id).then((value) => { if (!cancelled) { setSnapshot(value); onSnapshot(value); } }).catch((nextError) => { if (!cancelled) { setError(String(nextError)); requestClusterProbe(cluster.id); } }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cluster.id, revision, reloadToken]);
  const cpu = snapshot?.cpuPercent ?? cluster.cpu;
  const memory = snapshot?.memoryPercent ?? cluster.memory;
  const podCount = snapshot?.pods ?? 0;
  const podCapacity = snapshot?.podCapacity ?? 0;
  const runningPods = snapshot?.runningPods ?? 0;
  const storageTiB = (snapshot?.storageBytes ?? 0) / 1_099_511_627_776;
  const storagePercent = snapshot?.storageCapacityBytes ? Math.round((snapshot.storageBytes / snapshot.storageCapacityBytes) * 100) : 0;
  const health = snapshot?.workloadHealth ?? { total: 0, healthy: 0, degraded: 0, failed: 0 };
  const liveEvents = snapshot?.events ?? [];
  const podDescriptor = descriptorForResource("Pods", [])!;
  const liveIssues = snapshot?.issues.map((record) => rowFromBackend(record, podDescriptor)) ?? [];
  const nodeValues = snapshot?.nodeUsage.map((node) => node.cpuPercent ?? 0) ?? [];
  return <div className="workspace-scroll"><div className="page-head"><div><div className="eyebrow">{tr(language, "clusterOverview")}</div><h1>{cluster.name}</h1><p>{error || `Kubernetes ${snapshot?.version ?? cluster.version} · ${snapshot?.nodes ?? cluster.nodes} nodes · ${loading ? tr(language, "updating") : tr(language, "updatedJustNow")}`}</p></div><div className="head-actions"><Button variant="outline" size="sm" disabled={loading || !nativeBackendAvailable} onClick={() => setReloadToken((value) => value + 1)}><RefreshCw className={cn(loading && "spin")} size={13} />{t(language, "refresh")}</Button><Button size="sm" disabled={!nativeBackendAvailable} onClick={onTerminal}><SquareTerminal size={13} />{tr(language, "openShell")}</Button></div></div>
    <div className="metrics-grid"><MetricCard label="CPU" value={String(cpu)} unit="%" percentage={cpu} tone={cpu > 75 ? "amber" : "green"} sub={snapshot?.cpuPercent == null ? tr(language, "metricsApiUnavailable") : tr(language, "liveNodeUsage")} icon={Cpu} language={language} /><MetricCard label={tr(language, "memory")} value={String(memory)} unit="%" percentage={memory} sub={snapshot?.memoryPercent == null ? tr(language, "metricsApiUnavailable") : tr(language, "liveNodeUsage")} icon={Activity} language={language} /><MetricCard label="Pods" value={String(podCount)} unit={`/ ${podCapacity}`} percentage={podCapacity ? Math.min(100, Math.round((podCount / podCapacity) * 100)) : 0} sub={`${runningPods} ${tr(language, "running")}`} icon={Box} language={language} /><MetricCard label="Storage" value={storageTiB.toFixed(1)} unit="TiB" percentage={storagePercent} tone={storagePercent > 75 ? "amber" : "green"} sub={tr(language, "boundPersistentVolumes")} icon={HardDrive} language={language} /></div>
    <div className="overview-grid"><section className="panel"><div className="panel-head"><div><h2>{tr(language, "workloadHealth")}</h2><p>{tr(language, "acrossAllNamespaces")}</p></div><Button variant="ghost" size="sm" onClick={() => onNavigate("Deployments")}>{tr(language, "viewAll")} <ChevronRight size={12} /></Button></div><div className="health-chart"><div className="donut"><div><strong>{health.total}</strong><span>{tr(language, "workloads")}</span></div></div><div className="health-legend"><div><span><i className="green" />{tr(language, "healthy")}</span><strong>{health.healthy}</strong></div><div><span><i className="amber" />{tr(language, "degraded")}</span><strong>{health.degraded}</strong></div><div><span><i className="red" />{tr(language, "failed")}</span><strong>{health.failed}</strong></div></div></div></section><section className="panel"><div className="panel-head"><div><h2>Nodes</h2><p>{snapshot?.nodes ?? cluster.nodes} {tr(language, "connected")}</p></div><Badge tone={(snapshot?.readyNodes ?? 0) === (snapshot?.nodes ?? 0) ? "green" : "amber"}>{snapshot ? `${snapshot.readyNodes}/${snapshot.nodes} ${tr(language, "ready")}` : `0 ${tr(language, "ready")}`}</Badge></div><div className="node-bars">{nodeValues.map((v, i) => <div key={snapshot?.nodeUsage[i]?.name ?? i}><span style={{ height: `${v}%` }} className={v > 78 ? "hot" : ""} /></div>)}</div><div className="node-axis"><span>{snapshot?.nodeUsage[0]?.name ?? "—"}</span><span>{tr(language, "cpuUtilization")}</span><span>{snapshot?.nodeUsage.at(-1)?.name ?? "—"}</span></div></section></div>
    <section className="panel issues-panel"><div className="panel-head"><div><h2>{tr(language, "needsAttention")}</h2><p>{tr(language, "alerts")}</p></div><Badge tone="amber">{liveIssues.length} {tr(language, "active")}</Badge></div><div className="compact-list">{liveIssues.map((item) => <button key={item.key} onClick={() => onResource(item)}><StatusDot status={item.status ?? "Pending"} /><div><strong>{item.name}</strong><span>{item.namespace} · {item.kind}</span></div><Badge tone="amber">{item.status}</Badge><span>{item.data.containers ?? "—"} ready</span><ChevronRight size={14} /></button>)}</div></section>
    <section className="panel events-panel"><div className="panel-head"><div><h2>{tr(language, "recentEvents")}</h2><p>{tr(language, "liveClusterActivity")}</p></div><div className="live-label"><i />{tr(language, "live")}</div></div><div className="event-list">{liveEvents.map((event, index) => <div key={`${event.object}-${index}`}><span className={cn("event-icon", event.level)}>{event.level === "warning" ? <AlertTriangle size={13} /> : <CircleDot size={13} />}</span><div><strong>{event.reason}</strong><span>{event.message}</span><small>{event.object}</small></div><time>{event.time}</time></div>)}</div></section>
  </div>;
}

function statusTone(status?: string): "green" | "amber" | "red" | "neutral" {
  if (!status) return "neutral";
  const value = status.toLowerCase().replace(/\s+/g, "");
  if (value.includes("crash") || value.includes("failed") || value.includes("error") || value.includes("notready") || value.includes("terminat")) return "red";
  if (value.includes("degraded") || value.includes("pending") || value.includes("warning") || value.includes("outofsync") || value.includes("issuing") || value.includes("waiting")) return "amber";
  if (value.includes("running") || value.includes("ready") || value.includes("healthy") || value.includes("synced") || value.includes("bound") || value.includes("deployed") || value.includes("complete") || value.includes("active")) return "green";
  return "neutral";
}

function manifestReadOnlyReason(row: ResourceRow): string | undefined {
  if (row.kind === "HelmRelease") return "This Helm release is managed by Helm and is read-only in KubeHive.";
  if (row.kind === "Secret") return "Secret manifests can be inspected here but are read-only to prevent accidental modification.";
  if (!nativeBackendAvailable) return undefined;
  if (!row.descriptor) return "KubeHive could not determine this resource's patch capability, so the manifest is read-only.";
  if (!row.descriptor.verbs.includes("patch")) return "This resource API does not advertise the patch operation, so the manifest is read-only.";
  return undefined;
}

type ResourceSyncMode = "unavailable" | "manual" | "poll" | "watch";

const RESOURCE_POLL_INTERVAL = 15_000;
const PORT_FORWARD_POLL_INTERVAL = 3_000;

function resourceSyncMode(resource: string, descriptor: ApiResourceDescriptor | null | undefined): ResourceSyncMode {
  if (!nativeBackendAvailable) return "unavailable";
  if (resource === "Port Forwarding") return "poll";
  if (resource === "Helm Charts") return "manual";
  return descriptor?.verbs.includes("watch") ? "watch" : "poll";
}

function useResourceRows(clusterId: string, resource: string, namespace: string, discovered: ApiResourceDescriptor[], revision = 0, override?: ApiResourceDescriptor) {
  const rowsByKey = useRef(new Map<string, ResourceRow>());
  const [rowsRevision, setRowsRevision] = useState(0);
  const [loading, setLoading] = useState(nativeBackendAvailable);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const descriptor = override ?? descriptorForResource(resource, discovered);
  const effectiveDescriptor = resource === "Helm Releases"
    ? discovered.find((entry) => entry.kind === "Secret" && entry.apiVersion === "v1") ?? descriptorForResource("Secrets", discovered)
    : descriptor;
  const desiredSyncMode = resourceSyncMode(resource, effectiveDescriptor);
  const descriptorSignature = effectiveDescriptor
    ? `${effectiveDescriptor.apiVersion}\u0000${effectiveDescriptor.kind}\u0000${effectiveDescriptor.plural}\u0000${effectiveDescriptor.namespaced}\u0000${effectiveDescriptor.verbs.join(",")}`
    : "";
  const [syncMode, setSyncMode] = useState<ResourceSyncMode>(desiredSyncMode);
  const rows = useMemo(() => Array.from(rowsByKey.current.values()), [rowsRevision]);
  const replaceRows = (nextRows: ResourceRow[]) => {
    rowsByKey.current = new Map(nextRows.map((row) => [row.key, row]));
    setRowsRevision((value) => value + 1);
  };

  useEffect(() => {
    if (!nativeBackendAvailable) {
      replaceRows([]);
      setSyncMode("unavailable");
      setError("");
      setLoading(false);
      return;
    }
    setSyncMode(desiredSyncMode);
    let cancelled = false;
    let subscriptionId = "";
    let refreshTimer: number | undefined;
    let loadingSnapshot = false;
    const stop = () => { if (subscriptionId) void backend.stopWatch(subscriptionId); };
    const stopRefreshTimer = () => {
      if (refreshTimer !== undefined) {
        window.clearInterval(refreshTimer);
        refreshTimer = undefined;
      }
    };
    const interval = resource === "Port Forwarding" ? PORT_FORWARD_POLL_INTERVAL : RESOURCE_POLL_INTERVAL;
    const startRefreshTimer = () => {
      if (refreshTimer === undefined) refreshTimer = window.setInterval(() => { void load(true); }, interval);
    };
    const load = async (quiet = false) => {
      if (loadingSnapshot) return;
      loadingSnapshot = true;
      if (!quiet) setLoading(true);
      if (!quiet) setError("");
      try {
        if (resource === "Port Forwarding") {
          const sessions = await backend.listPortForwards(clusterId);
          if (!cancelled) {
            replaceRows(sessions.map((session) => {
              const targetKind = session.targetKind === "service" ? "Service" : "Pod";
              const targetName = `${targetKind}/${session.targetName}`;
              return {
                key: session.id, name: targetName, namespace: session.namespace, kind: "PortForward", status: session.status,
                data: { name: targetName, namespace: session.namespace, host: session.host, localAddress: `${session.host}:${session.localPort}`, localPort: session.localPort, targetPort: session.remotePort, servicePort: session.servicePort, resolvedPod: session.pod, protocol: session.protocol.toUpperCase(), status: session.status, error: session.error },
              };
            }));
            setError("");
          }
          return;
        }
        if (resource === "Helm Charts") {
          const charts = await backend.listHelmCharts(reloadToken > 0);
          if (!cancelled) {
            replaceRows(charts.map((chart) => ({ key: `${chart.repository}/${chart.name}`, name: chart.name, namespace: "—", kind: "HelmChart", data: { name: chart.name, repository: chart.repository, version: chart.version, appVersion: chart.appVersion, description: chart.description } })));
            setError("");
          }
          return;
        }
        let labelSelector: string | undefined;
        if (resource === "Helm Releases") labelSelector = "owner=helm";
        if (!effectiveDescriptor) throw new Error(`No Kubernetes API mapping is available for ${resource}`);
        const request = {
          clusterId,
          resource: effectiveDescriptor,
          namespace: effectiveDescriptor.namespaced && namespace !== "All namespaces" ? namespace : undefined,
          labelSelector,
          compact: resource === "Custom Resource Definitions" || !resource.startsWith("Custom Resource "),
        };
        const response = await backend.listResources(request);
        if (cancelled) return;
        const toRow = (record: BackendResourceRecord) => {
          const row = rowFromBackend(record, effectiveDescriptor);
          if (resource === "Helm Releases") {
            const labels = (record.object.metadata as { labels?: Record<string, string> } | undefined)?.labels ?? {};
            const match = record.name.match(/^sh\.helm\.release\.v1\.(.+)\.v(\d+)$/);
            row.name = match?.[1] ?? record.name;
            row.kind = "HelmRelease";
            row.data = { ...row.data, name: row.name, chart: labels.chart ?? "—", status: labels.status ?? "unknown", revision: match?.[2] ?? labels.version ?? "—", appVersion: labels.appVersion ?? "—", updated: row.data.age };
          }
          return row;
        };
        replaceRows(response.items.map(toRow));
        setError("");
        if (desiredSyncMode === "watch" && !subscriptionId) {
          try {
            const nextSubscriptionId = await backend.startWatch({ ...request, resourceVersion: response.resourceVersion }, (message) => {
              if (cancelled) return;
              if (message.eventType === "error") {
                setError("");
                setSyncMode("poll");
                requestClusterProbe(clusterId);
                startRefreshTimer();
                return;
              }
              setError("");
              setSyncMode("watch");
              stopRefreshTimer();
              if (message.eventType === "snapshot") {
                replaceRows(message.resources.map(toRow));
                return;
              }
              if (message.eventType !== "batch" || message.events.length === 0) return;
              const current = rowsByKey.current;
              message.events.forEach((event) => {
                const next = toRow(event.resource);
                if (event.eventType === "deleted") current.delete(next.key);
                else current.set(next.key, next);
              });
              setRowsRevision((value) => value + 1);
            });
            subscriptionId = nextSubscriptionId;
            if (cancelled) {
              void backend.stopWatch(nextSubscriptionId);
              return;
            }
            setSyncMode("watch");
            stopRefreshTimer();
          } catch {
            if (!cancelled) {
              setError("");
              setSyncMode("poll");
              requestClusterProbe(clusterId);
              startRefreshTimer();
            }
          }
        }
      } catch (nextError) {
        if (!cancelled) {
          if (!quiet) replaceRows([]);
          setError(String(nextError));
          requestClusterProbe(clusterId);
          if (desiredSyncMode !== "manual") {
            setSyncMode("poll");
            startRefreshTimer();
          }
        }
      } finally {
        loadingSnapshot = false;
        if (!cancelled && !quiet) setLoading(false);
      }
    };
    void load();
    if (desiredSyncMode === "poll") startRefreshTimer();
    return () => { cancelled = true; stop(); stopRefreshTimer(); };
  }, [clusterId, resource, namespace, revision, reloadToken, descriptorSignature, desiredSyncMode]);

  return { rows, loading, error, descriptor, syncMode, reload: () => setReloadToken((value) => value + 1) };
}


function renderResourceCell(columnId: string, row: ResourceRow, onOpenLink?: (link: ResourceLink, row: ResourceRow) => void, language?: AppLanguage) {
  const value = row.data[columnId];
  if (columnId === "name") {
    return <div className="resource-name"><span className="resource-kind">{row.kind[0]}</span><div><strong>{row.name}</strong><small>{row.kind}</small></div></div>;
  }
  if (columnId === "containers" && row.containers) {
    return <ContainerSquares containers={row.containers} language={language} />;
  }
  if (columnId === "status") {
    const status = String(row.status ?? value ?? "—");
    return <Badge tone={statusTone(status)}><StatusDot status={status} />{status}</Badge>;
  }
  if (columnId === "restarts") {
    const restarts = Number(value ?? 0);
    return <span className={restarts > 5 ? "danger-text" : undefined}>{restarts}</span>;
  }
  const link = row.links?.[columnId];
  if (link && onOpenLink && value !== undefined && value !== "") {
    return <ResourceLinkButton link={link} label={String(value)} stacked={columnId === "controlledBy" || columnId === "role" || columnId === "claim"} language={language} onOpen={(next) => onOpenLink(next, row)} />;
  }
  if (value === undefined || value === "") return "—";
  return value;
}

const resourceSearchTextCache = new WeakMap<ResourceRow, string>();

function resourceSearchText(row: ResourceRow) {
  const cached = resourceSearchTextCache.get(row);
  if (cached) return cached;
  const value = `${row.name} ${row.namespace} ${row.kind} ${Object.values(row.data).join(" ")}`.toLowerCase();
  resourceSearchTextCache.set(row, value);
  return value;
}

function isFindShortcut(event: KeyboardEvent | ReactKeyboardEvent) {
  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f";
}

function isInsideSessionDock(node: EventTarget | null) {
  return node instanceof Element && Boolean(node.closest(".session-dock"));
}

function isInsideExpandedSessionDock(node: EventTarget | null) {
  if (!(node instanceof Element)) return false;
  const dock = node.closest(".session-dock");
  return Boolean(dock && !dock.classList.contains("collapsed"));
}

/** Last pointer target inside the bottom sheet (tabs count) owns Cmd/Ctrl+F until the user clicks elsewhere. */
let sessionDockFindContextActive = false;

function noteSessionDockFindContext(target: EventTarget | null) {
  sessionDockFindContextActive = isInsideSessionDock(target);
}

function sessionDockFindEnabled() {
  return Boolean(document.querySelector(".session-dock[data-session-find='true']"));
}

function isSessionFindContext(eventTarget: EventTarget | null = null) {
  if (!sessionDockFindEnabled()) return false;
  if (isInsideExpandedSessionDock(eventTarget) || isInsideExpandedSessionDock(document.activeElement)) return true;
  return sessionDockFindContextActive;
}

function useSessionDockFindContextTracking() {
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => noteSessionDockFindContext(event.target);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, []);
}

function focusTableSearchInput(input: HTMLInputElement | null) {
  if (!input) return;
  input.focus();
  input.select();
}

/** Focus a list/filter search box on Cmd/Ctrl+F unless the bottom sheet owns the shortcut. */
function useResourceListFindShortcut(focusSearch: () => boolean | void) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!isFindShortcut(event)) return;
      if (isSessionFindContext(event.target)) return;
      const active = document.activeElement;
      if (active instanceof Element && active.closest(".modal-backdrop, [role='dialog'], .text-search-popover, .command-modal")) return;
      if (focusSearch() === false) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [focusSearch]);
}

type TableSearchHandle = { focus: () => boolean };

/**
 * Marks the table toolbar as "pinned" once it locks flush under the tab strip,
 * so it can shed its top border and corners (the tab strip's own border takes
 * over). The toolbar keeps its rounded, bordered look while at rest.
 */
function useToolbarPinned(toolbarRef: RefObject<HTMLDivElement | null>): boolean {
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    const toolbar = toolbarRef.current;
    const scroller = toolbar?.closest(".workspace-scroll, .cluster-home-scroll") as HTMLElement | null;
    if (!toolbar || !scroller) return;
    if (getComputedStyle(toolbar).position !== "sticky") {
      setPinned(false);
      return;
    }
    const update = () => {
      const toolbarTop = toolbar.getBoundingClientRect().top;
      const scrollportTop = scroller.getBoundingClientRect().top;
      setPinned(toolbarTop <= scrollportTop + 0.5);
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      scroller.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [toolbarRef]);
  return pinned;
}

function TableSearchField({
  value,
  onChange,
  placeholder,
  ariaLabel,
  clearLabel,
  handleRef,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  clearLabel: string;
  handleRef?: RefObject<TableSearchHandle | null>;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Collapsed to an icon-only toggle until activated (click or Cmd/Ctrl+F).
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (active) focusTableSearchInput(inputRef.current);
  }, [active]);

  const focus = useCallback(() => {
    setActive(true);
    focusTableSearchInput(inputRef.current);
    return true;
  }, []);

  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = { focus };
    return () => { handleRef.current = null; };
  }, [focus, handleRef]);

  const clear = () => {
    onChange("");
    focusTableSearchInput(inputRef.current);
  };

  return <div className={cn("table-search table-search-collapsible", active && "active", value && "has-value", className)}>
    <button type="button" className="table-search-toggle" aria-label={ariaLabel} onMouseDown={(event) => event.preventDefault()} onClick={() => setActive(true)}><Search size={14} aria-hidden="true" /></button>
    <Search size={14} aria-hidden="true" className="table-search-icon" />
    <input ref={inputRef} value={value} onChange={(event) => onChange(event.target.value)} onBlur={(event) => { if (!value && !event.currentTarget.contains(event.relatedTarget as Node | null)) setActive(false); }} onKeyDown={(event) => { if (event.key === "Escape") setActive(false); }} aria-label={ariaLabel} placeholder={placeholder} />
    {value ? <button type="button" className="table-search-clear" aria-label={clearLabel} onMouseDown={(event) => event.preventDefault()} onClick={clear}><X size={12} /></button> : null}
  </div>;
}

function useTableSearchFocus(handleRef: RefObject<TableSearchHandle | null>) {
  return useCallback(() => handleRef.current?.focus() ?? false, [handleRef]);
}

type BulkResourceAction = "delete" | "evict";
type BulkActionFeedback = { tone: "success" | "warning"; text: string } | null;

function bulkFailureKey(namespace: string | null | undefined, name: string) {
  return `${namespace ?? "—"}\u0000${name}`;
}

function bulkActionFeedback(action: BulkResourceAction, result: BulkActionResult): BulkActionFeedback {
  const verb = action === "evict" ? "evicted" : "deleted";
  if (result.failures.length === 0) return { tone: "success", text: `${result.succeeded} resources ${verb}` };
  const examples = result.failures.slice(0, 2).map((failure) => `${failure.name}: ${failure.error}`).join(" · ");
  return { tone: "warning", text: `${result.succeeded}/${result.requested} ${verb}; ${result.failures.length} failed${examples ? ` · ${examples}` : ""}` };
}

function useBulkResourceActions({ clusterId, rows, descriptor, selectionKey, canDelete, canEvict, onCompleted }: {
  clusterId: string;
  rows: ResourceRow[];
  descriptor?: ApiResourceDescriptor | null;
  selectionKey: string;
  canDelete: boolean;
  canEvict: boolean;
  onCompleted: () => void;
}) {
  const enabled = canDelete || canEvict;
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [pendingAction, setPendingAction] = useState<BulkResourceAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState<BulkActionFeedback>(null);
  useEffect(() => {
    setSelectedKeys(new Set());
    setPendingAction(null);
    setBusy(false);
    setError("");
    setFeedback(null);
  }, [selectionKey]);
  useEffect(() => {
    const available = new Set(rows.map((row) => row.key));
    setSelectedKeys((current) => {
      const next = new Set([...current].filter((key) => available.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [rows]);
  useEffect(() => {
    if (!pendingAction) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      event.stopPropagation();
      setPendingAction(null);
      setError("");
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [pendingAction, busy]);
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), 6_000);
    return () => window.clearTimeout(timer);
  }, [feedback]);
  const selectedRows = useMemo(() => rows.filter((row) => selectedKeys.has(row.key)), [rows, selectedKeys]);
  const begin = (action: BulkResourceAction) => {
    if (!selectedRows.length || (action === "delete" ? !canDelete : !canEvict)) return;
    setPendingAction(action);
    setError("");
  };
  const close = () => {
    if (busy) return;
    setPendingAction(null);
    setError("");
  };
  const confirm = async () => {
    const action = pendingAction;
    if (!action || busy || selectedRows.length === 0) return;
    setBusy(true);
    setError("");
    try {
      if (!nativeBackendAvailable) throw new Error("Bulk resource operations are available in the native KubeHive application.");
      let result: BulkActionResult;
      if (action === "delete") {
        const targets = selectedRows.map((row) => {
          const resourceDescriptor = row.descriptor ?? descriptor;
          if (!resourceDescriptor) throw new Error(`No Kubernetes API mapping is available for ${row.kind}`);
          if (!resourceDescriptor.verbs.includes("delete")) throw new Error(`The current Kubernetes credentials cannot delete ${row.kind} resources`);
          return {
            clusterId,
            resource: resourceDescriptor,
            namespace: row.namespace === "—" ? undefined : row.namespace,
            name: row.name,
            foreground: false,
          };
        });
        result = await backend.deleteResources(targets);
      } else {
        const pods = selectedRows.map((row) => {
          if (row.kind !== "Pod" || row.namespace === "—") throw new Error("Only namespaced Pods can be evicted");
          return { clusterId, namespace: row.namespace, pod: row.name };
        });
        result = await backend.evictPods(pods);
      }
      const failed = new Set(result.failures.map((failure) => bulkFailureKey(failure.namespace, failure.name)));
      setSelectedKeys(new Set(selectedRows.filter((row) => failed.has(bulkFailureKey(row.namespace, row.name))).map((row) => row.key)));
      setFeedback(bulkActionFeedback(action, result));
      setPendingAction(null);
      onCompleted();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };
  return { enabled, selectedKeys, setSelectedKeys, selectedRows, pendingAction, busy, error, feedback, begin, close, confirm, canDelete, canEvict };
}

type BulkResourceActions = ReturnType<typeof useBulkResourceActions>;

function BulkResourceToolbar({ actions }: { actions: BulkResourceActions }) {
  if (!actions.enabled || (actions.selectedRows.length === 0 && !actions.feedback)) return null;
  return <div className="bulk-resource-actions" role="status">
    {actions.selectedRows.length > 0 && <strong>{actions.selectedRows.length} selected</strong>}
    {actions.canEvict && actions.selectedRows.length > 0 && <Button variant="outline" size="sm" className="action-warning" onClick={() => actions.begin("evict")}><LogOut size={13} />Evict</Button>}
    {actions.canDelete && actions.selectedRows.length > 0 && <Button variant="outline" size="sm" className="hover-destructive" onClick={() => actions.begin("delete")}><Trash2 size={13} />Delete</Button>}
    {actions.feedback && <span className={cn("bulk-action-feedback", `tone-${actions.feedback.tone}`)} title={actions.feedback.text}>{actions.feedback.text}</span>}
  </div>;
}

function BulkResourceActionDialog({ actions }: { actions: BulkResourceActions }) {
  const action = actions.pendingAction;
  if (!action) return null;
  const evicting = action === "evict";
  const title = evicting ? "Evict selected Pods" : "Delete selected resources";
  const confirmLabel = evicting ? "Evict Pods" : "Delete resources";
  return <div className="modal-backdrop panel-dialog-backdrop bulk-resource-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) actions.close(); }}>
    <section className={cn("bulk-resource-dialog", evicting && "tone-warning")} role="dialog" aria-modal="true" aria-labelledby="bulk-resource-action-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><h2 id="bulk-resource-action-title">{title}</h2><div /><Button variant="ghost" size="icon" disabled={actions.busy} aria-label="Close bulk action confirmation" onClick={actions.close}><X size={14} /></Button></header>
      <div className="bulk-resource-body">
        <div className="bulk-resource-target"><span className="bulk-resource-icon">{evicting ? <LogOut size={17} /> : <Trash2 size={17} />}</span><div><strong>{actions.selectedRows.length} resources selected</strong><small>{actions.selectedRows.slice(0, 3).map((row) => `${row.kind}/${row.name}`).join(" · ")}{actions.selectedRows.length > 3 ? ` · +${actions.selectedRows.length - 3} more` : ""}</small></div></div>
        <div className="bulk-resource-warning"><AlertTriangle size={15} /><div><strong>{evicting ? "Evict these Pods from their nodes?" : "Delete all selected resources?"}</strong><span>{evicting ? "Kubernetes will check each PodDisruptionBudget and use graceful termination. Controllers may create replacement Pods; blocked evictions will be reported individually." : "This operation cannot be undone. Requests run with bounded concurrency and failures are reported per resource; Kubernetes controllers may recreate managed resources."}</span></div></div>
        <div className="bulk-resource-list">{actions.selectedRows.slice(0, 6).map((row) => <div key={row.key}><span>{row.kind}</span><strong>{row.name}</strong><small>{row.namespace === "—" ? "Cluster scoped" : row.namespace}</small></div>)}{actions.selectedRows.length > 6 && <div className="bulk-resource-list-more">+{actions.selectedRows.length - 6} more resources</div>}</div>
        {actions.error && <div className="bulk-resource-error" role="alert">{actions.error}</div>}
      </div>
      <footer><span>{evicting ? "Kubernetes policy/v1 Eviction" : "Kubernetes API · background propagation"}</span><div /><Button variant="outline" size="sm" disabled={actions.busy} autoFocus onClick={actions.close}>Cancel</Button><Button variant="outline" size="sm" className={cn("bulk-resource-confirm", evicting ? "action-warning" : "hover-destructive")} disabled={actions.busy} onClick={() => void actions.confirm()}>{actions.busy && <LoaderCircle className="spin" size={13} />}{actions.busy ? "Working…" : confirmLabel}</Button></footer>
    </section>
  </div>;
}

function ResourceTable({ clusterId, discovered, namespaces, revision, resource, selectedNamespaces, setSelectedNamespaces, language, onSelect, onOpenLink, onCreate, onRowAction }: {
  clusterId: string; discovered: ApiResourceDescriptor[]; namespaces: string[]; revision: number; resource: string; selectedNamespaces: string[];
  setSelectedNamespaces: (value: string[]) => void; language: AppLanguage; onSelect: (item: ResourceRow) => void;
  onOpenLink: (link: ResourceLink, row: ResourceRow) => void; onCreate: (descriptor?: ApiResourceDescriptor | null) => void;
  onRowAction: (action: string, row: ResourceRow) => void;
}) {
  const [query, setQuery] = useState("");
  const searchHandleRef = useRef<TableSearchHandle | null>(null);
  const focusSearch = useTableSearchFocus(searchHandleRef);
  useResourceListFindShortcut(focusSearch);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const toolbarPinned = useToolbarPinned(toolbarRef);
  const deferredQuery = useDeferredValue(query);
  const { defs, visible, setColumnVisible, reset, isVisible } = useVisibleColumns(resource);
  const clusterScoped = clusterScopedResources.has(resource);
  const apiNamespace = apiNamespaceFilter(selectedNamespaces) ?? "All namespaces";
  const namespaceKey = selectedNamespaces.length === 0 ? "All namespaces" : selectedNamespaces.slice().sort().join(",");
  const live = useResourceRows(clusterId, resource, apiNamespace, discovered, revision);
  const filtered = useMemo(() => {
    const search = deferredQuery.toLowerCase();
    return live.rows.filter((item) => (clusterScoped || matchesNamespaceFilter(item.namespace, selectedNamespaces)) && resourceSearchText(item).includes(search));
  }, [live.rows, clusterScoped, selectedNamespaces, deferredQuery]);
  const columns = useMemo<Array<VirtualTableColumn<ResourceRow>>>(() => visible.map((column) => ({
    id: column.id,
    label: column.label,
    render: (item) => renderResourceCell(column.id, item, onOpenLink, language),
  })), [visible, onOpenLink, language]);
  const canCreate = nativeBackendAvailable && (resource === "Port Forwarding" || Boolean(live.descriptor?.verbs.includes("create")));
  const canBulkDelete = nativeBackendAvailable && !["Port Forwarding", "Helm Charts", "Helm Releases"].includes(resource) && Boolean(live.descriptor?.verbs.includes("delete"));
  const bulkActions = useBulkResourceActions({
    clusterId,
    rows: filtered,
    descriptor: live.descriptor,
    selectionKey: `${clusterId}|${resource}|${namespaceKey}|${query}`,
    canDelete: canBulkDelete,
    canEvict: resource === "Pods",
    onCompleted: live.reload,
  });
  const rowMenu = (event: ReactMouseEvent, item: ResourceRow) => {
    const workload = ["Pod", "Deployment", "StatefulSet", "DaemonSet"].includes(item.kind);
    const isNode = item.kind === "Node";
    const nodeUnschedulable = isNode ? Boolean((item.backend?.object as { spec?: { unschedulable?: boolean } } | undefined)?.spec?.unschedulable) : false;
    const portForwardable = forwardablePortsFor(item).some((port) => port.forwardable);
    const scalable = ["Deployment", "StatefulSet", "ReplicaSet", "ReplicationController"].includes(item.kind);
    const restartable = ["Deployment", "StatefulSet", "ReplicaSet", "ReplicationController"].includes(item.kind);
    openContextMenu(event, [
      { type: "item", id: "open", label: tr(language, "openDetails"), icon: Info, onSelect: () => onSelect(item) },
      { type: "item", id: "edit", label: tr(language, "editManifest"), icon: Pencil, onSelect: () => onRowAction("Edit", item) },
      ...(workload ? [{ type: "item" as const, id: "logs", label: tr(language, "logs"), icon: ScrollText, onSelect: () => onRowAction("Logs", item) }, { type: "item" as const, id: "terminal", label: tr(language, "terminal"), icon: SquareTerminal, onSelect: () => onRowAction("Terminal", item) }, { type: "item" as const, id: "files", label: tr(language, "containerFiles"), icon: FolderOpen, onSelect: () => onRowAction("Files", item) }] : []),
      ...(isNode ? [
        { type: "item" as const, id: "terminal", label: tr(language, "terminal"), icon: SquareTerminal, onSelect: () => onRowAction("Terminal", item) },
        { type: "item" as const, id: "files", label: tr(language, "nodeFiles"), icon: FolderOpen, onSelect: () => onRowAction("Files", item) },
        { type: "separator" as const },
        nodeUnschedulable
          ? { type: "item" as const, id: "uncordon", label: tr(language, "uncordon"), icon: Play, onSelect: () => onRowAction("Uncordon", item) }
          : { type: "item" as const, id: "cordon", label: tr(language, "cordon"), icon: Pause, onSelect: () => onRowAction("Cordon", item) },
        { type: "item" as const, id: "drain", label: tr(language, "drain"), icon: Droplets, onSelect: () => onRowAction("Drain", item) },
        { type: "item" as const, id: "taints", label: tr(language, "taints"), icon: PaintBucket, onSelect: () => onRowAction("Taints", item) },
      ] : []),
      ...(["Pod", "Service"].includes(item.kind) ? [{ type: "item" as const, id: "port-forward", label: `${tr(language, "portForward")}...`, icon: Network, disabled: item.kind === "Pod" && !portForwardable, onSelect: () => onRowAction("Port Forward", item) }] : []),
      ...(item.kind === "Pod" ? [{ type: "item" as const, id: "evict", label: tr(language, "evict"), icon: LogOut, hoverWarning: true, onSelect: () => onRowAction("Evict", item) }] : []),
      ...(scalable ? [{ type: "item" as const, id: "scale", label: tr(language, "scale"), icon: Scaling, onSelect: () => onRowAction("Scale", item) }] : []),
      ...(restartable ? [{ type: "item" as const, id: "restart", label: tr(language, "restartRollout"), icon: RefreshCw, onSelect: () => onRowAction("Restart", item) }] : []),
      { type: "separator" },
      ...(item.kind === "PortForward"
        ? [
          { type: "item" as const, id: "open-port-forward", label: tr(language, "openInBrowser"), icon: ExternalLink, disabled: item.status !== "Active", onSelect: () => onRowAction("Open Port Forward", item) },
          item.status === "Paused"
            ? { type: "item" as const, id: "resume-port-forward", label: tr(language, "resumeForwarding"), icon: Play, onSelect: () => onRowAction("Resume Port Forward", item) }
            : { type: "item" as const, id: "pause-port-forward", label: tr(language, "pauseForwarding"), icon: Pause, onSelect: () => onRowAction("Pause Port Forward", item) },
          { type: "item" as const, id: "stop-port-forward", label: tr(language, "stopForwarding"), icon: Square, hoverDestructive: true, onSelect: () => onRowAction("Stop Port Forward", item) },
        ]
        : [{ type: "item" as const, id: "delete", label: tr(language, "delete"), icon: Trash2, hoverDestructive: true, disabled: item.kind === "HelmRelease" || (nativeBackendAvailable && !item.descriptor?.verbs.includes("delete")), onSelect: () => onRowAction("Delete", item) }]),
    ]);
  };
  return <><div className="workspace-scroll">
    <div className="page-head"><div><div className="eyebrow">KUBERNETES RESOURCES</div><h1>{resourceLabel(language, resource)}</h1><p>{live.loading ? tr(language, "loadingFromApi") : live.error ? live.error : `${filtered.length} ${tr(language, "resources")} · ${live.syncMode === "watch" ? tr(language, "liveUpdates") : live.syncMode === "poll" ? resource === "Port Forwarding" ? tr(language, "updatedEvery", { seconds: 3 }) : tr(language, "updatedEvery", { seconds: 15 }) : live.syncMode === "manual" ? tr(language, "refreshOnDemand") : tr(language, "nativeAppRequired")}`}</p></div><div className="head-actions"><Button variant="outline" size="sm" title={tr(language, "reloadLiveData")} onClick={live.reload} disabled={live.loading}><RefreshCw className={cn(live.loading && "spin")} size={13} />{t(language, "refresh")}</Button><Button size="sm" disabled={!canCreate} onClick={() => onCreate(live.descriptor)}><Plus size={13} />{t(language, "create")}</Button></div></div>
    <div className="resource-list-block">
      <div ref={toolbarRef} className={cn("table-toolbar", toolbarPinned && "pinned")}>{!clusterScoped && <NamespaceMultiCombobox className="table-namespace-combobox" language={language} values={selectedNamespaces} namespaces={namespaces} onChange={setSelectedNamespaces} />}<TableSearchField value={query} onChange={setQuery} handleRef={searchHandleRef} ariaLabel={`${t(language, "searchResources")} ${resourceLabel(language, resource)}`} placeholder={`${t(language, "searchResources")} ${resourceLabel(language, resource)}`} clearLabel={tr(language, "clear")} /><div className="toolbar-spacer" /><BulkResourceToolbar actions={bulkActions} /></div>
      <div className="resource-table-panel"><VirtualResourceTable rows={filtered} columns={columns} tableKey={`resource:${resource}`} selectedKeys={bulkActions.enabled ? bulkActions.selectedKeys : undefined} onSelectionChange={bulkActions.enabled ? bulkActions.setSelectedKeys : undefined} headerAction={<ColumnPicker resource={resource} language={language} defs={defs} isVisible={isVisible} onToggle={setColumnVisible} onReset={reset} />} renderAction={(item) => <Button variant="ghost" size="icon" aria-label={tr(language, "rowActions")} onClick={(event) => rowMenu(event, item)}><MoreHorizontal size={14} /></Button>} onRowClick={onSelect} onRowContextMenu={rowMenu} empty={!live.loading ? <div className="empty-state"><strong>{live.error ? tr(language, "resourceApiUnavailable") : tr(language, "noResourcesFound")}</strong><span>{live.error || tr(language, "tryAnotherNamespace")}</span></div> : undefined} /></div>
    </div>
  </div><BulkResourceActionDialog actions={bulkActions} /></>;
}


function CrdBrowser({ clusterId, discovered, namespaces, revision, selectedDefinitionName, selectedNamespaces, setSelectedNamespaces, language, onKindSelect, onBack, onInstance, onCreate, onOpenLink }: {
  clusterId: string; discovered: ApiResourceDescriptor[]; namespaces: string[]; revision: number; selectedDefinitionName: string | null; selectedNamespaces: string[];
  setSelectedNamespaces: (value: string[]) => void; language: AppLanguage; onKindSelect: (crd: CustomResourceDefinition) => void; onBack: () => void;
  onInstance: (row: ResourceRow) => void; onCreate: (descriptor?: ApiResourceDescriptor | null) => void; onOpenLink: (link: ResourceLink, row: ResourceRow) => void;
}) {
  const [query, setQuery] = useState("");
  const searchHandleRef = useRef<TableSearchHandle | null>(null);
  const focusSearch = useTableSearchFocus(searchHandleRef);
  useResourceListFindShortcut(focusSearch);
  const instanceToolbarRef = useRef<HTMLDivElement>(null);
  const instanceToolbarPinned = useToolbarPinned(instanceToolbarRef);
  const crdToolbarRef = useRef<HTMLDivElement>(null);
  const crdToolbarPinned = useToolbarPinned(crdToolbarRef);
  const crdDescriptor = descriptorForResource("Custom Resource Definitions", discovered)!;
  const crdLive = useResourceRows(clusterId, "Custom Resource Definitions", "All namespaces", discovered, revision, crdDescriptor);
  const liveDefinitions = crdLive.rows.map((row) => row.backend ? crdDefinitionFromRecord(row.backend) : null).filter(Boolean) as Array<ReturnType<typeof crdDefinitionFromRecord>>;
  const definition = liveDefinitions.find((item) => item.name === selectedDefinitionName);
  const printerColumns = definition && "printerColumns" in definition ? definition.printerColumns.filter((column) => !["Name", "Namespace", "Status", "Age"].includes(column.name)) : [];
  const dynamicDescriptor = definition && "descriptor" in definition ? definition.descriptor : definition ? {
    apiVersion: `${definition.group}/${definition.version}`, group: definition.group, version: definition.version, kind: definition.kind,
    plural: definition.plural ?? `${definition.kind.toLowerCase()}s`, namespaced: definition.scope === "Namespaced", verbs: ["get", "list", "watch", "create", "patch", "delete"], categories: [],
  } : crdDescriptor;
  const apiNamespace = apiNamespaceFilter(selectedNamespaces) ?? "All namespaces";
  const namespaceKey = selectedNamespaces.length === 0 ? "All namespaces" : selectedNamespaces.slice().sort().join(",");
  const instances = useResourceRows(clusterId, `Custom Resource ${definition?.group ?? "unknown"}/${definition?.kind ?? "Definitions"}`, apiNamespace, discovered, revision, dynamicDescriptor);
  const deferredQuery = useDeferredValue(query);
  const instanceFiltered = useMemo(() => instances.rows.filter((row) => {
    const namespaceOk = definition?.scope !== "Namespaced" || matchesNamespaceFilter(row.namespace, selectedNamespaces);
    return namespaceOk && row.name.toLowerCase().includes(deferredQuery.toLowerCase());
  }), [instances.rows, selectedNamespaces, deferredQuery, definition?.scope]);
  const instanceColumns = useVisibleColumns("Custom Resource");
  const instanceTableColumns = useMemo<Array<VirtualTableColumn<ResourceRow>>>(() => [
    ...instanceColumns.visible.map((column) => ({ id: column.id, label: column.label, render: (item: ResourceRow) => renderResourceCell(column.id, item, onOpenLink, language) })),
    ...printerColumns.map((column) => ({ id: column.jsonPath, label: column.name, render: (item: ResourceRow) => item.backend ? valueFromJsonPath(item.backend.object, column.jsonPath) : "—", sortValue: (item: ResourceRow) => item.backend ? valueFromJsonPath(item.backend.object, column.jsonPath) : undefined })),
  ], [instanceColumns.visible, printerColumns, onOpenLink]);
  const crdColumns = useVisibleColumns("Custom Resource Definitions");
  const liveDefinitionByName = useMemo(() => new Map(liveDefinitions.map((item) => [item.name, item])), [liveDefinitions]);
  const crdTableColumns = useMemo<Array<VirtualTableColumn<ResourceRow>>>(() => crdColumns.visible.map((column) => ({ id: column.id, label: column.label, render: (row) => renderResourceCell(column.id, row, undefined, language) })), [crdColumns.visible, language]);
  const instanceBulkActions = useBulkResourceActions({
    clusterId,
    rows: instanceFiltered,
    descriptor: dynamicDescriptor,
    selectionKey: `${clusterId}|custom-resource:${definition?.kind ?? "none"}|${namespaceKey}|${query}`,
    canDelete: dynamicDescriptor.verbs.includes("delete"),
    canEvict: false,
    onCompleted: instances.reload,
  });
  const crdBulkActions = useBulkResourceActions({
    clusterId,
    rows: crdLive.rows,
    descriptor: crdDescriptor,
    selectionKey: `${clusterId}|resource:Custom Resource Definitions`,
    canDelete: crdDescriptor.verbs.includes("delete"),
    canEvict: false,
    onCompleted: crdLive.reload,
  });
  if (definition && selectedDefinitionName) {
    return <><div className="workspace-scroll"><div className="page-head"><div><div className="eyebrow">CUSTOM RESOURCE · {definition.group}</div><h1>{definition.kind}</h1><p>{instances.error || `${definition.name} · ${definition.scope} · ${instanceFiltered.length} resources`}</p></div><div className="head-actions"><Button variant="outline" size="sm" onClick={onBack}>All CRDs</Button><Button size="sm" disabled={!dynamicDescriptor.verbs.includes("create")} onClick={() => onCreate(dynamicDescriptor)}><Plus size={13} />Create</Button></div></div><div className="resource-list-block"><div ref={instanceToolbarRef} className={cn("table-toolbar", instanceToolbarPinned && "pinned")}>{definition.scope === "Namespaced" && <NamespaceMultiCombobox className="table-namespace-combobox" language={language} values={selectedNamespaces} namespaces={namespaces} onChange={setSelectedNamespaces} />}<TableSearchField value={query} onChange={setQuery} handleRef={searchHandleRef} ariaLabel={`${t(language, "searchResources")} ${definition.kind}`} placeholder={`${t(language, "searchResources")} ${definition.kind}`} clearLabel={tr(language, "clear")} /><span>{instances.loading ? "Loading…" : `${instanceFiltered.length} resources`}</span><div className="toolbar-spacer" /><BulkResourceToolbar actions={instanceBulkActions} /></div><div className="resource-table-panel"><VirtualResourceTable rows={instanceFiltered} columns={instanceTableColumns} tableKey={`custom-resource:${definition.kind}`} selectedKeys={instanceBulkActions.enabled ? instanceBulkActions.selectedKeys : undefined} onSelectionChange={instanceBulkActions.enabled ? instanceBulkActions.setSelectedKeys : undefined} headerAction={<ColumnPicker resource="Custom Resource" language={language} defs={instanceColumns.defs} isVisible={instanceColumns.isVisible} onToggle={instanceColumns.setColumnVisible} onReset={instanceColumns.reset} />} renderAction={() => <ChevronRight size={14} />} onRowClick={onInstance} empty={!instances.loading ? <div className="empty-state"><strong>No resources found</strong><span>{instances.error || "Try another namespace or search query"}</span></div> : undefined} /></div></div></div><BulkResourceActionDialog actions={instanceBulkActions} /></>;
  }
  return <><div className="workspace-scroll"><div className="page-head"><div><div className="eyebrow">API EXTENSIONS</div><h1>Custom Resource Definitions</h1><p>{crdLive.error || `${liveDefinitions.length} definitions discovered in this cluster`}</p></div><Button size="sm" disabled={!crdDescriptor.verbs.includes("create")} onClick={() => onCreate(crdDescriptor)}><Plus size={13} />Create CRD</Button></div><div className="resource-list-block"><div ref={crdToolbarRef} className={cn("table-toolbar crd-bulk-toolbar", crdToolbarPinned && "pinned")}><span>{crdLive.rows.length} definitions</span><div className="toolbar-spacer" /><BulkResourceToolbar actions={crdBulkActions} /></div><div className="resource-table-panel standalone"><VirtualResourceTable className="standalone" rows={crdLive.rows} columns={crdTableColumns} tableKey="resource:Custom Resource Definitions" selectedKeys={crdBulkActions.enabled ? crdBulkActions.selectedKeys : undefined} onSelectionChange={crdBulkActions.enabled ? crdBulkActions.setSelectedKeys : undefined} headerAction={<ColumnPicker resource="Custom Resource Definitions" language={language} defs={crdColumns.defs} isVisible={crdColumns.isVisible} onToggle={crdColumns.setColumnVisible} onReset={crdColumns.reset} />} renderAction={(row) => { const source = liveDefinitionByName.get(row.name); return source ? <Button variant="ghost" size="icon" aria-label={`Open ${source.kind} instances`} onClick={() => onKindSelect(source)}><ChevronRight size={14} /></Button> : null; }} onRowClick={onInstance} empty={!crdLive.loading ? <div className="empty-state"><strong>No definitions found</strong><span>{crdLive.error || "This cluster did not return any CRDs"}</span></div> : undefined} /></div></div></div><BulkResourceActionDialog actions={crdBulkActions} /></>;
}

function portNumber(value: unknown): number | null {
  const port = typeof value === "number" ? value : Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function parseDeclaredPorts(value: unknown, prefix: string): ForwardablePort[] {
  if (typeof value !== "string") return [];
  return value.split(",").flatMap((entry, index) => {
    const match = entry.trim().match(/^(\d+)(?::\d+)?\/(TCP|UDP|SCTP)$/i);
    const port = portNumber(match?.[1]);
    if (!port) return [];
    const protocol = (match?.[2] ?? "TCP").toUpperCase();
    return [{ port, protocol, label: `${prefix} ${port}`, forwardable: protocol === "TCP", target: entry.trim(), container: `${index + 1}` }];
  });
}

function forwardablePortsFor(row: ResourceRow): ForwardablePort[] {
  const spec = row.backend?.object.spec as {
    containers?: Array<{ name?: string; ports?: Array<{ name?: string; containerPort?: number; protocol?: string }> }>;
    ports?: Array<{ name?: string; port?: number; targetPort?: string | number; protocol?: string }>;
  } | undefined;
  if (row.kind === "Pod") {
    const declared = (spec?.containers ?? []).flatMap((container) => (container.ports ?? []).flatMap((entry) => {
      const port = portNumber(entry.containerPort);
      if (!port) return [];
      const protocol = (entry.protocol ?? "TCP").toUpperCase();
      const name = entry.name ? ` · ${entry.name}` : "";
      return [{ port, protocol, label: `${container.name ?? "container"} · ${port}/${protocol}${name}`, container: container.name, name: entry.name, forwardable: protocol === "TCP" }];
    }));
    if (declared.length) return declared;
    const adaptedContainers = (row.containers ?? []).flatMap((container) => parseDeclaredPorts(container.port, container.name).map((entry) => ({ ...entry, label: `${container.name} · ${entry.port}/${entry.protocol}` })));
    return adaptedContainers.length ? adaptedContainers : parseDeclaredPorts(row.data.ports, "Container port");
  }
  if (row.kind === "Service") {
    const declared = (spec?.ports ?? []).flatMap((entry) => {
      const port = portNumber(entry.port);
      if (!port) return [];
      const protocol = (entry.protocol ?? "TCP").toUpperCase();
      const name = entry.name ? ` · ${entry.name}` : "";
      const target = entry.targetPort === undefined ? String(port) : String(entry.targetPort);
      return [{ port, protocol, label: `${port}/${protocol}${name} → ${target}`, target, name: entry.name, forwardable: protocol === "TCP" }];
    });
    return declared.length ? declared : parseDeclaredPorts(row.data.ports, "Service port");
  }
  return [];
}

function portForwardMatches(session: PortForwardSession, row: ResourceRow, port: number): boolean {
  const targetKind = row.kind === "Service" ? "service" : "pod";
  return session.targetKind === targetKind
    && session.targetName === row.name
    && session.namespace === row.namespace
    && (targetKind === "service" ? session.servicePort === port : session.remotePort === port);
}

function portForwardAddress(session: PortForwardSession): string {
  const browserHost = session.host === "0.0.0.0" ? "localhost" : session.host;
  return `${session.protocol}://${browserHost}:${session.localPort}`;
}

function PortForwardDialog({ state, busy, error, language, onClose, onConfirm }: { state: PortForwardDialogState; busy: boolean; error: string; language: AppLanguage; onClose: () => void; onConfirm: (options: { remotePort: number; localPort: number; host: "localhost" | "0.0.0.0"; protocol: "http" | "https"; openBrowser: boolean }) => void }) {
  const [selectedPort, setSelectedPort] = useState(state.selectedPort);
  const [localPort, setLocalPort] = useState("");
  const [host, setHost] = useState<"localhost" | "0.0.0.0">("localhost");
  const [https, setHttps] = useState(false);
  const [openBrowser, setOpenBrowser] = useState(true);
  const [validationError, setValidationError] = useState("");
  useEffect(() => {
    setSelectedPort(state.selectedPort); setLocalPort(""); setHost("localhost"); setHttps(false); setOpenBrowser(true); setValidationError("");
  }, [state]);
  const selectablePorts = state.ports.filter((entry) => entry.forwardable);
  const selected = selectablePorts.find((entry) => entry.port === selectedPort) ?? selectablePorts[0];
  const submit = () => {
    if (!selected || !selected.forwardable) { setValidationError(tr(language, "noPodTcpPorts")); return; }
    const normalized = localPort.trim();
    const local = normalized === "" ? 0 : Number(normalized);
    if (normalized !== "" && (!Number.isInteger(local) || local < 1 || local > 65535)) { setValidationError(tr(language, "localPortHint")); return; }
    setValidationError("");
    onConfirm({ remotePort: selected.port, localPort: local, host, protocol: https ? "https" : "http", openBrowser });
  };
  const kind = state.row.kind === "Service" ? "Service" : "Pod";
  return <div className="modal-backdrop panel-dialog-backdrop port-forward-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="port-forward-dialog" role="dialog" aria-modal="true" aria-labelledby="port-forward-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><h2 id="port-forward-dialog-title">{tr(language, "forwardPort", { kind })}</h2><div /><Button variant="ghost" size="icon" disabled={busy} aria-label={tr(language, "close")} onClick={onClose}><X size={14} /></Button></header>
      <div className="port-forward-body">
        <div className="port-forward-target"><Network size={17} /><div><strong>{kind}/{state.row.name}</strong><small>{tr(language, "namespace")} · {state.row.namespace}</small></div></div>
        <div className="port-forward-field"><span>{state.showPortSelect ? tr(language, "ports") : tr(language, "portForward")}</span>{state.showPortSelect ? <Combobox className="port-forward-combobox" ariaLabel={tr(language, "ports")} searchable={false} value={String(selected?.port ?? "")} options={selectablePorts.map((entry) => ({ value: String(entry.port), label: entry.label, description: `${entry.protocol} port` }))} onChange={(value) => setSelectedPort(Number(value))} /> : <strong>{selected?.label ?? tr(language, "unavailable")}</strong>}</div>
        <div className="port-forward-field-grid"><label className="port-forward-field"><span>{tr(language, "localPort")}</span><input aria-label={tr(language, "localPort")} type="number" min={1} max={65535} step={1} inputMode="numeric" placeholder={tr(language, "automatic")} value={localPort} onChange={(event) => setLocalPort(event.target.value)} /><small>{tr(language, "localPortHint")}</small></label><div className="port-forward-field"><span>{tr(language, "host")}</span><Combobox className="port-forward-combobox" ariaLabel={tr(language, "host")} language={language} searchable={false} value={host} options={[{ value: "localhost", label: "localhost", description: tr(language, "onlyThisComputer") }, { value: "0.0.0.0", label: "0.0.0.0", description: tr(language, "allNetworkInterfaces") }]} onChange={(value) => setHost(value as "localhost" | "0.0.0.0")} /><small>{tr(language, "lanAccessHint")}</small></div></div>
        <div className="port-forward-options"><label><input aria-label={tr(language, "useHttps")} type="checkbox" checked={https} onChange={(event) => setHttps(event.target.checked)} />{tr(language, "useHttps")}</label><label><input aria-label={tr(language, "openInBrowserLabel")} type="checkbox" checked={openBrowser} onChange={(event) => setOpenBrowser(event.target.checked)} />{tr(language, "openInBrowserLabel")}</label></div>
        {(validationError || error) && <div className="port-forward-error" role="alert"><AlertTriangle size={13} />{validationError || error}</div>}
      </div>
      <footer><span>{selected ? `${selected.protocol} · ${selected.port}` : tr(language, "unavailable")}</span><div /><Button variant="outline" size="sm" disabled={busy} onClick={onClose}>{tr(language, "cancel")}</Button><Button size="sm" disabled={busy || !selected?.forwardable} onClick={submit}>{busy && <LoaderCircle className="spin" size={13} />}{busy ? tr(language, "working") : tr(language, "forward")}</Button></footer>
    </section>
  </div>;
}

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
  const headerActions: Array<{ label: string; icon: typeof Play; mode?: BottomRequest["mode"] }> = tab.type === "related" || actionKind === "PortForward"
    ? []
    : actionKind === "Pod"
      ? [...editAction, { label: "Terminal", icon: SquareTerminal, mode: "terminal" }, { label: "Logs", icon: ScrollText, mode: "logs" }, ...fileAction, { label: "Evict", icon: LogOut }, ...deleteAction]
      : actionKind === "DaemonSet"
        ? [...editAction, { label: "Logs", icon: ScrollText, mode: "logs" }, ...fileAction, { label: "Restart", icon: RefreshCw }, ...deleteAction]
        : actionKind === "CronJob"
          ? [...editAction, ...deleteAction]
          : actionKind === "StatefulSet"
            ? [...editAction, { label: "Terminal", icon: SquareTerminal, mode: "terminal" }, { label: "Logs", icon: ScrollText, mode: "logs" }, ...fileAction, { label: "Scale", icon: Scaling }, ...deleteAction]
            : actionKind === "Deployment"
              ? [...editAction, { label: "Terminal", icon: SquareTerminal, mode: "terminal" }, { label: "Logs", icon: ScrollText, mode: "logs" }, ...fileAction, { label: "Scale", icon: Scaling }, { label: "Restart", icon: RefreshCw }, ...deleteAction]
              : actionKind === "Node"
                ? [...editAction, { label: "Terminal", icon: SquareTerminal, mode: "terminal" }, { label: "Files", icon: FolderOpen, mode: "files" }, { label: nodeCordoned ? "Uncordon" : "Cordon", icon: nodeCordoned ? Play : Pause }, { label: "Drain", icon: Droplets }, { label: "Taints", icon: PaintBucket }, ...deleteAction]
                : [...editAction, ...deleteAction];
  const actionLabel = (action: string) => action === "Edit" ? tr(language, "edit") : action === "Delete" ? tr(language, "delete") : action === "Files" ? (actionKind === "Node" ? tr(language, "nodeFiles") : tr(language, "files")) : action === "Terminal" ? tr(language, "terminal") : action === "Logs" ? tr(language, "logs") : action === "Evict" ? tr(language, "evict") : action === "Scale" ? tr(language, "scale") : action === "Restart" ? tr(language, "restartRollout") : action === "Cordon" ? tr(language, "cordon") : action === "Uncordon" ? tr(language, "uncordon") : action === "Drain" ? tr(language, "drain") : action === "Taints" ? tr(language, "taints") : action;
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
  const detailSections = tab.row ? buildResourceDetailSections(tab.row) : [];
  const containerSection = tab.row ? getContainerDetailSection(tab.row) : null;
  const conditions = getResourceConditions(tab.row);
  const eventGroup = (tab.relations ?? []).find((group) => group.id === "events");
  const portRows = tab.row && ["Pod", "Service"].includes(tab.row.kind) ? forwardablePortsFor(tab.row) : [];
  const portForwardSession = actionKind === "PortForward" ? portForwardSessions.find((session) => session.id === tab.row?.key) : undefined;
  const portForwardPaused = portForwardSession?.status === "Paused";
  const displayStatus = portForwardSession?.status ?? status;
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
    <div className="drawer-head detail-sheet-header"><div className="resource-kind">{tab.type === "crd" ? "CR" : kindLabel.slice(0, 2).toUpperCase()}</div><div className="sheet-title-stack"><small>{kindLabel}</small><h2>{tab.label}</h2></div><div className="detail-header-actions">{portForwardSession && <>{!portForwardPaused && <Button variant="ghost" size="icon" aria-label={tr(language, "openInBrowser")} title={tr(language, "openInBrowser")} onClick={() => onOpenPortForward(portForwardSession)}><ExternalLink size={13} /></Button>}<Button variant="ghost" size="icon" aria-label={portForwardPaused ? tr(language, "resumeForwarding") : tr(language, "pauseForwarding")} title={portForwardPaused ? tr(language, "resumeForwarding") : tr(language, "pauseForwarding")} onClick={() => { if (portForwardPaused) onResumePortForward(portForwardSession); else onPausePortForward(portForwardSession); }}>{portForwardPaused ? <Play size={12} /> : <Pause size={12} />}</Button><Button variant="ghost" size="icon" className="hover-destructive" aria-label={tr(language, "stopPortForwarding")} title={tr(language, "stopForwarding")} onClick={() => { void onStopPortForward(portForwardSession).then((stopped) => { if (stopped) onClose(); }); }}><Trash2 size={13} /></Button></>}{headerActions.map(({ label, icon: Icon }, index) => <Button key={label} variant="ghost" size="icon" className={cn(index >= 2 && "detail-header-secondary", label === "Delete" && "hover-destructive", label === "Evict" && "hover-warning")} aria-label={actionLabel(label)} title={actionLabel(label)} onClick={() => onAction(label)}><Icon size={13} /></Button>)}{overflowHeaderActions.length > 0 && <Button variant="ghost" size="icon" className="detail-header-overflow" aria-label={t(language, "actions")} title={t(language, "actions")} aria-haspopup="menu" onClick={(event) => openContextMenu(event, overflowHeaderActions.map(({ label, icon: Icon }) => ({ type: "item" as const, id: `detail-${label.toLowerCase()}`, label: actionLabel(label), icon: Icon, hoverDestructive: label === "Delete", hoverWarning: label === "Evict", onSelect: () => onAction(label) })))}><MoreHorizontal size={14} /></Button>}</div><Button variant="ghost" size="icon" aria-label={tr(language, "close")} onClick={onClose}><X size={14} /></Button></div>
    <div className={cn("drawer-body", related ? "detail-drawer-legacy" : "detail-drawer-sections")}>
      {related ? <><div className="detail-status"><StatusDot status={displayStatus} /><div><strong>{displayStatus}</strong><span>Reverse link · {related.relation}</span></div><Badge tone={statusTone(displayStatus)}>{related.relation}</Badge></div><h3>{tr(language, "resources")}</h3><dl>{(related.meta ?? []).map((entry) => <div key={entry.label}><dt>{entry.label}</dt><dd>{entry.value}</dd></div>)}{related.from && <div><dt>Opened from</dt><dd>{related.from}</dd></div>}</dl>{tab.error && <div className="related-empty">{tab.error}</div>}</> : tab.row ? <>
        {tab.error && <div className="detail-load-error"><AlertTriangle size={13} /><span>{tab.error}</span></div>}
        {podSheet ? <>
          {(tab.metrics || tab.metricsLoading) && <PodMetricsSection metrics={tab.metrics} active={metricKind} range={metricRange} loading={tab.metricsLoading} onMetric={setMetricKind} onRange={(range) => { setMetricRange(range); onMetricsRange(tab.row!, range); }} />}
          <PropertiesSection row={tab.row} relations={tab.relations} onOpenResource={openLink} onCopy={onCopy} />
          <ContainerConfigurationSection row={tab.row} section={containerSection} sessions={portForwardSessions} onOpenResource={openLink} onCopy={onCopy} onPortForward={onPortForward} onOpenPortForward={onOpenPortForward} onPausePortForward={onPausePortForward} onResumePortForward={onResumePortForward} onStopPortForward={onStopPortForward} />
          <StatusSection row={tab.row} conditions={conditions} fallbackStatus={displayStatus} eventGroup={eventGroup} onOpenResource={onOpenResource} onCopy={onCopy} />
        </> : <>
          <PropertiesSection row={tab.row} relations={tab.relations} onOpenResource={openLink} onCopy={onCopy} />
          {renderDetailSections()}
          <ContainerConfigurationSection row={tab.row} section={containerSection} sessions={portForwardSessions} onOpenResource={openLink} onCopy={onCopy} onPortForward={onPortForward} onOpenPortForward={onOpenPortForward} onPausePortForward={onPausePortForward} onResumePortForward={onResumePortForward} onStopPortForward={onStopPortForward} />
          <ResourceDataSection row={tab.row} onCopy={onCopy} />
          {tab.row.kind === "Service" && <ServicePortsSection row={tab.row} ports={portRows.map((port) => ({ port: port.port, protocol: port.protocol, name: port.name, target: port.target, forwardable: port.forwardable }))} sessions={portForwardSessions} onCopy={onCopy} onPortForward={onPortForward} onOpenPortForward={onOpenPortForward} onPausePortForward={onPausePortForward} onResumePortForward={onResumePortForward} onStopPortForward={onStopPortForward} />}
          <RelationLoadingNotice loading={tab.relationsLoading} error={tab.relationsError} />
          <StatusSection row={tab.row} conditions={conditions} fallbackStatus={displayStatus} eventGroup={eventGroup} onOpenResource={onOpenResource} onCopy={onCopy} />
        </>}
      </> : <div className="detail-container-empty">Resource details are unavailable.</div>}
    </div>
  </aside>;

}

function cleanTerminalOutput(value: string) {
  return value
    .replace(/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "")
    .replace(/\r/g, "");
}

function podContainers(record?: BackendResourceRecord | null, type: "init" | "regular" = "regular") {
  const spec = record?.object.spec as { initContainers?: Array<{ name?: string }>; containers?: Array<{ name?: string }> } | undefined;
  return (type === "init" ? spec?.initContainers : spec?.containers ?? [])
    ?.map((container) => container.name?.trim() ?? "")
    .filter(Boolean) ?? [];
}

function allPodContainers(target?: PodSessionTarget) {
  return target ? [...target.containers, ...target.initContainers] : [];
}

function podIsReady(record: BackendResourceRecord) {
  const statuses = (record.object.status as { containerStatuses?: Array<{ ready?: boolean }> } | undefined)?.containerStatuses ?? [];
  return statuses.length > 0 && statuses.every((status) => status.ready);
}

function podTargetFromRecord(record: BackendResourceRecord): PodSessionTarget {
  return {
    key: `${record.namespace}/${record.name}`,
    namespace: record.namespace,
    pod: record.name,
    phase: String((record.object.status as { phase?: string } | undefined)?.phase ?? "Unknown"),
    ready: podIsReady(record),
    initContainers: podContainers(record, "init"),
    containers: podContainers(record),
  };
}


async function listPodTargets(clusterId: string, item?: DetailItem): Promise<PodSessionTarget[]> {
  if (!nativeBackendAvailable) return [];
  const descriptor = descriptorForResource("Pods", [])!;
  const namespace = item?.subtitle && item.subtitle !== "—" ? item.subtitle : undefined;
  const directPod = item?.row?.kind === "Pod";
  const labels = (item?.row?.backend?.object.spec as { selector?: { matchLabels?: Record<string, string> } } | undefined)?.selector?.matchLabels;
  const labelSelector = !directPod && labels ? Object.entries(labels).map(([key, value]) => `${key}=${value}`).join(",") : undefined;
  const fieldSelector = directPod ? `metadata.name=${item.row?.name}` : undefined;
  const response = await backend.listResources({ clusterId, resource: descriptor, namespace, labelSelector, fieldSelector });
  return response.items
    .map(podTargetFromRecord)
    .sort((left, right) => Number(right.phase === "Running") - Number(left.phase === "Running") || Number(right.ready) - Number(left.ready) || left.pod.localeCompare(right.pod));
}

// How long the content-zoom control lingers after the text size returns to
// 100% before it fades away, so the user still sees the confirmed reset.
const CONTENT_ZOOM_HIDE_DELAY_MS = 5_000;
// Sustained trackpad streams are capped to one 5% text-size step per interval.
// A normal mouse notch still applies immediately, while fling bursts are dropped
// instead of being replayed after the gesture ends.
const CONTENT_ZOOM_STEP_INTERVAL_MS = 80;
// WKWebView can drop Command flags from later notches and emit a false Meta
// keyup after the first event. Keep a macOS Command gesture armed across the
// whole held-scroll stream; a genuine release ends it immediately (see
// onModifierKeyUp), and this idle timeout only guards keyups we cannot verify.
const CONTENT_ZOOM_MAC_ARM_IDLE_MS = 1_000;

function BottomActionSheet({ clusterId, sessions, activeId, collapsed, searchOpen, onSearchOpenChange, language, appTheme, contentTheme, contentFont, contentFontSize, contentZoom, onContentZoom, terminalRuntimes, sessionCaches, onUpdateTerminalRuntimes, onUpdateSessionCaches, onActivate, onCloseSession, onCloseOthers, onCloseAll, onCreateSession, onToggleCollapsed, onApplied, onToast }: {
  clusterId: string;
  sessions: BottomSession[];
  activeId: string;
  collapsed: boolean;
  searchOpen: boolean;
  onSearchOpenChange: (open: boolean) => void;
  language: AppLanguage;
  appTheme: "light" | "dark";
  contentTheme: "light" | "dark";
  contentFont: string;
  contentFontSize: number;
  contentZoom: number;
  onContentZoom: (next: number) => void;
  terminalRuntimes: TerminalRuntimeMap;
  sessionCaches: BottomSessionCacheMap;
  onUpdateTerminalRuntimes: RuntimeMapUpdater<TerminalRuntimeMap>;
  onUpdateSessionCaches: RuntimeMapUpdater<BottomSessionCacheMap>;
  onActivate: (id: string) => void;
  onCloseSession: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onCloseAll: () => void;
  onCreateSession: (request: BottomRequest) => void;
  onToggleCollapsed: () => void;
  onApplied: () => void;
  onToast: (tone: AppToast["tone"], message: string, filePath?: string) => void;
}) {
  const state = sessions.find((session) => session.id === activeId) ?? sessions[0];
  const nodeTerminal = state?.mode === "terminal" && (state.terminalTarget === "node" || (state.terminalTarget === undefined && (state.item?.row?.kind === "Node" || state.item?.kind === "Node")));
  const containerTerminal = state?.mode === "terminal" && !nodeTerminal && (state.terminalTarget === "container" || (state.terminalTarget === undefined && Boolean(state.item)));
  const fileExplorer = state?.mode === "files";
  const nodeFiles = fileExplorer && state?.terminalTarget === "node";
  const nodeName = state?.item?.row?.name || state?.item?.label || state?.label || "";
  const [height, setHeight] = useState(() => {
    const maximum = Math.max(220, window.innerHeight - 220);
    return Math.max(220, Math.min(maximum, Number(localStorage.getItem("kubehive.sessionHeight")) || 450));
  });
  const [maximized, setMaximized] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [podTargets, setPodTargets] = useState<PodSessionTarget[]>([]);
  const [targetsLoading, setTargetsLoading] = useState(false);
  const [targetError, setTargetError] = useState("");
  const [nodeFileSessionError, setNodeFileSessionError] = useState<{ key: string; message: string } | null>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const tabListRef = useHorizontalTabRail();
  const terminalRuntimesRef = useRef<TerminalRuntimeMap>(terminalRuntimes);
  const sessionCachesRef = useRef<BottomSessionCacheMap>(sessionCaches);
  const nodeFileStartRef = useRef<Set<string>>(new Set());
  const nodeFileSessionKey = nodeFiles && state ? `${clusterId}::${state.id}` : "";
  const nodeFileTarget = nodeFileSessionKey ? sessionCachesRef.current[nodeFileSessionKey]?.nodeFileTarget : undefined;
  const nodeFileSessionFailure = nodeFileSessionError?.key === nodeFileSessionKey ? nodeFileSessionError.message : "";
  const nodeFileTargetLoading = Boolean(nodeFileSessionKey && nodeName && !nodeFileTarget && !nodeFileSessionFailure);
  const targetsReadySessionRef = useRef("");
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  const [contentZoomActive, setContentZoomActive] = useState(false);
  const [contentZoomLinger, setContentZoomLinger] = useState(false);
  const contentZoomRef = useRef(contentZoom);
  const contentWheelRemainderRef = useRef(0);
  const contentZoomFrameRef = useRef<number | undefined>(undefined);
  const contentZoomSettleTimerRef = useRef<number | undefined>(undefined);
  const contentZoomLingerTimerRef = useRef<number | undefined>(undefined);
  const contentZoomLastStepAtRef = useRef(Number.NEGATIVE_INFINITY);
  const contentZoomRateTimerRef = useRef<number | undefined>(undefined);
  const contentZoomMacArmTimerRef = useRef<number | undefined>(undefined);
  const contentZoomPendingDirectionRef = useRef<-1 | 0 | 1>(0);
  const contentZoomHeldModifiersRef = useRef({ metaKey: false, ctrlKey: false, macCommandArmed: false });
  terminalRuntimesRef.current = terminalRuntimes;
  sessionCachesRef.current = sessionCaches;
  contentZoomRef.current = contentZoom;
  const clearContentZoomLinger = () => {
    window.clearTimeout(contentZoomLingerTimerRef.current);
    contentZoomLingerTimerRef.current = undefined;
    setContentZoomLinger(false);
  };
  // Applies a new content zoom and manages the floating control's visibility.
  // Returning to 100% keeps the control on screen for a few seconds before it
  // fades; any further change (or a non-100% value) cancels that pending hide.
  const applyContentZoom = (next: number) => {
    contentZoomRef.current = next;
    onContentZoom(next);
    if (Math.round(next * 100) === 100) {
      if (contentZoomLingerTimerRef.current === undefined) {
        setContentZoomLinger(true);
        contentZoomLingerTimerRef.current = window.setTimeout(() => {
          contentZoomLingerTimerRef.current = undefined;
          setContentZoomLinger(false);
        }, CONTENT_ZOOM_HIDE_DELAY_MS);
      }
    } else {
      clearContentZoomLinger();
    }
  };
  // The wheel effect below is registered once and always calls the latest
  // applyContentZoom via this ref, so re-renders (e.g. a language change) never
  // tear down the listener or a pending linger timer mid-gesture.
  const applyContentZoomRef = useRef(applyContentZoom);
  applyContentZoomRef.current = applyContentZoom;
  // Cmd/Ctrl + wheel scales terminal/log/editor text with strict platform
  // isolation: Command on macOS, Control on Windows/Linux. Physical modifier
  // key state is tracked separately because WKWebView can mislabel a macOS
  // Command+wheel event as ctrlKey-only or release Meta early during a wheel
  // stream. Input units are normalized and queued through a one-step rate
  // limiter, allowing continuous scrolling without a large fling jump.
  useEffect(() => {
    const flush = () => {
      contentZoomFrameRef.current = undefined;
      applyContentZoomRef.current(contentZoomRef.current);
    };
    const scheduleFlush = () => {
      if (contentZoomFrameRef.current === undefined) contentZoomFrameRef.current = window.requestAnimationFrame(flush);
    };
    const clearPendingRateStep = () => {
      window.clearTimeout(contentZoomRateTimerRef.current);
      contentZoomRateTimerRef.current = undefined;
      contentZoomPendingDirectionRef.current = 0;
    };
    const flushPendingRateStep = () => {
      contentZoomRateTimerRef.current = undefined;
      const direction = contentZoomPendingDirectionRef.current;
      contentZoomPendingDirectionRef.current = 0;
      if (!direction) return;
      const next = settleContentZoomFactor(contentZoomRef.current + direction * 0.05);
      if (next === contentZoomRef.current) return;
      contentZoomRef.current = next;
      contentZoomLastStepAtRef.current = performance.now();
      scheduleFlush();
    };
    const queueRateLimitedStep = (direction: -1 | 1, delay: number) => {
      contentZoomPendingDirectionRef.current = direction;
      if (contentZoomRateTimerRef.current === undefined) {
        contentZoomRateTimerRef.current = window.setTimeout(flushPendingRateStep, Math.max(0, delay));
      }
    };
    const clearMacCommandArm = () => {
      window.clearTimeout(contentZoomMacArmTimerRef.current);
      contentZoomMacArmTimerRef.current = undefined;
      contentZoomHeldModifiersRef.current.macCommandArmed = false;
    };
    const refreshMacCommandArm = () => {
      contentZoomHeldModifiersRef.current.macCommandArmed = true;
      window.clearTimeout(contentZoomMacArmTimerRef.current);
      contentZoomMacArmTimerRef.current = window.setTimeout(clearMacCommandArm, CONTENT_ZOOM_MAC_ARM_IDLE_MS);
    };
    const settle = () => {
      contentZoomSettleTimerRef.current = undefined;
      if (contentZoomRateTimerRef.current !== undefined) {
        window.clearTimeout(contentZoomRateTimerRef.current);
        contentZoomRateTimerRef.current = undefined;
        const direction = contentZoomPendingDirectionRef.current;
        contentZoomPendingDirectionRef.current = 0;
        if (direction) contentZoomRef.current = settleContentZoomFactor(contentZoomRef.current + direction * 0.05);
      }
      if (contentZoomFrameRef.current !== undefined) { window.cancelAnimationFrame(contentZoomFrameRef.current); contentZoomFrameRef.current = undefined; }
      contentWheelRemainderRef.current = 0;
      applyContentZoomRef.current(settleContentZoomFactor(contentZoomRef.current));
      // Do not clear macCommandArmed here. WKWebView often drops Command flags
      // between notches; the arm idle timer owns gesture expiry instead.
      setContentZoomActive(false);
    };
    const onModifierKeyDown = (event: KeyboardEvent) => {
      const current = contentZoomHeldModifiersRef.current;
      const ctrlKey = event.ctrlKey || event.key === "Control";
      if (platform === "macos" && event.key === "Control") clearMacCommandArm();
      contentZoomHeldModifiersRef.current = {
        metaKey: event.metaKey || event.key === "Meta",
        ctrlKey,
        macCommandArmed: platform === "macos"
          ? event.key === "Control" ? false : event.key === "Meta" ? true : current.macCommandArmed
          : false,
      };
      if (platform === "macos" && event.key === "Meta") {
        window.clearTimeout(contentZoomMacArmTimerRef.current);
        contentZoomMacArmTimerRef.current = window.setTimeout(clearMacCommandArm, CONTENT_ZOOM_MAC_ARM_IDLE_MS);
      }
    };
    const onModifierKeyUp = (event: KeyboardEvent) => {
      const current = contentZoomHeldModifiersRef.current;
      // WKWebView emits a false Meta keyup after the first notch while Command
      // is still physically held, so a keyup alone must not end the arm. But
      // getModifierState reflects the live keyboard rather than the dropped
      // event flags, which distinguishes that false keyup from a genuine
      // release: the latter ends the gesture immediately instead of leaving
      // the arm live for the full idle window (a later plain wheel would zoom).
      const metaReallyUp = platform === "macos" && event.key === "Meta" && event.getModifierState?.("Meta") === false;
      if (metaReallyUp) clearMacCommandArm();
      contentZoomHeldModifiersRef.current = {
        metaKey: event.key === "Meta" ? false : event.metaKey,
        ctrlKey: event.key === "Control" ? false : event.ctrlKey,
        macCommandArmed: metaReallyUp ? false : current.macCommandArmed,
      };
    };
    const clearHeldModifiers = () => {
      window.clearTimeout(contentZoomMacArmTimerRef.current);
      contentZoomMacArmTimerRef.current = undefined;
      contentZoomHeldModifiersRef.current = { metaKey: false, ctrlKey: false, macCommandArmed: false };
    };
    const onWheel = (event: WheelEvent) => {
      const held = contentZoomHeldModifiersRef.current;
      // Prefer KeyboardEvent-tracked keys, then WheelEvent flags, then
      // getModifierState. WKWebView often drops metaKey after the first notch.
      const wheelMetaKey = event.metaKey || event.getModifierState?.("Meta") === true;
      const wheelCtrlKey = event.ctrlKey || event.getModifierState?.("Control") === true;
      if (!contentZoomModifierActive(platform, wheelMetaKey, wheelCtrlKey, held.metaKey, held.ctrlKey, held.macCommandArmed)) return;
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".terminal-output, .editor-layout, .manifest-editor, .cm-editor, .container-terminal, .file-text-editor")) return;
      event.preventDefault();
      event.stopPropagation();
      // Arm from the first accepted Command wheel itself. Meta keydown is not
      // reliable when focus is inside CodeMirror/xterm, so continuous notches
      // must not depend on a prior keydown event.
      if (platform === "macos" && !held.ctrlKey && (held.metaKey || wheelMetaKey || held.macCommandArmed)) {
        refreshMacCommandArm();
      }
      const legacyWheelDeltaY = (event as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
      const deltaY = normalizeContentWheelDelta(event.deltaY, event.deltaMode, window.innerHeight, legacyWheelDeltaY);
      if (!deltaY) return;
      setContentZoomActive(true);
      const result = nextContentZoomFactor(contentZoomRef.current, deltaY, contentWheelRemainderRef.current);
      const now = performance.now();
      if (result.factor !== contentZoomRef.current) {
        const elapsed = now - contentZoomLastStepAtRef.current;
        const direction = result.factor > contentZoomRef.current ? 1 : -1;
        if (elapsed < CONTENT_ZOOM_STEP_INTERVAL_MS) {
          // Keep one pending step so a sustained mouse-wheel stream continues at
          // the controlled rate instead of dropping every event after the first.
          contentWheelRemainderRef.current = 0;
          queueRateLimitedStep(direction, CONTENT_ZOOM_STEP_INTERVAL_MS - elapsed);
        } else {
          clearPendingRateStep();
          contentZoomLastStepAtRef.current = now;
          contentZoomRef.current = result.factor;
          contentWheelRemainderRef.current = result.remainder;
          scheduleFlush();
        }
      } else {
        contentWheelRemainderRef.current = result.remainder;
        scheduleFlush();
      }
      window.clearTimeout(contentZoomSettleTimerRef.current);
      contentZoomSettleTimerRef.current = window.setTimeout(settle, 180);
    };
    window.addEventListener("keydown", onModifierKeyDown, true);
    window.addEventListener("keyup", onModifierKeyUp, true);
    window.addEventListener("blur", clearHeldModifiers);
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => {
      window.removeEventListener("keydown", onModifierKeyDown, true);
      window.removeEventListener("keyup", onModifierKeyUp, true);
      window.removeEventListener("blur", clearHeldModifiers);
      window.removeEventListener("wheel", onWheel, { capture: true });
      window.clearTimeout(contentZoomSettleTimerRef.current);
      window.clearTimeout(contentZoomRateTimerRef.current);
      contentZoomRateTimerRef.current = undefined;
      contentZoomPendingDirectionRef.current = 0;
      window.clearTimeout(contentZoomMacArmTimerRef.current);
      contentZoomMacArmTimerRef.current = undefined;
      window.clearTimeout(contentZoomLingerTimerRef.current);
      contentZoomLingerTimerRef.current = undefined;
      if (contentZoomFrameRef.current !== undefined) window.cancelAnimationFrame(contentZoomFrameRef.current);
    };
  }, []);
  const contentZoomPercent = Math.round(contentZoom * 100);
  const zoomWidgetVisible = contentZoomActive || contentZoomLinger || contentZoomPercent !== 100;
  const scaledContentFontSize = Math.round(contentFontSize * contentZoom * 100) / 100;

  const fallbackManifest = state ? `apiVersion: ${state.descriptor?.apiVersion ?? "apps/v1"}\nkind: ${state.descriptor?.kind ?? "Deployment"}\nmetadata:\n  name: ${state.item?.label ?? "new-resource"}\n  namespace: ${state.item?.subtitle && state.item.subtitle !== "—" ? state.item.subtitle : "default"}\nspec:\n  replicas: 1` : "";
  const runtimeKey = state ? `${clusterId}::${state.id}` : "";
  const sessionCache = runtimeKey ? sessionCaches[runtimeKey] : undefined;
  const manifestText = sessionCache?.manifestText ?? state?.manifest ?? state?.item?.manifest ?? fallbackManifest;
  const manifestFormat = sessionCache?.manifestFormat ?? "yaml";
  const manifestValidation = useMemo(() => validateManifestText(manifestText, manifestFormat), [manifestText, manifestFormat]);
  const output = sessionCache?.output ?? "";
  const feedback = sessionCache?.feedback ?? "";
  const selectedPodKey = sessionCache?.selectedPodKey ?? "";
  const selectedContainer = sessionCache?.selectedContainer ?? "";
  const logTailLines = sessionCache?.logTailLines ?? 1000;
  const logPrevious = sessionCache?.logPrevious ?? false;
  const logFollow = sessionCache?.logFollow ?? true;
  const logTimestamps = sessionCache?.logTimestamps ?? true;
  const logWrapLines = sessionCache?.logWrapLines ?? true;
  const terminalReloadToken = sessionCache?.terminalReloadToken ?? 0;
  const patchSessionCache = (patch: Partial<BottomSessionCache>) => {
    if (!state) return;
    onUpdateSessionCaches((current) => ({ ...current, [runtimeKey]: { ...current[runtimeKey], ...patch } }));
  };
  const setManifestText = (value: string) => patchSessionCache({ manifestText: value, feedback: "" });
  const setOutput = (value: string) => patchSessionCache({ output: value });
  const setFeedback = (value: string) => patchSessionCache({ feedback: value });
  const setSelectedPodKey = (value: string) => patchSessionCache({ selectedPodKey: value });
  const setSelectedContainer = (value: string) => patchSessionCache({ selectedContainer: value });
  const setLogTailLines = (value: number) => patchSessionCache({ logTailLines: value });
  const setLogPrevious = (value: boolean) => patchSessionCache({ logPrevious: value });
  const setLogFollow = (value: boolean) => patchSessionCache({ logFollow: value });
  const setLogTimestamps = (value: boolean) => patchSessionCache({ logTimestamps: value });
  const setLogWrapLines = (value: boolean) => patchSessionCache({ logWrapLines: value });
  const activeTerminalRuntime = state?.mode === "terminal" ? terminalRuntimes[runtimeKey] : undefined;
  const terminalOutput = activeTerminalRuntime?.output ?? "";
  const terminalStatus = activeTerminalRuntime?.status ?? "idle";
  const terminalSessionId = activeTerminalRuntime?.sessionId ?? "";
  const textSearch = useTextSearch(state?.mode === "edit" || state?.mode === "create" ? manifestText : state?.mode === "terminal" ? cleanTerminalOutput(terminalOutput) : state?.mode === "logs" ? ansiToPlainText(output) : output);
  const dockRef = useRef<HTMLElement>(null);
  const resize = useRef<{ startY: number; startHeight: number; currentHeight: number } | null>(null);
  useEffect(() => localStorage.setItem("kubehive.sessionHeight", String(height)), [height]);
  useEffect(() => { const close = (event: MouseEvent) => { if (!addMenuRef.current?.contains(event.target as Node)) setAddMenuOpen(false); }; window.addEventListener("mousedown", close); return () => window.removeEventListener("mousedown", close); }, []);
  useEffect(() => {
    const move = (event: PointerEvent) => { if (!resize.current || !dockRef.current) return; const maximum = Math.max(220, window.innerHeight - 220); const next = Math.max(38, Math.min(maximum, resize.current.startHeight + resize.current.startY - event.clientY)); resize.current.currentHeight = next; dockRef.current.style.height = `${next}px`; };
    const stop = () => { if (!resize.current) return; const finalHeight = resize.current.currentHeight; resize.current = null; setHeight(finalHeight); document.body.classList.remove("resizing-session-sheet"); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop); window.addEventListener("pointercancel", stop);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); window.removeEventListener("pointercancel", stop); document.body.classList.remove("resizing-session-sheet"); };
  }, []);
  useEffect(() => {
    if (!state) return;
    onSearchOpenChange(false);
    textSearch.setQuery("");
  }, [state?.id]);
  const openSessionSearch = useCallback(() => {
    onSearchOpenChange(true);
    setSearchFocusRequest((value) => value + 1);
  }, [onSearchOpenChange]);
  // Capture-phase Cmd/Ctrl+F so logs (non-editable) and dock chrome still open
  // the shared find popover when focus or the event target lives in the sheet.
  useEffect(() => {
    if (collapsed || !state || state.mode === "files") return;
    const handler = (event: KeyboardEvent) => {
      if (!isFindShortcut(event)) return;
      if (!isSessionFindContext(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      openSessionSearch();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [collapsed, state?.mode, openSessionSearch]);
  useEffect(() => {
    if (!state || nodeFiles || (state.mode !== "logs" && !containerTerminal && state.mode !== "files")) return;
    let cancelled = false;
    targetsReadySessionRef.current = "";
    setTargetsLoading(true);
    setTargetError("");
    setPodTargets([]);
    void listPodTargets(clusterId, state.item).then((targets) => {
      if (cancelled) return;
      setPodTargets(targets);
      const saved = sessionCachesRef.current[`${clusterId}::${state.id}`];
      const runtime = containerTerminal ? terminalRuntimesRef.current[`${clusterId}::${state.id}`] : undefined;
      const first = targets.find((target) => target.key === saved?.selectedPodKey)
        ?? targets.find((target) => target.key === runtime?.podKey)
        ?? targets[0];
      const firstContainers = allPodContainers(first);
      const selected = [saved?.selectedContainer, runtime?.container].find((container) => container && firstContainers.includes(container)) ?? firstContainers[0] ?? "";
      setSelectedPodKey(first?.key ?? "");
      setSelectedContainer(selected);
      targetsReadySessionRef.current = state.id;
      if (!first) setTargetError("No matching pod is available for this session");
    }).catch((error) => {
      if (!cancelled) setTargetError(String(error));
    }).finally(() => {
      if (!cancelled) setTargetsLoading(false);
    });
    return () => { cancelled = true; };
  }, [clusterId, state?.id, state?.mode, containerTerminal, nodeFiles]);
  const selectedPod = podTargets.find((target) => target.key === selectedPodKey) ?? podTargets[0];
  // Node file sessions: resolve the shared helper Pod on the target Node once.
  // The resolved container target (hostRoot: true) is cached with the session
  // and released in disposeBottomSessions / disposeClusterSessions.
  useEffect(() => {
    if (!state || !nodeFiles || !nodeName) return;
    const cacheKey = `${clusterId}::${state.id}`;
    if (sessionCachesRef.current[cacheKey]?.nodeFileTarget || nodeFileStartRef.current.has(cacheKey) || nodeFileSessionError?.key === cacheKey) return;
    if (!nativeBackendAvailable) {
      setNodeFileSessionError({ key: cacheKey, message: tr(language, "nativeAppRequired") });
      return;
    }
    nodeFileStartRef.current.add(cacheKey);
    let cancelled = false;
    void backend.startNodeFileSession({ clusterId, node: nodeName }).then((target) => {
      if (cancelled) { void backend.stopNodeFileSession({ clusterId, node: nodeName }); return; }
      onUpdateSessionCaches((current) => {
        const cache = current[cacheKey] ?? {};
        if (cache.nodeFileTarget) return current;
        return { ...current, [cacheKey]: { ...cache, nodeFileTarget: target, nodeFileName: nodeName } };
      });
    }).catch((error) => {
      if (!cancelled) setNodeFileSessionError({ key: cacheKey, message: String(error) });
    }).finally(() => {
      nodeFileStartRef.current.delete(cacheKey);
    });
    return () => { cancelled = true; };
  }, [clusterId, state?.id, state?.mode, state?.terminalTarget, nodeName, nodeFiles, nodeFileSessionError?.key, language, onUpdateSessionCaches]);
  useEffect(() => {
    if (!state || (state.mode !== "logs" && !containerTerminal && state.mode !== "files") || !selectedPod) return;
    const containers = allPodContainers(selectedPod);
    if (!containers.includes(selectedContainer)) setSelectedContainer(containers[0] ?? "");
  }, [state?.mode, containerTerminal, selectedPodKey, selectedPod, selectedContainer]);
  useEffect(() => {
    if (!state || state.mode !== "terminal" || (containerTerminal && (!selectedPod || targetsReadySessionRef.current !== state.id))) return;
    if (nodeTerminal && !nodeName) return;
    const sessionId = runtimeKey;
    const targetLabel = nodeTerminal
      ? `Node ${nodeName}`
      : containerTerminal
        ? `${selectedPod!.namespace}/${selectedPod!.pod}${selectedContainer ? ` · ${selectedContainer}` : ""}`
        : "Local shell · active cluster";
    const connectionKey = nodeTerminal
      ? `${clusterId}|node|${nodeName}|${terminalReloadToken}`
      : containerTerminal
        ? `${clusterId}|${selectedPod!.key}|${selectedContainer}|${terminalReloadToken}`
        : `${clusterId}|${terminalReloadToken}`;
    const existing = terminalRuntimesRef.current[sessionId];
    if (existing?.connectionKey === connectionKey && (existing.status === "connected" || existing.status === "connecting")) return;
    if (existing?.sessionId && nativeBackendAvailable) void backend.stopTerminal(existing.sessionId);
    const terminalKind = nodeTerminal ? "Node" : containerTerminal ? "Container" : "Local";
    onUpdateTerminalRuntimes((current) => ({
      ...current,
      [sessionId]: {
        sessionId: "", output: "", status: "connecting", feedback: `${nodeTerminal || containerTerminal ? "Connecting" : "Starting"} · ${targetLabel}`, connectionKey, targetLabel,
        podKey: containerTerminal ? selectedPod!.key : undefined,
        container: containerTerminal ? selectedContainer : undefined,
      },
    }));

    const updateRuntime = (update: (runtime: TerminalRuntime) => TerminalRuntime) => {
      onUpdateTerminalRuntimes((current) => {
        const runtime = current[sessionId];
        if (!runtime || runtime.connectionKey !== connectionKey) return current;
        return { ...current, [sessionId]: update(runtime) };
      });
    };

    if (!nativeBackendAvailable) {
      updateRuntime((runtime) => ({ ...runtime, status: "disconnected", feedback: tr(language, "nativeAppRequired"), sessionId: "" }));
      return;
    }

    const onMessage = (message: { eventType: string; data?: string | null }) => {
      if (message.eventType === "connected") {
        updateRuntime((runtime) => ({ ...runtime, status: "connected", feedback: message.data || `Connected · ${targetLabel}` }));
      } else if (message.eventType === "output") {
        const chunk = message.data ?? "";
        if (chunk) updateRuntime((runtime) => ({ ...runtime, output: `${runtime.output}${chunk}`.slice(-2_000_000) }));
      } else if (message.eventType === "error") {
        updateRuntime((runtime) => ({ ...runtime, feedback: message.data || `${terminalKind} terminal failed` }));
      } else if (message.eventType === "disconnected") {
        updateRuntime((runtime) => ({ ...runtime, status: "disconnected", feedback: message.data || `${terminalKind} terminal disconnected`, sessionId: "" }));
      }
    };
    const start = nodeTerminal
      ? backend.startNodeTerminal({ clusterId, node: nodeName, command: [] }, onMessage)
      : containerTerminal
        ? backend.startTerminal({ clusterId, namespace: selectedPod!.namespace, pod: selectedPod!.pod, container: selectedContainer || undefined, command: [] }, onMessage)
        : backend.startLocalTerminal(clusterId, onMessage);
    void start.then((nextSessionId) => {
      onUpdateTerminalRuntimes((current) => {
        const runtime = current[sessionId];
        if (!runtime || runtime.connectionKey !== connectionKey) {
          void backend.stopTerminal(nextSessionId);
          return current;
        }
        return { ...current, [sessionId]: { ...runtime, sessionId: nextSessionId } };
      });
    }).catch((error) => {
      updateRuntime((runtime) => ({ ...runtime, status: "disconnected", feedback: String(error), sessionId: "" }));
    });
  }, [clusterId, state?.id, state?.mode, containerTerminal, nodeTerminal, nodeName, selectedPod?.key, selectedContainer, terminalReloadToken, language]);
  useEffect(() => {
    if (!state || state.mode !== "logs" || !selectedPod) return;
    if (!nativeBackendAvailable) {
      setOutput(tr(language, "nativeAppRequired"));
      setFeedback(tr(language, "nativeAppRequired"));
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const logs = await backend.podLogs({ clusterId, namespace: selectedPod.namespace, pod: selectedPod.pod, container: selectedContainer || undefined, tailLines: logTailLines, timestamps: logTimestamps, previous: logPrevious });
        if (!cancelled) { setOutput(logs || "No log lines returned"); setFeedback(""); }
      } catch (nextError) { if (!cancelled) { setOutput(String(nextError)); setFeedback("Log request failed"); } }
    };
    if (!sessionCachesRef.current[runtimeKey]?.output) setOutput("Connecting to pod log stream…");
    void load();
    if (logFollow) timer = window.setInterval(load, 5000);
    return () => { cancelled = true; if (timer) window.clearInterval(timer); };
  }, [clusterId, state?.id, state?.mode, selectedPod?.key, selectedContainer, logFollow, logTailLines, logPrevious, logTimestamps, language]);
  if (!state) return null;
  const readOnlyReason = state.readOnlyReason;
  const manifestReadOnly = Boolean(readOnlyReason);
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => { event.preventDefault(); event.stopPropagation(); const currentHeight = collapsed ? 38 : dockRef.current?.getBoundingClientRect().height ?? height; if (collapsed) { setHeight(38); onToggleCollapsed(); } setMaximized(false); resize.current = { startY: event.clientY, startHeight: currentHeight, currentHeight }; document.body.classList.add("resizing-session-sheet"); };
  const sessionHeightMaximum = Math.max(220, window.innerHeight - 220);
  const resizeSessionWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 48 : 24;
    const current = collapsed ? 38 : maximized ? sessionHeightMaximum : height;
    let next: number | undefined;
    if (event.key === "ArrowUp") next = collapsed ? 220 : current + step;
    if (event.key === "ArrowDown") next = current - step;
    if (event.key === "Home") next = 38;
    if (event.key === "End") next = sessionHeightMaximum;
    if (next === undefined) return;
    event.preventDefault();
    next = Math.max(38, Math.min(sessionHeightMaximum, next));
    if (next === 38 && !collapsed) onToggleCollapsed();
    if (next > 38 && collapsed) onToggleCollapsed();
    setMaximized(false);
    setHeight(next);
  };
  const sessionModeLabel = (session: BottomSession) => {
    if (session.mode === "terminal") {
      if (session.terminalTarget === "node" || session.item?.row?.kind === "Node" || session.item?.kind === "Node") return tr(language, "nodeTerminal");
      if (session.terminalTarget === "container" || (session.terminalTarget === undefined && session.item)) return tr(language, "containerTerminal");
      return tr(language, "localTerminal");
    }
    if (session.mode === "logs") return tr(language, "logs");
    if (session.mode === "files") return session.terminalTarget === "node" || session.item?.row?.kind === "Node" || session.item?.kind === "Node" ? tr(language, "nodeFiles") : tr(language, "files");
    if (session.mode === "edit") return session.readOnlyReason ? tr(language, "view") : tr(language, "edit");
    return tr(language, "create");
  };
  const sessionTitle = (session: BottomSession) => `${sessionModeLabel(session)} · ${session.label ?? session.item?.label ?? "cluster"}`;
  const terminalOption = tr(language, "newLocalTerminal");
  const resourceOption = tr(language, "createResource");
  const showPodTarget = state.item?.row?.kind !== "Pod";
  const podOptions = podTargets.length
    ? podTargets.map((target) => ({ value: target.key, label: target.pod, description: `${target.namespace} · ${target.phase}${target.ready ? " · Ready" : ""}`, icon: Box }))
    : [{ value: "", label: targetsLoading ? "Resolving..." : "Unavailable", description: targetError || undefined, icon: Box }];
  const availableContainerOptions = [
    ...(selectedPod?.initContainers ?? []).map((container) => ({ value: container, label: container, group: "Init Containers", icon: Container })),
    ...(selectedPod?.containers ?? []).map((container) => ({ value: container, label: container, group: "Containers", icon: Container })),
  ];
  const containerOptions = availableContainerOptions.length
    ? availableContainerOptions
    : [{ value: "", label: targetsLoading ? "Resolving..." : "Unavailable", description: targetError || undefined, icon: Container }];
  const updateActiveTerminalRuntime = (update: (runtime: TerminalRuntime) => TerminalRuntime) => {
    if (!state || state.mode !== "terminal") return;
    const id = runtimeKey;
    onUpdateTerminalRuntimes((current) => {
      const runtime = current[id];
      if (!runtime) return current;
      return { ...current, [id]: update(runtime) };
    });
  };
  const reconnectTerminal = () => {
    updateActiveTerminalRuntime((runtime) => ({ ...runtime, status: "connecting", feedback: tr(language, "reconnecting") }));
    patchSessionCache({ terminalReloadToken: terminalReloadToken + 1 });
  };
  const writeTerminalInput = (data: string) => {
    if (terminalStatus !== "connected") return;
    if (!nativeBackendAvailable) return;
    if (!terminalSessionId) {
      updateActiveTerminalRuntime((runtime) => ({ ...runtime, status: "disconnected", feedback: tr(language, "terminalUnavailable") }));
      return;
    }
    void backend.writeTerminal(terminalSessionId, data).catch((error) => {
      updateActiveTerminalRuntime((runtime) => ({ ...runtime, status: "disconnected", feedback: String(error) }));
    });
  };
  const resizeContainerTerminal = (columns: number, rows: number) => {
    if (nativeBackendAvailable && terminalSessionId) void backend.resizeTerminal(terminalSessionId, columns, rows).catch(() => undefined);
  };
  const changeManifestFormat = (nextFormat: ManifestFormat) => {
    if (nextFormat === manifestFormat || busy || manifestReadOnly) return;
    try {
      const converted = convertManifest(manifestText, manifestFormat, nextFormat);
      patchSessionCache({
        manifestText: converted,
        manifestFormat: nextFormat,
        feedback: manifestFormat === "yaml" && nextFormat === "json"
          ? "Converted to JSON; YAML comments and formatting were normalized"
          : `Converted to ${nextFormat.toUpperCase()}`,
      });
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
    }
  };
  const apply = async (closeAfter = false) => {
    if (manifestReadOnly) { setFeedback(readOnlyReason ?? "This manifest is read-only"); return; }
    const format = manifestFormat;
    const manifest = manifestText;
    const localValidation = validateManifestText(manifest, format);
    const localError = firstManifestError(localValidation);
    if (localError) { setFeedback(localError.message); return; }
    if (!nativeBackendAvailable) { setFeedback(tr(language, "nativeAppRequired")); return; }
    setBusy(true); setFeedback(`Applying ${format.toUpperCase()} with Kubernetes API…`);
    try {
      await backend.applyManifest({ clusterId, manifest, format, resource: state.descriptor ?? state.item?.row?.descriptor, force: false });
      setFeedback("Applied successfully");
      onApplied();
      if (closeAfter) onCloseSession(state.id);
    } catch (nextError) { setFeedback(String(nextError)); }
    finally { setBusy(false); }
  };
  const validateActiveManifest = async () => {
    const format = manifestFormat;
    const manifest = manifestText;
    const localValidation = validateManifestText(manifest, format);
    const localError = firstManifestError(localValidation);
    if (localError) { setFeedback(localError.message); return; }
    if (!nativeBackendAvailable) { setFeedback(tr(language, "nativeAppRequired")); return; }
    setBusy(true); setFeedback(`Validating ${format.toUpperCase()} with Kubernetes API…`);
    try {
      await backend.applyManifest({ clusterId, manifest, format, resource: state.descriptor ?? state.item?.row?.descriptor, dryRun: true, force: false });
      setFeedback(`${format.toUpperCase()} is valid`);
    } catch (nextError) { setFeedback(String(nextError)); }
    finally { setBusy(false); }
  };
  const reloadManifest = async () => {
    if (state.mode !== "edit" || busy) return;
    const row = state.item?.row;
    const descriptor = state.descriptor ?? row?.descriptor;
    const name = row?.kind === "HelmRelease" ? row.backend?.name : (row?.name ?? state.item?.label);
    const namespace = row
      ? (row.namespace === "—" ? undefined : row.namespace)
      : (state.item?.subtitle && state.item.subtitle !== "—" ? state.item.subtitle : undefined);
    if (!descriptor || !name) { setFeedback(tr(language, "reloadManifestUnavailable")); return; }
    if (!nativeBackendAvailable) { setFeedback(tr(language, "nativeAppRequired")); return; }
    setBusy(true); setFeedback(tr(language, "reloadingManifest"));
    try {
      const response = await backend.getResource({ clusterId, resource: descriptor, namespace, name });
      const text = manifestFormat === "json" ? convertManifest(response.manifest, "yaml", "json") : response.manifest;
      patchSessionCache({ manifestText: text, feedback: tr(language, "manifestReloaded") });
    } catch (nextError) { setFeedback(String(nextError)); }
    finally { setBusy(false); }
  };
  const handleSessionShortcut = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!isFindShortcut(event)) return;
    if (state.mode === "files") return;
    event.preventDefault();
    event.stopPropagation();
    openSessionSearch();
  };
  const runtimeStatus = state.mode === "terminal" ? terminalStatus : state.mode === "files" ? "ready" : feedback ? "error" : logFollow ? "live" : "paused";
  const runtimeTone = runtimeStatus === "connected" || runtimeStatus === "live"
    ? "green"
    : runtimeStatus === "connecting"
      ? "amber"
      : runtimeStatus === "disconnected" || runtimeStatus === "error"
        ? "red"
        : "neutral";
  const runtimeStatusLabel = `${state.mode === "terminal" ? "Terminal" : "Logs"} ${runtimeStatus}`;
  const manifestSearchMatch = searchOpen && textSearch.query ? textSearch.matches[textSearch.currentIndex] : undefined;
  const editorFeedbackTone = feedback.includes("success") || feedback.includes(" is valid") || feedback.startsWith("Converted") || feedback === tr(language, "manifestReloaded")
    ? "green"
    : feedback.includes("Applying") || feedback.includes("Validating") || feedback === tr(language, "reloadingManifest")
      ? "neutral"
      : "red";
  const downloadLogs = async () => {
    if (!output || !selectedPod) return;
    if (nativeBackendAvailable) {
      try {
        const path = await backend.downloadLogs({ content: output, pod: selectedPod.pod, container: selectedContainer || undefined });
        onToast("success", "Logs downloaded to", path);
      } catch (error) {
        onToast("error", `Unable to download logs: ${String(error)}`);
      }
      return;
    }
    const blob = new Blob([output], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const targetName = [selectedPod.pod, selectedContainer].filter(Boolean).join("-").replace(/[^a-zA-Z0-9_.-]+/g, "-");
    const filename = `${targetName || "pod"}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    onToast("success", `Logs downloaded as ${filename}`);
  };
  const renderFileTargetSelectors = (inPanel = false) => <>
    {showPodTarget && <Combobox className={cn("session-target-combobox", "pod-target-combobox", inPanel && "file-explorer-target-panel-combobox")} ariaLabel="Pod" leadingIcon={Box} searchable={false} value={selectedPodKey} options={podOptions} onChange={setSelectedPodKey} />}
    <Combobox className={cn("session-target-combobox", "container-target-combobox", inPanel && "file-explorer-target-panel-combobox")} ariaLabel="Container" leadingIcon={Container} searchable={false} value={selectedContainer} options={containerOptions} onChange={setSelectedContainer} />
    {targetsLoading && <LoaderCircle className="spin session-action-spinner" size={13} />}
  </>;
  const fileSessionTargets = fileExplorer && !nodeFiles ? <div className="file-explorer-session-targets">
    <div className="file-explorer-session-targets-inline">{renderFileTargetSelectors()}</div>
    <div className="file-explorer-session-targets-overflow">
      <button type="button" aria-haspopup="dialog" aria-label={tr(language, "showTargetSelectors")} title={tr(language, "targetSelectors")}><Container size={14} /></button>
      <div className="file-explorer-session-targets-panel" role="group" aria-label={tr(language, "targetSelectors")}>{renderFileTargetSelectors(true)}</div>
    </div>
  </div> : undefined;
  const fileExplorerTarget = nodeFiles
    ? nodeFileTarget
    : selectedPod ? { clusterId, namespace: selectedPod.namespace, pod: selectedPod.pod, container: selectedContainer || undefined } : undefined;
  const fileExplorerInstanceKey = [runtimeKey, fileExplorerTarget?.clusterId, fileExplorerTarget?.namespace, fileExplorerTarget?.pod, fileExplorerTarget?.container, fileExplorerTarget?.hostRoot ? "host" : "container"].join("\u0000");

  return <section ref={dockRef} data-session-find={!collapsed && state.mode !== "files" ? "true" : "false"} onKeyDown={handleSessionShortcut} onPointerDownCapture={(event) => noteSessionDockFindContext(event.target)} className={cn("sheet sheet-bottom session-dock", collapsed && "collapsed", maximized && "maximized", !fileExplorer && (state.mode === "logs" || state.mode === "terminal" || state.mode === "edit" || state.mode === "create") && `content-theme-${contentTheme}`)} style={collapsed ? undefined : { height: maximized ? Math.max(220, window.innerHeight - 220) : height }}><div className="sheet-resize-edge horizontal" aria-label={tr(language, "resizeSessions")} aria-orientation="horizontal" aria-valuemin={38} aria-valuemax={sessionHeightMaximum} aria-valuenow={collapsed ? 38 : maximized ? sessionHeightMaximum : Math.round(height)} aria-valuetext={`${collapsed ? 38 : maximized ? sessionHeightMaximum : Math.round(height)} pixels`} role="separator" tabIndex={0} onKeyDown={resizeSessionWithKeyboard} onPointerDown={startResize} /><div className="session-tabbar"><div ref={tabListRef} className="bottom-session-tabs">{sessions.map((session) => {
    const Icon = session.mode === "terminal" ? SquareTerminal : session.mode === "logs" ? ScrollText : session.mode === "files" ? FolderOpen : session.mode === "edit" ? Pencil : Plus; return <button key={session.id} className={cn(session.id === state.id && "active")} onClick={() => onActivate(session.id)} onContextMenu={(event) => openContextMenu(event, [
      { type: "item", id: "close", label: tr(language, "close"), onSelect: () => onCloseSession(session.id) },
      { type: "item", id: "close-others", label: tr(language, "closeOthers"), disabled: sessions.length <= 1, onSelect: () => onCloseOthers(session.id) },
      { type: "item", id: "close-all", label: tr(language, "closeAll"), onSelect: onCloseAll },
    ])}><Icon size={12} /><span>{sessionTitle(session)}</span><i role="button" aria-label={`${tr(language, "close")} ${sessionTitle(session)}`} onClick={(event) => { event.stopPropagation(); onCloseSession(session.id); }}><X size={10} /></i></button>;
  })}</div><div className="session-add" ref={addMenuRef}><Button variant="ghost" size="icon" className="session-add-trigger" aria-label={tr(language, "addSession")} title={tr(language, "addSession")} onClick={() => setAddMenuOpen((value) => !value)}><Plus size={13} /></Button>{addMenuOpen && <div className="session-add-menu"><button onClick={() => { onCreateSession({ mode: "terminal", terminalTarget: "local", sessionKey: `terminal-${Date.now()}`, label: terminalOption }); setAddMenuOpen(false); }}><SquareTerminal size={13} /><span>{terminalOption}</span></button><button onClick={() => { onCreateSession({ mode: "create", sessionKey: `resource-${Date.now()}`, label: resourceOption }); setAddMenuOpen(false); }}><Plus size={13} /><span>{resourceOption}</span></button></div>}</div><div className="session-tab-spacer" /><Button variant="ghost" size="icon" aria-label={maximized ? tr(language, "restoreSessions") : tr(language, "maximizeSessions")} onClick={() => { if (collapsed) onToggleCollapsed(); setMaximized((value) => !value); }}>{maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</Button><Button variant="ghost" size="icon" aria-label={collapsed ? tr(language, "expandSessions") : tr(language, "collapseSessions")} onClick={onToggleCollapsed}><ChevronDown className={cn(collapsed && "rotate-180")} size={15} /></Button></div>{!collapsed && <>{!fileExplorer && <div className="session-action-bar"><div className="session-primary-actions">{(state.mode === "edit" || state.mode === "create") && !manifestReadOnly && <><Button size="sm" disabled={busy || !manifestText.trim() || manifestHasErrors(manifestValidation)} onClick={() => void apply(false)}>{busy && <LoaderCircle className="spin" size={13} />}{tr(language, "apply")}</Button><Button variant="secondary" size="sm" disabled={busy || !manifestText.trim() || manifestHasErrors(manifestValidation)} onClick={() => void apply(true)}> {tr(language, "applyAndClose")}</Button></>}{state.mode === "edit" && <Button variant="secondary" size="icon" aria-label={tr(language, "reloadManifest")} title={tr(language, "reloadManifest")} disabled={busy} onClick={() => void reloadManifest()}><RefreshCw className={cn(busy && feedback === tr(language, "reloadingManifest") && "spin")} size={14} /></Button>}{readOnlyReason && <span className="manifest-read-only-notice" role="status"><Info size={13} aria-hidden="true" /><span>{readOnlyReason}</span></span>}{(state.mode === "logs" || state.mode === "terminal") && <span className={cn("session-runtime-status", `status-${runtimeTone}`)} role="status" aria-label={runtimeStatusLabel} title={runtimeStatusLabel} data-status={runtimeStatus} />}{(state.mode === "logs" || containerTerminal || fileExplorer) && <>{showPodTarget && <Combobox className="session-target-combobox pod-target-combobox" ariaLabel="Pod" leadingIcon={Box} searchable={false} value={selectedPodKey} options={podOptions} onChange={setSelectedPodKey} />}<Combobox className="session-target-combobox container-target-combobox" ariaLabel="Container" leadingIcon={Container} searchable={false} value={selectedContainer} options={containerOptions} onChange={setSelectedContainer} />{targetsLoading && <LoaderCircle className="spin session-action-spinner" size={13} />}</>}</div><div className="session-secondary-actions">{(state.mode === "edit" || state.mode === "create") && !manifestReadOnly && <><div className="manifest-format-switch" role="group" aria-label="Manifest format">{(["yaml", "json"] as ManifestFormat[]).map((format) => <button key={format} type="button" className={cn(manifestFormat === format && "active")} aria-pressed={manifestFormat === format} disabled={busy} onClick={() => changeManifestFormat(format)}>{format.toUpperCase()}</button>)}</div><Button variant="outline" size="sm" disabled={busy || !manifestText.trim()} onClick={() => void validateActiveManifest()}><ShieldCheck size={13} />Validate {manifestFormat.toUpperCase()}</Button></>}{state.mode === "terminal" && terminalStatus === "disconnected" && <Button variant="outline" size="sm" onClick={() => void reconnectTerminal()}><RefreshCw size={13} />Reconnect</Button>}{state.mode === "logs" && <><Combobox className="session-tail-combobox" ariaLabel="Tail lines" label="Tail" searchable={false} value={String(logTailLines)} options={[100, 500, 1000, 5000, 10000].map((value) => ({ value: String(value), label: String(value) }))} onChange={(value) => setLogTailLines(Number(value))} /><label className="session-checkbox"><input type="checkbox" checked={logTimestamps} onChange={(event) => setLogTimestamps(event.target.checked)} /><span>Timestamps</span></label><label className="session-checkbox"><input type="checkbox" checked={logFollow} onChange={(event) => setLogFollow(event.target.checked)} /><span>Follow</span></label><label className="session-checkbox" title="Show logs from the previous terminated container instance"><input type="checkbox" aria-label="Previous terminated container logs" checked={logPrevious} onChange={(event) => setLogPrevious(event.target.checked)} /><span>Previous</span></label><label className="session-checkbox"><input type="checkbox" checked={logWrapLines} onChange={(event) => setLogWrapLines(event.target.checked)} /><span>Wrap</span></label><Button variant="ghost" size="icon" aria-label="Download logs" title="Download logs" disabled={!output} onClick={downloadLogs}><Download size={14} /></Button></>}{state.mode !== "files" && <Button variant="secondary" size="icon" aria-label="Find text" title={tr(language, "findTextShortcut")} onClick={() => { if (searchOpen) onSearchOpenChange(false); else openSessionSearch(); }}><Search size={14} /></Button>}</div></div>}{(state.mode === "edit" || state.mode === "create") && <div className="editor-layout"><Suspense fallback={<div className="manifest-editor-loading"><LoaderCircle className="spin" size={14} />Loading editor…</div>}><ManifestEditor key={`${runtimeKey}:${manifestFormat}`} documentId={runtimeKey} value={manifestText} format={manifestFormat} theme={contentTheme} fontFamily={contentFont} fontSize={scaledContentFontSize} diagnostics={manifestValidation.diagnostics} selection={manifestSearchMatch ? { from: manifestSearchMatch.start, to: manifestSearchMatch.end } : undefined} language={language} readOnly={manifestReadOnly} onChange={setManifestText} onFind={openSessionSearch} /></Suspense>{feedback && <Badge className="editor-feedback" tone={editorFeedbackTone}>{feedback}</Badge>}</div>}{state.mode === "logs" && <div className={cn("terminal-output logs-output", logWrapLines && "wrap-lines")} style={{ fontFamily: contentFont }} tabIndex={-1} onMouseDown={(event) => { if (event.button === 0) event.currentTarget.focus(); }}><pre style={{ fontSize: scaledContentFontSize }}><AnsiHighlightedText text={output} matches={textSearch.matches} currentIndex={textSearch.currentIndex} /></pre></div>}{state.mode === "terminal" && <div className="terminal-output terminal-interactive"><Suspense fallback={<div className="terminal-loading"><LoaderCircle className="spin" size={14} />Loading terminal…</div>}><ContainerTerminal language={language} sessionId={terminalSessionId} output={terminalOutput} connected={terminalStatus === "connected"} theme={contentTheme} fontFamily={contentFont} fontSize={scaledContentFontSize} search={textSearch} onInput={writeTerminalInput} onResize={resizeContainerTerminal} onFind={openSessionSearch} /></Suspense></div>}{state.mode === "files" && <ContainerFileExplorer key={fileExplorerInstanceKey} target={fileExplorerTarget} targetLoading={nodeFiles && nodeFileTargetLoading} targetUnavailableTitle={nodeFiles ? tr(language, "nodeFilesUnavailable") : undefined} targetUnavailableMessage={nodeFiles ? nodeFileSessionFailure || undefined : undefined} initialSnapshot={sessionCache?.fileExplorerSnapshot} onSnapshotChange={(fileExplorerSnapshot) => patchSessionCache({ fileExplorerSnapshot })} appTheme={appTheme} contentFont={contentFont} contentFontSize={scaledContentFontSize} language={language} sessionTargetControls={fileSessionTargets} onToast={onToast} />}{!collapsed && <div className="session-float-controls"><div className={cn("content-zoom-widget", !zoomWidgetVisible && "hidden-widget")} role="group" aria-label={tr(language, "contentZoomFeedback", { percent: contentZoomPercent })}><button type="button" aria-label={tr(language, "zoomOut")} title={tr(language, "zoomOut")} onClick={() => applyContentZoom(settleContentZoomFactor(contentZoomRef.current - 0.05))}><ZoomOut size={13} /></button><span>{contentZoomPercent}%</span><button type="button" aria-label={tr(language, "zoomIn")} title={tr(language, "zoomIn")} onClick={() => applyContentZoom(settleContentZoomFactor(contentZoomRef.current + 0.05))}><ZoomIn size={13} /></button><button type="button" aria-label={tr(language, "resetZoom")} title={tr(language, "resetZoom")} onClick={() => applyContentZoom(1)}><RotateCcw size={12} /></button></div><TextSearchPopover open={searchOpen} onClose={() => onSearchOpenChange(false)} search={textSearch} language={language} focusRequest={searchFocusRequest} /></div>}</>}</section>;
}

function ResourceDeleteDialog({ row, busy, error, language, onClose, onConfirm }: { row: ResourceRow; busy: boolean; error: string; language: AppLanguage; onClose: () => void; onConfirm: () => void }) {
  const stoppingForward = row.kind === "PortForward";
  const namespaceLabel = row.namespace === "—" ? tr(language, "clusterScoped") : `${tr(language, "namespace")} · ${row.namespace}`;
  const title = stoppingForward ? tr(language, "stopPortForwarding") : tr(language, "deleteResource");
  const confirmLabel = stoppingForward ? tr(language, "stopForwarding") : tr(language, "delete");
  return <div className="modal-backdrop panel-dialog-backdrop resource-delete-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="resource-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="resource-delete-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><h2 id="resource-delete-title">{title}</h2><div /><Button variant="ghost" size="icon" disabled={busy} aria-label={tr(language, "close")} onClick={onClose}><X size={14} /></Button></header>
      <div className="resource-delete-body">
        <div className="resource-delete-target"><span className="resource-delete-icon"><Trash2 size={17} /></span><div><strong>{row.name}</strong><small>{row.kind} · {namespaceLabel}</small></div></div>
        <div className="resource-delete-warning"><AlertTriangle size={15} /><div><strong>{stoppingForward ? tr(language, "stopThisForward") : tr(language, "deleteResourcePrompt", { kind: row.kind, name: row.name })}</strong><span>{stoppingForward ? "Connections using this local port will be interrupted immediately." : row.kind === "Pod" ? "The Pod will enter graceful termination. If it is managed by a controller, Kubernetes may create a replacement Pod." : "This operation cannot be undone. Kubernetes controllers may recreate resources that they manage."}</span></div></div>
        {error && <div className="resource-delete-error" role="alert">{error}</div>}
      </div>
      <footer><span>{stoppingForward ? tr(language, "localForwardSession") : tr(language, "backgroundPropagation")}</span><div /><Button variant="outline" size="sm" disabled={busy} autoFocus onClick={onClose}>{tr(language, "cancel")}</Button><Button variant="outline" size="sm" className="resource-delete-confirm hover-destructive" disabled={busy} onClick={onConfirm}>{busy && <LoaderCircle className="spin" size={13} />}{busy ? (stoppingForward ? tr(language, "stopping") : tr(language, "deleting")) : confirmLabel}</Button></footer>
    </section>
  </div>;
}

function currentReplicaCount(row: ResourceRow) {
  return Number(String(row.data.ready ?? row.data.desired ?? row.data.replicas ?? "1").split("/").at(-1)) || 1;
}

function sanitizeReplicaInput(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits === "") return "";
  return String(Number(digits));
}

function ResourceScaleDialog({ row, busy, error, language, onClose, onConfirm }: { row: ResourceRow; busy: boolean; error: string; language: AppLanguage; onClose: () => void; onConfirm: (replicas: number) => void }) {
  const current = currentReplicaCount(row);
  const [replicas, setReplicas] = useState(String(current));
  const [validationError, setValidationError] = useState("");
  const namespaceLabel = row.namespace === "—" ? tr(language, "clusterScoped") : `${tr(language, "namespace")} · ${row.namespace}`;
  const replicaValue = replicas === "" ? 0 : Number(replicas);
  useEffect(() => {
    setReplicas(String(currentReplicaCount(row)));
    setValidationError("");
  }, [row]);
  const adjustReplicas = (delta: number) => {
    if (busy) return;
    const next = Math.max(0, (replicas === "" ? 0 : Number(replicas)) + delta);
    setReplicas(String(next));
    setValidationError("");
  };
  const submit = () => {
    if (replicas === "" || !/^\d+$/.test(replicas) || !Number.isInteger(replicaValue) || replicaValue < 0) {
      setValidationError(tr(language, "replicasNonNegative"));
      return;
    }
    setValidationError("");
    onConfirm(replicaValue);
  };
  return <div className="modal-backdrop panel-dialog-backdrop resource-scale-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="resource-scale-dialog" role="dialog" aria-modal="true" aria-labelledby="resource-scale-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><h2 id="resource-scale-title">{tr(language, "scaleResource")}</h2><div /><Button variant="ghost" size="icon" disabled={busy} aria-label={tr(language, "close")} onClick={onClose}><X size={14} /></Button></header>
      <div className="resource-scale-body">
        <div className="resource-scale-target"><span className="resource-scale-icon"><Scaling size={17} /></span><div><strong>{row.name}</strong><small>{row.kind} · {namespaceLabel}</small></div></div>
        <div className="resource-scale-field">
          <span>{tr(language, "replicas")}</span>
          <div className="resource-scale-stepper" role="group" aria-label={tr(language, "replicas")}>
            <Button type="button" variant="outline" size="icon" disabled={busy || replicaValue <= 0} aria-label="-" title="-" onClick={() => adjustReplicas(-1)}><Minus size={14} /></Button>
            <input
              aria-label={tr(language, "replicas")}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              autoFocus
              disabled={busy}
              value={replicas}
              onChange={(event) => {
                setReplicas(sanitizeReplicaInput(event.target.value));
                setValidationError("");
              }}
              onBlur={() => { if (replicas === "") setReplicas("0"); }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !busy) { event.preventDefault(); submit(); return; }
                if (event.key === "ArrowUp") { event.preventDefault(); adjustReplicas(1); return; }
                if (event.key === "ArrowDown") { event.preventDefault(); adjustReplicas(-1); return; }
                if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey && !/[0-9]/.test(event.key)) event.preventDefault();
              }}
            />
            <Button type="button" variant="outline" size="icon" disabled={busy} aria-label="+" title="+" onClick={() => adjustReplicas(1)}><Plus size={14} /></Button>
          </div>
          <small>{tr(language, "currentReplicas", { count: current })} · {tr(language, "scaleHint")}</small>
        </div>
        {(validationError || error) && <div className="resource-scale-error" role="alert">{validationError || error}</div>}
      </div>
      <footer><span>{tr(language, "scaleSubresource")}</span><div /><Button variant="outline" size="sm" disabled={busy} onClick={onClose}>{tr(language, "cancel")}</Button><Button size="sm" disabled={busy} onClick={submit}>{busy && <LoaderCircle className="spin" size={13} />}{busy ? tr(language, "scaling") : tr(language, "scale")}</Button></footer>
    </section>
  </div>;
}

function NodeDrainDialog({ row, busy, error, result, language, onClose, onConfirm }: { row: ResourceRow; busy: boolean; error: string; result: DrainNodeResult | null; language: AppLanguage; onClose: () => void; onConfirm: (options: { ignoreDaemonsets: boolean; deleteEmptyDirData: boolean; force: boolean; disableEviction: boolean; waitForDeletion: boolean; timeoutSeconds: number }) => void }) {
  const [ignoreDaemonsets, setIgnoreDaemonsets] = useState(true);
  const [deleteEmptyDirData, setDeleteEmptyDirData] = useState(false);
  const [force, setForce] = useState(false);
  const [disableEviction, setDisableEviction] = useState(false);
  const [waitForDeletion, setWaitForDeletion] = useState(true);
  const [timeoutInput, setTimeoutInput] = useState("300");
  const timeout = Math.max(1, Math.min(3600, Number(timeoutInput) || 300));
  const namespaceLabel = row.namespace === "—" ? tr(language, "clusterScoped") : `${tr(language, "namespace")} · ${row.namespace}`;
  return <div className="modal-backdrop panel-dialog-backdrop resource-scale-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="resource-scale-dialog node-drain-dialog" role="dialog" aria-modal="true" aria-labelledby="node-drain-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><h2 id="node-drain-title">{tr(language, "drainNode")}</h2><div /><Button variant="ghost" size="icon" disabled={busy} aria-label={tr(language, "close")} onClick={onClose}><X size={14} /></Button></header>
      <div className="resource-scale-body">
        <div className="resource-scale-target"><span className="resource-scale-icon"><Droplets size={17} /></span><div><strong>{row.name}</strong><small>{row.kind} · {namespaceLabel}</small></div></div>
        {result ? <div className="node-drain-result" role="status">
          <strong>{tr(language, "drainComplete", { name: row.name, evicted: result.evicted, skipped: result.skipped })}</strong>
          {result.failures.length > 0 && <div className="node-drain-failures" role="alert"><AlertTriangle size={14} /><ul>{result.failures.map((failure) => <li key={failure}>{failure}</li>)}</ul></div>}
          {result.remaining.length > 0 && <div className="node-drain-remaining" role="alert"><AlertTriangle size={14} /><span>{tr(language, "drainRemaining", { count: result.remaining.length, pods: result.remaining.join(", ") })}</span></div>}
        </div> : <>
          <div className="node-action-warning"><AlertTriangle size={15} /><div><strong>{tr(language, "drainNodePrompt", { name: row.name })}</strong><span>{tr(language, "drainOptions")}</span></div></div>
          <div className="node-drain-options">
            <label className="session-checkbox"><input type="checkbox" checked={ignoreDaemonsets} disabled={busy} onChange={(event) => setIgnoreDaemonsets(event.target.checked)} /><span><strong>{tr(language, "ignoreDaemonsets")}</strong><small>{tr(language, "ignoreDaemonsetsHint")}</small></span></label>
            <label className="session-checkbox"><input type="checkbox" checked={deleteEmptyDirData} disabled={busy} onChange={(event) => setDeleteEmptyDirData(event.target.checked)} /><span><strong>{tr(language, "deleteEmptyDirData")}</strong><small>{tr(language, "deleteEmptyDirDataHint")}</small></span></label>
            <label className="session-checkbox"><input type="checkbox" checked={force} disabled={busy} onChange={(event) => setForce(event.target.checked)} /><span><strong>{tr(language, "forceDrain")}</strong><small>{tr(language, "forceDrainHint")}</small></span></label>
            <label className="session-checkbox"><input type="checkbox" checked={disableEviction} disabled={busy} onChange={(event) => setDisableEviction(event.target.checked)} /><span><strong>{tr(language, "disableEviction")}</strong><small>{tr(language, "disableEvictionHint")}</small></span></label>
            <label className="session-checkbox"><input type="checkbox" checked={waitForDeletion} disabled={busy} onChange={(event) => setWaitForDeletion(event.target.checked)} /><span><strong>{tr(language, "waitForDeletion")}</strong></span></label>
            <label className="node-drain-timeout"><span>{tr(language, "drainTimeoutSeconds")}</span><input aria-label={tr(language, "drainTimeoutSeconds")} type="number" min={1} max={3600} disabled={busy} value={timeoutInput} onChange={(event) => setTimeoutInput(event.target.value)} /></label>
          </div>
        </>}
        {error && <div className="resource-scale-error" role="alert">{error}</div>}
      </div>
      <footer><span>{tr(language, "cordon")} · {row.name}</span><div /><Button variant="outline" size="sm" disabled={busy} onClick={onClose}>{result ? tr(language, "close") : tr(language, "cancel")}</Button>{!result && <Button variant="secondary" size="sm" className="node-action-confirm" disabled={busy} onClick={() => onConfirm({ ignoreDaemonsets, deleteEmptyDirData, force, disableEviction, waitForDeletion, timeoutSeconds: timeout })}>{busy && <LoaderCircle className="spin" size={13} />}{busy ? tr(language, "drainStarting", { name: row.name }) : tr(language, "drain")}</Button>}</footer>
    </section>
  </div>;
}

function NodeCordonDialog({ row, busy, error, language, onClose, onConfirm }: { row: ResourceRow; busy: boolean; error: string; language: AppLanguage; onClose: () => void; onConfirm: () => void }) {
  const namespaceLabel = row.namespace === "\u2014" ? tr(language, "clusterScoped") : `${tr(language, "namespace")} · ${row.namespace}`;
  return <div className="modal-backdrop panel-dialog-backdrop resource-delete-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="resource-delete-dialog node-cordon-dialog" role="dialog" aria-modal="true" aria-labelledby="node-cordon-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><h2 id="node-cordon-title">{tr(language, "cordon")}</h2><div /><Button variant="ghost" size="icon" disabled={busy} aria-label={tr(language, "close")} onClick={onClose}><X size={14} /></Button></header>
      <div className="resource-delete-body">
        <div className="resource-delete-target"><span className="resource-delete-icon"><Pause size={17} /></span><div><strong>{row.name}</strong><small>{row.kind} · {namespaceLabel}</small></div></div>
        <div className="node-action-warning"><AlertTriangle size={15} /><div><strong>{tr(language, "cordonPrompt", { name: row.name })}</strong><span>{tr(language, "cordonHint")}</span></div></div>
        {error && <div className="resource-delete-error" role="alert">{error}</div>}
      </div>
      <footer><span>{tr(language, "unschedulable")}</span><div /><Button variant="outline" size="sm" disabled={busy} autoFocus onClick={onClose}>{tr(language, "cancel")}</Button><Button variant="secondary" size="sm" className="node-action-confirm" disabled={busy} onClick={onConfirm}>{busy && <LoaderCircle className="spin" size={13} />}{busy ? tr(language, "cordoning") : tr(language, "cordon")}</Button></footer>
    </section>
  </div>;
}

function NodeTaintsDialog({ clusterId, row, error, language, onClose, onTainted }: { clusterId: string; row: ResourceRow; error: string; language: AppLanguage; onClose: () => void; onTainted: () => void }) {
  const [taints, setTaints] = useState<NodeTaint[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState("");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [effect, setEffect] = useState("NoSchedule");
  const [validationError, setValidationError] = useState("");
  const namespaceLabel = row.namespace === "\u2014" ? tr(language, "clusterScoped") : `${tr(language, "namespace")} · ${row.namespace}`;
  const effectOptions: Array<{ value: string; label: string; description: string }> = [
    { value: "NoSchedule", label: "NoSchedule", description: tr(language, "taintEffectNoScheduleHint") },
    { value: "PreferNoSchedule", label: "PreferNoSchedule", description: tr(language, "taintEffectPreferNoScheduleHint") },
    { value: "NoExecute", label: "NoExecute", description: tr(language, "taintEffectNoExecuteHint") },
  ];
  const reload = () => {
    setLoadError("");
    void backend.listNodeTaints({ clusterId, node: row.name }).then((items) => {
      setTaints(items);
    }).catch((nextError) => {
      setTaints([]);
      setLoadError(String(nextError));
    });
  };
  useEffect(() => {
    if (!nativeBackendAvailable) { setTaints([]); setLoadError(tr(language, "nativeAppRequired")); return; }
    reload();
  }, [clusterId, row.name]);
  const add = async () => {
    if (!key.trim() || busy) return;
    setValidationError("");
    setBusy(true);
    try {
      await backend.addNodeTaint(clusterId, row.name, key.trim(), value.trim(), effect);
      setKey(""); setValue(""); setEffect("NoSchedule");
      reload();
      onTainted();
    } catch (nextError) { setValidationError(String(nextError)); }
    finally { setBusy(false); }
  };
  const remove = async (item: NodeTaint) => {
    if (busy) return;
    if (!window.confirm(tr(language, "removeTaint", { key: item.key, effect: item.effect }))) return;
    setRemoving(`${item.key}\u0000${item.effect}`);
    setBusy(true);
    try {
      await backend.removeNodeTaint(clusterId, row.name, item.key, item.effect);
      reload();
      onTainted();
    } catch (nextError) { setValidationError(String(nextError)); }
    finally { setBusy(false); setRemoving(""); }
  };
  return <div className="modal-backdrop panel-dialog-backdrop resource-scale-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="resource-scale-dialog node-taints-dialog" role="dialog" aria-modal="true" aria-labelledby="node-taints-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><h2 id="node-taints-title">{tr(language, "manageTaints")}</h2><div /><Button variant="ghost" size="icon" aria-label={tr(language, "close")} onClick={onClose}><X size={14} /></Button></header>
      <div className="resource-scale-body">
        <div className="resource-scale-target"><span className="resource-scale-icon"><PaintBucket size={17} /></span><div><strong>{row.name}</strong><small>{row.kind} · {namespaceLabel}</small></div></div>
        {loadError ? <div className="resource-scale-error" role="alert">{loadError}</div> : taints === null
          ? <div className="node-taints-loading"><LoaderCircle className="spin" size={16} />{tr(language, "loading")}...</div>
          : taints.length === 0 ? <div className="node-taints-empty">{tr(language, "noTaints")}</div>
            : <table className="node-taints-table">
              <thead><tr><th>{tr(language, "taintKey")}</th><th>{tr(language, "taintValue")}</th><th>{tr(language, "taintEffect")}</th><th>{tr(language, "added")}</th><th aria-label={tr(language, "actions")} /></tr></thead>
              <tbody>{taints.map((item) => <tr key={`${item.key}\u0000${item.effect}`}><td><code>{item.key}</code></td><td>{item.value || "\u2014"}</td><td><Badge tone="blue">{item.effect}</Badge></td><td><time>{item.timeAdded ? new Date(item.timeAdded).toLocaleString(language === "en" ? "en" : language) : "\u2014"}</time></td><td className="node-taints-table-action"><Button variant="ghost" size="icon" className="hover-destructive" disabled={busy} aria-label={tr(language, "removeTaint", { key: item.key, effect: item.effect })} title={tr(language, "removeTaint", { key: item.key, effect: item.effect })} onClick={() => void remove(item)}>{removing === `${item.key}\u0000${item.effect}` ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}</Button></td></tr>)}</tbody>
            </table>}
        <div className="node-taints-add">
          <strong>{tr(language, "addTaint")}</strong>
          <label><span>{tr(language, "taintKey")}</span><input autoFocus value={key} placeholder="dedicated" onChange={(event) => setKey(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && key.trim() && !busy) void add(); }} /><small>{tr(language, "taintKeyHint")}</small></label>
          <label><span>{tr(language, "taintValue")}</span><input value={value} placeholder="gpu" onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && key.trim() && !busy) void add(); }} /><small>{tr(language, "taintValueHint")}</small></label>
          <div className="node-taints-effect-field"><span>{tr(language, "taintEffect")}</span><Combobox className="node-taints-effect" ariaLabel={tr(language, "taintEffect")} searchable={false} value={effect} options={effectOptions} onChange={setEffect} language={language} /></div>
          {(validationError || error) && <div className="resource-scale-error" role="alert">{validationError || error}</div>}
          <Button variant="secondary" size="sm" className="node-action-confirm" disabled={busy || !key.trim()} onClick={() => void add()}>{busy && <LoaderCircle className="spin" size={13} />}<Plus size={13} />{tr(language, "addTaint")}</Button>
        </div>
      </div>
    </section>
  </div>;
}

function AlertsDialog({ clusterId, language, onClose }: { clusterId: string; language: AppLanguage; onClose: () => void }) {
  const [items, setItems] = useState<LiveClusterOverview["events"]>([]);
  useEffect(() => {
    if (!nativeBackendAvailable || clusterId === "unconfigured") return;
    let cancelled = false;
    backend.overview(clusterId).then((snapshot) => { if (!cancelled) setItems(snapshot.events.filter((event) => event.level === "warning")); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [clusterId]);
  return <div className="modal-backdrop panel-dialog-backdrop" onMouseDown={onClose}><section className="alerts-modal" onMouseDown={(event) => event.stopPropagation()}><div className="dialog-header"><h2>{tr(language, "alerts")}</h2><Badge tone="amber">{items.length} {tr(language, "active")}</Badge><div /><Button variant="ghost" size="icon" aria-label={tr(language, "close")} onClick={onClose}><X size={15} /></Button></div><div className="drawer-events">{items.map((event, index) => <div key={`${event.object}-${index}`}><AlertTriangle size={14} /><div><strong>{event.reason}</strong><span>{event.message}</span><small>{event.time} ago · {event.object}</small></div></div>)}{items.length === 0 && <div className="related-empty">{tr(language, "noActiveWarnings")}</div>}</div><footer><span>{tr(language, "showingActiveWarnings")}</span><Button variant="outline" size="sm" onClick={onClose}>{tr(language, "close")}</Button></footer></section></div>;
}

function AboutPanel({ language, updateState, onCheckUpdates, onInstallUpdate, onClose }: { language: AppLanguage; updateState: UpdateState; onCheckUpdates: () => void; onInstallUpdate: () => void; onClose: () => void }) {
  const update = updateState.update;
  const releaseVisible = Boolean(update && ["available", "downloading", "error"].includes(updateState.status));
  const checking = updateState.status === "checking";
  const downloading = updateState.status === "downloading";
  const progress = updateState.contentLength && updateState.contentLength > 0
    ? Math.min(100, Math.round((updateState.downloadedBytes / updateState.contentLength) * 100))
    : 35;
  const updateNote = updateState.status === "checking"
    ? tr(language, "verifyingRelease")
    : updateState.status === "current"
      ? tr(language, "latestRelease", { version: appVersion })
      : updateState.status === "unsupported"
        ? tr(language, "packagedAppRequired")
        : updateState.status === "error" && !releaseVisible
          ? localizedUpdateError(language, updateState.message)
          : "";
  const published = update?.date ? tr(language, "published", { date: new Date(update.date).toLocaleDateString(language === "en" ? "en" : language) }) : tr(language, "signedUpdateReady");
  return <div className="modal-backdrop panel-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="about-modal" role="dialog" aria-modal="true" aria-labelledby="about-title" onMouseDown={(event) => event.stopPropagation()}>
    <header className="about-header"><h2 id="about-title">{tr(language, "aboutKubeHive")}</h2><div /><Button variant="ghost" size="icon" aria-label={tr(language, "close")} onClick={onClose}><X size={15} /></Button></header>
    <div className="about-scroll">
      <section className="about-hero"><img className="about-logo" src={kubeHiveLogo} alt="" /><h1>KubeHive</h1><p>{tr(language, "desktopClientDescription")}</p><div className="about-version"><code>v{appVersion}</code><Badge tone="green">{tr(language, "stable")}</Badge></div><div className="about-meta"><a href="https://github.com/poneding/kubehive" target="_blank" rel="noreferrer" onClick={(event) => { event.preventDefault(); void openUrl("https://github.com/poneding/kubehive"); }}><ExternalLink size={12} />{tr(language, "githubRepository")}</a></div></section>
      {!releaseVisible && <div className="about-update-controls"><Button variant="outline" size="sm" disabled={checking} onClick={onCheckUpdates}>{checking ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}{checking ? tr(language, "checkingForUpdates") : tr(language, "checkForUpdates")}</Button>{updateNote && <span className={cn(updateState.status === "error" && "error")}>{updateNote}</span>}</div>}
      {releaseVisible && update && <section className="about-release" aria-label={tr(language, "whatsNew")}><header><span className="about-release-icon">{downloading ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}</span><div className="about-release-title"><strong>{tr(language, "versionReady", { version: update.version })}</strong><span>{downloading ? (updateState.contentLength ? tr(language, "downloadedBytes", { done: Math.round(updateState.downloadedBytes / 1024 / 1024), total: Math.round(updateState.contentLength / 1024 / 1024) }) : tr(language, "downloadingUpdate")) : published}</span></div><div className="about-release-actions"><Button size="sm" disabled={downloading} onClick={onInstallUpdate}>{downloading ? <LoaderCircle className="spin" size={13} /> : <Download size={13} />}{downloading ? tr(language, "installingUpdate") : tr(language, "installAndRestart")}</Button></div></header>{downloading && <div className="about-progress" aria-label={tr(language, "updateDownloadProgress")}><i style={{ width: `${progress}%` }} /></div>}{updateState.status === "error" && <div className="about-update-controls"><span className="error">{localizedUpdateError(language, updateState.message)}</span></div>}<div className="about-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => { const safeHref = typeof href === "string" && /^https?:\/\//i.test(href) ? href : null; return safeHref ? <a href={safeHref} target="_blank" rel="noreferrer" onClick={(event) => { event.preventDefault(); void openUrl(safeHref); }}>{children}</a> : <span>{children}</span>; } }}>{update.body?.trim() || tr(language, "noReleaseNotes")}</ReactMarkdown></div></section>}
    </div>
  </section></div>;
}

function SettingsSheet({ preferences, onChange, updateState, onCheckUpdates, onClose }: { preferences: Preferences; onChange: (next: Preferences) => void; updateState: UpdateState; onCheckUpdates: () => void; onClose: () => void }) {
  const language = preferences.language;
  const update = <K extends keyof Preferences>(key: K, value: Preferences[K]) => onChange({ ...preferences, [key]: value });
  const themeLabels = language === "en" ? ["Follow system", "Light", "Dark"] : language === "zh-TW" ? ["跟隨系統", "淺色", "深色"] : ["跟随系统", "浅色", "深色"];
  const contentThemeLabels = language === "en" ? ["Follow application", "Dark", "Light"] : language === "zh-TW" ? ["跟隨應用程式主題", "深色", "淺色"] : ["跟随应用主题", "深色", "浅色"];
  const updateDetail = updateState.status === "checking" ? "Checking the signed release" : updateState.status === "available" && updateState.update ? `Version ${updateState.update.version} is ready in About` : updateState.status === "current" ? t(language, "upToDate") : updateState.status === "error" ? localizedUpdateError(language, updateState.message) : `Version ${appVersion} · stable channel`;
  const checking = updateState.status === "checking" || updateState.status === "downloading";
  return <div className="modal-backdrop panel-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="settings-modal"><div className="settings-header"><h2>{t(language, "settings")}</h2><div /><Button variant="ghost" size="icon" aria-label={tr(language, "close")} onClick={onClose}><X size={15} /></Button></div><div className="settings-scroll">
    <section className="settings-section"><div className="settings-section-title"><Globe2 size={15} /><div><h3>{t(language, "application")}</h3><p>{tr(language, "languageAppearance")}</p></div></div><div className="settings-card"><div className="settings-row"><span><strong>{t(language, "language")}</strong><small>{tr(language, "appliesImmediately")}</small></span><Combobox value={preferences.language} onChange={(value) => update("language", value as AppLanguage)} options={[{ value: "en", label: "English" }, { value: "zh-CN", label: "简体中文" }, { value: "zh-TW", label: "繁體中文" }]} searchable={false} /></div><div className="settings-row"><span><strong>{t(language, "theme")}</strong><small>{tr(language, "systemAppearance")}</small></span><Combobox value={preferences.theme} onChange={(value) => update("theme", value as Preferences["theme"])} options={[{ value: "system", label: themeLabels[0], icon: Monitor }, { value: "light", label: themeLabels[1], icon: Sun }, { value: "dark", label: themeLabels[2], icon: Moon }]} searchable={false} /></div></div></section>
    <section className="settings-section"><div className="settings-section-title"><Type size={15} /><div><h3>{t(language, "terminal")}</h3><p>{tr(language, "contentAppearanceDescription")}</p></div></div><div className="settings-card"><div className="settings-row"><span><strong>{t(language, "contentTheme")}</strong><small>{tr(language, "contentColors")}</small></span><Combobox value={preferences.contentTheme} onChange={(value) => update("contentTheme", value as ContentTheme)} options={[{ value: "system", label: contentThemeLabels[0], icon: Monitor }, { value: "dark", label: contentThemeLabels[1], icon: Moon }, { value: "light", label: contentThemeLabels[2], icon: Sun }]} searchable={false} /></div><div className="settings-row"><span><strong>{t(language, "contentFont")}</strong><small>{tr(language, "installedFonts")}</small></span><Combobox value={preferences.contentFont} onChange={(value) => update("contentFont", value)} options={contentFontOptions.map((value) => ({ value, label: value }))} searchable={false} /></div><div className="settings-row"><span><strong>{t(language, "contentFontSize")}</strong><small>{tr(language, "contentText")}</small></span><Combobox value={String(preferences.contentFontSize)} onChange={(value) => update("contentFontSize", Number(value) as Preferences["contentFontSize"])} options={contentFontSizes.map((value) => ({ value: String(value), label: `${value} px` }))} searchable={false} /></div></div></section>
    <section className="settings-section"><div className="settings-section-title"><Wifi size={15} /><div><h3>{t(language, "proxy")}</h3><p>{tr(language, "proxyTraffic")}</p></div></div><div className="settings-card"><div className="settings-row"><span><strong>{t(language, "proxy")}</strong><small>{tr(language, "proxyClients")}</small></span><ToggleSwitch label={tr(language, "enableProxy")} checked={preferences.proxyEnabled} onChange={(value) => update("proxyEnabled", value)} /></div>{preferences.proxyEnabled && <div className="settings-input-row"><span>{tr(language, "proxyUrl")}</span><input value={preferences.proxyUrl} onChange={(event) => update("proxyUrl", event.target.value)} placeholder="http://127.0.0.1:7890" /></div>}</div></section>
    <section className="settings-section"><div className="settings-section-title"><Download size={15} /><div><h3>{t(language, "updates")}</h3><p>{updateDetail}</p></div><Button variant="outline" size="sm" disabled={checking} onClick={onCheckUpdates}>{checking ? <LoaderCircle className="spin" size={13} /> : updateState.status === "current" ? <CheckCircle2 size={13} /> : <RefreshCw size={13} />} {t(language, "checkUpdates")}</Button></div><div className="settings-card"><div className="settings-row"><span><strong>{t(language, "autoUpdate")}</strong><small>{tr(language, "checkStableChannel")}</small></span><ToggleSwitch label={tr(language, "automaticUpdates")} checked={preferences.autoUpdate} onChange={(value) => update("autoUpdate", value)} /></div></div></section>
  </div></section></div>;
}

function AddClusterDialog({ language, onClose, onAdd }: { language: AppLanguage; onClose: () => void; onAdd: (request: { displayName: string; kubeconfigYaml?: string; server?: string; token?: string; insecureSkipTlsVerify?: boolean }) => Promise<void> }) {
  const methods = [
    { id: "file", label: tr(language, "kubeconfigFile"), icon: FileUp },
    { id: "paste", label: tr(language, "pasteConfig"), icon: Copy },
    { id: "manual", label: tr(language, "manual"), icon: Settings },
  ] as const;
  const [mode, setMode] = useState<(typeof methods)[number]["id"]>("file");
  const [fileName, setFileName] = useState("");
  const [clusterName, setClusterName] = useState("");
  const [kubeconfig, setKubeconfig] = useState("");
  const [server, setServer] = useState("https://");
  const [token, setToken] = useState("");
  const [insecure, setInsecure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const applyKubeconfigFile = async (file?: File) => {
    setError("");
    try {
      setFileName(file?.name ?? "");
      setKubeconfig(file ? await file.text() : "");
    } catch (nextError) {
      setFileName("");
      setKubeconfig("");
      setError(String(nextError));
    }
  };
  const chooseKubeconfigFile = async () => {
    setError("");
    if (!nativeBackendAvailable) {
      fileInputRef.current?.click();
      return;
    }
    try {
      const file = await backend.selectKubeconfigFile();
      if (file) {
        setFileName(file.fileName);
        setKubeconfig(file.contents);
      }
    } catch (nextError) { setError(String(nextError)); }
  };
  const suggested = clusterName.trim() || fileName.replace(/\.(yaml|yml|config)$/i, "") || "imported-cluster";
  const addDisabled = busy || (mode === "file" ? !kubeconfig.trim() : mode === "paste" ? !kubeconfig.trim() : !server.startsWith("http") || !token.trim());
  const submit = async () => {
    setBusy(true); setError("");
    try {
      await onAdd(mode === "manual" ? { displayName: suggested, server, token, insecureSkipTlsVerify: insecure } : { displayName: suggested, kubeconfigYaml: kubeconfig });
    } catch (nextError) { setError(String(nextError)); }
    finally { setBusy(false); }
  };
  const focusMode = (nextMode: (typeof methods)[number]["id"]) => {
    setMode(nextMode);
    window.requestAnimationFrame(() => document.getElementById(`add-cluster-tab-${nextMode}`)?.focus());
  };

  return <div className="modal-backdrop add-cluster-backdrop" onMouseDown={onClose}>
    <div className="add-cluster-dialog" onMouseDown={(event) => event.stopPropagation()}>
      <header><h2>{t(language, "addCluster")}</h2><div /><Button variant="ghost" size="icon" aria-label={tr(language, "closeAddCluster")} onClick={onClose}><X size={15} /></Button></header>
      <div className="add-cluster-tabs-row">
        <div className="add-cluster-tabs" role="tablist" aria-label={tr(language, "clusterConnectionMethod")} aria-orientation="horizontal">
          {methods.map(({ id, label, icon: Icon }, index) => <button
            key={id}
            id={`add-cluster-tab-${id}`}
            type="button"
            role="tab"
            data-state={mode === id ? "active" : "inactive"}
            aria-selected={mode === id}
            aria-controls="add-cluster-mode-panel"
            tabIndex={mode === id ? 0 : -1}
            onClick={() => setMode(id)}
            onKeyDown={(event) => {
              let nextIndex = index;
              if (event.key === "ArrowRight") nextIndex = (index + 1) % methods.length;
              else if (event.key === "ArrowLeft") nextIndex = (index - 1 + methods.length) % methods.length;
              else if (event.key === "Home") nextIndex = 0;
              else if (event.key === "End") nextIndex = methods.length - 1;
              else return;
              event.preventDefault();
              focusMode(methods[nextIndex].id);
            }}
          ><Icon size={13} /><span>{label}</span></button>)}
        </div>
      </div>
      <div id="add-cluster-mode-panel" className="add-cluster-body" role="tabpanel" aria-labelledby={`add-cluster-tab-${mode}`}>
        <label className="field-label"><span>{tr(language, "displayName")} <small>{tr(language, "optional")}</small></span><input value={clusterName} onChange={(event) => setClusterName(event.target.value)} placeholder="e.g. production-eu" /></label>
        {mode === "file" && <div className="file-drop" role="button" tabIndex={0} aria-label={tr(language, "chooseFile")} onClick={() => void chooseKubeconfigFile()} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void chooseKubeconfigFile(); } }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void applyKubeconfigFile(event.dataTransfer.files?.[0]); }}><input ref={fileInputRef} type="file" accept=".yaml,.yml,.config" onClick={(event) => event.stopPropagation()} onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; void applyKubeconfigFile(file); }} /><Upload size={22} /><strong>{fileName || tr(language, "dropKubeconfig")}</strong><span>{fileName ? tr(language, "readyToImport") : tr(language, "chooseFile")}</span></div>}
        {mode === "paste" && <label className="field-label"><span>Kubeconfig YAML</span><textarea value={kubeconfig} onChange={(event) => setKubeconfig(event.target.value)} placeholder={'apiVersion: v1\nclusters:\n  - cluster: ...'} /></label>}
        {mode === "manual" && <><label className="field-label"><span>{tr(language, "apiServerUrl")}</span><input value={server} onChange={(event) => setServer(event.target.value)} placeholder="https://kubernetes.example.com:6443" /></label><label className="field-label"><span>{tr(language, "bearerToken")}</span><textarea rows={3} value={token} onChange={(event) => setToken(event.target.value)} placeholder="eyJhbGciOiJSUzI1NiIs..." /></label><label className="settings-input-row"><span>{tr(language, "skipTlsVerification")}</span><ToggleSwitch label={tr(language, "skipTlsVerification")} checked={insecure} onChange={setInsecure} /></label></>}
        <div className="import-note"><ShieldCheck size={14} /><span>{tr(language, "credentialsNotice")}</span></div>{error && <div className="related-empty">{error}</div>}
      </div>
      <footer><span>{mode === "file" ? tr(language, "kubeconfigSupported") : tr(language, "connectionValidated")}</span><div /><Button variant="outline" size="sm" onClick={onClose}>{t(language, "cancel")}</Button><Button size="sm" disabled={addDisabled} onClick={() => void submit()}>{busy && <LoaderCircle className="spin" size={13} />} {t(language, "add")}</Button></footer>
    </div>
  </div>;
}

function CommandPalette({ language, onClose, onNavigate, onTerminal, onCreate }: { language: AppLanguage; onClose: () => void; onNavigate: (item: string) => void; onTerminal: () => void; onCreate: () => void }) {
  const [query, setQuery] = useState("");
  const commands = [
    ...navGroups.flatMap((group) => group.items).map((item) => ({ label: tr(language, "goTo", { resource: resourceLabel(language, item) }), run: () => onNavigate(item) })),
    { label: tr(language, "openClusterTerminal"), run: onTerminal },
    { label: tr(language, "createResource"), run: onCreate },
  ].filter((command) => command.label.toLowerCase().includes(query.toLowerCase())).slice(0, 12);
  return <div className="modal-backdrop" onMouseDown={onClose}><div className="command-modal" onMouseDown={(event) => event.stopPropagation()}><div className="command-input"><Search size={17} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && commands[0]) { commands[0].run(); onClose(); } }} placeholder={tr(language, "commandSearch")} /><kbd>ESC</kbd></div><p>{query ? tr(language, "results") : tr(language, "quickActions")}</p>{commands.map((command) => <button key={command.label} onClick={() => { command.run(); onClose(); }}><span className="command-key"><Command size={14} /></span>{command.label}<kbd>↵</kbd></button>)}{commands.length === 0 && <div className="related-empty">{tr(language, "noMatchingCommand")}</div>}</div></div>;
}

async function loadPodMetrics(clusterId: string, row: ResourceRow, rangeHours: MetricsRange): Promise<PodMetrics | null> {
  if (!nativeBackendAvailable || !row.namespace || row.namespace === "—") return null;
  const response: PodMetricsResponse | null = await backend.podMetrics({ clusterId, namespace: row.namespace, pod: row.name, rangeHours });
  return response ? { ...response, source: "prometheus" } : null;
}

export default function App() {
  const [availableClusters, setAvailableClusters] = useState<Cluster[]>([unconfiguredCluster]);
  const [cluster, setCluster] = useState<Cluster>(unconfiguredCluster);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("clusters");
  const [clusterOperationId, setClusterOperationId] = useState<string | null>(null);
  const [clusterConnection, setClusterConnection] = useState<ClusterConnectionState | null>(null);
  const clusterOrderHydratedRef = useRef(false);
  const clusterConnectionAttemptRef = useRef<{ clusterId: string; operationId: string; cancelled: boolean } | null>(null);
  const [initialClusterWorkspaces] = useState<Record<string, ClusterWorkspaceState>>(() => loadClusterWorkspaces());
  const clusterWorkspacesRef = useRef(initialClusterWorkspaces);
  const [selectedNamespaces, setSelectedNamespaces] = useState<string[]>([]);
  const [navOpen, setNavOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState>(initialUpdateState);
  const [addClusterOpen, setAddClusterOpen] = useState(false);
  const [clusterSettingsId, setClusterSettingsId] = useState<string | null>(null);
  const [tabs, setTabs] = useState<ResourceTab[]>(() => defaultClusterWorkspace().tabs);
  const [activeTabId, setActiveTabId] = useState("overview");
  const [detail, setDetail] = useState<DetailItem | null>(null);
  const detailRequestRef = useRef(0);
  const metricsRequestRef = useRef(0);
  const [bottomSessions, setBottomSessions] = useState<BottomSession[]>([]);
  const [activeBottomId, setActiveBottomId] = useState("");
  const [bottomCollapsed, setBottomCollapsed] = useState(false);
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [terminalRuntimes, setTerminalRuntimesState] = useState<TerminalRuntimeMap>({});
  const terminalRuntimesRef = useRef<TerminalRuntimeMap>({});
  const [bottomSessionCaches, setBottomSessionCachesState] = useState<BottomSessionCacheMap>({});
  const bottomSessionCachesRef = useRef<BottomSessionCacheMap>({});
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [alertCount, setAlertCount] = useState(0);
  const [discoveredResources, setDiscoveredResources] = useState<ApiResourceDescriptor[]>([]);
  const [clusterNamespaces, setClusterNamespaces] = useState<string[]>([]);
  const [dataRevision, setDataRevision] = useState(0);
  const [backendError, setBackendError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ResourceRow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [scaleTarget, setScaleTarget] = useState<ResourceRow | null>(null);
  const [scaleBusy, setScaleBusy] = useState(false);
  const [scaleError, setScaleError] = useState("");
  const [portForwardDialog, setPortForwardDialog] = useState<PortForwardDialogState | null>(null);
  const [portForwardSessions, setPortForwardSessions] = useState<PortForwardSession[]>([]);
  const [portForwardBusy, setPortForwardBusy] = useState(false);
  const [portForwardError, setPortForwardError] = useState("");
  const [drainTarget, setDrainTarget] = useState<ResourceRow | null>(null);
  const [drainBusy, setDrainBusy] = useState(false);
  const [drainError, setDrainError] = useState("");
  const [drainResult, setDrainResult] = useState<DrainNodeResult | null>(null);
  const [cordonTarget, setCordonTarget] = useState<ResourceRow | null>(null);
  const [cordonBusy, setCordonBusy] = useState(false);
  const [cordonError, setCordonError] = useState("");
  const [taintTarget, setTaintTarget] = useState<ResourceRow | null>(null);
  const [taintError, setTaintError] = useState("");
  const [toast, setToast] = useState<AppToast | null>(null);
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("dark");
  const [preferences, setPreferences] = useState<Preferences>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("kubehive.preferences") ?? "{}") as Partial<Preferences> & { language?: string };
      const language: AppLanguage = saved.language === "zh-TW" ? "zh-TW" : saved.language === "zh-CN" || saved.language === "zh-K8s" ? "zh-CN" : "en";
      const savedFontSize = Number(saved.contentFontSize);
      const contentFontSize = contentFontSizes.includes(savedFontSize as Preferences["contentFontSize"])
        ? savedFontSize as Preferences["contentFontSize"]
        : defaultPreferences.contentFontSize;
      const hasSavedFont = typeof saved.contentFont === "string" && saved.contentFont.trim().length > 0;
      let contentFont = hasSavedFont ? saved.contentFont!.trim() : defaultPreferences.contentFont;
      // One-shot: replace the historical generic monospace default on Windows.
      const fontDefaultsVersion = Number(localStorage.getItem("kubehive.fontDefaultsVersion") || 0);
      if (fontDefaultsVersion < 1) {
        if (platform === "windows" && (!hasSavedFont || contentFont === "monospace")) {
          contentFont = defaultContentFont(platform);
        }
        localStorage.setItem("kubehive.fontDefaultsVersion", "1");
      }
      return { ...defaultPreferences, ...saved, language, contentFontSize, contentFont };
    } catch { return defaultPreferences; }
  });
  // Session-only zoom state. The window factor lives in the zoom module; content
  // zoom lives here and is deliberately never written back to `preferences`.
  const [contentZoomFactor, setContentZoomFactor] = useState(1);
  const changeWindowZoom = useCallback((factor: number) => {
    void applyWindowZoom(factor).catch(() => { /* Browser prototype or unsupported platform. */ });
  }, []);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const resource = activeTab.resource;
  const language = preferences.language;
  const contentAppearance = preferences.contentTheme === "system" ? resolvedTheme : preferences.contentTheme;
  const activeCluster = availableClusters.find((item) => item.id === cluster.id) ?? cluster;
  const accent = clusterAccent(activeCluster);
  const clusterSettingsTarget = availableClusters.find((item) => item.id === clusterSettingsId) ?? null;
  const openSettings = useCallback(() => {
    setAboutOpen(false);
    setAlertsOpen(false);
    setSettingsOpen(true);
    setDetail(null);
  }, []);
  const openAbout = useCallback(() => {
    setSettingsOpen(false);
    setAlertsOpen(false);
    setAboutOpen(true);
    setDetail(null);
  }, []);
  const checkUpdates = useCallback(async () => {
    if (!nativeBackendAvailable) {
      setUpdateState({ status: "unsupported", update: null, message: "", downloadedBytes: 0, contentLength: null });
      return;
    }
    setUpdateState({ status: "checking", update: null, message: "", downloadedBytes: 0, contentLength: null });
    try {
      const update = await checkForUpdate();
      setUpdateState(update
        ? { status: "available", update, message: "", downloadedBytes: 0, contentLength: null }
        : { status: "current", update: null, message: "", downloadedBytes: 0, contentLength: null });
    } catch (error) {
      setUpdateState({ status: "error", update: null, message: String(error), downloadedBytes: 0, contentLength: null });
    }
  }, []);
  const openAboutAndCheckUpdates = useCallback(() => {
    openAbout();
    void checkUpdates();
  }, [checkUpdates, openAbout]);
  const installUpdate = useCallback(async () => {
    const update = updateState.update;
    if (!update) return;
    setUpdateState({ status: "downloading", update, message: "", downloadedBytes: 0, contentLength: null });
    try {
      await installAndRelaunch(update, (event) => setUpdateState((current) => updateProgress(event, current)));
    } catch (error) {
      setUpdateState({ status: "error", update, message: String(error), downloadedBytes: 0, contentLength: null });
    }
  }, [updateState.update]);
  useEffect(() => {
    if (!nativeBackendAvailable) return;
    let unlisten: (() => void) | undefined;
    void listen<TrayAction>("kubehive://tray-action", (event) => {
      if (event.payload === "settings") openSettings();
      else if (event.payload === "about") openAbout();
      else if (event.payload === "check-updates") openAboutAndCheckUpdates();
    }).then((dispose) => { unlisten = dispose; }).catch((error) => {
      setUpdateState({ status: "error", update: null, message: String(error), downloadedBytes: 0, contentLength: null });
    });
    return () => { unlisten?.(); };
  }, [openAbout, openAboutAndCheckUpdates, openSettings]);
  useEffect(() => {
    if (preferences.autoUpdate && nativeBackendAvailable) void checkUpdates();
  }, [checkUpdates, preferences.autoUpdate]);
  useEffect(() => {
    if (!nativeBackendAvailable || activeCluster.disconnected) { setPortForwardSessions([]); return; }
    let cancelled = false;
    const refresh = () => { void backend.listPortForwards(activeCluster.id).then((sessions) => {
      if (!cancelled) setPortForwardSessions(sessions);
    }).catch(() => { if (!cancelled) setPortForwardSessions([]); }); };
    refresh();
    const timer = window.setInterval(refresh, 3_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [activeCluster.id, activeCluster.disconnected, dataRevision]);
  terminalRuntimesRef.current = terminalRuntimes;
  const updateTerminalRuntimes: RuntimeMapUpdater<TerminalRuntimeMap> = (update) => {
    setTerminalRuntimesState((current) => {
      const next = update(current);
      terminalRuntimesRef.current = next;
      return next;
    });
  };
  const updateBottomSessionCaches: RuntimeMapUpdater<BottomSessionCacheMap> = (update) => {
    setBottomSessionCachesState((current) => {
      const next = update(current);
      bottomSessionCachesRef.current = next;
      return next;
    });
  };
  const stopNodeFileSessions = (clusterId: string, sessionIds: string[]) => {
    sessionIds.forEach((id) => {
      const cache = bottomSessionCachesRef.current[`${clusterId}::${id}`];
      if (cache?.nodeFileTarget && cache.nodeFileName && nativeBackendAvailable) void backend.stopNodeFileSession({ clusterId, node: cache.nodeFileName });
    });
  };
  const disposeBottomSessions = (clusterId: string, sessionIds: string[]) => {
    if (!sessionIds.length) return;
    const discarded = new Set(sessionIds.map((id) => `${clusterId}::${id}`));
    discarded.forEach((id) => {
      const runtime = terminalRuntimesRef.current[id];
      if (runtime?.sessionId && nativeBackendAvailable) void backend.stopTerminal(runtime.sessionId);
    });
    stopNodeFileSessions(clusterId, sessionIds);
    updateTerminalRuntimes((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !discarded.has(id))));
    updateBottomSessionCaches((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !discarded.has(id))));
  };
  const disposeClusterSessions = (clusterId: string) => {
    const prefix = `${clusterId}::`;
    const discarded = Object.keys(terminalRuntimesRef.current).filter((id) => id.startsWith(prefix));
    discarded.forEach((id) => {
      const runtime = terminalRuntimesRef.current[id];
      if (runtime?.sessionId && nativeBackendAvailable) void backend.stopTerminal(runtime.sessionId);
    });
    const nodeFileSessionIds = Object.entries(bottomSessionCachesRef.current)
      .filter(([id]) => id.startsWith(prefix) && Boolean(bottomSessionCachesRef.current[id]?.nodeFileTarget))
      .map(([id]) => id.slice(prefix.length));
    stopNodeFileSessions(clusterId, nodeFileSessionIds);
    updateTerminalRuntimes((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !id.startsWith(prefix))));
    updateBottomSessionCaches((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !id.startsWith(prefix))));
  };
  const persistClusterWorkspace = (clusterId: string, workspace: ClusterWorkspaceState) => {
    if (!clusterId || clusterId === "unconfigured") return;
    clusterWorkspacesRef.current = { ...clusterWorkspacesRef.current, [clusterId]: normalizeClusterWorkspace(workspace) };
    try { localStorage.setItem(clusterWorkspaceStorageKey, JSON.stringify(clusterWorkspacesRef.current)); } catch { /* ignore unavailable storage */ }
  };
  const captureActiveClusterWorkspace = () => {
    if (workspaceView !== "cluster" || activeCluster.id === "unconfigured" || activeCluster.disconnected) return;
    persistClusterWorkspace(activeCluster.id, { tabs, activeTabId, namespaces: selectedNamespaces, bottomSessions, activeBottomId, bottomCollapsed });
  };
  const restoreClusterWorkspace = (clusterId: string) => {
    const workspace = normalizeClusterWorkspace(clusterWorkspacesRef.current[clusterId]);
    setTabs(workspace.tabs.map((tab) => ({ ...tab })));
    setActiveTabId(workspace.activeTabId);
    setSelectedNamespaces(workspace.namespaces);
    setBottomSessions(workspace.bottomSessions.map((session) => ({ ...session })));
    setActiveBottomId(workspace.activeBottomId);
    setBottomCollapsed(workspace.bottomCollapsed);
    setDetail(null);
  };
  const clearCachedClusterSessions = (clusterId: string) => {
    const workspace = normalizeClusterWorkspace(clusterWorkspacesRef.current[clusterId]);
    persistClusterWorkspace(clusterId, { ...workspace, bottomSessions: [], activeBottomId: "", bottomCollapsed: false });
  };
  const forgetClusterWorkspace = (clusterId: string) => {
    const next = { ...clusterWorkspacesRef.current };
    delete next[clusterId];
    clusterWorkspacesRef.current = next;
    try { localStorage.setItem(clusterWorkspaceStorageKey, JSON.stringify(next)); } catch { /* ignore unavailable storage */ }
  };

  useEffect(() => () => {
    if (!nativeBackendAvailable) return;
    Object.values(terminalRuntimesRef.current).forEach((runtime) => {
      if (runtime.sessionId) void backend.stopTerminal(runtime.sessionId);
    });
    Object.entries(bottomSessionCachesRef.current).forEach(([id, cache]) => {
      if (cache?.nodeFileTarget && cache.nodeFileName) {
        const clusterId = id.split("::")[0];
        if (clusterId) void backend.stopNodeFileSession({ clusterId, node: cache.nodeFileName });
      }
    });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast((current) => current?.id === toast.id ? null : current), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const showToast = (tone: AppToast["tone"], message: string, filePath?: string) => setToast({ id: Date.now(), tone, message, filePath });
  const copyDetailValue: DetailCopyHandler = (value, label = "Value") => {
    if (!value || value === "—") return;
    if (!navigator.clipboard?.writeText) {
      showToast("error", `Unable to copy ${label.toLowerCase()}`);
      return;
    }
    void navigator.clipboard.writeText(value)
      .then(() => showToast("success", `${label} copied to clipboard`))
      .catch(() => showToast("error", `Unable to copy ${label.toLowerCase()}`));
  };
  const openToastFile = async (filePath: string) => {
    try {
      await openPath(filePath);
      setToast(null);
    } catch (error) {
      setToast({ id: Date.now(), tone: "error", message: `Unable to open downloaded file: ${String(error)}` });
    }
  };

  useEffect(() => {
    if (!nativeBackendAvailable) return;
    let cancelled = false;
    backend.listClusters().then((items) => {
      if (cancelled) return;
      let colors: Record<string, string> = {}; try { colors = JSON.parse(localStorage.getItem("kubehive.clusterColors") ?? "{}"); } catch { /* ignore invalid local preference */ }
      const next = applySavedClusterOrder(items.length ? items.map((item) => ({ ...item, color: colors[item.id] } as Cluster)) : [unconfiguredCluster]);
      clusterOrderHydratedRef.current = true;
      setAvailableClusters(next);
      setCluster(next[0]);
      setWorkspaceView("clusters");
      setBackendError("");
    }).catch((error) => { if (!cancelled) { setBackendError(String(error)); setAvailableClusters([unconfiguredCluster]); setCluster(unconfiguredCluster); setWorkspaceView("clusters"); } });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!clusterOrderHydratedRef.current) return;
    try { localStorage.setItem(clusterOrderStorageKey, JSON.stringify(availableClusters.filter((item) => item.id !== "unconfigured").map((item) => item.id))); } catch { /* ignore unavailable storage */ }
  }, [availableClusters]);

  useEffect(() => {
    if (!nativeBackendAvailable || workspaceView !== "cluster" || activeCluster.id === "unconfigured" || activeCluster.disconnected) return;
    let cancelled = false;
    setDiscoveredResources([]);
    backend.discoverResources(activeCluster.id).then(async (resources) => {
      if (cancelled) return;
      setDiscoveredResources(resources);
      const namespaceResource = descriptorForResource("Namespaces", resources);
      if (namespaceResource) {
        const response = await backend.listResources({ clusterId: activeCluster.id, resource: namespaceResource });
        if (!cancelled) setClusterNamespaces(response.items.map((item) => item.name).sort());
      }
    }).catch((error) => { if (!cancelled) setBackendError(String(error)); });
    return () => { cancelled = true; };
  }, [activeCluster.id, activeCluster.disconnected, dataRevision, workspaceView]);

  useEffect(() => {
    if (!nativeBackendAvailable) return;
    void backend.setProxy(preferences.proxyEnabled, preferences.proxyEnabled ? preferences.proxyUrl : undefined).catch((error) => setBackendError(String(error)));
  }, [preferences.proxyEnabled, preferences.proxyUrl]);

  useEffect(() => {
    localStorage.setItem("kubehive.preferences", JSON.stringify(preferences));
    document.documentElement.lang = preferences.language === "en" ? "en" : preferences.language === "zh-TW" ? "zh-TW" : "zh-CN";
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const next = preferences.theme === "system" ? (media.matches ? "light" : "dark") : preferences.theme;
      setResolvedTheme(next);
      document.documentElement.classList.toggle("theme-light", next === "light");
      document.documentElement.classList.toggle("theme-dark", next === "dark");
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preferences]);

  useEffect(() => {
    if (workspaceView !== "cluster" || activeCluster.id === "unconfigured" || activeCluster.disconnected) return;
    persistClusterWorkspace(activeCluster.id, { tabs, activeTabId, namespaces: selectedNamespaces, bottomSessions, activeBottomId, bottomCollapsed });
  }, [activeCluster.id, activeCluster.disconnected, activeTabId, selectedNamespaces, tabs, bottomSessions, activeBottomId, bottomCollapsed, workspaceView]);

  const openResourcePage = (nextResource: string, crd?: Pick<CustomResourceDefinition, "name" | "kind">, options?: { permanent?: boolean }) => {
    const permanent = Boolean(options?.permanent);
    const id = nextResource === "Overview" && !crd ? "overview" : resourceTabId(nextResource, crd);
    if (id === "overview") {
      setActiveTabId("overview");
      setDetail(null);
      return;
    }
    const nextTab: ResourceTab = {
      id,
      label: crd?.kind ?? nextResource,
      resource: nextResource,
      crdKind: crd?.kind,
      crdName: crd?.name,
      preview: !permanent,
    };
    setTabs((current) => {
      const existingIndex = current.findIndex((tab) => tab.id === id);
      if (existingIndex >= 0) {
        if (!permanent) return current;
        return current.map((tab, index) => index === existingIndex ? { ...tab, preview: false } : tab);
      }
      if (permanent) return [...current, { ...nextTab, preview: false }];
      const previewIndex = current.findIndex(isPreviewTab);
      if (previewIndex >= 0) {
        const copy = current.slice();
        copy[previewIndex] = nextTab;
        return copy;
      }
      return [...current, nextTab];
    });
    setActiveTabId(id);
    setDetail(null);
  };
  const keepTabOpen = (id: string) => {
    if (id === "overview") return;
    setTabs((current) => current.map((tab) => tab.id === id ? { ...tab, preview: false } : tab));
  };
  const detailIdForRow = (row: ResourceRow) => `resource:${JSON.stringify([
    activeCluster.id,
    row.descriptor?.apiVersion ?? row.backend?.apiVersion ?? "",
    row.kind,
    row.namespace,
    row.name,
    row.backend?.uid ?? row.key,
  ])}`;
  const baseDetailForRow = (row: ResourceRow): DetailItem => ({
    id: detailIdForRow(row),
    label: row.name,
    subtitle: row.namespace,
    type: row.kind === "CustomResource" ? "crd" : "resource",
    kind: row.kind,
    status: row.status,
    row,
    loading: Boolean(nativeBackendAvailable && row.backend && row.descriptor),
    relationsLoading: nativeBackendAvailable,
    relations: [],
    ...(row.kind === "Pod" ? { metricsLoading: nativeBackendAvailable, metricsRange: 1 as MetricsRange } : {}),
  });
  const fetchDetailForRow = async (row: ResourceRow) => {
    const base = baseDetailForRow(row);
    if (!nativeBackendAvailable || !row.backend || !row.descriptor) return base;
    try {
      const response = await backend.getResource({ clusterId: activeCluster.id, resource: row.descriptor, namespace: row.namespace === "—" ? undefined : row.namespace, name: row.kind === "HelmRelease" ? row.backend.name : row.name });
      return { ...base, row: row.kind === "HelmRelease" ? row : rowFromBackend(response, row.descriptor), manifest: response.manifest, loading: false };
    } catch (error) {
      return { ...base, loading: false, error: String(error) };
    }
  };
  const reloadPodMetrics = (row: ResourceRow, range: MetricsRange, detailId = detailIdForRow(row)) => {
    if (row.kind !== "Pod") return;
    const requestId = ++metricsRequestRef.current;
    setDetail((current) => current?.id === detailId ? { ...current, metricsLoading: true, metricsRange: range } : current);
    void loadPodMetrics(activeCluster.id, row, range).then((metrics) => {
      if (metricsRequestRef.current !== requestId) return;
      setDetail((current) => current?.id === detailId && current.metricsRange === range ? { ...current, metrics: metrics ?? undefined, metricsLoading: false, metricsError: undefined } : current);
    }).catch(() => {
      if (metricsRequestRef.current !== requestId) return;
      setDetail((current) => current?.id === detailId && current.metricsRange === range ? { ...current, metrics: undefined, metricsLoading: false, metricsError: undefined } : current);
    });
  };
  const openResourceRow = (row: ResourceRow) => {
    const requestId = ++detailRequestRef.current;
    const base = baseDetailForRow(row);
    setDetail(base);
    void (async () => {
      const hydrated = await fetchDetailForRow(row);
      if (detailRequestRef.current !== requestId) return;
      const hydratedRow = hydrated.row ?? row;
      const pod = hydratedRow.kind === "Pod";
      setDetail((current) => current?.id === hydrated.id ? { ...hydrated, relationsLoading: nativeBackendAvailable, relations: current.relations ?? [], metricsLoading: pod && nativeBackendAvailable, metrics: undefined, metricsError: undefined, metricsRange: 1 } : current);
      if (pod && nativeBackendAvailable) reloadPodMetrics(hydratedRow, 1, hydrated.id);
      if (!nativeBackendAvailable) return;
      try {
        const relations = await resolveResourceRelations(activeCluster.id, hydratedRow, discoveredResources);
        if (detailRequestRef.current !== requestId) return;
        setDetail((current) => current?.id === hydrated.id ? { ...current, relations, relationsLoading: false, relationsError: undefined } : current);
      } catch (error) {
        if (detailRequestRef.current !== requestId) return;
        setDetail((current) => current?.id === hydrated.id ? { ...current, relationsLoading: false, relationsError: String(error) } : current);
      }
    })();
  };
  const openRelatedLink = (link: ResourceLink, row: ResourceRow) => {
    const requestId = ++detailRequestRef.current;
    const namespace = link.namespace ?? (row.namespace === "—" ? undefined : row.namespace);
    const id = `related:${JSON.stringify([activeCluster.id, link.apiVersion ?? "", link.kind, namespace ?? "cluster", link.name])}`;
    const related: RelatedDetail = { relation: link.relation, kind: link.kind, name: link.name, namespace, from: `${row.kind}/${row.name}`, status: tr(language, "resolving") };
    setDetail({ id, label: link.name, subtitle: namespace ?? link.relation, type: "related", kind: link.kind, related, loading: true });
    void resolveResourceLink(activeCluster.id, { ...link, namespace }, discoveredResources).then((resolved) => {
      if (detailRequestRef.current !== requestId) return;
      if (resolved) openResourceRow(resolved);
      else setDetail((current) => current?.id === id ? { ...current, loading: false, error: `Unable to resolve ${link.kind}/${link.name}` } : current);
    }).catch((error) => {
      if (detailRequestRef.current !== requestId) return;
      setDetail((current) => current?.id === id ? { ...current, loading: false, error: String(error) } : current);
    });
  };
  const openBottomSession = (request: BottomRequest) => {
    const id = `${request.mode}:${request.sessionKey ?? request.item?.id ?? (request.mode === "create" ? activeTabId : "cluster")}`;
    const session: BottomSession = { ...request, id };
    setBottomSessions((current) => current.some((item) => item.id === id) ? current.map((item) => item.id === id ? session : item) : [...current, session]);
    setActiveBottomId(id); setBottomCollapsed(false);
  };
  const openCreateSession = (descriptor?: ApiResourceDescriptor | null) => {
    const effective = descriptor ?? descriptorForResource(resource, discoveredResources) ?? undefined;
    const namespaced = effective?.namespaced ?? true;
    const manifest = `apiVersion: ${effective?.apiVersion ?? "v1"}\nkind: ${effective?.kind ?? "ConfigMap"}\nmetadata:\n  name: new-${(effective?.kind ?? "resource").toLowerCase()}${namespaced ? `\n  namespace: ${namespace === "All namespaces" ? "default" : namespace}` : ""}\n${effective?.kind === "ConfigMap" ? "data:\n  key: value" : "spec: {}"}`;
    openBottomSession({ mode: "create", sessionKey: `create-${effective?.apiVersion ?? "v1"}-${effective?.kind ?? "resource"}`, label: effective?.kind ?? resource, descriptor: effective, manifest });
  };
  const requestPortForward = (targetRow?: ResourceRow, preferredPort?: number, showPortSelect = true) => {
    if (!nativeBackendAvailable) { setBackendError("Port forwarding is available in the native Tauri application."); return; }
    if (!targetRow || !["Pod", "Service"].includes(targetRow.kind)) { setBackendError("Select a Pod or Service with a declared port before creating a port forward."); return; }
    if (!targetRow.namespace || targetRow.namespace === "—") { setBackendError("Port forwarding requires a namespaced Pod or Service."); return; }
    const ports = forwardablePortsFor(targetRow);
    const selected = ports.find((entry) => entry.port === preferredPort && entry.forwardable) ?? ports.find((entry) => entry.forwardable);
    if (!selected) {
      setBackendError(targetRow.kind === "Pod" ? "This Pod has no declared TCP ports to forward." : "This Service has no declared TCP ports to forward.");
      return;
    }
    setPortForwardError("");
    setPortForwardDialog({ row: targetRow, ports, selectedPort: selected.port, showPortSelect });
  };
  const openPortForwardSession = async (session: PortForwardSession) => {
    const url = portForwardAddress(session);
    if (session.status !== "Active") { setBackendError(`Cannot open ${url}; the port-forward status is ${session.status}.`); return; }
    try {
      if (nativeBackendAvailable) await openUrl(url); else window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      setBackendError(`Unable to open ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const pausePortForwardSession = async (session: PortForwardSession) => {
    try {
      const paused = await backend.pausePortForward(session.id);
      setPortForwardSessions((current) => current.map((item) => item.id === paused.id ? paused : item));
      setDataRevision((value) => value + 1);
      showToast("success", `Paused port forwarding on ${session.host}:${session.localPort}`);
    } catch (error) {
      setBackendError(error instanceof Error ? error.message : String(error));
    }
  };
  const resumePortForwardSession = async (session: PortForwardSession) => {
    try {
      const resumed = await backend.resumePortForward(session.id);
      setPortForwardSessions((current) => current.map((item) => item.id === resumed.id ? resumed : item));
      setDataRevision((value) => value + 1);
      showToast("success", `Resumed port forwarding on ${resumed.host}:${resumed.localPort}`);
    } catch (error) {
      setBackendError(error instanceof Error ? error.message : String(error));
    }
  };
  const stopPortForwardSession = async (session: PortForwardSession) => {
    try {
      const stopped = await backend.stopPortForward(session.id);
      if (!stopped) throw new Error("The port-forward session is no longer active.");
      setPortForwardSessions((current) => current.filter((item) => item.id !== session.id));
      setDataRevision((value) => value + 1);
      showToast("success", `Stopped port forwarding on ${session.host}:${session.localPort}`);
      return true;
    } catch (error) {
      setBackendError(error instanceof Error ? error.message : String(error));
      return false;
    }
  };
  const confirmPortForward = async (options: { remotePort: number; localPort: number; host: "localhost" | "0.0.0.0"; protocol: "http" | "https"; openBrowser: boolean }) => {
    const target = portForwardDialog;
    if (!target || portForwardBusy) return;
    const targetKind = target.row.kind === "Service" ? "service" : "pod";
    const existing = portForwardSessions.find((session) => portForwardMatches(session, target.row, options.remotePort));
    if (existing) {
      setPortForwardError(`Port ${options.remotePort} is already forwarded at ${portForwardAddress(existing)}.`);
      return;
    }
    setPortForwardBusy(true);
    setPortForwardError("");
    try {
      const session = await backend.startPortForward({ clusterId: activeCluster.id, namespace: target.row.namespace, targetKind, targetName: target.row.name, host: options.host, protocol: options.protocol, localPort: options.localPort, remotePort: options.remotePort });
      const targetLabel = `${session.targetKind === "service" ? "Service" : "Pod"}/${session.targetName}`;
      const endpointLabel = session.targetKind === "service" ? ` · endpoint Pod/${session.pod}:${session.remotePort}` : "";
      const localAddress = `${session.host}:${session.localPort}`;
      setBackendError("");
      showToast("success", `Port forward active: ${localAddress} → ${targetLabel}:${session.servicePort ?? session.remotePort}${endpointLabel}`);
      setPortForwardDialog(null);
      setDataRevision((value) => value + 1);
      setPortForwardSessions((current) => [...current.filter((item) => item.id !== session.id), session]);
      if (options.openBrowser) await openPortForwardSession(session);
    } catch (error) {
      setPortForwardError(error instanceof Error ? error.message : String(error));
    } finally {
      setPortForwardBusy(false);
    }
  };
  const closeResourceDelete = () => {
    if (deleteBusy) return;
    setDeleteTarget(null);
    setDeleteError("");
  };
  const closeResourceScale = () => {
    if (scaleBusy) return;
    setScaleTarget(null);
    setScaleError("");
  };
  const closeResourceDrain = () => {
    if (drainBusy) return;
    setDrainTarget(null);
    setDrainError("");
    setDrainResult(null);
  };
  const closeResourceCordon = () => {
    if (cordonBusy) return;
    setCordonTarget(null);
    setCordonError("");
  };
  const confirmResourceCordon = async () => {
    const row = cordonTarget;
    if (!row || cordonBusy) return;
    setCordonBusy(true);
    setCordonError("");
    try {
      if (!nativeBackendAvailable) throw new Error(tr(language, "nativeAppRequired"));
      await backend.setNodeUnschedulable(activeCluster.id, row.name, true);
      setCordonTarget(null);
      setDetail(null);
      setDataRevision((value) => value + 1);
      setBackendError("");
      showToast("success", tr(language, "nodeCordoned", { name: row.name }));
    } catch (error) {
      setCordonError(error instanceof Error ? error.message : String(error));
    } finally {
      setCordonBusy(false);
    }
  };
  const closeResourceTaints = () => {
    setTaintTarget(null);
    setTaintError("");
  };
  const confirmResourceDrain = async (options: { ignoreDaemonsets: boolean; deleteEmptyDirData: boolean; force: boolean; disableEviction: boolean; waitForDeletion: boolean; timeoutSeconds: number }) => {
    const row = drainTarget;
    if (!row || drainBusy) return;
    setDrainBusy(true);
    setDrainError("");
    setDrainResult(null);
    try {
      if (!nativeBackendAvailable) throw new Error(tr(language, "nativeAppRequired"));
      const result = await backend.drainNode({ clusterId: activeCluster.id, node: row.name, ...options });
      setDrainResult(result);
      if (result.failures.length === 0 && result.remaining.length === 0) {
        setDrainTarget(null);
        setDrainResult(null);
        setDetail(null);
        setDataRevision((value) => value + 1);
        setBackendError("");
        showToast("success", tr(language, "drainComplete", { name: row.name, evicted: result.evicted, skipped: result.skipped }));
      }
    } catch (error) {
      setDrainError(error instanceof Error ? error.message : String(error));
    } finally {
      setDrainBusy(false);
    }
  };
  const confirmResourceScale = async (replicas: number) => {
    const row = scaleTarget;
    if (!row || scaleBusy) return;
    setScaleBusy(true);
    setScaleError("");
    try {
      if (!nativeBackendAvailable) throw new Error("Resource scaling is available in the native KubeHive application.");
      if (!row.descriptor) throw new Error(`No Kubernetes API mapping is available for ${row.kind}`);
      await backend.scaleResource({
        clusterId: activeCluster.id,
        resource: row.descriptor,
        namespace: row.namespace === "—" ? undefined : row.namespace,
        name: row.name,
        replicas,
      });
      setScaleTarget(null);
      setDetail(null);
      setDataRevision((value) => value + 1);
      setBackendError("");
      showToast("success", tr(language, "scaleRequested", { kind: row.kind, name: row.name, replicas }));
    } catch (error) {
      setScaleError(error instanceof Error ? error.message : String(error));
    } finally {
      setScaleBusy(false);
    }
  };
  const confirmResourceDelete = async () => {
    const row = deleteTarget;
    if (!row || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      if (!nativeBackendAvailable) throw new Error("Resource deletion is available in the native KubeHive application.");
      if (row.kind === "PortForward") {
        const stopped = await backend.stopPortForward(row.key);
        if (!stopped) throw new Error("The port-forward session is no longer active.");
      } else {
        if (!row.descriptor) throw new Error(`No Kubernetes API mapping is available for ${row.kind}`);
        if (!row.descriptor.verbs.includes("delete")) throw new Error(`The current Kubernetes credentials cannot delete ${row.kind} resources`);
        await backend.deleteResource({
          clusterId: activeCluster.id,
          resource: row.descriptor,
          namespace: row.namespace === "—" ? undefined : row.namespace,
          name: row.name,
          foreground: false,
        });
      }
      setDeleteTarget(null);
      setDetail(null);
      setDataRevision((value) => value + 1);
      setBackendError("");
      showToast("success", row.kind === "PortForward" ? `Stopped port forwarding for ${row.name}` : `Deletion requested for ${row.kind}/${row.name}`);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleteBusy(false);
    }
  };
  const performResourceAction = async (action: string, row: ResourceRow) => {
    if (action === "Delete") { setDeleteTarget(row); setDeleteError(""); return; }
    if (action === "Scale") { setScaleTarget(row); setScaleError(""); return; }
    if (action === "Open Port Forward" || action === "Pause Port Forward" || action === "Resume Port Forward" || action === "Stop Port Forward") {
      const session = portForwardSessions.find((item) => item.id === row.key);
      if (!session) { setBackendError("The port-forward session is no longer active."); return; }
      if (action === "Open Port Forward") void openPortForwardSession(session);
      else if (action === "Pause Port Forward") void pausePortForwardSession(session);
      else if (action === "Resume Port Forward") void resumePortForwardSession(session);
      else void stopPortForwardSession(session);
      return;
    }
    if (action === "Port Forward") { requestPortForward(row, undefined, true); return; }
    if (action === "Cordon" || action === "Uncordon") {
      if (!nativeBackendAvailable) return;
      if (action === "Cordon") { setCordonTarget(row); setCordonError(""); return; }
      try {
        await backend.setNodeUnschedulable(activeCluster.id, row.name, false);
        showToast("success", tr(language, "nodeUncordoned", { name: row.name }));
        setDetail(null); setDataRevision((value) => value + 1); setBackendError("");
      } catch (error) { setBackendError(String(error)); }
      return;
    }
    if (action === "Drain") {
      if (!nativeBackendAvailable) return;
      setDrainTarget(row); setDrainError(""); setDrainResult(null);
      return;
    }
    if (action === "Taints") {
      if (!nativeBackendAvailable) return;
      setTaintTarget(row); setTaintError("");
      return;
    }
    const item = await fetchDetailForRow(row);
    if (action === "Logs" || action === "Terminal" || action === "Files") {
      const nodeSession = row.kind === "Node" || item.row?.kind === "Node" || item.kind === "Node";
      const terminalTarget = action === "Terminal" || action === "Files"
        ? (nodeSession ? "node" : "container")
        : undefined;
      openBottomSession({
        mode: action === "Logs" ? "logs" : action === "Terminal" ? "terminal" : "files",
        item,
        label: terminalTarget === "node" ? (row.name || item.label) : undefined,
        terminalTarget,
      });
      setDetail(null);
      return;
    }
    if (action === "Edit") {
      openBottomSession({ mode: "edit", item, manifest: item.manifest, descriptor: row.descriptor, readOnlyReason: manifestReadOnlyReason(row) });
      setDetail(null);
      return;
    }
    if (!nativeBackendAvailable || !row.descriptor) return;
    const target = { clusterId: activeCluster.id, resource: row.descriptor, namespace: row.namespace === "—" ? undefined : row.namespace, name: row.name };
    try {
      if (action === "Evict") {
        if (row.kind !== "Pod" || row.namespace === "—") throw new Error(tr(language, "onlyNamespacedPods"));
        if (!window.confirm(tr(language, "evictPrompt", { name: row.name }))) return;
        await backend.evictPod({ clusterId: activeCluster.id, namespace: row.namespace, pod: row.name });
      } else if (action === "Restart") {
        await backend.restartResource(target);
      }
      setDetail(null); setDataRevision((value) => value + 1); setBackendError("");
    } catch (error) { setBackendError(String(error)); }
  };
  const closeBottomSession = (id: string) => {
    disposeBottomSessions(activeCluster.id, [id]);
    setBottomSessions((current) => {
      const index = current.findIndex((session) => session.id === id);
      const next = current.filter((session) => session.id !== id);
      if (activeBottomId === id) setActiveBottomId(next[Math.max(0, index - 1)]?.id ?? next[0]?.id ?? "");
      if (!next.length) setBottomCollapsed(false);
      return next;
    });
  };
  const closeTab = (id: string) => setTabs((current) => {
    if (id === "overview") return current;
    const index = current.findIndex((tab) => tab.id === id);
    const next = current.filter((tab) => tab.id !== id);
    if (activeTabId === id) setActiveTabId(next[Math.max(0, index - 1)]?.id ?? next[0].id);
    setDetail(null); return next;
  });
  const closeOtherTabs = (id: string) => setTabs((current) => {
    const next = current.filter((tab) => tab.id === "overview" || tab.id === id);
    setActiveTabId(id);
    setDetail(null);
    return next;
  });
  const closeAllTabs = () => {
    setTabs([{ id: "overview", label: "Overview", resource: "Overview", preview: false }]);
    setActiveTabId("overview");
    setDetail(null);
  };
  const closeOtherSessions = (id: string) => {
    disposeBottomSessions(activeCluster.id, bottomSessions.filter((session) => session.id !== id).map((session) => session.id));
    setBottomSessions((current) => current.filter((session) => session.id === id));
    setActiveBottomId(id);
  };
  const closeAllSessions = () => {
    disposeBottomSessions(activeCluster.id, bottomSessions.map((session) => session.id));
    setBottomSessions([]);
    setActiveBottomId("");
    setBottomCollapsed(false);
  };
  const moveCluster = (clusterId: string, direction: -1 | 1) => {
    setAvailableClusters((current) => {
      const visible = current.filter((item) => item.id !== "unconfigured");
      const index = visible.findIndex((item) => item.id === clusterId);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= visible.length) return current;
      const reordered = [...visible];
      [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];
      let visibleIndex = 0;
      return current.map((item) => item.id === "unconfigured" ? item : reordered[visibleIndex++]);
    });
  };
  const reorderCluster = (clusterId: string, insertionIndex: number) => {
    setAvailableClusters((current) => {
      const visible = current.filter((item) => item.id !== "unconfigured");
      const sourceIndex = visible.findIndex((item) => item.id === clusterId);
      if (sourceIndex < 0) return current;
      const reordered = [...visible];
      const [moved] = reordered.splice(sourceIndex, 1);
      const targetIndex = Math.max(0, Math.min(reordered.length, insertionIndex > sourceIndex ? insertionIndex - 1 : insertionIndex));
      reordered.splice(targetIndex, 0, moved);
      if (reordered.every((item, index) => item.id === visible[index]?.id)) return current;
      let visibleIndex = 0;
      return current.map((item) => item.id === "unconfigured" ? item : reordered[visibleIndex++]);
    });
  };
  const updateCluster = (id: string, patch: Partial<Cluster>) => {
    setAvailableClusters((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
    setCluster((current) => current.id === id ? { ...current, ...patch } : current);
  };
  const setClusterColor = (id: string, color: string) => {
    updateCluster(id, { color });
    try {
      const colors = JSON.parse(localStorage.getItem("kubehive.clusterColors") ?? "{}") as Record<string, string>;
      colors[id] = color;
      localStorage.setItem("kubehive.clusterColors", JSON.stringify(colors));
    } catch { /* ignore */ }
  };
  const saveClusterSettings = async (target: Cluster, name: string, color: string) => {
    const savedName = nativeBackendAvailable ? (await backend.renameCluster(target.id, name)).name : name.trim();
    updateCluster(target.id, { name: savedName });
    setClusterColor(target.id, color);
    setBackendError("");
  };
  const goHome = () => {
    captureActiveClusterWorkspace();
    setClusterConnection(null);
    setWorkspaceView("clusters");
    setNavOpen(false);
    setCommandOpen(false);
    setAlertsOpen(false);
    setDetail(null);
  };
  const connectAndOpenCluster = async (target: Cluster, forceReconnect = false) => {
    if (clusterOperationId) return;
    const reconnecting = forceReconnect || target.disconnected;
    const operationId = reconnecting ? (crypto.randomUUID?.() ?? `cluster-${Date.now()}-${Math.random().toString(36).slice(2)}`) : "";
    const attempt = reconnecting ? { clusterId: target.id, operationId, cancelled: false } : null;
    if (attempt) clusterConnectionAttemptRef.current = attempt;
    captureActiveClusterWorkspace();
    setClusterOperationId(target.id);
    if (reconnecting) {
      setCluster(target);
      setDiscoveredResources([]);
      setDetail(null);
      setNavOpen(false);
      setAlertsOpen(false);
      setWorkspaceView("cluster");
      setClusterConnection({ clusterId: target.id, phase: "connecting", operationId });
    }
    try {
      if (reconnecting && !nativeBackendAvailable) throw new Error(tr(language, "nativeAppRequired"));
      const next = reconnecting
        ? { ...(await backend.reconnectCluster(target.id, operationId)), disconnected: false } as Cluster
        : target;
      if (attempt?.cancelled || (attempt && clusterConnectionAttemptRef.current !== attempt)) return;
      setAvailableClusters((current) => current.map((item) => item.id === next.id ? { ...item, ...next } : item));
      setCluster(next);
      restoreClusterWorkspace(next.id);
      setDiscoveredResources([]);
      setNavOpen(false);
      setAlertsOpen(false);
      setWorkspaceView("cluster");
      setClusterConnection(null);
      setAlertCount(0);
      setBackendError("");
    } catch (error) {
      if (attempt?.cancelled || (attempt && clusterConnectionAttemptRef.current !== attempt)) return;
      const message = error instanceof Error ? error.message : String(error);
      const unavailable = { ...target, disconnected: true, status: "offline" as const };
      updateCluster(target.id, unavailable);
      setCluster(unavailable);
      setDiscoveredResources([]);
      setDetail(null);
      setWorkspaceView("cluster");
      setClusterConnection({ clusterId: target.id, phase: "failed", error: message });
      setBackendError("");
    } finally {
      if (!attempt || clusterConnectionAttemptRef.current === attempt) {
        if (attempt) clusterConnectionAttemptRef.current = null;
        setClusterOperationId(null);
      }
    }
  };
  const retryClusterConnection = () => {
    const target = availableClusters.find((item) => item.id === activeCluster.id) ?? activeCluster;
    void connectAndOpenCluster(target, true);
  };
  const cancelClusterConnection = () => {
    const attempt = clusterConnectionAttemptRef.current;
    if (!attempt || clusterConnection?.phase !== "connecting" || clusterConnection.clusterId !== attempt.clusterId) return;
    attempt.cancelled = true;
    clusterConnectionAttemptRef.current = null;
    const target = availableClusters.find((item) => item.id === attempt.clusterId) ?? activeCluster;
    const disconnected = { ...target, disconnected: true, status: "offline" as const };
    updateCluster(target.id, disconnected);
    setCluster(disconnected);
    setClusterConnection(null);
    setClusterOperationId(null);
    setDiscoveredResources([]);
    setDetail(null);
    setWorkspaceView("clusters");
    if (nativeBackendAvailable) {
      void Promise.allSettled([
        backend.cancelClusterConnection(attempt.operationId),
        backend.disconnectCluster(attempt.clusterId),
      ]);
    }
  };
  const markClusterUnavailable = (target: Cluster, error: string) => {
    if (clusterOperationId || activeCluster.id !== target.id) return;
    const unavailable = { ...target, disconnected: true, status: "offline" as const };
    updateCluster(target.id, unavailable);
    setCluster(unavailable);
    setDiscoveredResources([]);
    setDetail(null);
    setNavOpen(false);
    setCommandOpen(false);
    setAlertsOpen(false);
    setClusterConnection({ clusterId: target.id, phase: "unavailable", error });
    setWorkspaceView("cluster");
  };
  const closeClusterConnection = async (target: Cluster) => {
    if (clusterOperationId) return;
    captureActiveClusterWorkspace();
    setClusterOperationId(target.id);
    let disconnectError = "";
    try {
      if (nativeBackendAvailable) await backend.disconnectCluster(target.id);
    } catch (error) {
      disconnectError = error instanceof Error ? error.message : String(error);
    }
    disposeClusterSessions(target.id);
    clearCachedClusterSessions(target.id);
    updateCluster(target.id, { disconnected: true });
    if (cluster.id === target.id) {
      setCluster((current) => ({ ...current, disconnected: true }));
      closeAllTabs();
      setBottomSessions([]);
      setActiveBottomId("");
      setBottomCollapsed(false);
      setSelectedNamespaces([]);
      setDiscoveredResources([]);
      setNavOpen(false);
      setCommandOpen(false);
      setAlertsOpen(false);
      setAlertCount(0);
      setWorkspaceView("clusters");
    }
    setClusterConnection(null);
    setBackendError(disconnectError);
    setClusterOperationId(null);
  };
  const removeCluster = (target: Cluster) => {
    const applyRemoval = () => {
      disposeClusterSessions(target.id);
      forgetClusterWorkspace(target.id);
      if (cluster.id === target.id) {
        closeAllTabs();
        setBottomSessions([]);
        setActiveBottomId("");
        setBottomCollapsed(false);
        setDiscoveredResources([]);
        setClusterConnection(null);
        setWorkspaceView("clusters");
        setAlertCount(0);
      }
      setAvailableClusters((current) => {
        const next = current.filter((item) => item.id !== target.id);
        const fallback = next[0] ?? unconfiguredCluster;
        if (cluster.id === target.id) setCluster(fallback);
        return next.length ? next : [fallback];
      });
    };
    if (nativeBackendAvailable) {
      if (!target.imported) { setBackendError("Default kubeconfig contexts must be removed from your kubeconfig file."); return; }
      void backend.removeCluster(target.id).then(applyRemoval).catch((error) => setBackendError(String(error)));
    } else applyRemoval();
    if (clusterSettingsId === target.id) setClusterSettingsId(null);
  };
  useEffect(() => {
    if (!nativeBackendAvailable || workspaceView !== "cluster" || activeCluster.id === "unconfigured" || activeCluster.disconnected || clusterConnection) return;
    let cancelled = false;
    let probing = false;
    const probe = async () => {
      if (probing) return;
      probing = true;
      try {
        const summary = await backend.probeCluster(activeCluster.id);
        if (cancelled) return;
        if (summary.disconnected || summary.error) markClusterUnavailable(activeCluster, summary.error ?? "The cluster was disconnected.");
      } catch (error) {
        if (!cancelled) markClusterUnavailable(activeCluster, error instanceof Error ? error.message : String(error));
      } finally {
        probing = false;
      }
    };
    const onProbeRequest = (event: Event) => {
      const clusterId = event instanceof CustomEvent ? (event.detail as { clusterId?: unknown }).clusterId : undefined;
      if (clusterId === activeCluster.id) void probe();
    };
    window.addEventListener(clusterProbeRequestedEvent, onProbeRequest);
    const timer = window.setInterval(() => { void probe(); }, 15_000);
    return () => { cancelled = true; window.removeEventListener(clusterProbeRequestedEvent, onProbeRequest); window.clearInterval(timer); };
  }, [activeCluster, clusterConnection, clusterOperationId, workspaceView]);

  const addCluster = async (request: { displayName: string; kubeconfigYaml?: string; server?: string; token?: string; insecureSkipTlsVerify?: boolean }) => {
    if (!nativeBackendAvailable) throw new Error(tr(language, "nativeAppRequired"));
    const imported = await backend.importClusters(request);
    let colors: Record<string, string> = {}; try { colors = JSON.parse(localStorage.getItem("kubehive.clusterColors") ?? "{}"); } catch { /* ignore invalid local preference */ }
    const next = imported.map((item) => ({ ...item, color: colors[item.id] } as Cluster));
    setAvailableClusters((current) => [...current.filter((item) => item.id !== "unconfigured" && !next.some((added) => added.id === item.id)), ...next]);
    if (next[0]) setCluster(next[0]);
    setWorkspaceView("clusters"); setAddClusterOpen(false); setBackendError(""); setDataRevision((value) => value + 1);
  };



  // Clicking outside the details sheet dismisses it. Resource instances keep it open so
  // the sheet swaps content instead of closing, and overlay surfaces own their own state.
  useEffect(() => {
    if (!detail) return;
    const handler = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(DETAIL_SHEET_PERSIST_SELECTOR)) return;
      setDetail(null);
    };
    window.addEventListener("pointerdown", handler);
    return () => window.removeEventListener("pointerdown", handler);
  }, [detail]);

  // Cmd/Ctrl +/-/0 zoom the whole window. Registered in the capture phase so the
  // webview, xterm, and CodeMirror do not consume the keys first.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const modifier = platform === "macos" ? event.metaKey : event.ctrlKey;
      if (!modifier || event.altKey) return;
      const key = event.key;
      if (key === "+" || key === "=" || event.code === "Equal" || event.code === "NumpadAdd") {
        event.preventDefault();
        event.stopPropagation();
        changeWindowZoom(stepWindowZoom(getWindowZoomFactor(), 1));
      } else if (key === "-" || key === "_" || event.code === "Minus" || event.code === "NumpadSubtract") {
        event.preventDefault();
        event.stopPropagation();
        changeWindowZoom(stepWindowZoom(getWindowZoomFactor(), -1));
      } else if (key === "0" || event.code === "Digit0" || event.code === "Numpad0") {
        event.preventDefault();
        event.stopPropagation();
        changeWindowZoom(1);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [changeWindowZoom]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const settingsShortcut = event.key === "," && (platform === "macos" ? event.metaKey : event.ctrlKey);
      if (settingsShortcut) {
        event.preventDefault();
        event.stopPropagation();
        if (settingsOpen) setSettingsOpen(false);
        else openSettings();
        return;
      }
      const closeShortcut = event.key.toLowerCase() === "w" && (platform === "macos" ? event.metaKey : event.ctrlKey);
      if (closeShortcut) {
        // The visible bottom sheet owns Cmd/Ctrl+W. Otherwise close a resource tab
        // before falling back to the native window close behavior.
        event.preventDefault();
        event.stopPropagation();
        const workspaceTabsVisible = workspaceView === "cluster" && clusterConnection?.clusterId !== activeCluster.id;
        if (workspaceTabsVisible && bottomSessions.length > 0 && !bottomCollapsed) {
          const sessionId = bottomSessions.some((session) => session.id === activeBottomId) ? activeBottomId : bottomSessions[0].id;
          closeBottomSession(sessionId);
          return;
        }
        const tab = workspaceTabsVisible
          ? tabs.find((item) => item.id === activeTabId && item.id !== "overview") ?? tabs.find((item) => item.id !== "overview")
          : undefined;
        if (tab) { closeTab(tab.id); return; }
        void getCurrentWindow().close().catch(() => { /* Browser prototype. */ });
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && workspaceView === "cluster") { event.preventDefault(); setCommandOpen(true); }
      if (event.key === "Escape") {
        // Escape dismisses one layer per press, top-most first: dialogs, then the
        // right details sheet, then the bottom session dock. While the session
        // find popover is open, the first Escape belongs to it — wherever focus
        // sits inside the dock, the search closes first and the dock stays put;
        // the next Escape collapses the dock. When the popover itself has focus
        // it closes itself (and hands focus back), so just stand aside.
        if (document.activeElement instanceof Element && document.activeElement.closest(".text-search-popover")) return;
        if (deleteTarget) { if (!deleteBusy) { setDeleteTarget(null); setDeleteError(""); } return; }
        if (scaleTarget) { if (!scaleBusy) { setScaleTarget(null); setScaleError(""); } return; }
        if (drainTarget) { if (!drainBusy) { closeResourceDrain(); } return; }
        if (cordonTarget) { if (!cordonBusy) { setCordonTarget(null); setCordonError(""); } return; }
        if (taintTarget) { setTaintTarget(null); setTaintError(""); return; }
        if (commandOpen) { setCommandOpen(false); return; }
        if (addClusterOpen) { setAddClusterOpen(false); return; }
        if (clusterSettingsId) { setClusterSettingsId(null); return; }
        if (settingsOpen) { setSettingsOpen(false); return; }
        if (aboutOpen) { setAboutOpen(false); return; }
        if (alertsOpen) { setAlertsOpen(false); return; }
        if (detail) { setDetail(null); return; }
        if (sessionSearchOpen) { setSessionSearchOpen(false); return; }
        if (bottomSessions.length > 0 && !bottomCollapsed) { setBottomCollapsed(true); return; }
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [workspaceView, clusterConnection, activeCluster.id, deleteTarget, deleteBusy, scaleTarget, scaleBusy, commandOpen, addClusterOpen, clusterSettingsId, settingsOpen, aboutOpen, alertsOpen, detail, sessionSearchOpen, bottomSessions, bottomCollapsed, activeBottomId, tabs, activeTabId, openSettings]);

  useSessionDockFindContextTracking();
  useTitlebarWindowGestures();

  return <div className={cn("app-shell", `platform-${platform}`)} style={{ ["--cluster-accent" as string]: accent }}>
    <ClusterRail
      clusters={availableClusters}
      active={workspaceView === "cluster" ? activeCluster : null}
      language={language}
      alertCount={alertCount}
      alertsDisabled={workspaceView !== "cluster" || Boolean(activeCluster.disconnected)}
      onHome={goHome}
      onConnect={(target) => void connectAndOpenCluster(target)}
      onAlerts={() => setAlertsOpen(true)}
      onAbout={openAbout}
      onSettings={openSettings}
      onAdd={() => setAddClusterOpen(true)}
      onClusterSettings={(target) => setClusterSettingsId(target.id)}
      onCloseConnection={(target) => void closeClusterConnection(target)}
      onMove={moveCluster}
      onReorder={reorderCluster}
      onRemove={removeCluster}
    />
    <div className={cn("workspace-pane", workspaceView === "clusters" && "home-mode")}>
      {workspaceView === "clusters" ? <ClusterHome clusters={availableClusters} language={language} busyClusterId={clusterOperationId} onConnect={(target) => void connectAndOpenCluster(target)} onCloseConnection={(target) => void closeClusterConnection(target)} onSettings={(target) => setClusterSettingsId(target.id)} onRemove={removeCluster} onAdd={() => setAddClusterOpen(true)} /> : clusterConnection?.clusterId === activeCluster.id ? <ClusterConnectionPage cluster={activeCluster} language={language} state={clusterConnection} busy={clusterOperationId === activeCluster.id} onReconnect={retryClusterConnection} onCancel={cancelClusterConnection} onClose={() => void closeClusterConnection(activeCluster)} /> : <>
        <ResourceNav active={resource} cluster={activeCluster} language={language} discovered={discoveredResources} onSelect={(item, permanent) => openResourcePage(item, undefined, { permanent })} onCloseCluster={() => void closeClusterConnection(activeCluster)} closing={clusterOperationId === activeCluster.id} open={navOpen} onClose={() => setNavOpen(false)} onCommand={() => setCommandOpen(true)} />
        <main className="main-area">
          <WorkspaceTabs
            tabs={tabs}
            activeId={activeTabId}
            language={language}
            onActivate={(id) => { setActiveTabId(id); setDetail(null); }}
            onClose={closeTab}
            onCloseOthers={closeOtherTabs}
            onCloseAll={closeAllTabs}
            onKeepOpen={keepTabOpen}
            onMenu={() => setNavOpen(true)}
          />
          {resource === "Overview"
            ? <Overview cluster={activeCluster} language={language} revision={dataRevision} onResource={openResourceRow} onTerminal={() => openBottomSession({ mode: "terminal", terminalTarget: "local" })} onNavigate={openResourcePage} onSnapshot={(snapshot) => { updateCluster(activeCluster.id, { nodes: snapshot.nodes, cpu: snapshot.cpuPercent ?? 0, memory: snapshot.memoryPercent ?? 0, version: snapshot.version, status: snapshot.readyNodes === snapshot.nodes ? "healthy" : "warning" }); setAlertCount(snapshot.events.filter((event) => event.level === "warning").length); }} />
            : resource === "Custom Resource Definitions"
              ? <CrdBrowser key={`${activeCluster.id}:${activeTab.crdName ?? "definitions"}`} clusterId={activeCluster.id} discovered={discoveredResources} namespaces={clusterNamespaces} revision={dataRevision} selectedDefinitionName={activeTab.crdName ?? null} selectedNamespaces={selectedNamespaces} setSelectedNamespaces={setSelectedNamespaces} language={language} onKindSelect={(definition) => openResourcePage("Custom Resource Definitions", definition)} onBack={() => openResourcePage("Custom Resource Definitions")} onInstance={openResourceRow} onCreate={openCreateSession} onOpenLink={openRelatedLink} />
              : <ResourceTable key={`${activeCluster.id}:${resource}`} clusterId={activeCluster.id} discovered={discoveredResources} namespaces={clusterNamespaces} revision={dataRevision} resource={resource} selectedNamespaces={selectedNamespaces} setSelectedNamespaces={setSelectedNamespaces} language={language} onSelect={openResourceRow} onOpenLink={openRelatedLink} onCreate={resource === "Port Forwarding" ? () => requestPortForward() : openCreateSession} onRowAction={(action, row) => void performResourceAction(action, row)} />}
          {bottomSessions.length > 0 && <BottomActionSheet clusterId={activeCluster.id} sessions={bottomSessions} activeId={activeBottomId} collapsed={bottomCollapsed} searchOpen={sessionSearchOpen} onSearchOpenChange={setSessionSearchOpen} language={language} appTheme={resolvedTheme} contentTheme={contentAppearance} contentFont={resolveContentFont(preferences.contentFont, platform)} contentFontSize={preferences.contentFontSize} contentZoom={contentZoomFactor} onContentZoom={setContentZoomFactor} terminalRuntimes={terminalRuntimes} sessionCaches={bottomSessionCaches} onUpdateTerminalRuntimes={updateTerminalRuntimes} onUpdateSessionCaches={updateBottomSessionCaches} onActivate={(id) => { setActiveBottomId(id); setBottomCollapsed(false); }} onCloseSession={closeBottomSession} onCloseOthers={closeOtherSessions} onCloseAll={closeAllSessions} onCreateSession={openBottomSession} onToggleCollapsed={() => setBottomCollapsed((value) => !value)} onApplied={() => setDataRevision((value) => value + 1)} onToast={showToast} />}
        </main>
      </>}
    </div>
    {workspaceView === "cluster" && detail && <DetailSheet key={detail.id} tab={detail} language={language} onClose={() => setDetail(null)} onCopy={copyDetailValue} onOpenResource={openResourceRow} onOpenLink={(link) => { void resolveResourceLink(activeCluster.id, link, discoveredResources).then((resolved) => { if (resolved) openResourceRow(resolved); else setBackendError(`Unable to resolve ${link.kind}/${link.name}`); }).catch((error) => setBackendError(String(error))); }} onMetricsRange={reloadPodMetrics} onPortForward={(row, port) => requestPortForward(row, port, false)} portForwardSessions={portForwardSessions} onOpenPortForward={(session) => void openPortForwardSession(session)} onPausePortForward={(session) => void pausePortForwardSession(session)} onResumePortForward={(session) => void resumePortForwardSession(session)} onStopPortForward={(session) => stopPortForwardSession(session)} onAction={(action) => { if (detail.row) void performResourceAction(action, detail.row); else if (action === "Logs" || action === "Terminal" || action === "Files" || action === "Edit") { const terminalTarget = action === "Terminal" || action === "Files" ? (detail.kind === "Node" ? "node" : "container") : undefined; openBottomSession({ mode: action === "Logs" ? "logs" : action === "Terminal" ? "terminal" : action === "Files" ? "files" : "edit", item: detail, label: terminalTarget === "node" ? detail.label : undefined, terminalTarget, manifest: detail.manifest }); setDetail(null); } }} />}
    {deleteTarget && <ResourceDeleteDialog row={deleteTarget} busy={deleteBusy} error={deleteError} language={language} onClose={closeResourceDelete} onConfirm={() => void confirmResourceDelete()} />}
    {scaleTarget && <ResourceScaleDialog row={scaleTarget} busy={scaleBusy} error={scaleError} language={language} onClose={closeResourceScale} onConfirm={(replicas) => void confirmResourceScale(replicas)} />}
    {drainTarget && <NodeDrainDialog row={drainTarget} busy={drainBusy} error={drainError} result={drainResult} language={language} onClose={closeResourceDrain} onConfirm={(options) => void confirmResourceDrain(options)} />}
    {cordonTarget && <NodeCordonDialog row={cordonTarget} busy={cordonBusy} error={cordonError} language={language} onClose={closeResourceCordon} onConfirm={() => void confirmResourceCordon()} />}
    {taintTarget && <NodeTaintsDialog clusterId={activeCluster.id} row={taintTarget} error={taintError} language={language} onClose={closeResourceTaints} onTainted={() => { setTaintError(""); setDataRevision((value) => value + 1); }} />}
    {portForwardDialog && <PortForwardDialog key={`${portForwardDialog.row.key}:${portForwardDialog.selectedPort}:${portForwardDialog.showPortSelect}`} state={portForwardDialog} busy={portForwardBusy} error={portForwardError} language={language} onClose={() => { if (!portForwardBusy) { setPortForwardDialog(null); setPortForwardError(""); } }} onConfirm={(options) => void confirmPortForward(options)} />}

    {workspaceView === "cluster" && alertsOpen && <AlertsDialog clusterId={activeCluster.id} language={language} onClose={() => setAlertsOpen(false)} />}
    {aboutOpen && <AboutPanel language={language} updateState={updateState} onCheckUpdates={() => void checkUpdates()} onInstallUpdate={() => void installUpdate()} onClose={() => setAboutOpen(false)} />}
    {settingsOpen && <SettingsSheet preferences={preferences} onChange={setPreferences} updateState={updateState} onCheckUpdates={openAboutAndCheckUpdates} onClose={() => setSettingsOpen(false)} />}
    {addClusterOpen && <AddClusterDialog language={language} onClose={() => setAddClusterOpen(false)} onAdd={addCluster} />}
    {clusterSettingsTarget && <ClusterSettingsDialog clusterName={clusterSettingsTarget.name} color={clusterAccent(clusterSettingsTarget)} language={language} onSave={(name, color) => saveClusterSettings(clusterSettingsTarget, name, color)} onClose={() => setClusterSettingsId(null)} />}
    {workspaceView === "cluster" && commandOpen && <CommandPalette language={language} onClose={() => setCommandOpen(false)} onNavigate={openResourcePage} onTerminal={() => openBottomSession({ mode: "terminal", terminalTarget: "local" })} onCreate={() => openCreateSession()} />} {backendError && <div className="backend-error-toast" role="alert"><AlertTriangle size={14} /><span>{backendError}</span><button onClick={() => setBackendError("")} aria-label={tr(language, "dismissBackendError")}><X size={13} /></button></div>}
    {toast && <div className={cn("app-toast", `tone-${toast.tone}`)} role={toast.tone === "error" ? "alert" : "status"}>{toast.tone === "error" ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}<span>{toast.message}{toast.filePath && <button type="button" className="app-toast-file" title={tr(language, "openDownloadedFile")} onClick={() => void openToastFile(toast.filePath!)}>{toast.filePath}</button>}</span><button onClick={() => setToast(null)} aria-label={tr(language, "dismissNotification")}><X size={13} /></button></div>}
    <ContextMenuHost />
  </div>;
}
