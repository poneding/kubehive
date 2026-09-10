import type { ResourceRow } from "../resource-catalog";
import type { ResourceCondition, ResourceDetailLink } from "./types";
import { array, compact, detailValueAt, object, sourceFor, string } from "./value";

/**
 * Secret/ConfigMap entries discriminate on `source`: only base64-backed data
 * carries an `encoded` preview, and binary entries always carry one.
 */
export type ResourceDataEntry =
  | { key: string; decoded: string; source: "stringData"; encoded?: undefined }
  | { key: string; decoded: string; source: "data"; encoded?: string }
  | { key: string; decoded: string; source: "binaryData"; encoded: string };

function decodeBase64(value: string): string {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "Unable to decode this value";
  }
}

export function getResourceDataEntries(row?: ResourceRow): ResourceDataEntry[] {
  if (!row || !["ConfigMap", "Secret"].includes(row.kind)) return [];
  const source = sourceFor(row);
  const data = object(detailValueAt(source, "data"));
  const binaryData = object(detailValueAt(source, "binaryData"));
  const stringData = object(detailValueAt(source, "stringData"));
  const entries: ResourceDataEntry[] = [];
  for (const [key, value] of Object.entries(data)) {
    const text = string(value);
    entries.push(row.kind === "Secret" ? { key, encoded: text, decoded: decodeBase64(text), source: "data" } : { key, decoded: text, source: "data" });
  }
  for (const [key, value] of Object.entries(binaryData)) {
    const text = string(value);
    entries.push({ key, encoded: text, decoded: decodeBase64(text), source: "binaryData" });
  }
  for (const [key, value] of Object.entries(stringData)) entries.push({ key, decoded: string(value), source: "stringData" });
  return entries.sort((left, right) => left.key.localeCompare(right.key));
}

export function getResourceConditions(row?: ResourceRow): ResourceCondition[] {
  if (!row?.backend) return row?.status ? [{ type: row.status, status: row.status === "Running" || row.status === "Ready" || row.status === "Bound" ? "True" : "Unknown", reason: "Observed status", message: "Status from the current resource snapshot.", lastTransition: String(row.data.age ?? "—") }] : [];
  return array(detailValueAt(row.backend.object, "status.conditions")).map((condition) => ({
    type: compact(detailValueAt(condition, "type")),
    status: compact(detailValueAt(condition, "status")),
    reason: compact(detailValueAt(condition, "reason")),
    message: compact(detailValueAt(condition, "message"), 400),
    lastTransition: compact(detailValueAt(condition, "lastTransitionTime") ?? detailValueAt(condition, "lastProbeTime")),
  }));
}

function labelsFromString(value: unknown): Record<string, string> {
  if (typeof value !== "string") return {};
  return Object.fromEntries(value.split(",").map((entry) => entry.trim().split("=", 2)).filter((entry): entry is [string, string] => entry.length === 2 && Boolean(entry[0])));
}

export type ResourceProperty = {
  label: string;
  value: string;
  copyable?: boolean;
  tone?: "neutral" | "green" | "amber" | "red" | "blue";
  link?: ResourceDetailLink;
};

export function getResourceStatusValue(row: ResourceRow): string {
  const status = object(detailValueAt(sourceFor(row), "status"));
  return string(status.phase || status.status || row.status) || "Unknown";
}

export function getResourceStatusReason(row: ResourceRow): string {
  const status = object(detailValueAt(sourceFor(row), "status"));
  return string(status.reason || row.data.reason);
}

export function isFailedPodPhase(row: ResourceRow): boolean {
  if (row.kind !== "Pod") return false;
  const status = object(detailValueAt(sourceFor(row), "status"));
  return string(status.phase) === "Failed";
}

export function getResourceStatusProperties(row: ResourceRow): ResourceProperty[] {
  const status = object(detailValueAt(sourceFor(row), "status"));
  const value = getResourceStatusValue(row);
  const reason = getResourceStatusReason(row);
  const message = string(status.message || row.data.message) || "—";
  const failed = row.kind === "Pod" ? isFailedPodPhase(row) : /(failed|failure|error)/.test(value.toLowerCase());
  // The status itself is summarized in the Status section heading (like Pod);
  // only failure detail belongs in the field grid.
  const fields: ResourceProperty[] = [];
  if (failed) {
    if (row.kind === "Pod") fields.push({ label: "Message", value: message, copyable: true });
    else fields.push(
      { label: "Reason", value: reason || "—" },
      { label: "Message", value: message, copyable: true },
    );
  }
  return fields;
}

export function getResourceProperties(row: ResourceRow): ResourceProperty[] {
  const source = sourceFor(row);
  const spec = object(detailValueAt(source, "spec"));
  const status = object(detailValueAt(source, "status"));
  const namespace = row.namespace === "—" ? undefined : row.namespace;
  const properties: ResourceProperty[] = [
    { label: "Name", value: row.name, copyable: true },
    ...(namespace ? [{ label: "Namespace", value: namespace, copyable: true, link: { kind: "Namespace", name: namespace } }] : []),
  ];
  if (row.kind === "Pod") {
    const owner = array(detailValueAt(source, "metadata.ownerReferences")).map(object).find((entry) => entry.controller === true) ?? object(array(detailValueAt(source, "metadata.ownerReferences"))[0]);
    const ownerKind = string(owner.kind);
    const ownerName = string(owner.name);
    const node = string(spec.nodeName || row.data.node);
    const serviceAccount = string(spec.serviceAccountName || row.data.serviceAccount || "default");
    properties.push(
      { label: "Pod IP", value: string(status.podIP || row.data.ip) || "—", copyable: true },
    );
    if (ownerKind && ownerName) properties.push({ label: "Controlled by", value: `${ownerKind}/${ownerName}`, link: { kind: ownerKind, name: ownerName, namespace, apiVersion: string(owner.apiVersion) || undefined } });
    if (node && node !== "—") properties.push({ label: "Node", value: node, copyable: true, link: { kind: "Node", name: node } });
    if (serviceAccount) properties.push({ label: "Service account", value: serviceAccount, copyable: true, link: { kind: "ServiceAccount", name: serviceAccount, namespace } });
  } else {
    if (["Secret", "ConfigMap"].includes(row.kind)) {
      if (row.kind === "Secret") properties.push({ label: "Type", value: string(detailValueAt(source, "type") || row.data.type) });
      if (detailValueAt(source, "immutable") === true) properties.push({ label: "Immutable", value: "Yes" });
    }
    if (row.backend?.createdAt) properties.push({ label: "Created", value: new Date(row.backend.createdAt).toLocaleString() });
  }
  return properties.filter((entry) => entry.value && entry.value !== "—");
}

export function getResourceLabels(row?: ResourceRow): Record<string, string> {
  if (!row) return {};
  const values = object(detailValueAt(row.backend?.object, "metadata.labels"));
  if (row.backend) return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, compact(value, 180)]));
  if (Object.keys(values).length) return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, compact(value, 180)]));
  const fallback = labelsFromString(row.data.labels);
  return Object.keys(fallback).length ? fallback : { app: row.name };
}

export function getResourceAnnotations(row?: ResourceRow): Record<string, string> {
  if (!row?.backend) return {};
  // This client-side apply payload can be megabytes long and is useful only in
  // the manifest editor; keeping it out of the Sheet preserves operational signal.
  const omitted = new Set(["kubectl.kubernetes.io/last-applied-configuration"]);
  return Object.fromEntries(Object.entries(object(detailValueAt(row.backend.object, "metadata.annotations")))
    .filter(([key]) => !omitted.has(key))
    .map(([key, value]) => [key, compact(value, 480)]));
}
