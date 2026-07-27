import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  Activity, AlertTriangle, Bell, Box, Boxes, CheckCircle2, ChevronDown, ChevronRight, CircleDot, Code2,
  Command, Copy, Cpu, Database, Download, FileCode2, FileUp, Gauge, Globe2, HardDrive, Hexagon,
  LayoutDashboard, LoaderCircle, Maximize2, Menu, Minimize2, Minus, MoreHorizontal, Network, Palette, Pencil, Play, Plus,
  RefreshCw, Search, Server, Settings, ShieldCheck, Square, SquareTerminal, Trash2, Type, Upload,
  Users, Wifi, X, Zap,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Badge, Button, Progress, cn } from "./ui";
import { Combobox } from "./combobox";
import {
  clusters as initialClusters, customResourceDefinitions, customResources, events, navGroups, workloads,
  type Cluster, type CustomResource, type CustomResourceDefinition, type Workload,
} from "./data";
import { defaultPreferences, groupLabel, resourceLabel, t, type AppLanguage, type Preferences, type TerminalTheme } from "./preferences";
import "./index.css";
import "./workbench.css";
import "./platform.css";
import "./settings.css";
import "./refinements.css";
import "./tab-polish.css";
import "./sheet-polish.css";
import "./session-settings-polish.css";
import "./final-alignment.css";

type ResourceTab = { id: string; label: string; resource: string; crdKind?: string };
type DetailItem = { id: string; label: string; subtitle: string; type: "resource" | "crd"; workload?: Workload; crd?: CustomResource; kind?: string };
type BottomRequest = { mode: "create" | "edit" | "logs" | "terminal"; item?: DetailItem; sessionKey?: string; label?: string };
type BottomSession = BottomRequest & { id: string };
type DesktopPlatform = "macos" | "windows" | "linux";

const platform: DesktopPlatform = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "macos" : /Win/.test(navigator.userAgent) ? "windows" : "linux";

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
  return <button type="button" aria-label={label} aria-pressed={checked} className={cn("settings-toggle", checked && "active")} onClick={() => onChange(!checked)}><i/></button>;
}

const iconMap: Record<string, typeof Box> = {
  Overview: LayoutDashboard, Pods: Box, Deployments: Boxes, StatefulSets: Database,
  DaemonSets: Server, "Jobs & CronJobs": Zap, Services: Network, Ingresses: Network,
  "Network Policies": ShieldCheck, "Persistent Volumes": HardDrive, "Storage Classes": Database,
  "Config Maps": FileCode2, Secrets: ShieldCheck, "Resource Quotas": Gauge,
  "Service Accounts": Users, Roles: ShieldCheck, "Role Bindings": Users,
  "Helm Releases": Hexagon, "Custom Resource Definitions": Code2,
};

