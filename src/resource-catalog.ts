import type { ApiResourceDescriptor, BackendResourceRecord } from "./backend";

export type ColumnDef = {
  id: string;
  label: string;
  defaultVisible: boolean;
  /** Name (and similar identity columns) cannot be hidden. */
  required?: boolean;
};

export type ContainerInfo = {
  name: string;
  status: "running" | "waiting" | "succeeded" | "terminated" | "unknown";
  image: string;
  ready: boolean;
  restarts: number;
  port?: string;
};

export type ResourceLink = {
  apiVersion?: string;
  kind: string;
  name: string;
  namespace?: string;
  relation: "namespace" | "node" | "controller" | string;
};

export type ResourceRow = {
  key: string;
  name: string;
  namespace: string;
  kind: string;
  status?: string;
  data: Record<string, string | number>;
  containers?: ContainerInfo[];
  links?: Partial<Record<string, ResourceLink>>;
  /**
   * Column cells that map to several related resources at once, in display
   * order (e.g. Endpoint addresses each linking to their target Pod).
   * A `null` entry means that position has no navigable resource.
   */
  linkLists?: Partial<Record<string, Array<ResourceLink | null>>>;
  /** Present when the row is backed by a live Kubernetes API object. */
  backend?: BackendResourceRecord;
  descriptor?: ApiResourceDescriptor;
};

const col = (id: string, label: string, defaultVisible = true, required = false): ColumnDef => ({
  id, label, defaultVisible, required,
});

