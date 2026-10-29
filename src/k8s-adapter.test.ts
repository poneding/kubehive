import { describe, expect, it } from "vitest";
import type { ApiResourceDescriptor, BackendResourceRecord } from "./backend";
import {
  formatCpuQuantity,
  formatKubernetesCpuQuantity,
  formatKubernetesMemoryQuantity,
  formatMemoryQuantity,
  rowFromBackend,
} from "./k8s-adapter";

describe("Kubernetes quantity formatting", () => {
  it("formats node capacity in readable CPU and memory units", () => {
    const descriptor: ApiResourceDescriptor = {
      apiVersion: "v1",
      group: "",
      version: "v1",
      kind: "Node",
      plural: "nodes",
      namespaced: false,
      verbs: ["get", "list"],
      categories: [],
    };
    const record: BackendResourceRecord = {
      key: "node-a",
      name: "node-a",
      namespace: "—",
      apiVersion: "v1",
      kind: "Node",
      object: {
        metadata: { name: "node-a" },
        status: {
          capacity: { cpu: "63800m", memory: "522445740Ki" },
          allocatable: { pods: "110" },
          nodeInfo: { kubeletVersion: "v1.30.4" },
        },
      },
    };

    const row = rowFromBackend(record, descriptor);

    expect(row.data.cpu).toBe("63.8");
    expect(row.data.memory).toBe("498.2Gi");
  });

  it("normalizes decimal and binary memory quantities", () => {
    expect(formatKubernetesMemoryQuantity("1024Mi")).toBe("1Gi");
    expect(formatKubernetesMemoryQuantity("1.5Gi")).toBe("1.5Gi");
    expect(formatKubernetesMemoryQuantity("500M")).toBe("476.8Mi");
    expect(formatKubernetesMemoryQuantity("1e9")).toBe("953.7Mi");
    expect(formatKubernetesMemoryQuantity("not-a-quantity")).toBe("not-a-quantity");
  });

  it("uses cores for whole and fractional CPU values above one core", () => {
    expect(formatCpuQuantity(500)).toBe("500m");
    expect(formatCpuQuantity(1000)).toBe("1");
    expect(formatCpuQuantity(1250)).toBe("1.25");
    expect(formatKubernetesCpuQuantity("63800m")).toBe("63.8");
    expect(formatKubernetesCpuQuantity("0.5")).toBe("500m");
  });

  it("keeps the existing invalid byte behavior", () => {
    expect(formatMemoryQuantity(Number.NaN)).toBe("—");
    expect(formatMemoryQuantity(-1)).toBe("—");
  });
});
