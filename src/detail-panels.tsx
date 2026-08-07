import {
  ChevronDown,
  ChevronRight,
  Copy,
  Cpu,
  Eye,
  EyeOff,
  HardDrive,
  MemoryStick,
  Network,
  Pause,
  Play,
  Shuffle,
  Trash2,
} from "lucide-react";
import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PortForwardSession } from "./backend";
import { Combobox } from "./combobox";
import type { ResourceRow } from "./resource-catalog";
import {
  getResourceAnnotations,
  getResourceDataEntries,
  getResourceLabels,
  getResourceProperties,
  getResourceStatusProperties,
  getResourceStatusReason,
  getResourceStatusValue,
  isFailedPodPhase,
  type ContainerDetailSection,
  type PodMetricSeries,
  type PodMetrics,
  type ResourceCondition,
  type ResourceDataEntry,
  type ResourceDetailLink,
  type ResourceProperty,
} from "./resource-details";
import type { ResourceRelationGroup } from "./resource-relations";
import { Badge, Button, cn } from "./ui";

export type MetricsRange = 1 | 2 | 4 | 8 | 24;
export type MetricsKind = "cpu" | "memory" | "network" | "filesystem";
export type DetailCopyHandler = (value: string, label?: string) => void;

function statusTone(status?: string): "neutral" | "green" | "amber" | "red" | "blue" {
  const normalized = (status ?? "").toLowerCase();
  if (/(running|ready|active|bound|complete|healthy|normal|true)/.test(normalized)) return "green";
  if (/(failed|error|crash|notready|false|warning|degraded)/.test(normalized)) return "red";
  if (/(pending|waiting|terminat|unknown|suspend)/.test(normalized)) return "amber";
  return "neutral";
}

function DetailCopyButton({ value, label = "Value", onCopy }: { value: string; label?: string; onCopy: DetailCopyHandler }) {
  if (!value || value === "—") return null;
  return <button className="detail-inline-copy" type="button" aria-label={`Copy ${label.toLowerCase()}`} title={`Copy ${label.toLowerCase()}`} onClick={(event) => { event.stopPropagation(); onCopy(value, label); }}><Copy size={11} /></button>;
}

function LinkValue({ link, children, onOpenResource }: { link?: ResourceDetailLink; children: ReactNode; onOpenResource: (link: ResourceDetailLink) => void }) {
  if (!link) return <>{children}</>;
  return <button className="detail-resource-link" type="button" onClick={() => onOpenResource(link)}><span className="detail-resource-link-label">{children}</span><ChevronRight size={11} aria-hidden="true" /></button>;
}

