import { backend, descriptorForResource, nativeBackendAvailable, type BackendResourceRecord } from "../backend";
import type { DetailItem, PodSessionTarget } from "./types";

/**
 * Workload kinds that own Pods directly. Deployments are not listed here:
 * they own Pods through a ReplicaSet, so their Pods resolve one hop further.
 */
const podControllerKinds = new Set(["ReplicaSet", "StatefulSet", "DaemonSet", "Job", "ReplicationController"]);

type OwnerReference = { apiVersion?: string; kind?: string; name?: string; uid?: string; controller?: boolean };

type WorkloadController = { kind: string; name: string; namespace: string };

type PodTargetResolution = {
  targets: PodSessionTarget[];
  /**
   * The workload the session resolves through. A standalone Pod (no owning
   * controller) resolves without one and offers only itself as a target.
   */
  controller?: WorkloadController;
  /** When the session was opened from a Pod, the key of that Pod to preselect. */
  anchorPodKey?: string;
};

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

function ownerReferencesOf(record?: BackendResourceRecord | null): OwnerReference[] {
  const refs = (record?.object.metadata as { ownerReferences?: unknown } | undefined)?.ownerReferences;
  return Array.isArray(refs) ? refs as OwnerReference[] : [];
}

function recordUid(record?: BackendResourceRecord | null): string {
  return String(record?.uid ?? (record?.object.metadata as { uid?: unknown } | undefined)?.uid ?? "");
}

function matchLabelsOf(record?: BackendResourceRecord | null): Record<string, string> | undefined {
  const selector = (record?.object.spec as { selector?: { matchLabels?: Record<string, string> } } | undefined)?.selector;
  return selector?.matchLabels;
}

function labelSelectorText(labels?: Record<string, string> | null): string | undefined {
  const entries = labels
    ? Object.entries(labels).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
    : [];
  return entries.length ? entries.map(([key, value]) => `${key}=${value}`).join(",") : undefined;
}

async function listClusterRecords(clusterId: string, resourceName: string, namespace?: string, labelSelector?: string): Promise<BackendResourceRecord[]> {
  const descriptor = descriptorForResource(resourceName, [])!;
  // Compact records keep everything this module reads: spec containers, status
  // phase/containerStatuses, and metadata labels/ownerReferences/uids.
  const response = await backend.listResources({ clusterId, resource: descriptor, namespace, labelSelector, compact: true });
  return response.items;
}

function listPods(clusterId: string, namespace: string, labelSelector?: string) {
  return listClusterRecords(clusterId, "Pods", namespace, labelSelector);
}

function listReplicaSets(clusterId: string, namespace: string, labelSelector?: string) {
  return listClusterRecords(clusterId, "ReplicaSets", namespace, labelSelector);
}

/** Running first, ready second, then by name; a clicked Pod stays first so the session opens on it. */
function rankTargets(targets: PodSessionTarget[], anchorPodKey?: string): PodSessionTarget[] {
  const ranked = [...targets].sort(
    (left, right) => Number(right.phase === "Running") - Number(left.phase === "Running")
      || Number(right.ready) - Number(left.ready)
      || left.pod.localeCompare(right.pod),
  );
  if (anchorPodKey) {
    const anchorIndex = ranked.findIndex((target) => target.key === anchorPodKey);
    if (anchorIndex > 0) {
      const [anchor] = ranked.splice(anchorIndex, 1);
      ranked.unshift(anchor);
    }
  }
  return ranked;
}

async function resolvePodTargets(clusterId: string, item?: DetailItem): Promise<PodTargetResolution> {
  const empty = (): PodTargetResolution => ({ targets: [] });
  if (!nativeBackendAvailable) return empty();
  const record = item?.row?.backend ?? null;
  if (!record) return empty();
  const kind = item?.row?.kind ?? item?.kind ?? record.kind ?? "";
  const namespace = record.namespace && record.namespace !== "—"
    ? record.namespace
    : item?.subtitle && item.subtitle !== "—" ? item.subtitle : undefined;
  if (!namespace) return empty();

  if (kind === "Pod") return resolvePodAnchor(clusterId, record, namespace);
  if (kind === "Deployment") return resolveDeploymentAnchor(clusterId, record, namespace);
  if (podControllerKinds.has(kind)) return resolveDirectControllerAnchor(clusterId, record, kind, namespace);
  return empty();
}

/**
 * A session opened on a Pod: find the workload that owns it and offer that
 * workload's Pods, exactly like opening the session from the workload itself.
 */
