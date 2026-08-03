import type { ApiResourceDescriptor, BackendResourceRecord } from "./backend";
import { workloads, type Workload } from "./data";

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
  workload?: Workload;
  containers?: ContainerInfo[];
  links?: Partial<Record<string, ResourceLink>>;
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
    col("name", "Resource", true, true), col("namespace", "Namespace"), col("localAddress", "Local Address"),
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

function workloadRow(item: Workload, extra: Record<string, string | number> = {}, options: { key?: string; name?: string; kind?: string; status?: string; containers?: ContainerInfo[]; links?: ResourceRow["links"]; backend?: BackendResourceRecord } = {}): ResourceRow {
  const name = options.name ?? item.name;
  const kind = options.kind ?? item.kind;
  const status = options.status ?? item.status;
  const links: ResourceRow["links"] = {
    namespace: { kind: "Namespace", name: item.namespace, relation: "namespace" },
    ...options.links,
  };
  return {
    key: options.key ?? `${item.namespace}/${name}`,
    name,
    namespace: item.namespace,
    kind,
    status,
    workload: item,
    containers: options.containers,
    backend: options.backend,
    links,
    data: {
      name,
      namespace: item.namespace,
      ready: item.ready,
      status,
      restarts: item.restarts,
      cpu: item.cpu,
      memory: item.memory,
      age: item.age,
      images: item.image,
      selector: `app=${item.name}`,
      ...extra,
    },
  };
}

function buildPodContainers(item: Workload, replica: number): ContainerInfo[] {
  const app = item.image.split("/").pop()?.split(":")[0] ?? "app";
  if (item.status === "Degraded") {
    return [
      { name: app, status: "running", image: item.image, ready: true, restarts: Math.max(0, item.restarts - 2), port: "8080/TCP" },
      { name: "sidecar", status: replica % 2 === 0 ? "waiting" : "terminated", image: "ghcr.io/acme/sidecar:v1.2.0", ready: false, restarts: 2, port: "9090/TCP" },
    ];
  }
  if (item.status === "Pending") {
    return [
      { name: app, status: "waiting", image: item.image, ready: false, restarts: 0, port: "8080/TCP" },
    ];
  }
  const containers: ContainerInfo[] = [
    { name: app, status: "running", image: item.image, ready: true, restarts: item.restarts > 0 && replica === 0 ? 1 : 0, port: "8080/TCP" },
  ];
  if (item.kind === "StatefulSet" || item.kind === "DaemonSet") {
    containers.push({ name: "config-reloader", status: "running", image: "ghcr.io/acme/reloader:v0.4.1", ready: true, restarts: 0 });
  }
  if (item.kind === "Deployment" && replica === 0) {
    containers.push({ name: "istio-proxy", status: "running", image: "docker.io/istio/proxyv2:1.22.3", ready: true, restarts: 0, port: "15001/TCP" });
  }
  return containers;
}

