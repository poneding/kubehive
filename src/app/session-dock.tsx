import { Badge, Button, ScrollArea } from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  Box, ChevronDown, Container, Download, FolderOpen, Info, LoaderCircle,
  Maximize2, Minimize2, Pencil, Plus, RefreshCw, RotateCcw, ScrollText, Search,
  ShieldCheck, SquareTerminal, X, ZoomIn, ZoomOut,
} from "lucide-react";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ansiToPlainText } from "../ansi-log";
import { backend, nativeBackendAvailable } from "../backend";
import { Combobox } from "../combobox";
import { ContainerFileExplorer } from "../container-file-explorer";
import { openContextMenu } from "../context-menu";
import { tr } from "../i18n";
import { LogOutputScrollArea } from "../log-output-scroll-area";
import { convertManifest, firstManifestError, manifestHasErrors, validateManifestText, type ManifestFormat } from "../manifest-format";
import type { AppLanguage } from "../preferences";
import { useHorizontalTabRail } from "../tab-scroll";
import { TextSearchPopover, useTextSearch } from "../text-search";
import { settleContentZoomFactor } from "../zoom";
import { allPodContainers, listPodTargets } from "./pod-session-targets";
import { isFindShortcut, isSessionFindContext, noteSessionDockFindContext } from "./table-search";
import { useSessionContentZoom } from "./use-session-content-zoom";
import type { AppToast, BottomRequest, BottomSession, BottomSessionCache, BottomSessionCacheMap, PodSessionTarget, RuntimeMapUpdater, TerminalRuntime, TerminalRuntimeMap } from "./types";

const ContainerTerminal = lazy(() => import("../container-terminal"));
const ManifestEditor = lazy(() => import("../manifest-editor"));

function cleanTerminalOutput(value: string) {
  return value
    .replace(/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "")
    .replace(/\r/g, "");
}

// Mirrors --workspace-tabs-height in index.css. The bottom dock grows until it
// meets the bottom of the workspace tab strip; .sheet-bottom's max-height keeps
// that guarantee even if the two ever drift apart.
const WORKSPACE_TABS_HEIGHT = 40;
const SESSION_DOCK_MIN_HEIGHT = 220;
const sessionDockMaximumHeight = () => Math.max(SESSION_DOCK_MIN_HEIGHT, window.innerHeight - WORKSPACE_TABS_HEIGHT);

