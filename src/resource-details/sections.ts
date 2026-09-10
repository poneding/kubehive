import type { ResourceDetailSection } from "./types";
import type { ResourceRow } from "../resource-catalog";
import { array, compact, compactObject, detailValueAt, field, names, nonEmpty, object, ports, resourceQuantities, section, selector, sourceFor, string, tolerations } from "./value";
import { workloadTemplate } from "./containers";

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
    const name = string(resource.name || object(pods.metric).name || object(external.metric).name || object(metric.containerResource).name);
    const target = compact(detailValueAt(metric, "resource.target.averageUtilization") ?? detailValueAt(metric, "resource.target.averageValue") ?? detailValueAt(metric, "pods.target.averageValue") ?? detailValueAt(metric, "external.target.value"), 80);
    return [type, name, target === "—" ? "" : `target ${target}`].filter(Boolean).join(" · ");
  }).filter(Boolean);
  return metrics.length ? metrics.join("; ") : "—";
}

export type SectionContext = {
  row: ResourceRow;
  source: Record<string, unknown>;
  spec: Record<string, unknown>;
  status: Record<string, unknown>;
  template: Record<string, unknown>;
  templateScheduling: (title?: string) => ResourceDetailSection;
};

function buildDeploymentSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
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
}

function buildStatefulSetSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
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
}

function buildDaemonSetSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
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
}

function buildReplicaSetSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
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
}

function buildJobSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
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
}

function buildCronJobSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
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
}

function buildNodeSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
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
}

function buildNamespaceSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
  return nonEmpty([section("lifecycle", "Namespace lifecycle", [
    field("Phase", status.phase ?? row.status),
    field("Finalizers", names(spec.finalizers), { wide: true }),
    field("Deletion requested", detailValueAt(source, "metadata.deletionTimestamp") ? "Yes" : undefined),
  ])]);
}

function buildEventSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
  return nonEmpty([section("event", "Event signal", [
    field("Type", detailValueAt(source, "type") ?? row.data.type, { tone: String(detailValueAt(source, "type") ?? row.data.type) === "Warning" ? "amber" : "blue" }),
    field("Reason", detailValueAt(source, "reason") ?? row.name),
    field("Count", detailValueAt(source, "series.count") ?? detailValueAt(source, "deprecatedCount") ?? detailValueAt(source, "count") ?? row.data.count),
    field("Last seen", detailValueAt(source, "series.lastObservedTime") ?? detailValueAt(source, "deprecatedLastTimestamp") ?? detailValueAt(source, "lastTimestamp") ?? detailValueAt(source, "eventTime") ?? row.data.lastSeen),
    field("Regarding", detailValueAt(source, "regarding.kind") ? `${compact(detailValueAt(source, "regarding.kind"))}/${compact(detailValueAt(source, "regarding.name"))}` : detailValueAt(source, "involvedObject.kind") ? `${compact(detailValueAt(source, "involvedObject.kind"))}/${compact(detailValueAt(source, "involvedObject.name"))}` : row.data.object, { wide: true }),
    field("Message", detailValueAt(source, "note") ?? detailValueAt(source, "message") ?? row.data.message, { wide: true }),
  ], "A concise record of the Kubernetes signal and its affected object.")]);
}

function buildServiceSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
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
}

function buildEndpointsSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
  return nonEmpty([section("endpoints", "Endpoint health", [
    field("Ready addresses", endpointAddresses(source, "addresses") !== "—" ? endpointAddresses(source, "addresses") : row.data.addresses, { wide: true, copyable: true }),
    field("Not ready addresses", endpointAddresses(source, "notReadyAddresses"), { wide: true, copyable: true }),
    field("Ports", array(source.subsets).length ? array(source.subsets).map((entry) => ports(detailValueAt(entry, "ports"))).filter((entry) => entry !== "—").join(", ") : row.data.ports, { wide: true }),
  ], "Ready and unready backends registered for this Service.")]);
}

function buildEndpointSliceSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
  return nonEmpty([section("endpoints", "Endpoint slice health", [
    field("Service", object(detailValueAt(source, "metadata.labels"))["kubernetes.io/service-name"]),
    field("Address type", source.addressType),
    field("Ready endpoints", endpointSliceCount(source, true)),
    field("Not ready endpoints", endpointSliceCount(source, false)),
    field("Ports", ports(source.ports), { wide: true }),
  ])]);
}

function buildIngressSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
  return nonEmpty([section("routing", "Ingress routing", [
    field("Class", spec.ingressClassName ?? row.data.class),
    field("Address", array(detailValueAt(status, "loadBalancer.ingress")).map((entry) => compact(detailValueAt(entry, "ip") ?? detailValueAt(entry, "hostname"))).join(", ") || row.data.address, { copyable: true }),
    field("Hosts", array(spec.rules).map((entry) => compact(detailValueAt(entry, "host"))).filter((entry) => entry !== "—").join(", ") || row.data.hosts, { wide: true }),
    field("Backend services", ingressBackends(spec), { wide: true }),
    field("TLS secrets", array(spec.tls).map((entry) => compact(detailValueAt(entry, "secretName"))).filter((entry) => entry !== "—").join(", "), { wide: true }),
  ])]);
}

function buildIngressClassSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
  return nonEmpty([section("controller", "Ingress controller", [
    field("Controller", spec.controller ?? row.data.controller, { wide: true, copyable: true }),
    field("Parameters", dataSource(spec.parameters), { wide: true }),
  ])]);
}

function buildNetworkPolicySections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
  return nonEmpty([section("policy", "Traffic policy", [
    field("Pod selector", spec.podSelector ? selector(spec.podSelector) : row.data.podSelector, { wide: true }),
    field("Policy types", names(spec.policyTypes) !== "—" ? names(spec.policyTypes) : row.data.policyTypes),
    field("Ingress rules", array(spec.ingress).length),
    field("Egress rules", array(spec.egress).length),
    field("Ingress peers", array(spec.ingress).reduce((count: number, entry) => count + array(detailValueAt(entry, "from")).length, 0)),
    field("Egress peers", array(spec.egress).reduce((count: number, entry) => count + array(detailValueAt(entry, "to")).length, 0)),
  ], "Which Pods are selected and how their ingress and egress are constrained.")]);
}

function buildPersistentVolumeClaimSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
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
}

function buildPersistentVolumeSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
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
}

function buildStorageClassSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
  return nonEmpty([section("provisioning", "Dynamic provisioning", [
    field("Provisioner", source.provisioner ?? row.data.provisioner, { wide: true, copyable: true }),
    field("Reclaim policy", source.reclaimPolicy ?? row.data.reclaimPolicy),
    field("Binding mode", source.volumeBindingMode ?? row.data.bindingMode),
    field("Allow expansion", source.allowVolumeExpansion ?? row.data.allowExpansion),
    field("Mount options", names(source.mountOptions), { wide: true }),
    field("Parameters", compactObject(source.parameters), { wide: true }),
  ])]);
}

function buildConfigMapSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
  // The interactive Data section lists every key with raw/decoded
  // previews and copy actions; a summary block would only repeat it.
  return [];
}

function buildResourceQuotaSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
  return nonEmpty([section("quota", "Quota usage", [
    field("Hard limits", resourceQuantities(status.hard ?? spec.hard ?? row.data.limits), { wide: true }),
    field("Current usage", resourceQuantities(status.used ?? row.data.requests), { wide: true }),
    field("Scopes", names(spec.scopes), { wide: true }),
  ])]);
}

function buildLimitRangeSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
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

function buildHorizontalPodAutoscalerSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
  return nonEmpty([section("autoscaling", "Horizontal autoscaling", [
    field("Target", detailValueAt(spec, "scaleTargetRef.kind") ? `${compact(detailValueAt(spec, "scaleTargetRef.kind"))}/${compact(detailValueAt(spec, "scaleTargetRef.name"))}` : row.data.reference),
    field("Current / desired", `${compact(status.currentReplicas ?? row.data.replicas)} / ${compact(status.desiredReplicas ?? row.data.replicas)}`),
    field("Minimum", spec.minReplicas ?? row.data.minPods ?? 1),
    field("Maximum", spec.maxReplicas ?? row.data.maxPods),
    field("Metrics", metricSummary(spec.metrics) !== "—" ? metricSummary(spec.metrics) : row.data.targets, { wide: true }),
    field("Current metrics", metricSummary(status.currentMetrics), { wide: true }),
    field("Last scale", status.lastScaleTime),
  ], "Scale target, replica range, and the metrics driving decisions.")]);
}

function buildVerticalPodAutoscalerSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
  return nonEmpty([section("autoscaling", "Vertical autoscaling", [
    field("Target", detailValueAt(spec, "targetRef.kind") ? `${compact(detailValueAt(spec, "targetRef.kind"))}/${compact(detailValueAt(spec, "targetRef.name"))}` : row.data.reference),
    field("Update mode", detailValueAt(spec, "updatePolicy.updateMode") ?? row.data.mode),
    field("Minimum replicas", detailValueAt(spec, "updatePolicy.minReplicas")),
    field("Container policies", array(detailValueAt(spec, "resourcePolicy.containerPolicies")).length),
    field("Recommendations", array(detailValueAt(status, "recommendation.containerRecommendations")).length),
  ])]);
}

function buildPodDisruptionBudgetSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
  return nonEmpty([section("availability", "Disruption budget", [
    field("Minimum available", spec.minAvailable ?? row.data.minAvailable),
    field("Maximum unavailable", spec.maxUnavailable ?? row.data.maxUnavailable),
    field("Current healthy", status.currentHealthy),
    field("Desired healthy", status.desiredHealthy),
    field("Expected Pods", status.expectedPods),
    field("Allowed disruptions", status.disruptionsAllowed ?? row.data.allowedDisruptions),
    field("Selector", selector(spec.selector), { wide: true }),
  ])]);
}

function buildPriorityClassSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
  return nonEmpty([section("priority", "Scheduling priority", [
    field("Value", source.value ?? row.data.value),
    field("Global default", source.globalDefault ?? row.data.globalDefault),
    field("Preemption policy", source.preemptionPolicy ?? row.data.preemptionPolicy),
    field("Description", source.description, { wide: true }),
  ])]);
}

function buildRuntimeClassSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
  return nonEmpty([section("runtime", "Container runtime", [
    field("Handler", source.handler ?? row.data.handler, { copyable: true }),
    field("Overhead", resourceQuantities(detailValueAt(source, "overhead.podFixed")), { wide: true }),
    field("Node selector", selector(detailValueAt(source, "scheduling.nodeSelector")), { wide: true }),
    field("Tolerations", tolerations(detailValueAt(source, "scheduling.tolerations")), { wide: true }),
  ])]);
}

function buildLeaseSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
  return nonEmpty([section("lease", "Lease state", [
    field("Holder", spec.holderIdentity ?? row.data.holder),
    field("Renew time", spec.renewTime ?? row.data.renewTime),
    field("Lease duration", spec.leaseDurationSeconds ? `${spec.leaseDurationSeconds}s` : undefined),
    field("Acquire time", spec.acquireTime),
    field("Transitions", spec.leaseTransitions),
  ])]);
}

function buildMutatingWebhookConfigurationSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
  return nonEmpty([section("webhooks", "Admission webhooks", [
    field("Webhooks", array(source.webhooks).length || row.data.webhooks),
    field("Names", names(array(source.webhooks).map((entry) => detailValueAt(entry, "name"))), { wide: true }),
    field("Failure policies", names(array(source.webhooks).map((entry) => detailValueAt(entry, "failurePolicy"))) !== "—" ? names(array(source.webhooks).map((entry) => detailValueAt(entry, "failurePolicy"))) : row.data.failurePolicy),
    field("Timeouts", names(array(source.webhooks).map((entry) => detailValueAt(entry, "timeoutSeconds"))), { wide: true }),
  ])]);
}

function buildServiceAccountSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
  return nonEmpty([section("identity", "Service account", [
    field("Automount token", source.automountServiceAccountToken === undefined ? "Inherited" : source.automountServiceAccountToken ? "Enabled" : "Disabled"),
    field("Image pull secrets", names(array(source.imagePullSecrets).map((entry) => detailValueAt(entry, "name"))), { wide: true }),
    field("Referenced secrets", array(source.secrets).length || row.data.secrets),
  ])]);
}

function buildRoleSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
  return nonEmpty([section("permissions", "RBAC permissions", [
    field("Rules", array(source.rules).length || row.data.rules),
    field("Resources", names(Array.from(new Set(array(source.rules).flatMap((entry) => array(detailValueAt(entry, "resources")).map(string)))), 10), { wide: true }),
    field("Verbs", names(Array.from(new Set(array(source.rules).flatMap((entry) => array(detailValueAt(entry, "verbs")).map(string)))), 10), { wide: true }),
    field("Aggregation selectors", array(detailValueAt(source, "aggregationRule.clusterRoleSelectors")).length),
  ])]);
}

function buildRoleBindingSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
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
}

function buildPodSecurityPolicySections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
  return nonEmpty([section("security", "Pod security policy", [
    field("Privileged", spec.privileged ?? row.data.privileged),
    field("Allow escalation", spec.allowPrivilegeEscalation),
    field("Host namespaces", [spec.hostNetwork ? "network" : "", spec.hostPID ? "PID" : "", spec.hostIPC ? "IPC" : ""].filter(Boolean).join(", ") || "None"),
    field("Run as user", detailValueAt(spec, "runAsUser.rule") ?? row.data.runAsUser),
    field("Allowed volumes", names(spec.volumes) !== "—" ? names(spec.volumes) : row.data.volumes, { wide: true }),
  ])]);
}

function buildCustomResourceDefinitionSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
  return nonEmpty([section("definition", "Custom resource definition", [
    field("Group", spec.group ?? row.data.group),
    field("Resource kind", detailValueAt(spec, "names.kind") ?? row.data.kind),
    field("Scope", spec.scope ?? row.data.scope),
    field("Storage version", array(spec.versions).find((entry) => detailValueAt(entry, "storage") === true) ? detailValueAt(array(spec.versions).find((entry) => detailValueAt(entry, "storage") === true), "name") : undefined),
    field("Served versions", names(array(spec.versions).filter((entry) => detailValueAt(entry, "served") !== false).map((entry) => detailValueAt(entry, "name"))) !== "—" ? names(array(spec.versions).filter((entry) => detailValueAt(entry, "served") !== false).map((entry) => detailValueAt(entry, "name"))) : row.data.versions, { wide: true }),
    field("Instances", row.data.instances),
  ], "API-specific fields are retained here because they define this resource type.")]);
}

function buildHelmChartSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
  return nonEmpty([section("chart", "Helm chart", [
    field("Repository", row.data.repository, { wide: true, copyable: true }),
    field("Chart version", row.data.version),
    field("Application version", row.data.appVersion),
    field("Description", row.data.description, { wide: true }),
  ])]);
}

function buildHelmReleaseSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
  return nonEmpty([section("release", "Helm release", [
    field("Chart", row.data.chart),
    field("Status", row.data.status),
    field("Revision", row.data.revision),
    field("Application version", row.data.appVersion),
    field("Updated", row.data.updated),
  ])]);
}

function buildPortForwardSections(ctx: SectionContext): ResourceDetailSection[] {
  const { row, source, spec, status, template, templateScheduling } = ctx;
  return nonEmpty([section("forward", "Port forwarding", [
    field("Local address", row.data.localAddress ?? `${compact(row.data.host ?? "localhost")}:${compact(row.data.localPort)}`, { copyable: true }),
    field("Service port", row.data.servicePort),
    field("Target Pod port", row.data.targetPort),
    field("Endpoint Pod", row.data.resolvedPod),
    field("Protocol", row.data.protocol),
    field("Status", row.status),
    field("Last error", row.data.error, { wide: true }),
  ])]);
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

  const ctx: SectionContext = { row, source, spec, status, template, templateScheduling };

  switch (row.kind) {
    case "Pod": return [];
    case "Deployment": return buildDeploymentSections(ctx);
    case "StatefulSet": return buildStatefulSetSections(ctx);
    case "DaemonSet": return buildDaemonSetSections(ctx);
    case "ReplicaSet": return buildReplicaSetSections(ctx);
    case "ReplicationController": return buildReplicaSetSections(ctx);
    case "Job": return buildJobSections(ctx);
    case "CronJob": return buildCronJobSections(ctx);
    case "Node": return buildNodeSections(ctx);
    case "Namespace": return buildNamespaceSections(ctx);
    case "Event": return buildEventSections(ctx);
    case "Service": return buildServiceSections(ctx);
    case "Endpoints": return buildEndpointsSections(ctx);
    case "EndpointSlice": return buildEndpointSliceSections(ctx);
    case "Ingress": return buildIngressSections(ctx);
    case "IngressClass": return buildIngressClassSections(ctx);
    case "NetworkPolicy": return buildNetworkPolicySections(ctx);
    case "PersistentVolumeClaim": return buildPersistentVolumeClaimSections(ctx);
    case "PersistentVolume": return buildPersistentVolumeSections(ctx);
    case "StorageClass": return buildStorageClassSections(ctx);
    case "ConfigMap": return buildConfigMapSections(ctx);
    case "Secret": return buildConfigMapSections(ctx);
    case "ResourceQuota": return buildResourceQuotaSections(ctx);
    case "LimitRange": return buildLimitRangeSections(ctx);
    case "HorizontalPodAutoscaler": return buildHorizontalPodAutoscalerSections(ctx);
    case "VerticalPodAutoscaler": return buildVerticalPodAutoscalerSections(ctx);
    case "PodDisruptionBudget": return buildPodDisruptionBudgetSections(ctx);
    case "PriorityClass": return buildPriorityClassSections(ctx);
    case "RuntimeClass": return buildRuntimeClassSections(ctx);
    case "Lease": return buildLeaseSections(ctx);
    case "MutatingWebhookConfiguration": return buildMutatingWebhookConfigurationSections(ctx);
    case "ValidatingWebhookConfiguration": return buildMutatingWebhookConfigurationSections(ctx);
    case "ServiceAccount": return buildServiceAccountSections(ctx);
    case "Role": return buildRoleSections(ctx);
    case "ClusterRole": return buildRoleSections(ctx);
    case "RoleBinding": return buildRoleBindingSections(ctx);
    case "ClusterRoleBinding": return buildRoleBindingSections(ctx);
    case "PodSecurityPolicy": return buildPodSecurityPolicySections(ctx);
    case "CustomResourceDefinition": return buildCustomResourceDefinitionSections(ctx);
    case "HelmChart": return buildHelmChartSections(ctx);
    case "HelmRelease": return buildHelmReleaseSections(ctx);
    case "PortForward": return buildPortForwardSections(ctx);
    default: return genericObjectSections(row);

  }
}