function buildPodRows(): ResourceRow[] {
  const hashes = ["7b68b9c74c", "779d6bfcd", "5894f7d667", "6f9c8d4b5a", "4c2e1a9f8d", "9d3b7e2c1a"];
  const rows: ResourceRow[] = [];
  workloads.forEach((item, workloadIndex) => {
    const desired = Number(item.ready.split("/")[1] ?? 1);
    const count = Math.min(Math.max(desired, item.kind === "DaemonSet" ? 3 : 2), item.kind === "CronJob" ? 1 : 4);
    for (let replica = 0; replica < count; replica += 1) {
      const deploymentIndex = workloads.filter((candidate) => candidate.kind === "Deployment").findIndex((candidate) => candidate.name === item.name && candidate.namespace === item.namespace);
      const hash = item.kind === "Deployment" ? hashes[Math.max(0, deploymentIndex)] : hashes[(workloadIndex + replica) % hashes.length];
      const podName = item.kind === "StatefulSet"
        ? `${item.name}-${replica}`
        : item.kind === "CronJob"
          ? `${item.name}-289401`
          : `${item.name}-${hash}-${String.fromCharCode(97 + replica)}${replica + 2}rnl`.slice(0, 48);
      const node = `node-${String(((workloadIndex * 3 + replica) % 12) + 1).padStart(2, "0")}`;
      const controllerKind = item.kind === "CronJob" ? "Job" : item.kind === "Deployment" ? "ReplicaSet" : item.kind;
      const controllerName = item.kind === "CronJob" ? `${item.name}-289401` : item.kind === "Deployment" ? `${item.name}-${hash}` : item.name;
      const controlledBy = `${controllerKind}/${controllerName}`;
      const containers = buildPodContainers(item, replica);
      const readyCount = containers.filter((container) => container.ready).length;
      const status = item.status === "Degraded" && replica === 0
        ? "CrashLoopBackOff"
        : item.status === "Pending"
          ? "Pending"
          : readyCount === containers.length ? "Running" : "NotReady";
      const podObject: Record<string, unknown> = {
        apiVersion: "v1", kind: "Pod",
        metadata: {
          name: podName, namespace: item.namespace,
          labels: { app: item.name, "pod-template-hash": hash, "app.kubernetes.io/managed-by": "kubehive-demo" },
          annotations: { "prometheus.io/scrape": "true", "prometheus.io/port": "8080", "checksum/config": hash },
          ownerReferences: [{ apiVersion: controllerKind === "ReplicaSet" ? "apps/v1" : "batch/v1", kind: controllerKind, name: controllerName, controller: true }],
        },
        spec: {
          nodeName: node, serviceAccountName: item.name,
          volumes: [{ name: "app-config", configMap: { name: `${item.name}-config` } }, ...(item.kind === "StatefulSet" && item.name === "catalog-indexer" ? [{ name: "data", persistentVolumeClaim: { claimName: "catalog-db-1" } }] : [])],
          containers: containers.map((container) => ({
            name: container.name,
            image: container.image,
            imagePullPolicy: "IfNotPresent",
            ports: container.port ? [{ name: "http", containerPort: Number(container.port.split("/")[0]), protocol: "TCP" }] : [],
            resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "1", memory: "512Mi" } },
            env: [
              { name: "APP_ENV", value: "production" },
              { name: "LOG_LEVEL", value: "info" },
              { name: "CONFIG", valueFrom: { configMapKeyRef: { name: `${item.name}-config`, key: "app.yaml" } } },
              { name: "API_TOKEN", valueFrom: { secretKeyRef: { name: `${item.name}-tls`, key: "token" } } },
            ],
            volumeMounts: [
              { name: "app-config", mountPath: "/etc/app", readOnly: true },
              ...(item.kind === "StatefulSet" && item.name === "catalog-indexer" ? [{ name: "data", mountPath: "/var/lib/catalog" }] : []),
            ],
          })),
        },
        status: { phase: status === "Running" ? "Running" : status === "Pending" ? "Pending" : "Failed", podIP: `10.${40 + workloadIndex}.${12 + replica}.${20 + workloadIndex}`, containerStatuses: containers.map((container) => ({ name: container.name, ready: container.ready, restartCount: container.restarts, imageID: `docker-pullable://${container.image}@sha256:${hash.padEnd(64, "0")}`, state: container.status === "running" ? { running: { startedAt: "2026-01-01T00:00:00Z" } } : { waiting: { reason: status } } })), conditions: [{ type: "Ready", status: readyCount === containers.length ? "True" : "False", reason: readyCount === containers.length ? "ContainersReady" : "ContainersNotReady", message: readyCount === containers.length ? "All containers are ready" : "One or more containers are not ready" }] },
      };
      rows.push(workloadRow(item, {
        node,
        ip: `10.${40 + workloadIndex}.${12 + replica}.${20 + workloadIndex}`,
        controlledBy,
        containers: `${readyCount}/${containers.length}`,
        restarts: containers.reduce((sum, container) => sum + container.restarts, 0),
        status,
        cpu: item.cpu,
        memory: item.memory,
        serviceAccount: item.name,
        configMaps: `${item.name}-config`,
        secrets: `${item.name}-tls`,
        claims: item.kind === "StatefulSet" && item.name === "catalog-indexer" ? "catalog-db-1" : "",
        command: item.kind === "CronJob" ? "node /app/reconcile.js" : "/app/server",
        environment: "APP_ENV=production, LOG_LEVEL=info, API_TOKEN=demo-token",
        volumeMounts: "app-config:/etc/app",
      }, {
        key: `${item.namespace}/${podName}`,
        name: podName,
        kind: "Pod",
        status,
        containers,
        backend: { key: `${item.namespace}/${podName}`, name: podName, namespace: item.namespace, apiVersion: "v1", kind: "Pod", object: podObject },
        links: {
          namespace: { kind: "Namespace", name: item.namespace, relation: "namespace" },
          node: { kind: "Node", name: node, relation: "node" },
          controlledBy: { kind: controllerKind, name: controllerName, namespace: item.namespace, relation: "controller" },
        },
      }));
    }
  });
  return rows;
}

