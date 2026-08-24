import { cn } from "@/lib/utils";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { AlertTriangle, CheckCircle2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./about.css";
import { checkForUpdate, initialUpdateState, installAndRelaunch, updateProgress, type UpdateState } from "./app-update";
import { backend, descriptorForResource, nativeBackendAvailable, type ApiResourceDescriptor, type DrainNodeResult, type PodMetricsResponse, type PortForwardSession } from "./backend";
import "./bulk-actions.css";
import { ClusterSettingsDialog, ContextMenuHost } from "./context-menu";
import { clusterAccent, type Cluster, type CustomResourceDefinition } from "./data";
import type { DetailCopyHandler, MetricsRange } from "./detail-panels";
import "./final-alignment.css";
import { tr } from "./i18n";
import "./index.css";
import { rowFromBackend } from "./k8s-adapter";
import { defaultManifestText } from "./manifest-templates";
import "./platform.css";
import { contentFontSizes, resolveAppFont, resolveMonoFont, type AppLanguage, type Preferences } from "./preferences";
import "./refinements.css";
import "./resource-actions.css";
import type { ResourceLink, ResourceRow } from "./resource-catalog";
import type { PodMetrics } from "./resource-details";
import "./resource-details.css";
import { resolveResourceLink, resolveResourceRelations } from "./resource-relations";
import "./session-settings-polish.css";
import "./settings.css";
import "./sheet-polish.css";
import "./tab-polish.css";
import "./workbench.css";
import "./typography.css";
import { applyWindowZoom, getWindowZoomFactor, stepWindowZoom } from "./zoom";
import { WorkspaceScroll } from "./app/app-controls";
import { AboutPanel, AddClusterDialog, AlertsDialog, CommandPalette, SettingsSheet } from "./app/application-dialogs";
import {
  apiNamespaceFilter, applySavedClusterOrder, clampNavWidth, clusterOrderStorageKey,
  clusterProbeRequestedEvent, clusterWorkspaceStorageKey, customResourceNavEntries,
  defaultClusterWorkspace, defaultPreferences, isPreviewTab, loadClusterWorkspaces,
  loadNavWidth, navWidthStorageKey, nonAuthorableResources, normalizeClusterWorkspace,
  platform, resourceTabId, unconfiguredCluster,
} from "./app/app-state";
import { ClusterRail } from "./app/cluster-rail";
import { ClusterConnectionPage, ClusterHome, Overview } from "./app/cluster-pages";
import { DetailSheet } from "./app/detail-sheet";
import { ResourceNav } from "./app/resource-navigation";
import {
  CrdBrowser, PortForwardDialog, ResourceTable, forwardablePortsFor,
  manifestReadOnlyReason, portForwardAddress, portForwardMatches,
} from "./app/resource-browser";
import { NodeCordonDialog, NodeDrainDialog, NodeTaintsDialog, ResourceDeleteDialog, ResourceEvictDialog, ResourceScaleDialog } from "./app/resource-action-dialogs";
import { BottomActionSheet } from "./app/session-dock";
import { useSessionDockFindContextTracking } from "./app/table-search";
import type {
  AppToast, BottomRequest, BottomSession, BottomSessionCacheMap,
  ClusterConnectionState, ClusterWorkspaceState, DetailItem,
  PortForwardDialogState, RelatedDetail, ResourceTab, RuntimeMapUpdater,
  TerminalRuntimeMap, TrayAction, WorkspaceView,
} from "./app/types";
import { DETAIL_SHEET_PERSIST_SELECTOR, WorkspaceTabs, useTitlebarWindowGestures } from "./app/window-chrome";

export { WorkspaceScroll };

async function loadResourceMetrics(clusterId: string, row: ResourceRow, rangeHours: MetricsRange): Promise<PodMetrics | null> {
  if (!nativeBackendAvailable) return null;
  if (row.kind === "Pod") {
    if (!row.namespace || row.namespace === "—") return null;
    const response: PodMetricsResponse | null = await backend.podMetrics({ clusterId, namespace: row.namespace, pod: row.name, rangeHours });
    return response ? { ...response, source: "prometheus" } : null;
  }
  if (row.kind === "Node") {
    const response: PodMetricsResponse | null = await backend.nodeMetrics({ clusterId, node: row.name, rangeHours });
    return response ? { ...response, source: "prometheus" } : null;
  }
  return null;
}

export default function App() {
  const [availableClusters, setAvailableClusters] = useState<Cluster[]>([unconfiguredCluster]);
  const [cluster, setCluster] = useState<Cluster>(unconfiguredCluster);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("clusters");
  const [clusterOperationId, setClusterOperationId] = useState<string | null>(null);
  const [clusterConnection, setClusterConnection] = useState<ClusterConnectionState | null>(null);
  const clusterOrderHydratedRef = useRef(false);
  // The last theme synced to the native window layer; `null` until first sync.
  const themeSyncedRef = useRef<string | null>(null);
  const clusterConnectionAttemptRef = useRef<{ clusterId: string; operationId: string; cancelled: boolean } | null>(null);
  const [initialClusterWorkspaces] = useState<Record<string, ClusterWorkspaceState>>(() => loadClusterWorkspaces());
  const clusterWorkspacesRef = useRef(initialClusterWorkspaces);
  const [selectedNamespaces, setSelectedNamespaces] = useState<string[]>([]);
  const [navOpen, setNavOpen] = useState(false);
  const [navWidth, setNavWidth] = useState<number>(() => loadNavWidth());
  useEffect(() => {
    // Keep the stored width inside the window's bounds if it shrinks.
    const clamp = () => setNavWidth((current) => clampNavWidth(current));
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, []);
  const changeNavWidth = (width: number) => setNavWidth((current) => {
    const clamped = clampNavWidth(width);
    if (clamped === current) return current;
    try { localStorage.setItem(navWidthStorageKey, String(clamped)); } catch { /* ignore */ }
    return clamped;
  });
  const [commandOpen, setCommandOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState>(initialUpdateState);
  const [addClusterOpen, setAddClusterOpen] = useState(false);
  const [clusterSettingsId, setClusterSettingsId] = useState<string | null>(null);
  const [tabs, setTabs] = useState<ResourceTab[]>(() => defaultClusterWorkspace().tabs);
  const [activeTabId, setActiveTabId] = useState("overview");
  const [detail, setDetail] = useState<DetailItem | null>(null);
  const detailRequestRef = useRef(0);
  const metricsRequestRef = useRef(0);
  const [bottomSessions, setBottomSessions] = useState<BottomSession[]>([]);
  const [activeBottomId, setActiveBottomId] = useState("");
  const [bottomCollapsed, setBottomCollapsed] = useState(false);
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [terminalRuntimes, setTerminalRuntimesState] = useState<TerminalRuntimeMap>({});
  const terminalRuntimesRef = useRef<TerminalRuntimeMap>({});
  const [bottomSessionCaches, setBottomSessionCachesState] = useState<BottomSessionCacheMap>({});
  const bottomSessionCachesRef = useRef<BottomSessionCacheMap>({});
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [alertCount, setAlertCount] = useState(0);
  const [discoveredResources, setDiscoveredResources] = useState<ApiResourceDescriptor[]>([]);
  const discoveryClusterRef = useRef("");
  const [clusterNamespaces, setClusterNamespaces] = useState<string[]>([]);
  const [dataRevision, setDataRevision] = useState(0);
  const [backendError, setBackendError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ResourceRow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [evictTarget, setEvictTarget] = useState<ResourceRow | null>(null);
  const [evictBusy, setEvictBusy] = useState(false);
  const [evictError, setEvictError] = useState("");
  const [scaleTarget, setScaleTarget] = useState<ResourceRow | null>(null);
  const [scaleBusy, setScaleBusy] = useState(false);
  const [scaleError, setScaleError] = useState("");
  const [portForwardDialog, setPortForwardDialog] = useState<PortForwardDialogState | null>(null);
  const [portForwardSessions, setPortForwardSessions] = useState<PortForwardSession[]>([]);
  const [portForwardBusy, setPortForwardBusy] = useState(false);
  const [portForwardError, setPortForwardError] = useState("");
  const [drainTarget, setDrainTarget] = useState<ResourceRow | null>(null);
  const [drainBusy, setDrainBusy] = useState(false);
  const [drainError, setDrainError] = useState("");
  const [drainResult, setDrainResult] = useState<DrainNodeResult | null>(null);
  const [cordonTarget, setCordonTarget] = useState<ResourceRow | null>(null);
  const [cordonBusy, setCordonBusy] = useState(false);
  const [cordonError, setCordonError] = useState("");
  const [taintTarget, setTaintTarget] = useState<ResourceRow | null>(null);
  const [taintError, setTaintError] = useState("");
  const [toast, setToast] = useState<AppToast | null>(null);
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("dark");
  const [preferences, setPreferences] = useState<Preferences>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("kubehive.preferences") ?? "{}") as Omit<Partial<Preferences>, "language"> & { language?: string; contentFont?: string };
      const language: AppLanguage = saved.language === "zh-TW" ? "zh-TW" : saved.language === "zh-CN" || saved.language === "zh-K8s" ? "zh-CN" : "en";
      const savedFontSize = Number(saved.contentFontSize);
      const contentFontSize = contentFontSizes.includes(savedFontSize as Preferences["contentFontSize"])
        ? savedFontSize as Preferences["contentFontSize"]
        : defaultPreferences.contentFontSize;
      // Application font: empty or "system" selects the platform default stack.
      const savedAppFont = typeof saved.appFont === "string" ? saved.appFont.trim() : "";
      const appFont = savedAppFont ? savedAppFont : defaultPreferences.appFont;
      // Monospace font: prefer the new preference, then migrate the historical
      // `contentFont`; the generic `monospace` keyword resolves to the platform
      // stack, so normalize it to the system default.
      const savedMonoFont = typeof saved.monoFont === "string" ? saved.monoFont.trim() : "";
      const legacyFont = typeof saved.contentFont === "string" ? saved.contentFont.trim() : "";
      let monoFont = savedMonoFont || legacyFont || defaultPreferences.monoFont;
      if (monoFont === "monospace") monoFont = defaultPreferences.monoFont;
      // Drop the legacy `contentFont` key so it is not re-persisted.
      const { contentFont: _legacyContentFont, ...rest } = saved;
      return { ...defaultPreferences, ...rest, language, contentFontSize, appFont, monoFont };
    } catch { return defaultPreferences; }
  });
  // Push the resolved font stacks into CSS custom properties so the whole app —
  // including every `font-mono` surface — follows the configured fonts.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--font-sans", resolveAppFont(preferences.appFont, platform));
    root.style.setProperty("--font-mono", resolveMonoFont(preferences.monoFont, platform));
  }, [preferences.appFont, preferences.monoFont]);
  // Session-only zoom state. The window factor lives in the zoom module; content
  // zoom lives here and is deliberately never written back to `preferences`.
  const [contentZoomFactor, setContentZoomFactor] = useState(1);
  const changeWindowZoom = useCallback((factor: number) => {
    void applyWindowZoom(factor).catch(() => { /* Browser prototype or unsupported platform. */ });
  }, []);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const resource = activeTab.resource;
  const customResources = useMemo(() => customResourceNavEntries(discoveredResources), [discoveredResources]);
  const language = preferences.language;
  const contentAppearance = preferences.contentTheme === "system" ? resolvedTheme : preferences.contentTheme;
  const activeCluster = availableClusters.find((item) => item.id === cluster.id) ?? cluster;
  const accent = clusterAccent(activeCluster);
  const clusterSettingsTarget = availableClusters.find((item) => item.id === clusterSettingsId) ?? null;
  const openSettings = useCallback(() => {
    setAboutOpen(false);
    setAlertsOpen(false);
    setSettingsOpen(true);
    setDetail(null);
  }, []);
  const openAbout = useCallback(() => {
    setSettingsOpen(false);
    setAlertsOpen(false);
    setAboutOpen(true);
    setDetail(null);
  }, []);
  const checkUpdates = useCallback(async () => {
    if (!nativeBackendAvailable) {
      setUpdateState({ status: "unsupported", update: null, message: "", downloadedBytes: 0, contentLength: null });
      return;
    }
    setUpdateState({ status: "checking", update: null, message: "", downloadedBytes: 0, contentLength: null });
    try {
      const update = await checkForUpdate();
      setUpdateState(update
        ? { status: "available", update, message: "", downloadedBytes: 0, contentLength: null }
        : { status: "current", update: null, message: "", downloadedBytes: 0, contentLength: null });
    } catch (error) {
      setUpdateState({ status: "error", update: null, message: String(error), downloadedBytes: 0, contentLength: null });
    }
  }, []);
  const openAboutAndCheckUpdates = useCallback(() => {
    openAbout();
    void checkUpdates();
  }, [checkUpdates, openAbout]);
  const installUpdate = useCallback(async () => {
    const update = updateState.update;
    if (!update) return;
    setUpdateState({ status: "downloading", update, message: "", downloadedBytes: 0, contentLength: null });
    try {
      await installAndRelaunch(update, (event) => setUpdateState((current) => updateProgress(event, current)));
    } catch (error) {
      setUpdateState({ status: "error", update, message: String(error), downloadedBytes: 0, contentLength: null });
    }
  }, [updateState.update]);
  useEffect(() => {
    if (!nativeBackendAvailable) return;
    let unlisten: (() => void) | undefined;
    void listen<TrayAction>("kubehive://tray-action", (event) => {
      if (event.payload === "settings") openSettings();
      else if (event.payload === "about") openAbout();
      else if (event.payload === "check-updates") openAboutAndCheckUpdates();
    }).then((dispose) => { unlisten = dispose; }).catch((error) => {
      setUpdateState({ status: "error", update: null, message: String(error), downloadedBytes: 0, contentLength: null });
    });
    return () => { unlisten?.(); };
  }, [openAbout, openAboutAndCheckUpdates, openSettings]);
  useEffect(() => {
    if (preferences.autoUpdate && nativeBackendAvailable) void checkUpdates();
  }, [checkUpdates, preferences.autoUpdate]);
  useEffect(() => {
    if (!nativeBackendAvailable || activeCluster.disconnected) { setPortForwardSessions([]); return; }
    let cancelled = false;
    const refresh = () => {
      void backend.listPortForwards(activeCluster.id).then((sessions) => {
        if (!cancelled) setPortForwardSessions(sessions);
      }).catch(() => { if (!cancelled) setPortForwardSessions([]); });
    };
    refresh();
    const timer = window.setInterval(refresh, 3_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [activeCluster.id, activeCluster.disconnected, dataRevision]);
  terminalRuntimesRef.current = terminalRuntimes;
  const updateTerminalRuntimes: RuntimeMapUpdater<TerminalRuntimeMap> = (update) => {
    setTerminalRuntimesState((current) => {
      const next = update(current);
      terminalRuntimesRef.current = next;
      return next;
    });
  };
  const updateBottomSessionCaches: RuntimeMapUpdater<BottomSessionCacheMap> = (update) => {
    setBottomSessionCachesState((current) => {
      const next = update(current);
      bottomSessionCachesRef.current = next;
      return next;
    });
  };
  const stopNodeFileSessions = (clusterId: string, sessionIds: string[]) => {
    sessionIds.forEach((id) => {
      const cache = bottomSessionCachesRef.current[`${clusterId}::${id}`];
      if (cache?.nodeFileTarget && cache.nodeFileName && nativeBackendAvailable) void backend.stopNodeFileSession({ clusterId, node: cache.nodeFileName });
    });
  };
  const disposeBottomSessions = (clusterId: string, sessionIds: string[]) => {
    if (!sessionIds.length) return;
    const discarded = new Set(sessionIds.map((id) => `${clusterId}::${id}`));
    discarded.forEach((id) => {
      const runtime = terminalRuntimesRef.current[id];
      if (runtime?.sessionId && nativeBackendAvailable) void backend.stopTerminal(runtime.sessionId);
    });
    stopNodeFileSessions(clusterId, sessionIds);
    updateTerminalRuntimes((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !discarded.has(id))));
    updateBottomSessionCaches((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !discarded.has(id))));
  };
  const disposeClusterSessions = (clusterId: string) => {
    const prefix = `${clusterId}::`;
    const discarded = Object.keys(terminalRuntimesRef.current).filter((id) => id.startsWith(prefix));
    discarded.forEach((id) => {
      const runtime = terminalRuntimesRef.current[id];
      if (runtime?.sessionId && nativeBackendAvailable) void backend.stopTerminal(runtime.sessionId);
    });
    const nodeFileSessionIds = Object.entries(bottomSessionCachesRef.current)
      .filter(([id]) => id.startsWith(prefix) && Boolean(bottomSessionCachesRef.current[id]?.nodeFileTarget))
      .map(([id]) => id.slice(prefix.length));
    stopNodeFileSessions(clusterId, nodeFileSessionIds);
    updateTerminalRuntimes((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !id.startsWith(prefix))));
    updateBottomSessionCaches((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !id.startsWith(prefix))));
  };
  const persistClusterWorkspace = (clusterId: string, workspace: ClusterWorkspaceState) => {
    if (!clusterId || clusterId === "unconfigured") return;
    clusterWorkspacesRef.current = { ...clusterWorkspacesRef.current, [clusterId]: normalizeClusterWorkspace(workspace) };
    try { localStorage.setItem(clusterWorkspaceStorageKey, JSON.stringify(clusterWorkspacesRef.current)); } catch { /* ignore unavailable storage */ }
  };
  const captureActiveClusterWorkspace = () => {
    if (workspaceView !== "cluster" || activeCluster.id === "unconfigured" || activeCluster.disconnected) return;
    persistClusterWorkspace(activeCluster.id, { tabs, activeTabId, namespaces: selectedNamespaces, bottomSessions, activeBottomId, bottomCollapsed });
  };
  const restoreClusterWorkspace = (clusterId: string) => {
    const workspace = normalizeClusterWorkspace(clusterWorkspacesRef.current[clusterId]);
    setTabs(workspace.tabs.map((tab) => ({ ...tab })));
    setActiveTabId(workspace.activeTabId);
    setSelectedNamespaces(workspace.namespaces);
    setBottomSessions(workspace.bottomSessions.map((session) => ({ ...session })));
    setActiveBottomId(workspace.activeBottomId);
    setBottomCollapsed(workspace.bottomCollapsed);
    setDetail(null);
  };
  const clearCachedClusterSessions = (clusterId: string) => {
    const workspace = normalizeClusterWorkspace(clusterWorkspacesRef.current[clusterId]);
    persistClusterWorkspace(clusterId, { ...workspace, bottomSessions: [], activeBottomId: "", bottomCollapsed: false });
  };
  const forgetClusterWorkspace = (clusterId: string) => {
    const next = { ...clusterWorkspacesRef.current };
    delete next[clusterId];
    clusterWorkspacesRef.current = next;
    try { localStorage.setItem(clusterWorkspaceStorageKey, JSON.stringify(next)); } catch { /* ignore unavailable storage */ }
  };

  useEffect(() => () => {
    if (!nativeBackendAvailable) return;
    Object.values(terminalRuntimesRef.current).forEach((runtime) => {
      if (runtime.sessionId) void backend.stopTerminal(runtime.sessionId);
    });
    Object.entries(bottomSessionCachesRef.current).forEach(([id, cache]) => {
      if (cache?.nodeFileTarget && cache.nodeFileName) {
        const clusterId = id.split("::")[0];
        if (clusterId) void backend.stopNodeFileSession({ clusterId, node: cache.nodeFileName });
      }
    });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast((current) => current?.id === toast.id ? null : current), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const showToast = (tone: AppToast["tone"], message: string, filePath?: string) => setToast({ id: Date.now(), tone, message, filePath });
  const copyDetailValue: DetailCopyHandler = (value, label = "Value") => {
    if (!value || value === "—") return;
    if (!navigator.clipboard?.writeText) {
      showToast("error", `Unable to copy ${label.toLowerCase()}`);
      return;
    }
    void navigator.clipboard.writeText(value)
      .then(() => showToast("success", `${label} copied to clipboard`))
      .catch(() => showToast("error", `Unable to copy ${label.toLowerCase()}`));
  };
  const openToastFile = async (filePath: string) => {
    try {
      await openPath(filePath);
      setToast(null);
    } catch (error) {
      setToast({ id: Date.now(), tone: "error", message: `Unable to open downloaded file: ${String(error)}` });
    }
  };

  useEffect(() => {
    if (!nativeBackendAvailable) return;
    let cancelled = false;
    backend.listClusters().then((items) => {
      if (cancelled) return;
      let colors: Record<string, string> = {}; try { colors = JSON.parse(localStorage.getItem("kubehive.clusterColors") ?? "{}"); } catch { /* ignore invalid local preference */ }
      const next = applySavedClusterOrder(items.length ? items.map((item) => ({ ...item, color: colors[item.id] } as Cluster)) : [unconfiguredCluster]);
      clusterOrderHydratedRef.current = true;
      setAvailableClusters(next);
      setCluster(next[0]);
      setWorkspaceView("clusters");
      setBackendError("");
    }).catch((error) => { if (!cancelled) { setBackendError(String(error)); setAvailableClusters([unconfiguredCluster]); setCluster(unconfiguredCluster); setWorkspaceView("clusters"); } });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!clusterOrderHydratedRef.current) return;
    try { localStorage.setItem(clusterOrderStorageKey, JSON.stringify(availableClusters.filter((item) => item.id !== "unconfigured").map((item) => item.id))); } catch { /* ignore unavailable storage */ }
  }, [availableClusters]);

  useEffect(() => {
    if (!nativeBackendAvailable || workspaceView !== "cluster" || activeCluster.id === "unconfigured" || activeCluster.disconnected) return;
    let cancelled = false;
    // Keep the previous discovery result while refreshing. Resetting it on
    // every revision change made descriptors transiently fall back to empty
    // verbs, which surfaced misleading read-only/disabled states.
    if (discoveryClusterRef.current !== activeCluster.id) {
      discoveryClusterRef.current = activeCluster.id;
      setDiscoveredResources([]);
    }
    backend.discoverResources(activeCluster.id).then(async (resources) => {
      if (cancelled) return;
      setDiscoveredResources(resources);
      const namespaceResource = descriptorForResource("Namespaces", resources);
      if (namespaceResource) {
        const response = await backend.listResources({ clusterId: activeCluster.id, resource: namespaceResource });
        if (!cancelled) setClusterNamespaces(response.items.map((item) => item.name).sort());
      }
    }).catch((error) => { if (!cancelled) setBackendError(String(error)); });
    return () => { cancelled = true; };
  }, [activeCluster.id, activeCluster.disconnected, dataRevision, workspaceView]);

  useEffect(() => {
    if (!nativeBackendAvailable) return;
    void backend.setProxy(preferences.proxyEnabled, preferences.proxyEnabled ? preferences.proxyUrl : undefined).catch((error) => setBackendError(String(error)));
  }, [preferences.proxyEnabled, preferences.proxyUrl]);

  useEffect(() => {
    localStorage.setItem("kubehive.preferences", JSON.stringify(preferences));
    document.documentElement.lang = preferences.language === "en" ? "en" : preferences.language === "zh-TW" ? "zh-TW" : "zh-CN";
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const next = preferences.theme === "system" ? (media.matches ? "light" : "dark") : preferences.theme;
      setResolvedTheme(next);
      document.documentElement.classList.toggle("theme-light", next === "light");
      document.documentElement.classList.toggle("theme-dark", next === "dark");
      // Keep the document canvas on the app-shell color so repaint gaps and
      // the pre-CSS phase match the configured theme (index.html's inline
      // script paints the first frame; this keeps it in sync afterwards).
      document.documentElement.style.backgroundColor = next === "light" ? "#f3f5f7" : "#0c0e12";
    };
    apply();
    // The native window layer paints the same color on the next launch, so
    // the startup background follows the configured theme too.
    if (nativeBackendAvailable && themeSyncedRef.current !== preferences.theme) {
      themeSyncedRef.current = preferences.theme;
      backend.setAppTheme(preferences.theme).catch(() => { /* best-effort; startup paint falls back to system */ });
    }
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preferences]);

  useEffect(() => {
    if (workspaceView !== "cluster" || activeCluster.id === "unconfigured" || activeCluster.disconnected) return;
    persistClusterWorkspace(activeCluster.id, { tabs, activeTabId, namespaces: selectedNamespaces, bottomSessions, activeBottomId, bottomCollapsed });
  }, [activeCluster.id, activeCluster.disconnected, activeTabId, selectedNamespaces, tabs, bottomSessions, activeBottomId, bottomCollapsed, workspaceView]);

  const openResourcePage = (nextResource: string, crd?: Pick<CustomResourceDefinition, "name" | "kind">, options?: { permanent?: boolean }) => {
    const permanent = Boolean(options?.permanent);
    const id = nextResource === "Overview" && !crd ? "overview" : resourceTabId(nextResource, crd);
    if (id === "overview") {
      setActiveTabId("overview");
      setDetail(null);
      return;
    }
    const nextTab: ResourceTab = {
      id,
      label: crd?.kind ?? nextResource,
      resource: nextResource,
      crdKind: crd?.kind,
      crdName: crd?.name,
      preview: !permanent,
    };
    setTabs((current) => {
      const existingIndex = current.findIndex((tab) => tab.id === id);
      if (existingIndex >= 0) {
        if (!permanent) return current;
        return current.map((tab, index) => index === existingIndex ? { ...tab, preview: false } : tab);
      }
      if (permanent) return [...current, { ...nextTab, preview: false }];
      const previewIndex = current.findIndex(isPreviewTab);
      if (previewIndex >= 0) {
        const copy = current.slice();
        copy[previewIndex] = nextTab;
        return copy;
      }
      return [...current, nextTab];
    });
    setActiveTabId(id);
    setDetail(null);
  };
  const keepTabOpen = (id: string) => {
    if (id === "overview") return;
    setTabs((current) => current.map((tab) => tab.id === id ? { ...tab, preview: false } : tab));
  };
  const detailIdForRow = (row: ResourceRow) => `resource:${JSON.stringify([
    activeCluster.id,
    row.descriptor?.apiVersion ?? row.backend?.apiVersion ?? "",
    row.kind,
    row.namespace,
    row.name,
    row.backend?.uid ?? row.key,
  ])}`;
  const baseDetailForRow = (row: ResourceRow): DetailItem => ({
    id: detailIdForRow(row),
    label: row.name,
    subtitle: row.namespace,
    type: row.kind === "CustomResource" ? "crd" : "resource",
    kind: row.kind,
    status: row.status,
    row,
    loading: Boolean(nativeBackendAvailable && row.backend && row.descriptor),
    relationsLoading: nativeBackendAvailable,
    relations: [],
    ...(row.kind === "Pod" || row.kind === "Node" ? { metricsLoading: nativeBackendAvailable, metricsRange: 1 as MetricsRange } : {}),
    ...(row.kind === "HelmRelease" ? { helmValuesLoading: nativeBackendAvailable } : {}),
  });
  const fetchDetailForRow = async (row: ResourceRow) => {
    const base = baseDetailForRow(row);
    if (!nativeBackendAvailable || !row.backend || !row.descriptor) return base;
    try {
      const response = await backend.getResource({ clusterId: activeCluster.id, resource: row.descriptor, namespace: row.namespace === "—" ? undefined : row.namespace, name: row.kind === "HelmRelease" ? row.backend.name : row.name });
      const detail = { ...base, row: row.kind === "HelmRelease" ? row : rowFromBackend(response, row.descriptor), manifest: response.manifest, loading: false };
      // A Helm release row is the storage Secret behind one revision, and the
      // values that revision recorded live only inside its compressed payload.
      if (row.kind !== "HelmRelease") return detail;
      try {
        const helmValues = await backend.getHelmRelease({ clusterId: activeCluster.id, namespace: row.namespace, secretName: row.backend.name });
        return { ...detail, helmValues, helmValuesLoading: false };
      } catch (error) {
        return { ...detail, helmValuesLoading: false, helmValuesError: String(error) };
      }
    } catch (error) {
      return { ...base, loading: false, helmValuesLoading: false, error: String(error) };
    }
  };
  const reloadResourceMetrics = (row: ResourceRow, range: MetricsRange, detailId = detailIdForRow(row)) => {
    if (row.kind !== "Pod" && row.kind !== "Node") return;
    const requestId = ++metricsRequestRef.current;
    setDetail((current) => current?.id === detailId ? { ...current, metricsLoading: true, metricsRange: range } : current);
    void loadResourceMetrics(activeCluster.id, row, range).then((metrics) => {
      if (metricsRequestRef.current !== requestId) return;
      setDetail((current) => current?.id === detailId && current.metricsRange === range ? { ...current, metrics: metrics ?? undefined, metricsLoading: false, metricsError: undefined } : current);
    }).catch((error) => {
      if (metricsRequestRef.current !== requestId) return;
      setDetail((current) => current?.id === detailId && current.metricsRange === range ? { ...current, metrics: undefined, metricsLoading: false, metricsError: String(error) } : current);
    });
  };
  const openResourceRow = (row: ResourceRow) => {
    // Local port-forward sessions are not Kubernetes resources: there is no
    // manifest or status tree to inspect, so the details sheet stays closed
    // and the inline list actions are the whole interface.
    if (row.kind === "PortForward") return;
    const requestId = ++detailRequestRef.current;
    const base = baseDetailForRow(row);
    setDetail(base);
    void (async () => {
      const hydrated = await fetchDetailForRow(row);
      if (detailRequestRef.current !== requestId) return;
      const hydratedRow = hydrated.row ?? row;
      const metricable = hydratedRow.kind === "Pod" || hydratedRow.kind === "Node";
      setDetail((current) => current?.id === hydrated.id ? { ...hydrated, relationsLoading: nativeBackendAvailable, relations: current.relations ?? [], metricsLoading: metricable && nativeBackendAvailable, metrics: undefined, metricsError: undefined, metricsRange: 1 } : current);
      if (metricable && nativeBackendAvailable) reloadResourceMetrics(hydratedRow, 1, hydrated.id);
      if (!nativeBackendAvailable) return;
      try {
        const relations = await resolveResourceRelations(activeCluster.id, hydratedRow, discoveredResources);
        if (detailRequestRef.current !== requestId) return;
        setDetail((current) => current?.id === hydrated.id ? { ...current, relations, relationsLoading: false, relationsError: undefined } : current);
      } catch (error) {
        if (detailRequestRef.current !== requestId) return;
        setDetail((current) => current?.id === hydrated.id ? { ...current, relationsLoading: false, relationsError: String(error) } : current);
      }
    })();
  };
  const openRelatedLink = (link: ResourceLink, row: ResourceRow) => {
    const requestId = ++detailRequestRef.current;
    const namespace = link.namespace ?? (row.namespace === "—" ? undefined : row.namespace);
    const id = `related:${JSON.stringify([activeCluster.id, link.apiVersion ?? "", link.kind, namespace ?? "cluster", link.name])}`;
    const related: RelatedDetail = { relation: link.relation, kind: link.kind, name: link.name, namespace, from: `${row.kind}/${row.name}`, status: tr(language, "resolving") };
    setDetail({ id, label: link.name, subtitle: namespace ?? link.relation, type: "related", kind: link.kind, related, loading: true });
    void resolveResourceLink(activeCluster.id, { ...link, namespace }, discoveredResources).then((resolved) => {
      if (detailRequestRef.current !== requestId) return;
      if (resolved) openResourceRow(resolved);
      else setDetail((current) => current?.id === id ? { ...current, loading: false, error: `Unable to resolve ${link.kind}/${link.name}` } : current);
    }).catch((error) => {
      if (detailRequestRef.current !== requestId) return;
      setDetail((current) => current?.id === id ? { ...current, loading: false, error: String(error) } : current);
    });
  };
  const openBottomSession = (request: BottomRequest) => {
    const id = `${request.mode}:${request.sessionKey ?? request.item?.id ?? (request.mode === "create" ? activeTabId : "cluster")}`;
    const session: BottomSession = { ...request, id };
    setBottomSessions((current) => current.some((item) => item.id === id) ? current.map((item) => item.id === id ? session : item) : [...current, session]);
    setActiveBottomId(id); setBottomCollapsed(false);
  };
  const openCreateSession = (descriptor?: ApiResourceDescriptor | null) => {
    if (!descriptor && nonAuthorableResources.has(resource)) return;
    const effective = descriptor ?? descriptorForResource(resource, discoveredResources) ?? undefined;
    // Seed the manifest with the filtered namespace only when the list is
    // narrowed to exactly one; "all" and multi-select have no single target.
    const createNamespace = apiNamespaceFilter(selectedNamespaces) ?? "default";
    const manifest = defaultManifestText(effective, createNamespace);
    openBottomSession({ mode: "create", sessionKey: `create-${effective?.apiVersion ?? "v1"}-${effective?.kind ?? "resource"}`, label: effective?.kind ?? resource, descriptor: effective, manifest });
  };
  const requestPortForward = (targetRow?: ResourceRow, preferredPort?: number, showPortSelect = true) => {
    if (!nativeBackendAvailable) { setBackendError("Port forwarding is available in the native Tauri application."); return; }
    if (!targetRow || !["Pod", "Service"].includes(targetRow.kind)) { setBackendError("Select a Pod or Service with a declared port before creating a port forward."); return; }
    if (!targetRow.namespace || targetRow.namespace === "—") { setBackendError("Port forwarding requires a namespaced Pod or Service."); return; }
    const ports = forwardablePortsFor(targetRow);
    const selected = ports.find((entry) => entry.port === preferredPort && entry.forwardable) ?? ports.find((entry) => entry.forwardable);
    if (!selected) {
      setBackendError(targetRow.kind === "Pod" ? "This Pod has no declared TCP ports to forward." : "This Service has no declared TCP ports to forward.");
      return;
    }
    setPortForwardError("");
    setPortForwardDialog({ row: targetRow, ports, selectedPort: selected.port, showPortSelect });
  };
  const openPortForwardSession = async (session: PortForwardSession) => {
    const url = portForwardAddress(session);
    if (session.status !== "Active") { setBackendError(`Cannot open ${url}; the port-forward status is ${session.status}.`); return; }
    try {
      if (nativeBackendAvailable) await openUrl(url); else window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      setBackendError(`Unable to open ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const pausePortForwardSession = async (session: PortForwardSession) => {
    try {
      const paused = await backend.pausePortForward(session.id);
      setPortForwardSessions((current) => current.map((item) => item.id === paused.id ? paused : item));
      setDataRevision((value) => value + 1);
      showToast("success", `Paused port forwarding on ${session.host}:${session.localPort}`);
    } catch (error) {
      setBackendError(error instanceof Error ? error.message : String(error));
    }
  };
  const resumePortForwardSession = async (session: PortForwardSession) => {
    try {
      const resumed = await backend.resumePortForward(session.id);
      setPortForwardSessions((current) => current.map((item) => item.id === resumed.id ? resumed : item));
      setDataRevision((value) => value + 1);
      showToast("success", `Resumed port forwarding on ${resumed.host}:${resumed.localPort}`);
    } catch (error) {
      setBackendError(error instanceof Error ? error.message : String(error));
    }
  };
  const stopPortForwardSession = async (session: PortForwardSession) => {
    try {
      const stopped = await backend.stopPortForward(session.id);
      if (!stopped) throw new Error("The port-forward session is no longer active.");
      setPortForwardSessions((current) => current.filter((item) => item.id !== session.id));
      setDataRevision((value) => value + 1);
      showToast("success", `Stopped port forwarding on ${session.host}:${session.localPort}`);
      return true;
    } catch (error) {
      setBackendError(error instanceof Error ? error.message : String(error));
      return false;
    }
  };
  const confirmPortForward = async (options: { remotePort: number; localPort: number; host: "localhost" | "0.0.0.0"; protocol: "http" | "https"; openBrowser: boolean }) => {
    const target = portForwardDialog;
    if (!target || portForwardBusy) return;
    const targetKind = target.row.kind === "Service" ? "service" : "pod";
    const existing = portForwardSessions.find((session) => portForwardMatches(session, target.row, options.remotePort));
    if (existing) {
      setPortForwardError(`Port ${options.remotePort} is already forwarded at ${portForwardAddress(existing)}.`);
      return;
    }
    setPortForwardBusy(true);
    setPortForwardError("");
    try {
      const session = await backend.startPortForward({ clusterId: activeCluster.id, namespace: target.row.namespace, targetKind, targetName: target.row.name, host: options.host, protocol: options.protocol, localPort: options.localPort, remotePort: options.remotePort });
      const targetLabel = `${session.targetKind === "service" ? "Service" : "Pod"}/${session.targetName}`;
      const endpointLabel = session.targetKind === "service" ? ` · endpoint Pod/${session.pod}:${session.remotePort}` : "";
      const localAddress = `${session.host}:${session.localPort}`;
      setBackendError("");
      showToast("success", `Port forward active: ${localAddress} → ${targetLabel}:${session.servicePort ?? session.remotePort}${endpointLabel}`);
      setPortForwardDialog(null);
      setDataRevision((value) => value + 1);
      setPortForwardSessions((current) => [...current.filter((item) => item.id !== session.id), session]);
      if (options.openBrowser) await openPortForwardSession(session);
    } catch (error) {
      setPortForwardError(error instanceof Error ? error.message : String(error));
    } finally {
      setPortForwardBusy(false);
    }
  };
  const closeResourceDelete = () => {
    if (deleteBusy) return;
    setDeleteTarget(null);
    setDeleteError("");
  };
  const closeResourceEvict = () => {
    if (evictBusy) return;
    setEvictTarget(null);
    setEvictError("");
  };
  const closeResourceScale = () => {
    if (scaleBusy) return;
    setScaleTarget(null);
    setScaleError("");
  };
  const closeResourceDrain = () => {
    if (drainBusy) return;
    setDrainTarget(null);
    setDrainError("");
    setDrainResult(null);
  };
  const closeResourceCordon = () => {
    if (cordonBusy) return;
    setCordonTarget(null);
    setCordonError("");
  };
  const confirmResourceCordon = async () => {
    const row = cordonTarget;
    if (!row || cordonBusy) return;
    setCordonBusy(true);
    setCordonError("");
    try {
      if (!nativeBackendAvailable) throw new Error(tr(language, "nativeAppRequired"));
      await backend.setNodeUnschedulable(activeCluster.id, row.name, true);
      setCordonTarget(null);
      setDetail(null);
      setDataRevision((value) => value + 1);
      setBackendError("");
      showToast("success", tr(language, "nodeCordoned", { name: row.name }));
    } catch (error) {
      setCordonError(error instanceof Error ? error.message : String(error));
    } finally {
      setCordonBusy(false);
    }
  };
  const closeResourceTaints = () => {
    setTaintTarget(null);
    setTaintError("");
  };
  const confirmResourceDrain = async (options: { ignoreDaemonsets: boolean; deleteEmptyDirData: boolean; force: boolean; disableEviction: boolean; waitForDeletion: boolean; timeoutSeconds: number }) => {
    const row = drainTarget;
    if (!row || drainBusy) return;
    setDrainBusy(true);
    setDrainError("");
    setDrainResult(null);
    try {
      if (!nativeBackendAvailable) throw new Error(tr(language, "nativeAppRequired"));
      const result = await backend.drainNode({ clusterId: activeCluster.id, node: row.name, ...options });
      setDrainResult(result);
      if (result.failures.length === 0 && result.remaining.length === 0) {
        setDrainTarget(null);
        setDrainResult(null);
        setDetail(null);
        setDataRevision((value) => value + 1);
        setBackendError("");
        showToast("success", tr(language, "drainComplete", { name: row.name, evicted: result.evicted, skipped: result.skipped }));
      }
    } catch (error) {
      setDrainError(error instanceof Error ? error.message : String(error));
    } finally {
      setDrainBusy(false);
    }
  };
  const confirmResourceScale = async (replicas: number) => {
    const row = scaleTarget;
    if (!row || scaleBusy) return;
    setScaleBusy(true);
    setScaleError("");
    try {
      if (!nativeBackendAvailable) throw new Error("Resource scaling is available in the native KubeHive application.");
      if (!row.descriptor) throw new Error(`No Kubernetes API mapping is available for ${row.kind}`);
      await backend.scaleResource({
        clusterId: activeCluster.id,
        resource: row.descriptor,
        namespace: row.namespace === "—" ? undefined : row.namespace,
        name: row.name,
        replicas,
      });
      setScaleTarget(null);
      setDetail(null);
      setDataRevision((value) => value + 1);
      setBackendError("");
      showToast("success", tr(language, "scaleRequested", { kind: row.kind, name: row.name, replicas }));
    } catch (error) {
      setScaleError(error instanceof Error ? error.message : String(error));
    } finally {
      setScaleBusy(false);
    }
  };
  const confirmResourceDelete = async () => {
    const row = deleteTarget;
    if (!row || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      if (!nativeBackendAvailable) throw new Error("Resource deletion is available in the native KubeHive application.");
      if (row.kind === "PortForward") {
        const stopped = await backend.stopPortForward(row.key);
        if (!stopped) throw new Error("The port-forward session is no longer active.");
      } else {
        if (!row.descriptor) throw new Error(`No Kubernetes API mapping is available for ${row.kind}`);
        if (!row.descriptor.verbs.includes("delete")) throw new Error(`The current Kubernetes credentials cannot delete ${row.kind} resources`);
        await backend.deleteResource({
          clusterId: activeCluster.id,
          resource: row.descriptor,
          namespace: row.namespace === "—" ? undefined : row.namespace,
          name: row.name,
          foreground: false,
        });
      }
      setDeleteTarget(null);
      setDetail(null);
      setDataRevision((value) => value + 1);
      setBackendError("");
      showToast("success", row.kind === "PortForward" ? `Stopped port forwarding for ${row.name}` : `Deletion requested for ${row.kind}/${row.name}`);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleteBusy(false);
    }
  };
  const confirmResourceEvict = async () => {
    const row = evictTarget;
    if (!row || evictBusy) return;
    setEvictBusy(true);
    setEvictError("");
    try {
      if (!nativeBackendAvailable) throw new Error(tr(language, "nativeAppRequired"));
      if (row.kind !== "Pod" || row.namespace === "—") throw new Error(tr(language, "onlyNamespacedPods"));
      await backend.evictPod({ clusterId: activeCluster.id, namespace: row.namespace, pod: row.name });
      setEvictTarget(null);
      setDetail(null);
      setDataRevision((value) => value + 1);
      setBackendError("");
      showToast("success", tr(language, "evictConfirmToast", { name: row.name }));
    } catch (error) {
      setEvictError(error instanceof Error ? error.message : String(error));
    } finally {
      setEvictBusy(false);
    }
  };
  const performResourceAction = async (action: string, row: ResourceRow) => {
    if (action === "Delete") { setDeleteTarget(row); setDeleteError(""); return; }
    if (action === "Scale") { setScaleTarget(row); setScaleError(""); return; }
    if (action === "Open Port Forward" || action === "Pause Port Forward" || action === "Resume Port Forward" || action === "Stop Port Forward") {
      const session = portForwardSessions.find((item) => item.id === row.key);
      if (!session) { setBackendError("The port-forward session is no longer active."); return; }
      if (action === "Open Port Forward") void openPortForwardSession(session);
      else if (action === "Pause Port Forward") void pausePortForwardSession(session);
      else if (action === "Resume Port Forward") void resumePortForwardSession(session);
      else void stopPortForwardSession(session);
      return;
    }
    if (action === "Port Forward") { requestPortForward(row, undefined, true); return; }
    if (action === "Cordon" || action === "Uncordon") {
      if (!nativeBackendAvailable) return;
      if (action === "Cordon") { setCordonTarget(row); setCordonError(""); return; }
      try {
        await backend.setNodeUnschedulable(activeCluster.id, row.name, false);
        showToast("success", tr(language, "nodeUncordoned", { name: row.name }));
        setDetail(null); setDataRevision((value) => value + 1); setBackendError("");
      } catch (error) { setBackendError(String(error)); }
      return;
    }
    if (action === "Drain") {
      if (!nativeBackendAvailable) return;
      setDrainTarget(row); setDrainError(""); setDrainResult(null);
      return;
    }
    if (action === "Taints") {
      if (!nativeBackendAvailable) return;
      setTaintTarget(row); setTaintError("");
      return;
    }
    if (action === "Trigger" || action === "Suspend" || action === "Resume") {
      if (!nativeBackendAvailable || !row.descriptor || row.kind !== "CronJob") return;
      const target = { clusterId: activeCluster.id, resource: row.descriptor, namespace: row.namespace === "—" ? undefined : row.namespace, name: row.name };
      try {
        if (action === "Trigger") {
          const created = await backend.triggerCronJob(target);
          showToast("success", tr(language, "cronJobTriggered", { name: row.name, job: created.name }));
        } else if (action === "Suspend") {
          await backend.setCronJobSuspend({ ...target, suspend: true });
          showToast("success", tr(language, "cronJobSuspended", { name: row.name }));
        } else {
          await backend.setCronJobSuspend({ ...target, suspend: false });
          showToast("success", tr(language, "cronJobResumed", { name: row.name }));
        }
        setDetail(null); setDataRevision((value) => value + 1); setBackendError("");
      } catch (error) { setBackendError(String(error)); }
      return;
    }
    const item = await fetchDetailForRow(row);
    if (action === "Logs" || action === "Terminal" || action === "Files") {
      const nodeSession = row.kind === "Node" || item.row?.kind === "Node" || item.kind === "Node";
      const terminalTarget = action === "Terminal" || action === "Files"
        ? (nodeSession ? "node" : "container")
        : undefined;
      openBottomSession({
        mode: action === "Logs" ? "logs" : action === "Terminal" ? "terminal" : "files",
        item,
        label: terminalTarget === "node" ? (row.name || item.label) : undefined,
        terminalTarget,
      });
      setDetail(null);
      return;
    }
    if (action === "Edit") {
      openBottomSession({ mode: "edit", item, manifest: item.manifest, descriptor: row.descriptor, readOnlyReason: manifestReadOnlyReason(row) });
      setDetail(null);
      return;
    }
    if (!nativeBackendAvailable || !row.descriptor) return;
    const target = { clusterId: activeCluster.id, resource: row.descriptor, namespace: row.namespace === "—" ? undefined : row.namespace, name: row.name };
    try {
      if (action === "Evict") {
        if (row.kind !== "Pod" || row.namespace === "—") throw new Error(tr(language, "onlyNamespacedPods"));
        setEvictTarget(row);
        setEvictError("");
        return;
      } else if (action === "Restart") {
        await backend.restartResource(target);
      }
      setDetail(null); setDataRevision((value) => value + 1); setBackendError("");
    } catch (error) { setBackendError(String(error)); }
  };
  const closeBottomSession = (id: string) => {
    disposeBottomSessions(activeCluster.id, [id]);
    setBottomSessions((current) => {
      const index = current.findIndex((session) => session.id === id);
      const next = current.filter((session) => session.id !== id);
      if (activeBottomId === id) setActiveBottomId(next[Math.max(0, index - 1)]?.id ?? next[0]?.id ?? "");
      if (!next.length) setBottomCollapsed(false);
      return next;
    });
  };
  const closeTab = (id: string) => setTabs((current) => {
    if (id === "overview") return current;
    const index = current.findIndex((tab) => tab.id === id);
    const next = current.filter((tab) => tab.id !== id);
    if (activeTabId === id) setActiveTabId(next[Math.max(0, index - 1)]?.id ?? next[0].id);
    setDetail(null); return next;
  });
  const closeOtherTabs = (id: string) => setTabs((current) => {
    const next = current.filter((tab) => tab.id === "overview" || tab.id === id);
    setActiveTabId(id);
    setDetail(null);
    return next;
  });
  const closeAllTabs = () => {
    setTabs([{ id: "overview", label: "Overview", resource: "Overview", preview: false }]);
    setActiveTabId("overview");
    setDetail(null);
  };
  const closeOtherSessions = (id: string) => {
    disposeBottomSessions(activeCluster.id, bottomSessions.filter((session) => session.id !== id).map((session) => session.id));
    setBottomSessions((current) => current.filter((session) => session.id === id));
    setActiveBottomId(id);
  };
  const closeAllSessions = () => {
    disposeBottomSessions(activeCluster.id, bottomSessions.map((session) => session.id));
    setBottomSessions([]);
    setActiveBottomId("");
    setBottomCollapsed(false);
  };
  const moveCluster = (clusterId: string, direction: -1 | 1) => {
    setAvailableClusters((current) => {
      const visible = current.filter((item) => item.id !== "unconfigured");
      const index = visible.findIndex((item) => item.id === clusterId);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= visible.length) return current;
      const reordered = [...visible];
      [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];
      let visibleIndex = 0;
      return current.map((item) => item.id === "unconfigured" ? item : reordered[visibleIndex++]);
    });
  };
  const reorderCluster = (clusterId: string, insertionIndex: number) => {
    setAvailableClusters((current) => {
      const visible = current.filter((item) => item.id !== "unconfigured");
      const sourceIndex = visible.findIndex((item) => item.id === clusterId);
      if (sourceIndex < 0) return current;
      const reordered = [...visible];
      const [moved] = reordered.splice(sourceIndex, 1);
      const targetIndex = Math.max(0, Math.min(reordered.length, insertionIndex > sourceIndex ? insertionIndex - 1 : insertionIndex));
      reordered.splice(targetIndex, 0, moved);
      if (reordered.every((item, index) => item.id === visible[index]?.id)) return current;
      let visibleIndex = 0;
      return current.map((item) => item.id === "unconfigured" ? item : reordered[visibleIndex++]);
    });
  };
  const updateCluster = (id: string, patch: Partial<Cluster>) => {
    setAvailableClusters((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
    setCluster((current) => current.id === id ? { ...current, ...patch } : current);
  };
  const setClusterColor = (id: string, color: string) => {
    updateCluster(id, { color });
    try {
      const colors = JSON.parse(localStorage.getItem("kubehive.clusterColors") ?? "{}") as Record<string, string>;
      colors[id] = color;
      localStorage.setItem("kubehive.clusterColors", JSON.stringify(colors));
    } catch { /* ignore */ }
  };
  const saveClusterSettings = async (target: Cluster, name: string, color: string) => {
    const savedName = nativeBackendAvailable ? (await backend.renameCluster(target.id, name)).name : name.trim();
    updateCluster(target.id, { name: savedName });
    setClusterColor(target.id, color);
    setBackendError("");
  };
  const goHome = () => {
    captureActiveClusterWorkspace();
    setClusterConnection(null);
    setWorkspaceView("clusters");
    setNavOpen(false);
    setCommandOpen(false);
    setAlertsOpen(false);
    setDetail(null);
  };
  const connectAndOpenCluster = async (target: Cluster, forceReconnect = false) => {
    if (clusterOperationId) return;
    const reconnecting = forceReconnect || target.disconnected;
    const operationId = reconnecting ? (crypto.randomUUID?.() ?? `cluster-${Date.now()}-${Math.random().toString(36).slice(2)}`) : "";
    const attempt = reconnecting ? { clusterId: target.id, operationId, cancelled: false } : null;
    if (attempt) clusterConnectionAttemptRef.current = attempt;
    captureActiveClusterWorkspace();
    setClusterOperationId(target.id);
    if (reconnecting) {
      setCluster(target);
      setDiscoveredResources([]);
      setDetail(null);
      setNavOpen(false);
      setAlertsOpen(false);
      setWorkspaceView("cluster");
      setClusterConnection({ clusterId: target.id, phase: "connecting", operationId });
    }
    try {
      if (reconnecting && !nativeBackendAvailable) throw new Error(tr(language, "nativeAppRequired"));
      const next = reconnecting
        ? { ...(await backend.reconnectCluster(target.id, operationId)), disconnected: false } as Cluster
        : target;
      if (attempt?.cancelled || (attempt && clusterConnectionAttemptRef.current !== attempt)) return;
      setAvailableClusters((current) => current.map((item) => item.id === next.id ? { ...item, ...next } : item));
      setCluster(next);
      restoreClusterWorkspace(next.id);
      setDiscoveredResources([]);
      setNavOpen(false);
      setAlertsOpen(false);
      setWorkspaceView("cluster");
      setClusterConnection(null);
      setAlertCount(0);
      setBackendError("");
    } catch (error) {
      if (attempt?.cancelled || (attempt && clusterConnectionAttemptRef.current !== attempt)) return;
      const message = error instanceof Error ? error.message : String(error);
      const unavailable = { ...target, disconnected: true, status: "offline" as const };
      updateCluster(target.id, unavailable);
      setCluster(unavailable);
      setDiscoveredResources([]);
      setDetail(null);
      setWorkspaceView("cluster");
      setClusterConnection({ clusterId: target.id, phase: "failed", error: message });
      setBackendError("");
    } finally {
      if (!attempt || clusterConnectionAttemptRef.current === attempt) {
        if (attempt) clusterConnectionAttemptRef.current = null;
        setClusterOperationId(null);
      }
    }
  };
  const retryClusterConnection = () => {
    const target = availableClusters.find((item) => item.id === activeCluster.id) ?? activeCluster;
    void connectAndOpenCluster(target, true);
  };
  const cancelClusterConnection = () => {
    const attempt = clusterConnectionAttemptRef.current;
    if (!attempt || clusterConnection?.phase !== "connecting" || clusterConnection.clusterId !== attempt.clusterId) return;
    attempt.cancelled = true;
    clusterConnectionAttemptRef.current = null;
    const target = availableClusters.find((item) => item.id === attempt.clusterId) ?? activeCluster;
    const disconnected = { ...target, disconnected: true, status: "offline" as const };
    updateCluster(target.id, disconnected);
    setCluster(disconnected);
    setClusterConnection(null);
    setClusterOperationId(null);
    setDiscoveredResources([]);
    setDetail(null);
    setWorkspaceView("clusters");
    if (nativeBackendAvailable) {
      void Promise.allSettled([
        backend.cancelClusterConnection(attempt.operationId),
        backend.disconnectCluster(attempt.clusterId),
      ]);
    }
  };
  const markClusterUnavailable = (target: Cluster, error: string) => {
    if (clusterOperationId || activeCluster.id !== target.id) return;
    const unavailable = { ...target, disconnected: true, status: "offline" as const };
    updateCluster(target.id, unavailable);
    setCluster(unavailable);
    setDiscoveredResources([]);
    setDetail(null);
    setNavOpen(false);
    setCommandOpen(false);
    setAlertsOpen(false);
    setClusterConnection({ clusterId: target.id, phase: "unavailable", error });
    setWorkspaceView("cluster");
  };
  const closeClusterConnection = async (target: Cluster) => {
    if (clusterOperationId) return;
    captureActiveClusterWorkspace();
    setClusterOperationId(target.id);
    let disconnectError = "";
    try {
      if (nativeBackendAvailable) await backend.disconnectCluster(target.id);
    } catch (error) {
      disconnectError = error instanceof Error ? error.message : String(error);
    }
    disposeClusterSessions(target.id);
    clearCachedClusterSessions(target.id);
    updateCluster(target.id, { disconnected: true });
    if (cluster.id === target.id) {
      setCluster((current) => ({ ...current, disconnected: true }));
      closeAllTabs();
      setBottomSessions([]);
      setActiveBottomId("");
      setBottomCollapsed(false);
      setSelectedNamespaces([]);
      setDiscoveredResources([]);
      setNavOpen(false);
      setCommandOpen(false);
      setAlertsOpen(false);
      setAlertCount(0);
      setWorkspaceView("clusters");
    }
    setClusterConnection(null);
    setBackendError(disconnectError);
    setClusterOperationId(null);
  };
  const removeCluster = (target: Cluster) => {
    const applyRemoval = () => {
      disposeClusterSessions(target.id);
      forgetClusterWorkspace(target.id);
      if (cluster.id === target.id) {
        closeAllTabs();
        setBottomSessions([]);
        setActiveBottomId("");
        setBottomCollapsed(false);
        setDiscoveredResources([]);
        setClusterConnection(null);
        setWorkspaceView("clusters");
        setAlertCount(0);
      }
      setAvailableClusters((current) => {
        const next = current.filter((item) => item.id !== target.id);
        const fallback = next[0] ?? unconfiguredCluster;
        if (cluster.id === target.id) setCluster(fallback);
        return next.length ? next : [fallback];
      });
    };
    if (nativeBackendAvailable) {
      if (!target.imported) { setBackendError("Default kubeconfig contexts must be removed from your kubeconfig file."); return; }
      void backend.removeCluster(target.id).then(applyRemoval).catch((error) => setBackendError(String(error)));
    } else applyRemoval();
    if (clusterSettingsId === target.id) setClusterSettingsId(null);
  };
  useEffect(() => {
    if (!nativeBackendAvailable || workspaceView !== "cluster" || activeCluster.id === "unconfigured" || activeCluster.disconnected || clusterConnection) return;
    let cancelled = false;
    let probing = false;
    const probe = async () => {
      if (probing) return;
      probing = true;
      try {
        const summary = await backend.probeCluster(activeCluster.id);
        if (cancelled) return;
        if (summary.disconnected || summary.error) markClusterUnavailable(activeCluster, summary.error ?? "The cluster was disconnected.");
      } catch (error) {
        if (!cancelled) markClusterUnavailable(activeCluster, error instanceof Error ? error.message : String(error));
      } finally {
        probing = false;
      }
    };
    const onProbeRequest = (event: Event) => {
      const clusterId = event instanceof CustomEvent ? (event.detail as { clusterId?: unknown }).clusterId : undefined;
      if (clusterId === activeCluster.id) void probe();
    };
    window.addEventListener(clusterProbeRequestedEvent, onProbeRequest);
    const timer = window.setInterval(() => { void probe(); }, 15_000);
    return () => { cancelled = true; window.removeEventListener(clusterProbeRequestedEvent, onProbeRequest); window.clearInterval(timer); };
  }, [activeCluster, clusterConnection, clusterOperationId, workspaceView]);

  const addCluster = async (request: { displayName: string; kubeconfigYaml?: string; server?: string; token?: string; insecureSkipTlsVerify?: boolean }) => {
    if (!nativeBackendAvailable) throw new Error(tr(language, "nativeAppRequired"));
    const imported = await backend.importClusters(request);
    let colors: Record<string, string> = {}; try { colors = JSON.parse(localStorage.getItem("kubehive.clusterColors") ?? "{}"); } catch { /* ignore invalid local preference */ }
    const next = imported.map((item) => ({ ...item, color: colors[item.id] } as Cluster));
    setAvailableClusters((current) => [...current.filter((item) => item.id !== "unconfigured" && !next.some((added) => added.id === item.id)), ...next]);
    if (next[0]) setCluster(next[0]);
    setWorkspaceView("clusters"); setAddClusterOpen(false); setBackendError(""); setDataRevision((value) => value + 1);
  };



  // Clicking outside the details sheet dismisses it. Resource instances keep it open so
  // the sheet swaps content instead of closing, and overlay surfaces own their own state.
  useEffect(() => {
    if (!detail) return;
    const handler = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(DETAIL_SHEET_PERSIST_SELECTOR)) return;
      setDetail(null);
    };
    window.addEventListener("pointerdown", handler);
    return () => window.removeEventListener("pointerdown", handler);
  }, [detail]);

  // Cmd/Ctrl +/-/0 zoom the whole window. Registered in the capture phase so the
  // webview, xterm, and CodeMirror do not consume the keys first.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const modifier = platform === "macos" ? event.metaKey : event.ctrlKey;
      if (!modifier || event.altKey) return;
      const key = event.key;
      if (key === "+" || key === "=" || event.code === "Equal" || event.code === "NumpadAdd") {
        event.preventDefault();
        event.stopPropagation();
        changeWindowZoom(stepWindowZoom(getWindowZoomFactor(), 1));
      } else if (key === "-" || key === "_" || event.code === "Minus" || event.code === "NumpadSubtract") {
        event.preventDefault();
        event.stopPropagation();
        changeWindowZoom(stepWindowZoom(getWindowZoomFactor(), -1));
      } else if (key === "0" || event.code === "Digit0" || event.code === "Numpad0") {
        event.preventDefault();
        event.stopPropagation();
        changeWindowZoom(1);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [changeWindowZoom]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const settingsShortcut = event.key === "," && (platform === "macos" ? event.metaKey : event.ctrlKey);
      if (settingsShortcut) {
        event.preventDefault();
        event.stopPropagation();
        if (settingsOpen) setSettingsOpen(false);
        else openSettings();
        return;
      }
      const closeShortcut = event.key.toLowerCase() === "w" && (platform === "macos" ? event.metaKey : event.ctrlKey);
      if (closeShortcut) {
        // The visible bottom sheet owns Cmd/Ctrl+W. Otherwise close a resource tab
        // before falling back to the native window close behavior.
        event.preventDefault();
        event.stopPropagation();
        const workspaceTabsVisible = workspaceView === "cluster" && clusterConnection?.clusterId !== activeCluster.id;
        if (workspaceTabsVisible && bottomSessions.length > 0 && !bottomCollapsed) {
          const sessionId = bottomSessions.some((session) => session.id === activeBottomId) ? activeBottomId : bottomSessions[0].id;
          closeBottomSession(sessionId);
          return;
        }
        const tab = workspaceTabsVisible
          ? tabs.find((item) => item.id === activeTabId && item.id !== "overview") ?? tabs.find((item) => item.id !== "overview")
          : undefined;
        if (tab) { closeTab(tab.id); return; }
        void getCurrentWindow().close().catch(() => { /* Browser prototype. */ });
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && workspaceView === "cluster") { event.preventDefault(); setCommandOpen(true); }
      if (event.key === "Escape") {
        // Foundation overlays own Escape so Radix can honor each component's
        // dismissal guard before this app-level layer handler runs.
        if (document.querySelector('[data-slot="dialog-content"], [data-slot="popover-content"]')) return;
        // Escape dismisses one layer per press, top-most first: dialogs, then the
        // right details sheet, then the bottom session dock. While the session
        // find popover is open, the first Escape belongs to it — wherever focus
        // sits inside the dock, the search closes first and the dock stays put;
        // the next Escape collapses the dock. When the popover itself has focus
        // it closes itself (and hands focus back), so just stand aside.
        if (document.activeElement instanceof Element && document.activeElement.closest(".text-search-popover")) return;
        if (deleteTarget) { if (!deleteBusy) { setDeleteTarget(null); setDeleteError(""); } return; }
        if (evictTarget) { if (!evictBusy) { setEvictTarget(null); setEvictError(""); } return; }
        if (scaleTarget) { if (!scaleBusy) { setScaleTarget(null); setScaleError(""); } return; }
        if (drainTarget) { if (!drainBusy) { closeResourceDrain(); } return; }
        if (cordonTarget) { if (!cordonBusy) { setCordonTarget(null); setCordonError(""); } return; }
        if (taintTarget) { setTaintTarget(null); setTaintError(""); return; }
        if (commandOpen) { setCommandOpen(false); return; }
        if (addClusterOpen) { setAddClusterOpen(false); return; }
        if (clusterSettingsId) { setClusterSettingsId(null); return; }
        if (settingsOpen) { setSettingsOpen(false); return; }
        if (aboutOpen) { setAboutOpen(false); return; }
        if (alertsOpen) { setAlertsOpen(false); return; }
        if (detail) { setDetail(null); return; }
        if (sessionSearchOpen) { setSessionSearchOpen(false); return; }
        if (bottomSessions.length > 0 && !bottomCollapsed) { setBottomCollapsed(true); return; }
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [workspaceView, clusterConnection, activeCluster.id, deleteTarget, deleteBusy, evictTarget, evictBusy, scaleTarget, scaleBusy, drainTarget, drainBusy, cordonTarget, cordonBusy, taintTarget, commandOpen, addClusterOpen, clusterSettingsId, settingsOpen, aboutOpen, alertsOpen, detail, sessionSearchOpen, bottomSessions, bottomCollapsed, activeBottomId, tabs, activeTabId, openSettings]);

  useSessionDockFindContextTracking();
  useTitlebarWindowGestures();

  return <div className={cn("app-shell", `platform-${platform}`)} style={{ ["--cluster-accent" as string]: accent }}>
    <ClusterRail
      clusters={availableClusters}
      active={workspaceView === "cluster" ? activeCluster : null}
      language={language}
      alertCount={alertCount}
      alertsDisabled={workspaceView !== "cluster" || Boolean(activeCluster.disconnected)}
      updateAvailable={updateState.status === "available"}
      onHome={goHome}
      onConnect={(target) => void connectAndOpenCluster(target)}
      onAlerts={() => setAlertsOpen(true)}
      onAbout={openAbout}
      onSettings={openSettings}
      onAdd={() => setAddClusterOpen(true)}
      onClusterSettings={(target) => setClusterSettingsId(target.id)}
      onCloseConnection={(target) => void closeClusterConnection(target)}
      onMove={moveCluster}
      onReorder={reorderCluster}
      onRemove={removeCluster}
    />
    <div className={cn("workspace-pane", workspaceView === "clusters" && "home-mode")} style={{ ["--nav-width" as string]: `${navWidth}px` }}>
      {workspaceView === "clusters" ? <ClusterHome clusters={availableClusters} language={language} busyClusterId={clusterOperationId} onConnect={(target) => void connectAndOpenCluster(target)} onCloseConnection={(target) => void closeClusterConnection(target)} onSettings={(target) => setClusterSettingsId(target.id)} onRemove={removeCluster} onAdd={() => setAddClusterOpen(true)} onToast={showToast} /> : clusterConnection?.clusterId === activeCluster.id ? <ClusterConnectionPage cluster={activeCluster} language={language} state={clusterConnection} busy={clusterOperationId === activeCluster.id} onReconnect={retryClusterConnection} onCancel={cancelClusterConnection} onClose={() => void closeClusterConnection(activeCluster)} /> : <>
        <ResourceNav active={resource} activeCustomResource={activeTab.crdName ?? null} cluster={activeCluster} language={language} discovered={discoveredResources} customResources={customResources} navWidth={navWidth} onNavWidthChange={changeNavWidth} onSelect={(item, permanent) => openResourcePage(item, undefined, { permanent })} onSelectCustomResource={(entry, permanent) => openResourcePage("Custom Resource Definitions", { name: entry.name, kind: entry.kind }, { permanent })} onCloseCluster={() => void closeClusterConnection(activeCluster)} closing={clusterOperationId === activeCluster.id} open={navOpen} onClose={() => setNavOpen(false)} onCommand={() => setCommandOpen(true)} />
        <main className="main-area">
          <WorkspaceTabs
            tabs={tabs}
            activeId={activeTabId}
            language={language}
            onActivate={(id) => { setActiveTabId(id); setDetail(null); }}
            onClose={closeTab}
            onCloseOthers={closeOtherTabs}
            onCloseAll={closeAllTabs}
            onKeepOpen={keepTabOpen}
            onMenu={() => setNavOpen(true)}
          />
          {resource === "Overview"
            ? <Overview cluster={activeCluster} language={language} revision={dataRevision} onResource={openResourceRow} onTerminal={() => openBottomSession({ mode: "terminal", terminalTarget: "local" })} onNavigate={openResourcePage} onSnapshot={(snapshot) => { updateCluster(activeCluster.id, { nodes: snapshot.nodes, cpu: snapshot.cpuPercent ?? 0, memory: snapshot.memoryPercent ?? 0, version: snapshot.version, status: snapshot.readyNodes === snapshot.nodes ? "healthy" : "warning" }); setAlertCount(snapshot.events.filter((event) => event.level === "warning").length); }} />
            : resource === "Custom Resource Definitions"
              ? <CrdBrowser key={`${activeCluster.id}:${activeTab.crdName ?? "definitions"}`} clusterId={activeCluster.id} discovered={discoveredResources} namespaces={clusterNamespaces} revision={dataRevision} selectedDefinitionName={activeTab.crdName ?? null} selectedNamespaces={selectedNamespaces} setSelectedNamespaces={setSelectedNamespaces} language={language} onKindSelect={(definition) => openResourcePage("Custom Resource Definitions", definition)} onBack={() => openResourcePage("Custom Resource Definitions")} onInstance={openResourceRow} onCreate={openCreateSession} onRowAction={(action, row) => void performResourceAction(action, row)} onOpenLink={openRelatedLink} onCopy={copyDetailValue} />
              : <ResourceTable key={`${activeCluster.id}:${resource}`} clusterId={activeCluster.id} discovered={discoveredResources} namespaces={clusterNamespaces} revision={dataRevision} resource={resource} selectedNamespaces={selectedNamespaces} setSelectedNamespaces={setSelectedNamespaces} language={language} onSelect={openResourceRow} onOpenLink={openRelatedLink} onCreate={openCreateSession} onRowAction={(action, row) => void performResourceAction(action, row)} onCopy={copyDetailValue} onOpenPortForward={(row) => { const session = portForwardSessions.find((item) => item.id === row.key); if (session) void openPortForwardSession(session); }} />}
          {bottomSessions.length > 0 && <BottomActionSheet clusterId={activeCluster.id} sessions={bottomSessions} activeId={activeBottomId} collapsed={bottomCollapsed} searchOpen={sessionSearchOpen} onSearchOpenChange={setSessionSearchOpen} language={language} appTheme={resolvedTheme} contentTheme={contentAppearance} monoFont={resolveMonoFont(preferences.monoFont, platform)} contentFontSize={preferences.contentFontSize} contentZoom={contentZoomFactor} onContentZoom={setContentZoomFactor} terminalRuntimes={terminalRuntimes} sessionCaches={bottomSessionCaches} onUpdateTerminalRuntimes={updateTerminalRuntimes} onUpdateSessionCaches={updateBottomSessionCaches} onActivate={(id) => { setActiveBottomId(id); setBottomCollapsed(false); }} onCloseSession={closeBottomSession} onCloseOthers={closeOtherSessions} onCloseAll={closeAllSessions} onCreateSession={openBottomSession} onToggleCollapsed={() => setBottomCollapsed((value) => !value)} onApplied={() => setDataRevision((value) => value + 1)} onToast={showToast} />}
        </main>
      </>}
    </div>
    {workspaceView === "cluster" && detail && <DetailSheet key={detail.id} tab={detail} language={language} onClose={() => setDetail(null)} onCopy={copyDetailValue} onOpenResource={openResourceRow} onOpenLink={(link) => { void resolveResourceLink(activeCluster.id, link, discoveredResources).then((resolved) => { if (resolved) openResourceRow(resolved); else setBackendError(`Unable to resolve ${link.kind}/${link.name}`); }).catch((error) => setBackendError(String(error))); }} onMetricsRange={reloadResourceMetrics} onPortForward={(row, port) => requestPortForward(row, port, false)} portForwardSessions={portForwardSessions} onOpenPortForward={(session) => void openPortForwardSession(session)} onPausePortForward={(session) => void pausePortForwardSession(session)} onResumePortForward={(session) => void resumePortForwardSession(session)} onStopPortForward={(session) => stopPortForwardSession(session)} onAction={(action) => { if (detail.row) void performResourceAction(action, detail.row); else if (action === "Logs" || action === "Terminal" || action === "Files" || action === "Edit") { const terminalTarget = action === "Terminal" || action === "Files" ? (detail.kind === "Node" ? "node" : "container") : undefined; openBottomSession({ mode: action === "Logs" ? "logs" : action === "Terminal" ? "terminal" : action === "Files" ? "files" : "edit", item: detail, label: terminalTarget === "node" ? detail.label : undefined, terminalTarget, manifest: detail.manifest }); setDetail(null); } }} />}
    {deleteTarget && <ResourceDeleteDialog row={deleteTarget} busy={deleteBusy} error={deleteError} language={language} onClose={closeResourceDelete} onConfirm={() => void confirmResourceDelete()} />}
{evictTarget && <ResourceEvictDialog row={evictTarget} busy={evictBusy} error={evictError} language={language} onClose={closeResourceEvict} onConfirm={() => void confirmResourceEvict()} />}
    {scaleTarget && <ResourceScaleDialog row={scaleTarget} busy={scaleBusy} error={scaleError} language={language} onClose={closeResourceScale} onConfirm={(replicas) => void confirmResourceScale(replicas)} />}
    {drainTarget && <NodeDrainDialog row={drainTarget} busy={drainBusy} error={drainError} result={drainResult} language={language} onClose={closeResourceDrain} onConfirm={(options) => void confirmResourceDrain(options)} />}
    {cordonTarget && <NodeCordonDialog row={cordonTarget} busy={cordonBusy} error={cordonError} language={language} onClose={closeResourceCordon} onConfirm={() => void confirmResourceCordon()} />}
    {taintTarget && <NodeTaintsDialog clusterId={activeCluster.id} row={taintTarget} error={taintError} language={language} onClose={closeResourceTaints} onTainted={() => { setTaintError(""); setDataRevision((value) => value + 1); }} />}
    {portForwardDialog && <PortForwardDialog key={`${portForwardDialog.row.key}:${portForwardDialog.selectedPort}:${portForwardDialog.showPortSelect}`} state={portForwardDialog} busy={portForwardBusy} error={portForwardError} language={language} onClose={() => { if (!portForwardBusy) { setPortForwardDialog(null); setPortForwardError(""); } }} onConfirm={(options) => void confirmPortForward(options)} />}

    {workspaceView === "cluster" && alertsOpen && <AlertsDialog clusterId={activeCluster.id} language={language} onClose={() => setAlertsOpen(false)} />}
    {aboutOpen && <AboutPanel language={language} updateState={updateState} onCheckUpdates={() => void checkUpdates()} onInstallUpdate={() => void installUpdate()} onClose={() => setAboutOpen(false)} />}
    {settingsOpen && <SettingsSheet preferences={preferences} onChange={setPreferences} updateState={updateState} onCheckUpdates={openAboutAndCheckUpdates} onClose={() => setSettingsOpen(false)} />}
    {addClusterOpen && <AddClusterDialog language={language} onClose={() => setAddClusterOpen(false)} onAdd={addCluster} />}
    {clusterSettingsTarget && <ClusterSettingsDialog clusterName={clusterSettingsTarget.name} color={clusterAccent(clusterSettingsTarget)} language={language} onSave={(name, color) => saveClusterSettings(clusterSettingsTarget, name, color)} onClose={() => setClusterSettingsId(null)} />}
    {workspaceView === "cluster" && commandOpen && <CommandPalette language={language} customResources={customResources} onClose={() => setCommandOpen(false)} onNavigate={openResourcePage} onTerminal={() => openBottomSession({ mode: "terminal", terminalTarget: "local" })} onCreate={() => openCreateSession()} />} {backendError && <div className="backend-error-toast" role="alert"><AlertTriangle size={14} /><span>{backendError}</span><button onClick={() => setBackendError("")} aria-label={tr(language, "dismissBackendError")}><X size={13} /></button></div>}
    {toast && <div className={cn("app-toast", `tone-${toast.tone}`)} role={toast.tone === "error" ? "alert" : "status"}>{toast.tone === "error" ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}<span>{toast.message}{toast.filePath && <button type="button" className="app-toast-file" title={tr(language, "openDownloadedFile")} onClick={() => void openToastFile(toast.filePath!)}>{toast.filePath}</button>}</span><button onClick={() => setToast(null)} aria-label={tr(language, "dismissNotification")}><X size={13} /></button></div>}
    <ContextMenuHost />
  </div>;
}
