import type { ContainerDetail, ContainerDetailSection, ContainerEnvironment, ContainerMount, ContainerPort } from "./types";
import type { ResourceRow } from "../resource-catalog";
import { array, compact, detailValueAt, object, resourceQuantityValues, sourceFor, string } from "./value";
import { commandFor, environmentFor, mountsFor, portsFor, sensitiveEnvironmentName, volumeSources } from "./env";

export function workloadPodSpec(row: ResourceRow): Record<string, unknown> {
  const source = sourceFor(row);
  switch (row.kind) {
    case "Pod": return object(detailValueAt(source, "spec"));
    case "CronJob": return object(detailValueAt(source, "spec.jobTemplate.spec.template.spec"));
    case "Job": return object(detailValueAt(source, "spec.template.spec"));
    case "Deployment":
    case "StatefulSet":
    case "DaemonSet":
    case "ReplicaSet":
    case "ReplicationController":
      return object(detailValueAt(source, "spec.template.spec"));
    default: return {};
  }
}

export function workloadTemplate(row: ResourceRow) {
  return workloadPodSpec(row);
}

type ContainerState = {
  state: string;
  reason?: string;
  exitCode?: number;
  message?: string;
};

function containerState(status: Record<string, unknown>, kind: ContainerDetail["kind"]): ContainerState {
  const state = object(status.state);
  const running = object(state.running);
  const waiting = object(state.waiting);
  const terminated = object(state.terminated);
  if (Object.keys(running).length) return { state: "Running" };
  if (Object.keys(waiting).length) return { state: "Waiting", reason: string(waiting.reason) || undefined, message: string(waiting.message) || undefined };
  if (Object.keys(terminated).length) {
    const exitCode = typeof terminated.exitCode === "number" ? terminated.exitCode : undefined;
    return {
      state: kind === "init" && exitCode === 0 ? "Completed" : "Terminated",
      reason: string(terminated.reason) || undefined,
      exitCode,
      message: string(terminated.message) || undefined,
    };
  }
  return { state: kind === "init" ? "Pending" : "Unknown" };
}

function fallbackContainers(row: ResourceRow): ContainerDetail[] {
  const fallback = row.containers?.map((container) => ({
    name: container.name,
    kind: "container" as const,
    image: container.image,
    imageId: undefined,
    pullPolicy: "IfNotPresent",
    state: container.status === "running" ? "Running" : container.status === "waiting" ? "Waiting" : container.status === "succeeded" ? "Completed" : container.status === "terminated" ? "Terminated" : "Unknown",
    ready: container.ready,
    restarts: container.restarts,
    command: typeof row.data.command === "string" ? row.data.command : undefined,
    ports: String(container.port ?? "").split(",").map((value) => value.trim()).filter(Boolean).map((value) => {
      const [number, protocol = "TCP"] = value.split("/");
      return { port: number, protocol };
    }),
    environment: typeof row.data.environment === "string" ? row.data.environment.split(",").map((item) => item.trim()).filter(Boolean).map((item) => {
      const [name, ...rest] = item.split("=");
      return { name, value: sensitiveEnvironmentName(name) ? "••••••••" : compact(rest.join("=") || "(empty)", 180), source: "literal" as const, sensitive: sensitiveEnvironmentName(name) };
    }) : [],
    mounts: typeof row.data.volumeMounts === "string" ? row.data.volumeMounts.split(",").map((item) => item.trim()).filter(Boolean).map((item) => {
      const [name, path] = item.split(":", 2);
      return { name, sourceName: name, sourceType: "Volume", path: path || "—", readOnly: false };
    }).filter((mount) => mount.path !== "—") : [],
  })) ?? [];
  return fallback;
}

export function getContainerDetailSection(row: ResourceRow): ContainerDetailSection | null {
  const spec = workloadPodSpec(row);
  const supported = ["Pod", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "ReplicationController", "Job", "CronJob"].includes(row.kind);
  if (!supported) return null;
  const status = object(detailValueAt(sourceFor(row), "status"));
  const statusByName = new Map<string, { value: Record<string, unknown>; kind: ContainerDetail["kind"] }>();
  for (const entry of array(status.initContainerStatuses)) statusByName.set(string(detailValueAt(entry, "name")), { value: object(entry), kind: "init" });
  for (const entry of array(status.containerStatuses)) statusByName.set(string(detailValueAt(entry, "name")), { value: object(entry), kind: "container" });
  for (const entry of array(status.ephemeralContainerStatuses)) statusByName.set(string(detailValueAt(entry, "name")), { value: object(entry), kind: "ephemeral" });
  const namespace = row.namespace === "—" ? undefined : row.namespace;
  const sources = volumeSources(spec, namespace);
  const collect = (value: unknown, kind: ContainerDetail["kind"]) => array(value).map((entry) => {
    const container = object(entry);
    const name = string(container.name) || "container";
    const runtime = statusByName.get(name)?.value ?? {};
    const state: ContainerState = row.kind === "Pod" ? containerState(runtime, kind) : { state: "Template" };
    const resources = object(container.resources);
    return {
      name,
      kind,
      image: string(container.image) || "—",
      imageId: string(runtime.imageID) || undefined,
      pullPolicy: string(container.imagePullPolicy) || "IfNotPresent",
      state: state.state,
      stateReason: state.reason,
      exitCode: state.exitCode,
      stateMessage: state.message,
      ready: runtime.ready === undefined ? undefined : runtime.ready === true,
      restarts: runtime.restartCount === undefined ? undefined : Number(runtime.restartCount) || 0,
      command: commandFor(container, "command"),
      args: commandFor(container, "args"),
      ports: portsFor(container),
      environment: environmentFor(container, namespace),
      mounts: mountsFor(container, sources),
      resourceRequests: resourceQuantityValues(resources.requests),
      resourceLimits: resourceQuantityValues(resources.limits),
    } satisfies ContainerDetail;
  });
  const containers = Object.keys(spec).length
    ? [...collect(spec.initContainers, "init"), ...collect(spec.containers, "container"), ...collect(spec.ephemeralContainers, "ephemeral")]
    : fallbackContainers(row);
  if (!containers.length) return null;
  const template = row.kind !== "Pod";
  return {
    id: "containers",
    title: template ? "Pod template containers" : "Containers",
    description: template ? "Images and runtime configuration used for Pods created by this workload." : "Runtime state and the configuration supplied to each container.",
    containers,
  };
}