function StatusDot({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  return <span className={cn("status-dot", (normalized.includes("healthy") || normalized.includes("running") || normalized.includes("ready") || normalized.includes("synced")) && "ok", (normalized.includes("warning") || normalized.includes("degraded") || normalized.includes("pending") || normalized.includes("issuing") || normalized.includes("outofsync")) && "warn", normalized === "offline" && "off")} />;
}

function ClusterRail({ clusters, active, onSelect, onAlerts, onSettings, onAdd }: { clusters: Cluster[]; active: Cluster; onSelect: (cluster: Cluster) => void; onAlerts: () => void; onSettings: () => void; onAdd: () => void }) {
  return <aside className="cluster-rail">
    <div className="rail-header"><div className="brand-mark" title="KubeHive"><Hexagon size={19} /></div><div className="rail-divider" /></div>
    <div className="cluster-list">{clusters.map((cluster) => <button key={cluster.id} className={cn("cluster-icon", active.id === cluster.id && "active")} onClick={() => onSelect(cluster)} title={cluster.name}><span>{cluster.name.slice(0, 2).toUpperCase()}</span><StatusDot status={cluster.status} /></button>)}<button className="cluster-icon add" title="Add cluster" onClick={onAdd}><Plus size={16} /></button></div>
    <div className="rail-footer"><button className="rail-button alert-button" title="Alerts" onClick={onAlerts}><Bell size={16} /><i>2</i></button><button className="rail-button" title="Settings" onClick={onSettings}><Settings size={16} /></button></div>
  </aside>;
}

function ResourceNav({ active, cluster, language, onSelect, open, onClose }: { active: string; cluster: Cluster; language: AppLanguage; onSelect: (item: string) => void; open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  return <aside className={cn("resource-nav", open && "mobile-open")}>
    <div className="nav-title"><span>{t(language, "resources")}</span><Button variant="ghost" size="icon" className="mobile-only" aria-label="Close navigation" onClick={onClose}><X size={15} /></Button></div>
    <div className="nav-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Filter resources" placeholder={t(language, "filterResources")} /></div>
    <nav>{navGroups.map((group) => { const items = group.items.filter((item) => `${item} ${resourceLabel(language, item)}`.toLowerCase().includes(query.toLowerCase())); if (!items.length) return null; return <section key={group.label}>{group.label !== "Overview" && <p>{groupLabel(language, group.label)}</p>}{items.map((item) => { const Icon = iconMap[item] ?? Box; return <button key={item} aria-label={item} className={cn(active === item && "selected")} onClick={() => { onSelect(item); onClose(); }}><Icon size={14} /><span>{resourceLabel(language, item)}</span>{item === "Pods" && <small>148</small>}</button>; })}</section>; })}</nav>
    <div className="cluster-summary"><div className="cluster-summary-head"><span className="cluster-summary-icon">{cluster.name.slice(0,2).toUpperCase()}</span><div><small>{t(language, "currentCluster")}</small><strong>{cluster.name}</strong></div><StatusDot status={cluster.status}/></div><div className="cluster-summary-meta"><span>{cluster.provider} · {cluster.region}</span><Badge>{cluster.version}</Badge></div><div className="cluster-summary-stats"><span><strong>{cluster.nodes}</strong> nodes</span><span><strong>{cluster.cpu}%</strong> CPU</span></div></div>
  </aside>;
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
  return <div className="window-controls" aria-label="Window controls"><button aria-label="Minimize" onClick={run("minimize")}><Minus size={13}/></button><button aria-label="Maximize" onClick={run("maximize")}><Square size={11}/></button><button className="close" aria-label="Close window" onClick={run("close")}><X size={13}/></button></div>;
}

function WorkspaceTabs({ tabs, activeId, language, onActivate, onClose, onMenu, onCommand }: { tabs: ResourceTab[]; activeId: string; language: AppLanguage; onActivate: (id: string) => void; onClose: (id: string) => void; onMenu: () => void; onCommand: () => void }) {
  return <div className="workspace-tabs" data-tauri-drag-region><Button variant="ghost" size="icon" className="mobile-only tabs-menu-button" onClick={onMenu}><Menu size={15}/></Button><div className="workspace-tab-list">{tabs.map((tab) => { const Icon = tab.crdKind ? Code2 : (iconMap[tab.resource] ?? Box); return <button key={tab.id} className={cn(activeId === tab.id && "active")} onClick={() => onActivate(tab.id)}><Icon className="tab-icon" size={13}/><strong>{tab.crdKind ? tab.label : resourceLabel(language, tab.label)}</strong>{tab.id !== "overview" && <i role="button" aria-label={`Close ${tab.label}`} onClick={(event) => { event.stopPropagation(); onClose(tab.id); }}><X size={11}/></i>}</button>; })}</div><div className="tabs-drag-spacer" data-tauri-drag-region/><button className="tabs-command" onClick={onCommand}><Search size={13}/><span className="command-label">{t(language,"searchResources")}</span><span className="command-shortcut"><kbd>⌘</kbd><kbd>K</kbd></span></button><WindowControls/></div>;
}

function MetricCard({ label, value, unit, percentage, icon: Icon, tone = "green", sub }: { label: string; value: string; unit: string; percentage: number; icon: typeof Cpu; tone?: "green" | "amber"; sub: string }) {
  return <div className="metric-card"><div className="metric-top"><span><Icon size={14} />{label}</span><strong>{value}<small>{unit}</small></strong></div><Progress value={percentage} tone={tone} /><div className="metric-foot"><span>{percentage}% allocated</span><span>{sub}</span></div></div>;
}

function Overview({ cluster, language, onWorkload, onTerminal }: { cluster: Cluster; language: AppLanguage; onWorkload: (item: Workload) => void; onTerminal: () => void }) {
  return <div className="workspace-scroll"><div className="page-head"><div><div className="eyebrow">CLUSTER OVERVIEW</div><h1>{cluster.name}</h1><p>Kubernetes {cluster.version} · {cluster.nodes} nodes · updated just now</p></div><div className="head-actions"><Button variant="outline" size="sm"><RefreshCw size={13} />{t(language,"refresh")}</Button><Button size="sm" onClick={onTerminal}><SquareTerminal size={13} />Open shell</Button></div></div>
    <div className="metrics-grid"><MetricCard label="CPU" value={String(cluster.cpu)} unit="%" percentage={cluster.cpu} tone={cluster.cpu > 75 ? "amber" : "green"} sub="42.6 / 66 cores" icon={Cpu} /><MetricCard label="Memory" value={String(cluster.memory)} unit="%" percentage={cluster.memory} sub="181 / 256 GiB" icon={Activity} /><MetricCard label="Pods" value="148" unit="/ 320" percentage={46} sub="146 running" icon={Box} /><MetricCard label="Storage" value="8.4" unit="TiB" percentage={68} tone="amber" sub="3.9 TiB available" icon={HardDrive} /></div>
    <div className="overview-grid"><section className="panel"><div className="panel-head"><div><h2>Workload health</h2><p>Across all namespaces</p></div><Button variant="ghost" size="sm">View all <ChevronRight size={12} /></Button></div><div className="health-chart"><div className="donut"><div><strong>172</strong><span>workloads</span></div></div><div className="health-legend"><div><span><i className="green" />Healthy</span><strong>164</strong></div><div><span><i className="amber" />Degraded</span><strong>5</strong></div><div><span><i className="red" />Failed</span><strong>3</strong></div></div></div></section><section className="panel"><div className="panel-head"><div><h2>Nodes</h2><p>{cluster.nodes} connected</p></div><Badge tone="green">All ready</Badge></div><div className="node-bars">{[64,48,76,38,57,81,44,69,52,72,33,61].map((v,i) => <div key={i}><span style={{height:`${v}%`}} className={v>78?"hot":""}/></div>)}</div><div className="node-axis"><span>node-01</span><span>CPU utilization</span><span>node-12</span></div></section></div>
    <section className="panel issues-panel"><div className="panel-head"><div><h2>Needs attention</h2><p>Workloads with active warnings</p></div><Badge tone="amber">2 active</Badge></div><div className="compact-list">{workloads.filter((item) => item.status !== "Running").map((item) => <button key={item.name} onClick={() => onWorkload(item)}><StatusDot status={item.status}/><div><strong>{item.name}</strong><span>{item.namespace} · {item.kind}</span></div><Badge tone="amber">{item.status}</Badge><span>{item.ready} ready</span><ChevronRight size={14}/></button>)}</div></section>
    <section className="panel events-panel"><div className="panel-head"><div><h2>Recent events</h2><p>Live cluster activity</p></div><div className="live-label"><i/>LIVE</div></div><div className="event-list">{events.map((event,index) => <div key={index}><span className={cn("event-icon",event.level)}>{event.level === "warning" ? <AlertTriangle size={13}/> : <CircleDot size={13}/>}</span><div><strong>{event.reason}</strong><span>{event.message}</span><small>{event.object}</small></div><time>{event.time}</time></div>)}</div></section>
  </div>;
}

function ResourceTable({ resource, namespace, setNamespace, language, onSelect, onCreate }: { resource: string; namespace: string; setNamespace: (value: string) => void; language: AppLanguage; onSelect: (item: Workload) => void; onCreate: () => void }) {
  const [query, setQuery] = useState("");
  const filtered = workloads.filter((item) => (namespace === "All namespaces" || item.namespace === namespace) && `${item.name} ${item.namespace} ${item.kind}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="workspace-scroll"><div className="page-head"><div><div className="eyebrow">KUBERNETES RESOURCES</div><h1>{resourceLabel(language,resource)}</h1><p>{filtered.length} resources · live updates enabled</p></div><div className="head-actions"><Button variant="outline" size="sm"><RefreshCw size={13}/>{t(language,"refresh")}</Button><Button size="sm" onClick={onCreate}><Plus size={13}/>{t(language,"create")}</Button></div></div><div className="table-toolbar"><Combobox className="table-namespace-combobox" label={t(language,"namespace")} value={namespace} onChange={setNamespace} options={["All namespaces", "commerce", "search", "storefront", "ingress-nginx", "monitoring", "argocd"].map((item) => ({ value: item, label: item === "All namespaces" ? t(language,"allNamespaces") : item }))}/><div className="table-search"><Search size={14}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`${t(language,"searchResources")} ${resourceLabel(language,resource)}`}/></div><div className="toolbar-spacer"/><span>Auto-refresh</span><button className="toggle active"><i/></button></div><div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>Name</th><th>Status</th><th>Namespace</th><th>Ready</th><th>Restarts</th><th>CPU</th><th>Memory</th><th>Age</th><th/></tr></thead><tbody>{filtered.map((item) => <tr key={item.name} onClick={() => onSelect(item)}><td><div className="resource-name"><span className="resource-kind">{item.kind[0]}</span><div><strong>{item.name}</strong><small>{item.kind}</small></div></div></td><td><Badge tone={item.status === "Running" ? "green" : "amber"}><StatusDot status={item.status}/>{item.status}</Badge></td><td>{item.namespace}</td><td>{item.ready}</td><td className={item.restarts>5?"danger-text":""}>{item.restarts}</td><td>{item.cpu}</td><td>{item.memory}</td><td>{item.age}</td><td><Button variant="ghost" size="icon"><MoreHorizontal size={14}/></Button></td></tr>)}</tbody></table></div></div>;
}

function CrdBrowser({ selectedKind, namespace, setNamespace, language, onKindSelect, onBack, onInstance, onCreate }: { selectedKind: string | null; namespace: string; setNamespace: (value: string) => void; language: AppLanguage; onKindSelect: (crd: CustomResourceDefinition) => void; onBack: () => void; onInstance: (item: CustomResource, kind: string) => void; onCreate: () => void }) {
  const [query, setQuery] = useState("");
  const definition = customResourceDefinitions.find((item) => item.kind === selectedKind);
  if (definition) {
    const rows = (customResources[definition.kind] ?? []).filter((item) => (namespace === "All namespaces" || item.namespace === namespace) && item.name.toLowerCase().includes(query.toLowerCase()));
    return <div className="workspace-scroll"><div className="page-head"><div><div className="eyebrow">CUSTOM RESOURCE · {definition.group}</div><h1>{definition.kind}</h1><p>{definition.name} · {definition.scope}</p></div><div className="head-actions"><Button variant="outline" size="sm" onClick={onBack}>All CRDs</Button><Button size="sm" onClick={onCreate}><Plus size={13}/>Create</Button></div></div><div className="table-toolbar"><Combobox className="table-namespace-combobox" label={t(language,"namespace")} value={namespace} onChange={setNamespace} options={["All namespaces", "commerce", "search", "storefront", "ingress-nginx", "monitoring", "argocd"].map((item) => ({ value: item, label: item === "All namespaces" ? t(language,"allNamespaces") : item }))}/><div className="table-search"><Search size={14}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`${t(language,"searchResources")} ${definition.kind}`}/></div><div className="toolbar-spacer"/><span>{rows.length} resources</span></div><div className="resource-table-wrap"><table className="resource-table"><thead><tr><th>Name</th><th>Status</th><th>Namespace</th><th>API Version</th><th>Age</th><th/></tr></thead><tbody>{rows.map((item) => <tr key={item.name} onClick={() => onInstance(item, definition.kind)}><td><div className="resource-name"><span className="resource-kind">CR</span><strong>{item.name}</strong></div></td><td><Badge tone={item.status.includes("Ready") || item.status.includes("Healthy") || item.status.includes("Synced") ? "green" : "amber"}>{item.status}</Badge></td><td>{item.namespace}</td><td>{definition.group}/{item.version}</td><td>{item.age}</td><td><ChevronRight size={14}/></td></tr>)}</tbody></table></div></div>;
  }
  return <div className="workspace-scroll"><div className="page-head"><div><div className="eyebrow">API EXTENSIONS</div><h1>Custom Resource Definitions</h1><p>{customResourceDefinitions.length} definitions discovered in this cluster</p></div><Button size="sm" onClick={onCreate}><Plus size={13}/>Create CRD</Button></div><div className="resource-table-wrap standalone"><table className="resource-table"><thead><tr><th>Name</th><th>Group</th><th>Kind</th><th>Scope</th><th>Instances</th><th>Age</th><th/></tr></thead><tbody>{customResourceDefinitions.map((item) => <tr key={item.name} onClick={() => onKindSelect(item)}><td><div className="resource-name"><span className="resource-kind">CRD</span><strong>{item.name}</strong></div></td><td>{item.group}</td><td>{item.kind}</td><td><Badge>{item.scope}</Badge></td><td>{item.instances}</td><td>{item.age}</td><td><ChevronRight size={14}/></td></tr>)}</tbody></table></div></div>;
}

function DetailSheet({ tab, onClose, onAction }: { tab: DetailItem; onClose: () => void; onAction: (mode: BottomRequest) => void }) {
  const item = tab.workload;
  const headerActions: Array<{ label: string; icon: typeof Play; mode?: BottomRequest["mode"] }> = tab.type === "crd"
    ? [{ label: "Edit", icon: Pencil, mode: "edit" }, { label: "Delete", icon: Trash2 }]
    : item?.kind === "DaemonSet"
      ? [{ label: "Logs", icon: Play, mode: "logs" }, { label: "Edit", icon: Pencil, mode: "edit" }, { label: "Restart", icon: RefreshCw }, { label: "Delete", icon: Trash2 }]
      : item?.kind === "CronJob"
        ? [{ label: "Terminal", icon: SquareTerminal, mode: "terminal" }, { label: "Edit", icon: Pencil, mode: "edit" }, { label: "Delete", icon: Trash2 }]
        : item?.kind === "StatefulSet"
          ? [{ label: "Terminal", icon: SquareTerminal, mode: "terminal" }, { label: "Logs", icon: Play, mode: "logs" }, { label: "Edit", icon: Pencil, mode: "edit" }, { label: "Scale", icon: Gauge }, { label: "Delete", icon: Trash2 }]
          : [{ label: "Terminal", icon: SquareTerminal, mode: "terminal" }, { label: "Logs", icon: Play, mode: "logs" }, { label: "Edit", icon: Pencil, mode: "edit" }, { label: "Scale", icon: Gauge }, { label: "Restart", icon: RefreshCw }, { label: "Delete", icon: Trash2 }];
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
  return <><div className="sheet-scrim" onClick={onClose}/><aside ref={sheetRef} className="sheet sheet-right" style={{width}}><div className="sheet-resize-edge vertical" aria-label="Resize details" role="separator" aria-orientation="vertical" onPointerDown={startResize}/><div className="drawer-head detail-sheet-header"><div className="resource-kind">{tab.type === "crd" ? "CR" : item?.kind[0]}</div><div className="sheet-title-stack"><small>{tab.kind ?? item?.kind}</small><h2>{tab.label}</h2></div><div className="detail-header-actions">{headerActions.map(({label,icon:Icon,mode}) => <Button key={label} variant="ghost" size="icon" className={cn(label === "Delete" && "danger-action")} aria-label={label} title={label} onClick={() => mode && onAction({mode,item:tab})}><Icon size={13}/></Button>)}</div><Button variant="ghost" size="icon" aria-label="Close details" onClick={onClose}><X size={14}/></Button></div><div className="drawer-body"><div className="detail-status"><StatusDot status={item?.status ?? tab.crd?.status ?? "Ready"}/><div><strong>{item?.status ?? tab.crd?.status ?? "Ready"}</strong><span>Last reconciled 24 seconds ago</span></div><Badge tone="green">Available</Badge></div><h3>Resource</h3><dl><div><dt>API version</dt><dd>{tab.type === "crd" ? "custom/v1" : "apps/v1"}</dd></div><div><dt>Namespace</dt><dd>{tab.subtitle}</dd></div><div><dt>Created</dt><dd>{item?.age ?? tab.crd?.age} ago</dd></div>{item && <div><dt>Image</dt><dd>{item.image}<Button variant="ghost" size="icon"><Copy size={12}/></Button></dd></div>}</dl><h3>Conditions</h3><div className="condition-row"><StatusDot status="Ready"/><div><strong>Ready</strong><span>Minimum availability reached</span></div><time>24s</time></div><h3>Labels</h3><div className="labels"><Badge tone="blue">app={tab.label}</Badge><Badge>managed-by=helm</Badge><Badge>environment=production</Badge></div></div></aside></>;
}

function BottomActionSheet({ sessions, activeId, collapsed, language, terminalTheme, terminalFont, onActivate, onCloseSession, onCreateSession, onToggleCollapsed }: { sessions: BottomSession[]; activeId: string; collapsed: boolean; language: AppLanguage; terminalTheme: "light" | "dark"; terminalFont: string; onActivate: (id: string) => void; onCloseSession: (id: string) => void; onCreateSession: (request: BottomRequest) => void; onToggleCollapsed: () => void }) {
  const state = sessions.find((session) => session.id === activeId) ?? sessions[0];
  const [height, setHeight] = useState(() => Math.max(220, Math.min(window.innerHeight - 64, Number(localStorage.getItem("kubehive.sessionHeight")) || 450)));
  const [maximized, setMaximized] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLElement>(null);
  const resize = useRef<{ startY: number; startHeight: number; currentHeight: number } | null>(null);
  useEffect(() => localStorage.setItem("kubehive.sessionHeight", String(height)), [height]);
  useEffect(() => { const close = (event: MouseEvent) => { if (!addMenuRef.current?.contains(event.target as Node)) setAddMenuOpen(false); }; window.addEventListener("mousedown", close); return () => window.removeEventListener("mousedown", close); }, []);
  useEffect(() => {
    const move = (event: PointerEvent) => { if (!resize.current || !dockRef.current) return; const maximum = Math.max(220, window.innerHeight - 48); const next = Math.max(38, Math.min(maximum, resize.current.startHeight + resize.current.startY - event.clientY)); resize.current.currentHeight = next; dockRef.current.style.height = `${next}px`; };
    const stop = () => { if (!resize.current) return; const finalHeight = resize.current.currentHeight; resize.current = null; setHeight(finalHeight); document.body.classList.remove("resizing-session-sheet"); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop); window.addEventListener("pointercancel", stop);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); window.removeEventListener("pointercancel", stop); document.body.classList.remove("resizing-session-sheet"); };
  }, []);
  if (!state) return null;
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => { event.preventDefault(); event.stopPropagation(); const currentHeight = collapsed ? 38 : dockRef.current?.getBoundingClientRect().height ?? height; if (collapsed) { setHeight(38); onToggleCollapsed(); } setMaximized(false); resize.current = { startY: event.clientY, startHeight: currentHeight, currentHeight }; document.body.classList.add("resizing-session-sheet"); };
  const sessionTitle = (session: BottomSession) => `${session.mode === "terminal" ? "Terminal" : session.mode === "logs" ? "Logs" : session.mode === "edit" ? "Edit" : "Create"} · ${session.label ?? session.item?.label ?? "cluster"}`;
  const terminalOption = language === "en" ? "New terminal session" : language === "zh-TW" ? "新增終端工作階段" : "新建终端会话";
  const resourceOption = language === "en" ? "Create resource" : language === "zh-TW" ? "建立資源" : "创建资源";
  const manifest = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: checkout-api\n  namespace: commerce\nspec:\n  replicas: 12\n  selector:\n    matchLabels:\n      app: checkout-api`;
  return <section ref={dockRef} className={cn("sheet sheet-bottom session-dock", collapsed && "collapsed", maximized && "maximized", (state.mode === "logs" || state.mode === "terminal") && `terminal-theme-${terminalTheme}`)} style={collapsed ? undefined : {height: maximized ? window.innerHeight - 42 : height}}><div className="sheet-resize-edge horizontal" aria-label="Resize sessions" role="separator" aria-orientation="horizontal" onPointerDown={startResize}/><header><div className="bottom-session-tabs">{sessions.map((session) => { const Icon = session.mode === "terminal" ? SquareTerminal : session.mode === "logs" ? Play : session.mode === "edit" ? Pencil : Plus; return <button key={session.id} className={cn(session.id === state.id && "active")} onClick={() => onActivate(session.id)}><Icon size={12}/><span>{sessionTitle(session)}</span><i role="button" aria-label={`Close ${sessionTitle(session)}`} onClick={(event) => { event.stopPropagation(); onCloseSession(session.id); }}><X size={10}/></i></button>; })}</div><div className="session-add" ref={addMenuRef}><Button variant="secondary" size="icon" className="session-add-trigger" aria-label="Add session" title="Add session" onClick={() => setAddMenuOpen((value) => !value)}><Plus size={13}/></Button>{addMenuOpen&&<div className="session-add-menu"><button onClick={() => { onCreateSession({mode:"terminal",sessionKey:`terminal-${Date.now()}`,label:language === "en" ? "New session" : language === "zh-TW" ? "新工作階段" : "新会话"}); setAddMenuOpen(false); }}><SquareTerminal size={13}/><span>{terminalOption}</span></button><button onClick={() => { onCreateSession({mode:"create",sessionKey:`resource-${Date.now()}`,label:resourceOption}); setAddMenuOpen(false); }}><Plus size={13}/><span>{resourceOption}</span></button></div>}</div><div/><Button variant="ghost" size="icon" aria-label={maximized ? "Restore sessions" : "Maximize sessions"} onClick={() => { if (collapsed) onToggleCollapsed(); setMaximized((value) => !value); }}>{maximized?<Minimize2 size={14}/>:<Maximize2 size={14}/>}</Button><Button variant="ghost" size="icon" aria-label={collapsed ? "Expand sessions" : "Collapse sessions"} onClick={onToggleCollapsed}><ChevronDown className={cn(collapsed && "rotate-180")} size={15}/></Button></header>{!collapsed && <>{(state.mode === "edit" || state.mode === "create") && <div className="editor-layout"><div className="editor-gutter">1<br/>2<br/>3<br/>4<br/>5<br/>6<br/>7<br/>8<br/>9</div><pre contentEditable suppressContentEditableWarning>{manifest}</pre><aside><h3>Manifest</h3><span>Schema valid</span><Badge tone="green">No errors</Badge></aside></div>}{state.mode === "logs" && <div className="terminal-output" style={{fontFamily:terminalFont}}><div><Badge tone="green">LIVE</Badge><span>container: api · {state.item?.label}</span></div><pre>2026-07-26T15:10:41Z INFO request completed method=GET path=/health status=200 latency=4ms{"\n"}2026-07-26T15:10:43Z INFO payment authorized order=ord_8142 provider=stripe{"\n"}2026-07-26T15:10:46Z WARN retrying upstream service=inventory attempt=2</pre></div>}{state.mode === "terminal" && <div className="terminal-output" style={{fontFamily:terminalFont}}><pre><span>{state.item?.subtitle ?? "cluster"}/{state.item?.label ?? "shell"} $</span> kubectl get pods{"\n"}NAME                              READY   STATUS    RESTARTS{"\n"}payment-worker-7b68b9c74c-x2rnl  1/1     Running   0{"\n"}<span>{state.item?.subtitle ?? "cluster"}/{state.item?.label ?? "shell"} $</span> _</pre></div>}<footer><span>{state.mode === "logs" ? "Streaming · 42 lines" : "Session stays available while you navigate"}</span><div/>{(state.mode === "edit" || state.mode === "create") && <Button size="sm">Apply</Button>}</footer></>}</section>;
}

function AlertsDialog({ onClose }: { onClose: () => void }) { return <div className="modal-backdrop panel-dialog-backdrop" onMouseDown={onClose}><section className="alerts-modal" onMouseDown={(event)=>event.stopPropagation()}><div className="dialog-header"><h2>Alerts</h2><Badge tone="amber">2 active</Badge><div/><Button variant="ghost" size="icon" aria-label="Close alerts" onClick={onClose}><X size={15}/></Button></div><div className="drawer-events">{events.slice(0,2).map((event,index) => <div key={index}><AlertTriangle size={14}/><div><strong>{event.reason}</strong><span>{event.message}</span><small>{event.time} ago · {event.object}</small></div></div>)}</div><footer><span>Showing active warnings</span><Button variant="outline" size="sm" onClick={onClose}>Close</Button></footer></section></div> }

function SettingsSheet({ preferences, onChange, onClose }: { preferences: Preferences; onChange: (next: Preferences) => void; onClose: () => void }) {
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const language = preferences.language;
  const update = <K extends keyof Preferences>(key: K, value: Preferences[K]) => onChange({ ...preferences, [key]: value });
  const themeLabels = language === "en" ? ["Follow system", "Light", "Dark"] : language === "zh-TW" ? ["跟隨系統", "淺色", "深色"] : ["跟随系统", "浅色", "深色"];
  const terminalThemeLabels = language === "en" ? ["Follow application", "Dark", "Light"] : language === "zh-TW" ? ["跟隨應用程式主題", "深色", "淺色"] : ["跟随应用主题", "深色", "浅色"];
  return <div className="modal-backdrop panel-dialog-backdrop" onMouseDown={onClose}><section className="settings-modal" onMouseDown={(event)=>event.stopPropagation()}><div className="settings-header"><h2>{t(language, "settings")}</h2><div/><Button variant="ghost" size="icon" aria-label="Close settings" onClick={onClose}><X size={15}/></Button></div><div className="settings-scroll">
    <section className="settings-section"><div className="settings-section-title"><Globe2 size={15}/><div><h3>{t(language, "application")}</h3><p>Language and visual appearance</p></div></div><div className="settings-card"><div className="settings-row"><span><strong>{t(language, "language")}</strong><small>Changes are applied immediately</small></span><Combobox value={preferences.language} onChange={(value) => update("language", value as AppLanguage)} options={[{value:"en",label:"English"},{value:"zh-CN",label:"简体中文"},{value:"zh-TW",label:"繁體中文"}]}/></div><div className="settings-row"><span><strong>{t(language, "theme")}</strong><small>Use system appearance or override it</small></span><Combobox value={preferences.theme} onChange={(value) => update("theme", value as Preferences["theme"])} options={["system","light","dark"].map((value,index)=>({value,label:themeLabels[index]}))}/></div></div></section>
    <section className="settings-section"><div className="settings-section-title"><Type size={15}/><div><h3>{t(language, "terminal")}</h3><p>Shared by container terminals and log viewers</p></div></div><div className="settings-card"><div className="settings-row"><span><strong>{t(language, "terminalTheme")}</strong><small>Terminal colors can be independent</small></span><Combobox value={preferences.terminalTheme} onChange={(value) => update("terminalTheme", value as TerminalTheme)} options={["system","dark","light"].map((value,index)=>({value,label:terminalThemeLabels[index]}))}/></div><div className="settings-row"><span><strong>{t(language, "terminalFont")}</strong><small>Monospaced fonts installed on this system</small></span><Combobox value={preferences.terminalFont} onChange={(value) => update("terminalFont", value)} options={["monospace","JetBrains Mono","SFMono-Regular","Cascadia Code","Fira Code","IBM Plex Mono"].map((value)=>({value,label:value}))}/></div></div></section>
    <section className="settings-section"><div className="settings-section-title"><Wifi size={15}/><div><h3>{t(language, "proxy")}</h3><p>Proxy for application and cluster traffic</p></div></div><div className="settings-card"><div className="settings-row"><span><strong>{t(language, "proxy")}</strong><small>HTTP, HTTPS and SOCKS5 are supported</small></span><ToggleSwitch label="Enable proxy" checked={preferences.proxyEnabled} onChange={(value)=>update("proxyEnabled",value)}/></div>{preferences.proxyEnabled&&<div className="settings-input-row"><span>Proxy URL</span><input value={preferences.proxyUrl} onChange={(event)=>update("proxyUrl",event.target.value)} placeholder="http://127.0.0.1:7890"/></div>}</div></section>
    <section className="settings-section"><div className="settings-section-title"><Download size={15}/><div><h3>{t(language, "updates")}</h3><p>{checked ? t(language,"upToDate") : "Version 0.1.0 · stable channel"}</p></div><Button variant="outline" size="sm" disabled={checking} onClick={()=>{setChecking(true);setChecked(false);window.setTimeout(()=>{setChecking(false);setChecked(true);},800);}}>{checking?<LoaderCircle className="spin" size={13}/>:checked?<CheckCircle2 size={13}/>:<RefreshCw size={13}/>} {t(language,"checkUpdates")}</Button></div><div className="settings-card"><div className="settings-row"><span><strong>{t(language, "autoUpdate")}</strong><small>Download and install updates in the background</small></span><ToggleSwitch label="Automatic updates" checked={preferences.autoUpdate} onChange={(value)=>update("autoUpdate",value)}/></div></div></section>
  </div></section></div>;
}

function AddClusterDialog({ language, onClose, onAdd }: { language: AppLanguage; onClose: () => void; onAdd: (name: string) => void }) {
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
  const suggested = clusterName.trim() || fileName.replace(/\.(yaml|yml|config)$/i, "") || "imported-cluster";
  const addDisabled = mode === "file" ? !fileName && !clusterName.trim() : mode === "paste" ? !kubeconfig.trim() : !server.startsWith("http");
  const focusMode = (nextMode: (typeof methods)[number]["id"]) => {
    setMode(nextMode);
    window.requestAnimationFrame(() => document.getElementById(`add-cluster-tab-${nextMode}`)?.focus());
  };

  return <div className="modal-backdrop add-cluster-backdrop" onMouseDown={onClose}>
    <div className="add-cluster-dialog" onMouseDown={(event) => event.stopPropagation()}>
      <header><h2>{t(language,"addCluster")}</h2><div/><Button variant="ghost" size="icon" aria-label="Close add cluster" onClick={onClose}><X size={15}/></Button></header>
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
          ><Icon size={13}/><span>{label}</span></button>)}
        </div>
      </div>
      <div id="add-cluster-mode-panel" className="add-cluster-body" role="tabpanel" aria-labelledby={`add-cluster-tab-${mode}`}>
        <label className="field-label"><span>Display name <small>Optional</small></span><input value={clusterName} onChange={(event) => setClusterName(event.target.value)} placeholder="e.g. production-eu"/></label>
        {mode === "file" && <label className="file-drop"><input type="file" accept=".yaml,.yml,.config" onChange={(event) => setFileName(event.target.files?.[0]?.name ?? "")}/><Upload size={22}/><strong>{fileName || "Drop kubeconfig here"}</strong><span>{fileName ? "Ready to import" : "or click to choose a file"}</span></label>}
        {mode === "paste" && <label className="field-label"><span>Kubeconfig YAML</span><textarea value={kubeconfig} onChange={(event) => setKubeconfig(event.target.value)} placeholder={'apiVersion: v1\nclusters:\n  - cluster: ...'}/></label>}
        {mode === "manual" && <><label className="field-label"><span>API server URL</span><input value={server} onChange={(event) => setServer(event.target.value)} placeholder="https://kubernetes.example.com:6443"/></label><label className="field-label"><span>Bearer token</span><textarea rows={3} placeholder="eyJhbGciOiJSUzI1NiIs..."/></label></>}
        <div className="import-note"><ShieldCheck size={14}/><span>Credentials remain encrypted on this device and are never uploaded.</span></div>
      </div>
      <footer><span>{mode === "file" ? "Supports standard kubeconfig files" : "Connection will be validated before saving"}</span><div/><Button variant="outline" size="sm" onClick={onClose}>{t(language,"cancel")}</Button><Button size="sm" disabled={addDisabled} onClick={() => onAdd(suggested)}>{t(language,"add")}</Button></footer>
    </div>
  </div>;
}

function CommandPalette({ onClose, onNavigate }: { onClose: () => void; onNavigate: (item: string) => void }) { const commands=["Go to Pods","Go to Deployments","Go to Custom Resource Definitions","Open cluster terminal","Create resource"]; return <div className="modal-backdrop" onMouseDown={onClose}><div className="command-modal" onMouseDown={(event)=>event.stopPropagation()}><div className="command-input"><Search size={17}/><input autoFocus placeholder="Search resources and run commands…"/><kbd>ESC</kbd></div><p>QUICK ACTIONS</p>{commands.map((command)=><button key={command} onClick={()=>{if(command.startsWith("Go to "))onNavigate(command.replace("Go to ",""));onClose();}}><span className="command-key"><Command size={14}/></span>{command}<kbd>↵</kbd></button>)}</div></div>; }

export default function App() {
  useAutoHideScrollbars();
  const [availableClusters, setAvailableClusters] = useState<Cluster[]>(initialClusters);
  const [cluster, setCluster] = useState(initialClusters[0]);
  const [namespace, setNamespace] = useState("All namespaces");
  const [navOpen, setNavOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addClusterOpen, setAddClusterOpen] = useState(false);
  const [tabs, setTabs] = useState<ResourceTab[]>([{ id: "overview", label: "Overview", resource: "Overview" }]);
  const [activeTabId, setActiveTabId] = useState("overview");
  const [detail, setDetail] = useState<DetailItem | null>(null);
  const [bottomSessions, setBottomSessions] = useState<BottomSession[]>([]);
  const [activeBottomId, setActiveBottomId] = useState("");
  const [bottomCollapsed, setBottomCollapsed] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [resolvedTheme, setResolvedTheme] = useState<"light"|"dark">("dark");
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

  const openResourcePage = (nextResource: string, crdKind?: string) => {
    const id = crdKind ? `crd/${crdKind}` : `resource/${nextResource.toLowerCase().replaceAll(" ", "-")}`;
    const nextTab: ResourceTab = { id, label: crdKind ?? nextResource, resource: nextResource, crdKind };
    setTabs((current) => current.some((tab) => tab.id === id) ? current : [...current, nextTab]);
    setActiveTabId(id); setDetail(null);
  };
  const openWorkload = (item: Workload) => setDetail({ id: `${item.namespace}/${item.name}`, label: item.name, subtitle: item.namespace, type: "resource", workload: item });
  const openCrd = (item: CustomResource, kind: string) => setDetail({ id: `crd/${kind}/${item.namespace}/${item.name}`, label: item.name, subtitle: item.namespace, type: "crd", crd: item, kind });
  const openBottomSession = (request: BottomRequest) => {
    const id = `${request.mode}:${request.sessionKey ?? request.item?.id ?? (request.mode === "create" ? activeTabId : "cluster")}`;
    const session: BottomSession = { ...request, id };
    setBottomSessions((current) => current.some((item) => item.id === id) ? current : [...current, session]);
    setActiveBottomId(id); setBottomCollapsed(false);
  };
  const closeBottomSession = (id: string) => setBottomSessions((current) => {
    const index = current.findIndex((session) => session.id === id);
    const next = current.filter((session) => session.id !== id);
    if (activeBottomId === id) setActiveBottomId(next[Math.max(0, index - 1)]?.id ?? next[0]?.id ?? "");
    if (!next.length) setBottomCollapsed(false);
    return next;
  });
  const closeTab = (id: string) => setTabs((current) => {
    if (id === "overview") return current;
    const index = current.findIndex((tab) => tab.id === id);
    const next = current.filter((tab) => tab.id !== id);
    if (activeTabId === id) setActiveTabId(next[Math.max(0, index - 1)]?.id ?? next[0].id);
    setDetail(null); return next;
  });
  const addCluster = (name: string) => {
    const next: Cluster = { id: `imported-${Date.now()}`, name, provider: "Local", region: "kubeconfig", version: "v1.31.4", status: "healthy", nodes: 3, cpu: 18, memory: 34 };
    setAvailableClusters((current) => [...current, next]); setCluster(next); setAddClusterOpen(false);
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setCommandOpen(true); }
      if (event.key === "Escape") { setCommandOpen(false); setDetail(null); setBottomCollapsed(true); setAlertsOpen(false); setSettingsOpen(false); setAddClusterOpen(false); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return <div className={cn("app-shell", `platform-${platform}`)}>
    <ClusterRail clusters={availableClusters} active={cluster} onSelect={(next) => { setCluster(next); setDetail(null); }} onAlerts={() => setAlertsOpen(true)} onSettings={() => { setSettingsOpen(true); setDetail(null); }} onAdd={() => setAddClusterOpen(true)}/>
    <ResourceNav active={resource} cluster={cluster} language={language} onSelect={openResourcePage} open={navOpen} onClose={() => setNavOpen(false)}/>
    <main className="main-area">
      <WorkspaceTabs tabs={tabs} activeId={activeTabId} language={language} onActivate={(id) => { setActiveTabId(id); setDetail(null); }} onClose={closeTab} onMenu={() => setNavOpen(true)} onCommand={() => setCommandOpen(true)}/>
      {resource === "Overview"
        ? <Overview cluster={cluster} language={language} onWorkload={openWorkload} onTerminal={() => openBottomSession({ mode: "terminal" })}/>
        : resource === "Custom Resource Definitions"
          ? <CrdBrowser selectedKind={activeTab.crdKind ?? null} namespace={namespace} setNamespace={setNamespace} language={language} onKindSelect={(definition) => openResourcePage("Custom Resource Definitions", definition.kind)} onBack={() => openResourcePage("Custom Resource Definitions")} onInstance={openCrd} onCreate={() => openBottomSession({ mode: "create" })}/>
          : <ResourceTable resource={resource} namespace={namespace} setNamespace={setNamespace} language={language} onSelect={openWorkload} onCreate={() => openBottomSession({ mode: "create" })}/>}
    </main>
    {detail && <DetailSheet tab={detail} onClose={() => setDetail(null)} onAction={(request) => { openBottomSession(request); setDetail(null); }}/>}
    {bottomSessions.length > 0 && <BottomActionSheet sessions={bottomSessions} activeId={activeBottomId} collapsed={bottomCollapsed} language={language} terminalTheme={terminalAppearance} terminalFont={preferences.terminalFont} onActivate={(id) => { setActiveBottomId(id); setBottomCollapsed(false); }} onCloseSession={closeBottomSession} onCreateSession={openBottomSession} onToggleCollapsed={() => setBottomCollapsed((value) => !value)}/>}
    {alertsOpen && <AlertsDialog onClose={() => setAlertsOpen(false)}/>}
    {settingsOpen && <SettingsSheet preferences={preferences} onChange={setPreferences} onClose={() => setSettingsOpen(false)}/>}
    {addClusterOpen && <AddClusterDialog language={language} onClose={() => setAddClusterOpen(false)} onAdd={addCluster}/>}
    {commandOpen && <CommandPalette onClose={() => setCommandOpen(false)} onNavigate={openResourcePage}/>}
  </div>;
}
