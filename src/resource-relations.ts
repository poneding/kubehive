import { backend, descriptorForResource, nativeBackendAvailable, type ApiResourceDescriptor } from "./backend";
import { getResourceRows, type ResourceRow } from "./resource-catalog";
import { customResourceDefinitions, customResources } from "./data";
import { rowFromBackend } from "./k8s-adapter";
import { detailValueAt } from "./resource-details";

export type RelationDirection = "parent" | "child" | "peer";

/**
 * A detail drawer is an incident-response surface, not a graph browser.  Each
 * group below is intentionally small and contains only a dependency that can
 * affect how an operator diagnoses or changes the selected resource.
 */
export type ResourceRelationGroup = {
  id: string;
  title: string;
  direction: RelationDirection;
  description: string;
  items: ResourceRow[];
  /** Number of matches before the compact drawer cap is applied. */
  total: number;
  error?: string;
};

export type RelationshipMatrixEntry = {
  parents: string[];
  children: string[];
  peers: string[];
  derivation: string;
};

/** A deliberately narrow policy used by the Sheet, rather than an exhaustive graph. */
export const RESOURCE_RELATIONSHIP_MATRIX: Record<string, RelationshipMatrixEntry> = {
  Node: { parents: [], children: ["Scheduled Pods"], peers: ["Events"], derivation: "Pod.spec.nodeName" },
  Namespace: { parents: [], children: [], peers: ["Events"], derivation: "Event involvedObject" },
  Event: { parents: ["Regarding resource"], children: [], peers: [], derivation: "regarding/involvedObject" },
  Pod: { parents: ["Workload"], children: [], peers: ["ConfigMaps", "Secrets", "PVCs", "Events"], derivation: "owner chain; volumes/env/envFrom/imagePullSecrets" },
  Deployment: { parents: [], children: ["Managed Pods"], peers: ["Events"], derivation: "ReplicaSet ownership and selector" },
  StatefulSet: { parents: [], children: ["Managed Pods", "Volume Claims"], peers: ["Events"], derivation: "ownerReferences and volumeClaimTemplates" },
  DaemonSet: { parents: [], children: ["Managed Pods"], peers: ["Events"], derivation: "ownerReferences" },
  ReplicaSet: { parents: ["Deployment"], children: ["Managed Pods"], peers: ["Events"], derivation: "ownerReferences" },
  ReplicationController: { parents: [], children: ["Managed Pods"], peers: ["Events"], derivation: "ownerReferences and selector" },
  Job: { parents: ["CronJob"], children: ["Managed Pods"], peers: ["Events"], derivation: "ownerReferences" },
  CronJob: { parents: [], children: ["Recent Jobs"], peers: ["Events"], derivation: "Job ownerReferences" },
  Service: { parents: [], children: ["Selected Pods", "Endpoints"], peers: ["Events"], derivation: "selector and Service-name Endpoint objects" },
  Endpoints: { parents: ["Service"], children: [], peers: ["Target Pods", "Events"], derivation: "matching Service name and targetRef" },
  EndpointSlice: { parents: ["Service"], children: [], peers: ["Target Pods", "Events"], derivation: "kubernetes.io/service-name and targetRef" },
  Ingress: { parents: [], children: [], peers: ["Backend Services", "TLS Secrets", "Events"], derivation: "HTTP backends and tls.secretName" },
  IngressClass: { parents: [], children: [], peers: ["Events"], derivation: "involvedObject" },
  NetworkPolicy: { parents: [], children: [], peers: ["Selected Pods", "Events"], derivation: "spec.podSelector" },
  PersistentVolumeClaim: { parents: ["PersistentVolume"], children: [], peers: ["Events"], derivation: "spec.volumeName" },
  PersistentVolume: { parents: [], children: ["PersistentVolumeClaim"], peers: ["Events"], derivation: "spec.claimRef" },
  StorageClass: { parents: [], children: [], peers: ["Events"], derivation: "involvedObject" },
  ConfigMap: { parents: [], children: [], peers: ["Referencing Pods", "Events"], derivation: "Pod volumes/env/envFrom/projected refs" },
  Secret: { parents: [], children: [], peers: ["Referencing Pods", "Events"], derivation: "Pod volumes/env/envFrom/projected refs" },
  ResourceQuota: { parents: [], children: [], peers: ["Events"], derivation: "involvedObject" },
  LimitRange: { parents: [], children: [], peers: ["Events"], derivation: "involvedObject" },
  HorizontalPodAutoscaler: { parents: ["Scale target"], children: [], peers: ["Events"], derivation: "spec.scaleTargetRef" },
  VerticalPodAutoscaler: { parents: ["Target"], children: [], peers: ["Events"], derivation: "spec.targetRef" },
  PodDisruptionBudget: { parents: [], children: [], peers: ["Protected Pods", "Events"], derivation: "spec.selector" },
  PriorityClass: { parents: [], children: [], peers: ["Events"], derivation: "involvedObject" },
  RuntimeClass: { parents: [], children: [], peers: ["Events"], derivation: "involvedObject" },
  Lease: { parents: [], children: [], peers: ["Events"], derivation: "involvedObject" },
  MutatingWebhookConfiguration: { parents: [], children: [], peers: ["Webhook Services", "Events"], derivation: "webhooks.clientConfig.service" },
  ValidatingWebhookConfiguration: { parents: [], children: [], peers: ["Webhook Services", "Events"], derivation: "webhooks.clientConfig.service" },
  ServiceAccount: { parents: [], children: ["Pods"], peers: ["Events"], derivation: "Pod.spec.serviceAccountName" },
  Role: { parents: [], children: ["Bindings"], peers: ["Events"], derivation: "RoleBinding.roleRef" },
  ClusterRole: { parents: [], children: ["Bindings"], peers: ["Events"], derivation: "RoleBinding.roleRef" },
  RoleBinding: { parents: ["Granted role"], children: [], peers: ["Events"], derivation: "roleRef" },
  ClusterRoleBinding: { parents: ["Granted role"], children: [], peers: ["Events"], derivation: "roleRef" },
  PodSecurityPolicy: { parents: [], children: [], peers: ["Events"], derivation: "involvedObject" },
  CustomResourceDefinition: { parents: [], children: ["Instances"], peers: [], derivation: "CRD storage version" },
  HelmRelease: { parents: [], children: [], peers: ["Events"], derivation: "involvedObject" },
  HelmChart: { parents: [], children: [], peers: [], derivation: "external chart catalog" },
  PortForward: { parents: ["Target resource"], children: [], peers: [], derivation: "port-forward target" },
  CustomResource: { parents: ["Owner controller"], children: [], peers: ["Events"], derivation: "metadata.ownerReferences" },
};

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string => value === undefined || value === null ? "" : String(value);
const DRAWER_RELATION_LIMIT = 8;