/** Conventional kubectl-style default columns for each navigation resource. */
export const resourceColumnDefs: Record<string, ColumnDef[]> = {
  Pods: [
    col("name", "Name", true, true),
    col("namespace", "Namespace"),
    col("containers", "Containers"),
    col("status", "Status"),
    col("restarts", "Restarts"),
    col("node", "Node"),
    col("controlledBy", "Controlled By"),
    col("ip", "IP", false),
    col("cpu", "CPU", false),
    col("memory", "Memory", false),
    col("age", "Age"),
  ],
  Nodes: [
    col("name", "Name", true, true), col("status", "Status"), col("roles", "Roles"),
    col("version", "Version"), col("pods", "Pods"), col("cpu", "CPU"), col("memory", "Memory"), col("age", "Age"),
  ],
  Namespaces: [
    col("name", "Name", true, true), col("status", "Status"), col("labels", "Labels", false), col("age", "Age"),
  ],
  Events: [
    col("name", "Reason", true, true), col("namespace", "Namespace"), col("type", "Type"),
    col("object", "Object"), col("message", "Message"), col("count", "Count"), col("lastSeen", "Last Seen"),
  ],
  Deployments: [
    col("name", "Name", true, true),
    col("namespace", "Namespace"),
    col("ready", "Ready"),
    col("upToDate", "Up-to-date"),
    col("available", "Available"),
    col("status", "Status"),
    col("containers", "Containers", false),
    col("images", "Images", false),
    col("age", "Age"),
  ],
  StatefulSets: [
    col("name", "Name", true, true),
    col("namespace", "Namespace"),
    col("ready", "Ready"),
    col("status", "Status"),
    col("containers", "Containers", false),
    col("images", "Images", false),
    col("age", "Age"),
  ],
  DaemonSets: [
    col("name", "Name", true, true),
    col("namespace", "Namespace"),
    col("desired", "Desired"),
    col("current", "Current"),
    col("ready", "Ready"),
    col("upToDate", "Up-to-date"),
    col("available", "Available"),
    col("nodeSelector", "Node Selector", false),
    col("status", "Status"),
    col("age", "Age"),
  ],
  ReplicaSets: [
    col("name", "Name", true, true), col("namespace", "Namespace"), col("desired", "Desired"),
    col("current", "Current"), col("ready", "Ready"), col("controlledBy", "Controlled By"), col("age", "Age"),
  ],
  "Replication Controllers": [
    col("name", "Name", true, true), col("namespace", "Namespace"), col("desired", "Desired"),
    col("current", "Current"), col("ready", "Ready"), col("selector", "Selector", false), col("age", "Age"),
  ],
  Jobs: [
    col("name", "Name", true, true), col("namespace", "Namespace"), col("completions", "Completions"),
    col("duration", "Duration"), col("status", "Status"), col("controlledBy", "Controlled By", false), col("age", "Age"),
  ],
  CronJobs: [
    col("name", "Name", true, true), col("namespace", "Namespace"), col("schedule", "Schedule"),
    col("suspend", "Suspend"), col("active", "Active"), col("lastSchedule", "Last Schedule"), col("status", "Status"), col("age", "Age"),
  ],
  Services: [
    col("name", "Name", true, true),
    col("namespace", "Namespace"),
    col("type", "Type"),
    col("clusterIp", "Cluster IP"),
    col("externalIp", "External IP"),
    col("ports", "Ports"),
    col("selector", "Selector", false),
    col("age", "Age"),
  ],
  Endpoints: [
    col("name", "Name", true, true), col("namespace", "Namespace"), col("addresses", "Addresses"), col("ports", "Ports"), col("age", "Age"),
  ],
  Ingresses: [
    col("name", "Name", true, true),
    col("namespace", "Namespace"),
    col("class", "Class"),
    col("hosts", "Hosts"),
    col("address", "Address"),
    col("ports", "Ports"),
    col("age", "Age"),
  ],
  "Ingress Classes": [
    col("name", "Name", true, true), col("controller", "Controller"), col("parameters", "Parameters", false), col("age", "Age"),
  ],
  "Network Policies": [
    col("name", "Name", true, true),
    col("namespace", "Namespace"),
    col("podSelector", "Pod Selector"),
    col("policyTypes", "Policy Types", false),
    col("age", "Age"),
  ],
  "Port Forwarding": [
    col("name", "Name", true, true), col("namespace", "Namespace"), col("target", "Target"), col("localAddress", "Local Address"),
    col("servicePort", "Service Port"), col("targetPort", "Target Pod Port"), col("resolvedPod", "Endpoint Pod"), col("protocol", "Open As"), col("status", "Status"),
  ],
  "Persistent Volume Claims": [
    col("name", "Name", true, true), col("namespace", "Namespace"), col("status", "Status"),
    col("volume", "Volume"), col("capacity", "Capacity"), col("accessModes", "Access Modes"), col("storageClass", "Storage Class"), col("age", "Age"),
  ],
  "Persistent Volumes": [
    col("name", "Name", true, true),
    col("capacity", "Capacity"),
    col("accessModes", "Access Modes"),
    col("reclaimPolicy", "Reclaim Policy"),
    col("status", "Status"),
    col("claim", "Claim"),
    col("storageClass", "Storage Class"),
    col("age", "Age"),
  ],
  "Storage Classes": [
    col("name", "Name", true, true),
    col("provisioner", "Provisioner"),
    col("reclaimPolicy", "Reclaim Policy"),
    col("bindingMode", "Volume Binding Mode"),
    col("allowExpansion", "Allow Expansion", false),
    col("age", "Age"),
  ],
  "Config Maps": [
    col("name", "Name", true, true),
    col("namespace", "Namespace"),
    col("data", "Data"),
    col("age", "Age"),
  ],
  Secrets: [
    col("name", "Name", true, true),
    col("namespace", "Namespace"),
    col("type", "Type"),
    col("data", "Data"),
    col("age", "Age"),
  ],
  "Resource Quotas": [
    col("name", "Name", true, true),
    col("namespace", "Namespace"),
    col("requests", "Requests"),
    col("limits", "Limits"),
    col("age", "Age"),
  ],
  "Limit Ranges": [
    col("name", "Name", true, true), col("namespace", "Namespace"), col("type", "Type"), col("min", "Min"), col("max", "Max"), col("default", "Default"), col("age", "Age"),
  ],
  "Horizontal Pod Autoscalers": [
    col("name", "Name", true, true), col("namespace", "Namespace"), col("reference", "Reference"),
    col("targets", "Targets"), col("minPods", "Min Pods"), col("maxPods", "Max Pods"), col("replicas", "Replicas"), col("age", "Age"),
  ],
  "Vertical Pod Autoscalers": [
    col("name", "Name", true, true), col("namespace", "Namespace"), col("reference", "Reference"), col("mode", "Update Mode"), col("status", "Status"), col("age", "Age"),
  ],
  "Pod Disruption Budgets": [
    col("name", "Name", true, true), col("namespace", "Namespace"), col("minAvailable", "Min Available"),
    col("maxUnavailable", "Max Unavailable"), col("allowedDisruptions", "Allowed Disruptions"), col("age", "Age"),
  ],
  "Priority Classes": [
    col("name", "Name", true, true), col("value", "Value"), col("globalDefault", "Global Default"), col("preemptionPolicy", "Preemption Policy"), col("age", "Age"),
  ],
  "Runtime Classes": [
    col("name", "Name", true, true), col("handler", "Handler"), col("overhead", "Overhead", false), col("scheduling", "Scheduling", false), col("age", "Age"),
  ],
  Leases: [
    col("name", "Name", true, true), col("namespace", "Namespace"), col("holder", "Holder"), col("renewTime", "Renew Time"), col("age", "Age"),
  ],
  "Mutating Webhook Configs": [
    col("name", "Name", true, true), col("webhooks", "Webhooks"), col("failurePolicy", "Failure Policy"), col("age", "Age"),
  ],
  "Validating Webhook Configs": [
    col("name", "Name", true, true), col("webhooks", "Webhooks"), col("failurePolicy", "Failure Policy"), col("age", "Age"),
  ],
  "Service Accounts": [
    col("name", "Name", true, true),
    col("namespace", "Namespace"),
    col("secrets", "Secrets"),
    col("age", "Age"),
  ],
  "Cluster Roles": [
    col("name", "Name", true, true), col("rules", "Rules"), col("aggregation", "Aggregation", false), col("age", "Age"),
  ],
  Roles: [
    col("name", "Name", true, true),
    col("namespace", "Namespace"),
    col("rules", "Rules", false),
    col("age", "Age"),
  ],
  "Cluster Role Bindings": [
    col("name", "Name", true, true), col("role", "Role"), col("subjects", "Subjects"), col("age", "Age"),
  ],
  "Role Bindings": [
    col("name", "Name", true, true),
    col("namespace", "Namespace"),
    col("role", "Role"),
    col("subjects", "Subjects", false),
    col("age", "Age"),
  ],
  "Pod Security Policies": [
    col("name", "Name", true, true), col("privileged", "Privileged"), col("volumes", "Volumes"), col("runAsUser", "Run As User"), col("age", "Age"),
  ],
  "Helm Charts": [
    col("name", "Name", true, true), col("repository", "Repository"), col("version", "Version"), col("appVersion", "App Version"), col("description", "Description", false),
  ],
  "Helm Releases": [
    col("name", "Name", true, true),
    col("namespace", "Namespace"),
    col("chart", "Chart"),
    col("status", "Status"),
    col("revision", "Revision"),
    col("appVersion", "App Version"),
    col("updated", "Updated"),
  ],
  "Custom Resource Definitions": [
    col("name", "Name", true, true),
    col("group", "Group"),
    col("kind", "Kind"),
    col("scope", "Scope"),
    col("versions", "Versions", false),
    col("instances", "Instances"),
    col("age", "Age"),
  ],
  "Custom Resource": [
    col("name", "Name", true, true),
    col("namespace", "Namespace"),
    col("status", "Status"),
    col("apiVersion", "API Version"),
    col("age", "Age"),
  ],
};

