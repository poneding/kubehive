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
  sourcePath?: string | null;
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
