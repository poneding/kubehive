import type { ResourceRow } from "./resource-catalog";

/**
 * The detail drawer deliberately models operational information rather than a
 * flattened Kubernetes object.  The manifest editor remains the escape hatch
 * for exhaustive API metadata and raw spec inspection.
 */
export type DetailField = {
  label: string;
  value: string;
  tone?: "neutral" | "green" | "amber" | "red" | "blue";
  wide?: boolean;
  copyable?: boolean;
};

export type ResourceDetailSection = {
  id: string;
  title: string;
  description?: string;
  fields: DetailField[];
};

export type ResourceCondition = {
  type: string;
  status: string;
  reason: string;
  message: string;
  lastTransition: string;
};

export type ContainerEnvironment = {
  name: string;
  value: string;
  source: "literal" | "secret" | "configMap" | "field" | "resourceField" | "envFrom" | "unknown";
  sensitive?: boolean;
  link?: ResourceDetailLink;
};

export type ResourceDetailLink = {
  kind: string;
  name: string;
  namespace?: string;
  apiVersion?: string;
};

export type ContainerPort = {
  name?: string;
  port: string;
  protocol: string;
  hostPort?: string;
};

export type ContainerMount = {
  name: string;
  path: string;
  readOnly: boolean;
  subPath?: string;
  sourceName: string;
  sourceType: string;
  link?: ResourceDetailLink;
};

export type ContainerDetail = {
  name: string;
  kind: "init" | "container" | "ephemeral";
  image: string;
  imageId?: string;
  pullPolicy: string;
  state: string;
  stateReason?: string;
  ready?: boolean;
  restarts?: number;
  command?: string;
  args?: string;
  ports: ContainerPort[];
  environment: ContainerEnvironment[];
  mounts: ContainerMount[];
  resourceRequests?: Record<string, string>;
  resourceLimits?: Record<string, string>;
};

export type ContainerDetailSection = {
  id: string;
  title: string;
  description: string;
  containers: ContainerDetail[];
};

export type PodMetricSeries = {
  id: string;
  label: string;
  unit: string;
  points: Array<{ timestamp: number; value: number }>;
};

export type PodMetrics = {
  source: "prometheus";
  provider: string;
  rangeHours: number;
  stepSeconds: number;
  series: Record<"cpu" | "memory" | "network" | "filesystem", PodMetricSeries[]>;
};

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string => value === undefined || value === null ? "" : String(value);

export function detailValueAt(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) return current[Number(part)];
    if (typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[part];
  }, value);
}

function compact(value: unknown, maxLength = 360): string {
  if (value === undefined || value === null || value === "") return "—";
  let result: string;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") result = String(value);
  else if (Array.isArray(value)) result = value.length ? value.map((entry) => compact(entry, 120)).join(", ") : "—";
  else {
    const entries = Object.entries(object(value));
    result = entries.length ? entries.map(([key, entry]) => `${key}: ${compact(entry, 100)}`).join(", ") : "—";
  }
  return result.length > maxLength ? `${result.slice(0, Math.max(0, maxLength - 1))}…` : result;
}

function compactObject(value: unknown, maxItems = 8): string {
  const entries = Object.entries(object(value));
  if (!entries.length) return "—";
  const preview = entries.slice(0, maxItems).map(([key, entry]) => `${key}: ${compact(entry, 72)}`);
  return `${preview.join(" · ")}${entries.length > maxItems ? ` · +${entries.length - maxItems} more` : ""}`;
}

function names(value: unknown, maxItems = 8): string {
  const values = array(value).map((entry) => compact(entry, 100)).filter((entry) => entry !== "—");
  if (!values.length) return "—";
  return `${values.slice(0, maxItems).join(", ")}${values.length > maxItems ? ` +${values.length - maxItems} more` : ""}`;
}

function field(label: string, value: unknown, options: Partial<DetailField> = {}): DetailField {
  return { label, value: compact(value), ...options };
}

function section(id: string, title: string, fields: DetailField[], description?: string): ResourceDetailSection {
  return { id, title, description, fields: fields.filter((entry) => entry.value !== "—") };
}

function nonEmpty(sections: ResourceDetailSection[]): ResourceDetailSection[] {
  return sections.filter((entry) => entry.fields.length > 0);
}

function sourceFor(row: ResourceRow) {
  return row.backend?.object ?? {};
}

function dataOr(row: ResourceRow, path: string, dataKey?: string) {
  return detailValueAt(sourceFor(row), path) ?? row.data[dataKey ?? path.split(".").at(-1) ?? path];
}

function selector(value: unknown): string {
  const source = object(value);
  const matchLabels = object(source.matchLabels);
  const labels = Object.entries(Object.keys(matchLabels).length ? matchLabels : source)
    .filter(([key]) => key !== "matchExpressions")
    .map(([key, entry]) => `${key}=${compact(entry, 80)}`);
  const expressions = array(source.matchExpressions).map((entry) => {
    const key = compact(detailValueAt(entry, "key"), 80);
    const operator = compact(detailValueAt(entry, "operator"), 30);
    const values = names(detailValueAt(entry, "values"), 5);
    if (key === "—" || operator === "—") return "";
    if (operator === "Exists") return key;
    if (operator === "DoesNotExist") return `!${key}`;
    return values === "—" ? `${key} ${operator}` : `${key} ${operator} (${values})`;
  }).filter(Boolean);
  const all = [...labels, ...expressions];
  return all.length ? all.join(", ") : "—";
}

function ports(value: unknown): string {
  const values = array(value).map((entry) => {
    const source = object(entry);
    const port = source.port ?? source.containerPort ?? source.targetPort;
    if (port === undefined || port === null || port === "") return "";
    const name = source.name ? `${compact(source.name, 50)} · ` : "";
    const target = source.targetPort !== undefined && source.port !== undefined ? ` → ${compact(source.targetPort, 50)}` : "";
    const nodePort = source.nodePort !== undefined ? ` (node ${compact(source.nodePort, 50)})` : "";
    return `${name}${compact(port, 50)}/${compact(source.protocol ?? "TCP", 20)}${target}${nodePort}`;
  }).filter(Boolean);
  return values.length ? values.join(", ") : "—";
}

function tolerations(value: unknown): string {
  const values = array(value).map((entry) => {
    const source = object(entry);
    const key = string(source.key);
    const operator = string(source.operator || "Equal");
    const val = string(source.value);
    const effect = string(source.effect);
    const seconds = source.tolerationSeconds === undefined ? "" : ` for ${compact(source.tolerationSeconds, 30)}s`;
    const match = !key ? "all taints" : operator === "Exists" ? key : `${key}=${val}`;
    return `${match}${effect ? ` (${effect})` : ""}${seconds}`;
  }).filter(Boolean);
  return values.length ? `${values.slice(0, 5).join(" · ")}${values.length > 5 ? ` · +${values.length - 5} more` : ""}` : "—";
}

function resourceQuantities(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return compact(value);
  const entries = Object.entries(object(value));
  if (!entries.length) return "—";
  return entries.slice(0, 8).map(([key, entry]) => `${key}: ${compact(entry, 60)}`).join(" · ") + (entries.length > 8 ? ` · +${entries.length - 8} more` : "");
}

