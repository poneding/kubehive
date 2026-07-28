export type Cluster = {
  id: string;
  name: string;
  provider: "AWS" | "GCP" | "Azure" | "Local";
  region: string;
  version: string;
  status: "healthy" | "warning" | "offline";
  nodes: number;
  cpu: number;
  memory: number;
  color?: string;
  disconnected?: boolean;
  context?: string;
  server?: string;
  defaultNamespace?: string;
  imported?: boolean;
  error?: string | null;
};

export const defaultClusterColors: Record<Cluster["provider"], string> = {
  AWS: "#f59e0b",
  GCP: "#3b82f6",
  Azure: "#0ea5e9",
  Local: "#a78bfa",
};

export function clusterAccent(cluster: Pick<Cluster, "provider" | "color">) {
  return cluster.color ?? defaultClusterColors[cluster.provider] ?? "#55d49a";
}

export type Workload = {
  name: string;
  namespace: string;
  kind: "Deployment" | "StatefulSet" | "DaemonSet" | "CronJob";
  status: "Running" | "Degraded" | "Pending";
  ready: string;
  restarts: number;
  cpu: string;
  memory: string;
  age: string;
  image: string;
};

export const clusters: Cluster[] = [
  { id: "prod-eu", name: "production-eu", provider: "AWS", region: "eu-west-1", version: "v1.31.4", status: "healthy", nodes: 18, cpu: 64, memory: 71, disconnected: true },
  { id: "staging", name: "staging", provider: "GCP", region: "us-central1", version: "v1.30.8", status: "warning", nodes: 7, cpu: 81, memory: 62, disconnected: true },
  { id: "edge-ap", name: "edge-ap-south", provider: "Azure", region: "central-india", version: "v1.30.6", status: "healthy", nodes: 12, cpu: 43, memory: 55, disconnected: true },
  { id: "local", name: "local-dev", provider: "Local", region: "docker-desktop", version: "v1.29.2", status: "offline", nodes: 1, cpu: 0, memory: 0, disconnected: true },
];

export const workloads: Workload[] = [
  { name: "checkout-api", namespace: "commerce", kind: "Deployment", status: "Running", ready: "12/12", restarts: 0, cpu: "1.8 cores", memory: "3.2 GiB", age: "18d", image: "ghcr.io/acme/checkout:v4.12.1" },
  { name: "payment-worker", namespace: "commerce", kind: "Deployment", status: "Degraded", ready: "7/8", restarts: 14, cpu: "920m", memory: "2.4 GiB", age: "18d", image: "ghcr.io/acme/payment:v2.9.0" },
  { name: "catalog-indexer", namespace: "search", kind: "StatefulSet", status: "Running", ready: "5/5", restarts: 1, cpu: "2.1 cores", memory: "8.7 GiB", age: "42d", image: "ghcr.io/acme/indexer:v7.3.2" },
  { name: "ingress-nginx-controller", namespace: "ingress-nginx", kind: "DaemonSet", status: "Running", ready: "18/18", restarts: 0, cpu: "540m", memory: "1.1 GiB", age: "96d", image: "registry.k8s.io/ingress-nginx/controller:v1.11.3" },
  { name: "recommendation-api", namespace: "storefront", kind: "Deployment", status: "Pending", ready: "4/6", restarts: 3, cpu: "730m", memory: "1.8 GiB", age: "6d", image: "ghcr.io/acme/recommendation:v1.8.4" },
  { name: "order-reconciler", namespace: "commerce", kind: "CronJob", status: "Running", ready: "1/1", restarts: 0, cpu: "120m", memory: "320 MiB", age: "31d", image: "ghcr.io/acme/reconciler:v3.1.0" },
];

export type CustomResourceDefinition = {
  name: string;
  group: string;
  version: string;
  kind: string;
  scope: "Namespaced" | "Cluster";
  instances: number;
  age: string;
  plural?: string;
};

export type CustomResource = {
  name: string;
  namespace: string;
  status: string;
  version: string;
  age: string;
};

