import {
  Activity, Box, Boxes, Code2, Database, FileCode2, FileKey, FilePen, Gauge,
  HardDrive, Hexagon, Layers3, LayoutDashboard, Network, RefreshCw, Scale,
  Server, ShieldCheck, Users, Zap, createLucideIcon,
} from "lucide-react";
import { resourceNameByKind } from "../resource-relations";

const RotateCwFadingClock = createLucideIcon("rotate-cw-fading-clock", [
  ["path", { d: "M12 3a9.75 9.75 0 0 1 6.74 2.74", key: "1k3kxf" }],
  ["path", { d: "M18.74 5.74 21 8", key: "1eb40o" }],
  ["path", { d: "M21 8V3", key: "1et280" }],
  ["path", { d: "M7.5 19.794c-6-3.464-6-12.124 0-15.588", key: "19r0lp" }],
  ["path", { d: "M7.5 4.206A9 9 0 0 1 12 3", key: "s8r11" }],
  ["path", { d: "M12 7v5l4 2", key: "1fdv2h" }],
  ["path", { d: "M14 20.775A9 9 0 0 1 12 21", key: "184rgu" }],
  ["path", { d: "M19 17.656a9 9 0 0 1-1.5 1.456", key: "7qgp6l" }],
  ["path", { d: "M21 12a9 9 0 0 1-.228 2", key: "1h378y" }],
  ["path", { d: "M21 8h-5", key: "k0yzmk" }],
]);

const iconMap: Record<string, typeof Box> = {
  Overview: LayoutDashboard, Nodes: Server, Namespaces: Layers3, Events: Activity,
  Pods: Box, Deployments: Boxes, DaemonSets: Server, StatefulSets: Database,
  ReplicaSets: Boxes, "Replication Controllers": RefreshCw, Jobs: Zap, CronJobs: RotateCwFadingClock,
  Services: Network, Endpoints: Network, Ingresses: Network, "Ingress Classes": Network,
  "Network Policies": ShieldCheck, "Port Forwarding": Network,
  "Persistent Volume Claims": HardDrive, "Persistent Volumes": HardDrive, "Storage Classes": Database,
  "Config Maps": FileCode2, Secrets: FileKey, "Resource Quotas": Gauge, "Limit Ranges": Gauge,
  "Horizontal Pod Autoscalers": Scale, "Vertical Pod Autoscalers": Gauge,
  "Pod Disruption Budgets": ShieldCheck, "Priority Classes": Gauge, "Runtime Classes": Server,
  Leases: FilePen, "Mutating Webhook Configs": Code2, "Validating Webhook Configs": ShieldCheck,
  "Service Accounts": Users, "Cluster Roles": ShieldCheck, Roles: ShieldCheck,
  "Cluster Role Bindings": Users, "Role Bindings": Users, "Pod Security Policies": ShieldCheck,
  "Helm Charts": Hexagon, "Helm Releases": Hexagon, "Custom Resource Definitions": Code2,
};

/**
 * The icon that stands for one resource kind (`Pod`, `HelmRelease`, …). Kinds
 * resolve through their navigation entry so a resource carries the same icon
 * wherever it appears; kinds the navigation tree does not list — a custom
 * resource instance — fall back to the custom resource icon.
 */
function resourceKindIcon(kind?: string | null): typeof Box {
  const navigationEntry = kind ? resourceNameByKind[kind] : undefined;
  return (navigationEntry ? iconMap[navigationEntry] : undefined) ?? Code2;
}

export { iconMap, resourceKindIcon };