function resourceQuantityValues(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(object(value)).slice(0, 8).map(([key, entry]) => [key, compact(entry, 60)]));
}

function workloadPodSpec(row: ResourceRow): Record<string, unknown> {
  const source = sourceFor(row);
  switch (row.kind) {
    case "Pod": return object(detailValueAt(source, "spec"));
    case "CronJob": return object(detailValueAt(source, "spec.jobTemplate.spec.template.spec"));
    case "Job": return object(detailValueAt(source, "spec.template.spec"));
    case "Deployment":
    case "StatefulSet":
    case "DaemonSet":
    case "ReplicaSet":
    case "ReplicationController":
      return object(detailValueAt(source, "spec.template.spec"));
    default: return {};
  }
}

function workloadTemplate(row: ResourceRow) {
  return workloadPodSpec(row);
}

function containerState(status: Record<string, unknown>, kind: ContainerDetail["kind"]) {
  const state = object(status.state);
  const running = object(state.running);
  const waiting = object(state.waiting);
  const terminated = object(state.terminated);
  if (Object.keys(running).length) return { state: "Running", reason: string(running.startedAt) || undefined };
  if (Object.keys(waiting).length) return { state: "Waiting", reason: string(waiting.reason) || string(waiting.message) || undefined };
  if (Object.keys(terminated).length) {
    const code = terminated.exitCode === undefined ? "" : ` (exit ${compact(terminated.exitCode, 20)})`;
    return { state: kind === "init" && terminated.exitCode === 0 ? "Completed" : "Terminated", reason: `${string(terminated.reason) || string(terminated.message) || "Exited"}${code}` };
  }
  return { state: kind === "init" ? "Pending" : "Unknown", reason: undefined };
}

function sensitiveEnvironmentName(name: string) {
  return /(password|passwd|secret|token|credential|private[_-]?key|api[_-]?key)/i.test(name);
}

function environmentFor(container: Record<string, unknown>, namespace?: string): ContainerEnvironment[] {
  const variables: ContainerEnvironment[] = [];
  for (const envValue of array(container.env)) {
    const env = object(envValue);
    const name = string(env.name);
    if (!name) continue;
    const valueFrom = object(env.valueFrom);
    const secret = object(valueFrom.secretKeyRef);
    const configMap = object(valueFrom.configMapKeyRef);
    const fieldRef = object(valueFrom.fieldRef);
    const resourceFieldRef = object(valueFrom.resourceFieldRef);
    if (string(secret.name)) variables.push({ name, value: `Secret/${string(secret.name)}:${string(secret.key) || "*"}`, source: "secret", sensitive: true, link: { kind: "Secret", name: string(secret.name), namespace } });
    else if (string(configMap.name)) variables.push({ name, value: `ConfigMap/${string(configMap.name)}:${string(configMap.key) || "*"}`, source: "configMap", link: { kind: "ConfigMap", name: string(configMap.name), namespace } });
    else if (string(fieldRef.fieldPath)) variables.push({ name, value: `Field: ${string(fieldRef.fieldPath)}`, source: "field" });
    else if (string(resourceFieldRef.resource)) variables.push({ name, value: `Resource: ${string(resourceFieldRef.resource)}`, source: "resourceField" });
    else {
      const literal = string(env.value);
      variables.push({ name, value: compact(literal || "(empty)", 180), source: "literal", sensitive: sensitiveEnvironmentName(name) });
    }
  }
  for (const envFromValue of array(container.envFrom)) {
    const envFrom = object(envFromValue);
    const configMap = object(envFrom.configMapRef);
    const secret = object(envFrom.secretRef);
    const prefix = string(envFrom.prefix);
    if (string(configMap.name)) variables.push({ name: `${prefix || ""}*`, value: `All keys from ConfigMap/${string(configMap.name)}`, source: "envFrom", link: { kind: "ConfigMap", name: string(configMap.name), namespace } });
    if (string(secret.name)) variables.push({ name: `${prefix || ""}*`, value: `All keys from Secret/${string(secret.name)}`, source: "envFrom", sensitive: true, link: { kind: "Secret", name: string(secret.name), namespace } });
  }
  return variables;
}

function portsFor(container: Record<string, unknown>): ContainerPort[] {
  return array(container.ports).map((entry) => {
    const port = object(entry);
    const number = string(port.containerPort || port.hostPort);
    if (!number) return null;
    return { name: string(port.name) || undefined, port: number, protocol: string(port.protocol || "TCP"), hostPort: string(port.hostPort) || undefined };
  }).filter((entry): entry is ContainerPort => Boolean(entry));
}

function volumeSources(spec: Record<string, unknown>, namespace?: string) {
  const sources = new Map<string, Omit<ContainerMount, "path" | "readOnly" | "subPath">>();
  for (const entry of array(spec.volumes)) {
    const volume = object(entry);
    const name = string(volume.name);
    if (!name) continue;
    const configMap = object(volume.configMap);
    const secret = object(volume.secret);
    const claim = object(volume.persistentVolumeClaim);
    const projected = object(volume.projected);
    const hostPath = object(volume.hostPath);
    const emptyDir = object(volume.emptyDir);
    if (string(configMap.name)) sources.set(name, { name, sourceName: string(configMap.name), sourceType: "ConfigMap", link: { kind: "ConfigMap", name: string(configMap.name), namespace } });
    else if (string(secret.secretName)) sources.set(name, { name, sourceName: string(secret.secretName), sourceType: "Secret", link: { kind: "Secret", name: string(secret.secretName), namespace } });
    else if (string(claim.claimName)) sources.set(name, { name, sourceName: string(claim.claimName), sourceType: "PVC", link: { kind: "PersistentVolumeClaim", name: string(claim.claimName), namespace } });
    else if (Object.keys(projected).length) sources.set(name, { name, sourceName: name, sourceType: "Projected" });
    else if (Object.keys(hostPath).length) sources.set(name, { name, sourceName: string(hostPath.path) || name, sourceType: "HostPath" });
    else if (Object.keys(emptyDir).length || "emptyDir" in volume) sources.set(name, { name, sourceName: name, sourceType: "EmptyDir" });
    else sources.set(name, { name, sourceName: name, sourceType: "Volume" });
  }
  return sources;
}

function mountsFor(container: Record<string, unknown>, sources: Map<string, Omit<ContainerMount, "path" | "readOnly" | "subPath">>): ContainerMount[] {
  return array(container.volumeMounts).map((entry) => {
    const mount = object(entry);
    const name = string(mount.name);
    const path = string(mount.mountPath);
    if (!name || !path) return null;
    const source = sources.get(name) ?? { name, sourceName: name, sourceType: "Volume" };
    return { ...source, path, readOnly: mount.readOnly === true, subPath: string(mount.subPath) || undefined };
  }).filter((entry): entry is ContainerMount => Boolean(entry));
}

function commandFor(container: Record<string, unknown>, key: "command" | "args") {
  const values = array(container[key]).map((entry) => string(entry)).filter(Boolean);
  return values.length ? values.join(" ") : undefined;
}

