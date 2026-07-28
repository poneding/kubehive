import type { ApiResourceDescriptor, BackendResourceRecord } from "./backend";
import type { ContainerInfo, ResourceLink, ResourceRow } from "./resource-catalog";

const get = (value: unknown, path: string): unknown => path.split(".").reduce<unknown>((current, part) => {
  if (current === null || typeof current !== "object") return undefined;
  return (current as Record<string, unknown>)[part];
}, value);

const array = (value: unknown) => Array.isArray(value) ? value : [];
const object = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, fallback = "—") => value === undefined || value === null || value === "" ? fallback : typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value);
const number = (value: unknown, fallback = 0) => typeof value === "number" ? value : Number(value) || fallback;
const join = (value: unknown, mapper: (entry: Record<string, unknown>) => string, fallback = "—") => {
  const values = array(value).map((entry) => mapper(object(entry))).filter(Boolean);
  return values.length ? values.join(", ") : fallback;
};
const labels = (value: unknown) => Object.entries(object(value)).map(([key, val]) => `${key}=${text(val, "")}`).join(", ") || "—";
const selector = (value: unknown) => labels(get(value, "matchLabels") ?? value);

export function formatAge(seconds?: number | null) {
  if (seconds === undefined || seconds === null || seconds < 0) return "—";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 31_536_000) return `${Math.floor(seconds / 86_400)}d`;
  return `${Math.floor(seconds / 31_536_000)}y`;
}

function containerInfo(record: BackendResourceRecord): ContainerInfo[] {
  const specs = [...array(get(record.object, "spec.initContainers")), ...array(get(record.object, "spec.containers"))].map(object);
  const statuses = [...array(get(record.object, "status.initContainerStatuses")), ...array(get(record.object, "status.containerStatuses"))].map(object);
  return specs.map((spec) => {
    const name = text(spec.name, "container");
    const status = statuses.find((entry) => entry.name === name) ?? {};
    const state = object(status.state);
    const statusName: ContainerInfo["status"] = state.running ? "running" : state.waiting ? "waiting" : state.terminated ? "terminated" : "unknown";
    return {
      name,
      status: statusName,
      image: text(spec.image),
      ready: Boolean(status.ready),
      restarts: number(status.restartCount),
      port: join(spec.ports, (port) => `${text(port.containerPort, "")}/${text(port.protocol, "TCP")}`),
    };
  });
}

function readyCondition(record: BackendResourceRecord) {
  if (record.kind === "Node") {
    const ready = array(get(record.object, "status.conditions")).map(object).find((entry) => entry.type === "Ready");
    return ready?.status === "True" ? "Ready" : "NotReady";
  }
  return undefined;
}

export function statusForRecord(record: BackendResourceRecord, containers = containerInfo(record)): string {
  const explicit = readyCondition(record);
  if (explicit) return explicit;
  if (record.kind === "Event") return text(get(record.object, "type"), "Normal");
  if (record.kind === "Deployment" || record.kind === "StatefulSet" || record.kind === "ReplicaSet" || record.kind === "ReplicationController") {
    const desired = number(get(record.object, "spec.replicas"), 1);
    const ready = number(get(record.object, "status.readyReplicas"));
    return ready >= desired ? "Ready" : ready === 0 ? "NotReady" : "Degraded";
  }
  if (record.kind === "DaemonSet") {
    const desired = number(get(record.object, "status.desiredNumberScheduled"));
    const ready = number(get(record.object, "status.numberReady"));
    return ready >= desired ? "Ready" : ready === 0 ? "NotReady" : "Degraded";
  }
  if (record.kind === "Job") {
    if (number(get(record.object, "status.failed")) > 0) return "Failed";
    if (number(get(record.object, "status.succeeded")) > 0) return "Complete";
    return number(get(record.object, "status.active")) > 0 ? "Running" : "Pending";
  }
  if (record.kind === "Pod") {
    const waiting = containers.find((container) => container.status === "waiting");
    if (waiting) {
      const status = array(get(record.object, "status.containerStatuses")).map(object).find((entry) => entry.name === waiting.name);
      return text(get(status, "state.waiting.reason"), "Pending");
    }
  }
  const phase = get(record.object, "status.phase");
  if (phase) return text(phase);
  const conditions = array(get(record.object, "status.conditions")).map(object);
  const ready = conditions.find((condition) => condition.type === "Ready" || condition.type === "Available");
  if (ready) return ready.status === "True" ? "Ready" : text(ready.reason, "NotReady");
  if (get(record.object, "metadata.deletionTimestamp")) return "Terminating";
  return "Active";
}

