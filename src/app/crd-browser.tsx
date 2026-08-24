import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import { ChevronRight, Info, MoreHorizontal, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { backend, descriptorForCrdName, descriptorForResource, nativeBackendAvailable, type ApiResourceDescriptor } from "../backend";
import { ColumnPicker, useVisibleColumns } from "../column-picker";
import { NamespaceMultiCombobox } from "../combobox";
import { openContextMenu } from "../context-menu";
import type { CustomResourceDefinition } from "../data";
import { tr } from "../i18n";
import { crdDefinitionFromRecord, valueFromJsonPath } from "../k8s-adapter";
import { t, type AppLanguage } from "../preferences";
import type { ResourceLink, ResourceRow } from "../resource-catalog";
import { VirtualResourceTable, type VirtualTableColumn } from "../table-extras";
import { WorkspaceScroll } from "./app-controls";
import { apiNamespaceFilter, matchesNamespaceFilter } from "./app-state";
import { BulkResourceActionDialog, BulkResourceToolbar, useBulkResourceActions } from "./bulk-resource-actions";
import { renderResourceCell } from "./resource-cells";
import { useResourceRows } from "./resource-data";
import { resourceSearchText, TableSearchField, useResourceListFindShortcut, useTableSearchFocus, useToolbarPinned, type TableSearchHandle } from "./table-search";

function CrdBrowser({ clusterId, discovered, namespaces, revision, selectedDefinitionName, selectedNamespaces, setSelectedNamespaces, language, onKindSelect, onBack, onInstance, onCreate, onRowAction, onOpenLink, onCopy }: {
  clusterId: string; discovered: ApiResourceDescriptor[]; namespaces: string[]; revision: number; selectedDefinitionName: string | null; selectedNamespaces: string[];
  setSelectedNamespaces: (value: string[]) => void; language: AppLanguage; onKindSelect: (crd: CustomResourceDefinition) => void; onBack: () => void;
  onInstance: (row: ResourceRow) => void; onCreate: (descriptor?: ApiResourceDescriptor | null) => void; onRowAction: (action: string, row: ResourceRow) => void;
  onOpenLink: (link: ResourceLink, row: ResourceRow) => void; onCopy?: (value: string, label?: string) => void;
}) {
  // Two separate views, two separate data sets: a custom resource page resolves
  // its own definition, so opening one never lists (and watches) every CRD in
  // the cluster along with its OpenAPI schema.
  if (selectedDefinitionName) {
    return <CustomResourceList clusterId={clusterId} discovered={discovered} namespaces={namespaces} revision={revision} crdName={selectedDefinitionName} selectedNamespaces={selectedNamespaces} setSelectedNamespaces={setSelectedNamespaces} language={language} onBack={onBack} onInstance={onInstance} onCreate={onCreate} onRowAction={onRowAction} onOpenLink={onOpenLink} onCopy={onCopy} />;
  }
  return <CrdDefinitionList clusterId={clusterId} discovered={discovered} revision={revision} language={language} onKindSelect={onKindSelect} onInstance={onInstance} onCreate={onCreate} onCopy={onCopy} />;
}

type CrdDefinitionRecord = ReturnType<typeof crdDefinitionFromRecord>;

/** Everything a custom resource page needs to list and act on its instances. */
type CustomResourceContext = {
  crdName: string;
  kind: string;
  group: string;
  scope: "Namespaced" | "Cluster";
  descriptor: ApiResourceDescriptor;
  printerColumns: CrdDefinitionRecord["printerColumns"];
};

/**
 * Resolves one custom resource kind. Discovery already reports how to reach the
 * instances and which verbs the active credentials hold, so the list renders
 * without waiting; the CRD object is fetched on top of it for the additional
 * printer columns and stays optional, because reading
 * `customresourcedefinitions` is frequently not granted.
 */
function useCustomResourceContext(clusterId: string, crdName: string, discovered: ApiResourceDescriptor[], revision: number): CustomResourceContext | null {
  const [record, setRecord] = useState<CrdDefinitionRecord | null>(null);
  const crdDescriptor = descriptorForResource("Custom Resource Definitions", discovered);
  const served = descriptorForCrdName(crdName, discovered);
  useEffect(() => {
    if (!nativeBackendAvailable || !crdDescriptor) return;
    let cancelled = false;
    backend.getResource({ clusterId, resource: crdDescriptor, name: crdName })
      .then((detail) => { if (!cancelled) setRecord(crdDefinitionFromRecord(detail)); })
      .catch(() => { if (!cancelled) setRecord(null); });
    return () => { cancelled = true; };
  }, [clusterId, crdName, revision, crdDescriptor?.apiVersion]);
  return useMemo(() => {
    // Discovery wins for the descriptor: its verbs mirror the real permissions
    // and its version is the one the API server recommends.
    const descriptor = served ?? record?.descriptor ?? null;
    if (!descriptor) return null;
    return {
      crdName,
      kind: record?.kind ?? descriptor.kind,
      group: record?.group ?? descriptor.group,
      scope: record?.scope ?? (descriptor.namespaced ? "Namespaced" : "Cluster"),
      descriptor,
      printerColumns: (record?.printerColumns ?? []).filter((column) => !["Name", "Namespace", "Status", "Age"].includes(column.name)),
    };
  }, [crdName, served, record]);
}

function CustomResourceList({ clusterId, discovered, namespaces, revision, crdName, selectedNamespaces, setSelectedNamespaces, language, onBack, onInstance, onCreate, onRowAction, onOpenLink, onCopy }: {
  clusterId: string; discovered: ApiResourceDescriptor[]; namespaces: string[]; revision: number; crdName: string; selectedNamespaces: string[];
  setSelectedNamespaces: (value: string[]) => void; language: AppLanguage; onBack: () => void; onInstance: (row: ResourceRow) => void;
  onCreate: (descriptor?: ApiResourceDescriptor | null) => void; onRowAction: (action: string, row: ResourceRow) => void;
  onOpenLink: (link: ResourceLink, row: ResourceRow) => void; onCopy?: (value: string, label?: string) => void;
}) {
  const [query, setQuery] = useState("");
  const searchHandleRef = useRef<TableSearchHandle | null>(null);
  const focusSearch = useTableSearchFocus(searchHandleRef);
  useResourceListFindShortcut(focusSearch);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const toolbarPinned = useToolbarPinned(toolbarRef);
  const context = useCustomResourceContext(clusterId, crdName, discovered, revision);
  const namespaced = context?.scope === "Namespaced";
  const apiNamespace = apiNamespaceFilter(selectedNamespaces) ?? "All namespaces";
  const namespaceKey = selectedNamespaces.length === 0 ? "All namespaces" : selectedNamespaces.slice().sort().join(",");
  const live = useResourceRows(clusterId, `Custom Resource ${crdName}`, apiNamespace, discovered, revision, context?.descriptor);
  const deferredQuery = useDeferredValue(query);
  const filtered = useMemo(() => live.rows.filter((row) => {
    const namespaceOk = !namespaced || matchesNamespaceFilter(row.namespace, selectedNamespaces);
    return namespaceOk && resourceSearchText(row).includes(deferredQuery.toLowerCase());
  }), [live.rows, selectedNamespaces, deferredQuery, namespaced]);
  const { defs, visible, setColumnVisible, reset, isVisible } = useVisibleColumns("Custom Resource");
  const printerColumns = context?.printerColumns ?? [];
  const columns = useMemo<Array<VirtualTableColumn<ResourceRow>>>(() => [
    ...visible.map((column) => ({ id: column.id, label: column.label, render: (item: ResourceRow) => renderResourceCell(column.id, item, onOpenLink, language, onCopy) })),
    ...printerColumns.map((column) => ({ id: column.jsonPath, label: column.name, render: (item: ResourceRow) => item.backend ? valueFromJsonPath(item.backend.object, column.jsonPath) : "—", sortValue: (item: ResourceRow) => item.backend ? valueFromJsonPath(item.backend.object, column.jsonPath) : undefined })),
  ], [visible, printerColumns, onOpenLink, language, onCopy]);
  const bulkActions = useBulkResourceActions({
    clusterId,
    rows: filtered,
    descriptor: context?.descriptor,
    selectionKey: `${clusterId}|custom-resource:${crdName}|${namespaceKey}|${query}`,
    canDelete: nativeBackendAvailable && Boolean(context?.descriptor.verbs.includes("delete")),
    canEvict: false,
    onCompleted: live.reload,
  });
  const hasVisibleBulkResourceActions = bulkActions.enabled && (bulkActions.selectedRows.length > 0 || Boolean(bulkActions.feedback));
  // Custom resources are opaque to KubeHive: the manifest editor and deletion
  // are the two operations that apply to every kind alike.
  const rowMenu = (event: ReactMouseEvent, item: ResourceRow) => openContextMenu(event, [
    { type: "item", id: "open", label: tr(language, "openDetails"), icon: Info, onSelect: () => onInstance(item) },
    { type: "item", id: "edit", label: tr(language, "editManifest"), icon: Pencil, onSelect: () => onRowAction("Edit", item) },
    { type: "separator" },
    { type: "item", id: "delete", label: tr(language, "delete"), icon: Trash2, hoverDestructive: true, disabled: nativeBackendAvailable && !item.descriptor?.verbs.includes("delete"), onSelect: () => onRowAction("Delete", item) },
  ]);
  const kind = context?.kind ?? crdName;
  // Discovery is what makes the kind reachable, so an unresolved context means
  // the cluster no longer serves it (or discovery has not landed yet).
  const resolving = !context && nativeBackendAvailable && discovered.length === 0;
  const error = context ? live.error : "";
  const summary = context
    ? `${crdName} · ${context.scope} · ${filtered.length} ${tr(language, "resources")}`
    : resolving ? tr(language, "loadingFromApi") : tr(language, "customResourceUnavailable", { name: crdName });
  return <><WorkspaceScroll>
    <div className="page-head"><div><div className="eyebrow">CUSTOM RESOURCE{context ? ` · ${context.group}` : ""}</div><h1>{kind}</h1><p>{error || summary}</p></div><div className="head-actions"><Button variant="outline" size="sm" onClick={onBack}>{tr(language, "allCrds")}</Button><Button size="sm" disabled={!context?.descriptor.verbs.includes("create")} onClick={() => onCreate(context?.descriptor)}><Plus size={13} />{t(language, "create")}</Button></div></div>
    <div className="resource-list-block">
      <div ref={toolbarRef} className={cn("table-toolbar", toolbarPinned && "pinned")}>{namespaced && <NamespaceMultiCombobox className="table-namespace-combobox" language={language} values={selectedNamespaces} namespaces={namespaces} onChange={setSelectedNamespaces} />}<TableSearchField value={query} onChange={setQuery} handleRef={searchHandleRef} ariaLabel={`${t(language, "searchResources")} ${kind}`} placeholder={`${t(language, "searchResources")} ${kind}`} clearLabel={tr(language, "clear")} /><div className="toolbar-spacer" /><BulkResourceToolbar actions={bulkActions} />{hasVisibleBulkResourceActions && <div className="resource-toolbar-divider" aria-hidden="true" />}<Button variant="secondary" size="icon" className="resource-toolbar-refresh" aria-label={t(language, "refresh")} title={tr(language, "reloadLiveData")} onClick={live.reload} disabled={live.loading}><RefreshCw className={cn(live.loading && "spin")} size={13} /></Button></div>
      <div className="resource-table-panel"><VirtualResourceTable rows={filtered} columns={columns} tableKey={`custom-resource:${kind}`} selectedKeys={bulkActions.enabled ? bulkActions.selectedKeys : undefined} onSelectionChange={bulkActions.enabled ? bulkActions.setSelectedKeys : undefined} headerAction={<ColumnPicker resource="Custom Resource" language={language} defs={defs} isVisible={isVisible} onToggle={setColumnVisible} onReset={reset} />} renderAction={(item) => <Button variant="ghost" size="icon" aria-label={tr(language, "rowActions")} onClick={(event) => rowMenu(event, item)}><MoreHorizontal size={14} /></Button>} onRowClick={onInstance} onRowContextMenu={rowMenu} empty={!live.loading ? <div className="empty-state"><strong>{tr(language, "noResourcesFound")}</strong><span>{error || (context ? tr(language, "tryAnotherNamespace") : summary)}</span></div> : undefined} /></div>
    </div>
  </WorkspaceScroll><BulkResourceActionDialog actions={bulkActions} /></>;
}

function CrdDefinitionList({ clusterId, discovered, revision, language, onKindSelect, onInstance, onCreate, onCopy }: {
  clusterId: string; discovered: ApiResourceDescriptor[]; revision: number; language: AppLanguage;
  onKindSelect: (crd: CustomResourceDefinition) => void; onInstance: (row: ResourceRow) => void;
  onCreate: (descriptor?: ApiResourceDescriptor | null) => void; onCopy?: (value: string, label?: string) => void;
}) {
  const crdToolbarRef = useRef<HTMLDivElement>(null);
  const crdToolbarPinned = useToolbarPinned(crdToolbarRef);
  const crdDescriptor = descriptorForResource("Custom Resource Definitions", discovered)!;
  const crdLive = useResourceRows(clusterId, "Custom Resource Definitions", "All namespaces", discovered, revision, crdDescriptor);
  const liveDefinitions = crdLive.rows.map((row) => row.backend ? crdDefinitionFromRecord(row.backend) : null).filter(Boolean) as CrdDefinitionRecord[];
  const crdColumns = useVisibleColumns("Custom Resource Definitions");
  const liveDefinitionByName = useMemo(() => new Map(liveDefinitions.map((item) => [item.name, item])), [liveDefinitions]);
  const crdTableColumns = useMemo<Array<VirtualTableColumn<ResourceRow>>>(() => crdColumns.visible.map((column) => ({ id: column.id, label: column.label, render: (row) => renderResourceCell(column.id, row, undefined, language, onCopy) })), [crdColumns.visible, language, onCopy]);
  const crdBulkActions = useBulkResourceActions({
    clusterId,
    rows: crdLive.rows,
    descriptor: crdDescriptor,
    selectionKey: `${clusterId}|resource:Custom Resource Definitions`,
    canDelete: crdDescriptor.verbs.includes("delete"),
    canEvict: false,
    onCompleted: crdLive.reload,
  });
  return <><WorkspaceScroll><div className="page-head"><div><div className="eyebrow">API EXTENSIONS</div><h1>Custom Resource Definitions</h1><p>{crdLive.error || `${liveDefinitions.length} definitions discovered in this cluster`}</p></div><Button size="sm" disabled={!crdDescriptor.verbs.includes("create")} onClick={() => onCreate(crdDescriptor)}><Plus size={13} />Create CRD</Button></div><div className="resource-list-block"><div ref={crdToolbarRef} className={cn("table-toolbar crd-bulk-toolbar", crdToolbarPinned && "pinned")}><span>{crdLive.rows.length} definitions</span><div className="toolbar-spacer" /><BulkResourceToolbar actions={crdBulkActions} /></div><div className="resource-table-panel standalone"><VirtualResourceTable className="standalone" rows={crdLive.rows} columns={crdTableColumns} tableKey="resource:Custom Resource Definitions" selectedKeys={crdBulkActions.enabled ? crdBulkActions.selectedKeys : undefined} onSelectionChange={crdBulkActions.enabled ? crdBulkActions.setSelectedKeys : undefined} headerAction={<ColumnPicker resource="Custom Resource Definitions" language={language} defs={crdColumns.defs} isVisible={crdColumns.isVisible} onToggle={crdColumns.setColumnVisible} onReset={crdColumns.reset} />} renderAction={(row) => { const source = liveDefinitionByName.get(row.name); return source ? <Button variant="ghost" size="icon" aria-label={`Open ${source.kind} instances`} onClick={() => onKindSelect(source)}><ChevronRight size={14} /></Button> : null; }} onRowClick={onInstance} empty={!crdLive.loading ? <div className="empty-state"><strong>No definitions found</strong><span>{crdLive.error || "This cluster did not return any CRDs"}</span></div> : undefined} /></div></div></WorkspaceScroll><BulkResourceActionDialog actions={crdBulkActions} /></>;
}

export { CrdBrowser };
