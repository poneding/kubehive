import { backend, descriptorForResource, nativeBackendAvailable, type ApiResourceDescriptor, type BackendResourceRecord } from "./backend";
import { getResourceRows, type ResourceRow } from "./resource-catalog";
import { customResourceDefinitions, customResources } from "./data";
import { rowFromBackend } from "./k8s-adapter";
import { detailValueAt } from "./resource-details";

export type RelationDirection = "parent" | "child" | "peer";

export type ResourceRelationGroup = {
  id: string;
  title: string;
  direction: RelationDirection;
  description: string;
  items: ResourceRow[];
  error?: string;
};

export type RelationshipMatrixEntry = {
  parents: string[];
  children: string[];
  peers: string[];
  derivation: string;
};

export const RESOURCE_RELATIONSHIP_MATRIX: Record<string, RelationshipMatrixEntry> = {
  Node: { parents: [], children: ["Pods", "Lease"], peers: ["Events"], derivation: "Pod.spec.nodeName; kube-node-lease name; Event involvedObject" },
  Namespace: { parents: [], children: ["Pods", "Workloads", "Services", "ConfigMaps", "Secrets", "PVCs", "Events"], peers: [], derivation: "metadata.namespace" },
  Event: { parents: ["Involved object", "Namespace"], children: [], peers: [], derivation: "involvedObject kind/name/uid" },
  Pod: { parents: ["Owner controller", "Node", "Namespace", "ServiceAccount", "PriorityClass", "RuntimeClass", "PVC", "ConfigMap", "Secret"], children: [], peers: ["Services", "Events"], derivation: "ownerReferences and Pod spec refs; Service selector against Pod labels" },
  Deployment: { parents: ["Namespace"], children: ["ReplicaSets", "Managed Pods"], peers: ["HPA", "VPA", "PDB", "Services", "Events"], derivation: "ownerReferences plus spec.selector; Pods are resolved transitively through ReplicaSets and selector" },
  StatefulSet: { parents: ["Namespace"], children: ["Managed Pods", "PVCs"], peers: ["Headless Service", "HPA", "VPA", "PDB", "Events"], derivation: "ownerReferences, selector, serviceName, volumeClaimTemplates" },
  DaemonSet: { parents: ["Namespace"], children: ["Managed Pods"], peers: ["Events"], derivation: "Pod ownerReferences and selector" },
  ReplicaSet: { parents: ["Deployment", "Namespace"], children: ["Managed Pods"], peers: ["Events"], derivation: "ownerReferences" },
  ReplicationController: { parents: ["Namespace"], children: ["Managed Pods"], peers: ["Services", "Events"], derivation: "ownerReferences and selector" },
  Job: { parents: ["CronJob", "Namespace"], children: ["Managed Pods"], peers: ["Events"], derivation: "ownerReferences" },
  CronJob: { parents: ["Namespace"], children: ["Jobs", "Managed Pods"], peers: ["Events"], derivation: "Job ownerReferences; Pods through Jobs" },
  Service: { parents: ["Namespace"], children: ["Selected Pods", "Endpoints"], peers: ["Ingresses", "Events"], derivation: "spec.selector; same-name Endpoints; Ingress service backends" },
  Endpoints: { parents: ["Service", "Namespace"], children: [], peers: ["Target Pods", "Events"], derivation: "same name and subset.addresses.targetRef" },
  Ingress: { parents: ["IngressClass", "Namespace"], children: [], peers: ["Backend Services", "TLS Secrets", "Events"], derivation: "spec.ingressClassName, rules backends, tls.secretName" },
  IngressClass: { parents: [], children: ["Ingresses"], peers: [], derivation: "Ingress.spec.ingressClassName" },
  NetworkPolicy: { parents: ["Namespace"], children: [], peers: ["Selected Pods", "Events"], derivation: "spec.podSelector" },
  PersistentVolumeClaim: { parents: ["PersistentVolume", "StorageClass", "Namespace", "StatefulSet"], children: [], peers: ["Mounted Pods", "Events"], derivation: "spec.volumeName/storageClassName, ownerReferences, Pod volumes" },
  PersistentVolume: { parents: ["StorageClass"], children: ["Claim"], peers: ["Mounted Pods", "Events"], derivation: "spec.claimRef and storageClassName; Pods through PVC" },
  StorageClass: { parents: [], children: ["PersistentVolumes", "PersistentVolumeClaims"], peers: [], derivation: "spec.storageClassName" },
  ConfigMap: { parents: ["Namespace"], children: [], peers: ["Referencing Pods", "Events"], derivation: "Pod volumes/env/envFrom/projected refs" },
  Secret: { parents: ["Namespace"], children: [], peers: ["Referencing Pods", "Ingresses", "ServiceAccounts", "Events"], derivation: "Pod refs, Ingress TLS, ServiceAccount secrets/imagePullSecrets" },
  ResourceQuota: { parents: ["Namespace"], children: [], peers: ["Events"], derivation: "metadata.namespace" },
  LimitRange: { parents: ["Namespace"], children: [], peers: ["Events"], derivation: "metadata.namespace" },
  HorizontalPodAutoscaler: { parents: ["Scale target", "Namespace"], children: [], peers: ["Events"], derivation: "spec.scaleTargetRef" },
  VerticalPodAutoscaler: { parents: ["Target", "Namespace"], children: [], peers: ["Events"], derivation: "spec.targetRef" },
  PodDisruptionBudget: { parents: ["Namespace"], children: [], peers: ["Selected Pods", "Controllers", "Events"], derivation: "spec.selector and selected Pod ownerReferences" },
  PriorityClass: { parents: [], children: ["Pods"], peers: [], derivation: "Pod.spec.priorityClassName" },
  RuntimeClass: { parents: [], children: ["Pods"], peers: [], derivation: "Pod.spec.runtimeClassName" },
  Lease: { parents: ["Namespace", "Node/holder"], children: [], peers: [], derivation: "kube-node-lease naming and spec.holderIdentity" },
  MutatingWebhookConfiguration: { parents: [], children: [], peers: ["Webhook Services"], derivation: "webhooks.clientConfig.service" },
  ValidatingWebhookConfiguration: { parents: [], children: [], peers: ["Webhook Services"], derivation: "webhooks.clientConfig.service" },
  ServiceAccount: { parents: ["Namespace"], children: ["Pods"], peers: ["RoleBindings", "ClusterRoleBindings", "Secrets"], derivation: "Pod serviceAccountName, binding subjects, secret refs" },
  Role: { parents: ["Namespace"], children: ["RoleBindings"], peers: [], derivation: "RoleBinding.roleRef" },
  ClusterRole: { parents: [], children: ["RoleBindings", "ClusterRoleBindings"], peers: [], derivation: "roleRef" },
  RoleBinding: { parents: ["Role/ClusterRole", "Namespace"], children: [], peers: ["ServiceAccount subjects"], derivation: "roleRef and subjects" },
  ClusterRoleBinding: { parents: ["ClusterRole"], children: [], peers: ["ServiceAccount subjects"], derivation: "roleRef and subjects" },
  PodSecurityPolicy: { parents: [], children: [], peers: ["Roles allowing use"], derivation: "RBAC rules with resourceNames" },
  CustomResourceDefinition: { parents: [], children: ["Custom resource instances"], peers: [], derivation: "CRD group/version/plural/scope" },
  HelmRelease: { parents: ["Namespace"], children: ["Managed resources"], peers: [], derivation: "meta.helm.sh/release-name and release-namespace annotations" },
  HelmChart: { parents: [], children: [], peers: [], derivation: "External repository catalog item" },
  PortForward: { parents: ["Target Pod"], children: [], peers: [], derivation: "active port-forward session target" },
  CustomResource: { parents: ["Owner references", "Namespace"], children: ["Owned resources"], peers: ["Events"], derivation: "metadata.ownerReferences; dynamic discovery scan for matching owner UID" },
};

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string => value === undefined || value === null ? "" : String(value);

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