function ownerLink(record: BackendResourceRecord): ResourceLink | undefined {
  const owner = object(array(get(record.object, "metadata.ownerReferences"))[0]);
  const kind = text(owner.kind, "");
  const name = text(owner.name, "");
  if (!kind || !name) return undefined;
  return { kind, name, namespace: record.namespace === "—" ? undefined : record.namespace, relation: "controller" };
}

function linksForRecord(record: BackendResourceRecord): ResourceRow["links"] {
  const links: Partial<Record<string, ResourceLink>> = {};
  if (record.namespace !== "—") links.namespace = { kind: "Namespace", name: record.namespace, relation: "namespace" };
  const owner = ownerLink(record);
  if (owner) links.controlledBy = owner;
  const node = text(get(record.object, "spec.nodeName"), "");
  if (node) links.node = { kind: "Node", name: node, relation: "node" };
  const claim = text(get(record.object, "spec.claimRef.name"), "");
  const claimNs = text(get(record.object, "spec.claimRef.namespace"), "");
  if (claim) links.claim = { kind: "PersistentVolumeClaim", name: claim, namespace: claimNs || undefined, relation: "claim" };
  const roleKind = text(get(record.object, "roleRef.kind"), "");
  const roleName = text(get(record.object, "roleRef.name"), "");
  if (roleKind && roleName) links.role = { kind: roleKind, name: roleName, namespace: record.namespace === "—" ? undefined : record.namespace, relation: "role" };
  return links;
}

function commonData(record: BackendResourceRecord, containers: ContainerInfo[], status: string) {
  const spec = object(get(record.object, "spec"));
  const resourceStatus = object(get(record.object, "status"));
  const metadata = object(get(record.object, "metadata"));
  const desired = number(spec.replicas, number(resourceStatus.desiredNumberScheduled));
  const ready = number(resourceStatus.readyReplicas, number(resourceStatus.numberReady));
  const ports = get(record.object, "spec.ports");
  const ingress = array(get(record.object, "status.loadBalancer.ingress")).map(object);
  const owner = ownerLink(record);
  const data: Record<string, string | number> = {
    name: record.name,
    namespace: record.namespace,
    status,
    age: formatAge(record.ageSeconds),
    containers: containers.length ? `${containers.filter((container) => container.ready).length}/${containers.length}` : number(get(record.object, "spec.template.spec.containers.length")),
    restarts: containers.reduce((sum, container) => sum + container.restarts, 0),
    node: text(spec.nodeName),
    controlledBy: owner ? `${owner.kind}/${owner.name}` : "—",
    ip: text(resourceStatus.podIP),
    ready: desired || ready ? `${ready}/${desired}` : text(resourceStatus.ready),
    desired,
    current: number(resourceStatus.currentReplicas, number(resourceStatus.currentNumberScheduled)),
    upToDate: number(resourceStatus.updatedReplicas, number(resourceStatus.updatedNumberScheduled)),
    available: number(resourceStatus.availableReplicas, number(resourceStatus.numberAvailable)),
    images: join(get(record.object, "spec.template.spec.containers") ?? spec.containers, (entry) => text(entry.image, "")),
    labels: labels(metadata.labels),
    type: text(spec.type ?? get(record.object, "type")),
    clusterIp: text(spec.clusterIP),
    externalIp: ingress.length ? ingress.map((entry) => text(entry.ip ?? entry.hostname, "")).filter(Boolean).join(", ") : join(spec.externalIPs, (entry) => text(entry, "")),
    ports: join(ports, (port) => `${text(port.port, "")}${port.nodePort ? `:${text(port.nodePort, "")}` : ""}/${text(port.protocol, "TCP")}`),
    selector: selector(spec.selector),
    schedule: text(spec.schedule),
    suspend: text(spec.suspend),
    active: array(resourceStatus.active).length,
    lastSchedule: text(resourceStatus.lastScheduleTime),
    capacity: text(get(record.object, "status.capacity.storage") ?? get(record.object, "spec.capacity.storage") ?? get(record.object, "status.capacity")),
    storageClass: text(spec.storageClassName),
    accessModes: array(spec.accessModes).join(", ") || "—",
    volume: text(spec.volumeName),
    reclaimPolicy: text(spec.persistentVolumeReclaimPolicy ?? spec.reclaimPolicy),
    claim: text(get(record.object, "spec.claimRef.namespace"), "") && text(get(record.object, "spec.claimRef.name"), "") ? `${text(get(record.object, "spec.claimRef.namespace"), "")}/${text(get(record.object, "spec.claimRef.name"), "")}` : "—",
    provisioner: text(spec.provisioner),
    bindingMode: text(spec.volumeBindingMode),
    allowExpansion: text(spec.allowVolumeExpansion),
    data: Object.keys(object(get(record.object, "data"))).length,
    rules: array(get(record.object, "rules")).length,
    subjects: join(get(record.object, "subjects"), (subject) => `${text(subject.kind, "")}/${text(subject.namespace, "") ? `${text(subject.namespace, "")}/` : ""}${text(subject.name, "")}`),
    role: text(get(record.object, "roleRef.kind"), "") && text(get(record.object, "roleRef.name"), "") ? `${text(get(record.object, "roleRef.kind"), "")}/${text(get(record.object, "roleRef.name"), "")}` : "—",
  };
  return data;
}