function BottomActionSheet({ clusterId, sessions, activeId, collapsed, searchOpen, onSearchOpenChange, language, appTheme, contentTheme, monoFont, contentFontSize, contentZoom, onContentZoom, terminalRuntimes, sessionCaches, onUpdateTerminalRuntimes, onUpdateSessionCaches, onActivate, onCloseSession, onCloseOthers, onCloseAll, onCreateSession, onToggleCollapsed, onApplied, onToast }: {
  clusterId: string;
  sessions: BottomSession[];
  activeId: string;
  collapsed: boolean;
  searchOpen: boolean;
  onSearchOpenChange: (open: boolean) => void;
  language: AppLanguage;
  appTheme: "light" | "dark";
  contentTheme: "light" | "dark";
  monoFont: string;
  contentFontSize: number;
  contentZoom: number;
  onContentZoom: (next: number) => void;
  terminalRuntimes: TerminalRuntimeMap;
  sessionCaches: BottomSessionCacheMap;
  onUpdateTerminalRuntimes: RuntimeMapUpdater<TerminalRuntimeMap>;
  onUpdateSessionCaches: RuntimeMapUpdater<BottomSessionCacheMap>;
  onActivate: (id: string) => void;
  onCloseSession: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onCloseAll: () => void;
  onCreateSession: (request: BottomRequest) => void;
  onToggleCollapsed: () => void;
  onApplied: () => void;
  onToast: (tone: AppToast["tone"], message: string, filePath?: string) => void;
}) {
  const state = sessions.find((session) => session.id === activeId) ?? sessions[0];
  const nodeTerminal = state?.mode === "terminal" && (state.terminalTarget === "node" || (state.terminalTarget === undefined && (state.item?.row?.kind === "Node" || state.item?.kind === "Node")));
  const containerTerminal = state?.mode === "terminal" && !nodeTerminal && (state.terminalTarget === "container" || (state.terminalTarget === undefined && Boolean(state.item)));
  const fileExplorer = state?.mode === "files";
  const nodeFiles = fileExplorer && state?.terminalTarget === "node";
  const nodeName = state?.item?.row?.name || state?.item?.label || state?.label || "";
  const [height, setHeight] = useState(() => {
    const maximum = sessionDockMaximumHeight();
    return Math.max(220, Math.min(maximum, Number(localStorage.getItem("kubehive.sessionHeight")) || 450));
  });
  const [maximized, setMaximized] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [podTargets, setPodTargets] = useState<PodSessionTarget[]>([]);
  const [targetsLoading, setTargetsLoading] = useState(false);
  const [targetError, setTargetError] = useState("");
  const [nodeFileSessionError, setNodeFileSessionError] = useState<{ key: string; message: string } | null>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const tabListRef = useHorizontalTabRail(state?.id);
  const terminalRuntimesRef = useRef<TerminalRuntimeMap>(terminalRuntimes);
  const sessionCachesRef = useRef<BottomSessionCacheMap>(sessionCaches);
  const nodeFileStartRef = useRef<Set<string>>(new Set());
  const nodeFileSessionKey = nodeFiles && state ? `${clusterId}::${state.id}` : "";
  const nodeFileTarget = nodeFileSessionKey ? sessionCachesRef.current[nodeFileSessionKey]?.nodeFileTarget : undefined;
  const nodeFileSessionFailure = nodeFileSessionError?.key === nodeFileSessionKey ? nodeFileSessionError.message : "";
  const nodeFileTargetLoading = Boolean(nodeFileSessionKey && nodeName && !nodeFileTarget && !nodeFileSessionFailure);
  const targetsReadySessionRef = useRef("");
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  terminalRuntimesRef.current = terminalRuntimes;
  sessionCachesRef.current = sessionCaches;
  const { applyContentZoom, contentZoomPercent, contentZoomRef, scaledContentFontSize, zoomWidgetVisible } = useSessionContentZoom(contentZoom, contentFontSize, onContentZoom);

  const fallbackManifest = state ? `apiVersion: ${state.descriptor?.apiVersion ?? "apps/v1"}\nkind: ${state.descriptor?.kind ?? "Deployment"}\nmetadata:\n  name: ${state.item?.label ?? "new-resource"}\n  namespace: ${state.item?.subtitle && state.item.subtitle !== "—" ? state.item.subtitle : "default"}\nspec:\n  replicas: 1` : "";
  const runtimeKey = state ? `${clusterId}::${state.id}` : "";
  const sessionCache = runtimeKey ? sessionCaches[runtimeKey] : undefined;
  const manifestText = sessionCache?.manifestText ?? state?.manifest ?? state?.item?.manifest ?? fallbackManifest;
  const manifestFormat = sessionCache?.manifestFormat ?? "yaml";
  const manifestValidation = useMemo(() => validateManifestText(manifestText, manifestFormat), [manifestText, manifestFormat]);
  const output = sessionCache?.output ?? "";
  const feedback = sessionCache?.feedback ?? "";
  const selectedPodKey = sessionCache?.selectedPodKey ?? "";
  const selectedContainer = sessionCache?.selectedContainer ?? "";
  const logTailLines = sessionCache?.logTailLines ?? 1000;
  const logPrevious = sessionCache?.logPrevious ?? false;
  const logFollow = sessionCache?.logFollow ?? true;
  const logTimestamps = sessionCache?.logTimestamps ?? false;
  const logWrapLines = sessionCache?.logWrapLines ?? true;
  const editorWrapLines = sessionCache?.editorWrapLines ?? true;
  const terminalReloadToken = sessionCache?.terminalReloadToken ?? 0;
  const patchSessionCache = (patch: Partial<BottomSessionCache>) => {
    if (!state) return;
    onUpdateSessionCaches((current) => ({ ...current, [runtimeKey]: { ...current[runtimeKey], ...patch } }));
  };
  const setManifestText = (value: string) => patchSessionCache({ manifestText: value, feedback: "" });
  const setOutput = (value: string) => patchSessionCache({ output: value });
  const setFeedback = (value: string) => patchSessionCache({ feedback: value });
  const setSelectedPodKey = (value: string) => patchSessionCache({ selectedPodKey: value });
  const setSelectedContainer = (value: string) => patchSessionCache({ selectedContainer: value });
  const setLogTailLines = (value: number) => patchSessionCache({ logTailLines: value });
  const setLogPrevious = (value: boolean) => patchSessionCache({ logPrevious: value });
  const setLogFollow = (value: boolean) => patchSessionCache({ logFollow: value });
  const setLogTimestamps = (value: boolean) => patchSessionCache({ logTimestamps: value });
  const setLogWrapLines = (value: boolean) => patchSessionCache({ logWrapLines: value });
  const setEditorWrapLines = (value: boolean) => patchSessionCache({ editorWrapLines: value });
  const activeTerminalRuntime = state?.mode === "terminal" ? terminalRuntimes[runtimeKey] : undefined;
  const terminalOutput = activeTerminalRuntime?.output ?? "";
  const terminalStatus = activeTerminalRuntime?.status ?? "idle";
  const terminalSessionId = activeTerminalRuntime?.sessionId ?? "";
  const textSearch = useTextSearch(state?.mode === "edit" || state?.mode === "create" ? manifestText : state?.mode === "terminal" ? cleanTerminalOutput(terminalOutput) : state?.mode === "logs" ? ansiToPlainText(output) : output);
  const dockRef = useRef<HTMLElement>(null);
  const resize = useRef<{ startY: number; startHeight: number; currentHeight: number } | null>(null);
  useEffect(() => localStorage.setItem("kubehive.sessionHeight", String(height)), [height]);
  useEffect(() => { const close = (event: MouseEvent) => { if (!addMenuRef.current?.contains(event.target as Node)) setAddMenuOpen(false); }; window.addEventListener("mousedown", close); return () => window.removeEventListener("mousedown", close); }, []);
  useEffect(() => {
    const move = (event: PointerEvent) => { if (!resize.current || !dockRef.current) return; const maximum = sessionDockMaximumHeight(); const next = Math.max(38, Math.min(maximum, resize.current.startHeight + resize.current.startY - event.clientY)); resize.current.currentHeight = next; dockRef.current.style.height = `${next}px`; };
    const stop = () => { if (!resize.current) return; const finalHeight = resize.current.currentHeight; resize.current = null; setHeight(finalHeight); document.body.classList.remove("resizing-session-sheet"); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop); window.addEventListener("pointercancel", stop);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); window.removeEventListener("pointercancel", stop); document.body.classList.remove("resizing-session-sheet"); };
  }, []);
  useEffect(() => {
    if (!state) return;
    onSearchOpenChange(false);
    textSearch.setQuery("");
  }, [state?.id]);
  const openSessionSearch = useCallback(() => {
    onSearchOpenChange(true);
    setSearchFocusRequest((value) => value + 1);
  }, [onSearchOpenChange]);
  // Capture-phase Cmd/Ctrl+F so logs (non-editable) and dock chrome still open
  // the shared find popover when focus or the event target lives in the sheet.
  useEffect(() => {
    if (collapsed || !state || state.mode === "files") return;
    const handler = (event: KeyboardEvent) => {
      if (!isFindShortcut(event)) return;
      if (!isSessionFindContext(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      openSessionSearch();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [collapsed, state?.mode, openSessionSearch]);
  useEffect(() => {
    if (!state || nodeFiles || (state.mode !== "logs" && !containerTerminal && state.mode !== "files")) return;
    let cancelled = false;
    targetsReadySessionRef.current = "";
    setTargetsLoading(true);
    setTargetError("");
    setPodTargets([]);
    void listPodTargets(clusterId, state.item).then((targets) => {
      if (cancelled) return;
      setPodTargets(targets);
      const saved = sessionCachesRef.current[`${clusterId}::${state.id}`];
      const runtime = containerTerminal ? terminalRuntimesRef.current[`${clusterId}::${state.id}`] : undefined;
      const first = targets.find((target) => target.key === saved?.selectedPodKey)
        ?? targets.find((target) => target.key === runtime?.podKey)
        ?? targets[0];
      const firstContainers = allPodContainers(first);
      const selected = [saved?.selectedContainer, runtime?.container].find((container) => container && firstContainers.includes(container)) ?? firstContainers[0] ?? "";
      setSelectedPodKey(first?.key ?? "");
      setSelectedContainer(selected);
      targetsReadySessionRef.current = state.id;
      if (!first) setTargetError("No matching pod is available for this session");
    }).catch((error) => {
      if (!cancelled) setTargetError(String(error));
    }).finally(() => {
      if (!cancelled) setTargetsLoading(false);
    });
    return () => { cancelled = true; };
  }, [clusterId, state?.id, state?.mode, containerTerminal, nodeFiles]);
  const selectedPod = podTargets.find((target) => target.key === selectedPodKey) ?? podTargets[0];
  // Node file sessions: resolve the shared helper Pod on the target Node once.
  // The resolved container target (hostRoot: true) is cached with the session
  // and released in disposeBottomSessions / disposeClusterSessions.
  useEffect(() => {
    if (!state || !nodeFiles || !nodeName) return;
    const cacheKey = `${clusterId}::${state.id}`;
    if (sessionCachesRef.current[cacheKey]?.nodeFileTarget || nodeFileStartRef.current.has(cacheKey) || nodeFileSessionError?.key === cacheKey) return;
    if (!nativeBackendAvailable) {
      setNodeFileSessionError({ key: cacheKey, message: tr(language, "nativeAppRequired") });
      return;
    }
    nodeFileStartRef.current.add(cacheKey);
    let cancelled = false;
    void backend.startNodeFileSession({ clusterId, node: nodeName }).then((target) => {
      if (cancelled) { void backend.stopNodeFileSession({ clusterId, node: nodeName }); return; }
      onUpdateSessionCaches((current) => {
        const cache = current[cacheKey] ?? {};
        if (cache.nodeFileTarget) return current;
        return { ...current, [cacheKey]: { ...cache, nodeFileTarget: target, nodeFileName: nodeName } };
      });
    }).catch((error) => {
      if (!cancelled) setNodeFileSessionError({ key: cacheKey, message: String(error) });
    }).finally(() => {
      nodeFileStartRef.current.delete(cacheKey);
    });
    return () => { cancelled = true; };
  }, [clusterId, state?.id, state?.mode, state?.terminalTarget, nodeName, nodeFiles, nodeFileSessionError?.key, language, onUpdateSessionCaches]);
  useEffect(() => {
    if (!state || (state.mode !== "logs" && !containerTerminal && state.mode !== "files") || !selectedPod) return;
    const containers = allPodContainers(selectedPod);
    if (!containers.includes(selectedContainer)) setSelectedContainer(containers[0] ?? "");
  }, [state?.mode, containerTerminal, selectedPodKey, selectedPod, selectedContainer]);
  useEffect(() => {
    if (!state || state.mode !== "terminal" || (containerTerminal && (!selectedPod || targetsReadySessionRef.current !== state.id))) return;
    if (nodeTerminal && !nodeName) return;
    const sessionId = runtimeKey;
    const targetLabel = nodeTerminal
      ? `Node ${nodeName}`
      : containerTerminal
        ? `${selectedPod!.namespace}/${selectedPod!.pod}${selectedContainer ? ` · ${selectedContainer}` : ""}`
        : "Local shell · active cluster";
    const connectionKey = nodeTerminal
      ? `${clusterId}|node|${nodeName}|${terminalReloadToken}`
      : containerTerminal
        ? `${clusterId}|${selectedPod!.key}|${selectedContainer}|${terminalReloadToken}`
        : `${clusterId}|${terminalReloadToken}`;
    const existing = terminalRuntimesRef.current[sessionId];
    if (existing?.connectionKey === connectionKey && (existing.status === "connected" || existing.status === "connecting")) return;
    if (existing?.sessionId && nativeBackendAvailable) void backend.stopTerminal(existing.sessionId);
    const terminalKind = nodeTerminal ? "Node" : containerTerminal ? "Container" : "Local";
    onUpdateTerminalRuntimes((current) => ({
      ...current,
      [sessionId]: {
        sessionId: "", output: "", status: "connecting", feedback: `${nodeTerminal || containerTerminal ? "Connecting" : "Starting"} · ${targetLabel}`, connectionKey, targetLabel,
        podKey: containerTerminal ? selectedPod!.key : undefined,
        container: containerTerminal ? selectedContainer : undefined,
      },
    }));

    const updateRuntime = (update: (runtime: TerminalRuntime) => TerminalRuntime) => {
      onUpdateTerminalRuntimes((current) => {
        const runtime = current[sessionId];
        if (!runtime || runtime.connectionKey !== connectionKey) return current;
        return { ...current, [sessionId]: update(runtime) };
      });
    };

    if (!nativeBackendAvailable) {
      updateRuntime((runtime) => ({ ...runtime, status: "disconnected", feedback: tr(language, "nativeAppRequired"), sessionId: "" }));
      return;
    }

    const onMessage = (message: { eventType: string; data?: string | null }) => {
      if (message.eventType === "connected") {
        updateRuntime((runtime) => ({ ...runtime, status: "connected", feedback: message.data || `Connected · ${targetLabel}` }));
      } else if (message.eventType === "output") {
        const chunk = message.data ?? "";
        if (chunk) updateRuntime((runtime) => ({ ...runtime, output: `${runtime.output}${chunk}`.slice(-2_000_000) }));
      } else if (message.eventType === "error") {
        updateRuntime((runtime) => ({ ...runtime, feedback: message.data || `${terminalKind} terminal failed` }));
      } else if (message.eventType === "disconnected") {
        updateRuntime((runtime) => ({ ...runtime, status: "disconnected", feedback: message.data || `${terminalKind} terminal disconnected`, sessionId: "" }));
      }
    };
    const start = nodeTerminal
      ? backend.startNodeTerminal({ clusterId, node: nodeName, command: [] }, onMessage)
      : containerTerminal
        ? backend.startTerminal({ clusterId, namespace: selectedPod!.namespace, pod: selectedPod!.pod, container: selectedContainer || undefined, command: [] }, onMessage)
        : backend.startLocalTerminal(clusterId, onMessage);
    void start.then((nextSessionId) => {
      onUpdateTerminalRuntimes((current) => {
        const runtime = current[sessionId];
        if (!runtime || runtime.connectionKey !== connectionKey) {
          void backend.stopTerminal(nextSessionId);
          return current;
        }
        return { ...current, [sessionId]: { ...runtime, sessionId: nextSessionId } };
      });
    }).catch((error) => {
      updateRuntime((runtime) => ({ ...runtime, status: "disconnected", feedback: String(error), sessionId: "" }));
    });
  }, [clusterId, state?.id, state?.mode, containerTerminal, nodeTerminal, nodeName, selectedPod?.key, selectedContainer, terminalReloadToken, language]);
  // Identity of the log document on screen: pod, container and fetch window. A change
  // means a different log, so the viewer starts tailing the newest line again.
  const logTargetKey = `${runtimeKey}::${selectedPod?.key ?? ""}::${selectedContainer}::${logPrevious}::${logTailLines}`;
  useEffect(() => {
    if (!state || state.mode !== "logs" || !selectedPod) return;
    if (!nativeBackendAvailable) {
      setOutput(tr(language, "nativeAppRequired"));
      setFeedback(tr(language, "nativeAppRequired"));
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const logs = await backend.podLogs({ clusterId, namespace: selectedPod.namespace, pod: selectedPod.pod, container: selectedContainer || undefined, tailLines: logTailLines, timestamps: logTimestamps, previous: logPrevious });
        if (!cancelled) { setOutput(logs || "No log lines returned"); setFeedback(""); }
      } catch (nextError) { if (!cancelled) { setOutput(String(nextError)); setFeedback("Log request failed"); } }
    };
    if (!sessionCachesRef.current[runtimeKey]?.output) setOutput("Connecting to pod log stream…");
    void load();
    if (logFollow) timer = window.setInterval(load, 5000);
    return () => { cancelled = true; if (timer) window.clearInterval(timer); };
  }, [clusterId, state?.id, state?.mode, selectedPod?.key, selectedContainer, logFollow, logTailLines, logPrevious, logTimestamps, language]);
  if (!state) return null;
  const readOnlyReason = state.readOnlyReason;
  const manifestReadOnly = Boolean(readOnlyReason);
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => { event.preventDefault(); event.stopPropagation(); const currentHeight = collapsed ? 38 : dockRef.current?.getBoundingClientRect().height ?? height; if (collapsed) { setHeight(38); onToggleCollapsed(); } else if (maximized) setHeight(currentHeight); setMaximized(false); resize.current = { startY: event.clientY, startHeight: currentHeight, currentHeight }; document.body.classList.add("resizing-session-sheet"); };
  const sessionHeightMaximum = sessionDockMaximumHeight();
  const resizeSessionWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 48 : 24;
    const current = collapsed ? 38 : maximized ? sessionHeightMaximum : height;
    let next: number | undefined;
    if (event.key === "ArrowUp") next = collapsed ? 220 : current + step;
    if (event.key === "ArrowDown") next = current - step;
    if (event.key === "Home") next = 38;
    if (event.key === "End") next = sessionHeightMaximum;
    if (next === undefined) return;
    event.preventDefault();
    next = Math.max(38, Math.min(sessionHeightMaximum, next));
    if (next === 38 && !collapsed) onToggleCollapsed();
    if (next > 38 && collapsed) onToggleCollapsed();
    setMaximized(false);
    setHeight(next);
  };
  const sessionModeLabel = (session: BottomSession) => {
    if (session.mode === "terminal") {
      if (session.terminalTarget === "node" || session.item?.row?.kind === "Node" || session.item?.kind === "Node") return tr(language, "nodeTerminal");
      if (session.terminalTarget === "container" || (session.terminalTarget === undefined && session.item)) return tr(language, "containerTerminal");
      return tr(language, "localTerminal");
    }
    if (session.mode === "logs") return tr(language, "logs");
    if (session.mode === "files") return session.terminalTarget === "node" || session.item?.row?.kind === "Node" || session.item?.kind === "Node" ? tr(language, "nodeFiles") : tr(language, "files");
    if (session.mode === "edit") return session.readOnlyReason ? tr(language, "view") : tr(language, "edit");
    return tr(language, "create");
  };
  const sessionTitle = (session: BottomSession) => `${sessionModeLabel(session)} · ${session.label ?? session.item?.label ?? "cluster"}`;
  const terminalOption = tr(language, "newLocalTerminal");
  const resourceOption = tr(language, "createResource");
  const showPodTarget = state.item?.row?.kind !== "Pod";
  const podOptions = podTargets.length
    ? podTargets.map((target) => ({ value: target.key, label: target.pod, description: `${target.namespace} · ${target.phase}${target.ready ? " · Ready" : ""}`, icon: Box }))
    : [{ value: "", label: targetsLoading ? "Resolving..." : "Unavailable", description: targetError || undefined, icon: Box }];
  const availableContainerOptions = [
    ...(selectedPod?.initContainers ?? []).map((container) => ({ value: container, label: container, group: "Init Containers", icon: Container })),
    ...(selectedPod?.containers ?? []).map((container) => ({ value: container, label: container, group: "Containers", icon: Container })),
  ];
  const containerOptions = availableContainerOptions.length
    ? availableContainerOptions
    : [{ value: "", label: targetsLoading ? "Resolving..." : "Unavailable", description: targetError || undefined, icon: Container }];
  const updateActiveTerminalRuntime = (update: (runtime: TerminalRuntime) => TerminalRuntime) => {
    if (!state || state.mode !== "terminal") return;
    const id = runtimeKey;
    onUpdateTerminalRuntimes((current) => {
      const runtime = current[id];
      if (!runtime) return current;
      return { ...current, [id]: update(runtime) };
    });
  };
  const reconnectTerminal = () => {
    updateActiveTerminalRuntime((runtime) => ({ ...runtime, status: "connecting", feedback: tr(language, "reconnecting") }));
    patchSessionCache({ terminalReloadToken: terminalReloadToken + 1 });
  };
  const writeTerminalInput = (data: string) => {
    if (terminalStatus !== "connected") return;
    if (!nativeBackendAvailable) return;
    if (!terminalSessionId) {
      updateActiveTerminalRuntime((runtime) => ({ ...runtime, status: "disconnected", feedback: tr(language, "terminalUnavailable") }));
      return;
    }
    void backend.writeTerminal(terminalSessionId, data).catch((error) => {
      updateActiveTerminalRuntime((runtime) => ({ ...runtime, status: "disconnected", feedback: String(error) }));
    });
  };
  const resizeContainerTerminal = (columns: number, rows: number) => {
    if (nativeBackendAvailable && terminalSessionId) void backend.resizeTerminal(terminalSessionId, columns, rows).catch(() => undefined);
  };
  const changeManifestFormat = (nextFormat: ManifestFormat) => {
    if (nextFormat === manifestFormat || busy || manifestReadOnly) return;
    try {
      const converted = convertManifest(manifestText, manifestFormat, nextFormat);
      patchSessionCache({
        manifestText: converted,
        manifestFormat: nextFormat,
        feedback: manifestFormat === "yaml" && nextFormat === "json"
          ? "Converted to JSON; YAML comments and formatting were normalized"
          : `Converted to ${nextFormat.toUpperCase()}`,
      });
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
    }
  };
  const apply = async (closeAfter = false) => {
    if (manifestReadOnly) { setFeedback(readOnlyReason ?? "This manifest is read-only"); return; }
    const format = manifestFormat;
    const manifest = manifestText;
    const localValidation = validateManifestText(manifest, format);
    const localError = firstManifestError(localValidation);
    if (localError) { setFeedback(localError.message); return; }
    if (!nativeBackendAvailable) { setFeedback(tr(language, "nativeAppRequired")); return; }
    setBusy(true); setFeedback(`Applying ${format.toUpperCase()} with Kubernetes API…`);
    try {
      await backend.applyManifest({ clusterId, manifest, format, resource: state.descriptor ?? state.item?.row?.descriptor, force: false });
      setFeedback("Applied successfully");
      onApplied();
      if (closeAfter) onCloseSession(state.id);
    } catch (nextError) { setFeedback(String(nextError)); }
    finally { setBusy(false); }
  };
  const validateActiveManifest = async () => {
    const format = manifestFormat;
    const manifest = manifestText;
    const localValidation = validateManifestText(manifest, format);
    const localError = firstManifestError(localValidation);
    if (localError) { setFeedback(localError.message); return; }
    if (!nativeBackendAvailable) { setFeedback(tr(language, "nativeAppRequired")); return; }
    setBusy(true); setFeedback(`Validating ${format.toUpperCase()} with Kubernetes API…`);
    try {
      await backend.applyManifest({ clusterId, manifest, format, resource: state.descriptor ?? state.item?.row?.descriptor, dryRun: true, force: false });
      setFeedback(`${format.toUpperCase()} is valid`);
    } catch (nextError) { setFeedback(String(nextError)); }
    finally { setBusy(false); }
  };
  const reloadManifest = async () => {
    if (state.mode !== "edit" || busy) return;
    const row = state.item?.row;
    const descriptor = state.descriptor ?? row?.descriptor;
    const name = row?.kind === "HelmRelease" ? row.backend?.name : (row?.name ?? state.item?.label);
    const namespace = row
      ? (row.namespace === "—" ? undefined : row.namespace)
      : (state.item?.subtitle && state.item.subtitle !== "—" ? state.item.subtitle : undefined);
    if (!descriptor || !name) { setFeedback(tr(language, "reloadManifestUnavailable")); return; }
    if (!nativeBackendAvailable) { setFeedback(tr(language, "nativeAppRequired")); return; }
    setBusy(true); setFeedback(tr(language, "reloadingManifest"));
    try {
      const response = await backend.getResource({ clusterId, resource: descriptor, namespace, name });
      const text = manifestFormat === "json" ? convertManifest(response.manifest, "yaml", "json") : response.manifest;
      patchSessionCache({ manifestText: text, feedback: tr(language, "manifestReloaded") });
    } catch (nextError) { setFeedback(String(nextError)); }
    finally { setBusy(false); }
  };
  const handleSessionShortcut = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!isFindShortcut(event)) return;
    if (state.mode === "files") return;
    event.preventDefault();
    event.stopPropagation();
    openSessionSearch();
  };
  const runtimeStatus = state.mode === "terminal" ? terminalStatus : state.mode === "files" ? "ready" : feedback ? "error" : logFollow ? "live" : "paused";
  const runtimeTone = runtimeStatus === "connected" || runtimeStatus === "live"
    ? "green"
    : runtimeStatus === "connecting"
      ? "amber"
      : runtimeStatus === "disconnected" || runtimeStatus === "error"
        ? "red"
        : "neutral";
  const runtimeStatusLabel = `${state.mode === "terminal" ? "Terminal" : "Logs"} ${runtimeStatus}`;
  const manifestSearchMatch = searchOpen && textSearch.query ? textSearch.matches[textSearch.currentIndex] : undefined;
  const editorFeedbackTone = feedback.includes("success") || feedback.includes(" is valid") || feedback.startsWith("Converted") || feedback === tr(language, "manifestReloaded")
    ? "green"
    : feedback.includes("Applying") || feedback.includes("Validating") || feedback === tr(language, "reloadingManifest")
      ? "neutral"
      : "red";
  const downloadLogs = async () => {
    if (!output || !selectedPod) return;
    if (nativeBackendAvailable) {
      try {
        const path = await backend.downloadLogs({ content: output, pod: selectedPod.pod, container: selectedContainer || undefined });
        onToast("success", "Logs downloaded to", path);
      } catch (error) {
        onToast("error", `Unable to download logs: ${String(error)}`);
      }
      return;
    }
    const blob = new Blob([output], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const targetName = [selectedPod.pod, selectedContainer].filter(Boolean).join("-").replace(/[^a-zA-Z0-9_.-]+/g, "-");
    const filename = `${targetName || "pod"}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    onToast("success", `Logs downloaded as ${filename}`);
  };
  const renderFileTargetSelectors = (inPanel = false) => <>
    {showPodTarget && <Combobox className={cn("session-target-combobox", "pod-target-combobox", inPanel && "file-explorer-target-panel-combobox")} ariaLabel="Pod" leadingIcon={Box} searchable={false} value={selectedPodKey} options={podOptions} onChange={setSelectedPodKey} />}
    <Combobox className={cn("session-target-combobox", "container-target-combobox", inPanel && "file-explorer-target-panel-combobox")} ariaLabel="Container" leadingIcon={Container} searchable={false} value={selectedContainer} options={containerOptions} onChange={setSelectedContainer} />
    {targetsLoading && <LoaderCircle className="spin session-action-spinner" size={13} />}
  </>;
  const fileSessionTargets = fileExplorer && !nodeFiles ? <div className="file-explorer-session-targets">
    <div className="file-explorer-session-targets-inline">{renderFileTargetSelectors()}</div>
    <div className="file-explorer-session-targets-overflow">
      <button type="button" aria-haspopup="dialog" aria-label={tr(language, "showTargetSelectors")} title={tr(language, "targetSelectors")}><Container size={14} /></button>
      <div className="file-explorer-session-targets-panel" role="group" aria-label={tr(language, "targetSelectors")}>{renderFileTargetSelectors(true)}</div>
    </div>
  </div> : undefined;
  const fileExplorerTarget = nodeFiles
    ? nodeFileTarget
    : selectedPod ? { clusterId, namespace: selectedPod.namespace, pod: selectedPod.pod, container: selectedContainer || undefined } : undefined;
  const fileExplorerInstanceKey = [runtimeKey, fileExplorerTarget?.clusterId, fileExplorerTarget?.namespace, fileExplorerTarget?.pod, fileExplorerTarget?.container, fileExplorerTarget?.hostRoot ? "host" : "container"].join("\u0000");

  return <section ref={dockRef} data-session-find={!collapsed && state.mode !== "files" ? "true" : "false"} onKeyDown={handleSessionShortcut} onPointerDownCapture={(event) => noteSessionDockFindContext(event.target)} className={cn("sheet sheet-bottom session-dock", collapsed && "collapsed", maximized && "maximized", !fileExplorer && (state.mode === "logs" || state.mode === "terminal" || state.mode === "edit" || state.mode === "create") && `content-theme-${contentTheme}`)} style={collapsed || maximized ? undefined : { height }}><div className="sheet-resize-edge horizontal" aria-label={tr(language, "resizeSessions")} aria-orientation="horizontal" aria-valuemin={38} aria-valuemax={sessionHeightMaximum} aria-valuenow={collapsed ? 38 : maximized ? sessionHeightMaximum : Math.round(height)} aria-valuetext={`${collapsed ? 38 : maximized ? sessionHeightMaximum : Math.round(height)} pixels`} role="separator" tabIndex={0} onKeyDown={resizeSessionWithKeyboard} onPointerDown={startResize} /><div className="session-tabbar"><ScrollArea className="bottom-session-tabs-scroll-area" viewportClassName="bottom-session-tabs" viewportRef={tabListRef} scrollbars="horizontal" hideScrollbars type="hover"><div className="bottom-session-tabs-content">{sessions.map((session) => {
    const Icon = session.mode === "terminal" ? SquareTerminal : session.mode === "logs" ? ScrollText : session.mode === "files" ? FolderOpen : session.mode === "edit" ? Pencil : Plus; return <button key={session.id} className={cn(session.id === state.id && "active")} onClick={() => onActivate(session.id)} onContextMenu={(event) => openContextMenu(event, [
      { type: "item", id: "close", label: tr(language, "close"), onSelect: () => onCloseSession(session.id) },
      { type: "item", id: "close-others", label: tr(language, "closeOthers"), disabled: sessions.length <= 1, onSelect: () => onCloseOthers(session.id) },
      { type: "item", id: "close-all", label: tr(language, "closeAll"), onSelect: onCloseAll },
    ])}><Icon size={12} /><span>{sessionTitle(session)}</span><i role="button" aria-label={`${tr(language, "close")} ${sessionTitle(session)}`} onClick={(event) => { event.stopPropagation(); onCloseSession(session.id); }}><X size={10} /></i></button>;
  })}</div></ScrollArea><div className="session-add" ref={addMenuRef}><Button variant="ghost" size="icon" className="session-add-trigger" aria-label={tr(language, "addSession")} title={tr(language, "addSession")} onClick={() => setAddMenuOpen((value) => !value)}><Plus size={13} /></Button>{addMenuOpen && <div className="session-add-menu"><button onClick={() => { onCreateSession({ mode: "terminal", terminalTarget: "local", sessionKey: `terminal-${Date.now()}`, label: terminalOption }); setAddMenuOpen(false); }}><SquareTerminal size={13} /><span>{terminalOption}</span></button><button onClick={() => { onCreateSession({ mode: "create", sessionKey: `resource-${Date.now()}`, label: resourceOption }); setAddMenuOpen(false); }}><Plus size={13} /><span>{resourceOption}</span></button></div>}</div><div className="session-tab-spacer" /><Button variant="ghost" size="icon" aria-label={maximized ? tr(language, "restoreSessions") : tr(language, "maximizeSessions")} onClick={() => { if (collapsed) onToggleCollapsed(); setMaximized((value) => !value); }}>{maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</Button><Button variant="ghost" size="icon" aria-label={collapsed ? tr(language, "expandSessions") : tr(language, "collapseSessions")} onClick={onToggleCollapsed}><ChevronDown className={cn(collapsed && "rotate-180")} size={15} /></Button></div>{!collapsed && <>{!fileExplorer && <div className="session-action-bar"><div className="session-primary-actions">{(state.mode === "edit" || state.mode === "create") && !manifestReadOnly && <><Button size="sm" disabled={busy || !manifestText.trim() || manifestHasErrors(manifestValidation)} onClick={() => void apply(false)}>{busy && <LoaderCircle className="spin" size={13} />}{tr(language, "apply")}</Button><Button variant="secondary" size="sm" disabled={busy || !manifestText.trim() || manifestHasErrors(manifestValidation)} onClick={() => void apply(true)}> {tr(language, "applyAndClose")}</Button></>}{state.mode === "edit" && <Button variant="secondary" size="icon" aria-label={tr(language, "reloadManifest")} title={tr(language, "reloadManifest")} disabled={busy} onClick={() => void reloadManifest()}><RefreshCw className={cn(busy && feedback === tr(language, "reloadingManifest") && "spin")} size={14} /></Button>}{readOnlyReason && <span className="manifest-read-only-notice" role="status"><Info size={13} aria-hidden="true" /><span>{readOnlyReason}</span></span>}{(state.mode === "logs" || state.mode === "terminal") && <span className={cn("session-runtime-status", `status-${runtimeTone}`)} role="status" aria-label={runtimeStatusLabel} title={runtimeStatusLabel} data-status={runtimeStatus} />}{(state.mode === "logs" || containerTerminal || fileExplorer) && <>{showPodTarget && <Combobox className="session-target-combobox pod-target-combobox" ariaLabel="Pod" leadingIcon={Box} searchable={false} value={selectedPodKey} options={podOptions} onChange={setSelectedPodKey} />}<Combobox className="session-target-combobox container-target-combobox" ariaLabel="Container" leadingIcon={Container} searchable={false} value={selectedContainer} options={containerOptions} onChange={setSelectedContainer} />{targetsLoading && <LoaderCircle className="spin session-action-spinner" size={13} />}</>}</div><div className="session-secondary-actions">{(state.mode === "edit" || state.mode === "create") && !manifestReadOnly && <><div className="manifest-format-switch" role="group" aria-label="Manifest format">{(["yaml", "json"] as ManifestFormat[]).map((format) => <button key={format} type="button" className={cn(manifestFormat === format && "active")} aria-pressed={manifestFormat === format} disabled={busy} onClick={() => changeManifestFormat(format)}>{format.toUpperCase()}</button>)}</div><Button variant="secondary" size="sm" disabled={busy || !manifestText.trim()} onClick={() => void validateActiveManifest()}><ShieldCheck size={13} />Validate {manifestFormat.toUpperCase()}</Button></>}{state.mode === "terminal" && terminalStatus === "disconnected" && <Button variant="outline" size="sm" onClick={() => void reconnectTerminal()}><RefreshCw size={13} />Reconnect</Button>}{state.mode === "logs" && <><Combobox className="session-tail-combobox" ariaLabel="Tail lines" label="Tail" searchable={false} value={String(logTailLines)} options={[100, 500, 1000, 5000, 10000].map((value) => ({ value: String(value), label: String(value) }))} onChange={(value) => setLogTailLines(Number(value))} /><label className="session-checkbox"><input type="checkbox" checked={logTimestamps} onChange={(event) => setLogTimestamps(event.target.checked)} /><span>Timestamps</span></label><label className="session-checkbox"><input type="checkbox" checked={logFollow} onChange={(event) => setLogFollow(event.target.checked)} /><span>Follow</span></label><label className="session-checkbox" title="Show logs from the previous terminated container instance"><input type="checkbox" aria-label="Previous terminated container logs" checked={logPrevious} onChange={(event) => setLogPrevious(event.target.checked)} /><span>Previous</span></label><label className="session-checkbox"><input type="checkbox" checked={logWrapLines} onChange={(event) => setLogWrapLines(event.target.checked)} /><span>Wrap</span></label><Button variant="secondary" size="icon" aria-label="Download logs" title="Download logs" disabled={!output} onClick={downloadLogs}><Download size={14} /></Button></>}{(state.mode === "edit" || state.mode === "create") && <label className="session-checkbox"><input type="checkbox" checked={editorWrapLines} onChange={(event) => setEditorWrapLines(event.target.checked)} /><span>Wrap</span></label>}{state.mode !== "files" && <Button variant="secondary" size="icon" aria-label="Find text" title={tr(language, "findTextShortcut")} onClick={() => { if (searchOpen) onSearchOpenChange(false); else openSessionSearch(); }}><Search size={14} /></Button>}</div></div>}{(state.mode === "edit" || state.mode === "create") && <div className="editor-layout"><Suspense fallback={<div className="manifest-editor-loading"><LoaderCircle className="spin" size={14} />Loading editor...</div>}><ManifestEditor key={`${runtimeKey}:${manifestFormat}`} documentId={runtimeKey} value={manifestText} format={manifestFormat} theme={contentTheme} fontFamily={monoFont} fontSize={scaledContentFontSize} diagnostics={manifestValidation.diagnostics} selection={manifestSearchMatch ? { from: manifestSearchMatch.start, to: manifestSearchMatch.end } : undefined} language={language} readOnly={manifestReadOnly} wrapLines={editorWrapLines} onChange={setManifestText} onFind={openSessionSearch} /></Suspense>{feedback && <Badge className="editor-feedback" tone={editorFeedbackTone}>{feedback}</Badge>}</div>}{state.mode === "logs" && <LogOutputScrollArea ariaLabel={tr(language, "logs")} fontFamily={monoFont} fontSize={scaledContentFontSize} wrapLines={logWrapLines} output={output} targetKey={logTargetKey} matches={textSearch.matches} currentIndex={textSearch.currentIndex} />}{state.mode === "terminal" && <div className="terminal-output terminal-interactive"><Suspense fallback={<div className="terminal-loading"><LoaderCircle className="spin" size={14} />Loading terminal...</div>}><ContainerTerminal language={language} sessionId={terminalSessionId} output={terminalOutput} connected={terminalStatus === "connected"} theme={contentTheme} fontFamily={monoFont} fontSize={scaledContentFontSize} search={textSearch} onInput={writeTerminalInput} onResize={resizeContainerTerminal} onFind={openSessionSearch} /></Suspense></div>}{state.mode === "files" && <ContainerFileExplorer key={fileExplorerInstanceKey} target={fileExplorerTarget} targetLoading={nodeFiles && nodeFileTargetLoading} targetUnavailableTitle={nodeFiles ? tr(language, "nodeFilesUnavailable") : undefined} targetUnavailableMessage={nodeFiles ? nodeFileSessionFailure || undefined : undefined} initialSnapshot={sessionCache?.fileExplorerSnapshot} onSnapshotChange={(fileExplorerSnapshot) => patchSessionCache({ fileExplorerSnapshot })} appTheme={appTheme} monoFont={monoFont} contentFontSize={scaledContentFontSize} language={language} sessionTargetControls={fileSessionTargets} onToast={onToast} />}{!collapsed && <div className="session-float-controls"><div className={cn("content-zoom-widget", !zoomWidgetVisible && "hidden-widget")} role="group" aria-label={tr(language, "contentZoomFeedback", { percent: contentZoomPercent })}><button type="button" aria-label={tr(language, "zoomOut")} title={tr(language, "zoomOut")} onClick={() => applyContentZoom(settleContentZoomFactor(contentZoomRef.current - 0.05))}><ZoomOut size={13} /></button><span>{contentZoomPercent}%</span><button type="button" aria-label={tr(language, "zoomIn")} title={tr(language, "zoomIn")} onClick={() => applyContentZoom(settleContentZoomFactor(contentZoomRef.current + 0.05))}><ZoomIn size={13} /></button><button type="button" aria-label={tr(language, "resetZoom")} title={tr(language, "resetZoom")} onClick={() => applyContentZoom(1)}><RotateCcw size={12} /></button></div><TextSearchPopover open={searchOpen} onClose={() => onSearchOpenChange(false)} search={textSearch} language={language} focusRequest={searchFocusRequest} /></div>}</>}</section>;
}

export { BottomActionSheet };
