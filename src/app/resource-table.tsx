import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import { Droplets, FolderOpen, Info, LogOut, MoreHorizontal, Network, PaintBucket, Pause, Pencil, Play, Plus, RefreshCw, Scaling, ScrollText, Square, SquareTerminal, Trash2, Zap } from "lucide-react";
import { useDeferredValue, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { nativeBackendAvailable, type ApiResourceDescriptor } from "../backend";
import { ColumnPicker, useVisibleColumns } from "../column-picker";
import { NamespaceMultiCombobox } from "../combobox";
import { openContextMenu } from "../context-menu";
import { tr } from "../i18n";
import { resourceLabel, t, type AppLanguage } from "../preferences";
import type { ResourceLink, ResourceRow } from "../resource-catalog";
import { VirtualResourceTable, type VirtualTableColumn } from "../table-extras";
import { WorkspaceScroll } from "./app-controls";
import { apiNamespaceFilter, clusterScopedResources, matchesNamespaceFilter, nonAuthorableResources } from "./app-state";
import { BulkResourceActionDialog, BulkResourceToolbar, useBulkResourceActions } from "./bulk-resource-actions";
import { forwardablePortsFor } from "./port-forward";
import { renderResourceCell } from "./resource-cells";
import { useResourceRows } from "./resource-data";
import { resourceSearchText, TableSearchField, useResourceListFindShortcut, useTableSearchFocus, useToolbarPinned, type TableSearchHandle } from "./table-search";

function ResourceTable({ clusterId, discovered, namespaces, revision, resource, selectedNamespaces, setSelectedNamespaces, language, onSelect, onOpenLink, onCreate, onRowAction, onCopy, onOpenPortForward }: {
  clusterId: string; discovered: ApiResourceDescriptor[]; namespaces: string[]; revision: number; resource: string; selectedNamespaces: string[];
  setSelectedNamespaces: (value: string[]) => void; language: AppLanguage; onSelect: (item: ResourceRow) => void;
  onOpenLink: (link: ResourceLink, row: ResourceRow) => void; onCreate: (descriptor?: ApiResourceDescriptor | null) => void;
  onRowAction: (action: string, row: ResourceRow) => void; onCopy?: (value: string, label?: string) => void; onOpenPortForward?: (row: ResourceRow) => void;
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
    render: (item) => renderResourceCell(column.id, item, onOpenLink, language, onCopy, onOpenPortForward),
  })), [visible, onOpenLink, language, onCopy, onOpenPortForward]);
  const createSupported = !nonAuthorableResources.has(resource);
  const canCreate = createSupported && nativeBackendAvailable && Boolean(live.descriptor?.verbs.includes("create"));
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
  const hasVisibleBulkResourceActions = bulkActions.enabled && (bulkActions.selectedRows.length > 0 || Boolean(bulkActions.feedback));
  const rowMenu = (event: ReactMouseEvent, item: ResourceRow) => {
    if (item.kind === "PortForward") {
      // Local forward sessions are not Kubernetes objects: the menu only
      // carries the pause/resume and stop controls shown inline in the row.
      openContextMenu(event, [
        item.status === "Paused"
          ? { type: "item" as const, id: "resume-port-forward", label: tr(language, "resumeForwarding"), icon: Play, onSelect: () => onRowAction("Resume Port Forward", item) }
          : { type: "item" as const, id: "pause-port-forward", label: tr(language, "pauseForwarding"), icon: Pause, onSelect: () => onRowAction("Pause Port Forward", item) },
        { type: "item" as const, id: "stop-port-forward", label: tr(language, "stopForwarding"), icon: Square, hoverDestructive: true, onSelect: () => onRowAction("Stop Port Forward", item) },
      ]);
      return;
    }
    const workload = ["Pod", "Deployment", "StatefulSet", "DaemonSet"].includes(item.kind);
    const isNode = item.kind === "Node";
    const nodeUnschedulable = isNode ? Boolean((item.backend?.object as { spec?: { unschedulable?: boolean } } | undefined)?.spec?.unschedulable) : false;
    const cronJobSuspended = item.kind === "CronJob" ? Boolean((item.backend?.object as { spec?: { suspend?: boolean } } | undefined)?.spec?.suspend) : false;
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
      ...(item.kind === "CronJob" ? [
        { type: "item" as const, id: "trigger", label: tr(language, "triggerCronJob"), icon: Zap, onSelect: () => onRowAction("Trigger", item) },
        cronJobSuspended
          ? { type: "item" as const, id: "resume-cronjob", label: tr(language, "resumeCronJob"), icon: Play, onSelect: () => onRowAction("Resume", item) }
          : { type: "item" as const, id: "suspend-cronjob", label: tr(language, "suspendCronJob"), icon: Pause, onSelect: () => onRowAction("Suspend", item) },
      ] : []),
      { type: "separator" },
      { type: "item" as const, id: "delete", label: tr(language, "delete"), icon: Trash2, hoverDestructive: true, disabled: item.kind === "HelmRelease" || (nativeBackendAvailable && !item.descriptor?.verbs.includes("delete")), onSelect: () => onRowAction("Delete", item) },
    ]);
  };
  return <><WorkspaceScroll>
    <div className="page-head"><div><div className="eyebrow">KUBERNETES RESOURCES</div><h1>{resourceLabel(language, resource)}</h1><p>{live.loading ? tr(language, "loadingFromApi") : live.error ? live.error : `${filtered.length} ${tr(language, "resources")} · ${live.syncMode === "watch" ? tr(language, "liveUpdates") : live.syncMode === "poll" ? resource === "Port Forwarding" ? tr(language, "updatedEvery", { seconds: 3 }) : tr(language, "updatedEvery", { seconds: 15 }) : live.syncMode === "manual" ? tr(language, "refreshOnDemand") : tr(language, "nativeAppRequired")}`}</p></div><div className="head-actions">{createSupported && <Button size="sm" disabled={!canCreate} onClick={() => onCreate(live.descriptor)}><Plus size={13} />{t(language, "create")}</Button>}</div></div>
    <div className="resource-list-block">
      <div ref={toolbarRef} className={cn("table-toolbar", toolbarPinned && "pinned")}>{!clusterScoped && <NamespaceMultiCombobox className="table-namespace-combobox" language={language} values={selectedNamespaces} namespaces={namespaces} onChange={setSelectedNamespaces} />}<TableSearchField value={query} onChange={setQuery} handleRef={searchHandleRef} ariaLabel={`${t(language, "searchResources")} ${resourceLabel(language, resource)}`} placeholder={`${t(language, "searchResources")} ${resourceLabel(language, resource)}`} clearLabel={tr(language, "clear")} /><div className="toolbar-spacer" /><BulkResourceToolbar actions={bulkActions} />{hasVisibleBulkResourceActions && <div className="resource-toolbar-divider" aria-hidden="true" />}<Button variant="secondary" size="icon" className="resource-toolbar-refresh" aria-label={t(language, "refresh")} title={tr(language, "reloadLiveData")} onClick={live.reload} disabled={live.loading}><RefreshCw className={cn(live.loading && "spin")} size={13} /></Button></div>
      <div className="resource-table-panel"><VirtualResourceTable rows={filtered} columns={columns} tableKey={`resource:${resource}`} actionWidth={resource === "Port Forwarding" ? 68 : undefined} selectedKeys={bulkActions.enabled ? bulkActions.selectedKeys : undefined} onSelectionChange={bulkActions.enabled ? bulkActions.setSelectedKeys : undefined} headerAction={<ColumnPicker resource={resource} language={language} defs={defs} isVisible={isVisible} onToggle={setColumnVisible} onReset={reset} />} renderAction={(item) => item.kind === "PortForward" ? <div className="row-action-group"><Button variant="ghost" size="icon" aria-label={item.status === "Paused" ? tr(language, "resumeForwarding") : tr(language, "pauseForwarding")} title={item.status === "Paused" ? tr(language, "resumeForwarding") : tr(language, "pauseForwarding")} onClick={() => onRowAction(item.status === "Paused" ? "Resume Port Forward" : "Pause Port Forward", item)}>{item.status === "Paused" ? <Play size={12} /> : <Pause size={12} />}</Button><Button variant="ghost" size="icon" className="hover-destructive" aria-label={tr(language, "stopForwarding")} title={tr(language, "stopForwarding")} onClick={() => onRowAction("Stop Port Forward", item)}><Square size={12} /></Button></div> : <Button variant="ghost" size="icon" aria-label={tr(language, "rowActions")} onClick={(event) => rowMenu(event, item)}><MoreHorizontal size={14} /></Button>} onRowClick={onSelect} onRowContextMenu={rowMenu} empty={!live.loading ? <div className="empty-state"><strong>{live.error ? tr(language, "resourceApiUnavailable") : tr(language, "noResourcesFound")}</strong><span>{live.error || tr(language, "tryAnotherNamespace")}</span></div> : undefined} /></div>
    </div>
  </WorkspaceScroll><BulkResourceActionDialog actions={bulkActions} /></>;
}

export { ResourceTable };