function source(row: ResourceRow): Record<string, unknown> {
  return row.backend?.object ?? {};
}

function labelsOf(row: ResourceRow): Record<string, string> {
  const labels = object(detailValueAt(source(row), "metadata.labels"));
  if (Object.keys(labels).length) return Object.fromEntries(Object.entries(labels).map(([key, value]) => [key, string(value)]));
  const fromData = string(row.data.labels);
  return Object.fromEntries(fromData.split(",").map((entry) => entry.trim().split("=", 2)).filter((entry) => entry.length === 2) as Array<[string, string]>);
}

function selectorOf(value: unknown): Record<string, string> {
  const matchLabels = object(detailValueAt(value, "matchLabels") ?? value);
  return Object.fromEntries(Object.entries(matchLabels).map(([key, entry]) => [key, string(entry)]));
}

function selectorFromRow(row: ResourceRow, path = "spec.selector"): Record<string, string> {
  const direct = selectorOf(detailValueAt(source(row), path));
  if (Object.keys(direct).length) return direct;
  return selectorOf(Object.fromEntries(string(row.data.selector || row.data.podSelector).split(",").map((entry) => entry.trim().split("=", 2)).filter((entry) => entry.length === 2) as Array<[string, string]>));
}

function selectorCoveredBy(selector: Record<string, string>, labels: Record<string, string>) {
  return Object.keys(selector).length > 0 && Object.entries(selector).every(([key, value]) => labels[key] === value);
}