function fallbackContainers(row: ResourceRow): ContainerDetail[] {
  const fallback = row.containers?.map((container) => ({
    name: container.name,
    kind: "container" as const,
    image: container.image,
    imageId: undefined,
    pullPolicy: "IfNotPresent",
    state: container.status === "running" ? "Running" : container.status === "waiting" ? "Waiting" : container.status === "succeeded" ? "Completed" : container.status === "terminated" ? "Terminated" : "Unknown",
    ready: container.ready,
    restarts: container.restarts,
    command: typeof row.data.command === "string" ? row.data.command : undefined,
    ports: String(container.port ?? "").split(",").map((value) => value.trim()).filter(Boolean).map((value) => {
      const [number, protocol = "TCP"] = value.split("/");
      return { port: number, protocol };
    }),
    environment: typeof row.data.environment === "string" ? row.data.environment.split(",").map((item) => item.trim()).filter(Boolean).map((item) => {
      const [name, ...rest] = item.split("=");
      return { name, value: compact(rest.join("=") || "(empty)", 180), source: "literal" as const, sensitive: sensitiveEnvironmentName(name) };
    }) : [],
    mounts: typeof row.data.volumeMounts === "string" ? row.data.volumeMounts.split(",").map((item) => item.trim()).filter(Boolean).map((item) => {
      const [name, path] = item.split(":", 2);
      return { name, sourceName: name, sourceType: "Volume", path: path || "—", readOnly: false };
    }).filter((mount) => mount.path !== "—") : [],
  })) ?? [];
  return fallback;
}

export function getContainerDetailSection(row: ResourceRow): ContainerDetailSection | null {
  const spec = workloadPodSpec(row);
  const supported = ["Pod", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "ReplicationController", "Job", "CronJob"].includes(row.kind);
  if (!supported) return null;
  const status = object(detailValueAt(sourceFor(row), "status"));
  const statusByName = new Map<string, { value: Record<string, unknown>; kind: ContainerDetail["kind"] }>();
  for (const entry of array(status.initContainerStatuses)) statusByName.set(string(detailValueAt(entry, "name")), { value: object(entry), kind: "init" });
  for (const entry of array(status.containerStatuses)) statusByName.set(string(detailValueAt(entry, "name")), { value: object(entry), kind: "container" });
  for (const entry of array(status.ephemeralContainerStatuses)) statusByName.set(string(detailValueAt(entry, "name")), { value: object(entry), kind: "ephemeral" });
  const namespace = row.namespace === "—" ? undefined : row.namespace;
  const sources = volumeSources(spec, namespace);
  const collect = (value: unknown, kind: ContainerDetail["kind"]) => array(value).map((entry) => {
    const container = object(entry);
    const name = string(container.name) || "container";
    const runtime = statusByName.get(name)?.value ?? {};
    const state = row.kind === "Pod" ? containerState(runtime, kind) : { state: "Template", reason: undefined };
    const resources = object(container.resources);
    return {
      name,
      kind,
      image: string(container.image) || "—",
      imageId: string(runtime.imageID) || undefined,
      pullPolicy: string(container.imagePullPolicy) || "IfNotPresent",
      state: state.state,
      stateReason: state.reason,
      ready: runtime.ready === undefined ? undefined : runtime.ready === true,
      restarts: runtime.restartCount === undefined ? undefined : Number(runtime.restartCount) || 0,
      command: commandFor(container, "command"),
      args: commandFor(container, "args"),
      ports: portsFor(container),
      environment: environmentFor(container, namespace),
      mounts: mountsFor(container, sources),
      resourceRequests: resourceQuantityValues(resources.requests),
      resourceLimits: resourceQuantityValues(resources.limits),
    } satisfies ContainerDetail;
  });
  const containers = Object.keys(spec).length
    ? [...collect(spec.initContainers, "init"), ...collect(spec.containers, "container"), ...collect(spec.ephemeralContainers, "ephemeral")]
    : fallbackContainers(row);
  if (!containers.length) return null;
  const template = row.kind !== "Pod";
  return {
    id: "containers",
    title: template ? "Pod template containers" : "Containers",
    description: template ? "Images and runtime configuration used for Pods created by this workload." : "Runtime state and the configuration supplied to each container.",
    containers,
  };
}

function genericObjectSections(row: ResourceRow): ResourceDetailSection[] {
  const source = sourceFor(row);
  const specKeys = Object.keys(object(detailValueAt(source, "spec"))).filter((key) => !["template", "managedFields"].includes(key));
  const statusKeys = Object.keys(object(detailValueAt(source, "status"))).filter((key) => key !== "conditions");
  const fallbackKeys = Object.keys(row.data).filter((key) => !["name", "namespace", "age", "apiVersion", "kind", "uid", "resourceVersion", "labels"].includes(key));
  return nonEmpty([section("summary", "Operational summary", [
    field("Status", row.status),
    field("Spec fields", specKeys.length ? `${specKeys.slice(0, 8).join(", ")}${specKeys.length > 8 ? ` +${specKeys.length - 8} more` : ""}` : undefined, { wide: true }),
    field("Status fields", statusKeys.length ? `${statusKeys.slice(0, 8).join(", ")}${statusKeys.length > 8 ? ` +${statusKeys.length - 8} more` : ""}` : undefined, { wide: true }),
    field("Available fields", !specKeys.length && !statusKeys.length && fallbackKeys.length ? fallbackKeys.slice(0, 8).join(", ") : undefined, { wide: true }),
  ], "A concise view of fields exposed by this resource type.")]);
}

function dataSource(value: unknown): string {
  const source = object(value);
  const kind = string(source.kind);
  const name = string(source.name);
  return kind && name ? `${kind}/${name}` : "—";
}

function endpointAddresses(source: Record<string, unknown>, key: "addresses" | "notReadyAddresses") {
  const values = array(source.subsets).flatMap((subset) => array(detailValueAt(subset, key))).map((entry) => string(detailValueAt(entry, "ip"))).filter(Boolean);
  return values.length ? `${values.slice(0, 8).join(", ")}${values.length > 8 ? ` +${values.length - 8} more` : ""}` : "—";
}

function endpointSliceCount(source: Record<string, unknown>, ready: boolean) {
  return array(source.endpoints).filter((endpoint) => detailValueAt(endpoint, "conditions.ready") === ready).length;
}

function ingressBackends(spec: Record<string, unknown>) {
  const names = new Set<string>();
  const defaultService = string(detailValueAt(spec, "defaultBackend.service.name"));
  if (defaultService) names.add(defaultService);
  for (const rule of array(spec.rules)) for (const path of array(detailValueAt(rule, "http.paths"))) {
    const service = string(detailValueAt(path, "backend.service.name"));
    if (service) names.add(service);
  }
  return names.size ? [...names].join(", ") : "—";
}

