import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type { ManifestFormat } from "./manifest-format";

export const nativeBackendAvailable = isTauri();

export type BackendCluster = {
  id: string;
  name: string;
  provider: "AWS" | "GCP" | "Azure" | "Local";
  region: string;
  version: string;
  status: "healthy" | "warning" | "offline";
  nodes: number;
  cpu: number;
  memory: number;
  context: string;
  server: string;
  defaultNamespace: string;
  imported: boolean;
  sourcePath?: string | null;
  disconnected: boolean;
  error?: string | null;
};

export type RenameClusterResult = { id: string; name: string };

export type ApiResourceDescriptor = {
  apiVersion: string;
  group: string;
  version: string;
  kind: string;
  plural: string;
  namespaced: boolean;
  verbs: string[];
  categories: string[];
};

export type BackendResourceRecord = {
  key: string;
  name: string;
  namespace: string;
  uid?: string | null;
  resourceVersion?: string | null;
  apiVersion: string;
  kind: string;
  createdAt?: string | null;
  ageSeconds?: number | null;
  object: Record<string, unknown>;
};

export type BackendResourceDetail = BackendResourceRecord & { manifest: string };

export type ResourceListResponse = {
  resourceVersion: string;
  items: BackendResourceRecord[];
};

export type ResourceListRequest = {
  clusterId: string;
  resource: ApiResourceDescriptor;
  namespace?: string | null;
  labelSelector?: string | null;
  fieldSelector?: string | null;
  resourceVersion?: string | null;
  compact?: boolean;
};

export type ResourceTarget = {
  clusterId: string;
  resource: ApiResourceDescriptor;
  namespace?: string | null;
  name: string;
};

export type DeleteResourceTarget = ResourceTarget & {
  foreground?: boolean;
  gracePeriodSeconds?: number | null;
};

export type BulkActionFailure = {
  kind: string;
  name: string;
  namespace?: string | null;
  error: string;
};

export type BulkActionResult = {
  requested: number;
  succeeded: number;
  failures: BulkActionFailure[];
};

export type ApplyManifestRequest = {
  clusterId: string;
  manifest: string;
  format: ManifestFormat;
  resource?: ApiResourceDescriptor | null;
  dryRun?: boolean;
  force?: boolean;
};

export type ResourceWatchEvent = {
  eventType: "added" | "modified" | "deleted";
  resource: BackendResourceRecord;
};

export type ResourceWatchMessage = {
  subscriptionId: string;
  eventType: "batch" | "snapshot" | "error";
  events: ResourceWatchEvent[];
  resources: BackendResourceRecord[];
  resourceVersion?: string | null;
  error?: string | null;
};

export type ClusterOverview = {
  clusterId: string;
  version: string;
  nodes: number;
  readyNodes: number;
  cpuPercent?: number | null;
  memoryPercent?: number | null;
  pods: number;
  runningPods: number;
  podCapacity: number;
  storageBytes: number;
  storageCapacityBytes: number;
  workloadHealth: { total: number; healthy: number; degraded: number; failed: number };
  nodeUsage: Array<{ name: string; cpuPercent?: number | null; memoryPercent?: number | null; ready: boolean }>;
  issues: BackendResourceRecord[];
  events: Array<{ level: "warning" | "normal"; reason: string; object: string; message: string; time: string }>;
  updatedAt: string;
};

export type PodMetricsRequest = {
  clusterId: string;
  namespace: string;
  pod: string;
  rangeHours: 1 | 2 | 4 | 8 | 24;
};

export type NodeMetricsRequest = {
  clusterId: string;
  node: string;
  rangeHours: 1 | 2 | 4 | 8 | 24;
};

export type PodMetricPoint = { timestamp: number; value: number };
export type PodMetricSeries = { id: string; label: string; unit: string; points: PodMetricPoint[] };
export type PodMetricsResponse = {
  provider: string;
  rangeHours: number;
  stepSeconds: number;
  series: Record<"cpu" | "memory" | "network" | "filesystem", PodMetricSeries[]>;
};

export type PodUsageEntry = { namespace: string; name: string; cpuMillicores: number; memoryBytes: number };
export type PodMetricsListRequest = { clusterId: string; namespace?: string };
export type PodMetricsListResponse = { items: PodUsageEntry[] };

