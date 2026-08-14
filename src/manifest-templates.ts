import { stringify } from "yaml";
import type { ApiResourceDescriptor } from "./backend";

/**
 * Starting-point manifests for the create session.
 *
 * Each builder returns a manifest that is complete enough to apply as-is and to
 * show the shape of the kind: selectors that match their own pod labels, probes,
 * resource requests, and the required-but-easy-to-forget fields such as a
 * StatefulSet's serviceName or a webhook's admissionReviewVersions. Bodies are
 * emitted through the same yaml serializer the editor uses for format switching,
 * so a template survives a YAML to JSON round trip unchanged.
 */

type ManifestBody = Record<string, unknown>;

type TemplateContext = {
  /** metadata.name placeholder, "new-<kind>" unless a kind overrides it. */
  name: string;
  /** Empty for cluster-scoped kinds. */
  namespace: string;
  apiVersion: string;
  kind: string;
};

type TemplateBuilder = (context: TemplateContext) => ManifestBody;

const NAME_LABEL = "app.kubernetes.io/name";

const base = (context: TemplateContext, metadata: ManifestBody = {}): ManifestBody => ({
  apiVersion: context.apiVersion,
  kind: context.kind,
  metadata: {
    name: context.name,
    ...(context.namespace ? { namespace: context.namespace } : {}),
    ...metadata,
  },
});

const selectorLabels = (context: TemplateContext) => ({ [NAME_LABEL]: context.name });

/** A long-running HTTP container: ports, probes and resource bounds all set. */
const webContainer = () => ({
  name: "app",
  image: "nginx:1.27-alpine",
  imagePullPolicy: "IfNotPresent",
  ports: [{ name: "http", containerPort: 80, protocol: "TCP" }],
  resources: {
    requests: { cpu: "50m", memory: "64Mi" },
    limits: { cpu: "500m", memory: "256Mi" },
  },
  readinessProbe: {
    httpGet: { path: "/", port: "http" },
    initialDelaySeconds: 5,
    periodSeconds: 10,
  },
  livenessProbe: {
    httpGet: { path: "/", port: "http" },
    initialDelaySeconds: 15,
    periodSeconds: 20,
  },
});

/** A run-to-completion container for Job and CronJob templates. */
const taskContainer = () => ({
  name: "task",
  image: "busybox:1.37",
  imagePullPolicy: "IfNotPresent",
  command: ["sh", "-c", "echo \"started at $(date)\" && sleep 5"],
  resources: {
    requests: { cpu: "50m", memory: "32Mi" },
    limits: { cpu: "200m", memory: "128Mi" },
  },
});

const podTemplate = (context: TemplateContext) => ({
  metadata: { labels: selectorLabels(context) },
  spec: {
    terminationGracePeriodSeconds: 30,
    containers: [webContainer()],
  },
});

const taskPodTemplate = (context: TemplateContext) => ({
  metadata: { labels: selectorLabels(context) },
  spec: {
    restartPolicy: "Never",
    containers: [taskContainer()],
  },
});

const webhookBody = (context: TemplateContext, path: string) => ({
  ...base(context),
  webhooks: [{
    name: `${context.kind === "MutatingWebhookConfiguration" ? "mutate" : "validate"}.example.com`,
    admissionReviewVersions: ["v1"],
    sideEffects: "None",
    // Ignore keeps a half-configured webhook from blocking every admission call.
    failurePolicy: "Ignore",
    timeoutSeconds: 10,
    clientConfig: {
      service: { name: "webhook-service", namespace: "default", path, port: 443 },
    },
    rules: [{
      apiGroups: [""],
      apiVersions: ["v1"],
      operations: ["CREATE", "UPDATE"],
      resources: ["pods"],
      scope: "Namespaced",
    }],
  }],
});

