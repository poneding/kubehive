import type { ResourceRow } from "./resource-catalog";

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

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

export function detailValueAt(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) return current[Number(part)];
    if (typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[part];
  }, value);
}

function compact(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length ? value.map(compact).join(", ") : "—";
  const entries = Object.entries(object(value));
  if (!entries.length) return "—";
  return entries.map(([key, entry]) => `${key}: ${compact(entry)}`).join(", ");
}

function json(value: unknown): string {
  if (value === undefined || value === null) return "—";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function selector(value: unknown): string {
  const source = object(detailValueAt(value, "matchLabels") ?? value);
  const values = Object.entries(source).map(([key, entry]) => `${key}=${compact(entry)}`);
  return values.length ? values.join(", ") : "—";
}

function refs(value: unknown, kindPath = "kind", namePath = "name"): string {
  const values = array(value).map((entry) => {
    const kind = compact(detailValueAt(entry, kindPath));
    const name = compact(detailValueAt(entry, namePath));
    return kind === "—" ? name : `${kind}/${name}`;
  }).filter((entry) => entry !== "—");
  return values.length ? values.join(", ") : "—";
}

function ports(value: unknown): string {
  const values = array(value).map((entry) => {
    const source = object(entry);
    const port = source.port ?? source.containerPort ?? source.targetPort;
    if (port === undefined) return "";
    return `${source.name ? `${source.name}:` : ""}${compact(port)}/${compact(source.protocol ?? "TCP")}`;
  }).filter(Boolean);
  return values.length ? values.join(", ") : "—";
}

function images(value: unknown): string {
  const values = array(value).map((entry) => compact(object(entry).image)).filter((entry) => entry !== "—");
  return values.length ? values.join(", ") : "—";
}

function field(label: string, value: unknown, options: Partial<DetailField> = {}): DetailField {
  return { label, value: compact(value), ...options };
}

function section(id: string, title: string, fields: DetailField[], description?: string): ResourceDetailSection {
  return { id, title, description, fields };
}

function sourceFor(row: ResourceRow) {
  return row.backend?.object ?? {};
}

function dataOr(row: ResourceRow, path: string, dataKey?: string) {
  return detailValueAt(sourceFor(row), path) ?? row.data[dataKey ?? path.split(".").at(-1) ?? path];
}

function workloadTemplate(row: ResourceRow) {
  return detailValueAt(sourceFor(row), "spec.template.spec") ?? {};
}

function genericObjectSections(row: ResourceRow): ResourceDetailSection[] {
  const source = sourceFor(row);
  const summarize = (value: unknown) => Object.entries(object(value)).filter(([, entry]) => entry === null || ["string", "number", "boolean"].includes(typeof entry)).slice(0, 10).map(([key, entry]) => field(key, entry));
  const specFields = summarize(detailValueAt(source, "spec"));
  const statusFields = summarize(detailValueAt(source, "status"));
  const sections: ResourceDetailSection[] = [];
  if (specFields.length) sections.push(section("spec", "Specification", specFields, "Top-level fields exposed by this resource kind."));
  if (statusFields.length) sections.push(section("status", "Observed status", statusFields, "Controller-reported status fields."));
  if (!sections.length) sections.push(section("summary", "Resource summary", Object.entries(row.data).filter(([key]) => !["name", "namespace", "age"].includes(key)).slice(0, 10).map(([key, value]) => field(key, value))));
  return sections;
}

export function buildResourceDetailSections(row: ResourceRow): ResourceDetailSection[] {
  const source = sourceFor(row);
  const spec = object(detailValueAt(source, "spec"));
  const status = object(detailValueAt(source, "status"));
  const template = object(workloadTemplate(row));
  switch (row.kind) {
    case "Pod":
      return [
        section("runtime", "Pod runtime", [field("Phase", status.phase ?? row.status, { tone: row.status === "Running" ? "green" : "amber" }), field("Pod IP", status.podIP ?? row.data.ip), field("Host IP", status.hostIP), field("Node", spec.nodeName ?? row.data.node), field("QoS class", status.qosClass), field("Service account", spec.serviceAccountName ?? "default"), field("Priority class", spec.priorityClassName), field("Runtime class", spec.runtimeClassName)]),
        section("containers", "Containers", [field("Images", images(spec.containers), { wide: true, copyable: true }), field("Init containers", array(spec.initContainers).length), field("Containers", array(spec.containers).length || row.containers?.length), field("Ready", row.data.containers), field("Restarts", row.data.restarts), field("Ports", array(spec.containers).map((entry) => ports(object(entry).ports)).filter((entry) => entry !== "—").join(", "), { wide: true })]),
        section("scheduling", "Scheduling", [field("Scheduler", spec.schedulerName ?? "default-scheduler"), field("Node selector", selector(spec.nodeSelector), { wide: true }), field("Tolerations", array(spec.tolerations).length), field("Affinity", spec.affinity ? "Configured" : "—"), field("DNS policy", spec.dnsPolicy), field("Restart policy", spec.restartPolicy)]),
      ];
    case "Deployment":
      return [
        section("rollout", "Deployment rollout", [field("Desired", spec.replicas ?? row.data.ready?.toString().split("/").at(-1)), field("Ready", status.readyReplicas ?? row.data.ready), field("Updated", status.updatedReplicas ?? row.data.upToDate), field("Available", status.availableReplicas ?? row.data.available), field("Unavailable", status.unavailableReplicas ?? 0), field("Observed generation", status.observedGeneration)]),
        section("strategy", "Rollout strategy", [field("Strategy", detailValueAt(spec, "strategy.type") ?? "RollingUpdate"), field("Max surge", detailValueAt(spec, "strategy.rollingUpdate.maxSurge")), field("Max unavailable", detailValueAt(spec, "strategy.rollingUpdate.maxUnavailable")), field("Revision history", spec.revisionHistoryLimit), field("Progress deadline", spec.progressDeadlineSeconds ? `${spec.progressDeadlineSeconds}s` : undefined), field("Selector", spec.selector ? selector(spec.selector) : `app=${row.name}`, { wide: true })]),
        section("template", "Pod template", [field("Images", array(template.containers).length ? images(template.containers) : row.data.images, { wide: true, copyable: true }), field("Containers", array(template.containers).length || row.data.containers), field("Service account", template.serviceAccountName ?? "default"), field("Node selector", selector(template.nodeSelector), { wide: true })]),
      ];
    case "StatefulSet":
      return [
        section("rollout", "StatefulSet rollout", [field("Desired", spec.replicas ?? row.data.ready?.toString().split("/").at(-1)), field("Ready", status.readyReplicas ?? row.data.ready), field("Current", status.currentReplicas ?? row.data.ready), field("Updated", status.updatedReplicas ?? row.data.ready), field("Current revision", status.currentRevision), field("Update revision", status.updateRevision)]),
        section("identity", "Stable identity & storage", [field("Service name", spec.serviceName), field("Pod management", spec.podManagementPolicy), field("Update strategy", detailValueAt(spec, "updateStrategy.type")), field("Partition", detailValueAt(spec, "updateStrategy.rollingUpdate.partition")), field("PVC templates", array(spec.volumeClaimTemplates).map((entry) => compact(detailValueAt(entry, "metadata.name"))).join(", "), { wide: true }), field("Selector", selector(spec.selector), { wide: true })]),
        section("template", "Pod template", [field("Images", array(template.containers).length ? images(template.containers) : row.data.images, { wide: true, copyable: true }), field("Containers", array(template.containers).length || row.data.containers), field("Service account", template.serviceAccountName ?? "default")]),
      ];
    case "DaemonSet":
      return [
        section("rollout", "DaemonSet rollout", [field("Desired", status.desiredNumberScheduled ?? row.data.desired), field("Current", status.currentNumberScheduled ?? row.data.current), field("Ready", status.numberReady ?? row.data.ready), field("Available", status.numberAvailable ?? row.data.available), field("Updated", status.updatedNumberScheduled ?? row.data.upToDate), field("Misscheduled", status.numberMisscheduled ?? 0)]),
        section("placement", "Node placement", [field("Update strategy", detailValueAt(spec, "updateStrategy.type")), field("Max unavailable", detailValueAt(spec, "updateStrategy.rollingUpdate.maxUnavailable")), field("Node selector", selector(template.nodeSelector), { wide: true }), field("Tolerations", array(template.tolerations).length), field("Images", array(template.containers).length ? images(template.containers) : row.data.images, { wide: true, copyable: true })]),
      ];
    case "ReplicaSet":
    case "ReplicationController":
      return [section("replicas", `${row.kind} replicas`, [field("Desired", spec.replicas ?? row.data.desired), field("Current", status.replicas ?? row.data.current), field("Ready", status.readyReplicas ?? row.data.ready), field("Available", status.availableReplicas), field("Fully labeled", status.fullyLabeledReplicas), field("Selector", selector(spec.selector), { wide: true })]), section("template", "Pod template", [field("Images", images(template.containers), { wide: true, copyable: true }), field("Containers", array(template.containers).length)])];
    case "Job":
      return [section("execution", "Job execution", [field("Completions", spec.completions), field("Parallelism", spec.parallelism), field("Active", status.active ?? 0), field("Succeeded", status.succeeded ?? 0), field("Failed", status.failed ?? 0), field("Backoff limit", spec.backoffLimit), field("Completion mode", spec.completionMode), field("Deadline", spec.activeDeadlineSeconds ? `${spec.activeDeadlineSeconds}s` : undefined)]), section("template", "Pod template", [field("Images", images(template.containers), { wide: true, copyable: true }), field("Restart policy", template.restartPolicy), field("Selector", selector(spec.selector), { wide: true })])];
    case "CronJob":
      return [section("schedule", "Cron schedule", [field("Schedule", spec.schedule ?? row.data.schedule, { copyable: true }), field("Time zone", spec.timeZone), field("Suspend", spec.suspend ?? false), field("Concurrency policy", spec.concurrencyPolicy), field("Starting deadline", spec.startingDeadlineSeconds ? `${spec.startingDeadlineSeconds}s` : undefined), field("Last schedule", status.lastScheduleTime ?? row.data.lastSchedule), field("Last successful", status.lastSuccessfulTime), field("Active jobs", array(status.active).length)]), section("history", "History & job template", [field("Successful history", spec.successfulJobsHistoryLimit), field("Failed history", spec.failedJobsHistoryLimit), field("Completions", detailValueAt(spec, "jobTemplate.spec.completions")), field("Parallelism", detailValueAt(spec, "jobTemplate.spec.parallelism")), field("Images", images(detailValueAt(spec, "jobTemplate.spec.template.spec.containers")), { wide: true, copyable: true })])];
    case "Node":
      return [section("capacity", "Capacity & allocation", [field("CPU capacity", detailValueAt(status, "capacity.cpu") ?? row.data.cpu), field("CPU allocatable", detailValueAt(status, "allocatable.cpu")), field("Memory capacity", detailValueAt(status, "capacity.memory") ?? row.data.memory), field("Memory allocatable", detailValueAt(status, "allocatable.memory")), field("Pod capacity", detailValueAt(status, "capacity.pods") ?? row.data.pods), field("Ephemeral storage", detailValueAt(status, "capacity.ephemeral-storage"))]), section("system", "Node system", [field("Roles", row.data.roles), field("Kubelet", detailValueAt(status, "nodeInfo.kubeletVersion") ?? row.data.version), field("Container runtime", detailValueAt(status, "nodeInfo.containerRuntimeVersion")), field("OS image", detailValueAt(status, "nodeInfo.osImage")), field("Kernel", detailValueAt(status, "nodeInfo.kernelVersion")), field("Architecture", detailValueAt(status, "nodeInfo.architecture")), field("Provider ID", spec.providerID, { wide: true, copyable: true })]), section("addresses", "Addresses", array(status.addresses).map((entry) => field(compact(detailValueAt(entry, "type")), detailValueAt(entry, "address"), { copyable: true })) )];
    case "Namespace":
      return [section("lifecycle", "Namespace lifecycle", [field("Phase", status.phase ?? row.status), field("Finalizers", array(spec.finalizers).join(", "), { wide: true }), field("Deletion requested", detailValueAt(source, "metadata.deletionTimestamp") ?? "No")])];
    case "Event":
      return [section("event", "Event details", [field("Type", detailValueAt(source, "type") ?? row.data.type), field("Reason", detailValueAt(source, "reason") ?? row.name), field("Count", detailValueAt(source, "series.count") ?? detailValueAt(source, "deprecatedCount") ?? detailValueAt(source, "count") ?? row.data.count), field("First seen", detailValueAt(source, "deprecatedFirstTimestamp") ?? detailValueAt(source, "firstTimestamp") ?? detailValueAt(source, "eventTime")), field("Last seen", detailValueAt(source, "series.lastObservedTime") ?? detailValueAt(source, "deprecatedLastTimestamp") ?? detailValueAt(source, "lastTimestamp") ?? detailValueAt(source, "eventTime") ?? row.data.lastSeen), field("Reporting controller", detailValueAt(source, "reportingController")), field("Regarding", detailValueAt(source, "regarding.kind") ? `${compact(detailValueAt(source, "regarding.kind"))}/${compact(detailValueAt(source, "regarding.name"))}` : detailValueAt(source, "involvedObject.kind") ? `${compact(detailValueAt(source, "involvedObject.kind"))}/${compact(detailValueAt(source, "involvedObject.name"))}` : row.data.object, { wide: true }), field("Message", detailValueAt(source, "note") ?? detailValueAt(source, "message") ?? row.data.message, { wide: true })])];
    case "Service":
      return [section("network", "Service network", [field("Type", spec.type ?? row.data.type), field("Cluster IP", spec.clusterIP ?? row.data.clusterIp, { copyable: true }), field("Cluster IPs", spec.clusterIPs, { wide: true }), field("External IPs", spec.externalIPs ?? row.data.externalIp, { wide: true }), field("Load balancer IP", spec.loadBalancerIP), field("External traffic policy", spec.externalTrafficPolicy), field("Session affinity", spec.sessionAffinity), field("IP families", spec.ipFamilies)]), section("routing", "Routing", [field("Selector", spec.selector ? selector(spec.selector) : row.data.selector, { wide: true }), field("Ports", array(spec.ports).length ? ports(spec.ports) : row.data.ports, { wide: true }), field("Publish not ready", spec.publishNotReadyAddresses ?? false)])];
    case "Endpoints":
      return [section("endpoints", "Endpoint subsets", [field("Ready addresses", array(detailValueAt(source, "subsets")).length ? array(detailValueAt(source, "subsets")).flatMap((entry) => array(detailValueAt(entry, "addresses"))).map((entry) => compact(detailValueAt(entry, "ip"))).join(", ") : row.data.addresses, { wide: true }), field("Not ready addresses", array(detailValueAt(source, "subsets")).flatMap((entry) => array(detailValueAt(entry, "notReadyAddresses"))).map((entry) => compact(detailValueAt(entry, "ip"))).join(", "), { wide: true }), field("Ports", array(detailValueAt(source, "subsets")).length ? array(detailValueAt(source, "subsets")).map((entry) => ports(detailValueAt(entry, "ports"))).join(", ") : row.data.ports, { wide: true })])];
    case "Ingress":
      return [section("routing", "Ingress routing", [field("Class", spec.ingressClassName ?? row.data.class), field("Address", row.data.address), field("Default backend", detailValueAt(spec, "defaultBackend.service.name")), field("Rules", array(spec.rules).length || (row.data.hosts ? 1 : 0)), field("TLS entries", array(spec.tls).length), field("Hosts", array(spec.rules).length ? array(spec.rules).map((entry) => compact(detailValueAt(entry, "host"))).join(", ") : row.data.hosts, { wide: true }), field("TLS secrets", array(spec.tls).map((entry) => compact(detailValueAt(entry, "secretName"))).join(", "), { wide: true })])];
    case "IngressClass":
      return [section("controller", "Ingress controller", [field("Controller", spec.controller ?? row.data.controller, { wide: true, copyable: true }), field("Parameters kind", detailValueAt(spec, "parameters.kind")), field("Parameters name", detailValueAt(spec, "parameters.name")), field("Parameters scope", detailValueAt(spec, "parameters.scope"))])];
    case "NetworkPolicy":
      return [section("policy", "Network policy", [field("Pod selector", spec.podSelector ? selector(spec.podSelector) : row.data.podSelector, { wide: true }), field("Policy types", spec.policyTypes ?? row.data.policyTypes), field("Ingress rules", array(spec.ingress).length), field("Egress rules", array(spec.egress).length), field("Ingress peers", array(spec.ingress).reduce((count, entry) => count + array(detailValueAt(entry, "from")).length, 0)), field("Egress peers", array(spec.egress).reduce((count, entry) => count + array(detailValueAt(entry, "to")).length, 0))])];
    case "PersistentVolumeClaim":
      return [section("claim", "Volume claim", [field("Phase", status.phase ?? row.status), field("Volume", spec.volumeName ?? row.data.volume), field("Storage class", spec.storageClassName ?? row.data.storageClass), field("Requested", detailValueAt(spec, "resources.requests.storage")), field("Capacity", detailValueAt(status, "capacity.storage") ?? row.data.capacity), field("Access modes", status.accessModes ?? spec.accessModes ?? row.data.accessModes), field("Volume mode", spec.volumeMode), field("Data source", spec.dataSource ? `${compact(detailValueAt(spec, "dataSource.kind"))}/${compact(detailValueAt(spec, "dataSource.name"))}` : undefined)])];
    case "PersistentVolume":
      return [section("volume", "Persistent volume", [field("Phase", status.phase ?? row.status), field("Capacity", detailValueAt(spec, "capacity.storage") ?? row.data.capacity), field("Access modes", spec.accessModes ?? row.data.accessModes), field("Volume mode", spec.volumeMode), field("Reclaim policy", spec.persistentVolumeReclaimPolicy ?? row.data.reclaimPolicy), field("Storage class", spec.storageClassName ?? row.data.storageClass), field("Claim", spec.claimRef ? `${compact(detailValueAt(spec, "claimRef.namespace"))}/${compact(detailValueAt(spec, "claimRef.name"))}` : row.data.claim), field("Node affinity", spec.nodeAffinity ? "Configured" : "—")]), section("source", "Volume source", [field("CSI driver", detailValueAt(spec, "csi.driver")), field("Volume handle", detailValueAt(spec, "csi.volumeHandle"), { wide: true, copyable: true }), field("Filesystem type", detailValueAt(spec, "csi.fsType")), field("NFS server", detailValueAt(spec, "nfs.server")), field("NFS path", detailValueAt(spec, "nfs.path"))])];
    case "StorageClass":
      return [section("provisioning", "Dynamic provisioning", [field("Provisioner", detailValueAt(source, "provisioner") ?? row.data.provisioner, { wide: true, copyable: true }), field("Reclaim policy", detailValueAt(source, "reclaimPolicy") ?? row.data.reclaimPolicy), field("Binding mode", detailValueAt(source, "volumeBindingMode") ?? row.data.bindingMode), field("Allow expansion", detailValueAt(source, "allowVolumeExpansion") ?? row.data.allowExpansion), field("Mount options", detailValueAt(source, "mountOptions"), { wide: true }), field("Parameters", detailValueAt(source, "parameters"), { wide: true })])];
    case "ConfigMap":
      return [section("data", "ConfigMap data", [field("Entries", Object.keys(object(detailValueAt(source, "data"))).length || row.data.data), field("Binary entries", Object.keys(object(detailValueAt(source, "binaryData"))).length), field("Immutable", detailValueAt(source, "immutable") ?? false), field("Keys", Object.keys(object(detailValueAt(source, "data"))).join(", "), { wide: true, copyable: true })])];
    case "Secret":
      return [section("data", "Secret data", [field("Type", detailValueAt(source, "type") ?? row.data.type), field("Entries", Object.keys(object(detailValueAt(source, "data"))).length || row.data.data), field("Immutable", detailValueAt(source, "immutable") ?? false), field("Keys", Object.keys(object(detailValueAt(source, "data"))).join(", "), { wide: true }), field("Values", "Masked in the native Rust boundary", { wide: true, tone: "amber" })])];
    case "ResourceQuota":
      return [section("quota", "Quota usage", [field("Hard", status.hard ?? spec.hard ?? row.data.limits ?? row.data.requests, { wide: true }), field("Used", status.used ?? row.data.requests, { wide: true }), field("Scopes", spec.scopes, { wide: true }), field("Scope selector", spec.scopeSelector, { wide: true })])];
    case "LimitRange":
      return [section("limits", "Default resource limits", array(spec.limits).length ? array(spec.limits).flatMap((entry, index) => [field(`Rule ${index + 1} type`, detailValueAt(entry, "type")), field(`Rule ${index + 1} default`, detailValueAt(entry, "default"), { wide: true }), field(`Rule ${index + 1} request`, detailValueAt(entry, "defaultRequest"), { wide: true }), field(`Rule ${index + 1} min / max`, `${json(detailValueAt(entry, "min"))} / ${json(detailValueAt(entry, "max"))}`, { wide: true })]) : [field("Type", row.data.type), field("Default", row.data.default, { wide: true }), field("Minimum", row.data.min, { wide: true }), field("Maximum", row.data.max, { wide: true })])];
    case "HorizontalPodAutoscaler":
      return [section("autoscaling", "Horizontal autoscaling", [field("Target", detailValueAt(spec, "scaleTargetRef.kind") ? `${compact(detailValueAt(spec, "scaleTargetRef.kind"))}/${compact(detailValueAt(spec, "scaleTargetRef.name"))}` : row.data.reference), field("Min replicas", spec.minReplicas ?? row.data.minPods ?? 1), field("Max replicas", spec.maxReplicas ?? row.data.maxPods), field("Current replicas", status.currentReplicas ?? row.data.replicas), field("Desired replicas", status.desiredReplicas ?? row.data.replicas), field("Last scale", status.lastScaleTime), field("Metrics", array(spec.metrics).length), field("Behavior", spec.behavior ? "Configured" : "Default")])];
    case "VerticalPodAutoscaler":
      return [section("autoscaling", "Vertical autoscaling", [field("Target", detailValueAt(spec, "targetRef.kind") ? `${compact(detailValueAt(spec, "targetRef.kind"))}/${compact(detailValueAt(spec, "targetRef.name"))}` : row.data.reference), field("Update mode", detailValueAt(spec, "updatePolicy.updateMode") ?? row.data.mode), field("Min replicas", detailValueAt(spec, "updatePolicy.minReplicas")), field("Resource policies", array(detailValueAt(spec, "resourcePolicy.containerPolicies")).length), field("Recommendations", array(detailValueAt(status, "recommendation.containerRecommendations")).length)])];
    case "PodDisruptionBudget":
      return [section("availability", "Disruption budget", [field("Min available", spec.minAvailable ?? row.data.minAvailable), field("Max unavailable", spec.maxUnavailable ?? row.data.maxUnavailable), field("Current healthy", status.currentHealthy), field("Desired healthy", status.desiredHealthy), field("Expected pods", status.expectedPods), field("Allowed disruptions", status.disruptionsAllowed ?? row.data.allowedDisruptions), field("Selector", selector(spec.selector), { wide: true })])];
    case "PriorityClass":
      return [section("priority", "Scheduling priority", [field("Value", detailValueAt(source, "value") ?? row.data.value), field("Global default", detailValueAt(source, "globalDefault") ?? row.data.globalDefault), field("Preemption policy", detailValueAt(source, "preemptionPolicy") ?? row.data.preemptionPolicy), field("Description", detailValueAt(source, "description"), { wide: true })])];
    case "RuntimeClass":
      return [section("runtime", "Container runtime", [field("Handler", detailValueAt(source, "handler") ?? row.data.handler, { copyable: true }), field("Overhead", detailValueAt(source, "overhead.podFixed") ?? row.data.overhead, { wide: true }), field("Node selector", detailValueAt(source, "scheduling.nodeSelector") ?? row.data.scheduling, { wide: true }), field("Tolerations", array(detailValueAt(source, "scheduling.tolerations")).length)])];
    case "Lease":
      return [section("lease", "Lease state", [field("Holder", spec.holderIdentity ?? row.data.holder), field("Lease duration", spec.leaseDurationSeconds ? `${spec.leaseDurationSeconds}s` : undefined), field("Acquire time", spec.acquireTime), field("Renew time", spec.renewTime ?? row.data.renewTime), field("Transitions", spec.leaseTransitions)])];
    case "MutatingWebhookConfiguration":
    case "ValidatingWebhookConfiguration":
      return [section("webhooks", "Admission webhooks", [field("Webhooks", array(detailValueAt(source, "webhooks")).length || row.data.webhooks), field("Names", array(detailValueAt(source, "webhooks")).map((entry) => compact(detailValueAt(entry, "name"))).join(", "), { wide: true }), field("Failure policies", array(detailValueAt(source, "webhooks")).length ? array(detailValueAt(source, "webhooks")).map((entry) => compact(detailValueAt(entry, "failurePolicy"))).join(", ") : row.data.failurePolicy), field("Side effects", array(detailValueAt(source, "webhooks")).map((entry) => compact(detailValueAt(entry, "sideEffects"))).join(", ")), field("Timeouts", array(detailValueAt(source, "webhooks")).map((entry) => compact(detailValueAt(entry, "timeoutSeconds"))).join(", "))])];
    case "ServiceAccount":
      return [section("identity", "Service account identity", [field("Secrets", array(detailValueAt(source, "secrets")).length ? refs(detailValueAt(source, "secrets"), "kind", "name") : row.data.secrets), field("Image pull secrets", refs(detailValueAt(source, "imagePullSecrets"), "kind", "name")), field("Automount token", detailValueAt(source, "automountServiceAccountToken") ?? "Inherited")])];
    case "Role":
    case "ClusterRole":
      return [section("permissions", "RBAC permissions", [field("Rules", array(detailValueAt(source, "rules")).length || row.data.rules), field("API groups", Array.from(new Set(array(detailValueAt(source, "rules")).flatMap((entry) => array(detailValueAt(entry, "apiGroups")).map(compact)))).join(", "), { wide: true }), field("Resources", Array.from(new Set(array(detailValueAt(source, "rules")).flatMap((entry) => array(detailValueAt(entry, "resources")).map(compact)))).join(", "), { wide: true }), field("Verbs", Array.from(new Set(array(detailValueAt(source, "rules")).flatMap((entry) => array(detailValueAt(entry, "verbs")).map(compact)))).join(", "), { wide: true }), field("Aggregation selectors", array(detailValueAt(source, "aggregationRule.clusterRoleSelectors")).length)])];
    case "RoleBinding":
    case "ClusterRoleBinding":
      return [section("binding", "RBAC binding", [field("Role", detailValueAt(source, "roleRef.kind") ? `${compact(detailValueAt(source, "roleRef.kind"))}/${compact(detailValueAt(source, "roleRef.name"))}` : row.data.role), field("API group", detailValueAt(source, "roleRef.apiGroup")), field("Subjects", array(detailValueAt(source, "subjects")).length ? refs(detailValueAt(source, "subjects")) : row.data.subjects, { wide: true }), field("Subject count", array(detailValueAt(source, "subjects")).length || (row.data.subjects ? 1 : 0))])];
    case "PodSecurityPolicy":
      return [section("security", "Pod security policy", [field("Privileged", spec.privileged ?? row.data.privileged ?? false), field("Allow escalation", spec.allowPrivilegeEscalation), field("Host network", spec.hostNetwork ?? false), field("Host PID", spec.hostPID ?? false), field("Host IPC", spec.hostIPC ?? false), field("Run as user", detailValueAt(spec, "runAsUser.rule") ?? row.data.runAsUser), field("SELinux", detailValueAt(spec, "seLinux.rule")), field("Volumes", spec.volumes ?? row.data.volumes, { wide: true })])];
    case "CustomResourceDefinition":
      return [section("definition", "Custom resource API", [field("Group", spec.group ?? row.data.group), field("Kind", detailValueAt(spec, "names.kind") ?? row.data.kind), field("Plural", detailValueAt(spec, "names.plural") ?? row.data.plural), field("Scope", spec.scope ?? row.data.scope), field("Versions", array(spec.versions).length ? array(spec.versions).map((entry) => `${compact(detailValueAt(entry, "name"))}${detailValueAt(entry, "storage") ? " (storage)" : ""}`).join(", ") : row.data.versions, { wide: true }), field("Conversion", detailValueAt(spec, "conversion.strategy")), field("Instances", row.data.instances), field("Preserve unknown", detailValueAt(spec, "preserveUnknownFields"))])];
    case "HelmChart":
      return [section("chart", "Helm chart", [field("Repository", row.data.repository, { wide: true, copyable: true }), field("Chart version", row.data.version), field("Application version", row.data.appVersion), field("Description", row.data.description, { wide: true })])];
    case "HelmRelease":
      return [section("release", "Helm release", [field("Namespace", row.namespace), field("Chart", row.data.chart), field("Revision", row.data.revision), field("Status", row.data.status), field("Application version", row.data.appVersion), field("Updated", row.data.updated)])];
    case "PortForward":
      return [section("forward", "Port forwarding", [field("Resource", row.name), field("Namespace", row.namespace), field("Local address", `127.0.0.1:${compact(row.data.localPort)}`, { copyable: true }), field("Remote port", row.data.targetPort), field("Protocol", row.data.protocol), field("Status", row.status)])];
    default:
      return genericObjectSections(row);
  }
}

export function getResourceConditions(row?: ResourceRow): ResourceCondition[] {
  if (!row?.backend) return row?.status ? [{ type: row.status, status: row.status === "Running" || row.status === "Ready" ? "True" : "Unknown", reason: "DemoStatus", message: "Resource status from the current list snapshot.", lastTransition: String(row.data.age ?? "—") }] : [];
  return array(detailValueAt(row.backend.object, "status.conditions")).map((condition) => ({
    type: compact(detailValueAt(condition, "type")),
    status: compact(detailValueAt(condition, "status")),
    reason: compact(detailValueAt(condition, "reason")),
    message: compact(detailValueAt(condition, "message")),
    lastTransition: compact(detailValueAt(condition, "lastTransitionTime") ?? detailValueAt(condition, "lastProbeTime")),
  }));
}

export function getResourceLabels(row?: ResourceRow): Record<string, string> {
  if (!row?.backend) return row ? { app: row.name } : {};
  return Object.fromEntries(Object.entries(object(detailValueAt(row.backend.object, "metadata.labels"))).map(([key, value]) => [key, compact(value)]));
}

export function getResourceAnnotations(row?: ResourceRow): Record<string, string> {
  if (!row?.backend) return {};
  return Object.fromEntries(Object.entries(object(detailValueAt(row.backend.object, "metadata.annotations"))).map(([key, value]) => [key, compact(value)]));
}
