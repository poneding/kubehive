import { describe, expect, it } from "vitest";
import {
  buildResourceDetailSections,
  environmentFor,
  getResourceProperties,
  getContainerDetailSection,
  volumeSources,
} from "../src/resource-details";
import type { ResourceRow } from "../src/resource-catalog";

type BackendObject = {
  metadata: { name: string; namespace?: string; ownerReferences?: unknown[] };
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
};

function row(kind: string, object: BackendObject, data: Record<string, string | number> = {}): ResourceRow {
  return {
    key: `${object.metadata.namespace ?? ""}/${object.metadata.name}`,
    name: object.metadata.name,
    namespace: object.metadata.namespace ?? "—",
    kind,
    status: "Running",
    data,
    backend: {
      key: `${object.metadata.namespace ?? ""}/${object.metadata.name}`,
      name: object.metadata.name,
      namespace: object.metadata.namespace ?? "—",
      apiVersion: "v1",
      kind,
      object: object as unknown as Record<string, unknown>,
    },
  };
}

describe("resource detail environment and volumes", () => {
  it("keeps secret values out of environment details", () => {
    const variables = environmentFor({
      env: [
        { name: "PASSWORD", value: "visible-secret" },
        { name: "FROM_SECRET", valueFrom: { secretKeyRef: { name: "app-secrets", key: "password" } } },
      ],
      envFrom: [{ secretRef: { name: "all-secrets" }, prefix: "APP_" }],
    }, "default");

    expect(variables[0]).toMatchObject({ name: "PASSWORD", sensitive: true });
    expect(variables[0].value).not.toContain("visible-secret");
    expect(variables[1]).toMatchObject({ value: "Secret/app-secrets:password", sensitive: true });
    expect(variables[2]).toMatchObject({ value: "All keys from Secret/all-secrets", sensitive: true });
  });

  it("resolves volume source links without losing unknown volumes", () => {
    const sources = volumeSources({
      volumes: [
        { name: "config", configMap: { name: "settings" } },
        { name: "secret", secret: { secretName: "credentials" } },
        { name: "claim", persistentVolumeClaim: { claimName: "data" } },
        { name: "empty", emptyDir: {} },
        { name: "unknown" },
      ],
    }, "default");

    expect(sources.get("config")).toMatchObject({ sourceType: "ConfigMap", sourceName: "settings" });
    expect(sources.get("secret")).toMatchObject({ sourceType: "Secret", sourceName: "credentials" });
    expect(sources.get("claim")).toMatchObject({ sourceType: "PVC", sourceName: "data" });
    expect(sources.get("empty")).toMatchObject({ sourceType: "EmptyDir" });
    expect(sources.get("unknown")).toMatchObject({ sourceType: "Volume" });
  });
});

describe("resource detail builders", () => {
  it("dispatches deployment sections and filters empty fields", () => {
    const deployment = row("Deployment", {
      metadata: { name: "web", namespace: "default" },
      spec: {
        replicas: 3,
        selector: { matchLabels: { app: "web" } },
        template: { spec: { serviceAccountName: "web", containers: [{ name: "web", image: "nginx" }] } },
      },
      status: { readyReplicas: 2, updatedReplicas: 3 },
    });

    const sections = buildResourceDetailSections(deployment);
    expect(sections.map((section) => section.id)).toEqual(["rollout", "strategy", "template"]);
    expect(sections.flatMap((section) => section.fields).some((field) => field.value === "—")).toBe(false);
  });

  it("builds container details from pod templates and status", () => {
    const pod = row("Pod", {
      metadata: { name: "web-0", namespace: "default" },
      spec: {
        containers: [{
          name: "web",
          image: "nginx:latest",
          env: [{ name: "MODE", value: "prod" }],
          volumeMounts: [{ name: "config", mountPath: "/etc/app" }],
        }],
        volumes: [{ name: "config", configMap: { name: "app-config" } }],
      },
      status: {
        phase: "Running",
        containerStatuses: [{ name: "web", ready: true, restartCount: 0, state: { running: { startedAt: "2024-01-01T00:00:00Z" } } }],
      },
    });

    const details = getContainerDetailSection(pod);
    expect(details?.containers[0]).toMatchObject({ name: "web", state: "Running", ready: true });
    expect(details?.containers[0].mounts[0]).toMatchObject({ sourceType: "ConfigMap", sourceName: "app-config" });
  });
});

