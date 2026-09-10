import type { ResourceRow } from "../resource-catalog";
import type { DetailField, ResourceDetailSection } from "./types";

export const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const string = (value: unknown): string => value === undefined || value === null ? "" : String(value);

export function detailValueAt(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) return current[Number(part)];
    if (typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[part];
  }, value);
}

export function compact(value: unknown, maxLength = 360): string {
  if (value === undefined || value === null || value === "") return "—";
  let result: string;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") result = String(value);
  else if (Array.isArray(value)) result = value.length ? value.map((entry) => compact(entry, 120)).join(", ") : "—";
  else {
    const entries = Object.entries(object(value));
    result = entries.length ? entries.map(([key, entry]) => `${key}: ${compact(entry, 100)}`).join(", ") : "—";
  }
  return result.length > maxLength ? `${result.slice(0, Math.max(0, maxLength - 1))}…` : result;
}

export function compactObject(value: unknown, maxItems = 8): string {
  const entries = Object.entries(object(value));
  if (!entries.length) return "—";
  const preview = entries.slice(0, maxItems).map(([key, entry]) => `${key}: ${compact(entry, 72)}`);
  return `${preview.join(" · ")}${entries.length > maxItems ? ` · +${entries.length - maxItems} more` : ""}`;
}

export function names(value: unknown, maxItems = 8): string {
  const values = array(value).map((entry) => compact(entry, 100)).filter((entry) => entry !== "—");
  if (!values.length) return "—";
  return `${values.slice(0, maxItems).join(", ")}${values.length > maxItems ? ` +${values.length - maxItems} more` : ""}`;
}

export function field(label: string, value: unknown, options: Partial<DetailField> = {}): DetailField {
  return { label, value: compact(value), ...options };
}

export function section(id: string, title: string, fields: DetailField[], description?: string): ResourceDetailSection {
  return { id, title, description, fields: fields.filter((entry) => entry.value !== "—") };
}

export function nonEmpty(sections: ResourceDetailSection[]): ResourceDetailSection[] {
  return sections.filter((entry) => entry.fields.length > 0);
}

export function sourceFor(row: ResourceRow) {
  return row.backend?.object ?? {};
}

export function dataOr(row: ResourceRow, path: string, dataKey?: string) {
  return detailValueAt(sourceFor(row), path) ?? row.data[dataKey ?? path.split(".").at(-1) ?? path];
}

export function selector(value: unknown): string {
  const source = object(value);
  const matchLabels = object(source.matchLabels);
  const labels = Object.entries(Object.keys(matchLabels).length ? matchLabels : source)
    .filter(([key]) => key !== "matchExpressions")
    .map(([key, entry]) => `${key}=${compact(entry, 80)}`);
  const expressions = array(source.matchExpressions).map((entry) => {
    const key = compact(detailValueAt(entry, "key"), 80);
    const operator = compact(detailValueAt(entry, "operator"), 30);
    const values = names(detailValueAt(entry, "values"), 5);
    if (key === "—" || operator === "—") return "";
    if (operator === "Exists") return key;
    if (operator === "DoesNotExist") return `!${key}`;
    return values === "—" ? `${key} ${operator}` : `${key} ${operator} (${values})`;
  }).filter(Boolean);
  const all = [...labels, ...expressions];
  return all.length ? all.join(", ") : "—";
}

export function ports(value: unknown): string {
  const values = array(value).map((entry) => {
    const source = object(entry);
    const port = source.port ?? source.containerPort ?? source.targetPort;
    if (port === undefined || port === null || port === "") return "";
    const name = source.name ? `${compact(source.name, 50)} · ` : "";
    const target = source.targetPort !== undefined && source.port !== undefined ? ` → ${compact(source.targetPort, 50)}` : "";
    const nodePort = source.nodePort !== undefined ? ` (node ${compact(source.nodePort, 50)})` : "";
    return `${name}${compact(port, 50)}/${compact(source.protocol ?? "TCP", 20)}${target}${nodePort}`;
  }).filter(Boolean);
  return values.length ? values.join(", ") : "—";
}

export function tolerations(value: unknown): string {
  const values = array(value).map((entry) => {
    const source = object(entry);
    const key = string(source.key);
    const operator = string(source.operator || "Equal");
    const val = string(source.value);
    const effect = string(source.effect);
    const seconds = source.tolerationSeconds === undefined ? "" : ` for ${compact(source.tolerationSeconds, 30)}s`;
    const match = !key ? "all taints" : operator === "Exists" ? key : `${key}=${val}`;
    return `${match}${effect ? ` (${effect})` : ""}${seconds}`;
  }).filter(Boolean);
  return values.length ? `${values.slice(0, 5).join(" · ")}${values.length > 5 ? ` · +${values.length - 5} more` : ""}` : "—";
}

export function resourceQuantities(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return compact(value);
  const entries = Object.entries(object(value));
  if (!entries.length) return "—";
  return entries.slice(0, 8).map(([key, entry]) => `${key}: ${compact(entry, 60)}`).join(" · ") + (entries.length > 8 ? ` · +${entries.length - 8} more` : "");
}

export function resourceQuantityValues(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(object(value)).slice(0, 8).map(([key, entry]) => [key, compact(entry, 60)]));
}
