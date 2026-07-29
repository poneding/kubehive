import { getCurrentWindow } from "@tauri-apps/api/window";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  Activity, AlertTriangle, Bell, Box, Boxes, CheckCircle2, ChevronDown, ChevronRight, CircleDot, Code2,
  Command, Container, Copy, Cpu, Database, Download, FileCode2, FileKey, FilePen, FileUp, Gauge, Globe2, HardDrive, Hexagon,
  Layers3, LayoutDashboard, LoaderCircle, Logs, Maximize2, Menu, Minimize2, Minus, MoreHorizontal, Network,
  Pencil, Play, Plus, Power,
  RefreshCw, Scale, Search, Server, Settings, ShieldCheck, SlidersHorizontal, Square, SquareTerminal, Trash2, Type, Upload,
  Users, Wifi, X, Zap, createLucideIcon
} from "lucide-react";
import { Fragment, Suspense, lazy, useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { AnsiHighlightedText, ansiToPlainText } from "./ansi-log";
import kubeHiveLogo from "./assets/kubehive-logo.svg";
import { backend, descriptorForResource, nativeBackendAvailable, type ApiResourceDescriptor, type BackendResourceRecord, type ClusterOverview as LiveClusterOverview } from "./backend";
import { ColumnPicker, useVisibleColumns } from "./column-picker";
import { Combobox } from "./combobox";
import { ClusterHoverCard, ClusterSettingsDialog, ContextMenuHost, openContextMenu } from "./context-menu";
import {
  clusterAccent,
  customResourceDefinitions, customResources, events,
  clusters as initialClusters,
  navGroups, workloads,
  type Cluster, type CustomResource, type CustomResourceDefinition, type Workload,
} from "./data";
import { crdDefinitionFromRecord, rowFromBackend, valueFromJsonPath } from "./k8s-adapter";
import { defaultPreferences, groupLabel, resourceLabel, t, type AppLanguage, type Preferences, type TerminalTheme } from "./preferences";
import { getResourceRows, type ResourceLink, type ResourceRow } from "./resource-catalog";
import { buildResourceDetailSections, getResourceAnnotations, getResourceConditions, getResourceLabels } from "./resource-details";
import { resolveResourceLink, resolveResourceRelations, type ResourceRelationGroup } from "./resource-relations";
import { ContainerSquares, ResourceLinkButton, VirtualResourceTable, type VirtualTableColumn } from "./table-extras";
import { TextSearchPopover, useTextSearch } from "./text-search";
import { Badge, Button, Progress, cn } from "./ui";
import "./index.css";
import "./workbench.css";
import "./platform.css";
import "./settings.css";
import "./refinements.css";
import "./tab-polish.css";
import "./sheet-polish.css";
import "./resource-details.css";
import "./session-settings-polish.css";
import "./final-alignment.css";

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
type BottomRequest = { mode: "create" | "edit" | "logs" | "terminal"; item?: DetailItem; sessionKey?: string; label?: string; manifest?: string; descriptor?: ApiResourceDescriptor };
type BottomSession = BottomRequest & { id: string };
type BottomSessionCache = {
  manifestText?: string;
  output?: string;
  feedback?: string;
  selectedPodKey?: string;
  selectedContainer?: string;
  logTailLines?: number;
  logFollow?: boolean;
  logTimestamps?: boolean;
  logWrapLines?: boolean;
  terminalReloadToken?: number;
};
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
type PodSessionTarget = { key: string; namespace: string; pod: string; phase: string; ready: boolean; initContainers: string[]; containers: string[] };
type TerminalConnectionStatus = "idle" | "connecting" | "connected" | "disconnected";
type TerminalRuntime = { sessionId: string; output: string; status: TerminalConnectionStatus; feedback: string; connectionKey: string; targetLabel: string; podKey: string; container: string };
type DesktopPlatform = "macos" | "windows" | "linux";
type WorkspaceView = "clusters" | "cluster";

const platform: DesktopPlatform = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "macos" : /Win/.test(navigator.userAgent) ? "windows" : "linux";
const ContainerTerminal = lazy(() => import("./container-terminal"));
const unconfiguredCluster: Cluster = { id: "unconfigured", name: "No cluster configured", provider: "Local", region: "Add a kubeconfig to begin", version: "—", status: "offline", nodes: 0, cpu: 0, memory: 0, disconnected: true };
const clusterWorkspaceStorageKey = "kubehive.clusterWorkspaces";
const clusterOrderStorageKey = "kubehive.clusterOrder";

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
    if (typeof session.id !== "string" || seen.has(session.id) || !["create", "edit", "logs", "terminal"].includes(session.mode ?? "")) return [];
    seen.add(session.id);
    return [{
      id: session.id,
      mode: session.mode!,
      sessionKey: typeof session.sessionKey === "string" ? session.sessionKey : undefined,
      label: typeof session.label === "string" ? session.label : undefined,
      manifest: typeof session.manifest === "string" ? session.manifest : undefined,
      item: session.item && typeof session.item === "object" ? session.item : undefined,
      descriptor: session.descriptor && typeof session.descriptor === "object" ? session.descriptor : undefined,
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

function useAutoHideScrollbars() {
  useEffect(() => {
    const timers = new Map<Element, number>();
    const reveal = (target: EventTarget | null) => {
      const element = target instanceof Element ? target : document.documentElement;
      element.classList.add("is-scrolling");
      const previous = timers.get(element);
      if (previous) window.clearTimeout(previous);
      timers.set(element, window.setTimeout(() => { element.classList.remove("is-scrolling"); timers.delete(element); }, 900));
    };
    const onScroll = (event: Event) => reveal(event.target);
    const onWheel = (event: Event) => { let node = event.target instanceof Element ? event.target : null; while (node && node.scrollHeight <= node.clientHeight && node.scrollWidth <= node.clientWidth) node = node.parentElement; reveal(node); };
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("wheel", onWheel, { capture: true, passive: true });
    return () => { document.removeEventListener("scroll", onScroll, true); document.removeEventListener("wheel", onWheel, true); timers.forEach((timer) => window.clearTimeout(timer)); };
  }, []);
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
  return <span className={cn("status-dot", !bad && (normalized.includes("healthy") || normalized.includes("running") || normalized.includes("ready") || normalized.includes("synced")) && "ok", (normalized.includes("warning") || normalized.includes("degraded") || normalized.includes("pending") || normalized.includes("issuing") || normalized.includes("outofsync")) && "warn", bad && "err", normalized === "offline" && "off")} />;
}

function ClusterRail({ clusters, active, language, alertCount, alertsDisabled, onHome, onConnect, onAlerts, onSettings, onAdd, onClusterSettings, onCloseConnection, onMove, onReorder, onRemove }: {
  clusters: Cluster[];
  active: Cluster | null;
  language: AppLanguage;
  alertCount: number;
  alertsDisabled: boolean;
  onHome: () => void;
  onConnect: (cluster: Cluster) => void;
  onAlerts: () => void;
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
    <div className="rail-drag-region titlebar-chrome" data-tauri-drag-region aria-hidden="true" onDoubleClick={handleTitlebarDoubleClick} />
    <div className="rail-header"><button type="button" className="brand-mark" title={t(language, "clusters")} aria-label={t(language, "clusters")} onClick={onHome}><img src={kubeHiveLogo} alt="" /></button><div className="rail-divider" /></div>
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
          onContextMenu={(event) => openContextMenu(event, [
            { type: "item", id: "settings", label: t(language, "settings"), onSelect: () => onClusterSettings(cluster) },
            { type: "item", id: "move-up", label: t(language, "moveUp"), disabled: index === 0, onSelect: () => onMove(cluster.id, -1) },
            { type: "item", id: "move-down", label: t(language, "moveDown"), disabled: index === visibleClusters.length - 1, onSelect: () => onMove(cluster.id, 1) },
            { type: "separator" },
            cluster.disconnected
              ? { type: "item", id: "connect", label: t(language, "connect"), onSelect: () => onConnect(cluster) }
              : { type: "item", id: "close-connection", label: t(language, "closeConnection"), onSelect: () => onCloseConnection(cluster) },
            { type: "item", id: "remove", label: t(language, "remove"), danger: true, onSelect: () => onRemove(cluster) },
          ])}
        ><span>{cluster.name.slice(0, 2).toUpperCase()}</span><StatusDot status={cluster.disconnected ? "offline" : cluster.status} /></button>{dropLine(index + 1)}</Fragment>;
      })}
      <button type="button" className="cluster-icon add" title="Add cluster" aria-label={t(language, "addCluster")} onClick={onAdd}><Plus size={16} /></button>
    </div>
    <div className="rail-footer"><button type="button" className="rail-button alert-button" title={alertsDisabled ? t(language, "connectForAlerts") : "Alerts"} aria-label="Alerts" disabled={alertsDisabled} onClick={onAlerts}><Bell size={16} />{!alertsDisabled && alertCount > 0 && <i>{alertCount > 99 ? "99+" : alertCount}</i>}</button><button type="button" className="rail-button" title={t(language, "settings")} aria-label={t(language, "settings")} onClick={onSettings}><Settings size={16} /></button></div>
    {hover && <ClusterHoverCard cluster={hover.cluster} color={clusterAccent(hover.cluster)} anchor={hover.rect} />}
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
    <div className="nav-title"><span>{t(language, "resources")}</span><div className="nav-title-actions"><ResourceTreeFilter language={language} hidden={hiddenItems} onToggleItem={(item, visible) => updateHiddenItems((current) => { const next = new Set(current); if (visible) next.delete(item); else next.add(item); return next; })} onToggleGroup={(items, visible) => updateHiddenItems((current) => { const next = new Set(current); items.forEach((item) => visible ? next.delete(item) : next.add(item)); return next; })} onReset={() => updateHiddenItems(() => new Set())} /><Button variant="ghost" size="icon" className="mobile-only" aria-label="Close navigation" onClick={onClose}><X size={15} /></Button></div></div>
    <div className="nav-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Filter resources" placeholder={t(language, "filterResources")} /></div>
    <nav>{navGroups.map((group) => { const items = group.items.filter((item) => !hiddenItems.has(item) && `${item} ${resourceLabel(language, item)}`.toLowerCase().includes(query.toLowerCase())); if (!items.length) return null; return <section key={group.label}>{group.label !== "Overview" && <p>{groupLabel(language, group.label)}</p>}{items.map((item) => { const Icon = iconMap[item] ?? Box; const available = served(item); return <button key={item} type="button" aria-label={item} disabled={!available} title={available ? undefined : "This API is not served by the active cluster"} className={cn(active === item && "selected", !available && "unavailable")} onClick={() => { onSelect(item, false); onClose(); }} onDoubleClick={() => { onSelect(item, true); onClose(); }}><Icon size={14} /><span>{resourceLabel(language, item)}</span>{item === "Pods" && !nativeBackendAvailable && <small>148</small>}{!available && <small>—</small>}</button>; })}</section>; })}</nav>
    <div className="cluster-summary"><div className="cluster-summary-head"><span className="cluster-summary-icon">{cluster.name.slice(0, 2).toUpperCase()}</span><div><small>{t(language, "currentCluster")}</small><strong>{cluster.name}</strong></div><StatusDot status={cluster.status} /></div><div className="cluster-summary-meta"><span>{cluster.provider} · {cluster.region}</span><Badge>{cluster.version}</Badge></div><div className="cluster-summary-stats"><div className="cluster-summary-metrics"><span><strong>{cluster.nodes}</strong> nodes</span><span><strong>{cluster.cpu}%</strong> CPU</span></div><div className="cluster-summary-actions"><button type="button" disabled={closing} aria-label={closing ? t(language, "closingConnection") : t(language, "closeConnection")} title={closing ? t(language, "closingConnection") : t(language, "closeConnection")} onClick={onCloseCluster}><Power size={12} /></button></div></div></div>
  </aside>;
}

function ClusterActionsMenu({ cluster, language, busy, onConnect, onCloseConnection, onSettings, onRemove }: { cluster: Cluster; language: AppLanguage; busy: boolean; onConnect: () => void; onCloseConnection: () => void; onSettings: () => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
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
      <button type="button" disabled={busy} onClick={() => run(onConnect)}>{busy ? <LoaderCircle className="spin" size={13} /> : <Play size={13} />}<span>{cluster.disconnected ? t(language, "connect") : t(language, "openOverview")}</span></button>
      {!cluster.disconnected && <button type="button" disabled={busy} onClick={() => run(onCloseConnection)}><Power size={13} /><span>{t(language, "closeConnection")}</span></button>}
      <div />
      <button type="button" onClick={() => run(onSettings)}><Settings size={13} /><span>{t(language, "settings")}</span></button>
      <button type="button" className="danger" onClick={() => run(onRemove)}><Trash2 size={13} /><span>{t(language, "remove")}</span></button>
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
    <div className="home-titlebar titlebar-chrome" data-tauri-drag-region aria-hidden="true" onDoubleClick={handleTitlebarDoubleClick} />
    <div className="cluster-home-scroll"><div className="cluster-home">
      <header className="cluster-home-head"><div><div className="eyebrow">KUBERNETES WORKSPACES</div><h1>{t(language, "clusters")}</h1><p>{t(language, "clusterHomeDescription")}</p></div><Button size="sm" onClick={onAdd}><Plus size={13} />{t(language, "addCluster")}</Button></header>
      {listed.length ? <>
        <div className="table-toolbar cluster-home-toolbar"><div className="table-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t(language, "searchClusters")} placeholder={t(language, "searchClusters")} />{query && <button type="button" aria-label="Clear cluster search" onClick={() => setQuery("")}><X size={12} /></button>}</div><div className="toolbar-spacer" /><span><strong>{listed.length}</strong> {t(language, "configuredClusters")}</span><span><strong>{connected}</strong> {t(language, "connectedClusters")}</span></div>
        {filtered.length ? <section className="cluster-home-list" aria-label={t(language, "clusters")}>
          <div className="cluster-home-list-head"><span>{t(language, "cluster")}</span><span>{t(language, "provider")}</span><span>{t(language, "location")}</span><span>{t(language, "version")}</span><span>{t(language, "status")}</span><span /></div>
          {filtered.map((item) => <article key={item.id} data-cluster-id={item.id} className={cn("cluster-home-row", !item.disconnected && "connected", busyClusterId === item.id && "busy")} onDoubleClick={() => { if (busyClusterId !== item.id) onConnect(item); }}>
            <div className="cluster-home-identity"><span className="cluster-home-avatar" style={{ ["--cluster-accent" as string]: clusterAccent(item) }}>{item.name.slice(0, 2).toUpperCase()}<StatusDot status={item.disconnected ? "offline" : item.status} /></span><div><strong>{item.name}</strong><small>{item.context || item.server || item.id}</small></div></div>
            <span>{item.provider}</span><span title={item.server}>{item.region}</span><span className="cluster-home-version font-mono">{item.version}</span><span className={cn("cluster-connection-state", !item.disconnected && "connected")}><i />{item.disconnected ? t(language, "disconnected") : t(language, "connected")}</span>
            <ClusterActionsMenu cluster={item} language={language} busy={busyClusterId === item.id} onConnect={() => onConnect(item)} onCloseConnection={() => onCloseConnection(item)} onSettings={() => onSettings(item)} onRemove={() => onRemove(item)} />
          </article>)}
        </section> : <div className="cluster-home-filter-empty"><Search size={24} /><strong>{t(language, "noMatchingClusters")}</strong><span>{t(language, "noMatchingClustersHint")}</span></div>}
      </> : <div className="cluster-home-empty"><Hexagon size={32} /><strong>{t(language, "noClusters")}</strong><span>{t(language, "noClustersHint")}</span><Button size="sm" onClick={onAdd}><Plus size={13} />{t(language, "addCluster")}</Button></div>}
      <p className="cluster-home-tip"><Play size={12} />{t(language, "clusterConnectHint")}</p>
    </div></div>
  </main>;
}

/** Top window chrome height: blank pixels here can drag / double-click maximize. */
const TITLEBAR_GESTURE_HEIGHT = 42;

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
    ".workspace-tab-list",
    ".tabs-command",
    ".tabs-menu-button",
  ].join(", ")));
}