function metricSummary(value: unknown): string {
  const metrics = array(value).map((entry) => {
    const metric = object(entry);
    const type = string(metric.type);
    const resource = object(metric.resource);
    const pods = object(metric.pods);
    const external = object(metric.external);
    const name = string(resource.name || pods.metric?.name || external.metric?.name || metric.containerResource?.name);
    const target = compact(detailValueAt(metric, "resource.target.averageUtilization") ?? detailValueAt(metric, "resource.target.averageValue") ?? detailValueAt(metric, "pods.target.averageValue") ?? detailValueAt(metric, "external.target.value"), 80);
    return [type, name, target === "—" ? "" : `target ${target}`].filter(Boolean).join(" · ");
  }).filter(Boolean);
  return metrics.length ? metrics.join("; ") : "—";
}

export function buildResourceDetailSections(row: ResourceRow): ResourceDetailSection[] {
  const source = sourceFor(row);
  const spec = object(detailValueAt(source, "spec"));
  const status = object(detailValueAt(source, "status"));
  const template = workloadTemplate(row);
  const templateScheduling = (title = "Pod template") => section("template", title, [
    field("Service account", template.serviceAccountName || "default"),
    field("Restart policy", template.restartPolicy),
    field("Node selector", selector(template.nodeSelector), { wide: true }),
    field("Tolerations", tolerations(template.tolerations), { wide: true }),
    field("Affinity", template.affinity ? "Configured" : undefined),
  ]);

  switch (row.kind) {
    case "Pod":
      return [];
    case "Deployment":
      return nonEmpty([
        section("rollout", "Rollout", [
          field("Desired", spec.replicas ?? String(row.data.ready ?? "").split("/").at(-1)),
          field("Ready", status.readyReplicas ?? row.data.ready),
          field("Updated", status.updatedReplicas ?? row.data.upToDate),
          field("Available", status.availableReplicas ?? row.data.available),
          field("Unavailable", status.unavailableReplicas),
          field("Progress", detailValueAt(status, "conditions.0.reason")),
        ], "Current reconciliation and availability state."),
        section("strategy", "Rollout strategy", [
          field("Strategy", detailValueAt(spec, "strategy.type") ?? "RollingUpdate"),
          field("Max surge", detailValueAt(spec, "strategy.rollingUpdate.maxSurge")),
          field("Max unavailable", detailValueAt(spec, "strategy.rollingUpdate.maxUnavailable")),
          field("Progress deadline", spec.progressDeadlineSeconds ? `${spec.progressDeadlineSeconds}s` : undefined),
          field("Selector", selector(spec.selector), { wide: true }),
        ]),
        templateScheduling(),
      ]);
    case "StatefulSet":
      return nonEmpty([
        section("rollout", "StatefulSet rollout", [
          field("Desired", spec.replicas ?? String(row.data.ready ?? "").split("/").at(-1)),
          field("Ready", status.readyReplicas ?? row.data.ready),
          field("Current", status.currentReplicas),
          field("Updated", status.updatedReplicas),
          field("Current revision", status.currentRevision),
          field("Update revision", status.updateRevision),
        ]),
        section("identity", "Stable identity and storage", [
          field("Governing service", spec.serviceName),
          field("Pod management", spec.podManagementPolicy),
          field("Update strategy", detailValueAt(spec, "updateStrategy.type")),
          field("Partition", detailValueAt(spec, "updateStrategy.rollingUpdate.partition")),
          field("PVC templates", names(array(spec.volumeClaimTemplates).map((entry) => detailValueAt(entry, "metadata.name"))), { wide: true }),
          field("Selector", selector(spec.selector), { wide: true }),
        ]),
        templateScheduling(),
      ]);
    case "DaemonSet":
      return nonEmpty([
        section("rollout", "DaemonSet rollout", [
          field("Desired", status.desiredNumberScheduled ?? row.data.desired),
          field("Current", status.currentNumberScheduled ?? row.data.current),
          field("Ready", status.numberReady ?? row.data.ready),
          field("Available", status.numberAvailable ?? row.data.available),
          field("Updated", status.updatedNumberScheduled ?? row.data.upToDate),
          field("Misscheduled", status.numberMisscheduled),
        ]),
        section("placement", "Node placement", [
          field("Update strategy", detailValueAt(spec, "updateStrategy.type")),
          field("Max unavailable", detailValueAt(spec, "updateStrategy.rollingUpdate.maxUnavailable")),
          field("Node selector", selector(template.nodeSelector), { wide: true }),
          field("Tolerations", tolerations(template.tolerations), { wide: true }),
        ]),
        templateScheduling("Pod template"),
      ]);
    case "ReplicaSet":
    case "ReplicationController":
      return nonEmpty([
        section("replicas", `${row.kind} replicas`, [
          field("Desired", spec.replicas ?? row.data.desired),
          field("Current", status.replicas ?? row.data.current),
          field("Ready", status.readyReplicas ?? row.data.ready),
          field("Available", status.availableReplicas),
          field("Fully labeled", status.fullyLabeledReplicas),
          field("Selector", selector(spec.selector), { wide: true }),
        ]),
        templateScheduling(),
      ]);
    case "Job":
      return nonEmpty([
        section("execution", "Job execution", [
          field("Completions", spec.completions),
          field("Parallelism", spec.parallelism),
          field("Active", status.active),
          field("Succeeded", status.succeeded),
          field("Failed", status.failed),
          field("Backoff limit", spec.backoffLimit),
          field("Completion mode", spec.completionMode),
          field("Deadline", spec.activeDeadlineSeconds ? `${spec.activeDeadlineSeconds}s` : undefined),
        ]),
        templateScheduling(),
      ]);
    case "CronJob":
      return nonEmpty([
        section("schedule", "Schedule", [
          field("Schedule", spec.schedule ?? row.data.schedule, { copyable: true }),
          field("Time zone", spec.timeZone),
          field("Suspended", spec.suspend === true ? "Yes" : spec.suspend === false ? "No" : row.data.suspend),
          field("Concurrency", spec.concurrencyPolicy),
          field("Starting deadline", spec.startingDeadlineSeconds ? `${spec.startingDeadlineSeconds}s` : undefined),
          field("Last schedule", status.lastScheduleTime ?? row.data.lastSchedule),
          field("Last successful", status.lastSuccessfulTime),
          field("Active jobs", Array.isArray(status.active) ? array(status.active).length : row.data.active),
        ], "Execution cadence and recent run state."),
        section("job-template", "Job template", [
          field("Successful history", spec.successfulJobsHistoryLimit),
          field("Failed history", spec.failedJobsHistoryLimit),
          field("Completions", detailValueAt(spec, "jobTemplate.spec.completions")),
          field("Parallelism", detailValueAt(spec, "jobTemplate.spec.parallelism")),
          field("Restart policy", detailValueAt(spec, "jobTemplate.spec.template.spec.restartPolicy")),
        ]),
        templateScheduling("Pod template"),
      ]);
    case "Node":
      return nonEmpty([
        section("health", "Node health", [
          field("Status", row.status),
          field("Roles", row.data.roles),
          field("Scheduling", spec.unschedulable === true ? "Cordoned" : "Schedulable"),
          field("Taints", tolerations(spec.taints), { wide: true }),
        ]),
        section("capacity", "Capacity and allocation", [
          field("CPU allocatable", detailValueAt(status, "allocatable.cpu") ?? row.data.cpu),
          field("Memory allocatable", detailValueAt(status, "allocatable.memory") ?? row.data.memory),
          field("Pod capacity", detailValueAt(status, "allocatable.pods") ?? row.data.pods),
          field("Ephemeral storage", detailValueAt(status, "allocatable.ephemeral-storage")),
        ]),
        section("system", "Node system", [
          field("Kubelet", detailValueAt(status, "nodeInfo.kubeletVersion") ?? row.data.version),
          field("Container runtime", detailValueAt(status, "nodeInfo.containerRuntimeVersion")),
          field("OS image", detailValueAt(status, "nodeInfo.osImage")),
          field("Kernel", detailValueAt(status, "nodeInfo.kernelVersion")),
          field("Architecture", detailValueAt(status, "nodeInfo.architecture")),
          field("Addresses", array(status.addresses).map((entry) => `${compact(detailValueAt(entry, "type"), 50)}: ${compact(detailValueAt(entry, "address"), 100)}`).join(" · "), { wide: true, copyable: true }),
        ]),
      ]);
    case "Namespace":
      return nonEmpty([section("lifecycle", "Namespace lifecycle", [
        field("Phase", status.phase ?? row.status),
        field("Finalizers", names(spec.finalizers), { wide: true }),
        field("Deletion requested", detailValueAt(source, "metadata.deletionTimestamp") ? "Yes" : undefined),
      ])]);
    case "Event":
      return nonEmpty([section("event", "Event signal", [
        field("Type", detailValueAt(source, "type") ?? row.data.type, { tone: String(detailValueAt(source, "type") ?? row.data.type) === "Warning" ? "amber" : "blue" }),
        field("Reason", detailValueAt(source, "reason") ?? row.name),
        field("Count", detailValueAt(source, "series.count") ?? detailValueAt(source, "deprecatedCount") ?? detailValueAt(source, "count") ?? row.data.count),
        field("Last seen", detailValueAt(source, "series.lastObservedTime") ?? detailValueAt(source, "deprecatedLastTimestamp") ?? detailValueAt(source, "lastTimestamp") ?? detailValueAt(source, "eventTime") ?? row.data.lastSeen),
        field("Regarding", detailValueAt(source, "regarding.kind") ? `${compact(detailValueAt(source, "regarding.kind"))}/${compact(detailValueAt(source, "regarding.name"))}` : detailValueAt(source, "involvedObject.kind") ? `${compact(detailValueAt(source, "involvedObject.kind"))}/${compact(detailValueAt(source, "involvedObject.name"))}` : row.data.object, { wide: true }),
        field("Message", detailValueAt(source, "note") ?? detailValueAt(source, "message") ?? row.data.message, { wide: true }),
      ], "A concise record of the Kubernetes signal and its affected object.")]);
    case "Service":
      return nonEmpty([
        section("network", "Service access", [
          field("Type", spec.type ?? row.data.type),
          field("Cluster IP", spec.clusterIP ?? row.data.clusterIp, { copyable: true }),
          field("External address", array(detailValueAt(status, "loadBalancer.ingress")).map((entry) => compact(detailValueAt(entry, "ip") ?? detailValueAt(entry, "hostname"))).filter((entry) => entry !== "—").join(", ") || array(spec.externalIPs).map((entry) => compact(entry)).filter((entry) => entry !== "—").join(", ") || row.data.externalIp, { wide: true, copyable: true }),
          field("Ports", array(spec.ports).length ? ports(spec.ports) : row.data.ports, { wide: true }),
          field("Traffic policy", spec.externalTrafficPolicy),
          field("Session affinity", spec.sessionAffinity && spec.sessionAffinity !== "None" ? spec.sessionAffinity : undefined),
        ]),
        section("routing", "Backend selection", [
          field("Selector", spec.selector ? selector(spec.selector) : row.data.selector, { wide: true }),
          field("Publish not-ready addresses", spec.publishNotReadyAddresses === true ? "Yes" : undefined),
        ]),
      ]);
    case "Endpoints":
      return nonEmpty([section("endpoints", "Endpoint health", [
        field("Ready addresses", endpointAddresses(source, "addresses") !== "—" ? endpointAddresses(source, "addresses") : row.data.addresses, { wide: true, copyable: true }),
        field("Not ready addresses", endpointAddresses(source, "notReadyAddresses"), { wide: true, copyable: true }),
        field("Ports", array(source.subsets).length ? array(source.subsets).map((entry) => ports(detailValueAt(entry, "ports"))).filter((entry) => entry !== "—").join(", ") : row.data.ports, { wide: true }),
      ], "Ready and unready backends registered for this Service.")]);
    case "EndpointSlice":
      return nonEmpty([section("endpoints", "Endpoint slice health", [
        field("Service", object(detailValueAt(source, "metadata.labels"))["kubernetes.io/service-name"]),
        field("Address type", source.addressType),
        field("Ready endpoints", endpointSliceCount(source, true)),
        field("Not ready endpoints", endpointSliceCount(source, false)),
        field("Ports", ports(source.ports), { wide: true }),
      ])]);
    case "Ingress":
      return nonEmpty([section("routing", "Ingress routing", [
        field("Class", spec.ingressClassName ?? row.data.class),
        field("Address", array(detailValueAt(status, "loadBalancer.ingress")).map((entry) => compact(detailValueAt(entry, "ip") ?? detailValueAt(entry, "hostname"))).join(", ") || row.data.address, { copyable: true }),
        field("Hosts", array(spec.rules).map((entry) => compact(detailValueAt(entry, "host"))).filter((entry) => entry !== "—").join(", ") || row.data.hosts, { wide: true }),
        field("Backend services", ingressBackends(spec), { wide: true }),
        field("TLS secrets", array(spec.tls).map((entry) => compact(detailValueAt(entry, "secretName"))).filter((entry) => entry !== "—").join(", "), { wide: true }),
      ])]);
    case "IngressClass":
      return nonEmpty([section("controller", "Ingress controller", [
        field("Controller", spec.controller ?? row.data.controller, { wide: true, copyable: true }),
        field("Parameters", dataSource(spec.parameters), { wide: true }),
      ])]);
    case "NetworkPolicy":
      return nonEmpty([section("policy", "Traffic policy", [
        field("Pod selector", spec.podSelector ? selector(spec.podSelector) : row.data.podSelector, { wide: true }),
        field("Policy types", names(spec.policyTypes) !== "—" ? names(spec.policyTypes) : row.data.policyTypes),
        field("Ingress rules", array(spec.ingress).length),
        field("Egress rules", array(spec.egress).length),
        field("Ingress peers", array(spec.ingress).reduce((count, entry) => count + array(detailValueAt(entry, "from")).length, 0)),
        field("Egress peers", array(spec.egress).reduce((count, entry) => count + array(detailValueAt(entry, "to")).length, 0)),
      ], "Which Pods are selected and how their ingress and egress are constrained.")]);
    case "PersistentVolumeClaim":
      return nonEmpty([section("claim", "Volume claim", [
        field("Phase", status.phase ?? row.status),
        field("Persistent volume", spec.volumeName ?? row.data.volume),
        field("Requested", detailValueAt(spec, "resources.requests.storage")),
        field("Capacity", detailValueAt(status, "capacity.storage") ?? row.data.capacity),
        field("Storage class", spec.storageClassName ?? row.data.storageClass),
        field("Access modes", names(status.accessModes ?? spec.accessModes) !== "—" ? names(status.accessModes ?? spec.accessModes) : row.data.accessModes),
        field("Volume mode", spec.volumeMode),
        field("Data source", dataSource(spec.dataSource)),
      ], "Binding status, requested capacity, and storage characteristics.")]);
    case "PersistentVolume":
      return nonEmpty([
        section("volume", "Persistent volume", [
          field("Phase", status.phase ?? row.status),
          field("Capacity", detailValueAt(spec, "capacity.storage") ?? row.data.capacity),
          field("Access modes", names(spec.accessModes) !== "—" ? names(spec.accessModes) : row.data.accessModes),
          field("Reclaim policy", spec.persistentVolumeReclaimPolicy ?? row.data.reclaimPolicy),
          field("Storage class", spec.storageClassName ?? row.data.storageClass),
          field("Bound claim", spec.claimRef ? `${compact(detailValueAt(spec, "claimRef.namespace"))}/${compact(detailValueAt(spec, "claimRef.name"))}` : row.data.claim),
          field("Volume mode", spec.volumeMode),
        ]),
        section("source", "Storage source", [
          field("CSI driver", detailValueAt(spec, "csi.driver")),
          field("Volume handle", detailValueAt(spec, "csi.volumeHandle"), { wide: true, copyable: true }),
          field("NFS server", detailValueAt(spec, "nfs.server")),
          field("NFS path", detailValueAt(spec, "nfs.path"), { wide: true }),
          field("Local path", detailValueAt(spec, "local.path"), { wide: true }),
        ]),
      ]);
    case "StorageClass":
      return nonEmpty([section("provisioning", "Dynamic provisioning", [
        field("Provisioner", source.provisioner ?? row.data.provisioner, { wide: true, copyable: true }),
        field("Reclaim policy", source.reclaimPolicy ?? row.data.reclaimPolicy),
        field("Binding mode", source.volumeBindingMode ?? row.data.bindingMode),
        field("Allow expansion", source.allowVolumeExpansion ?? row.data.allowExpansion),
        field("Mount options", names(source.mountOptions), { wide: true }),
        field("Parameters", compactObject(source.parameters), { wide: true }),
      ])]);
    case "ConfigMap":
      return nonEmpty([section("data", "ConfigMap data", [
        field("Entries", Object.keys(object(source.data)).length || row.data.data),
        field("Binary entries", Object.keys(object(source.binaryData)).length),
        field("Immutable", source.immutable === true ? "Yes" : undefined),
        field("Keys", Object.keys(object(source.data)).join(", "), { wide: true, copyable: true }),
      ], "Keys are shown here; inspect the manifest to view configuration values.")]);
    case "Secret":
      return nonEmpty([section("data", "Secret data", [
        field("Type", source.type ?? row.data.type),
        field("Entries", Object.keys(object(source.data)).length || row.data.data),
        field("Immutable", source.immutable === true ? "Yes" : undefined),
        field("Keys", Object.keys(object(source.data)).join(", "), { wide: true }),
        field("Values", "Never shown in the detail drawer", { wide: true, tone: "amber" }),
      ], "Secret values remain masked; only their operational references are exposed.")]);
    case "ResourceQuota":
      return nonEmpty([section("quota", "Quota usage", [
        field("Hard limits", resourceQuantities(status.hard ?? spec.hard ?? row.data.limits), { wide: true }),
        field("Current usage", resourceQuantities(status.used ?? row.data.requests), { wide: true }),
        field("Scopes", names(spec.scopes), { wide: true }),
      ])]);
    case "LimitRange": {
      const limits = array(spec.limits);
      return nonEmpty([section("limits", "Default resource limits", limits.length ? limits.slice(0, 3).flatMap((entry, index) => [
        field(`Rule ${index + 1}`, detailValueAt(entry, "type")),
        field(`Default ${index + 1}`, resourceQuantities(detailValueAt(entry, "default")), { wide: true }),
        field(`Request ${index + 1}`, resourceQuantities(detailValueAt(entry, "defaultRequest")), { wide: true }),
        field(`Min / max ${index + 1}`, `${resourceQuantities(detailValueAt(entry, "min"))} / ${resourceQuantities(detailValueAt(entry, "max"))}`, { wide: true }),
      ]) : [
        field("Type", row.data.type), field("Default", row.data.default, { wide: true }), field("Minimum", row.data.min, { wide: true }), field("Maximum", row.data.max, { wide: true }),
      ])]);
    }
    case "HorizontalPodAutoscaler":
      return nonEmpty([section("autoscaling", "Horizontal autoscaling", [
        field("Target", detailValueAt(spec, "scaleTargetRef.kind") ? `${compact(detailValueAt(spec, "scaleTargetRef.kind"))}/${compact(detailValueAt(spec, "scaleTargetRef.name"))}` : row.data.reference),
        field("Current / desired", `${compact(status.currentReplicas ?? row.data.replicas)} / ${compact(status.desiredReplicas ?? row.data.replicas)}`),
        field("Minimum", spec.minReplicas ?? row.data.minPods ?? 1),
        field("Maximum", spec.maxReplicas ?? row.data.maxPods),
        field("Metrics", metricSummary(spec.metrics) !== "—" ? metricSummary(spec.metrics) : row.data.targets, { wide: true }),
        field("Current metrics", metricSummary(status.currentMetrics), { wide: true }),
        field("Last scale", status.lastScaleTime),
      ], "Scale target, replica range, and the metrics driving decisions.")]);
    case "VerticalPodAutoscaler":
      return nonEmpty([section("autoscaling", "Vertical autoscaling", [
        field("Target", detailValueAt(spec, "targetRef.kind") ? `${compact(detailValueAt(spec, "targetRef.kind"))}/${compact(detailValueAt(spec, "targetRef.name"))}` : row.data.reference),
        field("Update mode", detailValueAt(spec, "updatePolicy.updateMode") ?? row.data.mode),
        field("Minimum replicas", detailValueAt(spec, "updatePolicy.minReplicas")),
        field("Container policies", array(detailValueAt(spec, "resourcePolicy.containerPolicies")).length),
        field("Recommendations", array(detailValueAt(status, "recommendation.containerRecommendations")).length),
      ])]);
    case "PodDisruptionBudget":
      return nonEmpty([section("availability", "Disruption budget", [
        field("Minimum available", spec.minAvailable ?? row.data.minAvailable),
        field("Maximum unavailable", spec.maxUnavailable ?? row.data.maxUnavailable),
        field("Current healthy", status.currentHealthy),
        field("Desired healthy", status.desiredHealthy),
        field("Expected Pods", status.expectedPods),
        field("Allowed disruptions", status.disruptionsAllowed ?? row.data.allowedDisruptions),
        field("Selector", selector(spec.selector), { wide: true }),
      ])]);
    case "PriorityClass":
      return nonEmpty([section("priority", "Scheduling priority", [
        field("Value", source.value ?? row.data.value),
        field("Global default", source.globalDefault ?? row.data.globalDefault),
        field("Preemption policy", source.preemptionPolicy ?? row.data.preemptionPolicy),
        field("Description", source.description, { wide: true }),
      ])]);
    case "RuntimeClass":
      return nonEmpty([section("runtime", "Container runtime", [
        field("Handler", source.handler ?? row.data.handler, { copyable: true }),
        field("Overhead", resourceQuantities(detailValueAt(source, "overhead.podFixed")), { wide: true }),
        field("Node selector", selector(detailValueAt(source, "scheduling.nodeSelector")), { wide: true }),
        field("Tolerations", tolerations(detailValueAt(source, "scheduling.tolerations")), { wide: true }),
      ])]);
    case "Lease":
      return nonEmpty([section("lease", "Lease state", [
        field("Holder", spec.holderIdentity ?? row.data.holder),
        field("Renew time", spec.renewTime ?? row.data.renewTime),
        field("Lease duration", spec.leaseDurationSeconds ? `${spec.leaseDurationSeconds}s` : undefined),
        field("Acquire time", spec.acquireTime),
        field("Transitions", spec.leaseTransitions),
      ])]);
    case "MutatingWebhookConfiguration":
    case "ValidatingWebhookConfiguration":
      return nonEmpty([section("webhooks", "Admission webhooks", [
        field("Webhooks", array(source.webhooks).length || row.data.webhooks),
        field("Names", names(array(source.webhooks).map((entry) => detailValueAt(entry, "name"))), { wide: true }),
        field("Failure policies", names(array(source.webhooks).map((entry) => detailValueAt(entry, "failurePolicy"))) !== "—" ? names(array(source.webhooks).map((entry) => detailValueAt(entry, "failurePolicy"))) : row.data.failurePolicy),
        field("Timeouts", names(array(source.webhooks).map((entry) => detailValueAt(entry, "timeoutSeconds"))), { wide: true }),
      ])]);
    case "ServiceAccount":
      return nonEmpty([section("identity", "Service account", [
        field("Automount token", source.automountServiceAccountToken === undefined ? "Inherited" : source.automountServiceAccountToken ? "Enabled" : "Disabled"),
        field("Image pull secrets", names(array(source.imagePullSecrets).map((entry) => detailValueAt(entry, "name"))), { wide: true }),
        field("Referenced secrets", array(source.secrets).length || row.data.secrets),
      ])]);
    case "Role":
    case "ClusterRole":
      return nonEmpty([section("permissions", "RBAC permissions", [
        field("Rules", array(source.rules).length || row.data.rules),
        field("Resources", names(Array.from(new Set(array(source.rules).flatMap((entry) => array(detailValueAt(entry, "resources")).map(string)))), 10), { wide: true }),
        field("Verbs", names(Array.from(new Set(array(source.rules).flatMap((entry) => array(detailValueAt(entry, "verbs")).map(string)))), 10), { wide: true }),
        field("Aggregation selectors", array(detailValueAt(source, "aggregationRule.clusterRoleSelectors")).length),
      ])]);
    case "RoleBinding":
    case "ClusterRoleBinding":
      return nonEmpty([section("binding", "RBAC binding", [
        field("Granted role", detailValueAt(source, "roleRef.kind") ? `${compact(detailValueAt(source, "roleRef.kind"))}/${compact(detailValueAt(source, "roleRef.name"))}` : row.data.role),
        field("Subjects", names(array(source.subjects).map((entry) => {
          const subject = object(entry);
          return `${string(subject.kind)}/${string(subject.namespace) ? `${string(subject.namespace)}/` : ""}${string(subject.name)}`;
        })) !== "—" ? names(array(source.subjects).map((entry) => {
          const subject = object(entry);
          return `${string(subject.kind)}/${string(subject.namespace) ? `${string(subject.namespace)}/` : ""}${string(subject.name)}`;
        })) : row.data.subjects, { wide: true }),
      ])]);
    case "PodSecurityPolicy":
      return nonEmpty([section("security", "Pod security policy", [
        field("Privileged", spec.privileged ?? row.data.privileged),
        field("Allow escalation", spec.allowPrivilegeEscalation),
        field("Host namespaces", [spec.hostNetwork ? "network" : "", spec.hostPID ? "PID" : "", spec.hostIPC ? "IPC" : ""].filter(Boolean).join(", ") || "None"),
        field("Run as user", detailValueAt(spec, "runAsUser.rule") ?? row.data.runAsUser),
        field("Allowed volumes", names(spec.volumes) !== "—" ? names(spec.volumes) : row.data.volumes, { wide: true }),
      ])]);
    case "CustomResourceDefinition":
      return nonEmpty([section("definition", "Custom resource definition", [
        field("Group", spec.group ?? row.data.group),
        field("Resource kind", detailValueAt(spec, "names.kind") ?? row.data.kind),
        field("Scope", spec.scope ?? row.data.scope),
        field("Storage version", array(spec.versions).find((entry) => detailValueAt(entry, "storage") === true) ? detailValueAt(array(spec.versions).find((entry) => detailValueAt(entry, "storage") === true), "name") : undefined),
        field("Served versions", names(array(spec.versions).filter((entry) => detailValueAt(entry, "served") !== false).map((entry) => detailValueAt(entry, "name"))) !== "—" ? names(array(spec.versions).filter((entry) => detailValueAt(entry, "served") !== false).map((entry) => detailValueAt(entry, "name"))) : row.data.versions, { wide: true }),
        field("Instances", row.data.instances),
      ], "API-specific fields are retained here because they define this resource type.")]);
    case "HelmChart":
      return nonEmpty([section("chart", "Helm chart", [
        field("Repository", row.data.repository, { wide: true, copyable: true }),
        field("Chart version", row.data.version),
        field("Application version", row.data.appVersion),
        field("Description", row.data.description, { wide: true }),
      ])]);
    case "HelmRelease":
      return nonEmpty([section("release", "Helm release", [
        field("Chart", row.data.chart),
        field("Status", row.data.status),
        field("Revision", row.data.revision),
        field("Application version", row.data.appVersion),
        field("Updated", row.data.updated),
      ])]);
    case "PortForward":
      return nonEmpty([section("forward", "Port forwarding", [
        field("Local address", row.data.localAddress ?? `${compact(row.data.host ?? "localhost")}:${compact(row.data.localPort)}`, { copyable: true }),
        field("Service port", row.data.servicePort),
        field("Target Pod port", row.data.targetPort),
        field("Endpoint Pod", row.data.resolvedPod),
        field("Protocol", row.data.protocol),
        field("Status", row.status),
        field("Last error", row.data.error, { wide: true }),
      ])]);
    default:
      return genericObjectSections(row);
  }
}