function demoResourceObject(kind: string, name: string, namespace: string): Record<string, unknown> | undefined {
  if (kind === "ConfigMap") return { apiVersion: "v1", kind, metadata: { name, namespace }, data: name === "checkout-api-config" ? { "app.yaml": "server:\n  port: 8080\n  logLevel: info", "feature-flags.json": "{\"expressCheckout\":true}", REGION: "eu-west-1" } : { "config.yaml": "enabled: true\nmode: production" } };
  if (kind === "Secret") return { apiVersion: "v1", kind, metadata: { name, namespace }, type: "Opaque", data: name.includes("tls") ? { "tls.crt": btoa("-----BEGIN CERTIFICATE-----\nDEMO\n-----END CERTIFICATE-----"), "tls.key": btoa("demo-private-key") } : { username: btoa("service-account"), password: btoa("demo-password") } };
  return undefined;
}

function staticRows(resource: string, rows: Array<Record<string, string | number> & { name: string; namespace?: string; kind?: string; status?: string }>): ResourceRow[] {
  return rows.map((row) => {
    const namespace = String(row.namespace ?? "—");
    const kind = String(row.kind ?? resource);
    const links: ResourceRow["links"] = {};
    if (namespace && namespace !== "—") links.namespace = { kind: "Namespace", name: namespace, relation: "namespace" };
    if (typeof row.claim === "string" && row.claim.includes("/")) {
      const [claimNs, claimName] = String(row.claim).split("/");
      links.claim = { kind: "PersistentVolumeClaim", name: claimName, namespace: claimNs, relation: "claim" };
    }
    if (typeof row.controlledBy === "string" && row.controlledBy.includes("/")) {
      const [controllerKind, controllerName] = String(row.controlledBy).split("/");
      links.controlledBy = { kind: controllerKind, name: controllerName, namespace, relation: "controller" };
    }
    if (typeof row.role === "string" && row.role.includes("/")) {
      const [roleKind, roleName] = String(row.role).split("/");
      links.role = { kind: roleKind, name: roleName, namespace, relation: "role" };
    }
    return {
      key: `${namespace}/${row.name}`,
      name: row.name,
      namespace,
      kind,
      status: row.status ? String(row.status) : undefined,
      data: row,
      links,
      backend: demoResourceObject(kind, row.name, namespace) ? {
        key: `${namespace}/${row.name}`,
        name: row.name,
        namespace,
        apiVersion: "v1",
        kind,
        object: demoResourceObject(kind, row.name, namespace)!,
      } : undefined,
      descriptor: undefined,
    };
  });
}

