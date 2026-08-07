/**
 * Canonical status → tone mapping for the whole UI: resource table status
 * cells (Badge + StatusDot), detail panels, cluster health. Order matters —
 * more specific failure states are checked before the keywords they contain
 * ("NotReady" beats "ready", "Unavailable" beats "available").
 */

export type StatusTone = "green" | "amber" | "red" | "neutral";

export function statusTone(status?: string): StatusTone {
  const normalized = (status ?? "").toLowerCase().replace(/\s+/g, "");
  if (/(failed|error|crash|notready|unavail|lost|evicted|unreachable|rejected|expired|oom|imagepull|errimage|deadline|missing|invalid|false)/.test(normalized)) return "red";
  if (/(pending|waiting|warning|degraded|outofsync|issuing|suspended|progressing|reconciling|unknown|terminat|containercreating|initializ|schedulingdisabled)/.test(normalized)) return "amber";
  if (/(running|ready|healthy|synced|active|bound|available|deployed|complete|succeeded|normal|true|passed)/.test(normalized)) return "green";
  return "neutral";
}

/** Class for .status-dot, mirroring the badge tone (plus the offline state). */
export function statusDotClass(status: string): "ok" | "warn" | "err" | "off" | undefined {
  if (status.toLowerCase().replace(/\s+/g, "") === "offline") return "off";
  const tone = statusTone(status);
  return tone === "green" ? "ok" : tone === "amber" ? "warn" : tone === "red" ? "err" : undefined;
}