const templates: Record<string, TemplateBuilder> = {
  Namespace: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
  }),

  Pod: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
    spec: {
      restartPolicy: "Always",
      terminationGracePeriodSeconds: 30,
      containers: [webContainer()],
    },
  }),

  Deployment: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
    spec: {
      replicas: 2,
      revisionHistoryLimit: 3,
      selector: { matchLabels: selectorLabels(context) },
      strategy: { type: "RollingUpdate", rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
      template: podTemplate(context),
    },
  }),

  DaemonSet: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
    spec: {
      selector: { matchLabels: selectorLabels(context) },
      updateStrategy: { type: "RollingUpdate", rollingUpdate: { maxUnavailable: 1 } },
      template: podTemplate(context),
    },
  }),

  StatefulSet: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
    spec: {
      serviceName: `${context.name}-headless`,
      replicas: 2,
      podManagementPolicy: "OrderedReady",
      selector: { matchLabels: selectorLabels(context) },
      updateStrategy: { type: "RollingUpdate" },
      template: {
        metadata: { labels: selectorLabels(context) },
        spec: {
          terminationGracePeriodSeconds: 30,
          containers: [{
            ...webContainer(),
            volumeMounts: [{ name: "data", mountPath: "/usr/share/nginx/html" }],
          }],
        },
      },
      volumeClaimTemplates: [{
        metadata: { name: "data" },
        spec: {
          accessModes: ["ReadWriteOnce"],
          resources: { requests: { storage: "1Gi" } },
        },
      }],
    },
  }),

  ReplicaSet: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
    spec: {
      replicas: 2,
      selector: { matchLabels: selectorLabels(context) },
      template: podTemplate(context),
    },
  }),

  // The legacy controller selects with a flat label map, not matchLabels.
  ReplicationController: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
    spec: {
      replicas: 2,
      selector: selectorLabels(context),
      template: podTemplate(context),
    },
  }),

  Job: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
    spec: {
      completions: 1,
      parallelism: 1,
      backoffLimit: 4,
      ttlSecondsAfterFinished: 600,
      template: taskPodTemplate(context),
    },
  }),

  CronJob: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
    spec: {
      schedule: "*/5 * * * *",
      timeZone: "Etc/UTC",
      concurrencyPolicy: "Forbid",
      startingDeadlineSeconds: 60,
      successfulJobsHistoryLimit: 3,
      failedJobsHistoryLimit: 1,
      jobTemplate: {
        spec: {
          backoffLimit: 4,
          template: taskPodTemplate(context),
        },
      },
    },
  }),

  Service: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
    spec: {
      type: "ClusterIP",
      selector: selectorLabels(context),
      ports: [{ name: "http", port: 80, targetPort: 80, protocol: "TCP" }],
    },
  }),

  // Endpoints carries its addresses at the top level; there is no spec.
  Endpoints: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
    subsets: [{
      addresses: [{ ip: "10.0.0.10" }],
      ports: [{ name: "http", port: 80, protocol: "TCP" }],
    }],
  }),

  Ingress: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
    spec: {
      ingressClassName: "nginx",
      rules: [{
        host: "example.com",
        http: {
          paths: [{
            path: "/",
            pathType: "Prefix",
            backend: { service: { name: "example-service", port: { number: 80 } } },
          }],
        },
      }],
    },
  }),

  IngressClass: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
    spec: { controller: "k8s.io/ingress-nginx" },
  }),

  NetworkPolicy: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
    spec: {
      podSelector: { matchLabels: selectorLabels(context) },
      policyTypes: ["Ingress", "Egress"],
      ingress: [{
        from: [{ podSelector: { matchLabels: selectorLabels(context) } }],
        ports: [{ protocol: "TCP", port: 80 }],
      }],
      // Keep cluster DNS reachable once an egress policy starts applying.
      egress: [{
        to: [{ namespaceSelector: {} }],
        ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }],
      }],
    },
  }),

  PersistentVolumeClaim: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
    spec: {
      accessModes: ["ReadWriteOnce"],
      volumeMode: "Filesystem",
      resources: { requests: { storage: "1Gi" } },
    },
  }),

  PersistentVolume: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
    spec: {
      capacity: { storage: "1Gi" },
      accessModes: ["ReadWriteOnce"],
      volumeMode: "Filesystem",
      persistentVolumeReclaimPolicy: "Retain",
      storageClassName: "manual",
      hostPath: { path: "/mnt/data", type: "DirectoryOrCreate" },
    },
  }),

  // StorageClass keeps provisioner and policies at the top level.
  StorageClass: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
    provisioner: "kubernetes.io/no-provisioner",
    parameters: {},
    reclaimPolicy: "Delete",
    volumeBindingMode: "WaitForFirstConsumer",
    allowVolumeExpansion: true,
  }),

  ConfigMap: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
    data: {
      "log.level": "info",
      "app.properties": "log.level=info\nserver.port=8080\n",
    },
  }),

  // stringData takes plain text; the API server stores the base64 form.
  Secret: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
    type: "Opaque",
    stringData: {
      username: "admin",
      password: "change-me",
    },
  }),

  ResourceQuota: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
    spec: {
      hard: {
        "requests.cpu": "2",
        "requests.memory": "4Gi",
        "limits.cpu": "4",
        "limits.memory": "8Gi",
        pods: "10",
        persistentvolumeclaims: "5",
      },
    },
  }),

  LimitRange: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
    spec: {
      limits: [{
        type: "Container",
        default: { cpu: "500m", memory: "512Mi" },
        defaultRequest: { cpu: "100m", memory: "128Mi" },
        min: { cpu: "10m", memory: "32Mi" },
        max: { cpu: "2", memory: "2Gi" },
      }],
    },
  }),

  HorizontalPodAutoscaler: (context) => {
    const scaleTargetRef = { apiVersion: "apps/v1", kind: "Deployment", name: "example-deployment" };
    // autoscaling/v1 has no metrics array; it carries a single CPU target.
    if (context.apiVersion === "autoscaling/v1") {
      return {
        ...base(context, { labels: selectorLabels(context) }),
        spec: { scaleTargetRef, minReplicas: 2, maxReplicas: 10, targetCPUUtilizationPercentage: 70 },
      };
    }
    return {
      ...base(context, { labels: selectorLabels(context) }),
      spec: {
        scaleTargetRef,
        minReplicas: 2,
        maxReplicas: 10,
        metrics: [
          { type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 70 } } },
          { type: "Resource", resource: { name: "memory", target: { type: "Utilization", averageUtilization: 80 } } },
        ],
      },
    };
  },

  VerticalPodAutoscaler: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
    spec: {
      targetRef: { apiVersion: "apps/v1", kind: "Deployment", name: "example-deployment" },
      updatePolicy: { updateMode: "Auto" },
      resourcePolicy: {
        containerPolicies: [{
          containerName: "*",
          minAllowed: { cpu: "50m", memory: "64Mi" },
          maxAllowed: { cpu: "2", memory: "2Gi" },
          controlledResources: ["cpu", "memory"],
        }],
      },
    },
  }),

  PodDisruptionBudget: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
    spec: {
      minAvailable: 1,
      selector: { matchLabels: selectorLabels(context) },
      unhealthyPodEvictionPolicy: "IfHealthyBudget",
    },
  }),

  PriorityClass: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
    value: 1000,
    globalDefault: false,
    preemptionPolicy: "PreemptLowerPriority",
    description: "Priority for application workloads",
  }),

  RuntimeClass: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
    handler: "runc",
  }),

  Lease: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
    spec: {
      holderIdentity: `${context.name}-holder`,
      leaseDurationSeconds: 15,
    },
  }),

  MutatingWebhookConfiguration: (context) => webhookBody(context, "/mutate"),
  ValidatingWebhookConfiguration: (context) => webhookBody(context, "/validate"),

  ServiceAccount: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
    automountServiceAccountToken: false,
  }),

  ClusterRole: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
    rules: [{
      apiGroups: [""],
      resources: ["pods", "pods/log"],
      verbs: ["get", "list", "watch"],
    }],
  }),

  Role: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
    rules: [{
      apiGroups: [""],
      resources: ["configmaps", "secrets"],
      verbs: ["get", "list", "watch"],
    }],
  }),

  ClusterRoleBinding: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
    roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "view" },
    subjects: [{ kind: "ServiceAccount", name: "default", namespace: "default" }],
  }),

  RoleBinding: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
    roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: "example-role" },
    subjects: [{ kind: "ServiceAccount", name: "default", namespace: context.namespace || "default" }],
  }),

  // Removed from Kubernetes in 1.25, so modern clusters never enable the button.
  // Old clusters get the canonical restricted policy rather than an empty spec.
  PodSecurityPolicy: (context) => ({
    ...base(context, { labels: selectorLabels(context) }),
    spec: {
      privileged: false,
      allowPrivilegeEscalation: false,
      requiredDropCapabilities: ["ALL"],
      hostNetwork: false,
      hostIPC: false,
      hostPID: false,
      readOnlyRootFilesystem: false,
      volumes: ["configMap", "emptyDir", "projected", "secret", "downwardAPI", "persistentVolumeClaim"],
      runAsUser: { rule: "MustRunAsNonRoot" },
      seLinux: { rule: "RunAsAny" },
      supplementalGroups: { rule: "MustRunAs", ranges: [{ min: 1, max: 65535 }] },
      fsGroup: { rule: "MustRunAs", ranges: [{ min: 1, max: 65535 }] },
    },
  }),

  // A CRD's metadata.name is required to be "<plural>.<group>".
  CustomResourceDefinition: (context) => ({
    ...base(context, { name: "widgets.example.com" }),
    spec: {
      group: "example.com",
      scope: "Namespaced",
      names: {
        plural: "widgets",
        singular: "widget",
        kind: "Widget",
        listKind: "WidgetList",
        shortNames: ["wd"],
      },
      versions: [{
        name: "v1",
        served: true,
        storage: true,
        subresources: { status: {} },
        schema: {
          openAPIV3Schema: {
            type: "object",
            properties: {
              spec: {
                type: "object",
                properties: {
                  image: { type: "string" },
                  replicas: { type: "integer", default: 1, minimum: 0 },
                },
                required: ["image"],
              },
              status: {
                type: "object",
                properties: { phase: { type: "string" } },
              },
            },
          },
        },
      }],
    },
  }),
};

/**
 * Builds the manifest text a create session starts from. Kinds without a
 * template - custom resources above all - fall back to the minimal skeleton the
 * API server needs, so an unknown CRD still opens something applyable.
 */
export function defaultManifestText(descriptor: ApiResourceDescriptor | undefined, namespace: string): string {
  const kind = descriptor?.kind ?? "ConfigMap";
  const context: TemplateContext = {
    name: `new-${kind.toLowerCase()}`,
    namespace: (descriptor?.namespaced ?? true) ? namespace : "",
    apiVersion: descriptor?.apiVersion ?? "v1",
    kind,
  };
  const build = templates[kind];
  const body = build ? build(context) : { ...base(context), spec: {} };
  return stringify(body, { indent: 2, lineWidth: 0 });
}