export const customResourceDefinitions: CustomResourceDefinition[] = [
  { name: "certificates.cert-manager.io", group: "cert-manager.io", version: "v1", kind: "Certificate", scope: "Namespaced", instances: 24, age: "184d" },
  { name: "applications.argoproj.io", group: "argoproj.io", version: "v1alpha1", kind: "Application", scope: "Namespaced", instances: 18, age: "301d" },
  { name: "prometheuses.monitoring.coreos.com", group: "monitoring.coreos.com", version: "v1", kind: "Prometheus", scope: "Namespaced", instances: 3, age: "412d" },
  { name: "clusters.postgresql.cnpg.io", group: "postgresql.cnpg.io", version: "v1", kind: "Cluster", scope: "Namespaced", instances: 6, age: "128d" },
  { name: "nodepools.karpenter.sh", group: "karpenter.sh", version: "v1", kind: "NodePool", scope: "Cluster", instances: 4, age: "96d" },
];

export const customResources: Record<string, CustomResource[]> = {
  Certificate: [
    { name: "storefront-tls", namespace: "storefront", status: "Ready", version: "v1", age: "42d" },
    { name: "checkout-api-tls", namespace: "commerce", status: "Ready", version: "v1", age: "18d" },
    { name: "internal-wildcard", namespace: "ingress-nginx", status: "Issuing", version: "v1", age: "4m" },
  ],
  Application: [
    { name: "commerce-production", namespace: "argocd", status: "Synced / Healthy", version: "v1alpha1", age: "96d" },
    { name: "observability", namespace: "argocd", status: "OutOfSync", version: "v1alpha1", age: "96d" },
  ],
  Prometheus: [{ name: "platform", namespace: "monitoring", status: "Ready", version: "v1", age: "301d" }],
  Cluster: [{ name: "orders-db", namespace: "commerce", status: "Healthy", version: "v1", age: "88d" }, { name: "catalog-db", namespace: "search", status: "Healthy", version: "v1", age: "88d" }],
  NodePool: [{ name: "general-purpose", namespace: "—", status: "Ready", version: "v1", age: "96d" }, { name: "compute-optimized", namespace: "—", status: "Ready", version: "v1", age: "54d" }],
};

export const events = [
  { level: "warning", reason: "Unhealthy", object: "pod/payment-worker-7b68b9c74c-x2rnl", message: "Readiness probe failed: HTTP probe returned status 503", time: "34s" },
  { level: "warning", reason: "FailedScheduling", object: "pod/recommendation-api-5894f7d667-2dk8q", message: "0/18 nodes available: insufficient cpu", time: "2m" },
  { level: "normal", reason: "ScalingReplicaSet", object: "deployment/checkout-api", message: "Scaled up replica set checkout-api-779d6bfcd to 12", time: "8m" },
  { level: "normal", reason: "Pulled", object: "pod/catalog-indexer-3", message: "Container image already present on machine", time: "11m" },
];

export const navGroups = [
  { label: "Overview", items: ["Overview"] },
  { label: "Cluster", items: ["Nodes", "Namespaces", "Events"] },
  { label: "Workloads", items: ["Pods", "Deployments", "DaemonSets", "StatefulSets", "ReplicaSets", "Replication Controllers", "Jobs", "CronJobs"] },
  { label: "Configuration", items: ["Config Maps", "Secrets", "Resource Quotas", "Limit Ranges", "Horizontal Pod Autoscalers", "Vertical Pod Autoscalers", "Pod Disruption Budgets", "Priority Classes", "Runtime Classes", "Leases", "Mutating Webhook Configs", "Validating Webhook Configs"] },
  { label: "Network", items: ["Services", "Endpoints", "Ingresses", "Ingress Classes", "Network Policies", "Port Forwarding"] },
  { label: "Storage", items: ["Persistent Volume Claims", "Persistent Volumes", "Storage Classes"] },
  { label: "Helm", items: ["Helm Charts", "Helm Releases"] },
  { label: "Access Control", items: ["Service Accounts", "Cluster Roles", "Roles", "Cluster Role Bindings", "Role Bindings", "Pod Security Policies"] },
  { label: "Custom Resources", items: ["Custom Resource Definitions"] },
];