describe("resource properties", () => {
  it("extracts pod identity and controller links", () => {
    const pod = row("Pod", {
      metadata: {
        name: "web-0",
        namespace: "default",
        ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "web-abc", controller: true }],
      },
      spec: { nodeName: "worker-1", serviceAccountName: "web" },
      status: { podIP: "10.0.0.5" },
    });

    expect(getResourceProperties(pod)).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Pod IP", value: "10.0.0.5" }),
      expect.objectContaining({ label: "Controlled by", value: "ReplicaSet/web-abc" }),
      expect.objectContaining({ label: "Node", value: "worker-1" }),
    ]));
  });
});

describe("resource kind section coverage", () => {
  function sectionsFor(kind: string, spec: Record<string, unknown>, status: Record<string, unknown> = {}) {
    const source = { metadata: { name: kind.toLowerCase(), namespace: "default" }, spec, status };
    return buildResourceDetailSections({
      key: `default/${kind.toLowerCase()}`,
      name: kind.toLowerCase(),
      namespace: "default",
      kind,
      status: "Running",
      data: {},
      backend: { key: `default/${kind.toLowerCase()}`, name: kind.toLowerCase(), namespace: "default", apiVersion: "v1", kind, object: source },
    });
  }

  it("renders service ports and selector", () => {
    const sections = sectionsFor("Service", {
      type: "ClusterIP",
      clusterIP: "10.96.0.1",
      selector: { app: "web" },
      ports: [{ name: "http", port: 80, targetPort: 8080, protocol: "TCP" }],
    });
    const fields = sections.flatMap((section) => section.fields);
    expect(sections.map((section) => section.id)).toEqual(["network", "routing"]);
    expect(fields.some((entry) => entry.label === "Ports" && entry.value.includes("80/TCP"))).toBe(true);
    expect(fields.some((entry) => entry.label === "Selector" && entry.value === "app=web")).toBe(true);
  });

  it("renders storage class parameters", () => {
    const source = { metadata: { name: "standard" }, provisioner: "ebs.csi.aws.com", reclaimPolicy: "Delete", volumeBindingMode: "WaitForFirstConsumer", allowVolumeExpansion: true, mountOptions: ["debug"], parameters: { type: "gp3" } };
    const sections = buildResourceDetailSections({
      key: "standard",
      name: "standard",
      namespace: "—",
      kind: "StorageClass",
      status: "Available",
      data: {},
      backend: { key: "standard", name: "standard", namespace: "—", apiVersion: "storage.k8s.io/v1", kind: "StorageClass", object: source },
    });
    const fields = sections.flatMap((section) => section.fields);
    expect(fields.some((entry) => entry.label === "Provisioner" && entry.value === "ebs.csi.aws.com")).toBe(true);
    expect(fields.some((entry) => entry.label === "Parameters" && entry.value.includes("type: gp3"))).toBe(true);
  });

  it("renders quota hard limits and usage", () => {
    const fields = sectionsFor("ResourceQuota", { hard: { "requests.cpu": "4" }, scopes: ["BestEffort"] }, { hard: { "requests.cpu": "4" }, used: { "requests.cpu": "1" } }).flatMap((section) => section.fields);
    expect(fields.some((entry) => entry.label === "Hard limits" && entry.value.includes("requests.cpu: 4"))).toBe(true);
    expect(fields.some((entry) => entry.label === "Current usage" && entry.value.includes("requests.cpu: 1"))).toBe(true);
  });

  it("renders cronjob schedule and template", () => {
    const fields = sectionsFor("CronJob", {
      schedule: "*/5 * * * *",
      suspend: false,
      jobTemplate: { spec: { completions: 1, template: { spec: { restartPolicy: "Never", containers: [{ name: "job", image: "busybox" }] } } } },
    }, { lastScheduleTime: "2024-01-01T00:00:00Z", active: [{}] }).flatMap((section) => section.fields);
    expect(fields.some((entry) => entry.label === "Schedule" && entry.value === "*/5 * * * *")).toBe(true);
    expect(fields.some((entry) => entry.label === "Completions" && entry.value === "1")).toBe(true);
  });

  it("falls back to a generic operational summary for custom kinds", () => {
    const sections = sectionsFor("Widget", { size: 3 }, { phase: "Ready" });
    expect(sections).toHaveLength(1);
    expect(sections[0].id).toBe("summary");
    expect(sections[0].fields.some((entry) => entry.label === "Spec fields" && entry.value.includes("size"))).toBe(true);
  });
});
