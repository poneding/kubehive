import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import {
  Activity, AlertTriangle, ArrowDown, ArrowUp, Bell, Box, Boxes, CheckCircle2, ChevronDown, ChevronRight, CircleDot, Code2,
  Command, Container, Copy, Cpu, Database, Download, ExternalLink, FileCode2, FileKey, FilePen, FileUp, FolderOpen, Gauge, Globe2, HardDrive, Hexagon,
  Info,
  Layers3, LayoutDashboard, LoaderCircle, LogOut, Maximize2, Menu, Minimize2, Minus, MoreHorizontal, Network,
  Pencil, Pause, Play, Plus, Power,
  RefreshCw, Scale, Scaling, ScrollText, Search, Server, Settings, ShieldCheck, Shuffle, SlidersHorizontal, Square, SquareTerminal, Trash2, Type, Upload,
  Users, Wifi, X, Zap, createLucideIcon
} from "lucide-react";
import { Fragment, Suspense, lazy, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { initialUpdateState, installAndRelaunch, checkForUpdate, updateProgress, type UpdateState } from "./app-update";
import "./about.css";
import { AnsiHighlightedText, ansiToPlainText } from "./ansi-log";
import kubeHiveMark from "./assets/kubehive-mark-512.png";
import kubeHiveLogo from "./assets/kubehive-logo.svg";
import { backend, descriptorForResource, nativeBackendAvailable, type ApiResourceDescriptor, type BackendResourceRecord, type BulkActionResult, type ClusterOverview as LiveClusterOverview, type PortForwardSession } from "./backend";
import "./bulk-actions.css";
import { ColumnPicker, useVisibleColumns } from "./column-picker";
import { Combobox } from "./combobox";
import { ClusterHoverCard, ClusterSettingsDialog, ContextMenuHost, openContextMenu, type ContextMenuItem } from "./context-menu";
import {
  clusterAccent,
  customResourceDefinitions, customResources, events,
  clusters as initialClusters,
  navGroups, workloads,
  type Cluster, type CustomResource, type CustomResourceDefinition, type Workload,
} from "./data";
import "./final-alignment.css";
import "./index.css";
import { crdDefinitionFromRecord, rowFromBackend, valueFromJsonPath } from "./k8s-adapter";
import { convertManifest, firstManifestError, manifestHasErrors, validateManifestText, type ManifestFormat } from "./manifest-format";
import "./platform.css";
import { tr, localizedUpdateError } from "./i18n";
import { defaultPreferences, groupLabel, resourceLabel, t, contentFontSizes, type AppLanguage, type Preferences, type ContentTheme } from "./preferences";
import "./refinements.css";
import "./resource-actions.css";
import { getResourceRows, type ResourceLink, type ResourceRow } from "./resource-catalog";
import { buildResourceDetailSections, getResourceAnnotations, getResourceConditions, getResourceLabels } from "./resource-details";
import "./resource-details.css";
import { resolveResourceLink, resolveResourceRelations, type ResourceRelationGroup } from "./resource-relations";
import "./session-settings-polish.css";
import "./settings.css";
import "./sheet-polish.css";
import "./tab-polish.css";
import { ContainerFileExplorer } from "./container-file-explorer";
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
type DetailItem = { id: string; label: string; subtitle: string; type: "resource" | "crd" | "related"; workload?: Workload; crd?: CustomResource; kind?: string; status?: string; related?: RelatedDetail; row?: ResourceRow; manifest?: string; loading?: boolean; error?: string; relations?: ResourceRelationGroup[]; relationsLoading?: boolean; relationsError?: string };
type BottomRequest = { mode: "create" | "edit" | "logs" | "terminal" | "files"; item?: DetailItem; sessionKey?: string; label?: string; manifest?: string; descriptor?: ApiResourceDescriptor; readOnlyReason?: string; terminalTarget?: "local" | "container" };
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
  namespace: string;
  bottomSessions: BottomSession[];
  activeBottomId: string;
  bottomCollapsed: boolean;
};
type BottomSessionCacheMap = Record<string, BottomSessionCache>;
type TerminalRuntimeMap = Record<string, TerminalRuntime>;
type RuntimeMapUpdater<T> = (update: (current: T) => T) => void;
type AppToast = { id: number; tone: "success" | "error"; message: string; filePath?: string };
type ForwardablePort = { port: number; protocol: string; label: string; target?: string; container?: string; forwardable: boolean };
type PortForwardDialogState = { row: ResourceRow; ports: ForwardablePort[]; selectedPort: number; showPortSelect: boolean };
type PodSessionTarget = { key: string; namespace: string; pod: string; phase: string; ready: boolean; initContainers: string[]; containers: string[] };
type TerminalConnectionStatus = "idle" | "connecting" | "connected" | "disconnected";
type TerminalRuntime = { sessionId: string; output: string; status: TerminalConnectionStatus; feedback: string; connectionKey: string; targetLabel: string; podKey?: string; container?: string };
type DesktopPlatform = "macos" | "windows" | "linux";
type WorkspaceView = "clusters" | "cluster";
type ClusterConnectionPhase = "connecting" | "failed" | "unavailable";
type ClusterConnectionState = { clusterId: string; phase: ClusterConnectionPhase; error?: string };
type TrayAction = "settings" | "about" | "check-updates";

const platform: DesktopPlatform = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "macos" : /Win/.test(navigator.userAgent) ? "windows" : "linux";
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
    namespace: "All namespaces",
    bottomSessions: [],
    activeBottomId: "",
    bottomCollapsed: false,
  };
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
      terminalTarget: session.terminalTarget === "container" ? "container" : session.terminalTarget === "local" ? "local" : undefined,
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
  const namespace = typeof candidate.namespace === "string" && candidate.namespace ? candidate.namespace : "All namespaces";
  const bottomSessions = normalizeBottomSessions(candidate.bottomSessions);
  const activeBottomId = typeof candidate.activeBottomId === "string" && bottomSessions.some((session) => session.id === candidate.activeBottomId)
    ? candidate.activeBottomId
    : bottomSessions[0]?.id ?? "";
  const bottomCollapsed = typeof candidate.bottomCollapsed === "boolean" ? candidate.bottomCollapsed : false;
  return { tabs, activeTabId, namespace, bottomSessions, activeBottomId, bottomCollapsed };
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

function ResourceNav({ active, cluster, language, discovered, onSelect, onCloseCluster, closing, open, onClose }: { active: string; cluster: Cluster; language: AppLanguage; discovered: ApiResourceDescriptor[]; onSelect: (item: string, permanent?: boolean) => void; onCloseCluster: () => void; closing: boolean; open: boolean; onClose: () => void }) {
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
  return <aside className={cn("resource-nav", open && "mobile-open")}>
    <div className="nav-title"><span>{t(language, "resources")}</span><div className="nav-title-actions"><ResourceTreeFilter language={language} hidden={hiddenItems} onToggleItem={(item, visible) => updateHiddenItems((current) => { const next = new Set(current); if (visible) next.delete(item); else next.add(item); return next; })} onToggleGroup={(items, visible) => updateHiddenItems((current) => { const next = new Set(current); items.forEach((item) => visible ? next.delete(item) : next.add(item)); return next; })} onReset={() => updateHiddenItems(() => new Set())} /><Button variant="ghost" size="icon" className="mobile-only" aria-label={tr(language, "closeNavigation")} onClick={onClose}><X size={15} /></Button></div></div>
    <div className="nav-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Filter resources" placeholder={t(language, "filterResources")} /></div>
    <nav>{navGroups.map((group) => { const items = group.items.filter((item) => !hiddenItems.has(item) && `${item} ${resourceLabel(language, item)}`.toLowerCase().includes(query.toLowerCase())); if (!items.length) return null; return <section key={group.label}>{group.label !== "Overview" && <p>{groupLabel(language, group.label)}</p>}{items.map((item) => { const Icon = iconMap[item] ?? Box; const available = served(item); return <button key={item} type="button" aria-label={item} disabled={!available} title={available ? undefined : "This API is not served by the active cluster"} className={cn(active === item && "selected", !available && "unavailable")} onClick={() => { onSelect(item, false); onClose(); }} onDoubleClick={() => { onSelect(item, true); onClose(); }}><Icon size={14} /><span>{resourceLabel(language, item)}</span>{item === "Pods" && !nativeBackendAvailable && <small>148</small>}{!available && <small>—</small>}</button>; })}</section>; })}</nav>
    <div className="cluster-summary" style={{ ["--cluster-accent" as string]: clusterAccent(cluster) }}><div className="cluster-summary-head"><span className="cluster-summary-icon">{cluster.name.slice(0, 2).toUpperCase()}</span><div><small>{t(language, "currentCluster")}</small><strong>{cluster.name}</strong></div><StatusDot status={cluster.status} /></div><div className="cluster-summary-meta"><span>{cluster.provider} · {cluster.region}</span><Badge>{cluster.version}</Badge></div><div className="cluster-summary-stats"><div className="cluster-summary-metrics"><span><strong>{cluster.nodes}</strong> nodes</span><span><strong>{cluster.cpu}%</strong> CPU</span></div><div className="cluster-summary-actions"><Button type="button" variant="ghost" size="icon" className="hover-destructive" disabled={closing} aria-label={closing ? t(language, "closingConnection") : t(language, "closeConnection")} title={closing ? t(language, "closingConnection") : t(language, "closeConnection")} onClick={onCloseCluster}><Power size={12} /></Button></div></div></div>
  </aside>;
}