export type ExecResult = { stdout: string; stderr: string; success: boolean; status?: string | null };
export type ContainerFileTarget = { clusterId: string; namespace: string; pod: string; container?: string; hostRoot?: boolean };
export type NodeFileTarget = { clusterId: string; node: string };
export type NodeTaint = { key: string; value: string; effect: string; timeAdded?: string | null };
export type DrainNodeRequest = { clusterId: string; node: string; ignoreDaemonsets?: boolean; deleteEmptyDirData?: boolean; force?: boolean; gracePeriodSeconds?: number | null; disableEviction?: boolean; waitForDeletion?: boolean; timeoutSeconds?: number | null };
export type DrainNodeResult = { node: string; evicted: number; skipped: number; failures: string[]; remaining: string[] };
export type ContainerDirectoryContext = { workDir: string; homeDir: string };
export type ContainerFileEntry = { name: string; path: string; kind: "file" | "directory" | "symlink"; size: number; modifiedAt: number; permissions: string; readable: boolean; writable: boolean };
export type ContainerTextFile = { path: string; content: string };
export type TerminalEvent = { sessionId: string; eventType: "connected" | "output" | "disconnected" | "error"; data?: string | null };
export type PortForwardTargetKind = "pod" | "service";
export type PortForwardHost = "localhost" | "0.0.0.0";
export type PortForwardProtocol = "http" | "https";
export type PortForwardSession = { id: string; clusterId: string; namespace: string; targetKind: PortForwardTargetKind; targetName: string; pod: string; host: PortForwardHost; protocol: PortForwardProtocol; localPort: number; remotePort: number; servicePort?: number | null; status: string; error?: string | null };
export type StartPortForwardRequest = { clusterId: string; namespace: string; targetKind: PortForwardTargetKind; targetName: string; host: PortForwardHost; protocol: PortForwardProtocol; localPort: number; remotePort: number };
export type HelmChart = { name: string; repository: string; version: string; appVersion: string; description: string };
export type HelmReleaseValues = {
  name: string;
  namespace: string;
  revision: number;
  status: string;
  chart: string;
  appVersion: string;
  suppliedValues: string;
  suppliedValueCount: number;
  defaultValues: string;
  defaultValueCount: number;
  computedValues: string;
  computedValueCount: number;
};
export type SystemFontFamily = { name: string; monospace: boolean };

const call = <T>(command: string, args?: Record<string, unknown>) => invoke<T>(command, args);

