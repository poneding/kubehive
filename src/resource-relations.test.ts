import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResourceDescriptor, BackendResourceRecord } from "./backend";

/**
 * Relation lookups reach the cluster through the backend module only.  The mock
 * keeps every response deterministic so the endpoint target rules can be asserted
 * directly instead of through the UI.
 */
const fixtures = vi.hoisted(() => ({ records: new Map<string, unknown>() }));

vi.mock("./backend", () => ({
  nativeBackendAvailable: true,
  descriptorForResource: (name: string, discovered: ApiResourceDescriptor[]) => discovered.find((entry) => entry.plural === name) ?? null,
  backend: {
    listResources: async ({ resource }: { resource: ApiResourceDescriptor }) => ({
      resourceVersion: "1",
      items: [...fixtures.records.values()].filter((record) => (record as BackendResourceRecord).kind === resource.kind),
    }),
    getResource: async ({ resource, name }: { resource: ApiResourceDescriptor; name: string }) => fixtures.records.get(`${resource.kind}/${name}`) ?? null,
  },
}));

import { rowFromBackend } from "./k8s-adapter";
import { resolveResourceRelations } from "./resource-relations";

const descriptors: ApiResourceDescriptor[] = [
  { apiVersion: "v1", group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true, verbs: ["get", "list"], categories: [] },
  { apiVersion: "v1", group: "", version: "v1", kind: "Service", plural: "services", namespaced: true, verbs: ["get", "list"], categories: [] },
  { apiVersion: "v1", group: "", version: "v1", kind: "Endpoints", plural: "endpoints", namespaced: true, verbs: ["get", "list"], categories: [] },
  { apiVersion: "discovery.k8s.io/v1", group: "discovery.k8s.io", version: "v1", kind: "EndpointSlice", plural: "endpointslices", namespaced: true, verbs: ["get", "list"], categories: [] },
  { apiVersion: "wutong.io/v1alpha1", group: "wutong.io", version: "v1alpha1", kind: "ThirdComponent", plural: "thirdcomponents", namespaced: true, verbs: ["get", "list"], categories: [] },
];

const COMPONENT = "3846df0fa53184a6bb79c1a6daf54135";
const SERVICE = "wutong-devops-sonarqube-3165-80out";

function record(kind: string, name: string, object: Record<string, unknown>, namespace = "paas"): BackendResourceRecord {
  const descriptor = descriptors.find((entry) => entry.kind === kind);
  return { key: `${namespace}/${name}`, name, namespace, apiVersion: descriptor?.apiVersion ?? "v1", kind, object };
}

function descriptorFor(kind: string) {
  return descriptors.find((entry) => entry.kind === kind)!;
}

function seed(record: BackendResourceRecord) {
  fixtures.records.set(`${record.kind}/${record.name}`, record);
}

function seedBase() {
  seed(record("Service", SERVICE, { metadata: { name: SERVICE, namespace: "paas" }, spec: { ports: [{ name: "tcp-80", port: 80, targetPort: 80, protocol: "TCP" }] } }));
  seed(record("Pod", "sonarqube-sonarqube-0", { metadata: { name: "sonarqube-sonarqube-0", namespace: "paas", labels: { app: "sonarqube" } }, spec: { containers: [{ name: "sonarqube", ports: [{ name: "http", containerPort: 9000, protocol: "TCP" }] }] }, status: { phase: "Running", podIP: "10.244.7.186" } }));
  seed(record("ThirdComponent", COMPONENT, { metadata: { name: COMPONENT, namespace: "paas" }, spec: { endpointSource: { kubernetesService: { namespace: "paas", name: "sonarqube-sonarqube" } } } }));
}

async function relationsFor(row: ReturnType<typeof rowFromBackend>) {
  return resolveResourceRelations("cluster", row, descriptors);
}

function targetsOf(groups: Awaited<ReturnType<typeof relationsFor>>, id: string) {
  return groups.find((group) => group.id === id)?.items.map((item) => `${item.kind}/${item.name}`);
}

beforeEach(() => {
  fixtures.records.clear();
  seedBase();
});

describe("endpoint target relations", () => {
  it("follows a non-Pod target reference instead of matching an endpoint address to a Pod IP", async () => {
    const endpoints = record("Endpoints", SERVICE, {
      metadata: { name: SERVICE, namespace: "paas" },
      subsets: [{ addresses: [{ ip: "10.244.7.186", targetRef: { apiVersion: "wutong.io/v1alpha1", kind: "ThirdComponent", name: COMPONENT, namespace: "paas" } }], ports: [{ name: "tcp-80", port: 9000, protocol: "TCP" }] }],
    });
    seed(endpoints);

    const groups = await relationsFor(rowFromBackend(endpoints, descriptorFor("Endpoints")));

    expect(targetsOf(groups, "pods")).toBeUndefined();
    expect(targetsOf(groups, "targets")).toEqual([`ThirdComponent/${COMPONENT}`]);
  });

  it("resolves an EndpointSlice target reference the same way", async () => {
    const slice = record("EndpointSlice", `${SERVICE}-nc77l`, {
      metadata: { name: `${SERVICE}-nc77l`, namespace: "paas", labels: { "kubernetes.io/service-name": SERVICE } },
      addressType: "IPv4",
      endpoints: [{ addresses: ["10.244.7.186"], conditions: { ready: true }, targetRef: { apiVersion: "wutong.io/v1alpha1", kind: "ThirdComponent", name: COMPONENT, namespace: "paas" } }],
      ports: [{ name: "tcp-80", port: 9000, protocol: "TCP" }],
    });
    seed(slice);

    const groups = await relationsFor(rowFromBackend(slice, descriptorFor("EndpointSlice")));

    expect(targetsOf(groups, "pods")).toBeUndefined();
    expect(targetsOf(groups, "targets")).toEqual([`ThirdComponent/${COMPONENT}`]);
  });

  it("links the Pod an endpoint target reference names", async () => {
    const endpoints = record("Endpoints", "sonarqube-sonarqube", {
      metadata: { name: "sonarqube-sonarqube", namespace: "paas" },
      subsets: [{ addresses: [{ ip: "10.244.7.186", targetRef: { kind: "Pod", name: "sonarqube-sonarqube-0", namespace: "paas" } }], ports: [{ name: "http", port: 9000, protocol: "TCP" }] }],
    });
    seed(endpoints);

    const groups = await relationsFor(rowFromBackend(endpoints, descriptorFor("Endpoints")));

    expect(targetsOf(groups, "pods")).toEqual(["Pod/sonarqube-sonarqube-0"]);
    expect(targetsOf(groups, "targets")).toBeUndefined();
  });
});
