import { Badge } from "@/components/ui";
import { Copy, ExternalLink } from "lucide-react";
import type { AppLanguage } from "../preferences";
import type { ResourceLink, ResourceRow } from "../resource-catalog";
import { statusTone } from "../status";
import { ContainerSquares, ResourceLinkButton } from "../table-extras";
import { StatusDot } from "./app-controls";
import { resourceKindIcon } from "./resource-icons";

function CellCopyButton({ value, label, onCopy }: { value: string; label: string; onCopy: (value: string, label?: string) => void }) {
  return <button className="row-copy-button" type="button" aria-label={`Copy ${label.toLowerCase()}`} title={`Copy ${label.toLowerCase()}`} onClick={(event) => { event.stopPropagation(); onCopy(value, label); }}><Copy size={11} /></button>;
}

function renderResourceCell(columnId: string, row: ResourceRow, onOpenLink?: (link: ResourceLink, row: ResourceRow) => void, language?: AppLanguage, onCopy?: (value: string, label?: string) => void, onOpenPortForward?: (row: ResourceRow) => void) {
  const value = row.data[columnId];
  if (columnId === "name") {
    const KindIcon = resourceKindIcon(row.kind);
    // The kind icon carries the kind: every list page shows a single kind, so a
    // kind label on each row would only repeat the page title.
    return <div className="resource-name"><span className="resource-kind" role="img" aria-label={row.kind} title={row.kind}><KindIcon size={15} aria-hidden="true" /></span><div className="resource-name-line"><strong>{row.name}</strong>{onCopy && <CellCopyButton value={row.name} label="Name" onCopy={onCopy} />}</div></div>;
  }
  if (columnId === "localAddress" && row.kind === "PortForward") {
    // The local listener only exists while a forward is Active; other states render "—".
    if (row.status !== "Active" || value === undefined || value === "" || value === "—") return "—";
    const address = String(value);
    const content = onOpenPortForward
      ? <button className="port-forward-address" type="button" aria-label="Open in browser" title="Open in browser" onClick={(event) => { event.stopPropagation(); onOpenPortForward(row); }}><ExternalLink size={11} /><span>{address}</span></button>
      : <span>{address}</span>;
    return <span className="cell-copy-value">{content}{onCopy && <CellCopyButton value={address} label="Local address" onCopy={onCopy} />}</span>;
  }
  if ((columnId === "ip" && row.kind === "Pod") || (row.kind === "Service" && (columnId === "clusterIp" || columnId === "externalIp"))) {
    if (value === undefined || value === "" || value === "—") return "—";
    const label = columnId === "clusterIp" ? "Cluster IP" : columnId === "externalIp" ? "External IP" : "IP";
    return <span className="cell-copy-value"><span>{value}</span>{onCopy && <CellCopyButton value={String(value)} label={label} onCopy={onCopy} />}</span>;
  }
  if (columnId === "addresses" && row.linkLists?.[columnId]) {
    if (value === undefined || value === "" || value === "—") return "—";
    const parts = String(value).split(", ");
    const links = row.linkLists[columnId]!;
    return <div className="resource-link-list">{parts.map((part, index) => {
      const link = links[index];
      if (link && onOpenLink) return <ResourceLinkButton key={`${link.name}-${index}`} link={link} label={part} language={language} onOpen={(next) => onOpenLink(next, row)} />;
      return <span key={`${part}-${index}`}>{part}</span>;
    })}</div>;
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

export { renderResourceCell };