function MetadataRows({ title, entries, kind, onCopy }: { title: string; entries: Record<string, string>; kind: "labels" | "annotations"; onCopy: DetailCopyHandler }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [visibleCount, setVisibleCount] = useState(Number.MAX_SAFE_INTEGER);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const values = Object.entries(entries).sort(([left], [right]) => left.localeCompare(right));
  const valuesSignature = values.map(([key, value]) => `${key}\u0000${value}`).join("\u0001");
  useLayoutEffect(() => {
    const element = listRef.current;
    if (!element || expanded) return;
    const measure = () => {
      element.scrollTop = 0;
      const children = Array.from(element.children) as HTMLElement[];
      const hasOverflow = element.scrollHeight > element.clientHeight + 1;
      const bounds = element.getBoundingClientRect();
      const fullyVisible = hasOverflow
        ? children.filter((child) => {
          const rect = child.getBoundingClientRect();
          return rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1;
        }).length
        : children.length;
      setOverflowing((current) => current === hasOverflow ? current : hasOverflow);
      setVisibleCount((current) => {
        const next = hasOverflow ? Math.max(1, fullyVisible) : children.length;
        return current === next ? current : next;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    Array.from(element.children).forEach((child) => observer.observe(child));
    return () => observer.disconnect();
  }, [expanded, kind, valuesSignature]);
  if (!values.length) return null;
  const hiddenWhenCollapsed = (index: number) => !expanded && overflowing && index >= visibleCount;
  return <div className={cn("detail-property-meta", `detail-property-${kind}`)} data-property-metadata={kind}>
    <header><span>{title}</span><div className="detail-property-meta-actions">{overflowing && <button type="button" className="detail-show-all" aria-controls={listId} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? "Collapse" : "Show all"}</button>}<Badge tone="blue">{values.length}</Badge></div></header>
    {kind === "labels"
      ? <div id={listId} ref={listRef} className={cn("detail-label-list", !expanded && "two-lines")}>{values.map(([key, value], index) => { const hidden = hiddenWhenCollapsed(index); return <button type="button" key={key} aria-hidden={hidden || undefined} aria-label={`Copy label ${key}=${value}`} tabIndex={hidden ? -1 : undefined} title={`Copy label ${key}=${value}`} onClick={() => onCopy(`${key}=${value}`, "Label")}><code>{key}</code><b>=</b><strong>{value}</strong></button>; })}</div>
      : <div id={listId} ref={listRef} className={cn("detail-annotation-list", !expanded && "two-lines")}>{values.map(([key, value], index) => { const hidden = hiddenWhenCollapsed(index); return <button type="button" key={key} aria-hidden={hidden || undefined} aria-label={`Copy annotation ${key}=${value}`} tabIndex={hidden ? -1 : undefined} title={`Copy annotation ${key}=${value}`} onClick={() => onCopy(`${key}=${value}`, "Annotation")}><strong>{key}</strong><span>{value}</span></button>; })}</div>}
  </div>;
}

function PropertyValue({ property, onOpenResource, onCopy }: { property: ResourceProperty; onOpenResource: (link: ResourceDetailLink) => void; onCopy: DetailCopyHandler }) {
  return <div className="detail-property-value">
    <LinkValue link={property.link} onOpenResource={onOpenResource}><strong className={cn(property.tone && `tone-${property.tone}`)}>{property.value}</strong></LinkValue>
    {property.copyable && <DetailCopyButton value={property.value} label={property.label} onCopy={onCopy} />}
  </div>;
}

export function PropertiesSection({ row, relations, onOpenResource, onCopy }: { row: ResourceRow; relations?: ResourceRelationGroup[]; onOpenResource: (link: ResourceDetailLink) => void; onCopy: DetailCopyHandler }) {
  let properties = getResourceProperties(row);
  const workload = relations?.find((group) => group.id === "workload")?.items[0];
  if (row.kind === "Pod" && workload) properties = properties.map((property) => property.label === "Controlled by" ? { ...property, value: `${workload.kind}/${workload.name}`, link: { kind: workload.kind, name: workload.name, namespace: workload.namespace === "—" ? undefined : workload.namespace, apiVersion: workload.backend?.apiVersion } } : property);
  const relationGroups = row.kind === "Pod" ? [] : (relations ?? []).filter((group) => group.id !== "events" && group.items.length > 0);
  const labels = getResourceLabels(row);
  const annotations = getResourceAnnotations(row);
  return <section className="detail-section detail-properties-section" data-detail-section="properties">
    <div className="detail-section-heading"><h3>Properties</h3></div>
    <div className="detail-property-grid">{properties.map((property) => <div className={cn("detail-property", property.label === "Name" && "wide")} key={property.label}><span>{property.label}</span><PropertyValue property={property} onOpenResource={onOpenResource} onCopy={onCopy} /></div>)}</div>
    <MetadataRows title="Labels" entries={labels} kind="labels" onCopy={onCopy} />
    <MetadataRows title="Annotations" entries={annotations} kind="annotations" onCopy={onCopy} />
    {relationGroups.length > 0 && <div className="detail-property-relations"><header><span>Linked resources</span></header>{relationGroups.map((group) => <div className="detail-property-relation-group" key={group.id}><div><strong>{group.title}</strong><Badge tone="blue">{group.total ?? group.items.length}</Badge></div><div>{group.items.map((entry) => <button type="button" key={`${entry.kind}/${entry.namespace}/${entry.name}`} onClick={() => onOpenResource({ kind: entry.kind, name: entry.name, namespace: entry.namespace === "—" ? undefined : entry.namespace, apiVersion: entry.backend?.apiVersion })}><span>{entry.kind}</span><strong>{entry.name}</strong><ChevronRight size={11} aria-hidden="true" /></button>)}</div></div>)}</div>}
  </section>;
}

const lineColors = ["var(--detail-chart-1)", "var(--detail-chart-2)", "var(--detail-chart-3)", "var(--detail-chart-4)", "var(--detail-chart-5)"];

function formatMetric(value: number, unit: string) {
  if (!Number.isFinite(value)) return "—";
  if (unit === "bytes" || unit === "bytes/s") {
    const units: Array<[string, number]> = [["TiB", 1024 ** 4], ["GiB", 1024 ** 3], ["MiB", 1024 ** 2], ["KiB", 1024], ["B", 1]];
    const [suffix, divisor] = units.find(([, size]) => value >= size) ?? units.at(-1)!;
    return `${Math.round(value / divisor * 10) / 10} ${suffix}${unit === "bytes/s" ? "/s" : ""}`;
  }
  if (unit === "cores") return value < 1 ? `${Math.round(value * 1000)}m` : `${Math.round(value * 100) / 100} cores`;
  return `${Math.round(value * 100) / 100} ${unit}`;
}

function Chart({ series }: { series: PodMetricSeries[] }) {
  const chartRef = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(480);
  useLayoutEffect(() => {
    const element = chartRef.current;
    if (!element) return;
    const measure = () => {
      const next = Math.max(240, Math.round(element.getBoundingClientRect().width));
      setChartWidth((current) => current === next ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [series]);
  const height = 156;
  const padding = { left: 56, right: 12, top: 12, bottom: 25 };
  const allPoints = series.flatMap((item) => item.points);
  if (!allPoints.length) return <div className="detail-chart-empty">No samples for this metric and time range.</div>;
  const minTime = Math.min(...allPoints.map((point) => point.timestamp));
  const maxTime = Math.max(...allPoints.map((point) => point.timestamp));
  const maxValue = Math.max(...allPoints.map((point) => point.value), 1e-9);
  const x = (value: number) => padding.left + ((value - minTime) / Math.max(1, maxTime - minTime)) * (chartWidth - padding.left - padding.right);
  const y = (value: number) => padding.top + (1 - value / maxValue) * (height - padding.top - padding.bottom);
  const latestUnit = series[0]?.unit ?? "";
  return <div ref={chartRef} className="detail-chart-wrap">
    <svg className="detail-metric-chart" viewBox={`0 0 ${chartWidth} ${height}`} role="img" aria-label="Pod metric time series">
      {[0, .25, .5, .75, 1].map((ratio) => <g key={ratio}><line x1={padding.left} x2={chartWidth - padding.right} y1={y(maxValue * ratio)} y2={y(maxValue * ratio)} /><text x={padding.left - 7} y={y(maxValue * ratio) + 3}>{formatMetric(maxValue * ratio, latestUnit)}</text></g>)}
      {series.map((item, index) => <polyline key={item.id} fill="none" stroke={lineColors[index % lineColors.length]} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" points={item.points.map((point) => `${x(point.timestamp)},${y(point.value)}`).join(" ")} />)}
      <text className="axis-time" x={padding.left} y={height - 5}>{new Date(minTime * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</text>
      <text className="axis-time end" x={chartWidth - padding.right} y={height - 5}>{new Date(maxTime * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</text>
    </svg>
    <div className="detail-chart-legend">{series.map((item, index) => <span key={item.id}><i style={{ background: lineColors[index % lineColors.length] }} /><b>{item.label}</b><em>{formatMetric(item.points.at(-1)?.value ?? 0, item.unit)}</em></span>)}</div>
  </div>;
}

export function PodMetricsSection({ metrics, active, range, loading, onMetric, onRange }: { metrics?: PodMetrics; active: MetricsKind; range: MetricsRange; loading?: boolean; onMetric: (metric: MetricsKind) => void; onRange: (range: MetricsRange) => void }) {
  const tabs = [{ id: "cpu" as const, label: "CPU", icon: Cpu }, { id: "memory" as const, label: "Memory", icon: MemoryStick }, { id: "network" as const, label: "Network", icon: Network }, { id: "filesystem" as const, label: "Filesystem", icon: HardDrive }];
  return <section className="detail-section detail-metrics-section" data-detail-section="metrics">
    <div className="detail-metrics-toolbar"><h3>Metrics</h3><div className="detail-metrics-controls"><div className="detail-metric-tabs" role="tablist" aria-label="Metric type">{tabs.map((tab) => { const Icon = tab.icon; return <button type="button" role="tab" aria-label={tab.label} data-tooltip={tab.label} aria-selected={active === tab.id} key={tab.id} onClick={() => onMetric(tab.id)}><Icon size={13} aria-hidden="true" /></button>; })}</div><Combobox className="detail-metrics-range" ariaLabel="Metrics time range" searchable={false} value={String(range)} options={[1, 2, 4, 8, 24].map((hours) => ({ value: String(hours), label: `${hours}h` }))} onChange={(value) => onRange(Number(value) as MetricsRange)} /></div></div>
    <div className={cn("detail-metrics-chart", loading && "loading")} aria-busy={loading || undefined}>{metrics ? <Chart series={metrics.series[active] ?? []} /> : <div className="detail-chart-placeholder" role="status" aria-label="Loading metrics"><i /><i /><i /><i /><i /></div>}</div>
    <small className="detail-metrics-provider">{metrics ? `Source: ${metrics.provider}` : "\u00a0"}</small>
  </section>;
}

function EnvironmentVariableRow({ entry, onOpenResource, onCopy }: { entry: ContainerDetailSection["containers"][number]["environment"][number]; onOpenResource: (link: ResourceDetailLink) => void; onCopy: DetailCopyHandler }) {
  const [revealed, setRevealed] = useState(false);
  const masked = Boolean(entry.sensitive) && !revealed;
  const display = masked ? "••••••••" : entry.value;
  return <div className={cn("detail-env-row", entry.sensitive && "sensitive", masked && "masked")}>
    <code title={entry.name}>{entry.name}</code>
    <span title={masked ? undefined : entry.value}>{entry.link && !masked ? <LinkValue link={entry.link} onOpenResource={onOpenResource}>{entry.value}</LinkValue> : display}</span>
    <div className="detail-env-actions">
      {entry.sensitive && <button className="detail-inline-copy" type="button" aria-label={revealed ? `Hide environment variable ${entry.name}` : `Reveal environment variable ${entry.name}`} title={revealed ? "Hide value" : "Reveal value"} onClick={() => setRevealed((value) => !value)}>{revealed ? <EyeOff size={11} /> : <Eye size={11} />}</button>}
      <DetailCopyButton value={masked ? "" : entry.value} label={`Environment variable ${entry.name}`} onCopy={onCopy} />
    </div>
  </div>;
}

function ContainerEnvironmentList({ entries, expanded, onOpenResource, onCopy }: { entries: ContainerDetailSection["containers"][number]["environment"]; expanded: boolean; onOpenResource: (link: ResourceDetailLink) => void; onCopy: DetailCopyHandler }) {
  if (!entries.length) return <div className="detail-container-empty">No explicit environment variables</div>;
  const visible = expanded ? entries : entries.slice(0, 3);
  return <div className="detail-env-list">{visible.map((entry, index) => <EnvironmentVariableRow key={`${entry.name}-${index}`} entry={entry} onOpenResource={onOpenResource} onCopy={onCopy} />)}</div>;
}

export type DetailPortEntry = {
  port: string | number;
  protocol: string;
  name?: string;
  hostPort?: string;
  target?: string;
  forwardable?: boolean;
};

function portForwardSessionFor(row: ResourceRow, port: number, sessions: PortForwardSession[]) {
  const targetKind = row.kind === "Service" ? "service" : "pod";
  return sessions.find((item) => item.targetKind === targetKind
    && item.targetName === row.name
    && item.namespace === row.namespace
    && (targetKind === "service" ? item.servicePort === port : item.remotePort === port));
}

function portForwardAddress(session: PortForwardSession) {
  return `${session.protocol}://${session.host === "0.0.0.0" ? "localhost" : session.host}:${session.localPort}`;
}

function ResourcePortsTable({ row, ports, sessions, onCopy, onPortForward, onOpenPortForward, onPausePortForward, onResumePortForward, onStopPortForward }: { row: ResourceRow; ports: DetailPortEntry[]; sessions: PortForwardSession[]; onCopy: DetailCopyHandler; onPortForward: (row: ResourceRow, port: number) => void; onOpenPortForward: (session: PortForwardSession) => void; onPausePortForward: (session: PortForwardSession) => void; onResumePortForward: (session: PortForwardSession) => void; onStopPortForward: (session: PortForwardSession) => Promise<boolean> }) {
  if (!ports.length) return <div className="detail-container-empty">No declared ports</div>;
  return <div className="detail-port-table-wrap"><table className="detail-port-table"><thead><tr><th>Name</th><th>Port</th><th>Protocol</th><th>Address</th><th>Forward</th></tr></thead><tbody>{ports.map((port, index) => {
    const number = Number(port.port);
    const session = Number.isFinite(number) ? portForwardSessionFor(row, number, sessions) : undefined;
    const address = session ? portForwardAddress(session) : "";
    const forwardable = port.forwardable ?? port.protocol.toUpperCase() === "TCP";
    const name = port.name?.trim() || "-";
    return <tr key={`${port.name ?? "port"}-${port.port}-${index}`}><td className="detail-port-name" title={name === "-" ? undefined : name}>{name}</td><td className="detail-port-number"><strong>{port.port}</strong></td><td><Badge tone={port.protocol.toUpperCase() === "TCP" ? "blue" : "neutral"}>{port.protocol}</Badge></td><td>{session ? <div className="detail-port-address">{session.status === "Active" && <span className="detail-port-active-dot" aria-label="Port forward active" title="Port forward active" />}<button type="button" className="detail-port-address-link" disabled={session.status !== "Active"} title={session.status === "Active" ? "Open in browser" : "Resume before opening"} onClick={() => onOpenPortForward(session)}>{address}</button><DetailCopyButton value={address} label="Address" onCopy={onCopy} /></div> : <span className="detail-port-unforwarded">Not forwarded</span>}</td><td><div className="detail-port-actions">{session ? <>{session.status === "Paused" ? <Button variant="ghost" size="icon" aria-label="Resume forwarding" title="Resume forwarding" onClick={() => onResumePortForward(session)}><Play size={12} /></Button> : <Button variant="ghost" size="icon" aria-label="Pause forwarding" title="Pause forwarding" onClick={() => onPausePortForward(session)}><Pause size={12} /></Button>}<Button variant="ghost" size="icon" className="hover-destructive" aria-label="Stop forwarding" title="Stop forwarding" onClick={() => void onStopPortForward(session)}><Trash2 size={12} /></Button></> : <Button variant="outline" size="icon" disabled={!forwardable || !Number.isFinite(number)} aria-label={`Forward port ${port.port}`} title={forwardable ? `Forward port ${port.port}` : "TCP only"} onClick={() => onPortForward(row, number)}><Shuffle size={13} /></Button>}</div></td></tr>;
  })}</tbody></table></div>;
}

function ContainerPorts({ row, ports, sessions, onCopy, onPortForward, onOpenPortForward, onPausePortForward, onResumePortForward, onStopPortForward }: { row: ResourceRow; ports: ContainerDetailSection["containers"][number]["ports"]; sessions: PortForwardSession[]; onCopy: DetailCopyHandler; onPortForward: (row: ResourceRow, port: number) => void; onOpenPortForward: (session: PortForwardSession) => void; onPausePortForward: (session: PortForwardSession) => void; onResumePortForward: (session: PortForwardSession) => void; onStopPortForward: (session: PortForwardSession) => Promise<boolean> }) {
  return <ResourcePortsTable row={row} ports={ports} sessions={sessions} onCopy={onCopy} onPortForward={onPortForward} onOpenPortForward={onOpenPortForward} onPausePortForward={onPausePortForward} onResumePortForward={onResumePortForward} onStopPortForward={onStopPortForward} />;
}

export function ServicePortsSection({ row, ports, sessions, onCopy, onPortForward, onOpenPortForward, onPausePortForward, onResumePortForward, onStopPortForward }: { row: ResourceRow; ports: DetailPortEntry[]; sessions: PortForwardSession[]; onCopy: DetailCopyHandler; onPortForward: (row: ResourceRow, port: number) => void; onOpenPortForward: (session: PortForwardSession) => void; onPausePortForward: (session: PortForwardSession) => void; onResumePortForward: (session: PortForwardSession) => void; onStopPortForward: (session: PortForwardSession) => Promise<boolean> }) {
  if (!ports.length) return null;
  return <section className="detail-section detail-service-ports" data-detail-section="service-ports"><div className="detail-section-heading"><h3>Ports</h3><Badge tone="blue">{ports.length}</Badge></div><ResourcePortsTable row={row} ports={ports} sessions={sessions} onCopy={onCopy} onPortForward={onPortForward} onOpenPortForward={onOpenPortForward} onPausePortForward={onPausePortForward} onResumePortForward={onResumePortForward} onStopPortForward={onStopPortForward} /></section>;
}

function resourceLabel(value: string) {
  if (value.toLowerCase() === "cpu") return "CPU";
  return value.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function ContainerCard({ row, container, open, sessions, onOpenResource, onCopy, onPortForward, onOpenPortForward, onPausePortForward, onResumePortForward, onStopPortForward }: { row: ResourceRow; container: ContainerDetailSection["containers"][number]; open: boolean; sessions: PortForwardSession[]; onOpenResource: (link: ResourceDetailLink) => void; onCopy: DetailCopyHandler; onPortForward: (row: ResourceRow, port: number) => void; onOpenPortForward: (session: PortForwardSession) => void; onPausePortForward: (session: PortForwardSession) => void; onResumePortForward: (session: PortForwardSession) => void; onStopPortForward: (session: PortForwardSession) => Promise<boolean> }) {
  const [environmentExpanded, setEnvironmentExpanded] = useState(false);
  const imageDigestId = useId();
  const state = container.stateReason ? `${container.state} · ${container.stateReason}` : container.state;
  const requests = container.resourceRequests ?? {};
  const limits = container.resourceLimits ?? {};
  const resourceKeys = Array.from(new Set([...Object.keys(requests), ...Object.keys(limits)]));
  return <details className="detail-container-card" open={open}><summary><span className={cn("detail-container-state", `tone-${statusTone(container.state)}`)} /><div className="detail-container-title"><strong>{container.name}</strong><DetailCopyButton value={container.name} label="Container name" onCopy={onCopy} /></div><Badge tone={statusTone(container.state)}>{state}</Badge><ChevronDown size={13} /></summary><div className="detail-container-body">
    <div className="detail-container-facts">
      <div className="detail-container-fact detail-image-fact wide"><div className="detail-image-heading"><span>Image</span><Badge className="detail-pull-policy-badge">{container.pullPolicy}</Badge></div><div className="detail-image-value"><div className="detail-image-address" tabIndex={container.imageId ? 0 : undefined} aria-describedby={container.imageId ? imageDigestId : undefined}><code>{container.image}</code><DetailCopyButton value={container.image} label="Image" onCopy={onCopy} /></div>{container.imageId && <small id={imageDigestId} className="detail-image-id" role="tooltip"><span>Digest</span>{container.imageId}</small>}</div></div>
      {resourceKeys.length > 0 && <div className="detail-container-fact detail-container-resource-fact wide"><span>Resources</span><div className="detail-resource-grid">{resourceKeys.map((key) => <div className="detail-resource-row" key={key}><div><span>{resourceLabel(key)} request</span><strong>{requests[key] ?? "—"}</strong></div><div><span>{resourceLabel(key)} limit</span><strong>{limits[key] ?? "—"}</strong></div></div>)}</div></div>}
    </div>
    <div className="detail-container-subsection"><header><span>Ports</span><Badge tone="blue">{container.ports.length}</Badge></header><ContainerPorts row={row} ports={container.ports} sessions={sessions} onCopy={onCopy} onPortForward={onPortForward} onOpenPortForward={onOpenPortForward} onPausePortForward={onPausePortForward} onResumePortForward={onResumePortForward} onStopPortForward={onStopPortForward} /></div>
    <div className="detail-container-subsection"><header><span>Environment variables</span><div className="detail-subsection-actions">{container.environment.length > 3 && <button className="detail-show-more" type="button" onClick={() => setEnvironmentExpanded((value) => !value)}>{environmentExpanded ? "Show less" : "Show all"}</button>}<Badge tone="blue">{container.environment.length}</Badge></div></header><ContainerEnvironmentList entries={container.environment} expanded={environmentExpanded} onOpenResource={onOpenResource} onCopy={onCopy} /></div>
    <div className="detail-container-subsection"><header><span>Volume mounts</span><Badge tone="blue">{container.mounts.length}</Badge></header>{container.mounts.length ? <div className="detail-mount-table"><div className="head"><span>Volume</span><span>Source</span><span>Type</span><span>Path</span><span>Mode</span></div>{container.mounts.map((mount) => <div key={`${mount.name}-${mount.path}`}><strong>{mount.name}</strong><span>{mount.link ? <LinkValue link={mount.link} onOpenResource={onOpenResource}>{mount.sourceName}</LinkValue> : mount.sourceName}</span><span>{mount.sourceType}</span><code>{mount.path}{mount.subPath ? `/${mount.subPath}` : ""}</code><em>{mount.readOnly ? "RO" : "RW"}</em></div>)}</div> : <div className="detail-container-empty">No volume mounts</div>}</div>
  </div></details>;
}

export function ContainerConfigurationSection({ row, section, sessions, onOpenResource, onCopy, onPortForward, onOpenPortForward, onPausePortForward, onResumePortForward, onStopPortForward }: { row: ResourceRow; section: ContainerDetailSection | null; sessions: PortForwardSession[]; onOpenResource: (link: ResourceDetailLink) => void; onCopy: DetailCopyHandler; onPortForward: (row: ResourceRow, port: number) => void; onOpenPortForward: (session: PortForwardSession) => void; onPausePortForward: (session: PortForwardSession) => void; onResumePortForward: (session: PortForwardSession) => void; onStopPortForward: (session: PortForwardSession) => Promise<boolean> }) {
  if (!section) return null;
  return <section className="detail-section detail-container-section" data-detail-section="containers"><div className="detail-section-heading"><h3>Containers</h3><Badge tone="blue">{section.containers.length}</Badge></div><div className="detail-container-list">{section.containers.map((container) => <ContainerCard key={`${container.kind}-${container.name}`} row={row} container={container} open={container.kind === "container"} sessions={sessions} onOpenResource={onOpenResource} onCopy={onCopy} onPortForward={onPortForward} onOpenPortForward={onOpenPortForward} onPausePortForward={onPausePortForward} onResumePortForward={onResumePortForward} onStopPortForward={onStopPortForward} />)}</div></section>;
}

export function StatusSection({ row, conditions, fallbackStatus, eventGroup, onOpenResource, onCopy }: { row: ResourceRow; conditions: ResourceCondition[]; fallbackStatus: string; eventGroup?: ResourceRelationGroup; onOpenResource: (row: ResourceRow) => void; onCopy: DetailCopyHandler }) {
  const [conditionsExpanded, setConditionsExpanded] = useState(false);
  const [eventsExpanded, setEventsExpanded] = useState(false);
  const fields = getResourceStatusProperties(row);
  const podPhase = row.kind === "Pod" ? getResourceStatusValue(row) : undefined;
  const podReason = isFailedPodPhase(row) ? getResourceStatusReason(row) : "";
  const podStatus = podPhase && podReason && podReason !== "—" ? `${podPhase} · ${podReason}` : podPhase;
  const statusFallback = podPhase ?? fallbackStatus;
  const hasStatusDetails = fields.length > 0;
  const visibleConditions = conditionsExpanded ? conditions : conditions.slice(0, 5);
  const events = eventGroup?.items ?? [];
  const visibleEvents = eventsExpanded ? events : events.slice(0, 5);
  return <section className={cn("detail-section", "detail-status-section", !hasStatusDetails && "detail-status-without-summary")} data-detail-section="status">
    <div className="detail-section-heading"><h3>Status</h3>{podStatus && <Badge className="detail-header-status" tone={statusTone(podPhase)}>{podStatus}</Badge>}</div>
    {fields.length > 0 && <div className="detail-property-grid">{fields.map((field) => <div className={cn("detail-property", field.label === "Message" && "wide")} key={field.label}><span>{field.label}</span><PropertyValue property={field} onOpenResource={() => undefined} onCopy={onCopy} /></div>)}</div>}
    <div className="detail-status-subsection" data-status-subsection="conditions"><header><span>Conditions</span><Badge tone="blue">{conditions.length || 1}</Badge></header><div className="detail-condition-list">{visibleConditions.map((condition, index) => <div className="condition-row" key={`${condition.type}-${condition.lastTransition}-${index}`}><span className={cn("detail-condition-dot", `tone-${statusTone(condition.status === "True" ? "Ready" : condition.status === "False" ? "Failed" : condition.status)}`)} /><div><strong>{condition.type}</strong><span>{condition.reason !== "—" ? condition.reason : condition.message}</span>{condition.message !== "—" && condition.message !== condition.reason && <small>{condition.message}</small>}</div><time>{condition.lastTransition}</time></div>)}{conditions.length === 0 && <div className="condition-row"><span className={cn("detail-condition-dot", `tone-${statusTone(statusFallback)}`)} /><div><strong>{statusFallback}</strong><span>No status.conditions reported</span></div></div>}</div>{conditions.length > 5 && <button className="detail-show-more" type="button" onClick={() => setConditionsExpanded((value) => !value)}>{conditionsExpanded ? "Show less" : `Show all (${conditions.length})`}</button>}</div>
    <div className="detail-status-subsection" data-status-subsection="events"><header><span>Events</span>{events.length ? <Badge tone="blue">{eventGroup?.total ?? events.length}</Badge> : null}</header>{events.length ? <><div className="detail-condition-list detail-event-list">{visibleEvents.map((event) => {
      const message = String(event.data.message ?? "Kubernetes event");
      const reason = String(event.data.reason ?? "");
      return <button className="condition-row event-row" key={`${event.namespace}/${event.name}/${event.key}`} type="button" onClick={() => onOpenResource(event)}><span className={cn("detail-condition-dot", `tone-${statusTone(String(event.data.type ?? event.status))}`)} /><div><strong className="detail-event-name">{event.name}<ChevronRight size={11} aria-hidden="true" /></strong><span>{reason && reason !== message ? reason : message}</span>{reason && reason !== message && message && <small>{message}</small>}</div><time>{String(event.data.lastSeen ?? event.data.age ?? "")}</time></button>;
    })}</div>{events.length > 5 && <button className="detail-show-more" type="button" onClick={() => setEventsExpanded((value) => !value)}>{eventsExpanded ? "Show less" : `Show all (${events.length})`}</button>}</> : <div className="detail-container-empty">No recent events</div>}</div>
  </section>;
}

function DataPreviewRow({ entry, secret, onCopy }: { entry: ResourceDataEntry; secret: boolean; onCopy: DetailCopyHandler }) {
  const [revealed, setRevealed] = useState(!secret);
  const preview = revealed ? entry.decoded : "••••••••••••";
  return <details className="detail-data-entry"><summary><code>{entry.key}</code><span>{entry.source}</span><DetailCopyButton value={entry.key} label="Key" onCopy={onCopy} /><ChevronDown size={12} /></summary><div><pre>{preview}</pre><div>{secret && <Button variant="ghost" size="sm" onClick={() => setRevealed((value) => !value)}>{revealed ? <EyeOff size={12} /> : <Eye size={12} />}{revealed ? "Hide decoded" : "Decode preview"}</Button>}{revealed && <Button variant="ghost" size="sm" onClick={() => onCopy(entry.decoded, "Decoded value")}><Copy size={12} />Copy decoded</Button>}{entry.encoded && <Button variant="ghost" size="sm" onClick={() => onCopy(entry.encoded!, "Encoded value")}><Copy size={12} />Copy encoded</Button>}</div></div></details>;
}

export function ResourceDataSection({ row, onCopy }: { row: ResourceRow; onCopy: DetailCopyHandler }) {
  const entries = useMemo(() => getResourceDataEntries(row), [row]);
  if (!["ConfigMap", "Secret"].includes(row.kind)) return null;
  return <section className="detail-section detail-data-section" data-detail-section="data-preview"><div className="detail-section-heading"><div><h3>Data</h3><span>Per-key content preview and copy actions.</span></div><Badge tone="blue">{entries.length}</Badge></div>{entries.length ? <div className="detail-data-list">{entries.map((entry) => <DataPreviewRow key={`${entry.source}-${entry.key}`} entry={entry} secret={row.kind === "Secret"} onCopy={onCopy} />)}</div> : <div className="detail-container-empty">No data keys</div>}</section>;
}

export function RelationLoadingNotice({ loading, error }: { loading?: boolean; error?: string }) {
  if (!loading && !error) return null;
  return <div className="detail-inline-relation-status">{loading ? "Resolving linked resources…" : error}</div>;
}