export const backend = {
  info: () => call<{ name: string; runtime: string; kubernetesClient: string; mode: string }>("backend_info"),
  listSystemFonts: () => call<SystemFontFamily[]>("list_system_fonts"),
  listClusters: () => call<BackendCluster[]>("list_clusters"),
  importClusters: (request: { displayName?: string; kubeconfigYaml?: string; server?: string; token?: string; insecureSkipTlsVerify?: boolean }) => call<BackendCluster[]>("import_clusters", { request }),
  selectKubeconfigFile: () => call<{ fileName: string; contents: string } | null>("select_kubeconfig_file"),
  removeCluster: (clusterId: string) => call<void>("remove_cluster", { clusterId }),
  disconnectCluster: (clusterId: string) => call<void>("disconnect_cluster", { clusterId }),
  reconnectCluster: (clusterId: string, operationId: string) => call<BackendCluster>("reconnect_cluster", { clusterId, operationId }),
  cancelClusterConnection: (operationId: string) => call<boolean>("cancel_cluster_connection", { operationId }),
  probeCluster: (clusterId: string) => call<BackendCluster>("probe_cluster", { clusterId }),
  renameCluster: (clusterId: string, displayName: string) => call<RenameClusterResult>("rename_cluster", { request: { clusterId, displayName } }),
  setProxy: (enabled: boolean, url?: string) => call<void>("set_network_proxy", { settings: { enabled, url } }),
  setAppTheme: (theme: "system" | "light" | "dark") => call<void>("set_app_theme", { theme }),
  discoverResources: (clusterId: string) => call<ApiResourceDescriptor[]>("discover_resources", { clusterId }),
  listResources: (request: ResourceListRequest) => call<ResourceListResponse>("list_resources", { request }),
  getResource: (target: ResourceTarget) => call<BackendResourceDetail>("get_resource", { target }),
  podMetrics: (request: PodMetricsRequest) => call<PodMetricsResponse | null>("pod_metrics", { request }),
  nodeMetrics: (request: NodeMetricsRequest) => call<PodMetricsResponse | null>("node_metrics", { request }),
  listPodMetrics: (request: PodMetricsListRequest) => call<PodMetricsListResponse | null>("list_pod_metrics", { request }),
  applyManifest: (request: ApplyManifestRequest) => call<BackendResourceDetail>("apply_manifest", { request }),
  deleteResource: ({ foreground = false, gracePeriodSeconds, ...target }: DeleteResourceTarget) => call<void>("delete_resource", { request: { ...target, foreground, gracePeriodSeconds } }),
  deleteResources: (targets: DeleteResourceTarget[]) => call<BulkActionResult>("delete_resources", { request: { targets } }),
  scaleResource: ({ replicas, ...target }: ResourceTarget & { replicas: number }) => call<BackendResourceDetail>("scale_resource", { request: { ...target, replicas } }),
  restartResource: (target: ResourceTarget) => call<BackendResourceDetail>("restart_resource", { target }),
  triggerCronJob: (target: ResourceTarget) => call<BackendResourceDetail>("trigger_cronjob", { target }),
  setCronJobSuspend: ({ suspend, ...target }: ResourceTarget & { suspend: boolean }) => call<BackendResourceDetail>("set_cronjob_suspend", { request: { ...target, suspend } }),
  evictPod: (request: { clusterId: string; namespace: string; pod: string; gracePeriodSeconds?: number | null }) => call<void>("evict_pod", { request }),
  evictPods: (pods: Array<{ clusterId: string; namespace: string; pod: string; gracePeriodSeconds?: number | null }>) => call<BulkActionResult>("evict_pods", { request: { pods } }),
  podLogs: (request: { clusterId: string; namespace: string; pod: string; container?: string; tailLines?: number; sinceSeconds?: number; timestamps?: boolean; previous?: boolean }) => call<string>("pod_logs", { request }),
  downloadLogs: (request: { content: string; pod: string; container?: string }) => call<string>("download_logs", { request }),
  execPod: (request: { clusterId: string; namespace: string; pod: string; container?: string; command: string[] }) => call<ExecResult>("exec_pod", { request }),
  containerFileContext: (target: ContainerFileTarget) => call<ContainerDirectoryContext>("container_file_context", { target }),
  listContainerFiles: (target: ContainerFileTarget, path: string) => call<ContainerFileEntry[]>("list_container_files", { request: { ...target, path } }),
  readContainerTextFile: (target: ContainerFileTarget, path: string) => call<ContainerTextFile>("read_container_text_file", { request: { ...target, path } }),
  writeContainerTextFile: (target: ContainerFileTarget, path: string, content: string) => call<void>("write_container_text_file", { request: { ...target, path, content } }),
  uploadContainerFile: (target: ContainerFileTarget, path: string, data: number[], overwrite = false) => call<void>("upload_container_file", { request: { ...target, path, data, overwrite } }),
  createContainerDirectory: (target: ContainerFileTarget, path: string) => call<void>("create_container_directory", { request: { ...target, path } }),
  createContainerFile: (target: ContainerFileTarget, path: string) => call<void>("create_container_file", { request: { ...target, path } }),
  renameContainerPath: (target: ContainerFileTarget, path: string, newName: string) => call<void>("rename_container_path", { request: { ...target, path, newName } }),
  moveContainerPath: (target: ContainerFileTarget, sourcePath: string, destinationPath: string) => call<void>("move_container_path", { request: { ...target, sourcePath, destinationPath } }),
  copyContainerPath: (target: ContainerFileTarget, sourcePath: string, destinationPath: string) => call<void>("copy_container_path", { request: { ...target, sourcePath, destinationPath } }),
  deleteContainerPath: (target: ContainerFileTarget, path: string) => call<void>("delete_container_path", { request: { ...target, path } }),
  deleteContainerPaths: (target: ContainerFileTarget, paths: string[]) => call<void>("delete_container_paths", { request: { ...target, paths } }),
  downloadContainerPath: (target: ContainerFileTarget, path: string, directory: boolean) => call<string>("download_container_path", { request: { ...target, path, directory } }),
  downloadContainerPaths: (target: ContainerFileTarget, paths: string[]) => call<string>("download_container_paths", { request: { ...target, paths } }),
  startNodeFileSession: (target: NodeFileTarget) => call<ContainerFileTarget>("start_node_file_session", { target }),
  stopNodeFileSession: (target: NodeFileTarget) => call<void>("stop_node_file_session", { target }),
  setNodeUnschedulable: (clusterId: string, node: string, unschedulable: boolean) => call<void>("set_node_unschedulable", { request: { clusterId, node, unschedulable } }),
  drainNode: (request: DrainNodeRequest) => call<DrainNodeResult>("drain_node", { request }),
  listNodeTaints: (target: NodeFileTarget) => call<NodeTaint[]>("list_node_taints", { target }),
  addNodeTaint: (clusterId: string, node: string, key: string, value: string, effect: string) => call<NodeTaint[]>("add_node_taint", { request: { clusterId, node, key, value, effect } }),
  removeNodeTaint: (clusterId: string, node: string, key: string, effect?: string) => call<NodeTaint[]>("remove_node_taint", { request: { clusterId, node, key, effect } }),
  startTerminal: async (request: { clusterId: string; namespace: string; pod: string; container?: string; command?: string[] }, onMessage: (message: TerminalEvent) => void) => {
    const onEvent = new Channel<TerminalEvent>();
    onEvent.onmessage = onMessage;
    return call<string>("start_terminal", { request, onEvent });
  },
  startNodeTerminal: async (request: { clusterId: string; node: string; namespace?: string; command?: string[] }, onMessage: (message: TerminalEvent) => void) => {
    const onEvent = new Channel<TerminalEvent>();
    onEvent.onmessage = onMessage;
    return call<string>("start_terminal", { request, onEvent });
  },
  startLocalTerminal: async (clusterId: string, onMessage: (message: TerminalEvent) => void) => {
    const onEvent = new Channel<TerminalEvent>();
    onEvent.onmessage = onMessage;
    return call<string>("start_local_terminal", { request: { clusterId }, onEvent });
  },
  writeTerminal: (sessionId: string, data: string) => call<void>("write_terminal", { sessionId, data }),
  resizeTerminal: (sessionId: string, columns: number, rows: number) => call<void>("resize_terminal", { sessionId, columns, rows }),
  stopTerminal: (sessionId: string) => call<boolean>("stop_terminal", { sessionId }),
  overview: (clusterId: string) => call<ClusterOverview>("cluster_overview", { clusterId }),
  listHelmCharts: (refresh = false) => call<HelmChart[]>("list_helm_charts", { refresh }),
  getHelmRelease: (request: { clusterId: string; namespace: string; secretName: string }) => call<HelmReleaseValues>("get_helm_release", { request }),
  startWatch: async (request: ResourceListRequest, onMessage: (message: ResourceWatchMessage) => void) => {
    const onEvent = new Channel<ResourceWatchMessage>();
    onEvent.onmessage = onMessage;
    return call<string>("start_resource_watch", { request, onEvent });
  },
  stopWatch: (subscriptionId: string) => call<boolean>("stop_resource_watch", { subscriptionId }),
  listPortForwards: (clusterId?: string) => call<PortForwardSession[]>("list_port_forwards", { clusterId }),
  startPortForward: (request: StartPortForwardRequest) => call<PortForwardSession>("start_port_forward", { request }),
  pausePortForward: (sessionId: string) => call<PortForwardSession>("pause_port_forward", { sessionId }),
  resumePortForward: (sessionId: string) => call<PortForwardSession>("resume_port_forward", { sessionId }),
  stopPortForward: (sessionId: string) => call<boolean>("stop_port_forward", { sessionId }),
};