function labelSelectorQuery(value: unknown) {
  const source = object(value);
  const terms = Object.entries(object(source.matchLabels)).map(([key, entry]) => `${key}=${string(entry)}`);
  for (const expression of array(source.matchExpressions)) {
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
  if (!Object.keys(labels).length) return matchesSelector(row, selectorOf(value));
  if (!Object.entries(object(selector.matchLabels)).every(([key, entry]) => labels[key] === string(entry))) return false;
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
  const controller = row.links?.controlledBy?.name ?? string(row.data.controlledBy).split("/").at(-1);
  return Object.values(selector).some((value) => controller === value || row.name.includes(value));
}

function ownerReferences(row: ResourceRow): Array<{ apiVersion?: string; kind: string; name: string; uid?: string }> {
  const refs = array(detailValueAt(source(row), "metadata.ownerReferences")).map((entry) => ({ apiVersion: string(detailValueAt(entry, "apiVersion")), kind: string(detailValueAt(entry, "kind")), name: string(detailValueAt(entry, "name")), uid: string(detailValueAt(entry, "uid")) })).filter((entry) => entry.kind && entry.name);
  if (refs.length) return refs;
  const link = row.links?.controlledBy;
  return link ? [{ apiVersion: link.apiVersion, kind: link.kind, name: link.name }] : [];
}

function ownedBy(row: ResourceRow, parent: { apiVersion?: string; kind: string; name: string; uid?: string }) {
  return ownerReferences(row).some((owner) => {
    if (parent.uid) return owner.uid === parent.uid;
    const apiMatches = !parent.apiVersion || !owner.apiVersion || owner.apiVersion === parent.apiVersion;
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
    if (apiVersion) return exact;
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
        this.errors.push(`${descriptor.apiVersion}/${descriptor.kind}: ${String(error)}`);
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
  return { id, title, direction, description, items: uniqueRows(items).slice(0, 50), error };
}

function selectorQuery(selector: Record<string, string>) {
  return Object.entries(selector).map(([key, value]) => `${key}=${value}`).join(",");
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
  for (const container of [...array(spec.initContainers), ...array(spec.containers)]) {
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
  const controllerName = row.links?.controlledBy?.name ?? string(row.data.controlledBy).split("/").at(-1) ?? "";
  return { configMaps: [...configMaps], secrets: [...secrets], claims: [...claims], serviceAccount: string(spec.serviceAccountName || row.data.serviceAccount || controllerName || "default"), priorityClass: string(spec.priorityClassName || row.data.priorityClass), runtimeClass: string(spec.runtimeClassName || row.data.runtimeClass), node: string(spec.nodeName || row.data.node) };
}

function podReferences(row: ResourceRow, kind: "ConfigMap" | "Secret" | "PersistentVolumeClaim", name: string) {
  const refs = refsFromPod(row);
  if (!row.backend) {
    if (kind === "PersistentVolumeClaim" && refs.claims.length === 0) return row.name === name;
    const references = kind === "ConfigMap" ? refs.configMaps : refs.secrets;
    if (references.length === 0) {
      const controller = row.links?.controlledBy?.name ?? string(row.data.controlledBy).split("/").at(-1) ?? "";
      const normalized = name.replace(/-(config|configuration|feature-flags|tls|secret|credentials)$/i, "");
      return normalized.length > 3 && (controller === normalized || controller.startsWith(`${normalized}-`) || name.startsWith(`${controller}-`));
    }
  }
  return kind === "ConfigMap" ? refs.configMaps.includes(name) : kind === "Secret" ? refs.secrets.includes(name) : refs.claims.includes(name);
}

function ingressServiceNames(row: ResourceRow) {
  const names = new Set<string>();
  const spec = object(detailValueAt(source(row), "spec"));
  const fallback = string(detailValueAt(spec, "defaultBackend.service.name")); if (fallback) names.add(fallback);
  for (const rule of array(spec.rules)) for (const path of array(detailValueAt(rule, "http.paths"))) {
    const name = string(detailValueAt(path, "backend.service.name")); if (name) names.add(name);
  }
  if (!row.backend && names.size === 0) names.add(string(row.data.service) || row.name);
  return [...names];
}

function bindingRoleRef(row: ResourceRow) {
  const kind = string(detailValueAt(source(row), "roleRef.kind"));
  const name = string(detailValueAt(source(row), "roleRef.name"));
  if (kind && name) return { kind, name };
  const [fallbackKind = "", fallbackName = ""] = string(row.data.role).split("/", 2);
  return { kind: fallbackKind, name: fallbackName };
}

function bindingServiceAccounts(row: ResourceRow) {
  const live = array(detailValueAt(source(row), "subjects")).filter((subject) => string(detailValueAt(subject, "kind")) === "ServiceAccount").map((subject) => ({ name: string(detailValueAt(subject, "name")), namespace: string(detailValueAt(subject, "namespace")) || row.namespace })).filter((subject) => subject.name);
  if (live.length) return live;
  const value = string(row.data.subjects);
  const parts = value.split("/");
  if (parts[0] === "SA" && parts[1]) return [{ name: parts[1], namespace: row.namespace }];
  if (parts[0] === "ServiceAccount" && parts.length >= 3) return [{ name: parts.slice(2).join("/"), namespace: parts[1] }];
  return [];
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

function webhookServiceRefs(row: ResourceRow) {
  return uniqueStringRefs(array(detailValueAt(source(row), "webhooks")).map((entry) => ({ name: string(detailValueAt(entry, "clientConfig.service.name")), namespace: string(detailValueAt(entry, "clientConfig.service.namespace")) })));
}

function uniqueStringRefs<T extends { name: string; namespace?: string }>(refs: T[]) {
  const seen = new Set<string>();
  return refs.filter((ref) => ref.name && !seen.has(`${ref.namespace ?? ""}/${ref.name}`) && Boolean(seen.add(`${ref.namespace ?? ""}/${ref.name}`)));
}

async function rowsForNames(loader: RelationLoader, kind: string, names: string[], namespace?: string) {
  const rows = await Promise.all([...new Set(names)].filter(Boolean).map((name) => loader.one(kind, name, namespace)));
  return rows.filter(Boolean) as ResourceRow[];
}

async function selectedPods(loader: RelationLoader, row: ResourceRow, path = "spec.selector") {
  const selectorValue = detailValueAt(source(row), path);
  const selector = selectorFromRow(row, path);
  const namespace = row.namespace === "—" ? undefined : row.namespace;
  const query = selectorValue ? labelSelectorQuery(selectorValue) : selectorQuery(selector);
  const pods = await loader.list("Pod", namespace, query ? { labelSelector: query } : {});
  return selectorValue ? pods.filter((pod) => matchesLabelSelector(pod, selectorValue)) : pods.filter((pod) => matchesSelector(pod, selector));
}

async function eventsFor(loader: RelationLoader, row: ResourceRow) {
  if (row.kind === "Event") return [];
  const events = await loader.list("Event", row.namespace === "—" ? undefined : row.namespace);
  const uid = row.backend?.uid;
  return events.filter((event) => {
    const reference = eventObjectRef(event);
    if (uid && reference.uid === uid) return true;
    return reference.kind === row.kind && reference.name === row.name;
  });
}

async function ownerChildren(loader: RelationLoader, row: ResourceRow, kind: string) {
  const rows = await loader.list(kind, row.namespace === "—" ? undefined : row.namespace);
  return rows.filter((candidate) => ownedBy(candidate, { apiVersion: row.backend?.apiVersion, kind: row.kind, name: row.name, uid: row.backend?.uid ?? undefined }));
}

async function dynamicOwnedResources(loader: RelationLoader, row: ResourceRow, discovered: ApiResourceDescriptor[]) {
  if (!row.backend?.uid) return [];
  const candidates = discovered.filter((descriptor) => descriptor.verbs.includes("list") && descriptor.kind !== row.kind && !["Event", "Namespace", "Node"].includes(descriptor.kind)).slice(0, 80);
  const found: ResourceRow[] = [];
  for (let index = 0; index < candidates.length; index += 8) {
    const batch = await Promise.all(candidates.slice(index, index + 8).map((descriptor) => loader.listDescriptor(descriptor, descriptor.namespaced && row.namespace !== "—" ? row.namespace : undefined)));
    for (const rows of batch) found.push(...rows.filter((candidate) => ownedBy(candidate, { apiVersion: row.backend?.apiVersion, kind: row.kind, name: row.name, uid: row.backend?.uid ?? undefined })));
    if (found.length >= 50) break;
  }
  return uniqueRows(found);
}

export async function resolveResourceRelations(clusterId: string, row: ResourceRow, discovered: ApiResourceDescriptor[]): Promise<ResourceRelationGroup[]> {
  const loader = new RelationLoader(clusterId, discovered);
  const groups: ResourceRelationGroup[] = [];
  const namespace = row.namespace === "—" ? undefined : row.namespace;
  const add = (value: ResourceRelationGroup) => groups.push(value);

  if (namespace && row.kind !== "Namespace") {
    const parent = await loader.one("Namespace", namespace);
    add(group("namespace", "Namespace", "parent", "Namespace containing this resource.", parent ? [parent] : []));
  }

  const owners = await Promise.all(ownerReferences(row).map((owner) => loader.one(owner.kind, owner.name, namespace, owner.apiVersion)));
  const ownerRows = owners.filter(Boolean) as ResourceRow[];
  if (ownerReferences(row).length || ownerRows.length) add(group("owners", "Owner controllers", "parent", "Direct Kubernetes ownerReferences. Garbage collection and lifecycle normally follow these owners.", ownerRows));

  switch (row.kind) {
    case "Deployment": {
      const replicaSets = await ownerChildren(loader, row, "ReplicaSet");
      const selectorValue = detailValueAt(source(row), "spec.selector");
      const selector = selectorFromRow(row);
      const query = selectorValue ? labelSelectorQuery(selectorValue) : selectorQuery(selector);
      const allPods = await loader.list("Pod", namespace, query ? { labelSelector: query } : {});
      const ownedPods = allPods.filter((pod) => replicaSets.some((replicaSet) => ownedBy(pod, { apiVersion: replicaSet.backend?.apiVersion, kind: "ReplicaSet", name: replicaSet.name, uid: replicaSet.backend?.uid ?? undefined })));
      const pods = replicaSets.length ? ownedPods : allPods.filter((pod) => (selectorValue ? matchesLabelSelector(pod, selectorValue) : matchesSelector(pod, selector)) || pod.links?.controlledBy?.name === row.name);
      add(group("replicasets", "ReplicaSets", "child", "ReplicaSets created and reconciled by this Deployment.", replicaSets));
      add(group("pods", "Managed Pods", "child", "Pods managed by this Deployment, resolved through ReplicaSets and the Deployment selector.", pods));
      break;
    }
    case "StatefulSet": {
      const selected = await selectedPods(loader, row);
      const pods = selected.length ? selected : await ownerChildren(loader, row, "Pod");
      const serviceName = string(detailValueAt(source(row), "spec.serviceName"));
      const service = serviceName ? await loader.one("Service", serviceName, namespace) : null;
      const templates = array(detailValueAt(source(row), "spec.volumeClaimTemplates")).map((entry) => string(detailValueAt(entry, "metadata.name"))).filter(Boolean);
      const claims = (await loader.list("PersistentVolumeClaim", namespace)).filter((claim) => ownedBy(claim, { apiVersion: row.backend?.apiVersion, kind: row.kind, name: row.name, uid: row.backend?.uid ?? undefined }) || templates.some((template) => claim.name.startsWith(`${template}-${row.name}-`)));
      add(group("pods", "Managed Pods", "child", "Stable ordinal Pods selected and managed by this StatefulSet.", pods));
      add(group("claims", "Volume Claims", "child", "PersistentVolumeClaims created from volumeClaimTemplates.", claims));
      add(group("service", "Governing Service", "peer", "Service providing stable network identity for StatefulSet Pods.", service ? [service] : []));
      break;
    }
    case "DaemonSet":
    case "ReplicaSet":
    case "ReplicationController":
    case "Job": {
      const pods = await ownerChildren(loader, row, "Pod");
      const fallback = pods.length ? pods : await selectedPods(loader, row);
      add(group("pods", "Managed Pods", "child", `Pods directly managed by this ${row.kind}.`, fallback));
      break;
    }
    case "CronJob": {
      const jobs = await ownerChildren(loader, row, "Job");
      const pods = (await loader.list("Pod", namespace)).filter((pod) => jobs.some((job) => ownedBy(pod, { apiVersion: job.backend?.apiVersion, kind: "Job", name: job.name, uid: job.backend?.uid ?? undefined })));
      add(group("jobs", "Jobs", "child", "Job runs created by this schedule.", jobs));
      add(group("pods", "Managed Pods", "child", "Pods belonging to Jobs created by this CronJob.", pods));
      break;
    }
    case "Pod": {
      const refs = refsFromPod(row);
      const [node, serviceAccount, priorityClass, runtimeClass, configMaps, secrets, claims, services] = await Promise.all([
        loader.one("Node", refs.node), loader.one("ServiceAccount", refs.serviceAccount, namespace), loader.one("PriorityClass", refs.priorityClass), loader.one("RuntimeClass", refs.runtimeClass),
        rowsForNames(loader, "ConfigMap", refs.configMaps, namespace), rowsForNames(loader, "Secret", refs.secrets, namespace), rowsForNames(loader, "PersistentVolumeClaim", refs.claims, namespace), loader.list("Service", namespace),
      ]);
      add(group("node", "Scheduled Node", "parent", "Node selected by the scheduler for this Pod.", node ? [node] : []));
      add(group("identity", "Service Account", "parent", "Kubernetes identity mounted into the Pod.", serviceAccount ? [serviceAccount] : []));
      if (refs.priorityClass) add(group("priority", "Priority Class", "parent", "Scheduling priority used by this Pod.", priorityClass ? [priorityClass] : []));
      if (refs.runtimeClass) add(group("runtime", "Runtime Class", "parent", "Container runtime handler selected by this Pod.", runtimeClass ? [runtimeClass] : []));
      if (refs.claims.length) add(group("claims", "Mounted Claims", "parent", "PersistentVolumeClaims referenced by Pod volumes.", claims));
      if (refs.configMaps.length) add(group("configmaps", "Referenced ConfigMaps", "parent", "ConfigMaps used by volumes, envFrom, env, or projected sources.", configMaps));
      if (refs.secrets.length) add(group("secrets", "Referenced Secrets", "parent", "Secrets used by volumes, env, projected sources, or imagePullSecrets.", secrets));
      add(group("services", "Selecting Services", "peer", "Services whose selectors match this Pod's labels.", services.filter((service) => matchesSelector(row, selectorFromRow(service)))));
      const ancestors = (await Promise.all(ownerRows.flatMap((owner) => ownerReferences(owner).map((ancestor) => loader.one(ancestor.kind, ancestor.name, owner.namespace === "—" ? undefined : owner.namespace))))).filter(Boolean) as ResourceRow[];
      if (ancestors.length) add(group("controller-ancestry", "Controller Ancestry", "parent", "Higher-level workload controllers above the direct owner, such as the Deployment owning a ReplicaSet.", ancestors));
      break;
    }
    case "Node": {
      const pods = (await loader.list("Pod", undefined, { fieldSelector: `spec.nodeName=${row.name}` })).filter((pod) => refsFromPod(pod).node === row.name);
      const lease = await loader.one("Lease", row.name, "kube-node-lease");
      add(group("pods", "Scheduled Pods", "child", "Pods currently assigned to this Node.", pods));
      add(group("lease", "Node Lease", "child", "Heartbeat Lease used by the node controller.", lease ? [lease] : []));
      break;
    }
    case "Namespace": {
      const [pods, deployments, statefulSets, daemonSets, jobs, cronJobs, services, configMaps, secrets, claims] = await Promise.all([
        loader.list("Pod", row.name), loader.list("Deployment", row.name), loader.list("StatefulSet", row.name), loader.list("DaemonSet", row.name), loader.list("Job", row.name), loader.list("CronJob", row.name), loader.list("Service", row.name), loader.list("ConfigMap", row.name), loader.list("Secret", row.name), loader.list("PersistentVolumeClaim", row.name),
      ]);
      add(group("pods", "Pods", "child", "Pods contained in this Namespace.", pods));
      add(group("workloads", "Workloads", "child", "Controllers and batch workloads contained in this Namespace.", [...deployments, ...statefulSets, ...daemonSets, ...jobs, ...cronJobs]));
      add(group("services", "Services", "child", "Services contained in this Namespace.", services));
      add(group("configuration", "Configuration", "child", "ConfigMaps and Secrets contained in this Namespace.", [...configMaps, ...secrets]));
      const namespaceEvents = await loader.list("Event", row.name);
      add(group("claims", "Persistent Volume Claims", "child", "Storage claims contained in this Namespace.", claims));
      add(group("namespace-events", "Namespace Events", "child", "Events emitted by resources in this Namespace.", namespaceEvents));
      break;
    }
    case "Event": {
      const reference = eventObjectRef(row);
      const target = await loader.one(reference.kind, reference.name, reference.namespace || namespace, reference.apiVersion || undefined);
      add(group("regarding", "Regarding Resource", "parent", "Resource referenced by this Event's involvedObject.", target ? [target] : []));
      break;
    }
    case "Service": {
      const selector = selectorFromRow(row);
      const pods = await loader.list("Pod", namespace, Object.keys(selector).length ? { labelSelector: selectorQuery(selector) } : {});
      const endpoints = await loader.one("Endpoints", row.name, namespace);
      const ingresses = (await loader.list("Ingress", namespace)).filter((ingress) => ingressServiceNames(ingress).includes(row.name));
      add(group("pods", "Selected Pods", "child", "Pods selected as Service backends.", pods.filter((pod) => matchesSelector(pod, selector))));
      add(group("endpoints", "Endpoints", "child", "Legacy Endpoints object with the same Service name.", endpoints ? [endpoints] : []));
      add(group("ingresses", "Referencing Ingresses", "peer", "Ingress routes that use this Service as a backend.", ingresses));
      break;
    }
    case "Endpoints": {
      const service = await loader.one("Service", row.name, namespace);
      const podRefs = array(detailValueAt(source(row), "subsets")).flatMap((subset) => [...array(detailValueAt(subset, "addresses")), ...array(detailValueAt(subset, "notReadyAddresses"))]).filter((address) => string(detailValueAt(address, "targetRef.kind")) === "Pod").map((address) => string(detailValueAt(address, "targetRef.name")));
      const addressSet = new Set(string(row.data.addresses).split(",").map((address) => address.trim()).filter(Boolean));
      const pods = podRefs.length ? await rowsForNames(loader, "Pod", podRefs, namespace) : (await loader.list("Pod", namespace)).filter((pod) => addressSet.has(string(pod.data.ip)));
      add(group("service", "Service", "parent", "Service sharing this Endpoints object's name.", service ? [service] : []));
      add(group("pods", "Target Pods", "peer", "Pods referenced by endpoint address targetRefs.", pods));
      break;
    }
    case "Ingress": {
      const className = string(detailValueAt(source(row), "spec.ingressClassName")) || string(row.data.class);
      const classRow = await loader.one("IngressClass", className);
      const services = await rowsForNames(loader, "Service", ingressServiceNames(row), namespace);
      const secretNames = array(detailValueAt(source(row), "spec.tls")).map((entry) => string(detailValueAt(entry, "secretName"))).filter(Boolean);
      const secrets = await rowsForNames(loader, "Secret", secretNames, namespace);
      add(group("class", "Ingress Class", "parent", "Ingress controller class selected by this resource.", classRow ? [classRow] : []));
      add(group("services", "Backend Services", "peer", "Services referenced by defaultBackend and HTTP paths.", services));
      if (secretNames.length) add(group("tls", "TLS Secrets", "peer", "Secrets containing certificates for Ingress TLS hosts.", secrets));
      break;
    }
    case "IngressClass": {
      const ingresses = (await loader.list("Ingress")).filter((ingress) => (string(detailValueAt(source(ingress), "spec.ingressClassName")) || string(ingress.data.class)) === row.name);
      add(group("ingresses", "Ingresses", "child", "Ingress resources selecting this class.", ingresses));
      break;
    }
    case "NetworkPolicy": {
      add(group("pods", "Selected Pods", "peer", "Pods to which this NetworkPolicy applies.", await selectedPods(loader, row, "spec.podSelector")));
      break;
    }
    case "PersistentVolumeClaim": {
      const volumeName = string(detailValueAt(source(row), "spec.volumeName") || row.data.volume);
      const storageClass = string(detailValueAt(source(row), "spec.storageClassName") || row.data.storageClass);
      const [volume, storage, pods, statefulSets] = await Promise.all([loader.one("PersistentVolume", volumeName), loader.one("StorageClass", storageClass), loader.list("Pod", namespace), loader.list("StatefulSet", namespace)]);
      const inferredOwners = ownerRows.length ? [] : statefulSets.filter((statefulSet) => row.name.startsWith(`${statefulSet.name}-`) || row.name.includes(`-${statefulSet.name}-`));
      add(group("volume", "Bound Volume", "parent", "PersistentVolume bound to this claim.", volume ? [volume] : []));
      add(group("storageclass", "Storage Class", "parent", "StorageClass used to provision or bind this claim.", storage ? [storage] : []));
      if (inferredOwners.length) add(group("statefulset", "StatefulSet", "parent", "StatefulSet inferred from the volumeClaimTemplate naming convention.", inferredOwners));
      add(group("pods", "Mounted Pods", "peer", "Pods that reference this claim in their volumes.", pods.filter((pod) => podReferences(pod, "PersistentVolumeClaim", row.name))));
      break;
    }
    case "PersistentVolume": {
      const claimParts = string(row.data.claim).split("/");
      const claimName = string(detailValueAt(source(row), "spec.claimRef.name")) || claimParts[1];
      const claimNamespace = string(detailValueAt(source(row), "spec.claimRef.namespace")) || claimParts[0];
      const storageClass = string(detailValueAt(source(row), "spec.storageClassName") || row.data.storageClass);
      const [claim, storage] = await Promise.all([loader.one("PersistentVolumeClaim", claimName, claimNamespace), loader.one("StorageClass", storageClass)]);
      const pods = claim ? (await loader.list("Pod", claim.namespace)).filter((pod) => podReferences(pod, "PersistentVolumeClaim", claim.name)) : [];
      add(group("claim", "Bound Claim", "child", "PersistentVolumeClaim bound through spec.claimRef.", claim ? [claim] : []));
      add(group("storageclass", "Storage Class", "parent", "StorageClass associated with this volume.", storage ? [storage] : []));
      add(group("pods", "Mounted Pods", "peer", "Pods mounting the bound claim.", pods));
      break;
    }
    case "StorageClass": {
      const [volumes, claims] = await Promise.all([loader.list("PersistentVolume"), loader.list("PersistentVolumeClaim")]);
      add(group("volumes", "Persistent Volumes", "child", "Volumes using this StorageClass.", volumes.filter((volume) => string(detailValueAt(source(volume), "spec.storageClassName") || volume.data.storageClass) === row.name)));
      add(group("claims", "Persistent Volume Claims", "child", "Claims requesting this StorageClass.", claims.filter((claim) => string(detailValueAt(source(claim), "spec.storageClassName") || claim.data.storageClass) === row.name)));
      break;
    }
    case "ConfigMap":
    case "Secret": {
      const pods = (await loader.list("Pod", namespace)).filter((pod) => podReferences(pod, row.kind, row.name));
      add(group("pods", "Referencing Pods", "peer", `Pods that consume this ${row.kind} through volumes or environment references.`, pods));
      if (row.kind === "Secret") {
        const ingresses = (await loader.list("Ingress", namespace)).filter((ingress) => array(detailValueAt(source(ingress), "spec.tls")).some((entry) => string(detailValueAt(entry, "secretName")) === row.name) || (!ingress.backend && row.name === `${ingress.name}-tls`));
        const serviceAccounts = (await loader.list("ServiceAccount", namespace)).filter((account) => [...array(detailValueAt(source(account), "secrets")), ...array(detailValueAt(source(account), "imagePullSecrets"))].some((entry) => string(detailValueAt(entry, "name")) === row.name));
        add(group("ingresses", "TLS Ingresses", "peer", "Ingress resources using this Secret for TLS.", ingresses));
        add(group("serviceaccounts", "Service Accounts", "peer", "ServiceAccounts referencing this Secret.", serviceAccounts));
      }
      break;
    }
    case "HorizontalPodAutoscaler": {
      const fallback = string(row.data.reference).split("/");
      const kind = string(detailValueAt(source(row), "spec.scaleTargetRef.kind")) || fallback[0];
      const name = string(detailValueAt(source(row), "spec.scaleTargetRef.name")) || fallback[1];
      const target = await loader.one(kind, name, namespace);
      add(group("target", "Scale Target", "parent", "Workload whose scale subresource is controlled by this HPA.", target ? [target] : []));
      break;
    }
    case "VerticalPodAutoscaler": {
      const fallback = string(row.data.reference).split("/");
      const kind = string(detailValueAt(source(row), "spec.targetRef.kind")) || fallback[0];
      const name = string(detailValueAt(source(row), "spec.targetRef.name")) || fallback[1];
      const target = await loader.one(kind, name, namespace);
      add(group("target", "Recommendation Target", "parent", "Workload receiving resource recommendations or updates from this VPA.", target ? [target] : []));
      break;
    }
    case "PodDisruptionBudget": {
      const selected = await selectedPods(loader, row);
      const pods = selected.length || row.backend ? selected : (await loader.list("Pod", namespace)).filter((pod) => (pod.links?.controlledBy?.name ?? "").startsWith(row.name));
      const controllers = await Promise.all(uniqueStringRefs(pods.flatMap((pod) => ownerReferences(pod).map((owner) => ({ name: owner.name, namespace: pod.namespace, kind: owner.kind })))).map((owner) => loader.one(owner.kind, owner.name, owner.namespace)));
      add(group("pods", "Protected Pods", "peer", "Pods selected by this disruption budget.", pods));
      add(group("controllers", "Workload Controllers", "peer", "Direct controllers of the selected Pods.", controllers.filter(Boolean) as ResourceRow[]));
      break;
    }
    case "PriorityClass": {
      const pods = (await loader.list("Pod")).filter((pod) => refsFromPod(pod).priorityClass === row.name);
      add(group("pods", "Pods", "child", "Pods scheduled with this PriorityClass.", pods));
      break;
    }
    case "RuntimeClass": {
      const pods = (await loader.list("Pod")).filter((pod) => refsFromPod(pod).runtimeClass === row.name);
      add(group("pods", "Pods", "child", "Pods using this RuntimeClass handler.", pods));
      break;
    }
    case "Lease": {
      const holder = string(detailValueAt(source(row), "spec.holderIdentity") || row.data.holder);
      const nodeName = row.namespace === "kube-node-lease" ? row.name : holder;
      const node = await loader.one("Node", nodeName);
      add(group("node", "Node / Holder", "parent", "Node represented by a heartbeat Lease or named by holderIdentity when it resolves to a Node.", node ? [node] : []));
      break;
    }
    case "MutatingWebhookConfiguration":
    case "ValidatingWebhookConfiguration": {
      const refs = webhookServiceRefs(row);
      const services = (await Promise.all(refs.map((ref) => loader.one("Service", ref.name, ref.namespace)))).filter(Boolean) as ResourceRow[];
      add(group("services", "Webhook Services", "peer", "Services used by webhook clientConfig entries.", services));
      break;
    }
    case "ServiceAccount": {
      const [pods, roleBindings, clusterBindings, secrets] = await Promise.all([loader.list("Pod", namespace), loader.list("RoleBinding", namespace), loader.list("ClusterRoleBinding"), loader.list("Secret", namespace)]);
      const subjectMatches = (binding: ResourceRow) => bindingServiceAccounts(binding).some((subject) => subject.name === row.name && subject.namespace === namespace);
      const secretNames = new Set([...array(detailValueAt(source(row), "secrets")), ...array(detailValueAt(source(row), "imagePullSecrets"))].map((entry) => string(detailValueAt(entry, "name"))));
      add(group("pods", "Pods", "child", "Pods running as this ServiceAccount.", pods.filter((pod) => { const account = refsFromPod(pod).serviceAccount; return account === row.name || (!pod.backend && account.startsWith(`${row.name}-`)); })));
      add(group("bindings", "RBAC Bindings", "peer", "RoleBindings and ClusterRoleBindings granting permissions to this ServiceAccount.", [...roleBindings.filter(subjectMatches), ...clusterBindings.filter(subjectMatches)]));
      add(group("secrets", "Referenced Secrets", "peer", "Token or image pull Secrets referenced by this ServiceAccount.", secrets.filter((secret) => secretNames.has(secret.name))));
      break;
    }
    case "Role":
    case "ClusterRole": {
      const [roleBindings, clusterBindings] = await Promise.all([loader.list("RoleBinding", row.kind === "Role" ? namespace : undefined), loader.list("ClusterRoleBinding")]);
      const matches = (binding: ResourceRow) => { const reference = bindingRoleRef(binding); return reference.kind === row.kind && reference.name === row.name; };
      add(group("bindings", "RBAC Bindings", "child", `Bindings that grant this ${row.kind}.`, [...roleBindings.filter(matches), ...clusterBindings.filter(matches)]));
      break;
    }
    case "RoleBinding":
    case "ClusterRoleBinding": {
      const roleReference = bindingRoleRef(row);
      const role = await loader.one(roleReference.kind, roleReference.name, roleReference.kind === "Role" ? namespace : undefined);
      const subjects = bindingServiceAccounts(row);
      const accounts = (await Promise.all(subjects.map((subject) => loader.one("ServiceAccount", subject.name, subject.namespace || namespace)))).filter(Boolean) as ResourceRow[];
      add(group("role", "Granted Role", "parent", "Role or ClusterRole referenced by roleRef.", role ? [role] : []));
      add(group("subjects", "Service Account Subjects", "peer", "Kubernetes ServiceAccounts receiving this grant. User and Group subjects remain visible in the binding summary.", accounts));
      break;
    }
    case "PodSecurityPolicy": {
      const [roles, clusterRoles] = await Promise.all([loader.list("Role"), loader.list("ClusterRole")]);
      const allows = (role: ResourceRow) => array(detailValueAt(source(role), "rules")).some((rule) => array(detailValueAt(rule, "resources")).map(string).includes("podsecuritypolicies") && array(detailValueAt(rule, "resourceNames")).map(string).includes(row.name) && array(detailValueAt(rule, "verbs")).map(string).includes("use"));
      add(group("roles", "Roles Allowing Use", "peer", "RBAC roles with use permission for this PodSecurityPolicy.", [...roles.filter(allows), ...clusterRoles.filter(allows)]));
      break;
    }
    case "CustomResourceDefinition": {
      const groupName = string(detailValueAt(source(row), "spec.group"));
      const kind = string(detailValueAt(source(row), "spec.names.kind")) || string(row.data.kind);
      const plural = string(detailValueAt(source(row), "spec.names.plural"));
      const scope = string(detailValueAt(source(row), "spec.scope"));
      const versions = array(detailValueAt(source(row), "spec.versions"));
      const version = string(detailValueAt(versions.find((entry) => detailValueAt(entry, "storage") === true) ?? versions.find((entry) => detailValueAt(entry, "served") === true) ?? versions[0], "name"));
      let instances: ResourceRow[] = [];
      if (nativeBackendAvailable && groupName && version && plural) {
        const descriptor: ApiResourceDescriptor = { apiVersion: `${groupName}/${version}`, group: groupName, version, kind, plural, namespaced: scope === "Namespaced", verbs: ["list", "get"], categories: [] };
        instances = await loader.listDescriptor(descriptor);
      } else {
        const definition = customResourceDefinitions.find((item) => item.name === row.name || item.kind === kind);
        if (definition) instances = (customResources[definition.kind] ?? []).map((item) => ({ key: `${item.namespace}/${item.name}`, name: item.name, namespace: item.namespace, kind: definition.kind, status: item.status, data: { name: item.name, namespace: item.namespace, status: item.status, apiVersion: `${definition.group}/${item.version}`, age: item.age } }));
      }
      add(group("instances", `${kind || "Custom Resource"} Instances`, "child", "Custom resources served by this CRD's storage version.", instances));
      break;
    }
    case "HelmRelease": {
      const releaseName = row.name;
      const candidates = ["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob", "Service", "Ingress", "ConfigMap", "Secret", "ServiceAccount", "Role", "RoleBinding", "PersistentVolumeClaim"];
      const lists = await Promise.all(candidates.map((kind) => loader.list(kind, namespace)));
      const managed = lists.flat().filter((candidate) => {
        const annotations = object(detailValueAt(source(candidate), "metadata.annotations"));
        return string(annotations["meta.helm.sh/release-name"]) === releaseName && string(annotations["meta.helm.sh/release-namespace"]) === namespace;
      });
      add(group("managed", "Managed Resources", "child", "Resources annotated as managed by this Helm release.", managed));
      break;
    }
    case "PortForward": {
      const [targetKind = "Pod", targetName = row.name] = row.name.includes("/") ? row.name.split("/", 2) : ["Pod", row.name];
      const target = await loader.one(targetKind, targetName, namespace);
      add(group("target", `Target ${targetKind}`, "parent", "Kubernetes resource receiving traffic from this local port-forward session.", target ? [target] : []));
      break;
    }
    default: {
      if (!RESOURCE_RELATIONSHIP_MATRIX[row.kind]) {
        const children = await dynamicOwnedResources(loader, row, discovered);
        add(group("owned", "Owned Resources", "child", "Resources discovered with ownerReferences pointing to this custom resource.", children));
      }
      break;
    }
  }

  if (["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "ReplicationController"].includes(row.kind)) {
    const workloadSelector = selectorFromRow(row);
    const [hpas, vpas, budgets, services, workloadPods] = await Promise.all([loader.list("HorizontalPodAutoscaler", namespace), loader.list("VerticalPodAutoscaler", namespace), loader.list("PodDisruptionBudget", namespace), loader.list("Service", namespace), selectedPods(loader, row)]);
    const hpaTargets = hpas.filter((item) => { const fallback = string(item.data.reference).split("/"); return (string(detailValueAt(source(item), "spec.scaleTargetRef.kind")) || fallback[0]) === row.kind && (string(detailValueAt(source(item), "spec.scaleTargetRef.name")) || fallback[1]) === row.name; });
    const vpaTargets = vpas.filter((item) => { const fallback = string(item.data.reference).split("/"); return (string(detailValueAt(source(item), "spec.targetRef.kind")) || fallback[0]) === row.kind && (string(detailValueAt(source(item), "spec.targetRef.name")) || fallback[1]) === row.name; });
    const podKeys = new Set(workloadPods.map((pod) => `${pod.namespace}/${pod.name}`));
    const budgetSelections = await Promise.all(budgets.map((budget) => selectedPods(loader, budget).then((pods) => pods.some((pod) => podKeys.has(`${pod.namespace}/${pod.name}`)))));
    const matchingBudgets = budgets.filter((item, index) => budgetSelections[index] || selectorCoveredBy(selectorFromRow(item, "spec.selector"), workloadSelector) || (!item.backend && item.name === row.name));
    const matchingServices = services.filter((item) => workloadPods.some((pod) => matchesSelector(pod, selectorFromRow(item))) || selectorCoveredBy(selectorFromRow(item), workloadSelector));
    if (["Deployment", "StatefulSet", "ReplicaSet", "ReplicationController"].includes(row.kind)) add(group("autoscalers", "Autoscalers", "peer", "Horizontal and vertical autoscalers targeting this workload.", [...hpaTargets, ...vpaTargets]));
    add(group("budgets", "Disruption Budgets", "peer", "PodDisruptionBudgets whose selectors overlap this workload.", matchingBudgets));
    add(group("services", "Selecting Services", "peer", "Services routing traffic to Pods selected by this workload.", matchingServices));
  }

  const events = await eventsFor(loader, row);
  if (row.kind !== "Event") add(group("events", "Related Events", "peer", "Kubernetes Events whose involvedObject points to this resource.", events));
  if (loader.errors.length) {
    const first = groups.find((entry) => entry.items.length === 0) ?? groups.at(-1);
    if (first) first.error = loader.errors.slice(0, 3).join(" · ");
  }
  return groups;
}

export async function resolveResourceLink(clusterId: string, link: { apiVersion?: string; kind: string; name: string; namespace?: string }, discovered: ApiResourceDescriptor[]): Promise<ResourceRow | null> {
  return new RelationLoader(clusterId, discovered).one(link.kind, link.name, link.namespace, link.apiVersion);
}
