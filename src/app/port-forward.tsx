import { Button } from "@/components/ui";
import { AlertTriangle, LoaderCircle, Network, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { PortForwardSession } from "../backend";
import { Combobox } from "../combobox";
import { tr } from "../i18n";
import type { AppLanguage } from "../preferences";
import type { ResourceRow } from "../resource-catalog";
import type { ForwardablePort, PortForwardDialogState } from "./types";

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

export { PortForwardDialog, forwardablePortsFor, portForwardAddress, portForwardMatches };