function handleTitlebarDoubleClick(event: ReactMouseEvent<HTMLElement>) {
  if (isWindowChromeInteractiveTarget(event.target)) return;
  event.preventDefault();
  void toggleWindowMaximize();
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

function WindowControls() {
  if (platform === "macos") return null;
  const run = (action: "minimize" | "maximize" | "close") => async () => {
    try {
      const window = getCurrentWindow();
      if (action === "minimize") await window.minimize();
      if (action === "maximize") await window.toggleMaximize();
      if (action === "close") await window.close();
    } catch { /* Browser prototype: controls are visual only. */ }
  };
  return <div className="window-controls" aria-label="Window controls"><button aria-label="Minimize" onClick={run("minimize")}><Minus size={13} /></button><button aria-label="Maximize" onClick={run("maximize")}><Square size={11} /></button><button className="close" aria-label="Close window" onClick={run("close")}><X size={13} /></button></div>;
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
  return <div className="workspace-tabs titlebar-chrome" data-tauri-drag-region onDoubleClick={handleTitlebarDoubleClick}>
    <Button variant="ghost" size="icon" className="mobile-only tabs-menu-button" onClick={onMenu}><Menu size={15} /></Button>
    <div className="workspace-tab-list">{tabs.map((tab) => {
      const Icon = tab.crdKind ? Code2 : (iconMap[tab.resource] ?? Box);
      const preview = isPreviewTab(tab);
      return <button
        key={tab.id}
        type="button"
        className={cn(activeId === tab.id && "active", preview && "preview")}
        title={preview ? "Preview tab · double-click to keep open" : tab.label}
        onClick={() => onActivate(tab.id)}
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (preview) onKeepOpen(tab.id);
        }}
        onContextMenu={(event) => openContextMenu(event, [
          { type: "item", id: "keep-open", label: "Keep Open", disabled: !preview, onSelect: () => onKeepOpen(tab.id) },
          { type: "separator" },
          { type: "item", id: "close", label: "Close", disabled: tab.id === "overview", onSelect: () => onClose(tab.id) },
          { type: "item", id: "close-others", label: "Close Others", disabled: tabs.length <= 1, onSelect: () => onCloseOthers(tab.id) },
          { type: "item", id: "close-all", label: "Close All", disabled: tabs.every((item) => item.id === "overview"), onSelect: onCloseAll },
        ])}
      ><Icon className="tab-icon" size={13} /><strong>{tab.crdKind ? tab.label : resourceLabel(language, tab.label)}</strong>{tab.id !== "overview" && <i role="button" aria-label={`Close ${tab.label}`} onClick={(event) => { event.stopPropagation(); onClose(tab.id); }}><X size={11} /></i>}</button>;
    })}</div>
    <div className="tabs-drag-spacer" aria-hidden="true" />
    <button type="button" className="tabs-command" onClick={onCommand}><Search size={13} /><span className="command-label">{t(language, "searchResources")}</span><span className="command-shortcut"><kbd>⌘</kbd><kbd>K</kbd></span></button>
    <WindowControls />
  </div>;
}