export type ResourceDataEntry = {
  key: string;
  encoded?: string;
  decoded: string;
  source: "data" | "binaryData" | "stringData";
};

function decodeBase64(value: string): string {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "Unable to decode this value";
  }
}

export function getResourceDataEntries(row?: ResourceRow): ResourceDataEntry[] {
  if (!row || !["ConfigMap", "Secret"].includes(row.kind)) return [];
  const source = sourceFor(row);
  const data = object(detailValueAt(source, "data"));
  const binaryData = object(detailValueAt(source, "binaryData"));
  const stringData = object(detailValueAt(source, "stringData"));
  const entries: ResourceDataEntry[] = [];
  for (const [key, value] of Object.entries(data)) {
    const text = string(value);
    entries.push(row.kind === "Secret" ? { key, encoded: text, decoded: decodeBase64(text), source: "data" } : { key, decoded: text, source: "data" });
  }
  for (const [key, value] of Object.entries(binaryData)) {
    const text = string(value);
    entries.push({ key, encoded: text, decoded: decodeBase64(text), source: "binaryData" });
  }
  for (const [key, value] of Object.entries(stringData)) entries.push({ key, decoded: string(value), source: "stringData" });
  return entries.sort((left, right) => left.key.localeCompare(right.key));
}

export function getResourceConditions(row?: ResourceRow): ResourceCondition[] {
  if (!row?.backend) return row?.status ? [{ type: row.status, status: row.status === "Running" || row.status === "Ready" || row.status === "Bound" ? "True" : "Unknown", reason: "Observed status", message: "Status from the current resource snapshot.", lastTransition: String(row.data.age ?? "—") }] : [];
  return array(detailValueAt(row.backend.object, "status.conditions")).map((condition) => ({
    type: compact(detailValueAt(condition, "type")),
    status: compact(detailValueAt(condition, "status")),
    reason: compact(detailValueAt(condition, "reason")),
    message: compact(detailValueAt(condition, "message"), 400),
    lastTransition: compact(detailValueAt(condition, "lastTransitionTime") ?? detailValueAt(condition, "lastProbeTime")),
  }));
}

