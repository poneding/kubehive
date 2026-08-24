import { Badge, Button, Progress, ScrollArea } from "@/components/ui";
import { cn } from "@/lib/utils";
import { openPath } from "@tauri-apps/plugin-opener";
import { Activity, AlertTriangle, Box, ChevronRight, CircleDot, Cpu, HardDrive, Hexagon, Info, LoaderCircle, MoreHorizontal, Plus, Power, RefreshCw, SquareTerminal, Wifi, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { backend, descriptorForResource, nativeBackendAvailable, type ClusterOverview as LiveClusterOverview } from "../backend";
import { openContextMenu } from "../context-menu";
import { clusterAccent, clusterConnectionStatus, type Cluster } from "../data";
import { tr } from "../i18n";
import { rowFromBackend } from "../k8s-adapter";
import { t, type AppLanguage } from "../preferences";
import type { ResourceRow } from "../resource-catalog";
import { statusTone } from "../status";
import { VirtualResourceTable, type VirtualTableColumn } from "../table-extras";
import { StatusDot, WorkspaceScroll } from "./app-controls";
import { clusterActionMenuItems } from "./cluster-rail";
import { requestClusterProbe } from "./app-state";
import { TableSearchField, useResourceListFindShortcut, useTableSearchFocus, useToolbarPinned, type TableSearchHandle } from "./table-search";
import type { AppToast, ClusterConnectionState } from "./types";
import { WindowControls } from "./window-chrome";

function ClusterActionsMenu({ cluster, language, busy, onConnect, onCloseConnection, onSettings, onRemove }: { cluster: Cluster; language: AppLanguage; busy: boolean; onConnect: () => void; onCloseConnection: () => void; onSettings: () => void; onRemove: () => void }) {
  const actions = clusterActionMenuItems({ cluster, language, busy, onConnect, onCloseConnection, onSettings, onRemove });
  return <div className="cluster-actions" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
    <Button type="button" variant="ghost" size="icon" title={t(language, "actions")} aria-label={`${t(language, "actions")} ${cluster.name}`} aria-haspopup="menu" onClick={(event) => openContextMenu(event, actions)}><MoreHorizontal size={15} /></Button>
  </div>;
}

type ClusterListRow = ResourceRow & { source: Cluster };

function openKubeconfigInEditor(filePath: string, onToast: (tone: AppToast["tone"], message: string) => void) {
  // Open with the platform's built-in default text editor so extensionless
  // kubeconfig files open as text rather than hitting “no application”.
  const editor = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "TextEdit" : /Win/.test(navigator.userAgent) ? "notepad" : undefined;
  void openPath(filePath, editor)
    .then(() => onToast("success", `Opened ${filePath}`))
    .catch((error) => onToast("error", `Unable to open kubeconfig: ${String(error)}`));
}

function ClusterHome({ clusters, language, busyClusterId, onConnect, onCloseConnection, onSettings, onRemove, onAdd, onToast }: { clusters: Cluster[]; language: AppLanguage; busyClusterId: string | null; onConnect: (cluster: Cluster) => void; onCloseConnection: (cluster: Cluster) => void; onSettings: (cluster: Cluster) => void; onRemove: (cluster: Cluster) => void; onAdd: () => void; onToast: (tone: AppToast["tone"], message: string) => void }) {
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
  const rows = useMemo((): ClusterListRow[] => filtered.map((item) => {
    const connectionStatus = clusterConnectionStatus(item);
    return {
      key: item.id,
      name: item.name,
      namespace: "—",
      kind: "Cluster",
      status: connectionStatus,
      data: {
        provider: item.provider,
        location: item.region,
        kubeconfig: item.sourcePath || "—",
        version: item.version,
        connection: connectionStatus,
      },
      source: item,
    };
  }), [filtered]);
  const columns = useMemo((): VirtualTableColumn<ClusterListRow>[] => [
    {
      id: "name",
      label: t(language, "cluster"),
      sortValue: (row) => row.name,
      render: (row) => <div className="cluster-home-identity"><button type="button" className="cluster-home-avatar" aria-label={`${row.source.disconnected ? t(language, "connect") : t(language, "openOverview")} ${row.name}`} style={{ ["--cluster-accent" as string]: clusterAccent(row.source) }} onClick={(event) => { event.stopPropagation(); if (busyClusterId !== row.source.id) onConnect(row.source); }}>{row.name.slice(0, 2).toUpperCase()}<StatusDot status={clusterConnectionStatus(row.source)} /></button><div><strong>{row.name}</strong><small>{row.source.context || row.source.server || row.source.id}</small></div></div>,
    },
    { id: "provider", label: t(language, "provider"), sortValue: (row) => row.source.provider, render: (row) => row.source.provider },
    { id: "server", label: "APIServer", sortValue: (row) => row.source.server, render: (row) => <span className="cluster-home-server" title={row.source.server}>{row.source.server || "—"}</span> },
    { id: "kubeconfig", label: tr(language, "kubeconfigPath"), sortValue: (row) => row.source.sourcePath || "", render: (row) => row.source.sourcePath ? <button type="button" className="cluster-home-kubeconfig cluster-home-kubeconfig-open font-mono" title={row.source.sourcePath} onClick={(event) => { event.stopPropagation(); openKubeconfigInEditor(row.source.sourcePath!, onToast); }} onDoubleClick={(event) => event.stopPropagation()}>{row.source.sourcePath}</button> : <span className="cluster-home-kubeconfig font-mono">—</span> },
    { id: "version", label: t(language, "version"), sortValue: (row) => row.source.version, render: (row) => <span className="cluster-home-version font-mono">{row.source.version}</span> },
    {
      id: "connection",
      label: t(language, "status"),
      sortValue: (row) => Number(!row.source.disconnected),
      render: (row) => {
        const connectionStatus = clusterConnectionStatus(row.source);
        return <Badge tone={statusTone(connectionStatus)}><StatusDot status={connectionStatus} />{t(language, connectionStatus)}</Badge>;
      },
    },
  ], [busyClusterId, language, onConnect]);
  return <main className="home-main">
    <div className="home-titlebar titlebar-chrome">
      <div className="home-titlebar-drag" data-tauri-drag-region aria-hidden="true" />
      <WindowControls language={language} />
    </div>
    <ScrollArea className="cluster-home-scroll-area" viewportClassName="cluster-home-scroll" scrollbars="both"><div className="cluster-home">
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
    </div></ScrollArea>
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
  return <WorkspaceScroll><div className="page-head overview-page-head"><div><div className="eyebrow">{tr(language, "clusterOverview")}</div><h1>{cluster.name}</h1><p>{error || `Kubernetes ${snapshot?.version ?? cluster.version} · ${snapshot?.nodes ?? cluster.nodes} nodes · ${loading ? tr(language, "updating") : tr(language, "updatedJustNow")}`}</p></div><div className="head-actions"><Button variant="outline" size="sm" disabled={loading || !nativeBackendAvailable} onClick={() => setReloadToken((value) => value + 1)}><RefreshCw className={cn(loading && "spin")} size={13} />{t(language, "refresh")}</Button><Button size="sm" disabled={!nativeBackendAvailable} onClick={onTerminal}><SquareTerminal size={13} />{tr(language, "openShell")}</Button></div></div>
    <div className="metrics-grid"><MetricCard label="CPU" value={String(cpu)} unit="%" percentage={cpu} tone={cpu > 75 ? "amber" : "green"} sub={snapshot?.cpuPercent == null ? tr(language, "metricsApiUnavailable") : tr(language, "liveNodeUsage")} icon={Cpu} language={language} /><MetricCard label={tr(language, "memory")} value={String(memory)} unit="%" percentage={memory} sub={snapshot?.memoryPercent == null ? tr(language, "metricsApiUnavailable") : tr(language, "liveNodeUsage")} icon={Activity} language={language} /><MetricCard label="Pods" value={String(podCount)} unit={`/ ${podCapacity}`} percentage={podCapacity ? Math.min(100, Math.round((podCount / podCapacity) * 100)) : 0} sub={`${runningPods} ${tr(language, "running")}`} icon={Box} language={language} /><MetricCard label="Storage" value={storageTiB.toFixed(1)} unit="TiB" percentage={storagePercent} tone={storagePercent > 75 ? "amber" : "green"} sub={tr(language, "boundPersistentVolumes")} icon={HardDrive} language={language} /></div>
    <div className="overview-grid"><section className="panel"><div className="panel-head"><div><h2>{tr(language, "workloadHealth")}</h2><p>{tr(language, "acrossAllNamespaces")}</p></div><Button variant="ghost" size="sm" onClick={() => onNavigate("Deployments")}>{tr(language, "viewAll")} <ChevronRight size={12} /></Button></div><div className="health-chart"><div className="donut"><div><strong>{health.total}</strong><span>{tr(language, "workloads")}</span></div></div><div className="health-legend"><div><span><i className="green" />{tr(language, "healthy")}</span><strong>{health.healthy}</strong></div><div><span><i className="amber" />{tr(language, "degraded")}</span><strong>{health.degraded}</strong></div><div><span><i className="red" />{tr(language, "failed")}</span><strong>{health.failed}</strong></div></div></div></section><section className="panel"><div className="panel-head"><div><h2>Nodes</h2><p>{snapshot?.nodes ?? cluster.nodes} {tr(language, "connected")}</p></div><Badge tone={(snapshot?.readyNodes ?? 0) === (snapshot?.nodes ?? 0) ? "green" : "amber"}>{snapshot ? `${snapshot.readyNodes}/${snapshot.nodes} ${tr(language, "ready")}` : `0 ${tr(language, "ready")}`}</Badge></div><div className="node-bars">{nodeValues.map((v, i) => <div key={snapshot?.nodeUsage[i]?.name ?? i}><span style={{ height: `${v}%` }} className={v > 78 ? "hot" : ""} /></div>)}</div><div className="node-axis"><span>{snapshot?.nodeUsage[0]?.name ?? "—"}</span><span>{tr(language, "cpuUtilization")}</span><span>{snapshot?.nodeUsage.at(-1)?.name ?? "—"}</span></div></section></div>
    <section className="panel issues-panel"><div className="panel-head"><div><h2>{tr(language, "needsAttention")}</h2><p>{tr(language, "alerts")}</p></div><Badge tone="amber">{liveIssues.length} {tr(language, "active")}</Badge></div><div className="compact-list">{liveIssues.map((item) => <button key={item.key} onClick={() => onResource(item)}><StatusDot status={item.status ?? "Pending"} /><div><strong>{item.name}</strong><span>{item.namespace} · {item.kind}</span></div><Badge tone="amber">{item.status}</Badge><span>{item.data.containers ?? "—"} ready</span><ChevronRight size={14} /></button>)}</div></section>
    <section className="panel events-panel"><div className="panel-head"><div><h2>{tr(language, "recentEvents")}</h2><p>{tr(language, "liveClusterActivity")}</p></div><div className="live-label"><i />{tr(language, "live")}</div></div><div className="event-list">{liveEvents.map((event, index) => <div key={`${event.object}-${index}`}><span className={cn("event-icon", event.level)}>{event.level === "warning" ? <AlertTriangle size={13} /> : <CircleDot size={13} />}</span><div><strong>{event.reason}</strong><span>{event.message}</span><small>{event.object}</small></div><time>{event.time}</time></div>)}</div></section>
  </WorkspaceScroll>;
}

export { ClusterConnectionPage, ClusterHome, Overview };