const resourceNameByKind: Record<string, string> = {
  Node: "Nodes", Namespace: "Namespaces", Event: "Events", Pod: "Pods", Deployment: "Deployments", DaemonSet: "DaemonSets", StatefulSet: "StatefulSets",
  ReplicaSet: "ReplicaSets", ReplicationController: "Replication Controllers", Job: "Jobs", CronJob: "CronJobs", Service: "Services", Endpoints: "Endpoints",
  Ingress: "Ingresses", IngressClass: "Ingress Classes", NetworkPolicy: "Network Policies", PersistentVolumeClaim: "Persistent Volume Claims",
  PersistentVolume: "Persistent Volumes", StorageClass: "Storage Classes", ConfigMap: "Config Maps", Secret: "Secrets", ResourceQuota: "Resource Quotas",
  LimitRange: "Limit Ranges", HorizontalPodAutoscaler: "Horizontal Pod Autoscalers", VerticalPodAutoscaler: "Vertical Pod Autoscalers",
  PodDisruptionBudget: "Pod Disruption Budgets", PriorityClass: "Priority Classes", RuntimeClass: "Runtime Classes", Lease: "Leases",
  MutatingWebhookConfiguration: "Mutating Webhook Configs", ValidatingWebhookConfiguration: "Validating Webhook Configs", ServiceAccount: "Service Accounts",
  ClusterRole: "Cluster Roles", Role: "Roles", ClusterRoleBinding: "Cluster Role Bindings", RoleBinding: "Role Bindings", PodSecurityPolicy: "Pod Security Policies",
  CustomResourceDefinition: "Custom Resource Definitions",
};

type OwnerReference = { apiVersion?: string; kind: string; name: string; uid?: string; controller?: boolean };

function source(row: ResourceRow): Record<string, unknown> {
  return row.backend?.object ?? {};
}

function namespaceFor(row: ResourceRow) {
  return row.namespace === "—" ? undefined : row.namespace;
}

function labelsOf(row: ResourceRow): Record<string, string> {
  const labels = object(detailValueAt(source(row), "metadata.labels"));
  if (Object.keys(labels).length) return Object.fromEntries(Object.entries(labels).map(([key, value]) => [key, string(value)]));
  const fallback = string(row.data.labels);
  const parsed = Object.fromEntries(fallback.split(",").map((entry) => entry.trim().split("=", 2)).filter((entry): entry is [string, string] => entry.length === 2 && Boolean(entry[0])));
  if (Object.keys(parsed).length) return parsed;
  return row.workload ? { app: row.workload.name } : {};
}

function selectorOf(value: unknown): Record<string, string> {
  const sourceValue = object(value);
  const matchLabels = object(sourceValue.matchLabels);
  const values = Object.keys(matchLabels).length ? matchLabels : sourceValue;
  return Object.fromEntries(Object.entries(values).filter(([key]) => key !== "matchExpressions").map(([key, entry]) => [key, string(entry)]));
}

function selectorFromRow(row: ResourceRow, path = "spec.selector"): Record<string, string> {
  const direct = selectorOf(detailValueAt(source(row), path));
  if (Object.keys(direct).length) return direct;
  const raw = string(row.data[path.endsWith("podSelector") ? "podSelector" : "selector"]);
  return Object.fromEntries(raw.split(",").map((entry) => entry.trim().split("=", 2)).filter((entry): entry is [string, string] => entry.length === 2 && Boolean(entry[0])));
}

