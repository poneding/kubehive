import { Badge, Button } from "@/components/ui";
import { AlertTriangle, Droplets, LoaderCircle, LogOut, Minus, PaintBucket, Pause, Plus, Scaling, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { backend, nativeBackendAvailable, type DrainNodeResult, type NodeTaint } from "../backend";
import { Combobox } from "../combobox";
import { tr } from "../i18n";
import type { AppLanguage } from "../preferences";
import type { ResourceRow } from "../resource-catalog";

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

function ResourceEvictDialog({ row, busy, error, language, onClose, onConfirm }: { row: ResourceRow; busy: boolean; error: string; language: AppLanguage; onClose: () => void; onConfirm: () => void }) {
  const namespaceLabel = row.namespace === "—" ? tr(language, "clusterScoped") : `${tr(language, "namespace")} · ${row.namespace}`;
  return <div className="modal-backdrop panel-dialog-backdrop resource-delete-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="resource-delete-dialog resource-evict-dialog" role="dialog" aria-modal="true" aria-labelledby="resource-evict-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><h2 id="resource-evict-title">{tr(language, "evictPod")}</h2><div /><Button variant="ghost" size="icon" disabled={busy} aria-label={tr(language, "close")} onClick={onClose}><X size={14} /></Button></header>
      <div className="resource-delete-body">
        <div className="resource-delete-target"><span className="resource-delete-icon resource-evict-icon"><LogOut size={17} /></span><div><strong>{row.name}</strong><small>{row.kind} · {namespaceLabel}</small></div></div>
        <div className="resource-delete-warning resource-evict-warning"><AlertTriangle size={15} /><div><strong>{tr(language, "evictPrompt", { name: row.name })}</strong><span>{tr(language, "evictHint")}</span></div></div>
        {error && <div className="resource-delete-error" role="alert">{error}</div>}
      </div>
      <footer><span>{tr(language, "eviction")}</span><div /><Button variant="outline" size="sm" disabled={busy} autoFocus onClick={onClose}>{tr(language, "cancel")}</Button><Button variant="outline" size="sm" className="resource-delete-confirm action-warning" disabled={busy} onClick={onConfirm}>{busy && <LoaderCircle className="spin" size={13} />}{busy ? tr(language, "evicting") : tr(language, "evict")}</Button></footer>
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

export { NodeCordonDialog, NodeDrainDialog, NodeTaintsDialog, ResourceDeleteDialog, ResourceEvictDialog, ResourceScaleDialog };
