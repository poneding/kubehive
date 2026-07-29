import { parseAllDocuments, stringify } from "yaml";

export type ManifestFormat = "yaml" | "json";

export type ManifestDiagnostic = {
  from: number;
  to: number;
  severity: "warning" | "error";
  message: string;
};

export type ManifestValidation = {
  diagnostics: ManifestDiagnostic[];
  value?: unknown;
};

const diagnosticRange = (source: string, from = 0, to = from + 1) => ({
  from: Math.max(0, Math.min(source.length, from)),
  to: Math.max(0, Math.min(source.length, Math.max(from + 1, to))),
});

const diagnostic = (source: string, message: string, from = 0, to = from + 1): ManifestDiagnostic => ({
  ...diagnosticRange(source, from, to),
  severity: "error",
  message,
});

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function jsonErrorPosition(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const match = /position\s+(\d+)/i.exec(message);
  return { message, position: match ? Number(match[1]) : 0 };
}

function parseJson(source: string): ManifestValidation {
  try {
    return { diagnostics: [], value: JSON.parse(source) as unknown };
  } catch (error) {
    const { message, position } = jsonErrorPosition(error);
    return { diagnostics: [diagnostic(source, `Invalid JSON: ${message}`, position)] };
  }
}

function parseYaml(source: string): ManifestValidation {
  const documents = parseAllDocuments(source, {
    prettyErrors: true,
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
    version: "1.2",
  });
  if (documents.length !== 1) {
    return { diagnostics: [diagnostic(source, documents.length === 0 ? "YAML manifest is empty" : "YAML must contain exactly one document")] };
  }
  const document = documents[0];
  const errors = document.errors.map((error) => ({
    ...diagnosticRange(source, error.pos[0], error.pos[1]),
    severity: "error" as const,
    message: `Invalid YAML: ${error.message}`,
  }));
  if (errors.length > 0) return { diagnostics: errors };
  try {
    const value = document.toJS({ maxAliasCount: 100 }) as unknown;
    const warnings = document.warnings.map((warning) => ({
      ...diagnosticRange(source, warning.pos[0], warning.pos[1]),
      severity: "warning" as const,
      message: warning.message,
    }));
    return { diagnostics: warnings, value };
  } catch (error) {
    return { diagnostics: [diagnostic(source, `Invalid YAML: ${error instanceof Error ? error.message : String(error)}`)] };
  }
}

function fieldPosition(source: string, field: string) {
  const position = source.search(new RegExp(`(^|[\\s,{])${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:=]`, "m"));
  return position < 0 ? 0 : position;
}

export function validateManifestText(source: string, format: ManifestFormat): ManifestValidation {
  if (!source.trim()) return { diagnostics: [diagnostic(source, `${format.toUpperCase()} manifest is empty`)] };
  const parsed = format === "json" ? parseJson(source) : parseYaml(source);
  if (parsed.diagnostics.some((entry) => entry.severity === "error")) return parsed;
  if (!isObject(parsed.value)) {
    return { diagnostics: [...parsed.diagnostics, diagnostic(source, "Manifest root must be an object")] };
  }

  const metadata = parsed.value.metadata;
  const required: Array<{ valid: boolean; message: string; field: string }> = [
    { valid: typeof parsed.value.apiVersion === "string" && parsed.value.apiVersion.trim().length > 0, message: "Manifest is missing apiVersion", field: "apiVersion" },
    { valid: typeof parsed.value.kind === "string" && parsed.value.kind.trim().length > 0, message: "Manifest is missing kind", field: "kind" },
    { valid: isObject(metadata) && typeof metadata.name === "string" && metadata.name.trim().length > 0, message: "Manifest is missing metadata.name", field: "metadata" },
  ];
  const diagnostics = [...parsed.diagnostics];
  for (const entry of required) {
    if (!entry.valid) diagnostics.push(diagnostic(source, entry.message, fieldPosition(source, entry.field)));
  }
  return { diagnostics, value: parsed.value };
}

export function manifestHasErrors(validation: ManifestValidation) {
  return validation.diagnostics.some((entry) => entry.severity === "error");
}

export function firstManifestError(validation: ManifestValidation) {
  return validation.diagnostics.find((entry) => entry.severity === "error");
}

export function convertManifest(source: string, from: ManifestFormat, to: ManifestFormat) {
  const validation = validateManifestText(source, from);
  const error = firstManifestError(validation);
  if (error || !isObject(validation.value)) throw new Error(error?.message ?? `Unable to parse ${from.toUpperCase()} manifest`);
  if (from === to) return source;
  return to === "json"
    ? `${JSON.stringify(validation.value, null, 2)}\n`
    : stringify(validation.value, { indent: 2, lineWidth: 0 });
}