function MetricCard({ label, value, unit, percentage, icon: Icon, tone = "green", sub }: { label: string; value: string; unit: string; percentage: number; icon: typeof Cpu; tone?: "green" | "amber"; sub: string }) {
  return <div className="metric-card"><div className="metric-top"><span><Icon size={14} />{label}</span><strong>{value}<small>{unit}</small></strong></div><Progress value={percentage} tone={tone} /><div className="metric-foot"><span>{percentage}% allocated</span><span>{sub}</span></div></div>;
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
    backend.overview(cluster.id).then((value) => { if (!cancelled) { setSnapshot(value); onSnapshot(value); } }).catch((nextError) => { if (!cancelled) setError(String(nextError)); }).finally(() => { if (!cancelled) setLoading(false); });
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
  return <div className="workspace-scroll"><div className="page-head"><div><div className="eyebrow">CLUSTER OVERVIEW</div><h1>{cluster.name}</h1><p>{error || `Kubernetes ${snapshot?.version ?? cluster.version} · ${snapshot?.nodes ?? cluster.nodes} nodes · ${loading ? "updating…" : "updated just now"}`}</p></div><div className="head-actions"><Button variant="outline" size="sm" disabled={loading} onClick={() => setReloadToken((value) => value + 1)}><RefreshCw className={cn(loading && "spin")} size={13} />{t(language, "refresh")}</Button><Button size="sm" onClick={onTerminal}><SquareTerminal size={13} />Open shell</Button></div></div>
    <div className="metrics-grid"><MetricCard label="CPU" value={String(cpu)} unit="%" percentage={cpu} tone={cpu > 75 ? "amber" : "green"} sub={snapshot?.cpuPercent == null && nativeBackendAvailable ? "metrics API unavailable" : "live node usage"} icon={Cpu} /><MetricCard label="Memory" value={String(memory)} unit="%" percentage={memory} sub={snapshot?.memoryPercent == null && nativeBackendAvailable ? "metrics API unavailable" : "live node usage"} icon={Activity} /><MetricCard label="Pods" value={String(podCount)} unit={`/ ${podCapacity}`} percentage={Math.min(100, Math.round((podCount / Math.max(1, podCapacity)) * 100))} sub={`${runningPods} running`} icon={Box} /><MetricCard label="Storage" value={storageTiB.toFixed(1)} unit="TiB" percentage={storagePercent} tone={storagePercent > 75 ? "amber" : "green"} sub="bound persistent volumes" icon={HardDrive} /></div>
    <div className="overview-grid"><section className="panel"><div className="panel-head"><div><h2>Workload health</h2><p>Across all namespaces</p></div><Button variant="ghost" size="sm" onClick={() => onNavigate("Deployments")}>View all <ChevronRight size={12} /></Button></div><div className="health-chart"><div className="donut"><div><strong>{health.total}</strong><span>workloads</span></div></div><div className="health-legend"><div><span><i className="green" />Healthy</span><strong>{health.healthy}</strong></div><div><span><i className="amber" />Degraded</span><strong>{health.degraded}</strong></div><div><span><i className="red" />Failed</span><strong>{health.failed}</strong></div></div></div></section><section className="panel"><div className="panel-head"><div><h2>Nodes</h2><p>{snapshot?.nodes ?? cluster.nodes} connected</p></div><Badge tone={(snapshot?.readyNodes ?? cluster.nodes) === (snapshot?.nodes ?? cluster.nodes) ? "green" : "amber"}>{snapshot ? `${snapshot.readyNodes}/${snapshot.nodes} ready` : "All ready"}</Badge></div><div className="node-bars">{nodeValues.map((v, i) => <div key={snapshot?.nodeUsage[i]?.name ?? i}><span style={{ height: `${v}%` }} className={v > 78 ? "hot" : ""} /></div>)}</div><div className="node-axis"><span>{snapshot?.nodeUsage[0]?.name ?? "node-01"}</span><span>CPU utilization</span><span>{snapshot?.nodeUsage.at(-1)?.name ?? "node-12"}</span></div></section></div>
    <section className="panel issues-panel"><div className="panel-head"><div><h2>Needs attention</h2><p>Workloads with active warnings</p></div><Badge tone="amber">{nativeBackendAvailable ? liveIssues.length : 2} active</Badge></div><div className="compact-list">{nativeBackendAvailable ? liveIssues.map((item) => <button key={item.key} onClick={() => onResource(item)}><StatusDot status={item.status ?? "Pending"} /><div><strong>{item.name}</strong><span>{item.namespace} · {item.kind}</span></div><Badge tone="amber">{item.status}</Badge><span>{item.data.containers ?? "—"} ready</span><ChevronRight size={14} /></button>) : workloads.filter((item) => item.status !== "Running").map((item) => <button key={item.name} onClick={() => onWorkload(item)}><StatusDot status={item.status} /><div><strong>{item.name}</strong><span>{item.namespace} · {item.kind}</span></div><Badge tone="amber">{item.status}</Badge><span>{item.ready} ready</span><ChevronRight size={14} /></button>)}</div></section>
    <section className="panel events-panel"><div className="panel-head"><div><h2>Recent events</h2><p>Live cluster activity</p></div><div className="live-label"><i />LIVE</div></div><div className="event-list">{liveEvents.map((event, index) => <div key={`${event.object}-${index}`}><span className={cn("event-icon", event.level)}>{event.level === "warning" ? <AlertTriangle size={13} /> : <CircleDot size={13} />}</span><div><strong>{event.reason}</strong><span>{event.message}</span><small>{event.object}</small></div><time>{event.time}</time></div>)}</div></section>
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

function useResourceRows(clusterId: string, resource: string, namespace: string, discovered: ApiResourceDescriptor[], watchEnabled: boolean, revision = 0, override?: ApiResourceDescriptor) {
  const initialRows = nativeBackendAvailable ? [] : getResourceRows(resource);
  const rowsByKey = useRef(new Map(initialRows.map((row) => [row.key, row])));
  const [rowsRevision, setRowsRevision] = useState(0);
  const [loading, setLoading] = useState(nativeBackendAvailable);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const descriptor = override ?? descriptorForResource(resource, discovered);
  const rows = useMemo(() => Array.from(rowsByKey.current.values()), [rowsRevision]);
  const replaceRows = (nextRows: ResourceRow[]) => {
    rowsByKey.current = new Map(nextRows.map((row) => [row.key, row]));
    setRowsRevision((value) => value + 1);
  };

  useEffect(() => {
    if (!nativeBackendAvailable) {
      replaceRows(getResourceRows(resource));
      setLoading(false);
      return;
    }
    let cancelled = false;
    let subscriptionId = "";
    const stop = () => { if (subscriptionId) void backend.stopWatch(subscriptionId); };
    const load = async () => {
      setLoading(true);
      setError("");
      try {
        if (resource === "Port Forwarding") {
          const sessions = await backend.listPortForwards(clusterId);
          if (!cancelled) replaceRows(sessions.map((session) => ({
            key: session.id, name: `Pod/${session.pod}`, namespace: session.namespace, kind: "PortForward", status: session.status,
            data: { name: `Pod/${session.pod}`, namespace: session.namespace, localPort: session.localPort, targetPort: session.remotePort, protocol: "TCP", status: session.status },
          })));
          return;
        }
        if (resource === "Helm Charts") {
          const charts = await backend.listHelmCharts(reloadToken > 0);
          if (!cancelled) replaceRows(charts.map((chart) => ({ key: `${chart.repository}/${chart.name}`, name: chart.name, namespace: "—", kind: "HelmChart", data: { name: chart.name, repository: chart.repository, version: chart.version, appVersion: chart.appVersion, description: chart.description } })));
          return;
        }
        let effectiveDescriptor = descriptor;
        let labelSelector: string | undefined;
        if (resource === "Helm Releases") {
          effectiveDescriptor = discovered.find((entry) => entry.kind === "Secret" && entry.apiVersion === "v1") ?? descriptorForResource("Secrets", discovered);
          labelSelector = "owner=helm";
        }
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
          const row = rowFromBackend(record, effectiveDescriptor!);
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
        if (watchEnabled && effectiveDescriptor.verbs.includes("watch")) {
          const nextSubscriptionId = await backend.startWatch({ ...request, resourceVersion: response.resourceVersion }, (message) => {
            if (cancelled) return;
            if (message.eventType === "error") { setError(message.error ?? "Resource watch stopped"); return; }
            setError("");
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
          if (cancelled) void backend.stopWatch(nextSubscriptionId);
        }
      } catch (nextError) {
        if (!cancelled) { replaceRows([]); setError(String(nextError)); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; stop(); };
  }, [clusterId, resource, namespace, watchEnabled, revision, reloadToken, descriptor?.apiVersion, descriptor?.kind, descriptor?.plural]);

  return { rows, loading, error, descriptor, reload: () => setReloadToken((value) => value + 1) };
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

function renderResourceCell(columnId: string, row: ResourceRow, onOpenLink?: (link: ResourceLink, row: ResourceRow) => void) {
  const value = row.data[columnId];
  if (columnId === "name") {
    return <div className="resource-name"><span className="resource-kind">{row.kind[0]}</span><div><strong>{row.name}</strong><small>{row.kind}</small></div></div>;
  }
  if (columnId === "containers" && row.containers) {
    return <ContainerSquares containers={row.containers} />;
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
    return <ResourceLinkButton link={link} label={String(value)} stacked={columnId === "controlledBy" || columnId === "role" || columnId === "claim"} onOpen={(next) => onOpenLink(next, row)} />;
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

function ResourceTable({ clusterId, discovered, namespaces, revision, resource, namespace, setNamespace, language, onSelect, onOpenLink, onCreate, onRowAction }: {
  clusterId: string; discovered: ApiResourceDescriptor[]; namespaces: string[]; revision: number; resource: string; namespace: string;
  setNamespace: (value: string) => void; language: AppLanguage; onSelect: (item: ResourceRow) => void;
  onOpenLink: (link: ResourceLink, row: ResourceRow) => void; onCreate: (descriptor?: ApiResourceDescriptor | null) => void;
  onRowAction: (action: string, row: ResourceRow) => void;
}) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const { defs, visible, setColumnVisible, reset, isVisible } = useVisibleColumns(resource);
  const clusterScoped = clusterScopedResources.has(resource);
  const live = useResourceRows(clusterId, resource, namespace, discovered, autoRefresh, revision);
  const filtered = useMemo(() => {
    const search = deferredQuery.toLowerCase();
    return live.rows.filter((item) => (clusterScoped || namespace === "All namespaces" || item.namespace === namespace) && resourceSearchText(item).includes(search));
  }, [live.rows, clusterScoped, namespace, deferredQuery]);
  const columns = useMemo<Array<VirtualTableColumn<ResourceRow>>>(() => visible.map((column) => ({
    id: column.id,
    label: column.label,
    render: (item) => renderResourceCell(column.id, item, onOpenLink),
  })), [visible, onOpenLink]);
  const canCreate = resource === "Port Forwarding" || !nativeBackendAvailable || Boolean(live.descriptor?.verbs.includes("create"));
  const rowMenu = (event: ReactMouseEvent, item: ResourceRow) => {
    const workload = ["Pod", "Deployment", "StatefulSet", "DaemonSet"].includes(item.kind);
    const scalable = ["Pod", "Deployment", "StatefulSet", "ReplicaSet", "ReplicationController"].includes(item.kind);
    openContextMenu(event, [
      { type: "item", id: "open", label: "Open details", onSelect: () => onSelect(item) },
      { type: "item", id: "edit", label: "Edit YAML", disabled: item.kind === "Secret" || item.kind === "HelmRelease" || (nativeBackendAvailable && !item.descriptor?.verbs.includes("patch")), onSelect: () => onRowAction("Edit", item) },
      ...(workload ? [{ type: "item" as const, id: "logs", label: "Logs", onSelect: () => onRowAction("Logs", item) }, { type: "item" as const, id: "terminal", label: "Terminal", onSelect: () => onRowAction("Terminal", item) }] : []),
      ...(["Pod", "Service"].includes(item.kind) ? [{ type: "item" as const, id: "port-forward", label: "Port forward…", onSelect: () => onRowAction("Port Forward", item) }] : []),
      ...(scalable ? [{ type: "item" as const, id: "scale", label: "Scale", onSelect: () => onRowAction("Scale", item) }, { type: "item" as const, id: "restart", label: "Restart rollout", onSelect: () => onRowAction("Restart", item) }] : []),
      { type: "separator" },
      { type: "item", id: "delete", label: item.kind === "PortForward" ? "Stop forwarding" : "Delete", danger: true, disabled: item.kind === "HelmRelease" || (nativeBackendAvailable && item.kind !== "PortForward" && !item.descriptor?.verbs.includes("delete")), onSelect: () => onRowAction("Delete", item) },
    ]);
  };
  return <div className="workspace-scroll">
    <div className="page-head"><div><div className="eyebrow">KUBERNETES RESOURCES</div><h1>{resourceLabel(language, resource)}</h1><p>{live.loading ? "Loading from Kubernetes API…" : live.error ? live.error : `${filtered.length} resources · ${autoRefresh && live.descriptor?.verbs.includes("watch") ? "watch connected" : "snapshot"}`}</p></div><div className="head-actions"><Button variant="outline" size="sm" onClick={live.reload} disabled={live.loading}><RefreshCw className={cn(live.loading && "spin")} size={13} />{t(language, "refresh")}</Button><Button size="sm" disabled={!canCreate} onClick={() => onCreate(live.descriptor)}><Plus size={13} />{t(language, "create")}</Button></div></div>
    <div className="table-toolbar">{!clusterScoped && <Combobox className="table-namespace-combobox" label={t(language, "namespace")} value={namespace} onChange={setNamespace} options={["All namespaces", ...namespaces].map((item) => ({ value: item, label: item === "All namespaces" ? t(language, "allNamespaces") : item }))} />}<div className="table-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`${t(language, "searchResources")} ${resourceLabel(language, resource)}`} /></div><div className="toolbar-spacer" /><span>Auto-refresh</span><button type="button" aria-label="Toggle auto-refresh" aria-pressed={autoRefresh} className={cn("toggle", autoRefresh && "active")} onClick={() => setAutoRefresh((value) => !value)}><i /></button></div>
    <div className="resource-table-panel"><VirtualResourceTable rows={filtered} columns={columns} tableKey={`resource:${resource}`} headerAction={<ColumnPicker resource={resource} language={language} defs={defs} isVisible={isVisible} onToggle={setColumnVisible} onReset={reset} />} renderAction={(item) => <Button variant="ghost" size="icon" aria-label="Row actions" onClick={(event) => rowMenu(event, item)}><MoreHorizontal size={14} /></Button>} onRowClick={onSelect} onRowContextMenu={rowMenu} empty={!live.loading ? <div className="empty-state"><strong>{live.error ? "Resource API unavailable" : "No resources found"}</strong><span>{live.error || "Try another namespace or search query"}</span></div> : undefined} /></div>
  </div>;
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
  const columns = useMemo<Array<VirtualTableColumn<ResourceRow>>>(() => visible.map((column) => ({ id: column.id, label: column.label, render: (item) => renderResourceCell(column.id, item, onOpenLink) })), [visible, onOpenLink]);
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
  const crdLive = useResourceRows(clusterId, "Custom Resource Definitions", "All namespaces", discovered, true, revision, crdDescriptor);
  const liveDefinitions = crdLive.rows.map((row) => row.backend ? crdDefinitionFromRecord(row.backend) : null).filter(Boolean) as Array<ReturnType<typeof crdDefinitionFromRecord>>;
  const definition = nativeBackendAvailable
    ? liveDefinitions.find((item) => item.name === selectedDefinitionName)
    : customResourceDefinitions.find((item) => item.name === selectedDefinitionName);
  const printerColumns = definition && "printerColumns" in definition ? definition.printerColumns.filter((column) => !["Name", "Namespace", "Status", "Age"].includes(column.name)) : [];
  const dynamicDescriptor = definition && "descriptor" in definition ? definition.descriptor : definition ? {
    apiVersion: `${definition.group}/${definition.version}`, group: definition.group, version: definition.version, kind: definition.kind,
    plural: definition.plural ?? `${definition.kind.toLowerCase()}s`, namespaced: definition.scope === "Namespaced", verbs: ["get", "list", "watch", "create", "patch", "delete"], categories: [],
  } : crdDescriptor;
  const instances = useResourceRows(clusterId, `Custom Resource ${definition?.group ?? "unknown"}/${definition?.kind ?? "Definitions"}`, namespace, discovered, true, revision, dynamicDescriptor);
  const deferredQuery = useDeferredValue(query);
  const instanceFiltered = useMemo(() => instances.rows.filter((row) => row.name.toLowerCase().includes(deferredQuery.toLowerCase())), [instances.rows, deferredQuery]);
  const instanceColumns = useVisibleColumns("Custom Resource");
  const instanceTableColumns = useMemo<Array<VirtualTableColumn<ResourceRow>>>(() => [
    ...instanceColumns.visible.map((column) => ({ id: column.id, label: column.label, render: (item: ResourceRow) => renderResourceCell(column.id, item, onOpenLink) })),
    ...printerColumns.map((column) => ({ id: column.jsonPath, label: column.name, render: (item: ResourceRow) => item.backend ? valueFromJsonPath(item.backend.object, column.jsonPath) : "—", sortValue: (item: ResourceRow) => item.backend ? valueFromJsonPath(item.backend.object, column.jsonPath) : undefined })),
  ], [instanceColumns.visible, printerColumns, onOpenLink]);
  const crdColumns = useVisibleColumns("Custom Resource Definitions");
  const liveDefinitionByName = useMemo(() => new Map(liveDefinitions.map((item) => [item.name, item])), [liveDefinitions]);
  const crdTableColumns = useMemo<Array<VirtualTableColumn<ResourceRow>>>(() => crdColumns.visible.map((column) => ({ id: column.id, label: column.label, render: (row) => renderResourceCell(column.id, row) })), [crdColumns.visible]);
  if (!nativeBackendAvailable) {
    if (definition) return <CrdInstanceTable definition={definition} namespace={namespace} setNamespace={setNamespace} language={language} query={query} setQuery={setQuery} onBack={onBack} onInstance={(item, kind) => onInstance({ key: `${item.namespace}/${item.name}`, name: item.name, namespace: item.namespace, kind, status: item.status, data: { name: item.name, namespace: item.namespace, status: item.status, apiVersion: `${definition.group}/${item.version}`, age: item.age } })} onCreate={() => onCreate(dynamicDescriptor)} onOpenLink={onOpenLink} />;
    return <CrdListTable language={language} onKindSelect={onKindSelect} onDefinition={onInstance} onCreate={() => onCreate(crdDescriptor)} />;
  }
  if (definition && selectedDefinitionName) {
    return <div className="workspace-scroll"><div className="page-head"><div><div className="eyebrow">CUSTOM RESOURCE · {definition.group}</div><h1>{definition.kind}</h1><p>{instances.error || `${definition.name} · ${definition.scope} · ${instanceFiltered.length} resources`}</p></div><div className="head-actions"><Button variant="outline" size="sm" onClick={onBack}>All CRDs</Button><Button size="sm" disabled={!dynamicDescriptor.verbs.includes("create")} onClick={() => onCreate(dynamicDescriptor)}><Plus size={13} />Create</Button></div></div><div className="table-toolbar">{definition.scope === "Namespaced" && <Combobox className="table-namespace-combobox" label={t(language, "namespace")} value={namespace} onChange={setNamespace} options={["All namespaces", ...namespaces].map((item) => ({ value: item, label: item === "All namespaces" ? t(language, "allNamespaces") : item }))} />}<div className="table-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`${t(language, "searchResources")} ${definition.kind}`} /></div><div className="toolbar-spacer" /><span>{instances.loading ? "Loading…" : `${instanceFiltered.length} resources`}</span></div><div className="resource-table-panel"><VirtualResourceTable rows={instanceFiltered} columns={instanceTableColumns} tableKey={`custom-resource:${definition.kind}`} headerAction={<ColumnPicker resource="Custom Resource" language={language} defs={instanceColumns.defs} isVisible={instanceColumns.isVisible} onToggle={instanceColumns.setColumnVisible} onReset={instanceColumns.reset} />} renderAction={() => <ChevronRight size={14} />} onRowClick={onInstance} empty={!instances.loading ? <div className="empty-state"><strong>No resources found</strong><span>{instances.error || "Try another namespace or search query"}</span></div> : undefined} /></div></div>;
  }
  return <div className="workspace-scroll"><div className="page-head"><div><div className="eyebrow">API EXTENSIONS</div><h1>Custom Resource Definitions</h1><p>{crdLive.error || `${liveDefinitions.length} definitions discovered in this cluster`}</p></div><Button size="sm" disabled={!crdDescriptor.verbs.includes("create")} onClick={() => onCreate(crdDescriptor)}><Plus size={13} />Create CRD</Button></div><div className="resource-table-panel standalone"><VirtualResourceTable className="standalone" rows={crdLive.rows} columns={crdTableColumns} tableKey="resource:Custom Resource Definitions" headerAction={<ColumnPicker resource="Custom Resource Definitions" language={language} defs={crdColumns.defs} isVisible={crdColumns.isVisible} onToggle={crdColumns.setColumnVisible} onReset={crdColumns.reset} />} renderAction={(row) => { const source = liveDefinitionByName.get(row.name); return source ? <Button variant="ghost" size="icon" aria-label={`Open ${source.kind} instances`} onClick={() => onKindSelect(source)}><ChevronRight size={14} /></Button> : null; }} onRowClick={onInstance} empty={!crdLive.loading ? <div className="empty-state"><strong>No definitions found</strong><span>{crdLive.error || "This cluster did not return any CRDs"}</span></div> : undefined} /></div></div>;
}

function RelationGroupView({ group, onOpenResource }: { group: ResourceRelationGroup; onOpenResource: (row: ResourceRow) => void }) {
  const directionLabel = group.direction === "parent" ? "Parent" : group.direction === "child" ? "Child" : "Related";
  return <section className="detail-relation-group" data-relation-id={group.id}>
    <header><div><h4>{group.title}</h4><p>{group.description}</p></div><Badge tone={group.direction === "parent" ? "blue" : group.direction === "child" ? "green" : "neutral"}>{directionLabel} · {group.items.length}</Badge></header>
    {group.error && <div className="detail-relation-error"><AlertTriangle size={12} />{group.error}</div>}
    <div className="detail-relation-list">{group.items.map((entry) => <button key={`${entry.kind}/${entry.namespace}/${entry.name}`} type="button" onClick={() => onOpenResource(entry)}><span className="resource-kind">{entry.kind.slice(0, 2).toUpperCase()}</span><div><strong>{entry.name}</strong><small>{entry.kind}{entry.namespace !== "—" ? ` · ${entry.namespace}` : ""}</small></div>{entry.status && <Badge tone={statusTone(entry.status)}>{entry.status}</Badge>}<ChevronRight size={13} /></button>)}{group.items.length === 0 && <div className="detail-relation-empty">No related resources found</div>}</div>
  </section>;
}

function DetailSheet({ tab, onClose, onAction, onOpenResource }: { tab: DetailItem; onClose: () => void; onAction: (action: string) => void; onOpenResource: (row: ResourceRow) => void }) {
  const item = tab.workload;
  const related = tab.related;
  const actionKind = tab.row?.kind ?? item?.kind ?? tab.kind ?? "Resource";
  const canPatch = !nativeBackendAvailable || Boolean(tab.row?.descriptor?.verbs.includes("patch"));
  const canDelete = !nativeBackendAvailable || Boolean(tab.row?.descriptor?.verbs.includes("delete"));
  const editAction = canPatch && actionKind !== "Secret" ? [{ label: "Edit", icon: Pencil, mode: "edit" as const }] : [];
  const deleteAction = canDelete ? [{ label: "Delete", icon: Trash2 }] : [];
  const headerActions: Array<{ label: string; icon: typeof Play; mode?: BottomRequest["mode"] }> = tab.type === "related" || actionKind === "HelmRelease"
    ? []
    : actionKind === "Pod"
      ? [{ label: "Terminal", icon: SquareTerminal, mode: "terminal" }, { label: "Logs", icon: Logs, mode: "logs" }, ...editAction, { label: "Scale", icon: Gauge }, { label: "Restart", icon: RefreshCw }, ...deleteAction]
      : actionKind === "DaemonSet"
        ? [{ label: "Logs", icon: Logs, mode: "logs" }, ...editAction, { label: "Restart", icon: RefreshCw }, ...deleteAction]
        : actionKind === "CronJob"
          ? [...editAction, ...deleteAction]
          : actionKind === "StatefulSet"
            ? [{ label: "Terminal", icon: SquareTerminal, mode: "terminal" }, { label: "Logs", icon: Logs, mode: "logs" }, ...editAction, { label: "Scale", icon: Gauge }, ...deleteAction]
            : actionKind === "Deployment"
              ? [{ label: "Terminal", icon: SquareTerminal, mode: "terminal" }, { label: "Logs", icon: Logs, mode: "logs" }, ...editAction, { label: "Scale", icon: Gauge }, { label: "Restart", icon: RefreshCw }, ...deleteAction]
              : [...editAction, ...deleteAction];
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
  return <><div className="sheet-scrim" onClick={onClose} /><aside ref={sheetRef} className="sheet sheet-right" style={{ width }}><div className="sheet-resize-edge vertical" aria-label="Resize details" role="separator" aria-orientation="vertical" onPointerDown={startResize} /><div className="drawer-head detail-sheet-header"><div className="resource-kind">{tab.type === "crd" ? "CR" : kindLabel.slice(0, 2).toUpperCase()}</div><div className="sheet-title-stack"><small>{kindLabel}</small><h2>{tab.label}</h2></div><div className="detail-header-actions">{headerActions.map(({ label, icon: Icon }) => <Button key={label} variant="ghost" size="icon" className={cn(label === "Delete" && "danger-action")} aria-label={label} title={label} onClick={() => onAction(label)}><Icon size={13} /></Button>)}</div><Button variant="ghost" size="icon" aria-label="Close details" onClick={onClose}><X size={14} /></Button></div><div className="drawer-body"><div className="detail-status"><StatusDot status={status} /><div><strong>{status}</strong><span>{related ? `Reverse link · ${related.relation}` : tab.loading ? "Loading live API object…" : tab.row?.backend ? "Live Kubernetes API object" : "Browser demonstration snapshot"}</span></div><Badge tone={statusTone(status)}>{related ? related.relation : tab.relationsLoading ? "Resolving" : `${(tab.relations ?? []).reduce((count, group) => count + group.items.length, 0)} related`}</Badge></div>
    {related ? <>
      <h3>Resource</h3>
      <dl>{(related.meta ?? []).map((entry) => <div key={entry.label}><dt>{entry.label}</dt><dd>{entry.value}</dd></div>)}{related.from && <div><dt>Opened from</dt><dd>{related.from}</dd></div>}</dl>
      <h3>Referenced by</h3>
      {tab.error && <div className="related-empty">{tab.error}</div>}
      <div className="related-list">{(related.relatedItems ?? []).map((entry) => <div key={`${entry.namespace}/${entry.name}`} className="related-list-item"><div><strong>{entry.name}</strong><span>{[entry.kind, entry.namespace].filter(Boolean).join(" · ")}</span></div>{entry.status && <Badge tone={statusTone(entry.status)}>{entry.status}</Badge>}</div>)}{(related.relatedItems ?? []).length === 0 && <div className="related-empty">No related resources</div>}</div>
    </> : <>
      <section className="detail-section detail-metadata"><div className="detail-section-heading"><h3>Resource identity</h3><span>Kubernetes metadata</span></div><dl><div><dt>API version</dt><dd>{tab.row?.backend?.apiVersion ?? String(tab.row?.data.apiVersion ?? defaultApiVersion(kindLabel))}</dd></div><div><dt>Kind</dt><dd>{kindLabel}</dd></div><div><dt>Namespace</dt><dd>{tab.subtitle}</dd></div><div><dt>Age</dt><dd>{String(tab.row?.data.age ?? item?.age ?? tab.crd?.age ?? "—")}</dd></div>{tab.row?.backend?.uid && <div><dt>UID</dt><dd className="copy-value">{tab.row.backend.uid}<Button variant="ghost" size="icon" aria-label="Copy UID" onClick={() => void navigator.clipboard.writeText(tab.row?.backend?.uid ?? "")}><Copy size={12} /></Button></dd></div>}{tab.row?.backend?.resourceVersion && <div><dt>Resource version</dt><dd>{tab.row.backend.resourceVersion}</dd></div>}</dl></section>
      {tab.error && <div className="detail-load-error"><AlertTriangle size={13} /><span>{tab.error}</span></div>}
      {detailSections.map((detailSection) => <section className="detail-section detail-kind-section" key={detailSection.id} data-detail-section={detailSection.id}><div className="detail-section-heading"><h3>{detailSection.title}</h3>{detailSection.description && <span>{detailSection.description}</span>}</div><div className="detail-field-grid">{detailSection.fields.map((entry) => <div key={`${detailSection.id}-${entry.label}`} className={cn("detail-field", entry.wide && "wide")}><span>{entry.label}</span><strong className={cn(entry.tone && `tone-${entry.tone}`)}>{entry.value}{entry.copyable && entry.value !== "—" && <button type="button" aria-label={`Copy ${entry.label}`} onClick={() => void navigator.clipboard.writeText(entry.value)}><Copy size={11} /></button>}</strong></div>)}</div></section>)}
      <section className="detail-section"><div className="detail-section-heading"><h3>Conditions</h3><span>Controller-reported lifecycle state</span></div><div className="detail-condition-list">{conditions.map((condition) => <div className="condition-row" key={`${condition.type}-${condition.lastTransition}`}><StatusDot status={condition.status === "True" ? "Ready" : condition.status === "False" ? "NotReady" : "Pending"} /><div><strong>{condition.type}</strong><span>{condition.reason !== "—" ? condition.reason : condition.message}</span>{condition.message !== "—" && condition.message !== condition.reason && <small>{condition.message}</small>}</div><time>{condition.lastTransition}</time></div>)}{conditions.length === 0 && <div className="condition-row"><StatusDot status={status} /><div><strong>{status}</strong><span>{tab.loading ? "Loading live resource details…" : "No status.conditions reported"}</span></div><time>{String(tab.row?.data.age ?? "now")}</time></div>}</div></section>
      <section className="detail-section detail-relations"><div className="detail-section-heading"><h3>Resource relationships</h3><span>Parent, child, and referenced Kubernetes objects</span></div>{tab.relationsLoading && <div className="detail-relations-loading"><LoaderCircle className="spin" size={14} />Resolving resource graph…</div>}{tab.relationsError && <div className="detail-relation-error"><AlertTriangle size={12} />{tab.relationsError}</div>}{(tab.relations ?? []).map((relation) => <RelationGroupView key={relation.id} group={relation} onOpenResource={onOpenResource} />)}{!tab.relationsLoading && (tab.relations ?? []).length === 0 && <div className="detail-relation-empty">No relationship rules are available for this resource.</div>}</section>
      <section className="detail-section"><div className="detail-section-heading"><h3>Labels</h3><span>{Object.keys(labels).length} metadata labels</span></div><div className="labels">{Object.entries(labels).map(([key, value]) => <Badge key={key} tone={key === "app" || key === "app.kubernetes.io/name" ? "blue" : "neutral"}>{key}={value}</Badge>)}{Object.keys(labels).length === 0 && <span className="detail-relation-empty">No labels</span>}</div></section>
      {Object.keys(annotations).length > 0 && <section className="detail-section"><div className="detail-section-heading"><h3>Annotations</h3><span>{Object.keys(annotations).length} metadata annotations</span></div><div className="detail-annotation-list">{Object.entries(annotations).map(([key, value]) => <div key={key}><strong>{key}</strong><span>{value}</span></div>)}</div></section>}
    </>}
  </div></aside></>;
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

function BottomActionSheet({ clusterId, sessions, activeId, collapsed, language, terminalTheme, terminalFont, terminalRuntimes, sessionCaches, onUpdateTerminalRuntimes, onUpdateSessionCaches, onActivate, onCloseSession, onCloseOthers, onCloseAll, onCreateSession, onToggleCollapsed, onApplied, onToast }: {
  clusterId: string;
  sessions: BottomSession[];
  activeId: string;
  collapsed: boolean;
  language: AppLanguage;
  terminalTheme: "light" | "dark";
  terminalFont: string;
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
  const manifestEditorRef = useRef<HTMLTextAreaElement>(null);
  const editorGutterRef = useRef<HTMLDivElement>(null);
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
  const output = sessionCache?.output ?? "";
  const feedback = sessionCache?.feedback ?? "";
  const selectedPodKey = sessionCache?.selectedPodKey ?? "";
  const selectedContainer = sessionCache?.selectedContainer ?? "";
  const logTailLines = sessionCache?.logTailLines ?? 1000;
  const logFollow = sessionCache?.logFollow ?? true;
  const logTimestamps = sessionCache?.logTimestamps ?? true;
  const logWrapLines = sessionCache?.logWrapLines ?? true;
  const terminalReloadToken = sessionCache?.terminalReloadToken ?? 0;
  const patchSessionCache = (patch: Partial<BottomSessionCache>) => {
    if (!state) return;
    onUpdateSessionCaches((current) => ({ ...current, [runtimeKey]: { ...current[runtimeKey], ...patch } }));
  };
  const setManifestText = (value: string) => patchSessionCache({ manifestText: value });
  const setOutput = (value: string) => patchSessionCache({ output: value });
  const setFeedback = (value: string) => patchSessionCache({ feedback: value });
  const setSelectedPodKey = (value: string) => patchSessionCache({ selectedPodKey: value });
  const setSelectedContainer = (value: string) => patchSessionCache({ selectedContainer: value });
  const setLogTailLines = (value: number) => patchSessionCache({ logTailLines: value });
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
    if (!state || (state.mode !== "logs" && state.mode !== "terminal")) return;
    let cancelled = false;
    targetsReadySessionRef.current = "";
    setTargetsLoading(true);
    setTargetError("");
    setPodTargets([]);
    void listPodTargets(clusterId, state.item).then((targets) => {
      if (cancelled) return;
      setPodTargets(targets);
      const saved = sessionCachesRef.current[`${clusterId}::${state.id}`];
      const runtime = state.mode === "terminal" ? terminalRuntimesRef.current[`${clusterId}::${state.id}`] : undefined;
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
  }, [clusterId, state?.id, state?.mode]);
  const selectedPod = podTargets.find((target) => target.key === selectedPodKey) ?? podTargets[0];
  useEffect(() => {
    if (!selectedPod) return;
    const containers = allPodContainers(selectedPod);
    if (!containers.includes(selectedContainer)) setSelectedContainer(containers[0] ?? "");
  }, [selectedPodKey, selectedPod, selectedContainer]);
  useEffect(() => {
    if (!state || state.mode !== "terminal" || !selectedPod || targetsReadySessionRef.current !== state.id) return;
    const sessionId = runtimeKey;
    const targetLabel = `${selectedPod.namespace}/${selectedPod.pod}${selectedContainer ? ` · ${selectedContainer}` : ""}`;
    const connectionKey = `${clusterId}|${selectedPod.key}|${selectedContainer}|${terminalReloadToken}`;
    const existing = terminalRuntimesRef.current[sessionId];
    if (existing?.connectionKey === connectionKey && (existing.status === "connected" || existing.status === "connecting")) return;
    if (existing?.sessionId && nativeBackendAvailable) void backend.stopTerminal(existing.sessionId);
    onUpdateTerminalRuntimes((current) => ({
      ...current,
      [sessionId]: { sessionId: "", output: "", status: "connecting", feedback: `Connecting · ${targetLabel}`, connectionKey, targetLabel, podKey: selectedPod.key, container: selectedContainer },
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
        output: "Browser demo terminal ready.\r\nNative builds open an interactive Kubernetes exec stream.\r\n$ ",
      })), 120);
      return;
    }

    void backend.startTerminal({
      clusterId,
      namespace: selectedPod.namespace,
      pod: selectedPod.pod,
      container: selectedContainer || undefined,
      command: [],
    }, (message) => {
      if (message.eventType === "connected") {
        updateRuntime((runtime) => ({ ...runtime, status: "connected", feedback: message.data || `Connected · ${targetLabel}` }));
      } else if (message.eventType === "output") {
        const chunk = message.data ?? "";
        if (chunk) updateRuntime((runtime) => ({ ...runtime, output: `${runtime.output}${chunk}`.slice(-2_000_000) }));
      } else if (message.eventType === "error") {
        updateRuntime((runtime) => ({ ...runtime, feedback: message.data || "Terminal stream failed" }));
      } else if (message.eventType === "disconnected") {
        updateRuntime((runtime) => ({ ...runtime, status: "disconnected", feedback: message.data || "Terminal disconnected", sessionId: "" }));
      }
    }).then((nextSessionId) => {
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
  }, [clusterId, state?.id, state?.mode, selectedPod?.key, selectedContainer, terminalReloadToken]);
  useEffect(() => {
    if (!searchOpen || !textSearch.query || (state?.mode !== "edit" && state?.mode !== "create")) return;
    const match = textSearch.matches[textSearch.currentIndex];
    const editor = manifestEditorRef.current;
    if (!match || !editor) return;
    editor.setSelectionRange(match.start, match.end);
    const line = manifestText.slice(0, match.start).split("\n").length - 1;
    editor.scrollTop = Math.max(0, line * 17 - editor.clientHeight / 2);
    if (editorGutterRef.current) editorGutterRef.current.scrollTop = editor.scrollTop;
  }, [searchOpen, textSearch.query, textSearch.currentIndex, textSearch.matches, state?.mode, manifestText]);
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
        const logs = await backend.podLogs({ clusterId, namespace: selectedPod.namespace, pod: selectedPod.pod, container: selectedContainer || undefined, tailLines: logTailLines, timestamps: logTimestamps });
        if (!cancelled) { setOutput(logs || "No log lines returned"); setFeedback(""); }
      } catch (nextError) { if (!cancelled) { setOutput(String(nextError)); setFeedback("Log request failed"); } }
    };
    if (!sessionCachesRef.current[runtimeKey]?.output) setOutput("Connecting to pod log stream…");
    void load();
    if (logFollow) timer = window.setInterval(load, 5000);
    return () => { cancelled = true; if (timer) window.clearInterval(timer); };
  }, [clusterId, state?.id, state?.mode, selectedPod?.key, selectedContainer, logFollow, logTailLines, logTimestamps]);
  if (!state) return null;
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => { event.preventDefault(); event.stopPropagation(); const currentHeight = collapsed ? 38 : dockRef.current?.getBoundingClientRect().height ?? height; if (collapsed) { setHeight(38); onToggleCollapsed(); } setMaximized(false); resize.current = { startY: event.clientY, startHeight: currentHeight, currentHeight }; document.body.classList.add("resizing-session-sheet"); };
  const sessionTitle = (session: BottomSession) => `${session.mode === "terminal" ? "Terminal" : session.mode === "logs" ? "Logs" : session.mode === "edit" ? "Edit" : "Create"} · ${session.label ?? session.item?.label ?? "cluster"}`;
  const terminalOption = language === "en" ? "New terminal session" : language === "zh-TW" ? "新增終端工作階段" : "新建终端会话";
  const resourceOption = language === "en" ? "Create resource" : language === "zh-TW" ? "建立資源" : "创建资源";
  const showPodTarget = state.item?.row?.kind !== "Pod";
  const podOptions = podTargets.length
    ? podTargets.map((target) => ({ value: target.key, label: target.pod, description: `${target.namespace} · ${target.phase}${target.ready ? " · Ready" : ""}`, icon: Box }))
    : [{ value: "", label: targetsLoading ? "Resolving..." : "Unavailable", description: targetError || undefined, icon: Box }];
  const containerOptions = [
    ...(selectedPod?.initContainers ?? []).map((container) => ({ value: container, label: container, group: "Init Containers", icon: Container })),
    ...(selectedPod?.containers ?? []).map((container) => ({ value: container, label: container, group: "Containers", icon: Container })),
  ];
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
    updateActiveTerminalRuntime((runtime) => ({ ...runtime, status: "connecting", feedback: "Reconnecting…" }));
    patchSessionCache({ terminalReloadToken: terminalReloadToken + 1 });
  };
  const writeTerminalInput = (data: string) => {
    if (terminalStatus !== "connected") return;
    if (!nativeBackendAvailable) {
      updateActiveTerminalRuntime((runtime) => ({ ...runtime, output: `${runtime.output}${data === "\r" ? "\r\nbrowser demo\r\n$ " : data}`.slice(-2_000_000) }));
      return;
    }
    if (!terminalSessionId) {
      updateActiveTerminalRuntime((runtime) => ({ ...runtime, status: "disconnected", feedback: "Terminal session is no longer available" }));
      return;
    }
    void backend.writeTerminal(terminalSessionId, data).catch((error) => {
      updateActiveTerminalRuntime((runtime) => ({ ...runtime, status: "disconnected", feedback: String(error) }));
    });
  };
  const resizeContainerTerminal = (columns: number, rows: number) => {
    if (nativeBackendAvailable && terminalSessionId) void backend.resizeTerminal(terminalSessionId, columns, rows).catch(() => undefined);
  };
  const apply = async (closeAfter = false) => {
    if (!nativeBackendAvailable) {
      setFeedback("Applied successfully in browser demo mode");
      onApplied();
      if (closeAfter) onCloseSession(state.id);
      return;
    }
    setBusy(true); setFeedback("Applying with Kubernetes API…");
    try {
      await backend.applyManifest({ clusterId, manifest: manifestText, resource: state.descriptor ?? state.item?.row?.descriptor, force: false });
      setFeedback("Applied successfully");
      onApplied();
      if (closeAfter) onCloseSession(state.id);
    } catch (nextError) { setFeedback(String(nextError)); }
    finally { setBusy(false); }
  };
  const validateManifest = async () => {
    if (!nativeBackendAvailable) { setFeedback("YAML is valid in browser demo mode"); return; }
    setBusy(true); setFeedback("Validating with Kubernetes API…");
    try {
      await backend.applyManifest({ clusterId, manifest: manifestText, resource: state.descriptor ?? state.item?.row?.descriptor, dryRun: true, force: false });
      setFeedback("YAML is valid");
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
  const runtimeStatus = state.mode === "terminal" ? terminalStatus : feedback ? "error" : logFollow ? "live" : "paused";
  const runtimeTone = runtimeStatus === "connected" || runtimeStatus === "live"
    ? "green"
    : runtimeStatus === "connecting"
      ? "amber"
      : runtimeStatus === "disconnected" || runtimeStatus === "error"
        ? "red"
        : "neutral";
  const runtimeStatusLabel = `${state.mode === "terminal" ? "Terminal" : "Logs"} ${runtimeStatus}`;
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
  return <section ref={dockRef} onKeyDown={handleSessionShortcut} className={cn("sheet sheet-bottom session-dock", collapsed && "collapsed", maximized && "maximized", (state.mode === "logs" || state.mode === "terminal") && `terminal-theme-${terminalTheme}`)} style={collapsed ? undefined : { height: maximized ? Math.max(220, window.innerHeight - 220) : height }}><div className="sheet-resize-edge horizontal" aria-label="Resize sessions" role="separator" aria-orientation="horizontal" onPointerDown={startResize} /><div className="session-tabbar"><div className="bottom-session-tabs">{sessions.map((session) => {
    const Icon = session.mode === "terminal" ? SquareTerminal : session.mode === "logs" ? Logs : session.mode === "edit" ? Pencil : Plus; return <button key={session.id} className={cn(session.id === state.id && "active")} onClick={() => onActivate(session.id)} onContextMenu={(event) => openContextMenu(event, [
      { type: "item", id: "close", label: "Close", onSelect: () => onCloseSession(session.id) },
      { type: "item", id: "close-others", label: "Close Others", disabled: sessions.length <= 1, onSelect: () => onCloseOthers(session.id) },
      { type: "item", id: "close-all", label: "Close All", onSelect: onCloseAll },
    ])}><Icon size={12} /><span>{sessionTitle(session)}</span><i role="button" aria-label={`Close ${sessionTitle(session)}`} onClick={(event) => { event.stopPropagation(); onCloseSession(session.id); }}><X size={10} /></i></button>;
  })}</div><div className="session-add" ref={addMenuRef}><Button variant="ghost" size="icon" className="session-add-trigger" aria-label="Add session" title="Add session" onClick={() => setAddMenuOpen((value) => !value)}><Plus size={13} /></Button>{addMenuOpen && <div className="session-add-menu"><button onClick={() => { onCreateSession({ mode: "terminal", sessionKey: `terminal-${Date.now()}`, label: language === "en" ? "New session" : language === "zh-TW" ? "新工作階段" : "新会话" }); setAddMenuOpen(false); }}><SquareTerminal size={13} /><span>{terminalOption}</span></button><button onClick={() => { onCreateSession({ mode: "create", sessionKey: `resource-${Date.now()}`, label: resourceOption }); setAddMenuOpen(false); }}><Plus size={13} /><span>{resourceOption}</span></button></div>}</div><div className="session-tab-spacer" /><Button variant="ghost" size="icon" aria-label={maximized ? "Restore sessions" : "Maximize sessions"} onClick={() => { if (collapsed) onToggleCollapsed(); setMaximized((value) => !value); }}>{maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</Button><Button variant="ghost" size="icon" aria-label={collapsed ? "Expand sessions" : "Collapse sessions"} onClick={onToggleCollapsed}><ChevronDown className={cn(collapsed && "rotate-180")} size={15} /></Button></div>{!collapsed && <><div className="session-action-bar"><div className="session-primary-actions">{(state.mode === "edit" || state.mode === "create") && <><Button size="sm" disabled={busy || !manifestText.trim()} onClick={() => void apply(false)}>{busy && <LoaderCircle className="spin" size={13} />}Apply</Button><Button variant="secondary" size="sm" disabled={busy || !manifestText.trim()} onClick={() => void apply(true)}>Apply and close</Button></>}{(state.mode === "logs" || state.mode === "terminal") && <><span className={cn("session-runtime-status", `status-${runtimeTone}`)} role="status" aria-label={runtimeStatusLabel} title={runtimeStatusLabel} data-status={runtimeStatus} />{showPodTarget && <Combobox className="session-target-combobox pod-target-combobox" ariaLabel="Pod" leadingIcon={Box} searchable={false} value={selectedPodKey} options={podOptions} onChange={setSelectedPodKey} />}{containerOptions.length > 1 ? <Combobox className="session-target-combobox container-target-combobox" ariaLabel="Container" leadingIcon={Container} searchable={false} value={selectedContainer} options={containerOptions} onChange={setSelectedContainer} /> : <div className="session-target-label" aria-label="Container"><Container size={12} aria-hidden="true" /><strong title={selectedContainer || targetError || undefined}>{selectedContainer || (targetsLoading ? "Resolving..." : "Unavailable")}</strong></div>}{targetsLoading && <LoaderCircle className="spin session-action-spinner" size={13} />}</>}</div><div className="session-secondary-actions">{(state.mode === "edit" || state.mode === "create") && <Button variant="outline" size="sm" disabled={busy || !manifestText.trim()} onClick={() => void validateManifest()}><ShieldCheck size={13} />Validate YAML</Button>}{state.mode === "terminal" && terminalStatus === "disconnected" && <Button variant="outline" size="sm" onClick={() => void reconnectTerminal()}><RefreshCw size={13} />Reconnect</Button>}{state.mode === "logs" && <><Combobox className="session-tail-combobox" ariaLabel="Tail lines" searchable={false} value={String(logTailLines)} options={[100, 500, 1000, 5000, 10000].map((value) => ({ value: String(value), label: `Tail ${value}` }))} onChange={(value) => setLogTailLines(Number(value))} /><label className="session-checkbox"><input type="checkbox" checked={logTimestamps} onChange={(event) => setLogTimestamps(event.target.checked)} /><span>Timestamps</span></label><label className="session-checkbox"><input type="checkbox" checked={logFollow} onChange={(event) => setLogFollow(event.target.checked)} /><span>Follow logs</span></label><label className="session-checkbox"><input type="checkbox" checked={logWrapLines} onChange={(event) => setLogWrapLines(event.target.checked)} /><span>Wrap lines</span></label><Button variant="ghost" size="icon" aria-label="Download logs" title="Download logs" disabled={!output} onClick={downloadLogs}><Download size={14} /></Button></>}<Button variant={searchOpen ? "secondary" : "ghost"} size="icon" aria-label="Find text" title="Find text (Ctrl/Cmd+F)" onClick={() => setSearchOpen((open) => !open)}><Search size={14} /></Button></div><TextSearchPopover open={searchOpen} onClose={() => setSearchOpen(false)} search={textSearch} /></div>{(state.mode === "edit" || state.mode === "create") && <div className="editor-layout"><div ref={editorGutterRef} className="editor-gutter">{manifestText.split("\n").map((_, index) => <span key={index}>{index + 1}</span>)}</div><textarea ref={manifestEditorRef} className="manifest-editor" spellCheck={false} value={manifestText} onChange={(event) => setManifestText(event.target.value)} onScroll={(event) => { if (editorGutterRef.current) editorGutterRef.current.scrollTop = event.currentTarget.scrollTop; }} />{feedback && <Badge className="editor-feedback" tone={feedback.includes("success") || feedback.includes("valid") ? "green" : feedback.includes("Applying") || feedback.includes("Validating") ? "neutral" : "red"}>{feedback}</Badge>}</div>}{state.mode === "logs" && <div className={cn("terminal-output logs-output", logWrapLines && "wrap-lines")} style={{ fontFamily: terminalFont }}><pre><AnsiHighlightedText text={output} matches={textSearch.matches} currentIndex={textSearch.currentIndex} /></pre></div>}{state.mode === "terminal" && <div className="terminal-output terminal-interactive"><Suspense fallback={<div className="terminal-loading"><LoaderCircle className="spin" size={14} />Loading terminal…</div>}><ContainerTerminal sessionId={terminalSessionId} output={terminalOutput} connected={terminalStatus === "connected"} theme={terminalTheme} fontFamily={terminalFont} search={textSearch} onInput={writeTerminalInput} onResize={resizeContainerTerminal} onFind={() => setSearchOpen(true)} /></Suspense></div>}</>}</section>;
}

function AlertsDialog({ clusterId, onClose }: { clusterId: string; onClose: () => void }) {
  const [items, setItems] = useState(events.slice(0, 2));
  useEffect(() => {
    if (!nativeBackendAvailable || clusterId === "unconfigured") return;
    let cancelled = false;
    backend.overview(clusterId).then((snapshot) => { if (!cancelled) setItems(snapshot.events.filter((event) => event.level === "warning")); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [clusterId]);
  return <div className="modal-backdrop panel-dialog-backdrop" onMouseDown={onClose}><section className="alerts-modal" onMouseDown={(event) => event.stopPropagation()}><div className="dialog-header"><h2>Alerts</h2><Badge tone="amber">{items.length} active</Badge><div /><Button variant="ghost" size="icon" aria-label="Close alerts" onClick={onClose}><X size={15} /></Button></div><div className="drawer-events">{items.map((event, index) => <div key={`${event.object}-${index}`}><AlertTriangle size={14} /><div><strong>{event.reason}</strong><span>{event.message}</span><small>{event.time} ago · {event.object}</small></div></div>)}{items.length === 0 && <div className="related-empty">No active warning events</div>}</div><footer><span>Showing active warning events from Kubernetes</span><Button variant="outline" size="sm" onClick={onClose}>Close</Button></footer></section></div>;
}

function SettingsSheet({ preferences, onChange, onClose }: { preferences: Preferences; onChange: (next: Preferences) => void; onClose: () => void }) {
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [updateMessage, setUpdateMessage] = useState("");
  const language = preferences.language;
  const update = <K extends keyof Preferences>(key: K, value: Preferences[K]) => onChange({ ...preferences, [key]: value });
  const themeLabels = language === "en" ? ["Follow system", "Light", "Dark"] : language === "zh-TW" ? ["跟隨系統", "淺色", "深色"] : ["跟随系统", "浅色", "深色"];
  const terminalThemeLabels = language === "en" ? ["Follow application", "Dark", "Light"] : language === "zh-TW" ? ["跟隨應用程式主題", "深色", "淺色"] : ["跟随应用主题", "深色", "浅色"];
  return <div className="modal-backdrop panel-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="settings-modal"><div className="settings-header"><h2>{t(language, "settings")}</h2><div /><Button variant="ghost" size="icon" aria-label="Close settings" onClick={onClose}><X size={15} /></Button></div><div className="settings-scroll">
    <section className="settings-section"><div className="settings-section-title"><Globe2 size={15} /><div><h3>{t(language, "application")}</h3><p>Language and visual appearance</p></div></div><div className="settings-card"><div className="settings-row"><span><strong>{t(language, "language")}</strong><small>Changes are applied immediately</small></span><Combobox value={preferences.language} onChange={(value) => update("language", value as AppLanguage)} options={[{ value: "en", label: "English" }, { value: "zh-CN", label: "简体中文" }, { value: "zh-TW", label: "繁體中文" }]} /></div><div className="settings-row"><span><strong>{t(language, "theme")}</strong><small>Use system appearance or override it</small></span><Combobox value={preferences.theme} onChange={(value) => update("theme", value as Preferences["theme"])} options={["system", "light", "dark"].map((value, index) => ({ value, label: themeLabels[index] }))} /></div></div></section>
    <section className="settings-section"><div className="settings-section-title"><Type size={15} /><div><h3>{t(language, "terminal")}</h3><p>Shared by container terminals and log viewers</p></div></div><div className="settings-card"><div className="settings-row"><span><strong>{t(language, "terminalTheme")}</strong><small>Terminal colors can be independent</small></span><Combobox value={preferences.terminalTheme} onChange={(value) => update("terminalTheme", value as TerminalTheme)} options={["system", "dark", "light"].map((value, index) => ({ value, label: terminalThemeLabels[index] }))} /></div><div className="settings-row"><span><strong>{t(language, "terminalFont")}</strong><small>Monospaced fonts installed on this system</small></span><Combobox value={preferences.terminalFont} onChange={(value) => update("terminalFont", value)} options={["monospace", "JetBrains Mono", "SFMono-Regular", "Cascadia Code", "Fira Code", "IBM Plex Mono"].map((value) => ({ value, label: value }))} /></div></div></section>
    <section className="settings-section"><div className="settings-section-title"><Wifi size={15} /><div><h3>{t(language, "proxy")}</h3><p>Proxy for application and cluster traffic</p></div></div><div className="settings-card"><div className="settings-row"><span><strong>{t(language, "proxy")}</strong><small>HTTP and HTTPS proxy URLs are applied to kube-rs clients</small></span><ToggleSwitch label="Enable proxy" checked={preferences.proxyEnabled} onChange={(value) => update("proxyEnabled", value)} /></div>{preferences.proxyEnabled && <div className="settings-input-row"><span>Proxy URL</span><input value={preferences.proxyUrl} onChange={(event) => update("proxyUrl", event.target.value)} placeholder="http://127.0.0.1:7890" /></div>}</div></section>
    <section className="settings-section"><div className="settings-section-title"><Download size={15} /><div><h3>{t(language, "updates")}</h3><p>{updateMessage || (checked ? t(language, "upToDate") : "Version 0.1.0 · stable channel")}</p></div><Button variant="outline" size="sm" disabled={checking} onClick={() => { setChecking(true); setChecked(false); setUpdateMessage(""); if (nativeBackendAvailable) { backend.info().then(() => setUpdateMessage("No signed update source is configured for this build")).catch((error) => setUpdateMessage(String(error))).finally(() => setChecking(false)); } else { window.setTimeout(() => { setChecking(false); setChecked(true); }, 800); } }}>{checking ? <LoaderCircle className="spin" size={13} /> : checked ? <CheckCircle2 size={13} /> : <RefreshCw size={13} />} {t(language, "checkUpdates")}</Button></div><div className="settings-card"><div className="settings-row"><span><strong>{t(language, "autoUpdate")}</strong><small>{nativeBackendAvailable ? "Used when a signed updater endpoint is configured" : "Download and install updates in the background"}</small></span><ToggleSwitch label="Automatic updates" checked={preferences.autoUpdate} onChange={(value) => update("autoUpdate", value)} /></div></div></section>
  </div></section></div>;
}

function AddClusterDialog({ language, onClose, onAdd }: { language: AppLanguage; onClose: () => void; onAdd: (request: { displayName: string; kubeconfigYaml?: string; server?: string; token?: string; insecureSkipTlsVerify?: boolean }) => Promise<void> }) {
  const methods = [
    { id: "file", label: "Kubeconfig file", icon: FileUp },
    { id: "paste", label: "Paste config", icon: Copy },
    { id: "manual", label: "Manual", icon: Settings },
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
      <header><h2>{t(language, "addCluster")}</h2><div /><Button variant="ghost" size="icon" aria-label="Close add cluster" onClick={onClose}><X size={15} /></Button></header>
      <div className="add-cluster-tabs-row">
        <div className="add-cluster-tabs" role="tablist" aria-label="Cluster connection method" aria-orientation="horizontal">
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
        <label className="field-label"><span>Display name <small>Optional</small></span><input value={clusterName} onChange={(event) => setClusterName(event.target.value)} placeholder="e.g. production-eu" /></label>
        {mode === "file" && <label className="file-drop" onDragOver={(event) => event.preventDefault()} onDrop={async (event) => { event.preventDefault(); const file = event.dataTransfer.files?.[0]; setFileName(file?.name ?? ""); setKubeconfig(file ? await file.text() : ""); }}><input type="file" accept=".yaml,.yml,.config" onChange={async (event) => { const file = event.target.files?.[0]; setFileName(file?.name ?? ""); setKubeconfig(file ? await file.text() : ""); }} /><Upload size={22} /><strong>{fileName || "Drop kubeconfig here"}</strong><span>{fileName ? "Ready to import" : "or click to choose a file"}</span></label>}
        {mode === "paste" && <label className="field-label"><span>Kubeconfig YAML</span><textarea value={kubeconfig} onChange={(event) => setKubeconfig(event.target.value)} placeholder={'apiVersion: v1\nclusters:\n  - cluster: ...'} /></label>}
        {mode === "manual" && <><label className="field-label"><span>API server URL</span><input value={server} onChange={(event) => setServer(event.target.value)} placeholder="https://kubernetes.example.com:6443" /></label><label className="field-label"><span>Bearer token</span><textarea rows={3} value={token} onChange={(event) => setToken(event.target.value)} placeholder="eyJhbGciOiJSUzI1NiIs..." /></label><label className="settings-input-row"><span>Skip TLS verification</span><ToggleSwitch label="Skip TLS verification" checked={insecure} onChange={setInsecure} /></label></>}
        <div className="import-note"><ShieldCheck size={14} /><span>Credentials stay in the native Rust process; imported files use owner-only permissions on Unix.</span></div>{error && <div className="related-empty">{error}</div>}
      </div>
      <footer><span>{mode === "file" ? "Supports standard kubeconfig files" : "Connection will be validated before saving"}</span><div /><Button variant="outline" size="sm" onClick={onClose}>{t(language, "cancel")}</Button><Button size="sm" disabled={addDisabled} onClick={() => void submit()}>{busy && <LoaderCircle className="spin" size={13} />} {t(language, "add")}</Button></footer>
    </div>
  </div>;
}

function CommandPalette({ onClose, onNavigate, onTerminal, onCreate }: { onClose: () => void; onNavigate: (item: string) => void; onTerminal: () => void; onCreate: () => void }) {
  const [query, setQuery] = useState("");
  const commands = [
    ...navGroups.flatMap((group) => group.items).map((item) => ({ label: `Go to ${item}`, run: () => onNavigate(item) })),
    { label: "Open cluster terminal", run: onTerminal },
    { label: "Create resource", run: onCreate },
  ].filter((command) => command.label.toLowerCase().includes(query.toLowerCase())).slice(0, 12);
  return <div className="modal-backdrop" onMouseDown={onClose}><div className="command-modal" onMouseDown={(event) => event.stopPropagation()}><div className="command-input"><Search size={17} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && commands[0]) { commands[0].run(); onClose(); } }} placeholder="Search resources and run commands…" /><kbd>ESC</kbd></div><p>{query ? "RESULTS" : "QUICK ACTIONS"}</p>{commands.map((command) => <button key={command.label} onClick={() => { command.run(); onClose(); }}><span className="command-key"><Command size={14} /></span>{command.label}<kbd>↵</kbd></button>)}{commands.length === 0 && <div className="related-empty">No matching command</div>}</div></div>;
}

export default function App() {
  useAutoHideScrollbars();
  const [availableClusters, setAvailableClusters] = useState<Cluster[]>(() => {
    try {
      const colors = JSON.parse(localStorage.getItem("kubehive.clusterColors") ?? "{}") as Record<string, string>;
      return applySavedClusterOrder(initialClusters.map((item) => ({ ...item, color: colors[item.id] ?? item.color })));
    } catch { return applySavedClusterOrder(initialClusters); }
  });
  const [cluster, setCluster] = useState(() => availableClusters[0] ?? initialClusters[0]);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("clusters");
  const [clusterOperationId, setClusterOperationId] = useState<string | null>(null);
  const [initialClusterWorkspaces] = useState<Record<string, ClusterWorkspaceState>>(() => loadClusterWorkspaces());
  const clusterWorkspacesRef = useRef(initialClusterWorkspaces);
  const [namespace, setNamespace] = useState("All namespaces");
  const [navOpen, setNavOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  const [toast, setToast] = useState<AppToast | null>(null);
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("dark");
  const [preferences, setPreferences] = useState<Preferences>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("kubehive.preferences") ?? "{}") as Partial<Preferences> & { language?: string };
      const language: AppLanguage = saved.language === "zh-TW" ? "zh-TW" : saved.language === "zh-CN" || saved.language === "zh-K8s" ? "zh-CN" : "en";
      return { ...defaultPreferences, ...saved, language };
    } catch { return defaultPreferences; }
  });
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const resource = activeTab.resource;
  const language = preferences.language;
  const terminalAppearance = preferences.terminalTheme === "system" ? resolvedTheme : preferences.terminalTheme;
  const activeCluster = availableClusters.find((item) => item.id === cluster.id) ?? cluster;
  const accent = clusterAccent(activeCluster);
  const clusterSettingsTarget = availableClusters.find((item) => item.id === clusterSettingsId) ?? null;
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
      setToast({ id: Date.now(), tone: "error", message: `Unable to open log file: ${String(error)}` });
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
    if (row.kind === "HelmRelease") return { ...base, loading: false };
    if (!nativeBackendAvailable || !row.backend || !row.descriptor) return base;
    try {
      const response = await backend.getResource({ clusterId: activeCluster.id, resource: row.descriptor, namespace: row.namespace === "—" ? undefined : row.namespace, name: row.name });
      return { ...base, row: rowFromBackend(response, row.descriptor), manifest: response.manifest, loading: false };
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
  const startPortForwardForPod = async (targetRow?: ResourceRow) => {
    if (!nativeBackendAvailable) { setBackendError("Port forwarding is available in the native Tauri application."); return; }
    let pod = targetRow;
    if (targetRow?.kind === "Service") {
      const selector = (targetRow.backend?.object.spec as { selector?: Record<string, string> } | undefined)?.selector;
      if (!selector || !Object.keys(selector).length) throw new Error("This Service has no selector, so a backing Pod cannot be resolved");
      const podDescriptor = descriptorForResource("Pods", discoveredResources)!;
      const response = await backend.listResources({ clusterId: activeCluster.id, resource: podDescriptor, namespace: targetRow.namespace, labelSelector: Object.entries(selector).map(([key, value]) => `${key}=${value}`).join(",") });
      const record = response.items.find((item) => String((item.object.status as { phase?: string } | undefined)?.phase) === "Running") ?? response.items[0];
      if (!record) throw new Error("No backing Pod was found for this Service");
      pod = rowFromBackend(record, podDescriptor);
    }
    let namespaceValue = pod?.namespace;
    let podName = pod?.name;
    if (!podName) {
      const target = window.prompt("Pod to forward (namespace/pod)", `${namespace === "All namespaces" ? "default" : namespace}/`);
      if (!target) return;
      [namespaceValue, podName] = target.split("/", 2);
    }
    if (!namespaceValue || !podName) throw new Error("Use namespace/pod for the port-forward target");
    const remote = Number(window.prompt("Remote container port", "8080"));
    if (!Number.isInteger(remote) || remote < 1 || remote > 65535) throw new Error("Remote port must be between 1 and 65535");
    const localText = window.prompt("Local port (0 chooses a free port)", String(remote));
    if (localText === null) return;
    const local = Number(localText);
    if (!Number.isInteger(local) || local < 0 || local > 65535) throw new Error("Local port must be between 0 and 65535");
    const session = await backend.startPortForward({ clusterId: activeCluster.id, namespace: namespaceValue, pod: podName, localPort: local, remotePort: remote });
    setBackendError(`Port forward active: 127.0.0.1:${session.localPort} → ${namespaceValue}/${podName}:${remote}`);
    setDataRevision((value) => value + 1);
  };
  const performResourceAction = async (action: string, row: ResourceRow) => {
    if (action === "Port Forward") { try { await startPortForwardForPod(row); } catch (error) { setBackendError(String(error)); } return; }
    if (row.kind === "PortForward" && action === "Delete") { try { await backend.stopPortForward(row.key); setDataRevision((value) => value + 1); } catch (error) { setBackendError(String(error)); } return; }
    const item = await fetchDetailForRow(row);
    if (action === "Logs" || action === "Terminal") {
      openBottomSession({ mode: action === "Logs" ? "logs" : "terminal", item });
      setDetail(null);
      return;
    }
    if (action === "Edit") {
      openBottomSession({ mode: "edit", item, manifest: item.manifest, descriptor: row.descriptor });
      setDetail(null);
      return;
    }
    if (!nativeBackendAvailable || !row.descriptor) return;
    const target = { clusterId: activeCluster.id, resource: row.descriptor, namespace: row.namespace === "—" ? undefined : row.namespace, name: row.name };
    try {
      if (action === "Scale") {
        let scaleTarget = target;
        let current = Number(String(row.data.ready ?? row.data.desired ?? "1").split("/").at(-1)) || 1;
        if (row.kind === "Pod" && row.backend) {
          const owner = ((row.backend.object.metadata as { ownerReferences?: Array<{ kind: string; name: string }> } | undefined)?.ownerReferences ?? [])[0];
          if (!owner) throw new Error("This Pod has no scalable controller");
          let ownerDescriptor = discoveredResources.find((entry) => entry.kind === owner.kind);
          if (!ownerDescriptor) throw new Error(`The ${owner.kind} API is not available`);
          let ownerDetail = await backend.getResource({ clusterId: activeCluster.id, resource: ownerDescriptor, namespace: row.namespace, name: owner.name });
          let ownerName = owner.name;
          if (owner.kind === "ReplicaSet") {
            const deployment = ((ownerDetail.object.metadata as { ownerReferences?: Array<{ kind: string; name: string }> } | undefined)?.ownerReferences ?? []).find((entry) => entry.kind === "Deployment");
            if (deployment) {
              ownerDescriptor = discoveredResources.find((entry) => entry.kind === "Deployment") ?? ownerDescriptor;
              ownerName = deployment.name;
              ownerDetail = await backend.getResource({ clusterId: activeCluster.id, resource: ownerDescriptor, namespace: row.namespace, name: ownerName });
            }
          }
          if (!["Deployment", "StatefulSet", "ReplicaSet", "ReplicationController"].includes(ownerDescriptor.kind)) throw new Error(`${ownerDescriptor.kind}/${ownerName} does not expose replicas`);
          current = Number((ownerDetail.object.spec as { replicas?: number } | undefined)?.replicas) || current;
          scaleTarget = { clusterId: activeCluster.id, resource: ownerDescriptor, namespace: row.namespace, name: ownerName };
        }
        const value = window.prompt(`Scale ${scaleTarget.resource.kind}/${scaleTarget.name} to how many replicas?`, String(current));
        if (value === null) return;
        const replicas = Number(value);
        if (!Number.isInteger(replicas) || replicas < 0) throw new Error("Replicas must be a non-negative integer");
        await backend.scaleResource({ ...scaleTarget, replicas });
      } else if (action === "Restart") {
        await backend.restartResource(target);
      } else if (action === "Delete") {
        if (!window.confirm(`Delete ${row.kind}/${row.name}${row.namespace !== "—" ? ` in ${row.namespace}` : ""}? This cannot be undone.`)) return;
        await backend.deleteResource({ ...target, foreground: false });
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
    setWorkspaceView("clusters");
    setNavOpen(false);
    setCommandOpen(false);
    setAlertsOpen(false);
    setDetail(null);
  };
  const connectAndOpenCluster = async (target: Cluster) => {
    if (clusterOperationId) return;
    captureActiveClusterWorkspace();
    setClusterOperationId(target.id);
    try {
      const next = target.disconnected
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
      setAlertCount(nativeBackendAvailable ? 0 : events.filter((event) => event.level === "warning").length);
      setBackendError("");
    } catch (error) {
      updateCluster(target.id, { disconnected: true });
      setBackendError(String(error));
      setWorkspaceView("clusters");
    } finally {
      setClusterOperationId(null);
    }
  };
  const closeClusterConnection = async (target: Cluster) => {
    if (clusterOperationId) return;
    captureActiveClusterWorkspace();
    setClusterOperationId(target.id);
    try {
      if (nativeBackendAvailable && !target.disconnected) await backend.disconnectCluster(target.id);
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
      setBackendError("");
    } catch (error) {
      setBackendError(String(error));
    } finally {
      setClusterOperationId(null);
    }
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



  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && workspaceView === "cluster") { event.preventDefault(); setCommandOpen(true); }
      if (event.key === "Escape") { setCommandOpen(false); setDetail(null); setBottomCollapsed(true); setAlertsOpen(false); setSettingsOpen(false); setAddClusterOpen(false); setClusterSettingsId(null); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [workspaceView]);

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
      onSettings={() => { setSettingsOpen(true); setDetail(null); }}
      onAdd={() => setAddClusterOpen(true)}
      onClusterSettings={(target) => setClusterSettingsId(target.id)}
      onCloseConnection={(target) => void closeClusterConnection(target)}
      onMove={moveCluster}
      onReorder={reorderCluster}
      onRemove={removeCluster}
    />
    <div className={cn("workspace-pane", workspaceView === "clusters" && "home-mode")}>
      {workspaceView === "clusters" ? <ClusterHome clusters={availableClusters} language={language} busyClusterId={clusterOperationId} onConnect={(target) => void connectAndOpenCluster(target)} onCloseConnection={(target) => void closeClusterConnection(target)} onSettings={(target) => setClusterSettingsId(target.id)} onRemove={removeCluster} onAdd={() => setAddClusterOpen(true)} /> : <>
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
            ? <Overview cluster={activeCluster} language={language} revision={dataRevision} onWorkload={openWorkload} onResource={openResourceRow} onTerminal={() => openBottomSession({ mode: "terminal" })} onNavigate={openResourcePage} onSnapshot={(snapshot) => { updateCluster(activeCluster.id, { nodes: snapshot.nodes, cpu: snapshot.cpuPercent ?? 0, memory: snapshot.memoryPercent ?? 0, version: snapshot.version, status: snapshot.readyNodes === snapshot.nodes ? "healthy" : "warning" }); setAlertCount(snapshot.events.filter((event) => event.level === "warning").length); }} />
            : resource === "Custom Resource Definitions"
              ? <CrdBrowser clusterId={activeCluster.id} discovered={discoveredResources} namespaces={clusterNamespaces} revision={dataRevision} selectedDefinitionName={activeTab.crdName ?? null} namespace={namespace} setNamespace={setNamespace} language={language} onKindSelect={(definition) => openResourcePage("Custom Resource Definitions", definition)} onBack={() => openResourcePage("Custom Resource Definitions")} onInstance={openResourceRow} onCreate={openCreateSession} onOpenLink={openRelatedLink} />
              : <ResourceTable clusterId={activeCluster.id} discovered={discoveredResources} namespaces={clusterNamespaces} revision={dataRevision} resource={resource} namespace={namespace} setNamespace={setNamespace} language={language} onSelect={openResourceRow} onOpenLink={openRelatedLink} onCreate={resource === "Port Forwarding" ? () => { void startPortForwardForPod().catch((error) => setBackendError(String(error))); } : openCreateSession} onRowAction={(action, row) => void performResourceAction(action, row)} />}
          {bottomSessions.length > 0 && <BottomActionSheet clusterId={activeCluster.id} sessions={bottomSessions} activeId={activeBottomId} collapsed={bottomCollapsed} language={language} terminalTheme={terminalAppearance} terminalFont={preferences.terminalFont} terminalRuntimes={terminalRuntimes} sessionCaches={bottomSessionCaches} onUpdateTerminalRuntimes={updateTerminalRuntimes} onUpdateSessionCaches={updateBottomSessionCaches} onActivate={(id) => { setActiveBottomId(id); setBottomCollapsed(false); }} onCloseSession={closeBottomSession} onCloseOthers={closeOtherSessions} onCloseAll={closeAllSessions} onCreateSession={openBottomSession} onToggleCollapsed={() => setBottomCollapsed((value) => !value)} onApplied={() => setDataRevision((value) => value + 1)} onToast={showToast} />}
        </main>
      </>}
    </div>
    {workspaceView === "cluster" && detail && <DetailSheet tab={detail} onClose={() => setDetail(null)} onOpenResource={openResourceRow} onAction={(action) => { if (detail.row) void performResourceAction(action, detail.row); else if (action === "Logs" || action === "Terminal" || action === "Edit") { openBottomSession({ mode: action === "Logs" ? "logs" : action === "Terminal" ? "terminal" : "edit", item: detail, manifest: detail.manifest }); setDetail(null); } }} />}

    {workspaceView === "cluster" && alertsOpen && <AlertsDialog clusterId={activeCluster.id} onClose={() => setAlertsOpen(false)} />}
    {settingsOpen && <SettingsSheet preferences={preferences} onChange={setPreferences} onClose={() => setSettingsOpen(false)} />}
    {addClusterOpen && <AddClusterDialog language={language} onClose={() => setAddClusterOpen(false)} onAdd={addCluster} />}
    {clusterSettingsTarget && <ClusterSettingsDialog clusterName={clusterSettingsTarget.name} color={clusterAccent(clusterSettingsTarget)} language={language} onSave={(name, color) => saveClusterSettings(clusterSettingsTarget, name, color)} onClose={() => setClusterSettingsId(null)} />}
    {workspaceView === "cluster" && commandOpen && <CommandPalette onClose={() => setCommandOpen(false)} onNavigate={openResourcePage} onTerminal={() => openBottomSession({ mode: "terminal" })} onCreate={() => openCreateSession()} />} {backendError && <div className="backend-error-toast" role="alert"><AlertTriangle size={14} /><span>{backendError}</span><button onClick={() => setBackendError("")} aria-label="Dismiss backend error"><X size={13} /></button></div>}
    {toast && <div className={cn("app-toast", `tone-${toast.tone}`)} role="status"><CheckCircle2 size={14} /><span>{toast.message}{toast.filePath && <button type="button" className="app-toast-file" title="Open log file" onClick={() => void openToastFile(toast.filePath!)}>{toast.filePath}</button>}</span><button onClick={() => setToast(null)} aria-label="Dismiss notification"><X size={13} /></button></div>}
    <ContextMenuHost />
  </div>;
}