/** Mock rows shaped like typical kubectl output for each resource kind. */
export function getResourceRows(resource: string): ResourceRow[] {
  switch (resource) {
    case "Nodes":
      return staticRows("Node", [
        { name: "node-01", status: "Ready", roles: "worker", version: "v1.31.4", pods: 34, cpu: "64%", memory: "71%", age: "184d" },
        { name: "node-02", status: "Ready", roles: "worker", version: "v1.31.4", pods: 29, cpu: "48%", memory: "62%", age: "184d" },
        { name: "node-03", status: "Ready", roles: "worker", version: "v1.31.4", pods: 31, cpu: "76%", memory: "68%", age: "120d" },
        { name: "control-01", status: "Ready", roles: "control-plane", version: "v1.31.4", pods: 18, cpu: "38%", memory: "52%", age: "301d" },
      ]);
    case "Namespaces":
      return staticRows("Namespace", [
        { name: "commerce", status: "Active", labels: "team=commerce", age: "184d" },
        { name: "search", status: "Active", labels: "team=search", age: "184d" },
        { name: "storefront", status: "Active", labels: "team=storefront", age: "120d" },
        { name: "monitoring", status: "Active", labels: "platform=observability", age: "301d" },
        { name: "kube-system", status: "Active", labels: "kubernetes.io/metadata.name=kube-system", age: "412d" },
      ]);
    case "Events":
      return staticRows("Event", [
        { name: "Unhealthy", namespace: "commerce", type: "Warning", object: "Pod/payment-worker-779d6bfcd-a2rnl", message: "Readiness probe failed with status 503", count: 14, lastSeen: "34s" },
        { name: "FailedScheduling", namespace: "storefront", type: "Warning", object: "Pod/recommendation-api-5894f7d667-c4rnl", message: "Insufficient cpu on available nodes", count: 3, lastSeen: "2m" },
        { name: "ScalingReplicaSet", namespace: "commerce", type: "Normal", object: "Deployment/checkout-api", message: "Scaled up replica set to 12", count: 1, lastSeen: "8m" },
      ]);
    case "Pods":
      return buildPodRows();
    case "Deployments":
      return workloads.filter((item) => item.kind === "Deployment").map((item) => {
        const [ready, desired] = item.ready.split("/");
        return workloadRow(item, {
          upToDate: desired,
          available: ready,
          containers: 1,
          images: item.image,
        });
      });
    case "StatefulSets":
      return workloads.filter((item) => item.kind === "StatefulSet").map((item) => workloadRow(item, {
        containers: 2,
        images: item.image,
      }));
    case "DaemonSets":
      return workloads.filter((item) => item.kind === "DaemonSet").map((item) => {
        const desired = item.ready.split("/")[1] ?? "18";
        return workloadRow(item, {
          desired,
          current: desired,
          ready: item.ready,
          upToDate: desired,
          available: desired,
          nodeSelector: "kubernetes.io/os=linux",
        });
      });
    case "ReplicaSets":
      return workloads.filter((item) => item.kind === "Deployment").map((item, index) => workloadRow(item, {
        desired: item.ready.split("/")[1], current: item.ready.split("/")[0], ready: item.ready,
        controlledBy: `Deployment/${item.name}`,
      }, {
        key: `${item.namespace}/${item.name}-${["7b68b9c74c", "779d6bfcd", "5894f7d667"][index]}`,
        name: `${item.name}-${["7b68b9c74c", "779d6bfcd", "5894f7d667"][index]}`,
        kind: "ReplicaSet",
        links: { controlledBy: { kind: "Deployment", name: item.name, namespace: item.namespace, relation: "controller" } },
      }));
    case "Replication Controllers":
      return staticRows("ReplicationController", [
        { name: "legacy-api", namespace: "commerce", desired: 2, current: 2, ready: 2, selector: "app=legacy-api", status: "Ready", age: "412d" },
        { name: "legacy-worker", namespace: "search", desired: 1, current: 1, ready: 1, selector: "app=legacy-worker", status: "Ready", age: "365d" },
      ]);
    case "Jobs":
      return [
        ...workloads.filter((item) => item.kind === "CronJob").map((item) => workloadRow(item, { completions: "0/1", duration: "12m", controlledBy: `CronJob/${item.name}` }, { key: `${item.namespace}/${item.name}-289401`, name: `${item.name}-289401`, kind: "Job", status: "Running", links: { controlledBy: { kind: "CronJob", name: item.name, namespace: item.namespace, relation: "controller" } } })),
        ...staticRows("Job", [
          { name: "catalog-reindex-289401", namespace: "search", completions: "1/1", duration: "48s", status: "Complete", controlledBy: "CronJob/catalog-reindex", age: "2h" },
          { name: "payment-settlement-9182", namespace: "commerce", completions: "0/1", duration: "6m", status: "Running", controlledBy: "—", age: "6m" },
          { name: "database-backup-289400", namespace: "commerce", completions: "1/1", duration: "3m12s", status: "Complete", controlledBy: "CronJob/database-backup", age: "18h" },
        ]),
      ];
    case "CronJobs":
      return [
        ...workloads.filter((item) => item.kind === "CronJob").map((item) => workloadRow(item, { schedule: "*/15 * * * *", suspend: "False", active: 1, lastSchedule: "12m" })),
        ...staticRows("CronJob", [
          { name: "catalog-reindex", namespace: "search", schedule: "0 */6 * * *", suspend: "False", active: 0, lastSchedule: "2h", status: "Ready", age: "96d" },
          { name: "database-backup", namespace: "commerce", schedule: "0 2 * * *", suspend: "False", active: 0, lastSchedule: "18h", status: "Ready", age: "184d" },
        ]),
      ];
    case "Services":
      return staticRows("Service", [
        { name: "checkout-api", namespace: "commerce", type: "ClusterIP", clusterIp: "10.96.14.22", externalIp: "—", ports: "8080/TCP", selector: "app=checkout-api", age: "18d" },
        { name: "payment-worker", namespace: "commerce", type: "ClusterIP", clusterIp: "10.96.41.8", externalIp: "—", ports: "9090/TCP", selector: "app=payment-worker", age: "18d" },
        { name: "storefront", namespace: "storefront", type: "LoadBalancer", clusterIp: "10.96.8.55", externalIp: "34.250.18.91", ports: "80:30080/TCP,443:30443/TCP", selector: "app=storefront", age: "42d" },
        { name: "ingress-nginx-controller", namespace: "ingress-nginx", type: "NodePort", clusterIp: "10.96.200.12", externalIp: "—", ports: "80:30080/TCP,443:30443/TCP", selector: "app.kubernetes.io/name=ingress-nginx", age: "96d" },
      ]);
    case "Endpoints":
      return staticRows("Endpoints", [
        { name: "checkout-api", namespace: "commerce", addresses: "10.40.12.20, 10.40.12.21", ports: "8080/TCP", age: "18d" },
        { name: "payment-worker", namespace: "commerce", addresses: "10.41.13.20, 10.41.13.21", ports: "9090/TCP", age: "18d" },
        { name: "storefront", namespace: "storefront", addresses: "10.42.14.20", ports: "80/TCP, 443/TCP", age: "42d" },
      ]);
    case "Ingresses":
      return staticRows("Ingress", [
        { name: "storefront", namespace: "storefront", class: "nginx", hosts: "shop.example.com", address: "34.250.18.91", ports: "80, 443", age: "42d" },
        { name: "checkout-api", namespace: "commerce", class: "nginx", hosts: "api.example.com", address: "34.250.18.91", ports: "443", age: "18d" },
        { name: "argocd-server", namespace: "argocd", class: "nginx", hosts: "cd.example.com", address: "34.250.18.91", ports: "443", age: "96d" },
      ]);
    case "Ingress Classes":
      return staticRows("IngressClass", [
        { name: "nginx", controller: "k8s.io/ingress-nginx", parameters: "—", age: "301d" },
        { name: "internal", controller: "k8s.io/ingress-nginx", parameters: "IngressClassParams/internal", age: "120d" },
      ]);
    case "Network Policies":
      return staticRows("NetworkPolicy", [
        { name: "deny-all-ingress", namespace: "commerce", podSelector: "app=payment-worker", policyTypes: "Ingress", age: "64d" },
        { name: "allow-storefront", namespace: "storefront", podSelector: "app=storefront", policyTypes: "Ingress, Egress", age: "42d" },
        { name: "monitoring-scrape", namespace: "monitoring", podSelector: "—", policyTypes: "Ingress", age: "120d" },
      ]);
    case "Port Forwarding":
      return staticRows("PortForward", [
        { name: "Service/checkout-api", namespace: "commerce", localAddress: "localhost:18080", servicePort: 8080, targetPort: 8080, resolvedPod: "checkout-api-5bbdb4f98-pq8vh", protocol: "HTTP", status: "Active" },
        { name: "Pod/catalog-indexer-0", namespace: "search", localAddress: "localhost:19200", targetPort: 9200, resolvedPod: "catalog-indexer-0", protocol: "HTTP", status: "Active" },
      ]);
    case "Persistent Volume Claims":
      return staticRows("PersistentVolumeClaim", [
        { name: "orders-db-1", namespace: "commerce", status: "Bound", volume: "pv-orders-db-0", capacity: "200Gi", accessModes: "RWO", storageClass: "gp3", age: "88d" },
        { name: "catalog-db-1", namespace: "search", status: "Bound", volume: "pv-catalog-db-0", capacity: "500Gi", accessModes: "RWO", storageClass: "gp3", age: "88d" },
        { name: "prometheus-db-0", namespace: "monitoring", status: "Bound", volume: "pv-prometheus-0", capacity: "1Ti", accessModes: "RWO", storageClass: "fast-ssd", age: "301d" },
      ]);
    case "Persistent Volumes":
      return staticRows("PersistentVolume", [
        { name: "pv-orders-db-0", capacity: "200Gi", accessModes: "RWO", reclaimPolicy: "Retain", status: "Bound", claim: "commerce/orders-db-1", storageClass: "gp3", age: "88d" },
        { name: "pv-catalog-db-0", capacity: "500Gi", accessModes: "RWO", reclaimPolicy: "Retain", status: "Bound", claim: "search/catalog-db-1", storageClass: "gp3", age: "88d" },
        { name: "pv-prometheus-0", capacity: "1Ti", accessModes: "RWO", reclaimPolicy: "Delete", status: "Bound", claim: "monitoring/prometheus-db-0", storageClass: "fast-ssd", age: "301d" },
      ]);
    case "Storage Classes":
      return staticRows("StorageClass", [
        { name: "gp3", provisioner: "ebs.csi.aws.com", reclaimPolicy: "Delete", bindingMode: "WaitForFirstConsumer", allowExpansion: "true", age: "412d" },
        { name: "fast-ssd", provisioner: "pd.csi.storage.gke.io", reclaimPolicy: "Delete", bindingMode: "Immediate", allowExpansion: "true", age: "301d" },
        { name: "nfs-shared", provisioner: "nfs.csi.k8s.io", reclaimPolicy: "Retain", bindingMode: "Immediate", allowExpansion: "false", age: "184d" },
      ]);
    case "Config Maps":
      return staticRows("ConfigMap", [
        { name: "checkout-api-config", namespace: "commerce", data: 6, age: "18d" },
        { name: "storefront-feature-flags", namespace: "storefront", data: 14, age: "6d" },
        { name: "ingress-nginx-controller", namespace: "ingress-nginx", data: 3, age: "96d" },
        { name: "kube-root-ca.crt", namespace: "commerce", data: 1, age: "184d" },
      ]);
    case "Secrets":
      return staticRows("Secret", [
        { name: "checkout-api-tls", namespace: "commerce", type: "kubernetes.io/tls", data: 2, age: "18d" },
        { name: "payment-stripe", namespace: "commerce", type: "Opaque", data: 3, age: "42d" },
        { name: "ghcr-pull", namespace: "storefront", type: "kubernetes.io/dockerconfigjson", data: 1, age: "96d" },
        { name: "argocd-secret", namespace: "argocd", type: "Opaque", data: 5, age: "301d" },
      ]);
    case "Resource Quotas":
      return staticRows("ResourceQuota", [
        { name: "commerce-quota", namespace: "commerce", requests: "cpu: 20, memory: 64Gi", limits: "cpu: 40, memory: 128Gi", age: "120d" },
        { name: "storefront-quota", namespace: "storefront", requests: "cpu: 8, memory: 24Gi", limits: "cpu: 16, memory: 48Gi", age: "96d" },
        { name: "search-quota", namespace: "search", requests: "cpu: 12, memory: 48Gi", limits: "cpu: 24, memory: 96Gi", age: "88d" },
      ]);
    case "Limit Ranges":
      return staticRows("LimitRange", [
        { name: "default-limits", namespace: "commerce", type: "Container", min: "cpu: 50m", max: "cpu: 4, memory: 8Gi", default: "cpu: 500m, memory: 512Mi", age: "120d" },
        { name: "pod-limits", namespace: "storefront", type: "Pod", min: "cpu: 100m", max: "cpu: 8, memory: 16Gi", default: "—", age: "96d" },
      ]);
    case "Horizontal Pod Autoscalers":
      return staticRows("HorizontalPodAutoscaler", [
        { name: "checkout-api", namespace: "commerce", reference: "Deployment/checkout-api", targets: "64%/70%", minPods: 6, maxPods: 20, replicas: 12, age: "96d" },
        { name: "storefront", namespace: "storefront", reference: "Deployment/storefront", targets: "48%/75%", minPods: 2, maxPods: 10, replicas: 4, age: "42d" },
      ]);
    case "Vertical Pod Autoscalers":
      return staticRows("VerticalPodAutoscaler", [
        { name: "catalog-indexer", namespace: "search", reference: "StatefulSet/catalog-indexer", mode: "Auto", status: "Ready", age: "88d" },
        { name: "recommendation-api", namespace: "storefront", reference: "Deployment/recommendation-api", mode: "Off", status: "RecommendationProvided", age: "42d" },
      ]);
    case "Pod Disruption Budgets":
      return staticRows("PodDisruptionBudget", [
        { name: "checkout-api", namespace: "commerce", minAvailable: "75%", maxUnavailable: "—", allowedDisruptions: 3, age: "96d" },
        { name: "catalog-indexer", namespace: "search", minAvailable: 3, maxUnavailable: "—", allowedDisruptions: 2, age: "88d" },
      ]);
    case "Priority Classes":
      return staticRows("PriorityClass", [
        { name: "system-cluster-critical", value: 2000000000, globalDefault: "False", preemptionPolicy: "PreemptLowerPriority", age: "412d" },
        { name: "platform-critical", value: 1000000, globalDefault: "False", preemptionPolicy: "PreemptLowerPriority", age: "301d" },
        { name: "default", value: 0, globalDefault: "True", preemptionPolicy: "PreemptLowerPriority", age: "301d" },
      ]);
    case "Runtime Classes":
      return staticRows("RuntimeClass", [
        { name: "runc", handler: "runc", overhead: "—", scheduling: "—", age: "412d" },
        { name: "gvisor", handler: "runsc", overhead: "cpu: 50m, memory: 64Mi", scheduling: "runtime=gvisor", age: "184d" },
      ]);
    case "Leases":
      return staticRows("Lease", [
        { name: "kube-controller-manager", namespace: "kube-system", holder: "control-01", renewTime: "4s", age: "412d" },
        { name: "kube-scheduler", namespace: "kube-system", holder: "control-01", renewTime: "3s", age: "412d" },
        { name: "cert-manager-controller", namespace: "cert-manager", holder: "cert-manager-79c9", renewTime: "7s", age: "184d" },
      ]);
    case "Mutating Webhook Configs":
      return staticRows("MutatingWebhookConfiguration", [
        { name: "cert-manager-webhook", webhooks: 1, failurePolicy: "Fail", age: "184d" },
        { name: "istio-sidecar-injector", webhooks: 4, failurePolicy: "Fail", age: "301d" },
      ]);
    case "Validating Webhook Configs":
      return staticRows("ValidatingWebhookConfiguration", [
        { name: "cert-manager-webhook", webhooks: 1, failurePolicy: "Fail", age: "184d" },
        { name: "ingress-nginx-admission", webhooks: 1, failurePolicy: "Fail", age: "96d" },
      ]);
    case "Service Accounts":
      return staticRows("ServiceAccount", [
        { name: "checkout-api", namespace: "commerce", secrets: 1, age: "18d" },
        { name: "payment-worker", namespace: "commerce", secrets: 1, age: "18d" },
        { name: "default", namespace: "storefront", secrets: 0, age: "184d" },
        { name: "prometheus", namespace: "monitoring", secrets: 2, age: "301d" },
      ]);
    case "Cluster Roles":
      return staticRows("ClusterRole", [
        { name: "cluster-admin", rules: 1, aggregation: "—", age: "412d" },
        { name: "view", rules: 12, aggregation: "rbac.authorization.k8s.io/aggregate-to-view=true", age: "412d" },
        { name: "platform-operator", rules: 18, aggregation: "—", age: "301d" },
      ]);
    case "Roles":
      return staticRows("Role", [
        { name: "config-reader", namespace: "commerce", rules: 3, age: "96d" },
        { name: "secret-manager", namespace: "commerce", rules: 5, age: "96d" },
        { name: "pod-exec", namespace: "storefront", rules: 2, age: "42d" },
      ]);
    case "Cluster Role Bindings":
      return staticRows("ClusterRoleBinding", [
        { name: "cluster-admins", role: "ClusterRole/cluster-admin", subjects: "Group/platform-admins", age: "301d" },
        { name: "platform-viewers", role: "ClusterRole/view", subjects: "Group/platform-viewers", age: "184d" },
        { name: "prometheus", role: "ClusterRole/prometheus", subjects: "ServiceAccount/monitoring/prometheus", age: "301d" },
      ]);
    case "Role Bindings":
      return staticRows("RoleBinding", [
        { name: "checkout-config-reader", namespace: "commerce", role: "Role/config-reader", subjects: "SA/checkout-api", age: "96d" },
        { name: "payment-secret-manager", namespace: "commerce", role: "Role/secret-manager", subjects: "SA/payment-worker", age: "96d" },
        { name: "storefront-pod-exec", namespace: "storefront", role: "Role/pod-exec", subjects: "Group/platform-sre", age: "42d" },
      ]);
    case "Pod Security Policies":
      return staticRows("PodSecurityPolicy", [
        { name: "restricted", privileged: "False", volumes: "configMap, secret, persistentVolumeClaim", runAsUser: "MustRunAsNonRoot", age: "412d" },
        { name: "system-services", privileged: "False", volumes: "*", runAsUser: "RunAsAny", age: "412d" },
      ]);
    case "Helm Charts":
      return staticRows("HelmChart", [
        { name: "ingress-nginx", repository: "https://kubernetes.github.io/ingress-nginx", version: "4.11.3", appVersion: "1.11.3", description: "Ingress controller for Kubernetes" },
        { name: "cert-manager", repository: "https://charts.jetstack.io", version: "v1.16.2", appVersion: "v1.16.2", description: "X.509 certificate management" },
        { name: "kube-prometheus-stack", repository: "https://prometheus-community.github.io/helm-charts", version: "65.1.0", appVersion: "v0.76.0", description: "Kubernetes monitoring stack" },
        { name: "argo-cd", repository: "https://argoproj.github.io/argo-helm", version: "7.6.12", appVersion: "v2.12.6", description: "Declarative GitOps delivery" },
      ]);
    case "Helm Releases":
      return staticRows("HelmRelease", [
        { name: "ingress-nginx", namespace: "ingress-nginx", chart: "ingress-nginx-4.11.3", status: "deployed", revision: 8, appVersion: "1.11.3", updated: "12d ago" },
        { name: "cert-manager", namespace: "cert-manager", chart: "cert-manager-v1.16.2", status: "deployed", revision: 5, appVersion: "v1.16.2", updated: "28d ago" },
        { name: "kube-prometheus-stack", namespace: "monitoring", chart: "kube-prometheus-stack-65.1.0", status: "deployed", revision: 14, appVersion: "v0.76.0", updated: "6d ago" },
        { name: "argo-cd", namespace: "argocd", chart: "argo-cd-7.6.12", status: "failed", revision: 11, appVersion: "v2.12.6", updated: "2h ago" },
      ]);
    default:
      return [];
  }
}
