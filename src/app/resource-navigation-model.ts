import { crdNameForDescriptor, customResourceDescriptors, type ApiResourceDescriptor } from "../backend";
import type { CustomResourceDefinition } from "../data";
import type { CustomResourceNavEntry, ResourceTab } from "./types";

function apiNamespaceFilter(selected: string[]): string | undefined {
  return selected.length === 1 ? selected[0] : undefined;
}

function matchesNamespaceFilter(rowNamespace: string, selected: string[]) {
  return selected.length === 0 || selected.includes(rowNamespace);
}

function resourceTabId(resource: string, crd?: Pick<CustomResourceDefinition, "name" | "kind">) {
  return crd ? `crd/${crd.name}` : `resource/${resource.toLowerCase().replaceAll(" ", "-")}`;
}

/**
 * Navigation entries for the CRDs a cluster serves. The kind carries the label;
 * kinds installed by more than one group are suffixed with the group so both
 * stay distinguishable in flat lists (command palette, visibility filter).
 */
function customResourceNavEntries(discovered: ApiResourceDescriptor[]): CustomResourceNavEntry[] {
  const descriptors = customResourceDescriptors(discovered);
  const kindCounts = new Map<string, number>();
  descriptors.forEach((descriptor) => kindCounts.set(descriptor.kind, (kindCounts.get(descriptor.kind) ?? 0) + 1));
  return descriptors.map((descriptor) => ({
    name: crdNameForDescriptor(descriptor),
    label: (kindCounts.get(descriptor.kind) ?? 0) > 1 ? `${descriptor.kind} (${descriptor.group})` : descriptor.kind,
    kind: descriptor.kind,
    group: descriptor.group,
    descriptor,
  }));
}

/**
 * Installed kinds bucketed by API group (`cdi.kubevirt.io`, `cert-manager.io`,
 * …), groups sorted by name and kinds kept in their incoming kind order.
 */
function customResourceGroups(entries: CustomResourceNavEntry[]) {
  const groups = new Map<string, CustomResourceNavEntry[]>();
  entries.forEach((entry) => {
    const bucket = groups.get(entry.group);
    if (bucket) bucket.push(entry);
    else groups.set(entry.group, [entry]);
  });
  return [...groups.entries()]
    .map(([group, items]) => ({ group, items }))
    .sort((left, right) => left.group.localeCompare(right.group));
}

function isPreviewTab(tab: ResourceTab) {
  return tab.id !== "overview" && tab.preview === true;
}

const clusterScopedResources = new Set([
  "Nodes", "Namespaces", "Priority Classes", "Runtime Classes", "Mutating Webhook Configs",
  "Validating Webhook Configs", "Ingress Classes", "Persistent Volumes", "Storage Classes",
  "Helm Charts", "Cluster Roles", "Cluster Role Bindings", "Pod Security Policies",
]);

// Resource navigation is user-resizable: the grid column follows --nav-width
// (234px minimum, the previous fixed width) and the choice is persisted.
const navWidthStorageKey = "kubehive.navWidth";
const NAV_WIDTH_MIN = 234;
const NAV_WIDTH_MAX = 560;
const navWidthMax = () => Math.max(NAV_WIDTH_MIN, Math.min(NAV_WIDTH_MAX, window.innerWidth - 520));
const clampNavWidth = (value: number) => Math.round(Math.max(NAV_WIDTH_MIN, Math.min(navWidthMax(), value)));
function loadNavWidth() {
  try {
    const saved = Number(localStorage.getItem(navWidthStorageKey));
    if (Number.isFinite(saved) && saved >= NAV_WIDTH_MIN) return clampNavWidth(saved);
  } catch { /* ignore unavailable storage */ }
  return NAV_WIDTH_MIN;
}

// Lists whose page-head Create affordance can only be a dead end:
// - Nodes: the API server accepts the POST, but a Node is registered by its own
//   kubelet, so a hand-written manifest only adds a phantom NotReady entry.
// - Events: controllers emit these to describe things that already happened.
// - Port Forwarding: a KubeHive view, not an API collection. Forwards start from
//   the port-forward action on a Pod or Service row.
// - Helm Charts / Helm Releases: Helm owns these; there is no create path here.
const nonAuthorableResources = new Set(["Nodes", "Events", "Port Forwarding", "Helm Charts", "Helm Releases"]);

export {
  NAV_WIDTH_MIN,
  apiNamespaceFilter,
  clampNavWidth,
  clusterScopedResources,
  customResourceGroups,
  customResourceNavEntries,
  isPreviewTab,
  loadNavWidth,
  matchesNamespaceFilter,
  navWidthMax,
  navWidthStorageKey,
  nonAuthorableResources,
  resourceTabId,
};