function labelsFromString(value: unknown): Record<string, string> {
  if (typeof value !== "string") return {};
  return Object.fromEntries(value.split(",").map((entry) => entry.trim().split("=", 2)).filter((entry): entry is [string, string] => entry.length === 2 && Boolean(entry[0])));
}

export type ResourceProperty = {
  label: string;
  value: string;
  copyable?: boolean;
  tone?: "neutral" | "green" | "amber" | "red" | "blue";
  link?: ResourceDetailLink;
};

function resourceStatusTone(status: string): ResourceProperty["tone"] {
  const normalized = status.toLowerCase();
  if (/(running|ready|active|bound|complete|healthy|normal)/.test(normalized)) return "green";
  if (/(failed|failure|error|crash|notready|degraded)/.test(normalized)) return "red";
  if (/(pending|waiting|terminat|unknown|suspend)/.test(normalized)) return "amber";
  return "neutral";
}

export function getResourceStatusValue(row: ResourceRow): string {
  const status = object(detailValueAt(sourceFor(row), "status"));
  return string(status.phase || status.status || row.status) || "Unknown";
}

export function getResourceStatusReason(row: ResourceRow): string {
  const status = object(detailValueAt(sourceFor(row), "status"));
  return string(status.reason || row.data.reason);
}

export function isFailedPodPhase(row: ResourceRow): boolean {
  if (row.kind !== "Pod") return false;
  const status = object(detailValueAt(sourceFor(row), "status"));
  return string(status.phase) === "Failed";
}