async function resolvePodAnchor(clusterId: string, record: BackendResourceRecord, namespace: string): Promise<PodTargetResolution> {
  const anchorPodKey = `${record.namespace}/${record.name}`;
  const anchorPod = podTargetFromRecord(record);
  const owners = ownerReferencesOf(record);
  const leader = owners.find((owner) => owner.controller && (owner.kind === "ReplicaSet" || podControllerKinds.has(owner.kind)));
  // A standalone Pod has no workload to widen the session to; offer the Pod itself.
  if (!leader?.kind || !leader.uid) return { targets: [anchorPod], anchorPodKey };

  // Owned by a ReplicaSet: follow the chain up to the rollout workload so the
  // Pod list covers every ReplicaSet the workload currently owns.
  let controller: WorkloadController = { kind: leader.kind, name: leader.name ?? record.name, namespace };
  let ownerUids = new Set([leader.uid]);
  if (leader.kind === "ReplicaSet") {
    try {
      const replicasets = await listReplicaSets(clusterId, namespace);
      const ownReplicaSet = replicasets.find((candidate) => recordUid(candidate) === leader.uid);
      const rollout = ownReplicaSet
        ? ownerReferencesOf(ownReplicaSet).find((owner) => owner.controller && (owner.kind === "Deployment" || podControllerKinds.has(owner.kind)))
        : undefined;
      if (rollout?.kind && rollout.uid) {
        controller = { kind: rollout.kind, name: rollout.name ?? ownReplicaSet?.name ?? leader.name, namespace };
        const workloadUids = replicasets
          .filter((candidate) => ownerReferencesOf(candidate).some((owner) => owner.uid === rollout.uid))
          .map(recordUid);
        ownerUids = new Set([...workloadUids, leader.uid, rollout.uid]);
      }
    } catch {
      // Listing ReplicaSets can be RBAC-restricted; the Pod's own owner uid below stays usable.
    }
  }
  const pods = await listPods(clusterId, namespace);
  const targets = rankTargets(
    pods.filter((pod) => ownerReferencesOf(pod).some((owner) => owner.uid && ownerUids.has(owner.uid))).map(podTargetFromRecord),
    anchorPodKey,
  );
  return {
    // The owner chain always includes the Pod itself; if the listing missed it
    // (owner gone mid-flight), keep the Pod the user clicked as a target.
    targets: targets.length ? targets : [anchorPod],
    controller,
    anchorPodKey,
  };
}

/** A session opened on a Deployment: collect the Pods of every ReplicaSet it owns. */
async function resolveDeploymentAnchor(clusterId: string, record: BackendResourceRecord, namespace: string): Promise<PodTargetResolution> {
  const controller: WorkloadController = { kind: "Deployment", name: record.name, namespace };
  const selector = labelSelectorText(matchLabelsOf(record));
  const uid = recordUid(record);
  // Pods are never owned by a Deployment directly; they belong to its
  // ReplicaSets. Collect the owner uids so label lookalikes stay out.
  let ownerUids = new Set<string>();
  let replicaSetsUnreadable = false;
  try {
    const replicasets = await listReplicaSets(clusterId, namespace, selector);
    if (uid) {
      const owned = replicasets.filter((replicaSet) => ownerReferencesOf(replicaSet).some((owner) => owner.uid === uid));
      if (owned.length) ownerUids = new Set([uid, ...owned.map(recordUid)]);
    }
  } catch {
    replicaSetsUnreadable = true;
  }
  const pods = await listPods(clusterId, namespace, selector);
  const targets = ownerUids.size
    ? pods.filter((pod) => ownerReferencesOf(pod).some((owner) => owner.uid && ownerUids.has(owner.uid))).map(podTargetFromRecord)
    // ReplicaSet listing is RBAC-restricted (or the record has no uid): fall
    // back to the server-side selector match the way this resolved before.
    // Only when a selector exists: without one the pod list is namespace-wide
    // and would sweep in Pods that belong to unrelated workloads.
    : selector && (replicaSetsUnreadable || !uid)
      ? pods.map(podTargetFromRecord)
      : [];
  return { targets: rankTargets(targets), controller };
}

/** StatefulSet / DaemonSet / ReplicaSet / Job / ReplicationController own their Pods directly. */
async function resolveDirectControllerAnchor(clusterId: string, record: BackendResourceRecord, kind: string, namespace: string): Promise<PodTargetResolution> {
  const controller: WorkloadController = { kind, name: record.name, namespace };
  const selector = labelSelectorText(matchLabelsOf(record));
  const uid = recordUid(record);
  const pods = await listPods(clusterId, namespace, selector);
  const targets = uid
    ? pods.filter((pod) => ownerReferencesOf(pod).some((owner) => owner.uid === uid)).map(podTargetFromRecord)
    : pods.map(podTargetFromRecord);
  return { targets: rankTargets(targets), controller };
}

export { allPodContainers, resolvePodTargets, type PodTargetResolution };