function labelSelectorQuery(value: unknown) {
  const sourceValue = object(value);
  const terms = Object.entries(object(sourceValue.matchLabels)).map(([key, entry]) => `${key}=${string(entry)}`);
  if (!terms.length && !Array.isArray(sourceValue.matchExpressions)) terms.push(...Object.entries(sourceValue).filter(([key]) => key !== "matchExpressions").map(([key, entry]) => `${key}=${string(entry)}`));
  for (const expression of array(sourceValue.matchExpressions)) {
    const key = string(detailValueAt(expression, "key"));
    const operator = string(detailValueAt(expression, "operator"));
    const values = array(detailValueAt(expression, "values")).map(string);
    if (!key) continue;
    if (operator === "In" && values.length) terms.push(`${key} in (${values.join(",")})`);
    else if (operator === "NotIn" && values.length) terms.push(`${key} notin (${values.join(",")})`);
    else if (operator === "Exists") terms.push(key);
    else if (operator === "DoesNotExist") terms.push(`!${key}`);
  }
  return terms.join(",");
}

function matchesLabelSelector(row: ResourceRow, value: unknown) {
  const selector = object(value);
  const labels = labelsOf(row);
  const direct = selectorOf(value);
  if (!Object.keys(direct).length) return false;
  if (!Object.entries(object(selector.matchLabels)).every(([key, entry]) => labels[key] === string(entry))) return false;
  if (!Object.keys(object(selector.matchLabels)).length && !Object.entries(direct).every(([key, entry]) => labels[key] === entry)) return false;
  return array(selector.matchExpressions).every((expression) => {
    const key = string(detailValueAt(expression, "key"));
    const operator = string(detailValueAt(expression, "operator"));
    const values = array(detailValueAt(expression, "values")).map(string);
    if (operator === "In") return labels[key] !== undefined && values.includes(labels[key]);
    if (operator === "NotIn") return labels[key] === undefined || !values.includes(labels[key]);
    if (operator === "Exists") return labels[key] !== undefined;
    if (operator === "DoesNotExist") return labels[key] === undefined;
    return false;
  });
}

function matchesSelector(row: ResourceRow, selector: Record<string, string>) {
  if (!Object.keys(selector).length) return false;
  const labels = labelsOf(row);
  if (Object.keys(labels).length) return Object.entries(selector).every(([key, value]) => labels[key] === value);
  const controller = row.links?.controlledBy?.name ?? string(row.data.controlledBy).split("/").at(-1) ?? "";
  return Object.values(selector).some((value) => controller === value || row.workload?.name === value || row.name.includes(value));
}

function ownerReferences(row: ResourceRow): OwnerReference[] {
  const refs = array(detailValueAt(source(row), "metadata.ownerReferences")).map((entry) => ({
    apiVersion: string(detailValueAt(entry, "apiVersion")) || undefined,
    kind: string(detailValueAt(entry, "kind")),
    name: string(detailValueAt(entry, "name")),
    uid: string(detailValueAt(entry, "uid")) || undefined,
    controller: detailValueAt(entry, "controller") === true,
  })).filter((entry) => entry.kind && entry.name);
  if (refs.length) return refs;
  const link = row.links?.controlledBy;
  return link ? [{ apiVersion: link.apiVersion, kind: link.kind, name: link.name, controller: true }] : [];
}

function ownedBy(row: ResourceRow, parent: OwnerReference) {
  return ownerReferences(row).some((owner) => {
    if (parent.uid && owner.uid) return owner.uid === parent.uid;
    const apiMatches = !parent.apiVersion || !owner.apiVersion || parent.apiVersion === owner.apiVersion;
    return apiMatches && owner.kind === parent.kind && owner.name === parent.name;
  });
}

