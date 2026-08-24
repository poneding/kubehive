import { Button, ScrollArea } from "@/components/ui";
import { cn } from "@/lib/utils";
import { AlertTriangle, LoaderCircle, LogOut, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { backend, nativeBackendAvailable, type ApiResourceDescriptor, type BulkActionResult } from "../backend";
import type { ResourceRow } from "../resource-catalog";

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
        <ScrollArea className="bulk-resource-list" viewportClassName="bulk-resource-list-viewport"><div className="bulk-resource-list-content">{actions.selectedRows.slice(0, 6).map((row) => <div key={row.key}><span>{row.kind}</span><strong>{row.name}</strong><small>{row.namespace === "—" ? "Cluster scoped" : row.namespace}</small></div>)}{actions.selectedRows.length > 6 && <div className="bulk-resource-list-more">+{actions.selectedRows.length - 6} more resources</div>}</div></ScrollArea>
        {actions.error && <div className="bulk-resource-error" role="alert">{actions.error}</div>}
      </div>
      <footer><span>{evicting ? "Kubernetes policy/v1 Eviction" : "Kubernetes API · background propagation"}</span><div /><Button variant="outline" size="sm" disabled={actions.busy} autoFocus onClick={actions.close}>Cancel</Button><Button variant="outline" size="sm" className={cn("bulk-resource-confirm", evicting ? "action-warning" : "hover-destructive")} disabled={actions.busy} onClick={() => void actions.confirm()}>{actions.busy && <LoaderCircle className="spin" size={13} />}{actions.busy ? "Working…" : confirmLabel}</Button></footer>
    </section>
  </div>;
}

export { BulkResourceActionDialog, BulkResourceToolbar, useBulkResourceActions };
