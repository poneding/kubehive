import type { Cluster } from "../data";
import type { BottomSession, ClusterWorkspaceState, ResourceTab } from "./types";

const unconfiguredCluster: Cluster = { id: "unconfigured", name: "No cluster configured", provider: "Local", region: "Add a kubeconfig to begin", version: "—", status: "offline", nodes: 0, cpu: 0, memory: 0, disconnected: true };
const clusterWorkspaceStorageKey = "kubehive.clusterWorkspaces";
const clusterOrderStorageKey = "kubehive.clusterOrder";
const clusterProbeRequestedEvent = "kubehive:probe-cluster";

function requestClusterProbe(clusterId: string) {
  window.dispatchEvent(new CustomEvent(clusterProbeRequestedEvent, { detail: { clusterId } }));
}

function applySavedClusterOrder(items: Cluster[]): Cluster[] {
  try {
    const order = JSON.parse(localStorage.getItem(clusterOrderStorageKey) ?? "[]") as unknown;
    if (!Array.isArray(order)) return items;
    const rank = new Map(order.filter((id): id is string => typeof id === "string").map((id, index) => [id, index]));
    const original = new Map(items.map((item, index) => [item.id, index]));
    return [...items].sort((left, right) => (rank.get(left.id) ?? order.length + (original.get(left.id) ?? 0)) - (rank.get(right.id) ?? order.length + (original.get(right.id) ?? 0)));
  } catch { return items; }
}

function defaultClusterWorkspace(): ClusterWorkspaceState {
  return {
    tabs: [{ id: "overview", label: "Overview", resource: "Overview", preview: false }],
    activeTabId: "overview",
    namespaces: [],
    bottomSessions: [],
    activeBottomId: "",
    bottomCollapsed: false,
  };
}

function normalizeSelectedNamespaces(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0 && item !== "All namespaces"))];
  }
  if (typeof value === "string" && value && value !== "All namespaces") return [value];
  return [];
}

function normalizeBottomSessions(value: unknown): BottomSession[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const session = entry as Partial<BottomSession>;
    if (typeof session.id !== "string" || seen.has(session.id) || !["create", "edit", "logs", "terminal", "files"].includes(session.mode ?? "")) return [];
    seen.add(session.id);
    return [{
      id: session.id,
      mode: session.mode!,
      sessionKey: typeof session.sessionKey === "string" ? session.sessionKey : undefined,
      label: typeof session.label === "string" ? session.label : undefined,
      manifest: typeof session.manifest === "string" ? session.manifest : undefined,
      item: session.item && typeof session.item === "object" ? session.item : undefined,
      descriptor: session.descriptor && typeof session.descriptor === "object" ? session.descriptor : undefined,
      readOnlyReason: typeof session.readOnlyReason === "string" ? session.readOnlyReason : undefined,
      terminalTarget: session.terminalTarget === "container" || session.terminalTarget === "local" || session.terminalTarget === "node" ? session.terminalTarget : undefined,
    }];
  });
}

function normalizeClusterWorkspace(value: unknown): ClusterWorkspaceState {
  const candidate = value && typeof value === "object" ? value as Partial<ClusterWorkspaceState> : {};
  const tabs: ResourceTab[] = defaultClusterWorkspace().tabs;
  const seen = new Set(["overview"]);
  if (Array.isArray(candidate.tabs)) {
    candidate.tabs.forEach((entry) => {
      if (!entry || typeof entry !== "object") return;
      const tab = entry as Partial<ResourceTab>;
      if (typeof tab.id !== "string" || typeof tab.label !== "string" || typeof tab.resource !== "string" || seen.has(tab.id)) return;
      tabs.push({ id: tab.id, label: tab.label, resource: tab.resource, crdKind: typeof tab.crdKind === "string" ? tab.crdKind : undefined, crdName: typeof tab.crdName === "string" ? tab.crdName : undefined, preview: tab.preview === true });
      seen.add(tab.id);
    });
  }
  const activeTabId = typeof candidate.activeTabId === "string" && seen.has(candidate.activeTabId) ? candidate.activeTabId : "overview";
  // Prefer the multi-select field; fall back to the legacy single-namespace string.
  const namespaces = normalizeSelectedNamespaces(
    Array.isArray((candidate as { namespaces?: unknown }).namespaces)
      ? (candidate as { namespaces?: unknown }).namespaces
      : (candidate as { namespace?: unknown }).namespace,
  );
  const bottomSessions = normalizeBottomSessions(candidate.bottomSessions);
  const activeBottomId = typeof candidate.activeBottomId === "string" && bottomSessions.some((session) => session.id === candidate.activeBottomId)
    ? candidate.activeBottomId
    : bottomSessions[0]?.id ?? "";
  const bottomCollapsed = typeof candidate.bottomCollapsed === "boolean" ? candidate.bottomCollapsed : false;
  return { tabs, activeTabId, namespaces, bottomSessions, activeBottomId, bottomCollapsed };
}

function loadClusterWorkspaces(): Record<string, ClusterWorkspaceState> {
  try {
    const saved = JSON.parse(localStorage.getItem(clusterWorkspaceStorageKey) ?? "{}") as Record<string, unknown>;
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved).map(([clusterId, workspace]) => [clusterId, normalizeClusterWorkspace(workspace)]));
  } catch { return {}; }
}

export {
  applySavedClusterOrder,
  clusterOrderStorageKey,
  clusterProbeRequestedEvent,
  clusterWorkspaceStorageKey,
  defaultClusterWorkspace,
  loadClusterWorkspaces,
  normalizeClusterWorkspace,
  normalizeSelectedNamespaces,
  requestClusterProbe,
  unconfiguredCluster,
};