function uniqueRows(rows: ResourceRow[]) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.kind}/${row.namespace}/${row.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

class RelationLoader {
  private cache = new Map<string, Promise<ResourceRow[]>>();
  readonly errors: string[] = [];

  constructor(private clusterId: string, private discovered: ApiResourceDescriptor[]) {}

  descriptor(kind: string, apiVersion?: string) {
    const exact = this.discovered.find((entry) => entry.kind === kind && (!apiVersion || entry.apiVersion === apiVersion));
    return exact ?? descriptorForResource(resourceNameByKind[kind] ?? kind, this.discovered);
  }

  list(kind: string, namespace?: string, options: { labelSelector?: string; fieldSelector?: string } = {}): Promise<ResourceRow[]> {
    if (!nativeBackendAvailable) {
      const key = `${kind}|${namespace ?? "*"}|${options.labelSelector ?? ""}|${options.fieldSelector ?? ""}`;
      const existing = this.cache.get(key);
      if (existing) return existing;
      const resource = resourceNameByKind[kind];
      const promise = Promise.resolve(resource ? getResourceRows(resource).filter((row) => !namespace || row.namespace === namespace) : []);
      this.cache.set(key, promise);
      return promise;
    }
    const descriptor = this.descriptor(kind);
    return descriptor ? this.listDescriptor(descriptor, namespace, options) : Promise.resolve([]);
  }

  listDescriptor(descriptor: ApiResourceDescriptor, namespace?: string, options: { labelSelector?: string; fieldSelector?: string } = {}): Promise<ResourceRow[]> {
    const key = `${descriptor.apiVersion}/${descriptor.kind}|${namespace ?? "*"}|${options.labelSelector ?? ""}|${options.fieldSelector ?? ""}`;
    const existing = this.cache.get(key);
    if (existing) return existing;
    const promise = (async () => {
      if (!descriptor.verbs.includes("list") && descriptor.verbs.length) return [];
      try {
        const response = await backend.listResources({ clusterId: this.clusterId, resource: descriptor, namespace: descriptor.namespaced ? namespace : undefined, ...options });
        return response.items.map((record) => rowFromBackend(record, descriptor));
      } catch (error) {
        this.errors.push(`${descriptor.kind}: ${String(error)}`);
        return [];
      }
    })();
    this.cache.set(key, promise);
    return promise;
  }

  async one(kind: string, name: string, namespace?: string, apiVersion?: string): Promise<ResourceRow | null> {
    if (!name) return null;
    if (!nativeBackendAvailable) {
      const rows = await this.list(kind, namespace);
      return rows.find((row) => row.name === name) ?? null;
    }
    const descriptor = this.descriptor(kind, apiVersion);
    if (!descriptor) return null;
    try {
      const detail = await backend.getResource({ clusterId: this.clusterId, resource: descriptor, namespace: descriptor.namespaced ? namespace : undefined, name });
      return rowFromBackend(detail, descriptor);
    } catch (error) {
      this.errors.push(`${kind}/${name}: ${String(error)}`);
      return null;
    }
  }
}

function group(id: string, title: string, direction: RelationDirection, description: string, items: ResourceRow[], error?: string): ResourceRelationGroup {
  const unique = uniqueRows(items);
  return { id, title, direction, description, items: unique.slice(0, DRAWER_RELATION_LIMIT), total: unique.length, error };
}

function addGroup(groups: ResourceRelationGroup[], id: string, title: string, direction: RelationDirection, description: string, items: ResourceRow[], error?: string) {
  if (!items.length && !error) return;
  groups.push(group(id, title, direction, description, items, error));
}

async function rowsForNames(loader: RelationLoader, kind: string, names: string[], namespace?: string) {
  const rows = await Promise.all([...new Set(names)].filter(Boolean).map((name) => loader.one(kind, name, namespace)));
  return rows.filter(Boolean) as ResourceRow[];
}

function splitNames(value: unknown) {
  return string(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function refsFromPod(row: ResourceRow) {
  const spec = object(detailValueAt(source(row), "spec"));
  const configMaps = new Set<string>();
  const secrets = new Set<string>();
  const claims = new Set<string>();
  for (const volume of array(spec.volumes)) {
    const configMap = string(detailValueAt(volume, "configMap.name")); if (configMap) configMaps.add(configMap);
    const secret = string(detailValueAt(volume, "secret.secretName")); if (secret) secrets.add(secret);
    const claim = string(detailValueAt(volume, "persistentVolumeClaim.claimName")); if (claim) claims.add(claim);
    for (const projected of array(detailValueAt(volume, "projected.sources"))) {
      const projectedConfig = string(detailValueAt(projected, "configMap.name")); if (projectedConfig) configMaps.add(projectedConfig);
      const projectedSecret = string(detailValueAt(projected, "secret.name")); if (projectedSecret) secrets.add(projectedSecret);
    }
  }
  for (const container of [...array(spec.initContainers), ...array(spec.containers), ...array(spec.ephemeralContainers)]) {
    for (const from of array(detailValueAt(container, "envFrom"))) {
      const configMap = string(detailValueAt(from, "configMapRef.name")); if (configMap) configMaps.add(configMap);
      const secret = string(detailValueAt(from, "secretRef.name")); if (secret) secrets.add(secret);
    }
    for (const env of array(detailValueAt(container, "env"))) {
      const configMap = string(detailValueAt(env, "valueFrom.configMapKeyRef.name")); if (configMap) configMaps.add(configMap);
      const secret = string(detailValueAt(env, "valueFrom.secretKeyRef.name")); if (secret) secrets.add(secret);
    }
  }
  for (const imagePull of array(spec.imagePullSecrets)) { const name = string(detailValueAt(imagePull, "name")); if (name) secrets.add(name); }
  for (const name of splitNames(row.data.configMaps)) configMaps.add(name);
  for (const name of splitNames(row.data.secrets)) secrets.add(name);
  for (const name of splitNames(row.data.claims)) claims.add(name);
  // Browser demo rows carry a workload name rather than a complete Pod spec.
  if (!row.backend && row.workload) {
    if (!configMaps.size) configMaps.add(`${row.workload.name}-config`);
    if (!secrets.size) secrets.add(`${row.workload.name}-tls`);
  }
  return { configMaps: [...configMaps], secrets: [...secrets], claims: [...claims] };
}

function podReferences(row: ResourceRow, kind: "ConfigMap" | "Secret" | "PersistentVolumeClaim", name: string) {
  const refs = refsFromPod(row);
  const names = kind === "ConfigMap" ? refs.configMaps : kind === "Secret" ? refs.secrets : refs.claims;
  if (names.includes(name)) return true;
  if (row.backend) return false;
  const workload = row.workload?.name ?? row.links?.controlledBy?.name?.replace(/-[a-f0-9]{8,}$/i, "") ?? "";
  const normalized = name.replace(/-(config|configuration|feature-flags|tls|secret|credentials)$/i, "");
  return Boolean(workload && normalized.length > 3 && (workload === normalized || workload.startsWith(`${normalized}-`)));
}

function endpointServiceName(row: ResourceRow) {
  const labels = object(detailValueAt(source(row), "metadata.labels"));
  return string(labels["kubernetes.io/service-name"] || row.data.service);
}

function ingressServiceNames(row: ResourceRow) {
  const names = new Set<string>();
  const spec = object(detailValueAt(source(row), "spec"));
  const fallback = string(detailValueAt(spec, "defaultBackend.service.name")); if (fallback) names.add(fallback);
  for (const rule of array(spec.rules)) for (const path of array(detailValueAt(rule, "http.paths"))) {
    const name = string(detailValueAt(path, "backend.service.name")); if (name) names.add(name);
  }
  if (!row.backend && !names.size && string(row.data.service)) names.add(string(row.data.service));
  return [...names];
}

function bindingRoleRef(row: ResourceRow) {
  const kind = string(detailValueAt(source(row), "roleRef.kind"));
  const name = string(detailValueAt(source(row), "roleRef.name"));
  if (kind && name) return { kind, name };
  const [fallbackKind = "", fallbackName = ""] = string(row.data.role).split("/", 2);
  return { kind: fallbackKind, name: fallbackName };
}

function eventObjectRef(row: ResourceRow) {
  const kind = string(detailValueAt(source(row), "regarding.kind") || detailValueAt(source(row), "involvedObject.kind"));
  const name = string(detailValueAt(source(row), "regarding.name") || detailValueAt(source(row), "involvedObject.name"));
  const apiVersion = string(detailValueAt(source(row), "regarding.apiVersion") || detailValueAt(source(row), "involvedObject.apiVersion"));
  const namespace = string(detailValueAt(source(row), "regarding.namespace") || detailValueAt(source(row), "involvedObject.namespace"));
  const uid = string(detailValueAt(source(row), "regarding.uid") || detailValueAt(source(row), "involvedObject.uid"));
  if (kind && name) return { apiVersion, kind, name, namespace, uid };
  const [fallbackKind = "", ...nameParts] = string(row.data.object).split("/");
  return { apiVersion: "", kind: fallbackKind, name: nameParts.join("/"), namespace: row.namespace === "—" ? "" : row.namespace, uid: "" };
}

async function eventsFor(loader: RelationLoader, row: ResourceRow) {
  if (row.kind === "Event") return [];
  const events = await loader.list("Event", namespaceFor(row));
  const uid = row.backend?.uid;
  return events.filter((event) => {
    const reference = eventObjectRef(event);
    if (uid && reference.uid === uid) return true;
    return reference.kind === row.kind && reference.name === row.name;
  });
}

async function ownerChildren(loader: RelationLoader, row: ResourceRow, kind: string) {
  const rows = await loader.list(kind, namespaceFor(row));
  return rows.filter((candidate) => ownedBy(candidate, { apiVersion: row.backend?.apiVersion, kind: row.kind, name: row.name, uid: row.backend?.uid ?? undefined }));
}

async function selectedPods(loader: RelationLoader, row: ResourceRow, path = "spec.selector") {
  const selectorValue = detailValueAt(source(row), path);
  const selector = selectorFromRow(row, path);
  if (!Object.keys(selector).length && !selectorValue) return [];
  const query = selectorValue ? labelSelectorQuery(selectorValue) : Object.entries(selector).map(([key, value]) => `${key}=${value}`).join(",");
  const pods = await loader.list("Pod", namespaceFor(row), query ? { labelSelector: query } : {});
  return selectorValue ? pods.filter((pod) => matchesLabelSelector(pod, selectorValue)) : pods.filter((pod) => matchesSelector(pod, selector));
}

async function primaryWorkload(loader: RelationLoader, row: ResourceRow): Promise<ResourceRow | null> {
  let reference = ownerReferences(row).find((owner) => owner.controller) ?? ownerReferences(row)[0];
  let current: ResourceRow | null = reference ? await loader.one(reference.kind, reference.name, namespaceFor(row), reference.apiVersion) : null;
  const visited = new Set<string>();
  // ReplicaSets and Jobs are implementation controllers.  Operators normally need
  // the Deployment or CronJob that owns the Pod, so walk through those layers.
  for (let depth = 0; current && depth < 4; depth += 1) {
    const key = `${current.kind}/${current.namespace}/${current.name}`;
    if (visited.has(key)) break;
    visited.add(key);
    const next = ownerReferences(current).find((owner) => owner.controller) ?? ownerReferences(current)[0];
    if (!next || !["ReplicaSet", "Job"].includes(current.kind)) break;
    const parent = await loader.one(next.kind, next.name, namespaceFor(current), next.apiVersion);
    if (!parent) break;
    current = parent;
  }
  return current;
}

async function workloadPods(loader: RelationLoader, row: ResourceRow): Promise<ResourceRow[]> {
  const namespace = namespaceFor(row);
  if (row.kind === "Deployment") {
    const replicaSets = await ownerChildren(loader, row, "ReplicaSet");
    const all = await loader.list("Pod", namespace);
    const throughReplicaSet = all.filter((pod) => replicaSets.some((replicaSet) => ownedBy(pod, { apiVersion: replicaSet.backend?.apiVersion, kind: "ReplicaSet", name: replicaSet.name, uid: replicaSet.backend?.uid ?? undefined })));
    return throughReplicaSet.length ? throughReplicaSet : selectedPods(loader, row);
  }
  if (["StatefulSet", "DaemonSet", "ReplicaSet", "ReplicationController", "Job"].includes(row.kind)) {
    const direct = await ownerChildren(loader, row, "Pod");
    return direct.length ? direct : selectedPods(loader, row);
  }
  return [];
}

async function crdInstances(loader: RelationLoader, row: ResourceRow) {
  const sourceValue = source(row);
  const groupName = string(detailValueAt(sourceValue, "spec.group"));
  const kind = string(detailValueAt(sourceValue, "spec.names.kind")) || string(row.data.kind);
  const plural = string(detailValueAt(sourceValue, "spec.names.plural"));
  const scope = string(detailValueAt(sourceValue, "spec.scope"));
  const versions = array(detailValueAt(sourceValue, "spec.versions"));
  const version = string(detailValueAt(versions.find((entry) => detailValueAt(entry, "storage") === true) ?? versions.find((entry) => detailValueAt(entry, "served") === true) ?? versions[0], "name"));
  if (nativeBackendAvailable && groupName && version && plural) {
    const descriptor: ApiResourceDescriptor = { apiVersion: `${groupName}/${version}`, group: groupName, version, kind, plural, namespaced: scope === "Namespaced", verbs: ["list", "get"], categories: [] };
    return loader.listDescriptor(descriptor);
  }
  const definition = customResourceDefinitions.find((entry) => entry.name === row.name || entry.kind === kind);
  return definition ? (customResources[definition.kind] ?? []).map((item) => ({ key: `${item.namespace}/${item.name}`, name: item.name, namespace: item.namespace, kind: definition.kind, status: item.status, data: { name: item.name, namespace: item.namespace, status: item.status, age: item.age } })) : [];
}

export async function resolveResourceRelations(clusterId: string, row: ResourceRow, discovered: ApiResourceDescriptor[]): Promise<ResourceRelationGroup[]> {
  const loader = new RelationLoader(clusterId, discovered);
  const groups: ResourceRelationGroup[] = [];
  const namespace = namespaceFor(row);

  switch (row.kind) {
    case "Pod": {
      const refs = refsFromPod(row);
      const [workload, configMaps, secrets, claims] = await Promise.all([
        primaryWorkload(loader, row),
        rowsForNames(loader, "ConfigMap", refs.configMaps, namespace),
        rowsForNames(loader, "Secret", refs.secrets, namespace),
        rowsForNames(loader, "PersistentVolumeClaim", refs.claims, namespace),
      ]);
      addGroup(groups, "workload", "Owning workload", "parent", "The top-level workload responsible for this Pod's lifecycle.", workload ? [workload] : []);
      addGroup(groups, "claims", "Mounted volume claims", "parent", "PersistentVolumeClaims mounted by this Pod.", claims);
      addGroup(groups, "configmaps", "Referenced ConfigMaps", "parent", "ConfigMaps used through volumes or container environment sources.", configMaps);
      addGroup(groups, "secrets", "Referenced Secrets", "parent", "Secrets used through volumes, image pulls, or container environment sources.", secrets);
      break;
    }
    case "Deployment":
    case "StatefulSet":
    case "DaemonSet":
    case "ReplicaSet":
    case "ReplicationController":
    case "Job": {
      const pods = await workloadPods(loader, row);
      addGroup(groups, "pods", "Managed Pods", "child", `Pods currently created and reconciled by this ${row.kind}.`, pods);
      if (row.kind === "StatefulSet") {
        const templates = array(detailValueAt(source(row), "spec.volumeClaimTemplates")).map((entry) => string(detailValueAt(entry, "metadata.name"))).filter(Boolean);
        const claims = (await loader.list("PersistentVolumeClaim", namespace)).filter((claim) => ownedBy(claim, { apiVersion: row.backend?.apiVersion, kind: row.kind, name: row.name, uid: row.backend?.uid ?? undefined }) || templates.some((template) => claim.name.startsWith(`${template}-${row.name}-`)));
        addGroup(groups, "claims", "Volume claims", "child", "Claims created from this StatefulSet's volume claim templates.", claims);
      }
      if (["ReplicaSet", "Job"].includes(row.kind)) {
        const owner = await primaryWorkload(loader, row);
        addGroup(groups, "workload", row.kind === "ReplicaSet" ? "Deployment" : "CronJob", "parent", "Top-level workload that created this controller.", owner ? [owner] : []);
      }
      break;
    }
    case "CronJob": {
      const jobs = await ownerChildren(loader, row, "Job");
      addGroup(groups, "jobs", "Recent Jobs", "child", "Jobs created by this schedule.", jobs);
      break;
    }
    case "Node": {
      const pods = (await loader.list("Pod")).filter((pod) => string(detailValueAt(source(pod), "spec.nodeName") || pod.data.node) === row.name);
      addGroup(groups, "pods", "Scheduled Pods", "child", "Pods currently assigned to this Node.", pods);
      break;
    }
    case "Service": {
      const selector = selectorFromRow(row);
      const pods = Object.keys(selector).length ? (await loader.list("Pod", namespace, { labelSelector: Object.entries(selector).map(([key, value]) => `${key}=${value}`).join(",") })).filter((pod) => matchesSelector(pod, selector)) : [];
      const [endpoints, endpointSlices] = await Promise.all([
        loader.one("Endpoints", row.name, namespace),
        loader.list("EndpointSlice", namespace, { labelSelector: `kubernetes.io/service-name=${row.name}` }),
      ]);
      addGroup(groups, "pods", "Selected Pods", "child", "Pods selected as Service backends.", pods);
      addGroup(groups, "endpoints", "Endpoints", "child", "Endpoint objects representing the Service's ready and unready backends.", [...(endpoints ? [endpoints] : []), ...endpointSlices]);
      break;
    }
    case "Endpoints": {
      const service = await loader.one("Service", row.name, namespace);
      const podNames = array(detailValueAt(source(row), "subsets")).flatMap((subset) => [...array(detailValueAt(subset, "addresses")), ...array(detailValueAt(subset, "notReadyAddresses"))]).filter((address) => string(detailValueAt(address, "targetRef.kind")) === "Pod").map((address) => string(detailValueAt(address, "targetRef.name")));
      const addresses = new Set(splitNames(row.data.addresses));
      const pods = podNames.length ? await rowsForNames(loader, "Pod", podNames, namespace) : (await loader.list("Pod", namespace)).filter((pod) => addresses.has(string(pod.data.ip)));
      addGroup(groups, "service", "Service", "parent", "Service sharing this Endpoints object's name.", service ? [service] : []);
      addGroup(groups, "pods", "Target Pods", "peer", "Pods referenced by endpoint target references.", pods);
      break;
    }
    case "EndpointSlice": {
      const serviceName = endpointServiceName(row);
      const service = await loader.one("Service", serviceName, namespace);
      const podNames = array(detailValueAt(source(row), "endpoints")).filter((endpoint) => string(detailValueAt(endpoint, "targetRef.kind")) === "Pod").map((endpoint) => string(detailValueAt(endpoint, "targetRef.name")));
      const pods = await rowsForNames(loader, "Pod", podNames, namespace);
      addGroup(groups, "service", "Service", "parent", "Service identified by the EndpointSlice service-name label.", service ? [service] : []);
      addGroup(groups, "pods", "Target Pods", "peer", "Pods referenced by endpoint target references.", pods);
      break;
    }
    case "Ingress": {
      const services = await rowsForNames(loader, "Service", ingressServiceNames(row), namespace);
      const secretNames = array(detailValueAt(source(row), "spec.tls")).map((entry) => string(detailValueAt(entry, "secretName"))).filter(Boolean);
      const secrets = await rowsForNames(loader, "Secret", secretNames, namespace);
      addGroup(groups, "services", "Backend Services", "peer", "Services referenced by this Ingress's default backend and paths.", services);
      addGroup(groups, "tls", "TLS Secrets", "peer", "Secrets holding certificates selected by this Ingress.", secrets);
      break;
    }
    case "NetworkPolicy":
      addGroup(groups, "pods", "Selected Pods", "peer", "Pods to which this NetworkPolicy applies.", await selectedPods(loader, row, "spec.podSelector"));
      break;
    case "PersistentVolumeClaim": {
      const volumeName = string(detailValueAt(source(row), "spec.volumeName") || row.data.volume);
      const volume = await loader.one("PersistentVolume", volumeName);
      addGroup(groups, "volume", "Bound PersistentVolume", "parent", "PersistentVolume bound to this claim.", volume ? [volume] : []);
      break;
    }
    case "PersistentVolume": {
      const claimName = string(detailValueAt(source(row), "spec.claimRef.name")) || string(row.data.claim).split("/").at(-1);
      const claimNamespace = string(detailValueAt(source(row), "spec.claimRef.namespace")) || string(row.data.claim).split("/").at(0);
      const claim = await loader.one("PersistentVolumeClaim", claimName, claimNamespace || undefined);
      addGroup(groups, "claim", "Bound PersistentVolumeClaim", "child", "Claim bound through the PersistentVolume claim reference.", claim ? [claim] : []);
      break;
    }
    case "ConfigMap":
    case "Secret": {
      const pods = (await loader.list("Pod", namespace)).filter((pod) => podReferences(pod, row.kind, row.name));
      addGroup(groups, "pods", "Referencing Pods", "peer", `Pods that consume this ${row.kind} through a volume or container environment source.`, pods);
      break;
    }
    case "HorizontalPodAutoscaler": {
      const fallback = string(row.data.reference).split("/");
      const kind = string(detailValueAt(source(row), "spec.scaleTargetRef.kind")) || fallback[0];
      const name = string(detailValueAt(source(row), "spec.scaleTargetRef.name")) || fallback[1];
      const target = await loader.one(kind, name, namespace);
      addGroup(groups, "target", "Scale target", "parent", "Workload whose scale is controlled by this HPA.", target ? [target] : []);
      break;
    }
    case "VerticalPodAutoscaler": {
      const fallback = string(row.data.reference).split("/");
      const kind = string(detailValueAt(source(row), "spec.targetRef.kind")) || fallback[0];
      const name = string(detailValueAt(source(row), "spec.targetRef.name")) || fallback[1];
      const target = await loader.one(kind, name, namespace);
      addGroup(groups, "target", "Recommendation target", "parent", "Workload receiving recommendations or updates from this VPA.", target ? [target] : []);
      break;
    }
    case "PodDisruptionBudget":
      addGroup(groups, "pods", "Protected Pods", "peer", "Pods selected by this disruption budget.", await selectedPods(loader, row));
      break;
    case "ServiceAccount": {
      const pods = (await loader.list("Pod", namespace)).filter((pod) => string(detailValueAt(source(pod), "spec.serviceAccountName") || pod.data.serviceAccount || "default") === row.name);
      addGroup(groups, "pods", "Pods", "child", "Pods currently running with this ServiceAccount.", pods);
      break;
    }
    case "Role":
    case "ClusterRole": {
      const [roleBindings, clusterBindings] = await Promise.all([loader.list("RoleBinding", row.kind === "Role" ? namespace : undefined), loader.list("ClusterRoleBinding")]);
      const bindings = [...roleBindings, ...clusterBindings].filter((binding) => {
        const ref = bindingRoleRef(binding);
        return ref.kind === row.kind && ref.name === row.name;
      });
      addGroup(groups, "bindings", "Bindings", "child", `Bindings that grant this ${row.kind}.`, bindings);
      break;
    }
    case "RoleBinding":
    case "ClusterRoleBinding": {
      const ref = bindingRoleRef(row);
      const role = await loader.one(ref.kind, ref.name, ref.kind === "Role" ? namespace : undefined);
      addGroup(groups, "role", "Granted role", "parent", "Role or ClusterRole referenced by this binding.", role ? [role] : []);
      break;
    }
    case "MutatingWebhookConfiguration":
    case "ValidatingWebhookConfiguration": {
      const refs = array(detailValueAt(source(row), "webhooks")).map((entry) => ({ name: string(detailValueAt(entry, "clientConfig.service.name")), namespace: string(detailValueAt(entry, "clientConfig.service.namespace")) })).filter((entry) => entry.name);
      const services = (await Promise.all(refs.map((ref) => loader.one("Service", ref.name, ref.namespace || undefined)))).filter(Boolean) as ResourceRow[];
      addGroup(groups, "services", "Webhook Services", "peer", "Services called by webhook client configurations.", services);
      break;
    }
    case "CustomResourceDefinition":
      addGroup(groups, "instances", `${string(detailValueAt(source(row), "spec.names.kind") || row.data.kind) || "Custom resource"} instances`, "child", "Instances served by this custom resource definition.", await crdInstances(loader, row));
      break;
    case "Event": {
      const ref = eventObjectRef(row);
      const target = await loader.one(ref.kind, ref.name, ref.namespace || namespace, ref.apiVersion || undefined);
      addGroup(groups, "regarding", "Regarding resource", "parent", "Resource named by this Event's regarding or involved-object reference.", target ? [target] : []);
      break;
    }
    case "PortForward": {
      const [targetKind = "Pod", targetName = row.name] = row.name.includes("/") ? row.name.split("/", 2) : ["Pod", row.name];
      const target = await loader.one(targetKind, targetName, namespace);
      addGroup(groups, "target", `Target ${targetKind}`, "parent", "Kubernetes resource receiving traffic from this local port forward.", target ? [target] : []);
      break;
    }
    default: {
      const owner = await primaryWorkload(loader, row);
      addGroup(groups, "owner", "Owner controller", "parent", "Direct owner controller of this resource.", owner ? [owner] : []);
      break;
    }
  }

  const events = await eventsFor(loader, row);
  addGroup(groups, "events", "Recent events", "peer", "Kubernetes Events referring directly to this resource.", events);
  if (loader.errors.length && groups.length) groups[0].error = loader.errors.slice(0, 2).join(" · ");
  return groups;
}

export async function resolveResourceLink(clusterId: string, link: { apiVersion?: string; kind: string; name: string; namespace?: string }, discovered: ApiResourceDescriptor[]): Promise<ResourceRow | null> {
  return new RelationLoader(clusterId, discovered).one(link.kind, link.name, link.namespace, link.apiVersion);
}