const storageKey = (resource: string) => `kubehive.columns.${resource}`;

export function getColumnDefs(resource: string): ColumnDef[] {
  return resourceColumnDefs[resource] ?? resourceColumnDefs.Pods;
}

export function defaultVisibleIds(defs: ColumnDef[]): string[] {
  return defs.filter((item) => item.required || item.defaultVisible).map((item) => item.id);
}

export function loadVisibleColumns(resource: string): string[] {
  const defs = getColumnDefs(resource);
  try {
    const raw = localStorage.getItem(storageKey(resource));
    if (!raw) return defaultVisibleIds(defs);
    let saved = JSON.parse(raw) as string[];
    if (!Array.isArray(saved)) return defaultVisibleIds(defs);
    // Migrate Pods Ready → Containers and ensure Controlled By stays available.
    if (resource === "Pods") {
      saved = saved.map((id) => id === "ready" ? "containers" : id);
      if (!saved.includes("controlledBy") && !saved.includes("containers")) saved = defaultVisibleIds(defs);
    }
    // Port Forwarding gained a Target column; keep it visible for existing configs.
    if (resource === "Port Forwarding" && !saved.includes("target")) saved = [...saved, "target"];
    const allowed = new Set(defs.map((item) => item.id));
    const next = defs.filter((item) => item.required || (saved.includes(item.id) && allowed.has(item.id))).map((item) => item.id);
    return next.length ? next : defaultVisibleIds(defs);
  } catch {
    return defaultVisibleIds(defs);
  }
}

export function saveVisibleColumns(resource: string, ids: string[]) {
  localStorage.setItem(storageKey(resource), JSON.stringify(ids));
}
