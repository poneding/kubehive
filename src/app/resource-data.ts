import { useEffect, useMemo, useRef, useState } from "react";
import { backend, descriptorForResource, nativeBackendAvailable, type ApiResourceDescriptor, type BackendResourceRecord } from "../backend";
import { rowFromBackend } from "../k8s-adapter";
import type { ResourceRow } from "../resource-catalog";
import { requestClusterProbe } from "./app-state";

function manifestReadOnlyReason(row: ResourceRow): string | undefined {
  if (row.kind === "HelmRelease") return "This Helm release is managed by Helm and is read-only in KubeHive.";
  if (row.kind === "Secret") return "Secret manifests can be inspected here but are read-only to prevent accidental modification.";
  // Everything else is editable: the API server is the source of truth for
  // patch permissions, and Apply surfaces 403/validation errors directly.
  // Gating on discovery verbs was unreliable — discovery is reset and
  // refetched asynchronously, and verbs do not reflect the current
  // credentials' RBAC, which made the editor flip to read-only at random.
  return undefined;
}

type ResourceSyncMode = "unavailable" | "manual" | "poll" | "watch";

const RESOURCE_POLL_INTERVAL = 15_000;
const PORT_FORWARD_POLL_INTERVAL = 3_000;

function resourceSyncMode(resource: string, descriptor: ApiResourceDescriptor | null | undefined): ResourceSyncMode {
  if (!nativeBackendAvailable) return "unavailable";
  if (resource === "Port Forwarding") return "poll";
  if (resource === "Helm Charts") return "manual";
  return descriptor?.verbs.includes("watch") ? "watch" : "poll";
}