function enrichData(record: BackendResourceRecord, data: Record<string, string | number>) {
  const spec = object(get(record.object, "spec"));
  const status = object(get(record.object, "status"));
  switch (record.kind) {
    case "Node": {
      const nodeLabels = object(get(record.object, "metadata.labels"));
      data.roles = Object.keys(nodeLabels).filter((key) => key.startsWith("node-role.kubernetes.io/")).map((key) => key.split("/")[1] || "worker").join(", ") || "worker";
      data.version = text(get(record.object, "status.nodeInfo.kubeletVersion"));
      data.pods = text(get(record.object, "status.allocatable.pods"));
      data.cpu = text(get(record.object, "status.capacity.cpu"));
      data.memory = text(get(record.object, "status.capacity.memory"));
      break;
    }
    case "Event":
      data.name = text(get(record.object, "reason"), record.name);
      data.type = text(get(record.object, "type"));
      data.object = `${text(get(record.object, "involvedObject.kind"), "Object")}/${text(get(record.object, "involvedObject.name"), "unknown")}`;
      data.message = text(get(record.object, "message"));
      data.count = number(get(record.object, "count"), 1);
      data.lastSeen = text(get(record.object, "eventTime") ?? get(record.object, "lastTimestamp"));
      break;
    case "DaemonSet": data.nodeSelector = selector(get(record.object, "spec.template.spec.nodeSelector")); break;
    case "Job":
      data.completions = `${number(status.succeeded)}/${number(spec.completions, 1)}`;
      data.duration = text(status.completionTime);
      break;
    case "CronJob": data.lastSchedule = text(status.lastScheduleTime); break;
    case "Endpoints":
      data.addresses = join(get(record.object, "subsets"), (subset) => array(subset.addresses).map((address) => text(get(address, "ip"), "")).filter(Boolean).join(", "));
      data.ports = join(get(record.object, "subsets"), (subset) => array(subset.ports).map((port) => `${text(get(port, "port"), "")}/${text(get(port, "protocol"), "TCP")}`).join(", "));
      break;
    case "Ingress":
      data.class = text(spec.ingressClassName);
      data.hosts = join(spec.rules, (rule) => text(rule.host, ""));
      data.address = join(get(record.object, "status.loadBalancer.ingress"), (entry) => text(entry.ip ?? entry.hostname, ""));
      data.ports = array(spec.tls).length ? "80, 443" : "80";
      break;
    case "IngressClass": data.controller = text(spec.controller); data.parameters = text(spec.parameters); break;
    case "NetworkPolicy": data.podSelector = selector(spec.podSelector); data.policyTypes = array(spec.policyTypes).join(", ") || "—"; break;
    case "PersistentVolumeClaim": data.capacity = text(get(record.object, "status.capacity.storage") ?? get(record.object, "spec.resources.requests.storage")); break;
    case "ResourceQuota": data.requests = text(get(record.object, "status.used")); data.limits = text(get(record.object, "status.hard")); break;
    case "LimitRange": {
      const limit = object(array(spec.limits)[0]); data.type = text(limit.type); data.min = text(limit.min); data.max = text(limit.max); data.default = text(limit.default); break;
    }
    case "HorizontalPodAutoscaler":
      data.reference = `${text(get(record.object, "spec.scaleTargetRef.kind"), "")}/${text(get(record.object, "spec.scaleTargetRef.name"), "")}`;
      data.targets = join(get(record.object, "status.currentMetrics"), (metric) => text(metric.resource ?? metric.pods ?? metric.external, ""));
      data.minPods = number(spec.minReplicas); data.maxPods = number(spec.maxReplicas); data.replicas = number(status.currentReplicas); break;
    case "VerticalPodAutoscaler": data.reference = `${text(get(record.object, "spec.targetRef.kind"), "")}/${text(get(record.object, "spec.targetRef.name"), "")}`; data.mode = text(get(record.object, "spec.updatePolicy.updateMode")); break;
    case "PodDisruptionBudget": data.minAvailable = text(spec.minAvailable); data.maxUnavailable = text(spec.maxUnavailable); data.allowedDisruptions = number(status.disruptionsAllowed); break;
    case "PriorityClass": data.value = number(get(record.object, "value")); data.globalDefault = text(get(record.object, "globalDefault")); data.preemptionPolicy = text(get(record.object, "preemptionPolicy")); break;
    case "RuntimeClass": data.handler = text(get(record.object, "handler")); data.overhead = text(get(record.object, "overhead")); data.scheduling = text(get(record.object, "scheduling")); break;
    case "Lease": data.holder = text(get(record.object, "spec.holderIdentity")); data.renewTime = text(get(record.object, "spec.renewTime")); break;
    case "MutatingWebhookConfiguration":
    case "ValidatingWebhookConfiguration": data.webhooks = array(get(record.object, "webhooks")).length; data.failurePolicy = join(get(record.object, "webhooks"), (webhook) => text(webhook.failurePolicy, "")); break;
    case "ServiceAccount": data.secrets = array(get(record.object, "secrets")).length; break;
    case "ClusterRole": data.aggregation = labels(get(record.object, "aggregationRule.clusterRoleSelectors.0.matchLabels")); break;
    case "PodSecurityPolicy": data.privileged = text(spec.privileged); data.volumes = array(spec.volumes).join(", ") || "—"; data.runAsUser = text(get(record.object, "spec.runAsUser.rule")); break;
    case "CustomResourceDefinition":
      data.group = text(spec.group); data.kind = text(get(record.object, "spec.names.kind")); data.scope = text(spec.scope); data.versions = join(spec.versions, (version) => text(version.name, "")); data.instances = "Open to load"; break;
    default: break;
  }
}

