import { backend, descriptorForResource, nativeBackendAvailable, type BackendResourceRecord } from "../backend";
import type { DetailItem, PodSessionTarget } from "./types";

function podContainers(record?: BackendResourceRecord | null, type: "init" | "regular" = "regular") {
  const spec = record?.object.spec as { initContainers?: Array<{ name?: string }>; containers?: Array<{ name?: string }> } | undefined;
  return (type === "init" ? spec?.initContainers : spec?.containers ?? [])
    ?.map((container) => container.name?.trim() ?? "")
    .filter(Boolean) ?? [];
}

function allPodContainers(target?: PodSessionTarget) {
  return target ? [...target.containers, ...target.initContainers] : [];
}

function podIsReady(record: BackendResourceRecord) {
  const statuses = (record.object.status as { containerStatuses?: Array<{ ready?: boolean }> } | undefined)?.containerStatuses ?? [];
  return statuses.length > 0 && statuses.every((status) => status.ready);
}

function podTargetFromRecord(record: BackendResourceRecord): PodSessionTarget {
  return {
    key: `${record.namespace}/${record.name}`,
    namespace: record.namespace,
    pod: record.name,
    phase: String((record.object.status as { phase?: string } | undefined)?.phase ?? "Unknown"),
    ready: podIsReady(record),
    initContainers: podContainers(record, "init"),
    containers: podContainers(record),
  };
}


async function listPodTargets(clusterId: string, item?: DetailItem): Promise<PodSessionTarget[]> {
  if (!nativeBackendAvailable) return [];
  const descriptor = descriptorForResource("Pods", [])!;
  const namespace = item?.subtitle && item.subtitle !== "—" ? item.subtitle : undefined;
  const directPod = item?.row?.kind === "Pod";
  const labels = (item?.row?.backend?.object.spec as { selector?: { matchLabels?: Record<string, string> } } | undefined)?.selector?.matchLabels;
  const labelSelector = !directPod && labels ? Object.entries(labels).map(([key, value]) => `${key}=${value}`).join(",") : undefined;
  const fieldSelector = directPod ? `metadata.name=${item.row?.name}` : undefined;
  const response = await backend.listResources({ clusterId, resource: descriptor, namespace, labelSelector, fieldSelector });
  return response.items
    .map(podTargetFromRecord)
    .sort((left, right) => Number(right.phase === "Running") - Number(left.phase === "Running") || Number(right.ready) - Number(left.ready) || left.pod.localeCompare(right.pod));
}

export { allPodContainers, listPodTargets };
