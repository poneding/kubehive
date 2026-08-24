import type { ApiResourceDescriptor, ContainerFileTarget, HelmReleaseValues } from "../backend";
import type { ContainerFileExplorerSnapshot } from "../container-file-explorer";
import type { MetricsRange } from "../detail-panels";
import type { ResourceRow } from "../resource-catalog";
import type { PodMetrics } from "../resource-details";
import type { ResourceRelationGroup } from "../resource-relations";
import type { ManifestFormat } from "../manifest-format";

type ResourceTab = { id: string; label: string; resource: string; crdKind?: string; crdName?: string; preview?: boolean };
/** One installed CRD kind, listed under the Custom Resources navigation group. */
type CustomResourceNavEntry = { name: string; label: string; kind: string; group: string; descriptor: ApiResourceDescriptor };
type RelatedDetail = {
  relation: string;
  kind: string;
  name: string;
  namespace?: string;
  from?: string;
  status?: string;
  meta?: Array<{ label: string; value: string }>;
  relatedItems?: Array<{ name: string; kind: string; namespace?: string; status?: string }>;
};
type DetailItem = { id: string; label: string; subtitle: string; type: "resource" | "crd" | "related"; kind?: string; status?: string; related?: RelatedDetail; row?: ResourceRow; manifest?: string; loading?: boolean; error?: string; relations?: ResourceRelationGroup[]; relationsLoading?: boolean; relationsError?: string; metrics?: PodMetrics; metricsLoading?: boolean; metricsError?: string; metricsRange?: MetricsRange; helmValues?: HelmReleaseValues; helmValuesLoading?: boolean; helmValuesError?: string };
type BottomRequest = { mode: "create" | "edit" | "logs" | "terminal" | "files"; item?: DetailItem; sessionKey?: string; label?: string; manifest?: string; descriptor?: ApiResourceDescriptor; readOnlyReason?: string; terminalTarget?: "local" | "container" | "node" };
type BottomSession = BottomRequest & { id: string };
type BottomSessionCache = {
  manifestText?: string;
  manifestFormat?: ManifestFormat;
  output?: string;
  feedback?: string;
  selectedPodKey?: string;
  selectedContainer?: string;
  logTailLines?: number;
  logPrevious?: boolean;
  logFollow?: boolean;
  logTimestamps?: boolean;
  logWrapLines?: boolean;
  editorWrapLines?: boolean;
  terminalReloadToken?: number;
  /** Resolved helper-Pod target for a Node file explorer session. */
  nodeFileTarget?: ContainerFileTarget;
  /** Node whose helper Pod the session owns (paired with `nodeFileTarget`). */
  nodeFileName?: string;
  /** Last fully loaded file view, retained while this session's tab is inactive. */
  fileExplorerSnapshot?: ContainerFileExplorerSnapshot;
};

type ClusterWorkspaceState = {
  tabs: ResourceTab[];
  activeTabId: string;
  /** Empty array means all namespaces. */
  namespaces: string[];
  bottomSessions: BottomSession[];
  activeBottomId: string;
  bottomCollapsed: boolean;
};
type BottomSessionCacheMap = Record<string, BottomSessionCache>;
type TerminalRuntimeMap = Record<string, TerminalRuntime>;
type RuntimeMapUpdater<T> = (update: (current: T) => T) => void;
type AppToast = { id: number; tone: "success" | "error"; message: string; filePath?: string };
type ForwardablePort = { port: number; protocol: string; label: string; target?: string; container?: string; name?: string; forwardable: boolean };
type PortForwardDialogState = { row: ResourceRow; ports: ForwardablePort[]; selectedPort: number; showPortSelect: boolean };
type PodSessionTarget = { key: string; namespace: string; pod: string; phase: string; ready: boolean; initContainers: string[]; containers: string[] };
type TerminalConnectionStatus = "idle" | "connecting" | "connected" | "disconnected";
type TerminalRuntime = { sessionId: string; output: string; status: TerminalConnectionStatus; feedback: string; connectionKey: string; targetLabel: string; podKey?: string; container?: string };
type DesktopPlatform = "macos" | "windows" | "linux";
type WorkspaceView = "clusters" | "cluster";
type ClusterConnectionPhase = "connecting" | "failed" | "unavailable";
type ClusterConnectionState = { clusterId: string; phase: ClusterConnectionPhase; operationId?: string; error?: string };
type TrayAction = "settings" | "about" | "check-updates";

export type {
  AppToast,
  BottomRequest,
  BottomSession,
  BottomSessionCache,
  BottomSessionCacheMap,
  ClusterConnectionState,
  ClusterWorkspaceState,
  CustomResourceNavEntry,
  DesktopPlatform,
  DetailItem,
  ForwardablePort,
  PodSessionTarget,
  PortForwardDialogState,
  RelatedDetail,
  ResourceTab,
  RuntimeMapUpdater,
  TerminalConnectionStatus,
  TerminalRuntime,
  TerminalRuntimeMap,
  TrayAction,
  WorkspaceView,
};
