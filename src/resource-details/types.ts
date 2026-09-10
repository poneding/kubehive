export type DetailField = {
  label: string;
  value: string;
  tone?: "neutral" | "green" | "amber" | "red" | "blue";
  wide?: boolean;
  copyable?: boolean;
};

export type ResourceDetailSection = {
  id: string;
  title: string;
  description?: string;
  fields: DetailField[];
};

export type ResourceCondition = {
  type: string;
  status: string;
  reason: string;
  message: string;
  lastTransition: string;
};

/**
 * Environment entries discriminate on `source` so reference-based values are
 * statically forced to carry a navigable link, while literal values can never
 * smuggle one in. Secret/ConfigMap references keep only the reference here;
 * the raw value lives behind the resource's own get permission.
 */
export type ContainerEnvironment =
  | (ContainerEnvironmentBase & { source: "literal" | "field" | "resourceField" | "unknown"; link?: undefined })
  | (ContainerEnvironmentBase & { source: "secret" | "configMap" | "envFrom"; link: ResourceDetailLink });

type ContainerEnvironmentBase = {
  name: string;
  value: string;
  sensitive?: boolean;
};

export type ResourceDetailLink = {
  kind: string;
  name: string;
  namespace?: string;
  apiVersion?: string;
};

export type ContainerPort = {
  name?: string;
  port: string;
  protocol: string;
  hostPort?: string;
};

export type ContainerMount = {
  name: string;
  path: string;
  readOnly: boolean;
  subPath?: string;
  sourceName: string;
  sourceType: string;
  link?: ResourceDetailLink;
};

export type ContainerDetail = {
  name: string;
  kind: "init" | "container" | "ephemeral";
  image: string;
  imageId?: string;
  pullPolicy: string;
  state: string;
  stateReason?: string;
  /** Exit code when the container terminated; surfaced when non-zero. */
  exitCode?: number;
  /** Waiting/terminated message, surfaced as a hover tooltip. */
  stateMessage?: string;
  ready?: boolean;
  restarts?: number;
  command?: string;
  args?: string;
  ports: ContainerPort[];
  environment: ContainerEnvironment[];
  mounts: ContainerMount[];
  resourceRequests?: Record<string, string>;
  resourceLimits?: Record<string, string>;
};

export type ContainerDetailSection = {
  id: string;
  title: string;
  description: string;
  containers: ContainerDetail[];
};

export type PodMetricSeries = {
  id: string;
  label: string;
  unit: string;
  points: Array<{ timestamp: number; value: number }>;
};

export type PodMetrics = {
  source: "prometheus";
  provider: string;
  rangeHours: number;
  stepSeconds: number;
  series: Record<"cpu" | "memory" | "network" | "filesystem", PodMetricSeries[]>;
};