export function getResourceStatusProperties(row: ResourceRow): ResourceProperty[] {
  const status = object(detailValueAt(sourceFor(row), "status"));
  const value = getResourceStatusValue(row);
  const reason = getResourceStatusReason(row);
  const message = string(status.message || row.data.message) || "—";
  const failed = row.kind === "Pod" ? isFailedPodPhase(row) : /(failed|failure|error)/.test(value.toLowerCase());
  const fields: ResourceProperty[] = row.kind === "Pod" ? [] : [{ label: "Status", value, tone: resourceStatusTone(value) }];
  if (failed) {
    if (row.kind === "Pod") fields.push({ label: "Message", value: message, copyable: true });
    else fields.push(
      { label: "Reason", value: reason || "—" },
      { label: "Message", value: message, copyable: true },
    );
  }
  return fields;
}

export function getResourceProperties(row: ResourceRow): ResourceProperty[] {
  const source = sourceFor(row);
  const spec = object(detailValueAt(source, "spec"));
  const status = object(detailValueAt(source, "status"));
  const namespace = row.namespace === "—" ? undefined : row.namespace;
  const properties: ResourceProperty[] = [
    { label: "Name", value: row.name, copyable: true },
    ...(namespace ? [{ label: "Namespace", value: namespace, copyable: true, link: { kind: "Namespace", name: namespace } }] : []),
  ];
  if (row.kind === "Pod") {
    const owner = array(detailValueAt(source, "metadata.ownerReferences")).map(object).find((entry) => entry.controller === true) ?? object(array(detailValueAt(source, "metadata.ownerReferences"))[0]);
    const ownerKind = string(owner.kind);
    const ownerName = string(owner.name);
    const node = string(spec.nodeName || row.data.node);
    const serviceAccount = string(spec.serviceAccountName || row.data.serviceAccount || "default");
    properties.push(
      { label: "Pod IP", value: string(status.podIP || row.data.ip) || "—", copyable: true },
    );
    if (ownerKind && ownerName) properties.push({ label: "Controlled by", value: `${ownerKind}/${ownerName}`, link: { kind: ownerKind, name: ownerName, namespace, apiVersion: string(owner.apiVersion) || undefined } });
    if (node && node !== "—") properties.push({ label: "Node", value: node, copyable: true, link: { kind: "Node", name: node } });
    if (serviceAccount) properties.push({ label: "Service account", value: serviceAccount, copyable: true, link: { kind: "ServiceAccount", name: serviceAccount, namespace } });
  } else {
    if (row.backend?.createdAt) properties.push({ label: "Created", value: new Date(row.backend.createdAt).toLocaleString() });
  }
  return properties.filter((entry) => entry.value && entry.value !== "—");
}

export function getResourceLabels(row?: ResourceRow): Record<string, string> {
  if (!row) return {};
  const values = object(detailValueAt(row.backend?.object, "metadata.labels"));
  if (row.backend) return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, compact(value, 180)]));
  if (Object.keys(values).length) return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, compact(value, 180)]));
  const fallback = labelsFromString(row.data.labels);
  return Object.keys(fallback).length ? fallback : { app: row.name };
}

export function getResourceAnnotations(row?: ResourceRow): Record<string, string> {
  if (!row?.backend) return {};
  // This client-side apply payload can be megabytes long and is useful only in
  // the manifest editor; keeping it out of the Sheet preserves operational signal.
  const omitted = new Set(["kubectl.kubernetes.io/last-applied-configuration"]);
  return Object.fromEntries(Object.entries(object(detailValueAt(row.backend.object, "metadata.annotations")))
    .filter(([key]) => !omitted.has(key))
    .map(([key, value]) => [key, compact(value, 480)]));
}