function ClusterActionsMenu({ cluster, language, busy, onConnect, onCloseConnection, onSettings, onRemove }: { cluster: Cluster; language: AppLanguage; busy: boolean; onConnect: () => void; onCloseConnection: () => void; onSettings: () => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const actions = clusterActionMenuItems({ cluster, language, busy, onConnect, onCloseConnection, onSettings, onRemove });
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const run = (action: () => void) => { setOpen(false); action(); };
  return <div ref={root} className={cn("cluster-actions", open && "open")} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
    <Button type="button" variant="ghost" size="icon" title={t(language, "actions")} aria-label={`${t(language, "actions")} ${cluster.name}`} aria-expanded={open} onClick={() => setOpen((value) => !value)}><MoreHorizontal size={15} /></Button>
    {open && <div className="cluster-actions-menu" role="menu">
      {actions.map((item, index) => item.type === "separator"
        ? <div key={`separator-${index}`} role="separator" />
        : <button key={item.id} type="button" className={cn(item.hoverDestructive && "hover-destructive")} disabled={item.disabled} onClick={() => run(item.onSelect)}>{busy && item.id === "connect" ? <LoaderCircle className="spin" size={13} /> : item.icon && <item.icon size={13} />}<span>{item.label}</span></button>)}
    </div>}
  </div>;
}

function ClusterHome({ clusters, language, busyClusterId, onConnect, onCloseConnection, onSettings, onRemove, onAdd }: { clusters: Cluster[]; language: AppLanguage; busyClusterId: string | null; onConnect: (cluster: Cluster) => void; onCloseConnection: (cluster: Cluster) => void; onSettings: (cluster: Cluster) => void; onRemove: (cluster: Cluster) => void; onAdd: () => void }) {
  const [query, setQuery] = useState("");
  const listed = clusters.filter((cluster) => cluster.id !== "unconfigured");
  const connected = listed.filter((cluster) => !cluster.disconnected).length;
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = listed.filter((item) => !normalizedQuery || [item.name, item.context, item.server, item.provider, item.region, item.version].some((value) => value?.toLowerCase().includes(normalizedQuery)));
  return <main className="home-main">
    <div className="home-titlebar titlebar-chrome" data-tauri-drag-region aria-hidden="true" />
    <div className="cluster-home-scroll"><div className="cluster-home">
      <header className="cluster-home-head"><div><div className="eyebrow">KUBERNETES WORKSPACES</div><h1>{t(language, "clusters")}</h1><p>{t(language, "clusterHomeDescription")}</p></div><Button size="sm" onClick={onAdd}><Plus size={13} />{t(language, "addCluster")}</Button></header>
      {listed.length ? <>
        <div className="table-toolbar cluster-home-toolbar"><div className="table-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t(language, "searchClusters")} placeholder={t(language, "searchClusters")} />{query && <button type="button" aria-label={tr(language, "clearClusterSearch")} onClick={() => setQuery("")}><X size={12} /></button>}</div><div className="toolbar-spacer" /><span><strong>{listed.length}</strong> {t(language, "configuredClusters")}</span><span><strong>{connected}</strong> {t(language, "connectedClusters")}</span></div>
        {filtered.length ? <section className="cluster-home-list" aria-label={t(language, "clusters")}>
          <div className="cluster-home-list-head"><span>{t(language, "cluster")}</span><span>{t(language, "provider")}</span><span>{t(language, "location")}</span><span>{t(language, "version")}</span><span>{t(language, "status")}</span><span /></div>
          {filtered.map((item) => <article key={item.id} data-cluster-id={item.id} className={cn("cluster-home-row", !item.disconnected && "connected", busyClusterId === item.id && "busy")} onDoubleClick={() => { if (busyClusterId !== item.id) onConnect(item); }}>
            <div className="cluster-home-identity"><span className="cluster-home-avatar" style={{ ["--cluster-accent" as string]: clusterAccent(item) }}>{item.name.slice(0, 2).toUpperCase()}<StatusDot status={item.disconnected ? "offline" : item.status} /></span><div><strong>{item.name}</strong><small>{item.context || item.server || item.id}</small></div></div>
            <span>{item.provider}</span><span title={item.server}>{item.region}</span><span className="cluster-home-version font-mono">{item.version}</span><span className={cn("cluster-connection-state", !item.disconnected && "connected")}><i />{item.disconnected ? t(language, "disconnected") : t(language, "connected")}</span>
            <ClusterActionsMenu cluster={item} language={language} busy={busyClusterId === item.id} onConnect={() => onConnect(item)} onCloseConnection={() => onCloseConnection(item)} onSettings={() => onSettings(item)} onRemove={() => onRemove(item)} />
          </article>)}
        </section> : <div className="cluster-home-filter-empty"><Search size={24} /><strong>{t(language, "noMatchingClusters")}</strong><span>{t(language, "noMatchingClustersHint")}</span></div>}
      </> : <div className="cluster-home-empty"><Hexagon size={32} /><strong>{t(language, "noClusters")}</strong><span>{t(language, "noClustersHint")}</span><Button size="sm" onClick={onAdd}><Plus size={13} />{t(language, "addCluster")}</Button></div>}
      <p className="cluster-home-tip"><Info size={12} />{t(language, "clusterConnectHint")}</p>
    </div></div>
  </main>;
}

function ClusterConnectionPage({ cluster, language, state, busy, onReconnect, onClose }: { cluster: Cluster; language: AppLanguage; state: ClusterConnectionState; busy: boolean; onReconnect: () => void; onClose: () => void }) {
  const connecting = state.phase === "connecting";
  const title = connecting ? t(language, "connectingCluster") : state.phase === "failed" ? t(language, "connectionFailed") : t(language, "connectionInterrupted");
  const message = connecting
    ? t(language, "connectingClusterHint")
    : state.phase === "failed"
      ? t(language, "connectionFailedHint")
      : t(language, "connectionInterruptedHint");
  return <main className="cluster-connection-page">
    <section className="cluster-connection-card" aria-live="polite">
      <div className={cn("cluster-connection-icon", !connecting && "error")}>{connecting ? <LoaderCircle className="spin" size={26} /> : <Wifi size={26} />}</div>
      <div className="cluster-connection-copy"><span>{cluster.context || cluster.server || "KUBERNETES CLUSTER"}</span><h1>{title}</h1><p>{cluster.name}</p><small>{message}</small></div>
      {connecting && <div className="cluster-connection-progress" role="status" aria-label={title}><i /></div>}
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
  ".detail-relation-list",
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

function WorkspaceTabs({ tabs, activeId, language, onActivate, onClose, onCloseOthers, onCloseAll, onKeepOpen, onMenu, onCommand }: {
  tabs: ResourceTab[];
  activeId: string;
  language: AppLanguage;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onCloseAll: () => void;
  onKeepOpen: (id: string) => void;
  onMenu: () => void;
  onCommand: () => void;
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
    <button type="button" className="tabs-command" onClick={onCommand}><Search size={13} /><span className="command-label">{t(language, "searchResources")}</span><span className="command-shortcut"><kbd>⌘</kbd><kbd>K</kbd></span></button>
    <WindowControls language={language} />
  </div>;
}

function MetricCard({ label, value, unit, percentage, icon: Icon, tone = "green", sub, language }: { label: string; value: string; unit: string; percentage: number; icon: typeof Cpu; tone?: "green" | "amber"; sub: string; language: AppLanguage }) {
  return <div className="metric-card"><div className="metric-top"><span><Icon size={14} />{label}</span><strong>{value}<small>{unit}</small></strong></div><Progress value={percentage} tone={tone} /><div className="metric-foot"><span>{percentage}% {tr(language, "allocated")}</span><span>{sub}</span></div></div>;
}

function Overview({ cluster, language, revision, onWorkload, onResource, onTerminal, onNavigate, onSnapshot }: { cluster: Cluster; language: AppLanguage; revision: number; onWorkload: (item: Workload) => void; onResource: (item: ResourceRow) => void; onTerminal: () => void; onNavigate: (resource: string) => void; onSnapshot: (snapshot: LiveClusterOverview) => void }) {
  const [snapshot, setSnapshot] = useState<LiveClusterOverview | null>(null);
  const [loading, setLoading] = useState(nativeBackendAvailable);
  const [error, setError] = useState("");
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
  const podCount = snapshot?.pods ?? 148;
  const podCapacity = snapshot?.podCapacity || 320;
  const runningPods = snapshot?.runningPods ?? 146;
  const storageTiB = snapshot ? snapshot.storageBytes / 1_099_511_627_776 : 8.4;
  const storagePercent = snapshot?.storageCapacityBytes ? Math.round((snapshot.storageBytes / snapshot.storageCapacityBytes) * 100) : 68;
  const health = snapshot?.workloadHealth ?? { total: 172, healthy: 164, degraded: 5, failed: 3 };
  const liveEvents = snapshot?.events ?? events;
  const podDescriptor = descriptorForResource("Pods", [])!;
  const liveIssues = snapshot?.issues.map((record) => rowFromBackend(record, podDescriptor)) ?? [];
  const nodeValues = snapshot?.nodeUsage.map((node) => node.cpuPercent ?? 0) ?? [64, 48, 76, 38, 57, 81, 44, 69, 52, 72, 33, 61];
  return <div className="workspace-scroll"><div className="page-head"><div><div className="eyebrow">{tr(language, "clusterOverview")}</div><h1>{cluster.name}</h1><p>{error || `Kubernetes ${snapshot?.version ?? cluster.version} · ${snapshot?.nodes ?? cluster.nodes} nodes · ${loading ? tr(language, "updating") : tr(language, "updatedJustNow")}`}</p></div><div className="head-actions"><Button variant="outline" size="sm" disabled={loading} onClick={() => setReloadToken((value) => value + 1)}><RefreshCw className={cn(loading && "spin")} size={13} />{t(language, "refresh")}</Button><Button size="sm" onClick={onTerminal}><SquareTerminal size={13} />{tr(language, "openShell")}</Button></div></div>
    <div className="metrics-grid"><MetricCard label="CPU" value={String(cpu)} unit="%" percentage={cpu} tone={cpu > 75 ? "amber" : "green"} sub={snapshot?.cpuPercent == null && nativeBackendAvailable ? tr(language, "metricsApiUnavailable") : tr(language, "liveNodeUsage")} icon={Cpu} language={language} /><MetricCard label={tr(language, "memory")} value={String(memory)} unit="%" percentage={memory} sub={snapshot?.memoryPercent == null && nativeBackendAvailable ? tr(language, "metricsApiUnavailable") : tr(language, "liveNodeUsage")} icon={Activity} language={language} /><MetricCard label="Pods" value={String(podCount)} unit={`/ ${podCapacity}`} percentage={Math.min(100, Math.round((podCount / Math.max(1, podCapacity)) * 100))} sub={`${runningPods} ${tr(language, "running")}`} icon={Box} language={language} /><MetricCard label="Storage" value={storageTiB.toFixed(1)} unit="TiB" percentage={storagePercent} tone={storagePercent > 75 ? "amber" : "green"} sub={tr(language, "boundPersistentVolumes")} icon={HardDrive} language={language} /></div>
    <div className="overview-grid"><section className="panel"><div className="panel-head"><div><h2>{tr(language, "workloadHealth")}</h2><p>{tr(language, "acrossAllNamespaces")}</p></div><Button variant="ghost" size="sm" onClick={() => onNavigate("Deployments")}>{tr(language, "viewAll")} <ChevronRight size={12} /></Button></div><div className="health-chart"><div className="donut"><div><strong>{health.total}</strong><span>{tr(language, "workloads")}</span></div></div><div className="health-legend"><div><span><i className="green" />{tr(language, "healthy")}</span><strong>{health.healthy}</strong></div><div><span><i className="amber" />{tr(language, "degraded")}</span><strong>{health.degraded}</strong></div><div><span><i className="red" />{tr(language, "failed")}</span><strong>{health.failed}</strong></div></div></div></section><section className="panel"><div className="panel-head"><div><h2>Nodes</h2><p>{snapshot?.nodes ?? cluster.nodes} {tr(language, "connected")}</p></div><Badge tone={(snapshot?.readyNodes ?? cluster.nodes) === (snapshot?.nodes ?? cluster.nodes) ? "green" : "amber"}>{snapshot ? `${snapshot.readyNodes}/${snapshot.nodes} ${tr(language, "ready")}` : tr(language, "allReady")}</Badge></div><div className="node-bars">{nodeValues.map((v, i) => <div key={snapshot?.nodeUsage[i]?.name ?? i}><span style={{ height: `${v}%` }} className={v > 78 ? "hot" : ""} /></div>)}</div><div className="node-axis"><span>{snapshot?.nodeUsage[0]?.name ?? "node-01"}</span><span>{tr(language, "cpuUtilization")}</span><span>{snapshot?.nodeUsage.at(-1)?.name ?? "node-12"}</span></div></section></div>
    <section className="panel issues-panel"><div className="panel-head"><div><h2>{tr(language, "needsAttention")}</h2><p>{tr(language, "alerts")}</p></div><Badge tone="amber">{nativeBackendAvailable ? liveIssues.length : 2} {tr(language, "active")}</Badge></div><div className="compact-list">{nativeBackendAvailable ? liveIssues.map((item) => <button key={item.key} onClick={() => onResource(item)}><StatusDot status={item.status ?? "Pending"} /><div><strong>{item.name}</strong><span>{item.namespace} · {item.kind}</span></div><Badge tone="amber">{item.status}</Badge><span>{item.data.containers ?? "—"} ready</span><ChevronRight size={14} /></button>) : workloads.filter((item) => item.status !== "Running").map((item) => <button key={item.name} onClick={() => onWorkload(item)}><StatusDot status={item.status} /><div><strong>{item.name}</strong><span>{item.namespace} · {item.kind}</span></div><Badge tone="amber">{item.status}</Badge><span>{item.ready} ready</span><ChevronRight size={14} /></button>)}</div></section>
    <section className="panel events-panel"><div className="panel-head"><div><h2>{tr(language, "recentEvents")}</h2><p>{tr(language, "liveClusterActivity")}</p></div><div className="live-label"><i />LIVE</div></div><div className="event-list">{liveEvents.map((event, index) => <div key={`${event.object}-${index}`}><span className={cn("event-icon", event.level)}>{event.level === "warning" ? <AlertTriangle size={13} /> : <CircleDot size={13} />}</span><div><strong>{event.reason}</strong><span>{event.message}</span><small>{event.object}</small></div><time>{event.time}</time></div>)}</div></section>
  </div>;
}

function defaultApiVersion(kind: string) {
  if (["Node", "Namespace", "Event", "Pod", "Service", "Endpoints", "PersistentVolumeClaim", "PersistentVolume", "ConfigMap", "Secret", "ResourceQuota", "LimitRange", "ServiceAccount", "ReplicationController"].includes(kind)) return "v1";
  if (["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet"].includes(kind)) return "apps/v1";
  if (["Job", "CronJob"].includes(kind)) return "batch/v1";
  if (["Ingress", "IngressClass", "NetworkPolicy"].includes(kind)) return "networking.k8s.io/v1";
  if (kind === "StorageClass") return "storage.k8s.io/v1";
  if (kind === "HorizontalPodAutoscaler") return "autoscaling/v2";
  if (kind === "VerticalPodAutoscaler") return "autoscaling.k8s.io/v1";
  if (kind === "PodDisruptionBudget") return "policy/v1";
  if (kind === "PriorityClass") return "scheduling.k8s.io/v1";
  if (kind === "RuntimeClass") return "node.k8s.io/v1";
  if (kind === "Lease") return "coordination.k8s.io/v1";
  if (["MutatingWebhookConfiguration", "ValidatingWebhookConfiguration"].includes(kind)) return "admissionregistration.k8s.io/v1";
  if (["Role", "ClusterRole", "RoleBinding", "ClusterRoleBinding"].includes(kind)) return "rbac.authorization.k8s.io/v1";
  if (kind === "PodSecurityPolicy") return "policy/v1beta1";
  if (kind === "CustomResourceDefinition") return "apiextensions.k8s.io/v1";
  return "custom/v1";
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

type ResourceSyncMode = "demo" | "manual" | "poll" | "watch";

const RESOURCE_POLL_INTERVAL = 15_000;
const PORT_FORWARD_POLL_INTERVAL = 3_000;

function resourceSyncMode(resource: string, descriptor: ApiResourceDescriptor | null | undefined): ResourceSyncMode {
  if (!nativeBackendAvailable) return "demo";
  if (resource === "Port Forwarding") return "poll";
  if (resource === "Helm Charts") return "manual";
  return descriptor?.verbs.includes("watch") ? "watch" : "poll";
}

function useResourceRows(clusterId: string, resource: string, namespace: string, discovered: ApiResourceDescriptor[], revision = 0, override?: ApiResourceDescriptor) {
  const initialRows = nativeBackendAvailable ? [] : getResourceRows(resource);
  const rowsByKey = useRef(new Map(initialRows.map((row) => [row.key, row])));
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
      replaceRows(getResourceRows(resource));
      setSyncMode("demo");
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

function buildRelatedDetail(link: ResourceLink, fromRow?: ResourceRow): RelatedDetail {
  const allPods = getResourceRows("Pods");
  if (link.relation === "namespace" || link.kind === "Namespace") {
    const relatedItems = allPods.filter((item) => item.namespace === link.name).slice(0, 12).map((item) => ({ name: item.name, kind: item.kind, namespace: item.namespace, status: item.status }));
    return {
      relation: "namespace",
      kind: "Namespace",
      name: link.name,
      status: "Active",
      meta: [
        { label: "Status", value: "Active" },
        { label: "Phase", value: "Active" },
        { label: "Pods", value: String(relatedItems.length) },
      ],
      relatedItems,
    };
  }
  if (link.relation === "node" || link.kind === "Node") {
    const relatedItems = allPods.filter((item) => String(item.data.node) === link.name).slice(0, 12).map((item) => ({ name: item.name, kind: item.kind, namespace: item.namespace, status: item.status }));
    return {
      relation: "node",
      kind: "Node",
      name: link.name,
      status: "Ready",
      meta: [
        { label: "Status", value: "Ready" },
        { label: "Roles", value: "worker" },
        { label: "Pods", value: String(relatedItems.length) },
        { label: "Kubelet", value: "v1.31.4" },
      ],
      relatedItems,
    };
  }
  const relatedItems = allPods.filter((item) => item.links?.controlledBy?.name === link.name && item.links?.controlledBy?.kind === link.kind).slice(0, 12).map((item) => ({ name: item.name, kind: "Pod", namespace: item.namespace, status: item.status }));
  return {
    relation: link.relation,
    kind: link.kind,
    name: link.name,
    namespace: link.namespace ?? fromRow?.namespace,
    from: fromRow ? `${fromRow.kind}/${fromRow.name}` : undefined,
    status: "Ready",
    meta: [
      { label: "Kind", value: link.kind },
      { label: "Namespace", value: link.namespace ?? fromRow?.namespace ?? "—" },
      { label: "Controlled pods", value: String(relatedItems.length) },
    ],
    relatedItems,
  };
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
    {actions.canEvict && actions.selectedRows.length > 0 && <Button variant="outline" size="sm" className="hover-destructive" onClick={() => actions.begin("evict")}><LogOut size={13} />Evict</Button>}
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
    <section className="bulk-resource-dialog" role="dialog" aria-modal="true" aria-labelledby="bulk-resource-action-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><h2 id="bulk-resource-action-title">{title}</h2><div /><Button variant="ghost" size="icon" disabled={actions.busy} aria-label="Close bulk action confirmation" onClick={actions.close}><X size={14} /></Button></header>
      <div className="bulk-resource-body">
        <div className="bulk-resource-target"><span className="bulk-resource-icon">{evicting ? <LogOut size={17} /> : <Trash2 size={17} />}</span><div><strong>{actions.selectedRows.length} resources selected</strong><small>{actions.selectedRows.slice(0, 3).map((row) => `${row.kind}/${row.name}`).join(" · ")}{actions.selectedRows.length > 3 ? ` · +${actions.selectedRows.length - 3} more` : ""}</small></div></div>
        <div className="bulk-resource-warning"><AlertTriangle size={15} /><div><strong>{evicting ? "Evict these Pods from their nodes?" : "Delete all selected resources?"}</strong><span>{evicting ? "Kubernetes will check each PodDisruptionBudget and use graceful termination. Controllers may create replacement Pods; blocked evictions will be reported individually." : "This operation cannot be undone. Requests run with bounded concurrency and failures are reported per resource; Kubernetes controllers may recreate managed resources."}</span></div></div>
        <div className="bulk-resource-list">{actions.selectedRows.slice(0, 6).map((row) => <div key={row.key}><span>{row.kind}</span><strong>{row.name}</strong><small>{row.namespace === "—" ? "Cluster scoped" : row.namespace}</small></div>)}{actions.selectedRows.length > 6 && <div className="bulk-resource-list-more">+{actions.selectedRows.length - 6} more resources</div>}</div>
        {actions.error && <div className="bulk-resource-error" role="alert">{actions.error}</div>}
      </div>
      <footer><span>{evicting ? "Kubernetes policy/v1 Eviction" : "Kubernetes API · background propagation"}</span><div /><Button variant="outline" size="sm" disabled={actions.busy} autoFocus onClick={actions.close}>Cancel</Button><Button variant="outline" size="sm" className="bulk-resource-confirm hover-destructive" disabled={actions.busy} onClick={() => void actions.confirm()}>{actions.busy && <LoaderCircle className="spin" size={13} />}{actions.busy ? "Working…" : confirmLabel}</Button></footer>
    </section>
  </div>;
}

function ResourceTable({ clusterId, discovered, namespaces, revision, resource, namespace, setNamespace, language, onSelect, onOpenLink, onCreate, onRowAction }: {
  clusterId: string; discovered: ApiResourceDescriptor[]; namespaces: string[]; revision: number; resource: string; namespace: string;
  setNamespace: (value: string) => void; language: AppLanguage; onSelect: (item: ResourceRow) => void;
  onOpenLink: (link: ResourceLink, row: ResourceRow) => void; onCreate: (descriptor?: ApiResourceDescriptor | null) => void;
  onRowAction: (action: string, row: ResourceRow) => void;
}) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const { defs, visible, setColumnVisible, reset, isVisible } = useVisibleColumns(resource);
  const clusterScoped = clusterScopedResources.has(resource);
  const live = useResourceRows(clusterId, resource, namespace, discovered, revision);
  const filtered = useMemo(() => {
    const search = deferredQuery.toLowerCase();
    return live.rows.filter((item) => (clusterScoped || namespace === "All namespaces" || item.namespace === namespace) && resourceSearchText(item).includes(search));
  }, [live.rows, clusterScoped, namespace, deferredQuery]);
  const columns = useMemo<Array<VirtualTableColumn<ResourceRow>>>(() => visible.map((column) => ({
    id: column.id,
    label: column.label,
    render: (item) => renderResourceCell(column.id, item, onOpenLink, language),
  })), [visible, onOpenLink, language]);
  const canCreate = resource === "Port Forwarding" || !nativeBackendAvailable || Boolean(live.descriptor?.verbs.includes("create"));
  const canBulkDelete = !["Port Forwarding", "Helm Charts", "Helm Releases"].includes(resource) && (!nativeBackendAvailable || Boolean(live.descriptor?.verbs.includes("delete")));
  const bulkActions = useBulkResourceActions({
    clusterId,
    rows: filtered,
    descriptor: live.descriptor,
    selectionKey: `${clusterId}|${resource}|${namespace}|${query}`,
    canDelete: canBulkDelete,
    canEvict: resource === "Pods",
    onCompleted: live.reload,
  });
  const rowMenu = (event: ReactMouseEvent, item: ResourceRow) => {
    const workload = ["Pod", "Deployment", "StatefulSet", "DaemonSet"].includes(item.kind);
    const portForwardable = forwardablePortsFor(item).some((port) => port.forwardable);
    const scalable = ["Deployment", "StatefulSet", "ReplicaSet", "ReplicationController"].includes(item.kind);
    const restartable = ["Deployment", "StatefulSet", "ReplicaSet", "ReplicationController"].includes(item.kind);
    openContextMenu(event, [
      { type: "item", id: "open", label: tr(language, "openDetails"), icon: Info, onSelect: () => onSelect(item) },
      { type: "item", id: "edit", label: tr(language, "editManifest"), icon: Pencil, onSelect: () => onRowAction("Edit", item) },
      ...(workload ? [{ type: "item" as const, id: "logs", label: tr(language, "logs"), icon: ScrollText, onSelect: () => onRowAction("Logs", item) }, { type: "item" as const, id: "terminal", label: tr(language, "terminal"), icon: SquareTerminal, onSelect: () => onRowAction("Terminal", item) }, { type: "item" as const, id: "files", label: tr(language, "containerFiles"), icon: FolderOpen, onSelect: () => onRowAction("Files", item) }] : []),
      ...(["Pod", "Service"].includes(item.kind) ? [{ type: "item" as const, id: "port-forward", label: `${tr(language, "portForward")}...`, icon: Network, disabled: item.kind === "Pod" && !portForwardable, onSelect: () => onRowAction("Port Forward", item) }] : []),
      ...(item.kind === "Pod" ? [{ type: "item" as const, id: "evict", label: tr(language, "evict"), icon: LogOut, hoverDestructive: true, onSelect: () => onRowAction("Evict", item) }] : []),
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
    <div className="page-head"><div><div className="eyebrow">KUBERNETES RESOURCES</div><h1>{resourceLabel(language, resource)}</h1><p>{live.loading ? tr(language, "loadingFromApi") : live.error ? live.error : `${filtered.length} ${tr(language, "resources")} · ${live.syncMode === "watch" ? tr(language, "liveUpdates") : live.syncMode === "poll" ? resource === "Port Forwarding" ? tr(language, "updatedEvery", { seconds: 3 }) : tr(language, "updatedEvery", { seconds: 15 }) : live.syncMode === "manual" ? tr(language, "refreshOnDemand") : tr(language, "demoData")}`}</p></div><div className="head-actions"><Button variant="outline" size="sm" title={tr(language, "reloadLiveData")} onClick={live.reload} disabled={live.loading}><RefreshCw className={cn(live.loading && "spin")} size={13} />{t(language, "refresh")}</Button><Button size="sm" disabled={!canCreate} onClick={() => onCreate(live.descriptor)}><Plus size={13} />{t(language, "create")}</Button></div></div>
    <div className="table-toolbar">{!clusterScoped && <Combobox className="table-namespace-combobox" label={t(language, "namespace")} value={namespace} onChange={setNamespace} options={["All namespaces", ...namespaces].map((item) => ({ value: item, label: item === "All namespaces" ? t(language, "allNamespaces") : item }))} />}<div className="table-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`${t(language, "searchResources")} ${resourceLabel(language, resource)}`} /></div><div className="toolbar-spacer" /><BulkResourceToolbar actions={bulkActions} /></div>
    <div className="resource-table-panel"><VirtualResourceTable rows={filtered} columns={columns} tableKey={`resource:${resource}`} selectedKeys={bulkActions.enabled ? bulkActions.selectedKeys : undefined} onSelectionChange={bulkActions.enabled ? bulkActions.setSelectedKeys : undefined} headerAction={<ColumnPicker resource={resource} language={language} defs={defs} isVisible={isVisible} onToggle={setColumnVisible} onReset={reset} />} renderAction={(item) => <Button variant="ghost" size="icon" aria-label={tr(language, "rowActions")} onClick={(event) => rowMenu(event, item)}><MoreHorizontal size={14} /></Button>} onRowClick={onSelect} onRowContextMenu={rowMenu} empty={!live.loading ? <div className="empty-state"><strong>{live.error ? tr(language, "resourceApiUnavailable") : tr(language, "noResourcesFound")}</strong><span>{live.error || tr(language, "tryAnotherNamespace")}</span></div> : undefined} /></div>
  </div><BulkResourceActionDialog actions={bulkActions} /></>;
}

function CrdInstanceTable({ definition, namespace, setNamespace, language, query, setQuery, onBack, onInstance, onCreate, onOpenLink }: {
  definition: CustomResourceDefinition;
  namespace: string;
  setNamespace: (value: string) => void;
  language: AppLanguage;
  query: string;
  setQuery: (value: string) => void;
  onBack: () => void;
  onInstance: (item: CustomResource, kind: string) => void;
  onCreate: () => void;
  onOpenLink: (link: ResourceLink, row: ResourceRow) => void;
}) {
  const { defs, visible, setColumnVisible, reset, isVisible } = useVisibleColumns("Custom Resource");
  const rows: ResourceRow[] = (customResources[definition.kind] ?? []).filter((item) => (definition.scope === "Cluster" || namespace === "All namespaces" || item.namespace === namespace) && item.name.toLowerCase().includes(query.toLowerCase())).map((item) => ({
    key: `${item.namespace}/${item.name}`,
    name: item.name,
    namespace: item.namespace,
    kind: definition.kind,
    status: item.status,
    data: {
      name: item.name,
      namespace: item.namespace,
      status: item.status,
      apiVersion: `${definition.group}/${item.version}`,
      age: item.age,
    },
    links: item.namespace && item.namespace !== "—" ? { namespace: { kind: "Namespace", name: item.namespace, relation: "namespace" } } : undefined,
  }));
  const sources = customResources[definition.kind] ?? [];
  const columns = useMemo<Array<VirtualTableColumn<ResourceRow>>>(() => visible.map((column) => ({ id: column.id, label: column.label, render: (item) => renderResourceCell(column.id, item, onOpenLink, language) })), [visible, onOpenLink, language]);
  return <div className="workspace-scroll"><div className="page-head"><div><div className="eyebrow">CUSTOM RESOURCE · {definition.group}</div><h1>{definition.kind}</h1><p>{definition.name} · {definition.scope}</p></div><div className="head-actions"><Button variant="outline" size="sm" onClick={onBack}>All CRDs</Button><Button size="sm" onClick={onCreate}><Plus size={13} />Create</Button></div></div><div className="table-toolbar">{definition.scope === "Namespaced" && <Combobox className="table-namespace-combobox" label={t(language, "namespace")} value={namespace} onChange={setNamespace} options={["All namespaces", "commerce", "search", "storefront", "ingress-nginx", "monitoring", "argocd"].map((item) => ({ value: item, label: item === "All namespaces" ? t(language, "allNamespaces") : item }))} />}<div className="table-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`${t(language, "searchResources")} ${definition.kind}`} /></div><div className="toolbar-spacer" /><span>{rows.length} resources</span></div><div className="resource-table-panel"><VirtualResourceTable rows={rows} columns={columns} tableKey={`custom-resource:${definition.kind}`} headerAction={<ColumnPicker resource={definition.kind} language={language} defs={defs} isVisible={isVisible} onToggle={setColumnVisible} onReset={reset} />} renderAction={() => <ChevronRight size={14} />} onRowClick={(item) => { const source = sources.find((entry) => entry.name === item.name && entry.namespace === item.namespace); if (source) onInstance(source, definition.kind); }} empty={<div className="empty-state"><strong>No resources found</strong><span>Try another namespace or search query</span></div>} /></div></div>;
}

function CrdListTable({ language, onKindSelect, onDefinition, onCreate }: { language: AppLanguage; onKindSelect: (crd: CustomResourceDefinition) => void; onDefinition: (row: ResourceRow) => void; onCreate: () => void }) {
  const { defs, visible, setColumnVisible, reset, isVisible } = useVisibleColumns("Custom Resource Definitions");
  const crdRows: Array<ResourceRow & { source: CustomResourceDefinition }> = customResourceDefinitions.map((item) => ({
    key: item.name,
    name: item.name,
    namespace: "—",
    kind: "CustomResourceDefinition",
    status: "Established",
    data: {
      name: item.name,
      status: "Established",
      group: item.group,
      kind: item.kind,
      scope: item.scope,
      versions: item.version,
      instances: item.instances,
      age: item.age,
    },
    source: item,
  }));
  const columns = useMemo<Array<VirtualTableColumn<ResourceRow & { source: CustomResourceDefinition }>>>(() => visible.map((column) => ({
    id: column.id,
    label: column.label,
    render: (item) => column.id === "name" ? <div className="resource-name"><span className="resource-kind">CRD</span><strong>{item.name}</strong></div> : column.id === "scope" ? <Badge>{String(item.data.scope)}</Badge> : item.data[column.id],
  })), [visible]);
  return <div className="workspace-scroll"><div className="page-head"><div><div className="eyebrow">API EXTENSIONS</div><h1>Custom Resource Definitions</h1><p>{customResourceDefinitions.length} definitions discovered in this cluster</p></div><Button size="sm" onClick={onCreate}><Plus size={13} />Create CRD</Button></div><div className="resource-table-panel standalone"><VirtualResourceTable className="standalone" rows={crdRows} columns={columns} tableKey="resource:Custom Resource Definitions" headerAction={<ColumnPicker resource="Custom Resource Definitions" language={language} defs={defs} isVisible={isVisible} onToggle={setColumnVisible} onReset={reset} />} renderAction={(item) => <Button variant="ghost" size="icon" aria-label={`Open ${item.source.kind} instances`} onClick={() => onKindSelect(item.source)}><ChevronRight size={14} /></Button>} onRowClick={onDefinition} /></div></div>;
}

function CrdBrowser({ clusterId, discovered, namespaces, revision, selectedDefinitionName, namespace, setNamespace, language, onKindSelect, onBack, onInstance, onCreate, onOpenLink }: {
  clusterId: string; discovered: ApiResourceDescriptor[]; namespaces: string[]; revision: number; selectedDefinitionName: string | null; namespace: string;
  setNamespace: (value: string) => void; language: AppLanguage; onKindSelect: (crd: CustomResourceDefinition) => void; onBack: () => void;
  onInstance: (row: ResourceRow) => void; onCreate: (descriptor?: ApiResourceDescriptor | null) => void; onOpenLink: (link: ResourceLink, row: ResourceRow) => void;
}) {
  const [query, setQuery] = useState("");
  const crdDescriptor = descriptorForResource("Custom Resource Definitions", discovered)!;
  const crdLive = useResourceRows(clusterId, "Custom Resource Definitions", "All namespaces", discovered, revision, crdDescriptor);
  const liveDefinitions = crdLive.rows.map((row) => row.backend ? crdDefinitionFromRecord(row.backend) : null).filter(Boolean) as Array<ReturnType<typeof crdDefinitionFromRecord>>;
  const definition = nativeBackendAvailable
    ? liveDefinitions.find((item) => item.name === selectedDefinitionName)
    : customResourceDefinitions.find((item) => item.name === selectedDefinitionName);
  const printerColumns = definition && "printerColumns" in definition ? definition.printerColumns.filter((column) => !["Name", "Namespace", "Status", "Age"].includes(column.name)) : [];
  const dynamicDescriptor = definition && "descriptor" in definition ? definition.descriptor : definition ? {
    apiVersion: `${definition.group}/${definition.version}`, group: definition.group, version: definition.version, kind: definition.kind,
    plural: definition.plural ?? `${definition.kind.toLowerCase()}s`, namespaced: definition.scope === "Namespaced", verbs: ["get", "list", "watch", "create", "patch", "delete"], categories: [],
  } : crdDescriptor;
  const instances = useResourceRows(clusterId, `Custom Resource ${definition?.group ?? "unknown"}/${definition?.kind ?? "Definitions"}`, namespace, discovered, revision, dynamicDescriptor);
  const deferredQuery = useDeferredValue(query);
  const instanceFiltered = useMemo(() => instances.rows.filter((row) => row.name.toLowerCase().includes(deferredQuery.toLowerCase())), [instances.rows, deferredQuery]);
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
    selectionKey: `${clusterId}|custom-resource:${definition?.kind ?? "none"}|${namespace}|${query}`,
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
  if (!nativeBackendAvailable) {
    if (definition) return <CrdInstanceTable definition={definition} namespace={namespace} setNamespace={setNamespace} language={language} query={query} setQuery={setQuery} onBack={onBack} onInstance={(item, kind) => onInstance({ key: `${item.namespace}/${item.name}`, name: item.name, namespace: item.namespace, kind, status: item.status, data: { name: item.name, namespace: item.namespace, status: item.status, apiVersion: `${definition.group}/${item.version}`, age: item.age } })} onCreate={() => onCreate(dynamicDescriptor)} onOpenLink={onOpenLink} />;
    return <CrdListTable language={language} onKindSelect={onKindSelect} onDefinition={onInstance} onCreate={() => onCreate(crdDescriptor)} />;
  }
  if (definition && selectedDefinitionName) {
    return <><div className="workspace-scroll"><div className="page-head"><div><div className="eyebrow">CUSTOM RESOURCE · {definition.group}</div><h1>{definition.kind}</h1><p>{instances.error || `${definition.name} · ${definition.scope} · ${instanceFiltered.length} resources`}</p></div><div className="head-actions"><Button variant="outline" size="sm" onClick={onBack}>All CRDs</Button><Button size="sm" disabled={!dynamicDescriptor.verbs.includes("create")} onClick={() => onCreate(dynamicDescriptor)}><Plus size={13} />Create</Button></div></div><div className="table-toolbar">{definition.scope === "Namespaced" && <Combobox className="table-namespace-combobox" label={t(language, "namespace")} value={namespace} onChange={setNamespace} options={["All namespaces", ...namespaces].map((item) => ({ value: item, label: item === "All namespaces" ? t(language, "allNamespaces") : item }))} />}<div className="table-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`${t(language, "searchResources")} ${definition.kind}`} /></div><span>{instances.loading ? "Loading…" : `${instanceFiltered.length} resources`}</span><div className="toolbar-spacer" /><BulkResourceToolbar actions={instanceBulkActions} /></div><div className="resource-table-panel"><VirtualResourceTable rows={instanceFiltered} columns={instanceTableColumns} tableKey={`custom-resource:${definition.kind}`} selectedKeys={instanceBulkActions.enabled ? instanceBulkActions.selectedKeys : undefined} onSelectionChange={instanceBulkActions.enabled ? instanceBulkActions.setSelectedKeys : undefined} headerAction={<ColumnPicker resource="Custom Resource" language={language} defs={instanceColumns.defs} isVisible={instanceColumns.isVisible} onToggle={instanceColumns.setColumnVisible} onReset={instanceColumns.reset} />} renderAction={() => <ChevronRight size={14} />} onRowClick={onInstance} empty={!instances.loading ? <div className="empty-state"><strong>No resources found</strong><span>{instances.error || "Try another namespace or search query"}</span></div> : undefined} /></div></div><BulkResourceActionDialog actions={instanceBulkActions} /></>;
  }
  return <><div className="workspace-scroll"><div className="page-head"><div><div className="eyebrow">API EXTENSIONS</div><h1>Custom Resource Definitions</h1><p>{crdLive.error || `${liveDefinitions.length} definitions discovered in this cluster`}</p></div><Button size="sm" disabled={!crdDescriptor.verbs.includes("create")} onClick={() => onCreate(crdDescriptor)}><Plus size={13} />Create CRD</Button></div><div className="table-toolbar crd-bulk-toolbar"><span>{crdLive.rows.length} definitions</span><div className="toolbar-spacer" /><BulkResourceToolbar actions={crdBulkActions} /></div><div className="resource-table-panel standalone"><VirtualResourceTable className="standalone" rows={crdLive.rows} columns={crdTableColumns} tableKey="resource:Custom Resource Definitions" selectedKeys={crdBulkActions.enabled ? crdBulkActions.selectedKeys : undefined} onSelectionChange={crdBulkActions.enabled ? crdBulkActions.setSelectedKeys : undefined} headerAction={<ColumnPicker resource="Custom Resource Definitions" language={language} defs={crdColumns.defs} isVisible={crdColumns.isVisible} onToggle={crdColumns.setColumnVisible} onReset={crdColumns.reset} />} renderAction={(row) => { const source = liveDefinitionByName.get(row.name); return source ? <Button variant="ghost" size="icon" aria-label={`Open ${source.kind} instances`} onClick={() => onKindSelect(source)}><ChevronRight size={14} /></Button> : null; }} onRowClick={onInstance} empty={!crdLive.loading ? <div className="empty-state"><strong>No definitions found</strong><span>{crdLive.error || "This cluster did not return any CRDs"}</span></div> : undefined} /></div></div><BulkResourceActionDialog actions={crdBulkActions} /></>;
}

function portNumber(value: unknown): number | null {
  const port = typeof value === "number" ? value : Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function parseDemoPorts(value: unknown, prefix: string): ForwardablePort[] {
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
      return [{ port, protocol, label: `${container.name ?? "container"} · ${port}/${protocol}${name}`, container: container.name, forwardable: protocol === "TCP" }];
    }));
    if (declared.length) return declared;
    const demoContainers = (row.containers ?? []).flatMap((container) => parseDemoPorts(container.port, container.name).map((entry) => ({ ...entry, label: `${container.name} · ${entry.port}/${entry.protocol}` })));
    return demoContainers.length ? demoContainers : parseDemoPorts(row.data.ports, "Container port");
  }
  if (row.kind === "Service") {
    const declared = (spec?.ports ?? []).flatMap((entry) => {
      const port = portNumber(entry.port);
      if (!port) return [];
      const protocol = (entry.protocol ?? "TCP").toUpperCase();
      const name = entry.name ? ` · ${entry.name}` : "";
      const target = entry.targetPort === undefined ? String(port) : String(entry.targetPort);
      return [{ port, protocol, label: `${port}/${protocol}${name} → ${target}`, target, forwardable: protocol === "TCP" }];
    });
    return declared.length ? declared : parseDemoPorts(row.data.ports, "Service port");
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

function RelationGroupView({ group, language, onOpenResource }: { group: ResourceRelationGroup; language: AppLanguage; onOpenResource: (row: ResourceRow) => void }) {
  const directionLabel = group.direction === "parent" ? "Parent" : group.direction === "child" ? "Child" : "Related";
  return <section className="detail-relation-group" data-relation-id={group.id}>
    <header><div><h4>{group.title}</h4><p>{group.description}</p></div><Badge tone={group.direction === "parent" ? "blue" : group.direction === "child" ? "green" : "neutral"}>{directionLabel} · {group.items.length}</Badge></header>
    {group.error && <div className="detail-relation-error"><AlertTriangle size={12} />{group.error}</div>}
    <div className="detail-relation-list">{group.items.map((entry) => <button key={`${entry.kind}/${entry.namespace}/${entry.name}`} type="button" onClick={() => onOpenResource(entry)}><span className="resource-kind">{entry.kind.slice(0, 2).toUpperCase()}</span><div><strong>{entry.name}</strong><small>{entry.kind}{entry.namespace !== "—" ? ` · ${entry.namespace}` : ""}</small></div>{entry.status && <Badge tone={statusTone(entry.status)}>{entry.status}</Badge>}<ChevronRight size={13} /></button>)}{group.items.length === 0 && <div className="detail-relation-empty">{tr(language, "noResourcesFound")}</div>}</div>
  </section>;
}

function DetailSheet({ tab, language, onClose, onAction, onOpenResource, onPortForward, portForwardSessions, onOpenPortForward, onPausePortForward, onResumePortForward, onStopPortForward }: { tab: DetailItem; language: AppLanguage; onClose: () => void; onAction: (action: string) => void; onOpenResource: (row: ResourceRow) => void; onPortForward: (row: ResourceRow, port: number) => void; portForwardSessions: PortForwardSession[]; onOpenPortForward: (session: PortForwardSession) => void; onPausePortForward: (session: PortForwardSession) => void; onResumePortForward: (session: PortForwardSession) => void; onStopPortForward: (session: PortForwardSession) => Promise<boolean> }) {
  const item = tab.workload;
  const related = tab.related;
  const actionKind = tab.row?.kind ?? item?.kind ?? tab.kind ?? "Resource";
  const canDelete = !nativeBackendAvailable || Boolean(tab.row?.descriptor?.verbs.includes("delete"));
  const editAction = [{ label: "Edit", icon: Pencil, mode: "edit" as const }];
  const deleteAction = actionKind !== "HelmRelease" && canDelete ? [{ label: "Delete", icon: Trash2 }] : [];
  const fileAction = ["Pod", "Deployment", "StatefulSet", "DaemonSet"].includes(actionKind) ? [{ label: "Files", icon: FolderOpen }] : [];
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
              : [...editAction, ...deleteAction];
  const actionLabel = (action: string) => action === "Edit" ? tr(language, "edit") : action === "Delete" ? tr(language, "delete") : action === "Files" ? tr(language, "files") : action === "Terminal" ? tr(language, "terminal") : action === "Logs" ? tr(language, "logs") : action === "Evict" ? tr(language, "evict") : action === "Scale" ? tr(language, "scale") : action === "Restart" ? tr(language, "restartRollout") : action;
  const [width, setWidth] = useState(() => { const maximum = Math.max(280, Math.min(760, window.innerWidth - 80)); return Math.max(280, Math.min(maximum, Number(localStorage.getItem("kubehive.detailWidth")) || 410)); });
  const sheetRef = useRef<HTMLElement>(null);
  const resize = useRef<{ startX: number; startWidth: number; currentWidth: number } | null>(null);
  useEffect(() => localStorage.setItem("kubehive.detailWidth", String(width)), [width]);
  useEffect(() => {
    const move = (event: PointerEvent) => { if (!resize.current || !sheetRef.current) return; const maximum = Math.max(280, Math.min(840, window.innerWidth - 80)); const minimum = Math.min(320, maximum); const next = Math.max(minimum, Math.min(maximum, resize.current.startWidth + resize.current.startX - event.clientX)); resize.current.currentWidth = next; sheetRef.current.style.width = `${next}px`; };
    const stop = () => { if (!resize.current) return; const finalWidth = resize.current.currentWidth; resize.current = null; setWidth(finalWidth); document.body.classList.remove("resizing-sheet"); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop); window.addEventListener("pointercancel", stop);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); window.removeEventListener("pointercancel", stop); document.body.classList.remove("resizing-sheet"); };
  }, []);
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => { event.preventDefault(); event.stopPropagation(); resize.current = { startX: event.clientX, startWidth: sheetRef.current?.getBoundingClientRect().width ?? width, currentWidth: width }; document.body.classList.add("resizing-sheet"); };
  const status = related?.status ?? tab.row?.status ?? tab.status ?? item?.status ?? tab.crd?.status ?? "Ready";
  const kindLabel = related?.kind ?? tab.row?.kind ?? tab.kind ?? item?.kind ?? (tab.type === "crd" ? "CR" : "Resource");
  const detailSections = tab.row ? buildResourceDetailSections(tab.row) : [];
  const conditions = getResourceConditions(tab.row);
  const labels = getResourceLabels(tab.row);
  const annotations = getResourceAnnotations(tab.row);
  const portRows = tab.row && ["Pod", "Service"].includes(tab.row.kind) ? forwardablePortsFor(tab.row) : [];
  const portForwardSession = actionKind === "PortForward" ? portForwardSessions.find((session) => session.id === tab.row?.key) : undefined;
  const portForwardPaused = portForwardSession?.status === "Paused";
  const displayStatus = portForwardSession?.status ?? status;
  return <aside ref={sheetRef} className="sheet sheet-right" style={{ width }}><div className="sheet-resize-edge vertical" aria-label={tr(language, "resizeDetails")} role="separator" aria-orientation="vertical" onPointerDown={startResize} /><div className="drawer-head detail-sheet-header"><div className="resource-kind">{tab.type === "crd" ? "CR" : kindLabel.slice(0, 2).toUpperCase()}</div><div className="sheet-title-stack"><small>{kindLabel}</small><h2>{tab.label}</h2></div><div className="detail-header-actions">{portForwardSession && <>{!portForwardPaused && <Button variant="ghost" size="icon" aria-label={tr(language, "openInBrowser")} title={tr(language, "openInBrowser")} onClick={() => onOpenPortForward(portForwardSession)}><ExternalLink size={13} /></Button>}<Button variant="ghost" size="icon" aria-label={portForwardPaused ? tr(language, "resumeForwarding") : tr(language, "pauseForwarding")} title={portForwardPaused ? tr(language, "resumeForwarding") : tr(language, "pauseForwarding")} onClick={() => { if (portForwardPaused) onResumePortForward(portForwardSession); else onPausePortForward(portForwardSession); }}>{portForwardPaused ? <Play size={12} /> : <Pause size={12} />}</Button><Button variant="ghost" size="icon" className="hover-destructive" aria-label={tr(language, "stopPortForwarding")} title={tr(language, "stopForwarding")} onClick={() => { void onStopPortForward(portForwardSession).then((stopped) => { if (stopped) onClose(); }); }}><Trash2 size={13} /></Button></>}{headerActions.map(({ label, icon: Icon }) => <Button key={label} variant="ghost" size="icon" className={cn(["Delete", "Evict"].includes(label) && "hover-destructive")} aria-label={actionLabel(label)} title={actionLabel(label)} onClick={() => onAction(label)}><Icon size={13} /></Button>)}</div><Button variant="ghost" size="icon" aria-label={tr(language, "close")} onClick={onClose}><X size={14} /></Button></div><div className="drawer-body"><div className="detail-status"><StatusDot status={displayStatus} /><div><strong>{displayStatus}</strong><span>{related ? `Reverse link · ${related.relation}` : tab.loading ? "Loading live API object…" : tab.row?.backend ? "Live Kubernetes API object" : "Browser demonstration snapshot"}</span></div><Badge tone={statusTone(displayStatus)}>{related ? related.relation : tab.relationsLoading ? "Resolving" : `${(tab.relations ?? []).reduce((count, group) => count + group.items.length, 0)} related`}</Badge></div>
    {related ? <>
      <h3>{tr(language, "resources")}</h3>
      <dl>{(related.meta ?? []).map((entry) => <div key={entry.label}><dt>{entry.label}</dt><dd>{entry.value}</dd></div>)}{related.from && <div><dt>Opened from</dt><dd>{related.from}</dd></div>}</dl>
      <h3>{t(language, "reverseLinks")}</h3>
      {tab.error && <div className="related-empty">{tab.error}</div>}
      <div className="related-list">{(related.relatedItems ?? []).map((entry) => <div key={`${entry.namespace}/${entry.name}`} className="related-list-item"><div><strong>{entry.name}</strong><span>{[entry.kind, entry.namespace].filter(Boolean).join(" · ")}</span></div>{entry.status && <Badge tone={statusTone(entry.status)}>{entry.status}</Badge>}</div>)}{(related.relatedItems ?? []).length === 0 && <div className="related-empty">No related resources</div>}</div>
    </> : <>
      <section className="detail-section detail-metadata"><div className="detail-section-heading"><h3>{tr(language, "resourceIdentity")}</h3><span>{tr(language, "kubernetesMetadata")}</span></div><dl><div><dt>{tr(language, "apiVersion")}</dt><dd>{tab.row?.backend?.apiVersion ?? String(tab.row?.data.apiVersion ?? defaultApiVersion(kindLabel))}</dd></div><div><dt>{tr(language, "kind")}</dt><dd>{kindLabel}</dd></div><div><dt>{tr(language, "namespace")}</dt><dd>{tab.subtitle}</dd></div><div><dt>{tr(language, "age")}</dt><dd>{String(tab.row?.data.age ?? item?.age ?? tab.crd?.age ?? "—")}</dd></div>{tab.row?.backend?.uid && <div><dt>UID</dt><dd className="copy-value">{tab.row.backend.uid}<Button variant="ghost" size="icon" aria-label={tr(language, "copy")} onClick={() => void navigator.clipboard.writeText(tab.row?.backend?.uid ?? "")}><Copy size={12} /></Button></dd></div>}{tab.row?.backend?.resourceVersion && <div><dt>{tr(language, "resourceVersion")}</dt><dd>{tab.row.backend.resourceVersion}</dd></div>}</dl></section>
      {tab.error && <div className="detail-load-error"><AlertTriangle size={13} /><span>{tab.error}</span></div>}
      {detailSections.map((detailSection) => <section className="detail-section detail-kind-section" key={detailSection.id} data-detail-section={detailSection.id}><div className="detail-section-heading"><h3>{detailSection.title}</h3>{detailSection.description && <span>{detailSection.description}</span>}</div><div className="detail-field-grid">{detailSection.fields.map((entry) => <div key={`${detailSection.id}-${entry.label}`} className={cn("detail-field", entry.wide && "wide")}><span>{entry.label}</span><strong className={cn(entry.tone && `tone-${entry.tone}`)}>{entry.value}{entry.copyable && entry.value !== "—" && <button type="button" aria-label={tr(language, "copy")} onClick={() => void navigator.clipboard.writeText(entry.value)}><Copy size={11} /></button>}</strong></div>)}</div></section>)}
      {tab.row && ["Pod", "Service"].includes(tab.row.kind) && <section className="detail-section detail-port-list" data-detail-section="port-forward-ports"><div className="detail-section-heading"><h3>{tr(language, "ports")}</h3><Badge tone="blue">{portRows.length}</Badge></div><div className="detail-port-table-wrap"><table className="detail-port-table"><thead><tr><th>{tr(language, "ports")}</th><th>{tr(language, "protocol")}</th><th>{tr(language, "address")}</th><th>{tr(language, "forward")}</th></tr></thead><tbody>{portRows.map((entry) => {
        const session = portForwardSessions.find((item) => portForwardMatches(item, tab.row!, entry.port));
        const address = session ? portForwardAddress(session) : "";
        return <tr key={`${entry.port}-${entry.label}`}><td><strong>{entry.port}</strong></td><td><Badge tone={entry.forwardable ? "blue" : "neutral"}>{entry.protocol}</Badge></td><td>{session ? <div className="detail-port-address">{session.status === "Active" && <span className="detail-port-active-dot" aria-label={tr(language, "portForwardActive")} title={tr(language, "portForwardActive")} />}<button type="button" className="detail-port-address-link" disabled={session.status !== "Active"} aria-label={tr(language, "openInBrowser", { address })} title={session.status === "Active" ? tr(language, "openInBrowser") : tr(language, "resumeBeforeOpening")} onClick={() => onOpenPortForward(session)}>{address}</button><Button variant="ghost" size="icon" aria-label={tr(language, "copy")} title={tr(language, "copy")} onClick={() => void navigator.clipboard.writeText(address)}><Copy size={11} /></Button></div> : <span className="detail-port-unforwarded">{tr(language, "notForwarded")}</span>}</td><td><div className="detail-port-actions">{session ? <>{session.status === "Paused" ? <Button variant="ghost" size="icon" aria-label={tr(language, "resumeForwarding")} title={tr(language, "resumeForwarding")} onClick={() => onResumePortForward(session)}><Play size={12} /></Button> : <Button variant="ghost" size="icon" aria-label={tr(language, "pauseForwarding")} title={tr(language, "pauseForwarding")} onClick={() => onPausePortForward(session)}><Pause size={12} /></Button>}<Button variant="ghost" size="icon" className="hover-destructive" aria-label={tr(language, "stopForwarding")} title={tr(language, "stopForwarding")} onClick={() => onStopPortForward(session)}><Trash2 size={13} /></Button></> : <Button variant="outline" size="icon" disabled={!entry.forwardable} title={entry.forwardable ? tr(language, "forwardPortLabel", { port: entry.port }) : tr(language, "tcpOnly")} aria-label={tr(language, "forwardPortLabel", { port: entry.port })} onClick={() => onPortForward(tab.row!, entry.port)}><Shuffle size={13} /></Button>}</div></td></tr>;
      })}{portRows.length === 0 && <tr><td colSpan={4}><div className="detail-port-empty">{tr(language, "noDeclaredPorts")}</div></td></tr>}</tbody></table></div></section>}
      <section className="detail-section"><div className="detail-section-heading"><h3>{tr(language, "conditions")}</h3><span>{tr(language, "controllerReportedState")}</span></div><div className="detail-condition-list">{conditions.map((condition) => <div className="condition-row" key={`${condition.type}-${condition.lastTransition}`}><StatusDot status={condition.status === "True" ? "Ready" : condition.status === "False" ? "NotReady" : "Pending"} /><div><strong>{condition.type}</strong><span>{condition.reason !== "—" ? condition.reason : condition.message}</span>{condition.message !== "—" && condition.message !== condition.reason && <small>{condition.message}</small>}</div><time>{condition.lastTransition}</time></div>)}{conditions.length === 0 && <div className="condition-row"><StatusDot status={status} /><div><strong>{status}</strong><span>{tab.loading ? tr(language, "loadingLiveResource") : tr(language, "noConditions")}</span></div><time>{String(tab.row?.data.age ?? tr(language, "now"))}</time></div>}</div></section>
      <section className="detail-section detail-relations"><div className="detail-section-heading"><h3>{tr(language, "resourceRelationships")}</h3><span>{tr(language, "resourceRelationshipsDescription")}</span></div>{tab.relationsLoading && <div className="detail-relations-loading"><LoaderCircle className="spin" size={14} />{tr(language, "resolvingResourceGraph")}</div>}{tab.relationsError && <div className="detail-relation-error"><AlertTriangle size={12} />{tab.relationsError}</div>}{(tab.relations ?? []).map((relation) => <RelationGroupView key={relation.id} group={relation} language={language} onOpenResource={onOpenResource} />)}{!tab.relationsLoading && (tab.relations ?? []).length === 0 && <div className="detail-relation-empty">{tr(language, "noRelationshipRules")}</div>}</section>
      <section className="detail-section"><div className="detail-section-heading"><h3>{tr(language, "labels")}</h3><span>{tr(language, "metadataLabels", { count: Object.keys(labels).length })}</span></div><div className="labels">{Object.entries(labels).map(([key, value]) => <Badge key={key} tone={key === "app" || key === "app.kubernetes.io/name" ? "blue" : "neutral"}>{key}={value}</Badge>)}{Object.keys(labels).length === 0 && <span className="detail-relation-empty">{tr(language, "noLabels")}</span>}</div></section>
      {Object.keys(annotations).length > 0 && <section className="detail-section"><div className="detail-section-heading"><h3>{tr(language, "annotations")}</h3><span>{tr(language, "metadataAnnotations", { count: Object.keys(annotations).length })}</span></div><div className="detail-annotation-list">{Object.entries(annotations).map(([key, value]) => <div key={key}><strong>{key}</strong><span>{value}</span></div>)}</div></section>}
    </>}
  </div></aside>;
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

function demoPodTargets(item?: DetailItem): PodSessionTarget[] {
  const namespace = item?.subtitle && item.subtitle !== "—" ? item.subtitle : "default";
  const object = item?.row?.backend?.object;
  const workloadSpec = (object?.spec as { template?: { spec?: { initContainers?: Array<{ name?: string }>; containers?: Array<{ name?: string }> } } } | undefined)?.template?.spec;
  const workloadInitContainers = (workloadSpec?.initContainers ?? [])
    .map((container) => container.name?.trim() ?? "")
    .filter(Boolean);
  const workloadContainers = (workloadSpec?.containers ?? [])
    .map((container) => container.name?.trim() ?? "")
    .filter(Boolean);
  const directPod = item?.row?.kind === "Pod";
  const rowContainers = item?.row?.containers?.map((container) => container.name.trim()).filter(Boolean) ?? [];
  const inferredWorkloadContainers = item?.row?.workload ? [
    item.row.workload.image.split("/").pop()?.split(":")[0] ?? "app",
    ...(item.row.kind === "StatefulSet" || item.row.kind === "DaemonSet" ? ["config-reloader"] : []),
  ] : [];
  const directPodContainers = directPod ? podContainers(item.row.backend) : [];
  const initContainers = directPod ? podContainers(item.row.backend, "init") : workloadInitContainers;
  const containers = directPod
    ? directPodContainers.length > 0 ? directPodContainers : rowContainers
    : workloadContainers.length > 0 ? workloadContainers : inferredWorkloadContainers;
  const podCount = directPod ? 1 : Math.min(4, Math.max(1, Number(item?.row?.workload?.ready.split("/")[1]) || 1));
  const basePod = item?.row?.kind === "Pod" ? item.row.name : item?.label ?? "demo";
  return Array.from({ length: podCount }, (_, index) => {
    const pod = directPod ? basePod : item?.row?.kind === "StatefulSet" ? `${basePod}-${index}` : `${basePod}-pod-${index + 1}`;
    return {
      key: `${namespace}/${pod}`,
      namespace,
      pod,
      phase: "Running",
      ready: true,
      initContainers,
      containers: containers.length > 0 || initContainers.length > 0 ? containers : ["app"],
    };
  });
}

async function listPodTargets(clusterId: string, item?: DetailItem): Promise<PodSessionTarget[]> {
  if (!nativeBackendAvailable) return demoPodTargets(item);
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

function BottomActionSheet({ clusterId, sessions, activeId, collapsed, language, appTheme, contentTheme, contentFont, contentFontSize, terminalRuntimes, sessionCaches, onUpdateTerminalRuntimes, onUpdateSessionCaches, onActivate, onCloseSession, onCloseOthers, onCloseAll, onCreateSession, onToggleCollapsed, onApplied, onToast }: {
  clusterId: string;
  sessions: BottomSession[];
  activeId: string;
  collapsed: boolean;
  language: AppLanguage;
  appTheme: "light" | "dark";
  contentTheme: "light" | "dark";
  contentFont: string;
  contentFontSize: number;
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
  const containerTerminal = state?.mode === "terminal" && (state.terminalTarget === "container" || (state.terminalTarget === undefined && Boolean(state.item)));
  const fileExplorer = state?.mode === "files";
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
  const addMenuRef = useRef<HTMLDivElement>(null);
  const tabListRef = useHorizontalTabRail();
  const terminalRuntimesRef = useRef<TerminalRuntimeMap>(terminalRuntimes);
  const sessionCachesRef = useRef<BottomSessionCacheMap>(sessionCaches);
  const targetsReadySessionRef = useRef("");
  const [searchOpen, setSearchOpen] = useState(false);
  terminalRuntimesRef.current = terminalRuntimes;
  sessionCachesRef.current = sessionCaches;

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
    setSearchOpen(false);
    textSearch.setQuery("");
  }, [state?.id]);
  useEffect(() => {
    if (!state || (state.mode !== "logs" && !containerTerminal && state.mode !== "files")) return;
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
  }, [clusterId, state?.id, state?.mode, containerTerminal]);
  const selectedPod = podTargets.find((target) => target.key === selectedPodKey) ?? podTargets[0];
  useEffect(() => {
    if (!state || (state.mode !== "logs" && !containerTerminal && state.mode !== "files") || !selectedPod) return;
    const containers = allPodContainers(selectedPod);
    if (!containers.includes(selectedContainer)) setSelectedContainer(containers[0] ?? "");
  }, [state?.mode, containerTerminal, selectedPodKey, selectedPod, selectedContainer]);
  useEffect(() => {
    if (!state || state.mode !== "terminal" || (containerTerminal && (!selectedPod || targetsReadySessionRef.current !== state.id))) return;
    const sessionId = runtimeKey;
    const targetLabel = containerTerminal
      ? `${selectedPod!.namespace}/${selectedPod!.pod}${selectedContainer ? ` · ${selectedContainer}` : ""}`
      : "Local shell · active cluster";
    const connectionKey = containerTerminal
      ? `${clusterId}|${selectedPod!.key}|${selectedContainer}|${terminalReloadToken}`
      : `${clusterId}|${terminalReloadToken}`;
    const existing = terminalRuntimesRef.current[sessionId];
    if (existing?.connectionKey === connectionKey && (existing.status === "connected" || existing.status === "connecting")) return;
    if (existing?.sessionId && nativeBackendAvailable) void backend.stopTerminal(existing.sessionId);
    onUpdateTerminalRuntimes((current) => ({
      ...current,
      [sessionId]: {
        sessionId: "", output: "", status: "connecting", feedback: `${containerTerminal ? "Connecting" : "Starting"} · ${targetLabel}`, connectionKey, targetLabel,
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
      window.setTimeout(() => updateRuntime((runtime) => ({
        ...runtime,
        status: "connected",
        sessionId: `demo:${sessionId}`,
        feedback: `Connected · ${targetLabel}`,
        output: containerTerminal
          ? "Browser demo container terminal ready.\r\nNative builds open an interactive Kubernetes exec stream.\r\n$ "
          : "Browser demo terminal ready.\r\nNative builds open a local shell with KUBECONFIG scoped to the active cluster.\r\n$ ",
      })), 120);
      return;
    }

    const onMessage = (message: { eventType: string; data?: string | null }) => {
      if (message.eventType === "connected") {
        updateRuntime((runtime) => ({ ...runtime, status: "connected", feedback: message.data || `Connected · ${targetLabel}` }));
      } else if (message.eventType === "output") {
        const chunk = message.data ?? "";
        if (chunk) updateRuntime((runtime) => ({ ...runtime, output: `${runtime.output}${chunk}`.slice(-2_000_000) }));
      } else if (message.eventType === "error") {
        updateRuntime((runtime) => ({ ...runtime, feedback: message.data || `${containerTerminal ? "Container" : "Local"} terminal failed` }));
      } else if (message.eventType === "disconnected") {
        updateRuntime((runtime) => ({ ...runtime, status: "disconnected", feedback: message.data || `${containerTerminal ? "Container" : "Local"} terminal disconnected`, sessionId: "" }));
      }
    };
    const start = containerTerminal
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
  }, [clusterId, state?.id, state?.mode, containerTerminal, selectedPod?.key, selectedContainer, terminalReloadToken]);
  useEffect(() => {
    if (!state || state.mode !== "logs" || !selectedPod) return;
    if (!nativeBackendAvailable) {
      const lines = [
        "2026-07-26T15:10:41Z \u001b[32mINFO\u001b[0m request completed method=GET path=/health status=200 latency=4ms",
        "2026-07-26T15:10:43Z \u001b[32mINFO\u001b[0m payment authorized order=ord_8142 provider=stripe",
        "2026-07-26T15:10:46Z \u001b[33mWARN\u001b[0m retrying upstream service=inventory attempt=2",
      ];
      setOutput(lines.map((line) => logTimestamps ? line : line.replace(/^\S+\s/, "")).slice(-logTailLines).join("\n"));
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
  }, [clusterId, state?.id, state?.mode, selectedPod?.key, selectedContainer, logFollow, logTailLines, logPrevious, logTimestamps]);
  if (!state) return null;
  const readOnlyReason = state.readOnlyReason;
  const manifestReadOnly = Boolean(readOnlyReason);
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => { event.preventDefault(); event.stopPropagation(); const currentHeight = collapsed ? 38 : dockRef.current?.getBoundingClientRect().height ?? height; if (collapsed) { setHeight(38); onToggleCollapsed(); } setMaximized(false); resize.current = { startY: event.clientY, startHeight: currentHeight, currentHeight }; document.body.classList.add("resizing-session-sheet"); };
  const sessionModeLabel = (session: BottomSession) => session.mode === "terminal" ? (session.terminalTarget === "container" || (session.terminalTarget === undefined && session.item) ? tr(language, "containerTerminal") : tr(language, "localTerminal")) : session.mode === "logs" ? tr(language, "logs") : session.mode === "files" ? tr(language, "files") : session.mode === "edit" ? session.readOnlyReason ? tr(language, "view") : tr(language, "edit") : tr(language, "create");
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
    if (!nativeBackendAvailable) {
      updateActiveTerminalRuntime((runtime) => ({ ...runtime, output: `${runtime.output}${data === "\r" ? "\r\nbrowser demo\r\n$ " : data}`.slice(-2_000_000) }));
      return;
    }
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
    if (!nativeBackendAvailable) {
      setFeedback("Applied successfully in browser demo mode");
      onApplied();
      if (closeAfter) onCloseSession(state.id);
      return;
    }
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
    if (!nativeBackendAvailable) { setFeedback(`${format.toUpperCase()} is valid in browser demo mode`); return; }
    setBusy(true); setFeedback(`Validating ${format.toUpperCase()} with Kubernetes API…`);
    try {
      await backend.applyManifest({ clusterId, manifest, format, resource: state.descriptor ?? state.item?.row?.descriptor, dryRun: true, force: false });
      setFeedback(`${format.toUpperCase()} is valid`);
    } catch (nextError) { setFeedback(String(nextError)); }
    finally { setBusy(false); }
  };
  const handleSessionShortcut = (event: ReactKeyboardEvent<HTMLElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      event.stopPropagation();
      setSearchOpen(true);
    }
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
  const editorFeedbackTone = feedback.includes("success") || feedback.includes(" is valid") || feedback.startsWith("Converted")
    ? "green"
    : feedback.includes("Applying") || feedback.includes("Validating")
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
  const fileSessionTargets = fileExplorer ? <div className="file-explorer-session-targets">
    <div className="file-explorer-session-targets-inline">{renderFileTargetSelectors()}</div>
    <div className="file-explorer-session-targets-overflow">
      <button type="button" aria-haspopup="dialog" aria-label={tr(language, "showTargetSelectors")} title={tr(language, "targetSelectors")}><Container size={14} /></button>
      <div className="file-explorer-session-targets-panel" role="group" aria-label={tr(language, "targetSelectors")}>{renderFileTargetSelectors(true)}</div>
    </div>
  </div> : undefined;

  return <section ref={dockRef} onKeyDown={handleSessionShortcut} className={cn("sheet sheet-bottom session-dock", collapsed && "collapsed", maximized && "maximized", !fileExplorer && (state.mode === "logs" || state.mode === "terminal" || state.mode === "edit" || state.mode === "create") && `content-theme-${contentTheme}`)} style={collapsed ? undefined : { height: maximized ? Math.max(220, window.innerHeight - 220) : height }}><div className="sheet-resize-edge horizontal" aria-label={tr(language, "resizeSessions")} role="separator" aria-orientation="horizontal" onPointerDown={startResize} /><div className="session-tabbar"><div ref={tabListRef} className="bottom-session-tabs">{sessions.map((session) => {
    const Icon = session.mode === "terminal" ? SquareTerminal : session.mode === "logs" ? ScrollText : session.mode === "files" ? FolderOpen : session.mode === "edit" ? Pencil : Plus; return <button key={session.id} className={cn(session.id === state.id && "active")} onClick={() => onActivate(session.id)} onContextMenu={(event) => openContextMenu(event, [
      { type: "item", id: "close", label: tr(language, "close"), onSelect: () => onCloseSession(session.id) },
      { type: "item", id: "close-others", label: tr(language, "closeOthers"), disabled: sessions.length <= 1, onSelect: () => onCloseOthers(session.id) },
      { type: "item", id: "close-all", label: tr(language, "closeAll"), onSelect: onCloseAll },
    ])}><Icon size={12} /><span>{sessionTitle(session)}</span><i role="button" aria-label={`${tr(language, "close")} ${sessionTitle(session)}`} onClick={(event) => { event.stopPropagation(); onCloseSession(session.id); }}><X size={10} /></i></button>;
  })}</div><div className="session-add" ref={addMenuRef}><Button variant="ghost" size="icon" className="session-add-trigger" aria-label={tr(language, "addSession")} title={tr(language, "addSession")} onClick={() => setAddMenuOpen((value) => !value)}><Plus size={13} /></Button>{addMenuOpen && <div className="session-add-menu"><button onClick={() => { onCreateSession({ mode: "terminal", terminalTarget: "local", sessionKey: `terminal-${Date.now()}`, label: terminalOption }); setAddMenuOpen(false); }}><SquareTerminal size={13} /><span>{terminalOption}</span></button><button onClick={() => { onCreateSession({ mode: "create", sessionKey: `resource-${Date.now()}`, label: resourceOption }); setAddMenuOpen(false); }}><Plus size={13} /><span>{resourceOption}</span></button></div>}</div><div className="session-tab-spacer" /><Button variant="ghost" size="icon" aria-label={maximized ? tr(language, "restoreSessions") : tr(language, "maximizeSessions")} onClick={() => { if (collapsed) onToggleCollapsed(); setMaximized((value) => !value); }}>{maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</Button><Button variant="ghost" size="icon" aria-label={collapsed ? tr(language, "expandSessions") : tr(language, "collapseSessions")} onClick={onToggleCollapsed}><ChevronDown className={cn(collapsed && "rotate-180")} size={15} /></Button></div>{!collapsed && <>{!fileExplorer && <div className="session-action-bar"><div className="session-primary-actions">{(state.mode === "edit" || state.mode === "create") && !manifestReadOnly && <><Button size="sm" disabled={busy || !manifestText.trim() || manifestHasErrors(manifestValidation)} onClick={() => void apply(false)}>{busy && <LoaderCircle className="spin" size={13} />}{tr(language, "apply")}</Button><Button variant="secondary" size="sm" disabled={busy || !manifestText.trim() || manifestHasErrors(manifestValidation)} onClick={() => void apply(true)}> {tr(language, "applyAndClose")}</Button></>}{readOnlyReason && <span className="manifest-read-only-notice" role="status"><Info size={13} aria-hidden="true" /><span>{readOnlyReason}</span></span>}{(state.mode === "logs" || state.mode === "terminal") && <span className={cn("session-runtime-status", `status-${runtimeTone}`)} role="status" aria-label={runtimeStatusLabel} title={runtimeStatusLabel} data-status={runtimeStatus} />}{(state.mode === "logs" || containerTerminal || fileExplorer) && <>{showPodTarget && <Combobox className="session-target-combobox pod-target-combobox" ariaLabel="Pod" leadingIcon={Box} searchable={false} value={selectedPodKey} options={podOptions} onChange={setSelectedPodKey} />}<Combobox className="session-target-combobox container-target-combobox" ariaLabel="Container" leadingIcon={Container} searchable={false} value={selectedContainer} options={containerOptions} onChange={setSelectedContainer} />{targetsLoading && <LoaderCircle className="spin session-action-spinner" size={13} />}</>}</div><div className="session-secondary-actions">{(state.mode === "edit" || state.mode === "create") && !manifestReadOnly && <><div className="manifest-format-switch" role="group" aria-label="Manifest format">{(["yaml", "json"] as ManifestFormat[]).map((format) => <button key={format} type="button" className={cn(manifestFormat === format && "active")} aria-pressed={manifestFormat === format} disabled={busy} onClick={() => changeManifestFormat(format)}>{format.toUpperCase()}</button>)}</div><Button variant="outline" size="sm" disabled={busy || !manifestText.trim()} onClick={() => void validateActiveManifest()}><ShieldCheck size={13} />Validate {manifestFormat.toUpperCase()}</Button></>}{state.mode === "terminal" && terminalStatus === "disconnected" && <Button variant="outline" size="sm" onClick={() => void reconnectTerminal()}><RefreshCw size={13} />Reconnect</Button>}{state.mode === "logs" && <><Combobox className="session-tail-combobox" ariaLabel="Tail lines" label="Tail" searchable={false} value={String(logTailLines)} options={[100, 500, 1000, 5000, 10000].map((value) => ({ value: String(value), label: String(value) }))} onChange={(value) => setLogTailLines(Number(value))} /><label className="session-checkbox"><input type="checkbox" checked={logTimestamps} onChange={(event) => setLogTimestamps(event.target.checked)} /><span>Timestamps</span></label><label className="session-checkbox"><input type="checkbox" checked={logFollow} onChange={(event) => setLogFollow(event.target.checked)} /><span>Follow</span></label><label className="session-checkbox" title="Show logs from the previous terminated container instance"><input type="checkbox" aria-label="Previous terminated container logs" checked={logPrevious} onChange={(event) => setLogPrevious(event.target.checked)} /><span>Previous</span></label><label className="session-checkbox"><input type="checkbox" checked={logWrapLines} onChange={(event) => setLogWrapLines(event.target.checked)} /><span>Wrap</span></label><Button variant="ghost" size="icon" aria-label="Download logs" title="Download logs" disabled={!output} onClick={downloadLogs}><Download size={14} /></Button></>}{state.mode !== "files" && <Button variant="secondary" size="icon" aria-label="Find text" title="Find text (Ctrl/Cmd+F)" onClick={() => setSearchOpen((open) => !open)}><Search size={14} /></Button>}</div><TextSearchPopover open={searchOpen} onClose={() => setSearchOpen(false)} search={textSearch} language={language} /></div>}{(state.mode === "edit" || state.mode === "create") && <div className="editor-layout"><Suspense fallback={<div className="manifest-editor-loading"><LoaderCircle className="spin" size={14} />Loading editor…</div>}><ManifestEditor key={`${runtimeKey}:${manifestFormat}`} documentId={runtimeKey} value={manifestText} format={manifestFormat} theme={contentTheme} fontFamily={contentFont} fontSize={contentFontSize} diagnostics={manifestValidation.diagnostics} selection={manifestSearchMatch ? { from: manifestSearchMatch.start, to: manifestSearchMatch.end } : undefined} language={language} readOnly={manifestReadOnly} onChange={setManifestText} onFind={() => setSearchOpen(true)} /></Suspense>{feedback && <Badge className="editor-feedback" tone={editorFeedbackTone}>{feedback}</Badge>}</div>}{state.mode === "logs" && <div className={cn("terminal-output logs-output", logWrapLines && "wrap-lines")} style={{ fontFamily: contentFont }}><pre style={{ fontSize: contentFontSize }}><AnsiHighlightedText text={output} matches={textSearch.matches} currentIndex={textSearch.currentIndex} /></pre></div>}{state.mode === "terminal" && <div className="terminal-output terminal-interactive"><Suspense fallback={<div className="terminal-loading"><LoaderCircle className="spin" size={14} />Loading terminal…</div>}><ContainerTerminal language={language} sessionId={terminalSessionId} output={terminalOutput} connected={terminalStatus === "connected"} theme={contentTheme} fontFamily={contentFont} fontSize={contentFontSize} search={textSearch} onInput={writeTerminalInput} onResize={resizeContainerTerminal} onFind={() => setSearchOpen(true)} /></Suspense></div>}{state.mode === "files" && <ContainerFileExplorer target={selectedPod ? { clusterId, namespace: selectedPod.namespace, pod: selectedPod.pod, container: selectedContainer || undefined } : undefined} appTheme={appTheme} contentFont={contentFont} contentFontSize={contentFontSize} language={language} sessionTargetControls={fileSessionTargets} onToast={onToast} />}</>}</section>;
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

function AlertsDialog({ clusterId, language, onClose }: { clusterId: string; language: AppLanguage; onClose: () => void }) {
  const [items, setItems] = useState(events.slice(0, 2));
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
  const updateAvailable = updateState.status === "available" && update;
  const progress = updateState.contentLength && updateState.contentLength > 0
    ? Math.min(100, Math.round((updateState.downloadedBytes / updateState.contentLength) * 100))
    : 35;
  const status = updateState.status === "checking"
    ? { title: "Checking for updates", detail: "Verifying the signed GitHub release." }
    : updateState.status === "available" && update
      ? { title: `Version ${update.version} is ready`, detail: update.date ? `Published ${new Date(update.date).toLocaleDateString()}` : "A signed update is ready to install." }
      : updateState.status === "downloading"
        ? { title: "Installing update", detail: updateState.contentLength ? `${Math.round(updateState.downloadedBytes / 1024 / 1024)} MB of ${Math.round(updateState.contentLength / 1024 / 1024)} MB downloaded` : "Downloading and verifying the signed update." }
        : updateState.status === "current"
          ? { title: "You are up to date", detail: `KubeHive ${appVersion} is the latest release.` }
          : updateState.status === "unsupported"
            ? { title: "Updates require the desktop app", detail: "Run the packaged KubeHive app to check signed releases." }
            : updateState.status === "error"
              ? { title: localizedUpdateError(language, updateState.message), detail: "" }
              : { title: "Stable release channel", detail: `KubeHive ${appVersion}` };
  const canCheck = updateState.status !== "checking" && updateState.status !== "downloading";
  return <div className="modal-backdrop panel-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="about-modal" role="dialog" aria-modal="true" aria-labelledby="about-title" onMouseDown={(event) => event.stopPropagation()}>
    <header className="about-header"><img className="about-logo" src={kubeHiveLogo} alt="" /><div className="about-heading"><h2 id="about-title">{tr(language, "aboutKubeHive")}</h2><p>{tr(language, "desktopClient")}</p></div><Button variant="ghost" size="icon" aria-label={tr(language, "close")} onClick={onClose}><X size={15} /></Button></header>
    <div className="about-scroll"><section className="about-summary"><div><strong>KubeHive {appVersion}</strong><span>{tr(language, "desktopClientDescription")}</span></div><Badge tone="green">{tr(language, "stable")}</Badge></section><div className="about-meta"><a href="https://github.com/poneding/kubehive" target="_blank" rel="noreferrer" onClick={(event) => { event.preventDefault(); void openUrl("https://github.com/poneding/kubehive"); }}><ExternalLink size={12} />{tr(language, "githubRepository")}</a></div>
      <section className="about-update"><div className="about-section-heading"><Download size={15} /><h3>{tr(language, "updates")}</h3></div><div className="about-update-card"><div className={cn("about-update-status", updateState.status === "error" && "error")}>{updateState.status === "checking" || updateState.status === "downloading" ? <LoaderCircle className="spin" size={16} /> : updateState.status === "error" ? <AlertTriangle size={16} /> : updateAvailable ? <Download size={16} /> : <CheckCircle2 size={16} />}<div><strong>{status.title}</strong><span>{status.detail}</span></div></div>{updateState.status === "downloading" && <div className="about-progress" aria-label={tr(language, "updateDownloadProgress")}><i style={{ width: `${progress}%` }} /></div>}<div className="about-update-actions">{canCheck && <Button variant="outline" size="sm" onClick={onCheckUpdates}><RefreshCw size={13} />{tr(language, "checkForUpdates")}</Button>}{updateAvailable && <Button size="sm" onClick={onInstallUpdate}><Download size={13} />{tr(language, "installAndRestart")}</Button>}</div>{updateAvailable && <div className="about-changelog"><h4>{tr(language, "whatsNew")}</h4><div className="about-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => { const safeHref = typeof href === "string" && /^https?:\/\//i.test(href) ? href : null; return safeHref ? <a href={safeHref} target="_blank" rel="noreferrer" onClick={(event) => { event.preventDefault(); void openUrl(safeHref); }}>{children}</a> : <span>{children}</span>; } }}>{update.body?.trim() || tr(language, "noReleaseNotes")}</ReactMarkdown></div></div>}</div></section>
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
    <section className="settings-section"><div className="settings-section-title"><Globe2 size={15} /><div><h3>{t(language, "application")}</h3><p>{tr(language, "languageAppearance")}</p></div></div><div className="settings-card"><div className="settings-row"><span><strong>{t(language, "language")}</strong><small>{tr(language, "appliesImmediately")}</small></span><Combobox value={preferences.language} onChange={(value) => update("language", value as AppLanguage)} options={[{ value: "en", label: "English" }, { value: "zh-CN", label: "简体中文" }, { value: "zh-TW", label: "繁體中文" }]} /></div><div className="settings-row"><span><strong>{t(language, "theme")}</strong><small>{tr(language, "systemAppearance")}</small></span><Combobox value={preferences.theme} onChange={(value) => update("theme", value as Preferences["theme"])} options={["system", "light", "dark"].map((value, index) => ({ value, label: themeLabels[index] }))} /></div></div></section>
    <section className="settings-section"><div className="settings-section-title"><Type size={15} /><div><h3>{t(language, "terminal")}</h3><p>{tr(language, "contentAppearanceDescription")}</p></div></div><div className="settings-card"><div className="settings-row"><span><strong>{t(language, "contentTheme")}</strong><small>{tr(language, "contentColors")}</small></span><Combobox value={preferences.contentTheme} onChange={(value) => update("contentTheme", value as ContentTheme)} options={["system", "dark", "light"].map((value, index) => ({ value, label: contentThemeLabels[index] }))} /></div><div className="settings-row"><span><strong>{t(language, "contentFont")}</strong><small>{tr(language, "installedFonts")}</small></span><Combobox value={preferences.contentFont} onChange={(value) => update("contentFont", value)} options={["monospace", "JetBrains Mono", "SFMono-Regular", "Cascadia Code", "Fira Code", "IBM Plex Mono"].map((value) => ({ value, label: value }))} /></div><div className="settings-row"><span><strong>{t(language, "contentFontSize")}</strong><small>{tr(language, "contentText")}</small></span><Combobox value={String(preferences.contentFontSize)} onChange={(value) => update("contentFontSize", Number(value) as Preferences["contentFontSize"])} options={contentFontSizes.map((value) => ({ value: String(value), label: `${value} px` }))} /></div></div></section>
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
        {mode === "file" && <label className="file-drop" onDragOver={(event) => event.preventDefault()} onDrop={async (event) => { event.preventDefault(); const file = event.dataTransfer.files?.[0]; setFileName(file?.name ?? ""); setKubeconfig(file ? await file.text() : ""); }}><input type="file" accept=".yaml,.yml,.config" onChange={async (event) => { const file = event.target.files?.[0]; setFileName(file?.name ?? ""); setKubeconfig(file ? await file.text() : ""); }} /><Upload size={22} /><strong>{fileName || tr(language, "dropKubeconfig")}</strong><span>{fileName ? tr(language, "readyToImport") : tr(language, "chooseFile")}</span></label>}
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

export default function App() {
  const [availableClusters, setAvailableClusters] = useState<Cluster[]>(() => {
    try {
      const colors = JSON.parse(localStorage.getItem("kubehive.clusterColors") ?? "{}") as Record<string, string>;
      return applySavedClusterOrder(initialClusters.map((item) => ({ ...item, color: colors[item.id] ?? item.color })));
    } catch { return applySavedClusterOrder(initialClusters); }
  });
  const [cluster, setCluster] = useState(() => availableClusters[0] ?? initialClusters[0]);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("clusters");
  const [clusterOperationId, setClusterOperationId] = useState<string | null>(null);
  const [clusterConnection, setClusterConnection] = useState<ClusterConnectionState | null>(null);
  const [initialClusterWorkspaces] = useState<Record<string, ClusterWorkspaceState>>(() => loadClusterWorkspaces());
  const clusterWorkspacesRef = useRef(initialClusterWorkspaces);
  const [namespace, setNamespace] = useState("All namespaces");
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
  const [bottomSessions, setBottomSessions] = useState<BottomSession[]>([]);
  const [activeBottomId, setActiveBottomId] = useState("");
  const [bottomCollapsed, setBottomCollapsed] = useState(false);
  const [terminalRuntimes, setTerminalRuntimesState] = useState<TerminalRuntimeMap>({});
  const terminalRuntimesRef = useRef<TerminalRuntimeMap>({});
  const [bottomSessionCaches, setBottomSessionCachesState] = useState<BottomSessionCacheMap>({});
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [alertCount, setAlertCount] = useState(0);
  const [discoveredResources, setDiscoveredResources] = useState<ApiResourceDescriptor[]>([]);
  const [clusterNamespaces, setClusterNamespaces] = useState<string[]>(["commerce", "search", "storefront", "ingress-nginx", "monitoring", "argocd", "cert-manager"]);
  const [dataRevision, setDataRevision] = useState(0);
  const [backendError, setBackendError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ResourceRow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [portForwardDialog, setPortForwardDialog] = useState<PortForwardDialogState | null>(null);
  const [portForwardSessions, setPortForwardSessions] = useState<PortForwardSession[]>([]);
  const [portForwardBusy, setPortForwardBusy] = useState(false);
  const [portForwardError, setPortForwardError] = useState("");
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
      return { ...defaultPreferences, ...saved, language, contentFontSize };
    } catch { return defaultPreferences; }
  });
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
  const updateBottomSessionCaches: RuntimeMapUpdater<BottomSessionCacheMap> = (update) => setBottomSessionCachesState(update);
  const disposeBottomSessions = (clusterId: string, sessionIds: string[]) => {
    if (!sessionIds.length) return;
    const discarded = new Set(sessionIds.map((id) => `${clusterId}::${id}`));
    discarded.forEach((id) => {
      const runtime = terminalRuntimesRef.current[id];
      if (runtime?.sessionId && nativeBackendAvailable) void backend.stopTerminal(runtime.sessionId);
    });
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
    persistClusterWorkspace(activeCluster.id, { tabs, activeTabId, namespace, bottomSessions, activeBottomId, bottomCollapsed });
  };
  const restoreClusterWorkspace = (clusterId: string) => {
    const workspace = normalizeClusterWorkspace(clusterWorkspacesRef.current[clusterId]);
    setTabs(workspace.tabs.map((tab) => ({ ...tab })));
    setActiveTabId(workspace.activeTabId);
    setNamespace(workspace.namespace);
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
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast((current) => current?.id === toast.id ? null : current), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const showToast = (tone: AppToast["tone"], message: string, filePath?: string) => setToast({ id: Date.now(), tone, message, filePath });
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
      setAvailableClusters(next);
      setCluster(next[0]);
      setWorkspaceView("clusters");
      setBackendError("");
    }).catch((error) => { if (!cancelled) { setBackendError(String(error)); setAvailableClusters([unconfiguredCluster]); setCluster(unconfiguredCluster); setWorkspaceView("clusters"); } });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
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
    persistClusterWorkspace(activeCluster.id, { tabs, activeTabId, namespace, bottomSessions, activeBottomId, bottomCollapsed });
  }, [activeCluster.id, activeCluster.disconnected, activeTabId, namespace, tabs, bottomSessions, activeBottomId, bottomCollapsed, workspaceView]);

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
  const openWorkload = (item: Workload) => {
    const resourceName = item.kind === "CronJob" ? "CronJobs" : `${item.kind}s`;
    const row = getResourceRows(resourceName).find((entry) => entry.name === item.name && entry.namespace === item.namespace);
    if (row) openResourceRow(row); else setDetail({ id: `${item.namespace}/${item.name}`, label: item.name, subtitle: item.namespace, type: "resource", workload: item });
  };
  const baseDetailForRow = (row: ResourceRow): DetailItem => ({ id: `${row.kind}:${row.key}`, label: row.name, subtitle: row.namespace, type: row.kind === "CustomResource" ? "crd" : "resource", kind: row.kind, status: row.status, workload: row.workload ? { ...row.workload, name: row.name } : undefined, row, loading: Boolean(nativeBackendAvailable && row.backend && row.descriptor), relationsLoading: true, relations: [] });
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
  const openResourceRow = (row: ResourceRow) => {
    const base = baseDetailForRow(row);
    setDetail(base);
    void (async () => {
      const hydrated = await fetchDetailForRow(row);
      const hydratedRow = hydrated.row ?? row;
      setDetail((current) => current?.id === hydrated.id ? { ...hydrated, relationsLoading: true, relations: current.relations ?? [] } : current);
      try {
        const relations = await resolveResourceRelations(activeCluster.id, hydratedRow, discoveredResources);
        setDetail((current) => current?.id === hydrated.id ? { ...current, relations, relationsLoading: false, relationsError: undefined } : current);
      } catch (error) {
        setDetail((current) => current?.id === hydrated.id ? { ...current, relationsLoading: false, relationsError: String(error) } : current);
      }
    })();
  };
  const openRelatedLink = (link: ResourceLink, row: ResourceRow) => {
    const related = buildRelatedDetail(link, row);
    const id = `related/${related.kind}/${related.namespace ?? "cluster"}/${related.name}`;
    setDetail({ id, label: related.name, subtitle: related.namespace ?? related.relation, type: "related", kind: related.kind, related, loading: true });
    void resolveResourceLink(activeCluster.id, { ...link, namespace: link.namespace ?? (row.namespace === "—" ? undefined : row.namespace) }, discoveredResources).then((resolved) => {
      if (resolved) openResourceRow(resolved);
      else setDetail((current) => current?.id === id ? { ...current, loading: false, error: `Unable to resolve ${link.kind}/${link.name}` } : current);
    }).catch((error) => setDetail((current) => current?.id === id ? { ...current, loading: false, error: String(error) } : current));
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
    const item = await fetchDetailForRow(row);
    if (action === "Logs" || action === "Terminal" || action === "Files") {
      openBottomSession({ mode: action === "Logs" ? "logs" : action === "Terminal" ? "terminal" : "files", item, terminalTarget: action === "Terminal" || action === "Files" ? "container" : undefined });
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
      if (action === "Scale") {
        const current = Number(String(row.data.ready ?? row.data.desired ?? "1").split("/").at(-1)) || 1;
        const value = window.prompt(`Scale ${target.resource.kind}/${target.name} to how many replicas?`, String(current));
        if (value === null) return;
        const replicas = Number(value);
        if (!Number.isInteger(replicas) || replicas < 0) throw new Error("Replicas must be a non-negative integer");
        await backend.scaleResource({ ...target, replicas });
      } else if (action === "Evict") {
        if (row.kind !== "Pod" || row.namespace === "—") throw new Error("Only namespaced Pods can be evicted");
        if (!window.confirm(`Evict Pod/${row.name} from its node? Kubernetes will honor PodDisruptionBudgets and graceful termination. A controller may recreate the Pod.`)) return;
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
    captureActiveClusterWorkspace();
    setClusterOperationId(target.id);
    if (reconnecting) {
      setCluster(target);
      setDiscoveredResources([]);
      setDetail(null);
      setNavOpen(false);
      setAlertsOpen(false);
      setWorkspaceView("cluster");
      setClusterConnection({ clusterId: target.id, phase: "connecting" });
    }
    try {
      const next = reconnecting
        ? nativeBackendAvailable
          ? { ...(await backend.reconnectCluster(target.id)), disconnected: false } as Cluster
          : { ...target, disconnected: false }
        : target;
      setAvailableClusters((current) => current.map((item) => item.id === next.id ? { ...item, ...next } : item));
      setCluster(next);
      restoreClusterWorkspace(next.id);
      setDiscoveredResources([]);
      setNavOpen(false);
      setAlertsOpen(false);
      setWorkspaceView("cluster");
      setClusterConnection(null);
      setAlertCount(nativeBackendAvailable ? 0 : events.filter((event) => event.level === "warning").length);
      setBackendError("");
    } catch (error) {
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
      setClusterOperationId(null);
    }
  };
  const retryClusterConnection = () => {
    const target = availableClusters.find((item) => item.id === activeCluster.id) ?? activeCluster;
    void connectAndOpenCluster(target, true);
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
      setNamespace("All namespaces");
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
    if (!nativeBackendAvailable) {
      const next: Cluster = { id: `imported-${Date.now()}`, name: request.displayName, provider: "Local", region: "kubeconfig", version: "v1.31.4", status: "healthy", nodes: 3, cpu: 18, memory: 34, imported: true, disconnected: true };
      setAvailableClusters((current) => [...current.filter((item) => item.id !== "unconfigured"), next]); setCluster(next); setWorkspaceView("clusters"); setAddClusterOpen(false); return;
    }
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
        // right details sheet, then the bottom session dock.
        if (deleteTarget) { if (!deleteBusy) { setDeleteTarget(null); setDeleteError(""); } return; }
        if (commandOpen) { setCommandOpen(false); return; }
        if (addClusterOpen) { setAddClusterOpen(false); return; }
        if (clusterSettingsId) { setClusterSettingsId(null); return; }
        if (settingsOpen) { setSettingsOpen(false); return; }
        if (aboutOpen) { setAboutOpen(false); return; }
        if (alertsOpen) { setAlertsOpen(false); return; }
        if (detail) { setDetail(null); return; }
        if (bottomSessions.length > 0 && !bottomCollapsed) { setBottomCollapsed(true); return; }
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [workspaceView, clusterConnection, activeCluster.id, deleteTarget, deleteBusy, commandOpen, addClusterOpen, clusterSettingsId, settingsOpen, aboutOpen, alertsOpen, detail, bottomSessions, bottomCollapsed, activeBottomId, tabs, activeTabId, openSettings]);

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
      {workspaceView === "clusters" ? <ClusterHome clusters={availableClusters} language={language} busyClusterId={clusterOperationId} onConnect={(target) => void connectAndOpenCluster(target)} onCloseConnection={(target) => void closeClusterConnection(target)} onSettings={(target) => setClusterSettingsId(target.id)} onRemove={removeCluster} onAdd={() => setAddClusterOpen(true)} /> : clusterConnection?.clusterId === activeCluster.id ? <ClusterConnectionPage cluster={activeCluster} language={language} state={clusterConnection} busy={clusterOperationId === activeCluster.id} onReconnect={retryClusterConnection} onClose={() => void closeClusterConnection(activeCluster)} /> : <>
        <ResourceNav active={resource} cluster={activeCluster} language={language} discovered={discoveredResources} onSelect={(item, permanent) => openResourcePage(item, undefined, { permanent })} onCloseCluster={() => void closeClusterConnection(activeCluster)} closing={clusterOperationId === activeCluster.id} open={navOpen} onClose={() => setNavOpen(false)} />
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
            onCommand={() => setCommandOpen(true)}
          />
          {resource === "Overview"
            ? <Overview cluster={activeCluster} language={language} revision={dataRevision} onWorkload={openWorkload} onResource={openResourceRow} onTerminal={() => openBottomSession({ mode: "terminal", terminalTarget: "local" })} onNavigate={openResourcePage} onSnapshot={(snapshot) => { updateCluster(activeCluster.id, { nodes: snapshot.nodes, cpu: snapshot.cpuPercent ?? 0, memory: snapshot.memoryPercent ?? 0, version: snapshot.version, status: snapshot.readyNodes === snapshot.nodes ? "healthy" : "warning" }); setAlertCount(snapshot.events.filter((event) => event.level === "warning").length); }} />
            : resource === "Custom Resource Definitions"
              ? <CrdBrowser clusterId={activeCluster.id} discovered={discoveredResources} namespaces={clusterNamespaces} revision={dataRevision} selectedDefinitionName={activeTab.crdName ?? null} namespace={namespace} setNamespace={setNamespace} language={language} onKindSelect={(definition) => openResourcePage("Custom Resource Definitions", definition)} onBack={() => openResourcePage("Custom Resource Definitions")} onInstance={openResourceRow} onCreate={openCreateSession} onOpenLink={openRelatedLink} />
              : <ResourceTable clusterId={activeCluster.id} discovered={discoveredResources} namespaces={clusterNamespaces} revision={dataRevision} resource={resource} namespace={namespace} setNamespace={setNamespace} language={language} onSelect={openResourceRow} onOpenLink={openRelatedLink} onCreate={resource === "Port Forwarding" ? () => requestPortForward() : openCreateSession} onRowAction={(action, row) => void performResourceAction(action, row)} />}
          {bottomSessions.length > 0 && <BottomActionSheet clusterId={activeCluster.id} sessions={bottomSessions} activeId={activeBottomId} collapsed={bottomCollapsed} language={language} appTheme={resolvedTheme} contentTheme={contentAppearance} contentFont={preferences.contentFont} contentFontSize={preferences.contentFontSize} terminalRuntimes={terminalRuntimes} sessionCaches={bottomSessionCaches} onUpdateTerminalRuntimes={updateTerminalRuntimes} onUpdateSessionCaches={updateBottomSessionCaches} onActivate={(id) => { setActiveBottomId(id); setBottomCollapsed(false); }} onCloseSession={closeBottomSession} onCloseOthers={closeOtherSessions} onCloseAll={closeAllSessions} onCreateSession={openBottomSession} onToggleCollapsed={() => setBottomCollapsed((value) => !value)} onApplied={() => setDataRevision((value) => value + 1)} onToast={showToast} />}
        </main>
      </>}
    </div>
    {workspaceView === "cluster" && detail && <DetailSheet tab={detail} language={language} onClose={() => setDetail(null)} onOpenResource={openResourceRow} onPortForward={(row, port) => requestPortForward(row, port, false)} portForwardSessions={portForwardSessions} onOpenPortForward={(session) => void openPortForwardSession(session)} onPausePortForward={(session) => void pausePortForwardSession(session)} onResumePortForward={(session) => void resumePortForwardSession(session)} onStopPortForward={(session) => stopPortForwardSession(session)} onAction={(action) => { if (detail.row) void performResourceAction(action, detail.row); else if (action === "Logs" || action === "Terminal" || action === "Files" || action === "Edit") { openBottomSession({ mode: action === "Logs" ? "logs" : action === "Terminal" ? "terminal" : action === "Files" ? "files" : "edit", item: detail, terminalTarget: action === "Terminal" || action === "Files" ? "container" : undefined, manifest: detail.manifest }); setDetail(null); } }} />}
    {deleteTarget && <ResourceDeleteDialog row={deleteTarget} busy={deleteBusy} error={deleteError} language={language} onClose={closeResourceDelete} onConfirm={() => void confirmResourceDelete()} />}
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