const knownResourceKinds: Record<string, { apiVersion: string; kind: string; plural: string; namespaced: boolean }> = {
  Nodes: { apiVersion: "v1", kind: "Node", plural: "nodes", namespaced: false },
  Namespaces: { apiVersion: "v1", kind: "Namespace", plural: "namespaces", namespaced: false },
  Events: { apiVersion: "v1", kind: "Event", plural: "events", namespaced: true },
  Pods: { apiVersion: "v1", kind: "Pod", plural: "pods", namespaced: true },
  Deployments: { apiVersion: "apps/v1", kind: "Deployment", plural: "deployments", namespaced: true },
  DaemonSets: { apiVersion: "apps/v1", kind: "DaemonSet", plural: "daemonsets", namespaced: true },
  StatefulSets: { apiVersion: "apps/v1", kind: "StatefulSet", plural: "statefulsets", namespaced: true },
  ReplicaSets: { apiVersion: "apps/v1", kind: "ReplicaSet", plural: "replicasets", namespaced: true },
  "Replication Controllers": { apiVersion: "v1", kind: "ReplicationController", plural: "replicationcontrollers", namespaced: true },
  Jobs: { apiVersion: "batch/v1", kind: "Job", plural: "jobs", namespaced: true },
  CronJobs: { apiVersion: "batch/v1", kind: "CronJob", plural: "cronjobs", namespaced: true },
  Services: { apiVersion: "v1", kind: "Service", plural: "services", namespaced: true },
  Endpoints: { apiVersion: "v1", kind: "Endpoints", plural: "endpoints", namespaced: true },
  Ingresses: { apiVersion: "networking.k8s.io/v1", kind: "Ingress", plural: "ingresses", namespaced: true },
  "Ingress Classes": { apiVersion: "networking.k8s.io/v1", kind: "IngressClass", plural: "ingressclasses", namespaced: false },
  "Network Policies": { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", plural: "networkpolicies", namespaced: true },
  "Persistent Volume Claims": { apiVersion: "v1", kind: "PersistentVolumeClaim", plural: "persistentvolumeclaims", namespaced: true },
  "Persistent Volumes": { apiVersion: "v1", kind: "PersistentVolume", plural: "persistentvolumes", namespaced: false },
  "Storage Classes": { apiVersion: "storage.k8s.io/v1", kind: "StorageClass", plural: "storageclasses", namespaced: false },
  "Config Maps": { apiVersion: "v1", kind: "ConfigMap", plural: "configmaps", namespaced: true },
  Secrets: { apiVersion: "v1", kind: "Secret", plural: "secrets", namespaced: true },
  "Resource Quotas": { apiVersion: "v1", kind: "ResourceQuota", plural: "resourcequotas", namespaced: true },
  "Limit Ranges": { apiVersion: "v1", kind: "LimitRange", plural: "limitranges", namespaced: true },
  "Horizontal Pod Autoscalers": { apiVersion: "autoscaling/v2", kind: "HorizontalPodAutoscaler", plural: "horizontalpodautoscalers", namespaced: true },
  "Vertical Pod Autoscalers": { apiVersion: "autoscaling.k8s.io/v1", kind: "VerticalPodAutoscaler", plural: "verticalpodautoscalers", namespaced: true },
  "Pod Disruption Budgets": { apiVersion: "policy/v1", kind: "PodDisruptionBudget", plural: "poddisruptionbudgets", namespaced: true },
  "Priority Classes": { apiVersion: "scheduling.k8s.io/v1", kind: "PriorityClass", plural: "priorityclasses", namespaced: false },
  "Runtime Classes": { apiVersion: "node.k8s.io/v1", kind: "RuntimeClass", plural: "runtimeclasses", namespaced: false },
  Leases: { apiVersion: "coordination.k8s.io/v1", kind: "Lease", plural: "leases", namespaced: true },
  "Mutating Webhook Configs": { apiVersion: "admissionregistration.k8s.io/v1", kind: "MutatingWebhookConfiguration", plural: "mutatingwebhookconfigurations", namespaced: false },
  "Validating Webhook Configs": { apiVersion: "admissionregistration.k8s.io/v1", kind: "ValidatingWebhookConfiguration", plural: "validatingwebhookconfigurations", namespaced: false },
  "Service Accounts": { apiVersion: "v1", kind: "ServiceAccount", plural: "serviceaccounts", namespaced: true },
  "Cluster Roles": { apiVersion: "rbac.authorization.k8s.io/v1", kind: "ClusterRole", plural: "clusterroles", namespaced: false },
  Roles: { apiVersion: "rbac.authorization.k8s.io/v1", kind: "Role", plural: "roles", namespaced: true },
  "Cluster Role Bindings": { apiVersion: "rbac.authorization.k8s.io/v1", kind: "ClusterRoleBinding", plural: "clusterrolebindings", namespaced: false },
  "Role Bindings": { apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding", plural: "rolebindings", namespaced: true },
  "Pod Security Policies": { apiVersion: "policy/v1beta1", kind: "PodSecurityPolicy", plural: "podsecuritypolicies", namespaced: false },
  "Custom Resource Definitions": { apiVersion: "apiextensions.k8s.io/v1", kind: "CustomResourceDefinition", plural: "customresourcedefinitions", namespaced: false },
};

export function descriptorForResource(name: string, discovered: ApiResourceDescriptor[]): ApiResourceDescriptor | null {
  const known = knownResourceKinds[name];
  if (!known) return null;
  const exact = discovered.find((resource) => resource.kind === known.kind && resource.apiVersion === known.apiVersion);
  const preferred = discovered.find((resource) => resource.kind === known.kind);
  if (exact || preferred) return exact ?? preferred ?? null;
  return { ...known, group: known.apiVersion.includes("/") ? known.apiVersion.split("/")[0] : "", version: known.apiVersion.includes("/") ? known.apiVersion.split("/")[1] : known.apiVersion, verbs: [], categories: [] };
}

const apiGroupOf = (apiVersion: string) => apiVersion.includes("/") ? apiVersion.split("/")[0] : "";

/**
 * Groups the cluster serves by itself: the core Kubernetes groups plus the
 * aggregated metrics APIs. Anything served outside this set was installed on
 * top of the cluster — a CustomResourceDefinition in practice — which is what
 * the Custom Resources navigation group lists.
 */
const builtInApiGroups = new Set([
  "", "apps", "batch", "autoscaling", "policy", "extensions",
  "admissionregistration.k8s.io", "apiextensions.k8s.io", "apiregistration.k8s.io",
  "authentication.k8s.io", "authorization.k8s.io", "certificates.k8s.io",
  "coordination.k8s.io", "discovery.k8s.io", "events.k8s.io",
  "flowcontrol.apiserver.k8s.io", "internal.apiserver.k8s.io", "networking.k8s.io",
  "node.k8s.io", "rbac.authorization.k8s.io", "resource.k8s.io", "scheduling.k8s.io",
  "storage.k8s.io", "storagemigration.k8s.io",
  "metrics.k8s.io", "custom.metrics.k8s.io", "external.metrics.k8s.io",
]);

/** Kinds that already have a dedicated navigation entry (e.g. VPA). */
const navigatedKinds = new Set(Object.values(knownResourceKinds).map((known) => `${known.kind}/${apiGroupOf(known.apiVersion)}`));

/** The CRD object name behind a served resource, e.g. `widgets.example.com`. */
export function crdNameForDescriptor(resource: Pick<ApiResourceDescriptor, "plural" | "group">) {
  return `${resource.plural}.${resource.group}`;
}

/**
 * Resources contributed by installed CustomResourceDefinitions, sorted by kind.
 * Read from discovery rather than the CRD objects: it needs no permission on
 * `customresourcedefinitions` and reports the verbs the active credentials
 * really have for each kind.
 */
export function customResourceDescriptors(discovered: ApiResourceDescriptor[]): ApiResourceDescriptor[] {
  const seen = new Set<string>();
  return discovered
    .filter((resource) => {
      if (!resource.group || builtInApiGroups.has(resource.group)) return false;
      if (navigatedKinds.has(`${resource.kind}/${resource.group}`)) return false;
      if (!resource.verbs.includes("list")) return false;
      const name = crdNameForDescriptor(resource);
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    })
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.group.localeCompare(right.group));
}

/** Resolves `widgets.example.com` back to the descriptor discovery reported. */
export function descriptorForCrdName(crdName: string, discovered: ApiResourceDescriptor[]): ApiResourceDescriptor | null {
  const separator = crdName.indexOf(".");
  if (separator <= 0) return null;
  const plural = crdName.slice(0, separator);
  const group = crdName.slice(separator + 1);
  return discovered.find((resource) => resource.plural === plural && resource.group === group) ?? null;
}
