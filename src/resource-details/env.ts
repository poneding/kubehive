import type { ContainerEnvironment, ContainerMount, ContainerPort } from "./types";
import { array, compact, object, string } from "./value";

export function sensitiveEnvironmentName(name: string) {
  return /(password|passwd|secret|token|credential|private[_-]?key|api[_-]?key)/i.test(name);
}

export function environmentFor(container: Record<string, unknown>, namespace?: string): ContainerEnvironment[] {
  const variables: ContainerEnvironment[] = [];
  for (const envValue of array(container.env)) {
    const env = object(envValue);
    const name = string(env.name);
    if (!name) continue;
    const valueFrom = object(env.valueFrom);
    const secret = object(valueFrom.secretKeyRef);
    const configMap = object(valueFrom.configMapKeyRef);
    const fieldRef = object(valueFrom.fieldRef);
    const resourceFieldRef = object(valueFrom.resourceFieldRef);
    if (string(secret.name)) variables.push({ name, value: `Secret/${string(secret.name)}:${string(secret.key) || "*"}`, source: "secret", sensitive: true, link: { kind: "Secret", name: string(secret.name), namespace } });
    else if (string(configMap.name)) variables.push({ name, value: `ConfigMap/${string(configMap.name)}:${string(configMap.key) || "*"}`, source: "configMap", link: { kind: "ConfigMap", name: string(configMap.name), namespace } });
    else if (string(fieldRef.fieldPath)) variables.push({ name, value: `Field: ${string(fieldRef.fieldPath)}`, source: "field" });
    else if (string(resourceFieldRef.resource)) variables.push({ name, value: `Resource: ${string(resourceFieldRef.resource)}`, source: "resourceField" });
    else {
      const literal = string(env.value);
      variables.push({ name, value: sensitiveEnvironmentName(name) ? "••••••••" : compact(literal || "(empty)", 180), source: "literal", sensitive: sensitiveEnvironmentName(name) });
    }
  }
  for (const envFromValue of array(container.envFrom)) {
    const envFrom = object(envFromValue);
    const configMap = object(envFrom.configMapRef);
    const secret = object(envFrom.secretRef);
    const prefix = string(envFrom.prefix);
    if (string(configMap.name)) variables.push({ name: `${prefix || ""}*`, value: `All keys from ConfigMap/${string(configMap.name)}`, source: "envFrom", link: { kind: "ConfigMap", name: string(configMap.name), namespace } });
    if (string(secret.name)) variables.push({ name: `${prefix || ""}*`, value: `All keys from Secret/${string(secret.name)}`, source: "envFrom", sensitive: true, link: { kind: "Secret", name: string(secret.name), namespace } });
  }
  return variables;
}

export function portsFor(container: Record<string, unknown>): ContainerPort[] {
  return array(container.ports).map((entry) => {
    const port = object(entry);
    const number = string(port.containerPort || port.hostPort);
    if (!number) return null;
    const name = string(port.name);
    const hostPort = string(port.hostPort);
    return { port: number, protocol: string(port.protocol || "TCP"), ...(name ? { name } : {}), ...(hostPort ? { hostPort } : {}) };
  }).filter((entry): entry is ContainerPort => Boolean(entry));
}

export function volumeSources(spec: Record<string, unknown>, namespace?: string) {
  const sources = new Map<string, Omit<ContainerMount, "path" | "readOnly" | "subPath">>();
  for (const entry of array(spec.volumes)) {
    const volume = object(entry);
    const name = string(volume.name);
    if (!name) continue;
    const configMap = object(volume.configMap);
    const secret = object(volume.secret);
    const claim = object(volume.persistentVolumeClaim);
    const projected = object(volume.projected);
    const hostPath = object(volume.hostPath);
    const emptyDir = object(volume.emptyDir);
    if (string(configMap.name)) sources.set(name, { name, sourceName: string(configMap.name), sourceType: "ConfigMap", link: { kind: "ConfigMap", name: string(configMap.name), namespace } });
    else if (string(secret.secretName)) sources.set(name, { name, sourceName: string(secret.secretName), sourceType: "Secret", link: { kind: "Secret", name: string(secret.secretName), namespace } });
    else if (string(claim.claimName)) sources.set(name, { name, sourceName: string(claim.claimName), sourceType: "PVC", link: { kind: "PersistentVolumeClaim", name: string(claim.claimName), namespace } });
    else if (Object.keys(projected).length) sources.set(name, { name, sourceName: name, sourceType: "Projected" });
    else if (Object.keys(hostPath).length) sources.set(name, { name, sourceName: string(hostPath.path) || name, sourceType: "HostPath" });
    else if (Object.keys(emptyDir).length || "emptyDir" in volume) sources.set(name, { name, sourceName: name, sourceType: "EmptyDir" });
    else sources.set(name, { name, sourceName: name, sourceType: "Volume" });
  }
  return sources;
}

export function mountsFor(container: Record<string, unknown>, sources: Map<string, Omit<ContainerMount, "path" | "readOnly" | "subPath">>): ContainerMount[] {
  return array(container.volumeMounts).map((entry) => {
    const mount = object(entry);
    const name = string(mount.name);
    const path = string(mount.mountPath);
    if (!name || !path) return null;
    const source = sources.get(name) ?? { name, sourceName: name, sourceType: "Volume" };
    const subPath = string(mount.subPath);
    return { ...source, path, readOnly: mount.readOnly === true, ...(subPath ? { subPath } : {}) };
  }).filter((entry): entry is ContainerMount => Boolean(entry));
}

export function commandFor(container: Record<string, unknown>, key: "command" | "args") {
  const values = array(container[key]).map((entry) => string(entry)).filter(Boolean);
  return values.length ? values.join(" ") : undefined;
}