export function rowFromBackend(record: BackendResourceRecord, descriptor: ApiResourceDescriptor): ResourceRow {
  const containers = containerInfo(record);
  const status = statusForRecord(record, containers);
  const data = commonData(record, containers, status);
  enrichData(record, data);
  return {
    key: record.key,
    name: record.name,
    namespace: record.namespace,
    kind: record.kind,
    status,
    data,
    containers,
    links: linksForRecord(record),
    backend: record,
    descriptor,
  };
}

export function valueFromJsonPath(value: unknown, jsonPath: string) {
  const normalized = jsonPath.replace(/^\.?/, "").replace(/\[(\d+)\]/g, ".$1");
  const result = get(value, normalized);
  if (Array.isArray(result)) return result.map((entry) => text(entry, "")).join(", ") || "—";
  return text(result);
}

export function crdDefinitionFromRecord(record: BackendResourceRecord) {
  const versions = array(get(record.object, "spec.versions")).map(object);
  const preferred = versions.find((version) => version.storage === true) ?? versions.find((version) => version.served === true) ?? versions[0] ?? {};
  const group = text(get(record.object, "spec.group"), "");
  const kind = text(get(record.object, "spec.names.kind"), record.name);
  const plural = text(get(record.object, "spec.names.plural"), `${kind.toLowerCase()}s`);
  const scope = text(get(record.object, "spec.scope"), "Namespaced") as "Namespaced" | "Cluster";
  const version = text(preferred.name, "v1");
  return {
    name: record.name,
    group,
    version,
    kind,
    plural,
    scope,
    instances: 0,
    age: formatAge(record.ageSeconds),
    printerColumns: array(preferred.additionalPrinterColumns).map(object).filter((column) => number(column.priority) === 0).map((column) => ({ name: text(column.name, "Value"), jsonPath: text(column.jsonPath, ""), type: text(column.type, "string") })).filter((column) => column.jsonPath),
    descriptor: { apiVersion: `${group}/${version}`, group, version, kind, plural, namespaced: scope === "Namespaced", verbs: ["get", "list", "watch", "create", "patch", "delete"], categories: [] } satisfies ApiResourceDescriptor,
  };
}