function useResourceRows(clusterId: string, resource: string, namespace: string, discovered: ApiResourceDescriptor[], revision = 0, override?: ApiResourceDescriptor) {
  const rowsByKey = useRef(new Map<string, ResourceRow>());
  const [rowsRevision, setRowsRevision] = useState(0);
  const [loading, setLoading] = useState(nativeBackendAvailable);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const descriptor = override ?? descriptorForResource(resource, discovered);
  const effectiveDescriptor = resource === "Helm Releases"
    ? discovered.find((entry) => entry.kind === "Secret" && entry.apiVersion === "v1") ?? descriptorForResource("Secrets", discovered)
    : descriptor;
  const desiredSyncMode = resourceSyncMode(resource, effectiveDescriptor);
  const descriptorSignature = effectiveDescriptor
    ? `${effectiveDescriptor.apiVersion}\u0000${effectiveDescriptor.kind}\u0000${effectiveDescriptor.plural}\u0000${effectiveDescriptor.namespaced}\u0000${effectiveDescriptor.verbs.join(",")}`
    : "";
  const [syncMode, setSyncMode] = useState<ResourceSyncMode>(desiredSyncMode);
  const rows = useMemo(() => Array.from(rowsByKey.current.values()), [rowsRevision]);
  const replaceRows = (nextRows: ResourceRow[]) => {
    rowsByKey.current = new Map(nextRows.map((row) => [row.key, row]));
    setRowsRevision((value) => value + 1);
  };

  useEffect(() => {
    if (!nativeBackendAvailable) {
      replaceRows([]);
      setSyncMode("unavailable");
      setError("");
      setLoading(false);
      return;
    }
    setSyncMode(desiredSyncMode);
    let cancelled = false;
    let subscriptionId = "";
    let refreshTimer: number | undefined;
    let loadingSnapshot = false;
    const stop = () => { if (subscriptionId) void backend.stopWatch(subscriptionId); };
    const stopRefreshTimer = () => {
      if (refreshTimer !== undefined) {
        window.clearInterval(refreshTimer);
        refreshTimer = undefined;
      }
    };
    const interval = resource === "Port Forwarding" ? PORT_FORWARD_POLL_INTERVAL : RESOURCE_POLL_INTERVAL;
    const startRefreshTimer = () => {
      if (refreshTimer === undefined) refreshTimer = window.setInterval(() => { void load(true); }, interval);
    };
    const load = async (quiet = false) => {
      if (loadingSnapshot) return;
      loadingSnapshot = true;
      if (!quiet) setLoading(true);
      if (!quiet) setError("");
      try {
        if (resource === "Port Forwarding") {
          const sessions = await backend.listPortForwards(clusterId);
          if (!cancelled) {
            replaceRows(sessions.map((session) => {
              const targetKind = session.targetKind === "service" ? "Service" : "Pod";
              const targetName = session.targetName;
              return {
                key: session.id, name: `${targetName}-${session.remotePort}`, namespace: session.namespace, kind: "PortForward", status: session.status,
                data: { name: `${targetName}-${session.remotePort}`, namespace: session.namespace, target: `${targetKind}/${targetName}`, host: session.host, localAddress: `${session.host}:${session.localPort}`, localPort: session.localPort, targetPort: session.remotePort, servicePort: session.servicePort, resolvedPod: session.pod, protocol: session.protocol.toUpperCase(), status: session.status, error: session.error } as ResourceRow["data"],
                links: {
                  ...(session.namespace ? { namespace: { kind: "Namespace", name: session.namespace, relation: "namespace" } } : {}),
                  ...(session.targetName ? { target: { kind: targetKind, name: session.targetName, namespace: session.namespace || undefined, relation: "forwardTarget" } } : {}),
                  ...(session.pod ? { resolvedPod: { kind: "Pod", name: session.pod, namespace: session.namespace || undefined, relation: "endpointPod" } } : {}),
                },
              };
            }));
            setError("");
          }
          return;
        }
        if (resource === "Helm Charts") {
          const charts = await backend.listHelmCharts(reloadToken > 0);
          if (!cancelled) {
            replaceRows(charts.map((chart) => ({ key: `${chart.repository}/${chart.name}`, name: chart.name, namespace: "—", kind: "HelmChart", data: { name: chart.name, repository: chart.repository, version: chart.version, appVersion: chart.appVersion, description: chart.description } })));
            setError("");
          }
          return;
        }
        let labelSelector: string | undefined;
        if (resource === "Helm Releases") labelSelector = "owner=helm";
        if (!effectiveDescriptor) throw new Error(`No Kubernetes API mapping is available for ${resource}`);
        const request = {
          clusterId,
          resource: effectiveDescriptor,
          namespace: effectiveDescriptor.namespaced && namespace !== "All namespaces" ? namespace : undefined,
          labelSelector,
          compact: resource === "Custom Resource Definitions" || !resource.startsWith("Custom Resource "),
        };
        const response = await backend.listResources(request);
        if (cancelled) return;
        const toRow = (record: BackendResourceRecord) => {
          const row = rowFromBackend(record, effectiveDescriptor);
          if (resource === "Helm Releases") {
            const labels = (record.object.metadata as { labels?: Record<string, string> } | undefined)?.labels ?? {};
            const match = record.name.match(/^sh\.helm\.release\.v1\.(.+)\.v(\d+)$/);
            row.name = match?.[1] ?? record.name;
            row.kind = "HelmRelease";
            row.data = { ...row.data, name: row.name, chart: labels.chart ?? "—", status: labels.status ?? "unknown", revision: match?.[2] ?? labels.version ?? "—", appVersion: labels.appVersion ?? "—", updated: row.data.age };
          }
          return row;
        };
        replaceRows(response.items.map(toRow));
        setError("");
        if (desiredSyncMode === "watch" && !subscriptionId) {
          try {
            const nextSubscriptionId = await backend.startWatch({ ...request, resourceVersion: response.resourceVersion }, (message) => {
              if (cancelled) return;
              if (message.eventType === "error") {
                setError("");
                setSyncMode("poll");
                requestClusterProbe(clusterId);
                startRefreshTimer();
                return;
              }
              setError("");
              setSyncMode("watch");
              stopRefreshTimer();
              if (message.eventType === "snapshot") {
                replaceRows(message.resources.map(toRow));
                return;
              }
              if (message.eventType !== "batch" || message.events.length === 0) return;
              const current = rowsByKey.current;
              message.events.forEach((event) => {
                const next = toRow(event.resource);
                if (event.eventType === "deleted") current.delete(next.key);
                else current.set(next.key, next);
              });
              setRowsRevision((value) => value + 1);
            });
            subscriptionId = nextSubscriptionId;
            if (cancelled) {
              void backend.stopWatch(nextSubscriptionId);
              return;
            }
            setSyncMode("watch");
            stopRefreshTimer();
          } catch {
            if (!cancelled) {
              setError("");
              setSyncMode("poll");
              requestClusterProbe(clusterId);
              startRefreshTimer();
            }
          }
        }
      } catch (nextError) {
        if (!cancelled) {
          if (!quiet) replaceRows([]);
          setError(String(nextError));
          requestClusterProbe(clusterId);
          if (desiredSyncMode !== "manual") {
            setSyncMode("poll");
            startRefreshTimer();
          }
        }
      } finally {
        loadingSnapshot = false;
        if (!cancelled && !quiet) setLoading(false);
      }
    };
    void load();
    if (desiredSyncMode === "poll") startRefreshTimer();
    return () => { cancelled = true; stop(); stopRefreshTimer(); };
  }, [clusterId, resource, namespace, revision, reloadToken, descriptorSignature, desiredSyncMode]);

  return { rows, loading, error, descriptor, syncMode, reload: () => setReloadToken((value) => value + 1) };
}

export { manifestReadOnlyReason, useResourceRows };
