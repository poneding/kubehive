import {
  ArrowLeft, ArrowUp, Copy, Download, File, FileCode2, FilePlus2,
  Folder, FolderOpen, FolderPlus, Grid2X2, HardDrive, House, List, LoaderCircle, MoreHorizontal,
  PenLine, Pencil, RefreshCw, Save, Search, Trash2, Upload, X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { backend, nativeBackendAvailable, type ContainerFileEntry, type ContainerFileTarget } from "./backend";
import { openContextMenu } from "./context-menu";
import { tr, type AppLanguage } from "./i18n";
import { Badge, Button, cn } from "./ui";
import "./container-file-explorer.css";

type FileViewMode = "list" | "grid";
type FileOperation = "create-file" | "create-directory" | "rename" | "move" | "copy";
type OperationDialog = { operation: FileOperation; entry?: ContainerFileEntry; entries?: ContainerFileEntry[] };
type DeleteDialogState = { entries: ContainerFileEntry[] };

const demoEntries: Record<string, ContainerFileEntry[]> = {
  "/": [
    { name: "app", path: "/app", kind: "directory", size: 0, modifiedAt: 1785229200, permissions: "755", readable: true, writable: true },
    { name: "etc", path: "/etc", kind: "directory", size: 0, modifiedAt: 1785228100, permissions: "755", readable: true, writable: false },
    { name: "tmp", path: "/tmp", kind: "directory", size: 0, modifiedAt: 1785227600, permissions: "777", readable: true, writable: true },
  ],
  "/workspace": [
    { name: "config.json", path: "/workspace/config.json", kind: "file", size: 1842, modifiedAt: 1785229200, permissions: "644", readable: true, writable: true },
    { name: "server.log", path: "/workspace/server.log", kind: "file", size: 387421, modifiedAt: 1785229180, permissions: "644", readable: true, writable: true },
    { name: "static", path: "/workspace/static", kind: "directory", size: 0, modifiedAt: 1785200000, permissions: "755", readable: true, writable: true },
  ],
  "/workspace/static": [
    { name: "index.html", path: "/workspace/static/index.html", kind: "file", size: 4912, modifiedAt: 1785200000, permissions: "644", readable: true, writable: true },
  ],
  "/home/app": [],
  "/app": [
    { name: "config.json", path: "/app/config.json", kind: "file", size: 1842, modifiedAt: 1785229200, permissions: "644", readable: true, writable: true },
    { name: "server.log", path: "/app/server.log", kind: "file", size: 387421, modifiedAt: 1785229180, permissions: "644", readable: true, writable: true },
    { name: "static", path: "/app/static", kind: "directory", size: 0, modifiedAt: 1785200000, permissions: "755", readable: true, writable: true },
  ],
  "/app/static": [
    { name: "index.html", path: "/app/static/index.html", kind: "file", size: 4912, modifiedAt: 1785200000, permissions: "644", readable: true, writable: true },
  ],
  "/etc": [
    { name: "hosts", path: "/etc/hosts", kind: "file", size: 219, modifiedAt: 1785100000, permissions: "644", readable: true, writable: false },
    { name: "resolv.conf", path: "/etc/resolv.conf", kind: "file", size: 178, modifiedAt: 1785100000, permissions: "644", readable: true, writable: false },
  ],
  "/tmp": [],
};

function normalizePath(value: string) {
  const parts: string[] = [];
  for (const part of value.trim().split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function joinPath(parent: string, name: string) {
  return normalizePath(`${parent}/${name}`);
}

function parentPath(path: string) {
  const parts = normalizePath(path).split("/").filter(Boolean);
  parts.pop();
  return `/${parts.join("/")}`;
}

const demoTextFiles: Record<string, string> = {
  "/workspace/config.json": "{\n  \"environment\": \"production\",\n  \"port\": 8080,\n  \"logLevel\": \"info\"\n}\n",
  "/workspace/server.log": "2026-07-30T15:18:01Z INFO container file Explorer demo\n",
  "/workspace/static/index.html": "<!doctype html>\n<html>\n  <head><title>KubeHive demo</title></head>\n  <body><main>Container file preview</main></body>\n</html>\n",
  "/app/config.json": "{\n  \"environment\": \"production\",\n  \"port\": 8080,\n  \"logLevel\": \"info\"\n}\n",
  "/app/server.log": "2026-07-30T15:18:01Z INFO container file Explorer demo\n",
  "/app/static/index.html": "<!doctype html>\n<html>\n  <head><title>KubeHive demo</title></head>\n  <body><main>Container file preview</main></body>\n</html>\n",
  "/etc/hosts": "127.0.0.1 localhost\n::1 localhost ip6-localhost\n",
  "/etc/resolv.conf": "nameserver 10.96.0.10\nsearch checkout.svc.cluster.local svc.cluster.local\n",
};

function cloneDemoFilesystem() {
  return Object.fromEntries(Object.entries(demoEntries).map(([path, entries]) => [path, entries.map((entry) => ({ ...entry }))]));
}

function relocateDemoFilesystem(current: Record<string, ContainerFileEntry[]>, source: string, destination: string, copy: boolean) {
  const result = Object.fromEntries(Object.entries(current).map(([path, entries]) => [path, entries.map((entry) => ({ ...entry }))]));
  const sourceParent = parentPath(source);
  const entry = result[sourceParent]?.find((item) => item.path === source);
  if (!entry) return result;
  if (!copy) result[sourceParent] = result[sourceParent].filter((item) => item.path !== source);
  const destinationParent = parentPath(destination);
  const destinationName = destination.split("/").filter(Boolean).at(-1) ?? entry.name;
  result[destinationParent] = [...(result[destinationParent] ?? []).filter((item) => item.path !== destination), { ...entry, name: destinationName, path: destination, modifiedAt: Math.floor(Date.now() / 1000) }];
  if (entry.kind === "directory") {
    Object.keys(current).filter((path) => path === source || path.startsWith(`${source}/`)).forEach((oldPath) => {
      const nextPath = `${destination}${oldPath.slice(source.length)}`;
      result[nextPath] = (current[oldPath] ?? []).map((item) => ({ ...item, path: `${destination}${item.path.slice(source.length)}` }));
      if (!copy) delete result[oldPath];
    });
  }
  return result;
}

function relocateDemoContents(current: Record<string, string>, source: string, destination: string, copy: boolean) {
  const result = { ...current };
  Object.keys(current).filter((path) => path === source || path.startsWith(`${source}/`)).forEach((oldPath) => {
    result[`${destination}${oldPath.slice(source.length)}`] = current[oldPath];
    if (!copy) delete result[oldPath];
  });
  return result;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return bytes === 0 ? "—" : "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** power;
  return `${value >= 10 || power === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[power]}`;
}

function formatModified(timestamp: number, language: AppLanguage) {
  if (!timestamp) return "—";
  return new Intl.DateTimeFormat(language === "en" ? "en" : language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp * 1000));
}

function fileIcon(entry: ContainerFileEntry, size = 18) {
  if (entry.kind === "directory") return <Folder size={size} />;
  if (/\.(?:txt|md|json|ya?ml|toml|ini|conf|config|log|xml|html?|css|js|jsx|ts|tsx|py|rb|go|rs|java|sh|bash|zsh|sql|env)$/i.test(entry.name)) return <FileCode2 size={size} />;
  return <File size={size} />;
}

function demoText(path: string, contents: Record<string, string>) {
  return contents[path] ?? "2026-07-30T15:18:01Z INFO container file Explorer demo\n";
}

function DeleteConfirmationDialog({ entries, busy, language, onClose, onConfirm }: {
  entries: ContainerFileEntry[];
  busy: boolean;
  language: AppLanguage;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const single = entries.length === 1 ? entries[0] : undefined;
  const prompt = single
    ? tr(language, "deleteFilePrompt", { kind: single.kind === "directory" ? tr(language, "folder") : tr(language, "file"), path: single.path, contents: single.kind === "directory" ? tr(language, "deleteContentsPrompt") : "" })
    : tr(language, "deleteSelectedPrompt", { count: entries.length, plural: entries.length === 1 ? "" : "s" });
  return <div className="file-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="file-operation-dialog file-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="file-delete-title" aria-describedby="file-delete-description" onMouseDown={(event) => event.stopPropagation()}>
      <header><span className="file-dialog-icon file-delete-dialog-icon"><Trash2 size={16} /></span><div><h3 id="file-delete-title">{tr(language, "delete")}</h3><small>{single?.path ?? tr(language, "selectedItems", { count: entries.length })}</small></div><Button variant="ghost" size="icon" disabled={busy} aria-label={tr(language, "close")} onClick={onClose}><X size={14} /></Button></header>
      <div className="file-delete-dialog-body"><p id="file-delete-description">{prompt}</p>{entries.length > 1 && <ul>{entries.slice(0, 6).map((entry) => <li key={entry.path}>{entry.path}</li>)}{entries.length > 6 && <li>+{entries.length - 6}</li>}</ul>}</div>
      <footer><Button variant="outline" size="sm" disabled={busy} onClick={onClose}>{tr(language, "cancel")}</Button><Button autoFocus size="sm" className="hover-destructive" disabled={busy} onClick={onConfirm}>{busy && <LoaderCircle className="spin" size={13} />}{tr(language, "delete")}</Button></footer>
    </section>
  </div>;
}

function OperationDialog({ state, busy, language, onClose, onSubmit }: {
  state: OperationDialog;
  busy: boolean;
  language: AppLanguage;
  onClose: () => void;
  onSubmit: (value: string) => void;
}) {
  const create = state.operation === "create-file" || state.operation === "create-directory";
  const transfer = state.operation === "move" || state.operation === "copy";
  const batchEntries = state.entries ?? [];
  const batchTransfer = transfer && batchEntries.length > 0;
  const title = state.operation === "create-file" ? tr(language, "createFile")
    : state.operation === "create-directory" ? tr(language, "createFolder")
      : state.operation === "rename" ? tr(language, "rename")
        : state.operation === "move" ? tr(language, "moveToPath")
          : tr(language, "copyToPath");
  const defaultValue = create ? "" : state.operation === "rename" ? state.entry?.name ?? "" : batchTransfer ? "/tmp" : state.entry?.path ?? "";
  const [value, setValue] = useState(defaultValue);
  const invalid = !value.trim() || ((create || state.operation === "rename") && (value.includes("/") || value === "." || value === "..")) || (transfer && !value.trim().startsWith("/"));
  return <div className="file-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="file-operation-dialog" role="dialog" aria-modal="true" aria-labelledby="file-operation-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><span className="file-dialog-icon">{state.operation === "create-directory" ? <FolderPlus size={16} /> : state.operation === "create-file" ? <FilePlus2 size={16} /> : state.operation === "copy" ? <Copy size={16} /> : state.operation === "move" ? <ArrowLeft size={16} /> : <PenLine size={16} />}</span><div><h3 id="file-operation-title">{title}</h3><small>{batchTransfer ? tr(language, "selectedItems", { count: batchEntries.length }) : state.entry ? state.entry.path : tr(language, "currentContainerDirectory")}</small></div><Button variant="ghost" size="icon" disabled={busy} aria-label="Close file operation" onClick={onClose}><X size={14} /></Button></header>
      <label><span>{batchTransfer ? tr(language, "absoluteDestinationFolder") : transfer ? tr(language, "absoluteDestinationPath") : create ? tr(language, "name") : tr(language, "newName")}</span><input autoFocus value={value} placeholder={batchTransfer ? "/target/folder" : transfer ? "/target/path/name" : state.operation === "create-directory" ? "new-folder" : "new-file.txt"} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !invalid && !busy) onSubmit(value.trim()); }} />{transfer && <small>{batchTransfer ? tr(language, "destinationFolderHint") : tr(language, "destinationPathHint")}</small>}</label>
      <footer><Button variant="outline" size="sm" disabled={busy} onClick={onClose}>{tr(language, "cancel")}</Button><Button size="sm" disabled={busy || invalid} onClick={() => onSubmit(value.trim())}>{busy && <LoaderCircle className="spin" size={13} />}{title}</Button></footer>
    </section>
  </div>;
}

export function ContainerFileExplorer({ target, appTheme, contentFont, contentFontSize, language, sessionTargetControls, onToast }: {
  target?: ContainerFileTarget;
  appTheme: "light" | "dark";
  contentFont: string;
  contentFontSize: number;
  language: AppLanguage;
  sessionTargetControls?: ReactNode;
  onToast: (tone: "success" | "error", message: string, filePath?: string) => void;
}) {
  const [path, setPath] = useState("");
  const [workDir, setWorkDir] = useState("");
  const [homeDir, setHomeDir] = useState("");
  const [entries, setEntries] = useState<ContainerFileEntry[]>([]);
  const [entriesTargetKey, setEntriesTargetKey] = useState("");
  const [view, setView] = useState<FileViewMode>(() => localStorage.getItem("kubehive.fileExplorerView") === "grid" ? "grid" : "list");
  const [query, setQuery] = useState("");
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [containerState, setContainerState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [containerStateTarget, setContainerStateTarget] = useState("");
  const [containerError, setContainerError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [contextReloadToken, setContextReloadToken] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [dialog, setDialog] = useState<OperationDialog | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogState | null>(null);
  const [demoFilesystem, setDemoFilesystem] = useState<Record<string, ContainerFileEntry[]>>(cloneDemoFilesystem);
  const [demoContents, setDemoContents] = useState<Record<string, string>>({ ...demoTextFiles });
  const [editor, setEditor] = useState<{ path: string; content: string; original: string; writable: boolean } | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);

  useEffect(() => { localStorage.setItem("kubehive.fileExplorerView", view); }, [view]);
  const targetKey = target ? [target.clusterId, target.namespace, target.pod, target.container].join("\u0000") : "";
  const targetChanged = Boolean(target) && containerStateTarget !== targetKey;
  useEffect(() => {
    setPath(""); setWorkDir(""); setHomeDir(""); setEntries([]); setEntriesTargetKey(""); setSelectedPaths([]); setEditor(null); setQuery(""); setError(""); setContainerError(""); setDeleteDialog(null);
    if (!target) { setContainerStateTarget(""); setContainerState("loading"); return; }
    let cancelled = false;
    setContainerStateTarget(targetKey);
    setContainerState("loading");
    const context = nativeBackendAvailable
      ? backend.containerFileContext(target)
      : Promise.resolve({ workDir: "/workspace", homeDir: "/home/app" });
    void context.then((directories) => {
      if (cancelled) return;
      const initial = normalizePath(directories.workDir || "/");
      setWorkDir(initial);
      setHomeDir(normalizePath(directories.homeDir || initial));
      setPath(initial);
      setContainerState("ready");
    }).catch((nextError) => {
      if (cancelled) return;
      setEntries([]);
      setContainerError(tr(language, "unableToAccessFiles", { error: String(nextError) }));
      setContainerState("unavailable");
    });
    return () => { cancelled = true; };
  }, [targetKey, contextReloadToken]);
  useEffect(() => {
    if (!target || !path || targetChanged || containerState !== "ready") { setEntries([]); setEntriesTargetKey(""); return; }
    let cancelled = false;
    setLoading(true); setContainerError("");
    const request = nativeBackendAvailable ? backend.listContainerFiles(target, path) : Promise.resolve(demoFilesystem[path] ?? []);
    void request.then((items) => {
      if (cancelled) return;
      setEntries([...items].sort((left, right) => Number(right.kind === "directory") - Number(left.kind === "directory") || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" })));
      setEntriesTargetKey(targetKey);
      setSelectedPaths((current) => current.filter((selectedPath) => items.some((entry) => entry.path === selectedPath)));
    }).catch((nextError) => {
      if (cancelled) return;
      setEntries([]);
      setEntriesTargetKey("");
      setContainerError(tr(language, "unableToAccessPath", { path, error: String(nextError) }));
      setContainerState("unavailable");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [targetKey, path, reloadToken, demoFilesystem, targetChanged, containerState]);

  const visibleEntries = targetChanged || containerState !== "ready" || entriesTargetKey !== targetKey ? [] : entries;
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized ? visibleEntries.filter((entry) => entry.name.toLowerCase().includes(normalized)) : visibleEntries;
  }, [visibleEntries, query]);
  const selectedEntries = visibleEntries.filter((entry) => selectedPaths.includes(entry.path));
  const selected = selectedEntries.length === 1 ? selectedEntries[0] : undefined;
  const breadcrumbs = path === "/" ? [] : path.split("/").filter(Boolean);
  const refresh = () => {
    if (containerState === "unavailable") setContextReloadToken((value) => value + 1);
    else setReloadToken((value) => value + 1);
  };
  const navigate = (nextPath: string) => { const normalized = normalizePath(nextPath); setPath(normalized); setSelectedPaths([]); setEditor(null); setError(""); setContainerError(""); };

  const openEntry = async (entry: ContainerFileEntry) => {
    setSelectedPaths([entry.path]);
    if (entry.kind === "directory") { navigate(entry.path); return; }
    if (!entry.readable) { setError(tr(language, "notReadable", { name: entry.name })); return; }
    if (!target) return;
    setBusy(true); setError("");
    try {
      const file = nativeBackendAvailable ? await backend.readContainerTextFile(target, entry.path) : { path: entry.path, content: demoText(entry.path, demoContents) };
      setEditor({ path: file.path, content: file.content, original: file.content, writable: entry.writable });
    } catch (nextError) {
      setError(tr(language, "unableToOpenFile", { name: entry.name, error: String(nextError) }));
    } finally { setBusy(false); }
  };

  const saveEditor = async () => {
    if (!target || !editor || !editor.writable || editor.content === editor.original) return;
    setEditorBusy(true); setError("");
    try {
      if (nativeBackendAvailable) await backend.writeContainerTextFile(target, editor.path, editor.content);
      else setDemoContents((current) => ({ ...current, [editor.path]: editor.content }));
      setEditor((current) => current ? { ...current, original: current.content } : current);
      onToast("success", tr(language, "saved", { path: editor.path }));
      refresh();
    } catch (nextError) { setError(tr(language, "unableToSave", { path: editor.path, error: String(nextError) })); }
    finally { setEditorBusy(false); }
  };

  const download = async (entry = selected) => {
    if (!entry || !target) return;
    setBusy(true); setError("");
    try {
      if (nativeBackendAvailable) {
        const downloaded = await backend.downloadContainerPath(target, entry.path, entry.kind === "directory");
        onToast("success", entry.kind === "directory" ? tr(language, "folderPackaged") : tr(language, "fileDownloaded"), downloaded);
      } else {
        const blob = new Blob([entry.kind === "directory" ? "Browser demo archive placeholder" : demoText(entry.path, demoContents)], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url; anchor.download = entry.kind === "directory" ? `${entry.name}.tar.gz` : entry.name; anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
        onToast("success", tr(language, "downloaded", { name: anchor.download }));
      }
    } catch (nextError) { setError(tr(language, "unableToDownload", { name: entry.name, error: String(nextError) })); }
    finally { setBusy(false); }
  };

  const remove = (entry = selected) => {
    if (!entry || !target || busy) return;
    setError("");
    setDeleteDialog({ entries: [entry] });
  };

  const toggleSelection = (entry: ContainerFileEntry) => {
    setSelectedPaths((current) => current.includes(entry.path) ? current.filter((path) => path !== entry.path) : [...current, entry.path]);
  };

  const removeDemoEntries = (items: ContainerFileEntry[]) => {
    const roots = items.map((entry) => entry.path);
    setDemoFilesystem((current) => {
      const next = Object.fromEntries(Object.entries(current).map(([directory, entries]) => [directory, entries.filter((entry) => !roots.includes(entry.path))]));
      Object.keys(next).filter((directory) => roots.some((root) => directory === root || directory.startsWith(`${root}/`))).forEach((directory) => delete next[directory]);
      return next;
    });
    setDemoContents((current) => Object.fromEntries(Object.entries(current).filter(([file]) => !roots.some((root) => file === root || file.startsWith(`${root}/`)))));
  };

  const downloadSelected = async () => {
    if (!target || selectedEntries.length === 0) return;
    if (selectedEntries.length === 1) { await download(selectedEntries[0]); return; }
    setBusy(true); setError("");
    try {
      if (nativeBackendAvailable) {
        const downloaded = await backend.downloadContainerPaths(target, selectedEntries.map((entry) => entry.path));
        onToast("success", tr(language, "itemsPackaged", { count: selectedEntries.length }), downloaded);
      } else {
        const blob = new Blob([`Browser demo archive for:\n${selectedEntries.map((entry) => entry.path).join("\n")}`], { type: "application/gzip" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url; anchor.download = "container-files.tar.gz"; anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
        onToast("success", tr(language, "downloaded", { name: `${selectedEntries.length} items as ${anchor.download}` }));
      }
    } catch (nextError) { setError(tr(language, "unableToDownloadSelected", { error: String(nextError) })); }
    finally { setBusy(false); }
  };

  const removeSelected = () => {
    if (!target || selectedEntries.length === 0 || busy) return;
    setError("");
    setDeleteDialog({ entries: [...selectedEntries] });
  };

  const confirmRemove = async () => {
    const deletingEntries = deleteDialog?.entries ?? [];
    if (!target || deletingEntries.length === 0 || busy) return;
    setBusy(true); setError("");
    try {
      if (nativeBackendAvailable) await backend.deleteContainerPaths(target, deletingEntries.map((entry) => entry.path));
      else removeDemoEntries(deletingEntries);
      onToast("success", deletingEntries.length === 1
        ? tr(language, "deleted", { name: deletingEntries[0].path })
        : tr(language, "deleted", { name: `${deletingEntries.length} ${tr(language, "items")}` }));
      setDeleteDialog(null); setSelectedPaths([]); refresh();
    } catch (nextError) {
      const message = deletingEntries.length === 1
        ? tr(language, "unableToDelete", { name: deletingEntries[0].name, error: String(nextError) })
        : tr(language, "unableToDeleteSelected", { error: String(nextError) });
      setDeleteDialog(null); setError(message); onToast("error", message); refresh();
    } finally { setBusy(false); }
  };

  const runOperation = async (value: string) => {
    if (!target || !dialog) return;
    const operation = dialog.operation;
    const entry = dialog.entry;
    const batchEntries = dialog.entries ?? [];
    setBusy(true); setError("");
    try {
      let createdPath = "";
      if (operation === "create-file") {
        createdPath = joinPath(path, value);
        if (nativeBackendAvailable) await backend.createContainerFile(target, createdPath);
        else {
          const entry: ContainerFileEntry = { name: value, path: createdPath, kind: "file", size: 0, modifiedAt: Math.floor(Date.now() / 1000), permissions: "644", readable: true, writable: true };
          setDemoFilesystem((current) => ({ ...current, [path]: [...(current[path] ?? []).filter((item) => item.path !== createdPath), entry] }));
          setDemoContents((current) => ({ ...current, [createdPath]: "" }));
        }
      } else if (operation === "create-directory") {
        createdPath = joinPath(path, value);
        if (nativeBackendAvailable) await backend.createContainerDirectory(target, createdPath);
        else {
          const entry: ContainerFileEntry = { name: value, path: createdPath, kind: "directory", size: 0, modifiedAt: Math.floor(Date.now() / 1000), permissions: "755", readable: true, writable: true };
          setDemoFilesystem((current) => ({ ...current, [path]: [...(current[path] ?? []).filter((item) => item.path !== createdPath), entry], [createdPath]: current[createdPath] ?? [] }));
        }
      } else if ((operation === "move" || operation === "copy") && batchEntries.length > 0) {
        const destinationDirectory = normalizePath(value);
        const destinations = batchEntries.map((item) => ({ item, destination: joinPath(destinationDirectory, item.name) }));
        if (nativeBackendAvailable) {
          const results = await Promise.allSettled(destinations.map(({ item, destination }) => operation === "move"
            ? backend.moveContainerPath(target, item.path, destination)
            : backend.copyContainerPath(target, item.path, destination)));
          const failures = results.filter((result) => result.status === "rejected");
          setSelectedPaths([]); refresh();
          if (failures.length) {
            setDialog(null);
            throw new Error(tr(language, "fileOperationFailed", { error: `${failures.length} of ${results.length} items could not be ${operation === "move" ? "moved" : "copied"}` }));
          }
        } else {
          setDemoFilesystem((current) => destinations.reduce((next, transfer) => relocateDemoFilesystem(next, transfer.item.path, transfer.destination, operation === "copy"), current));
          setDemoContents((current) => destinations.reduce((next, transfer) => relocateDemoContents(next, transfer.item.path, transfer.destination, operation === "copy"), current));
        }
      } else if (operation === "rename" && entry) {
        const destination = joinPath(parentPath(entry.path), value);
        if (nativeBackendAvailable) await backend.renameContainerPath(target, entry.path, value);
        else {
          setDemoFilesystem((current) => relocateDemoFilesystem(current, entry.path, destination, false));
          setDemoContents((current) => relocateDemoContents(current, entry.path, destination, false));
        }
      } else if (operation === "move" && entry) {
        const destination = normalizePath(value);
        if (nativeBackendAvailable) await backend.moveContainerPath(target, entry.path, destination);
        else {
          setDemoFilesystem((current) => relocateDemoFilesystem(current, entry.path, destination, false));
          setDemoContents((current) => relocateDemoContents(current, entry.path, destination, false));
        }
      } else if (operation === "copy" && entry) {
        const destination = normalizePath(value);
        if (nativeBackendAvailable) await backend.copyContainerPath(target, entry.path, destination);
        else {
          setDemoFilesystem((current) => relocateDemoFilesystem(current, entry.path, destination, true));
          setDemoContents((current) => relocateDemoContents(current, entry.path, destination, true));
        }
      }
      setDialog(null); setSelectedPaths([]); refresh();
      onToast("success", batchEntries.length > 0
        ? tr(language, operation === "move" ? "moved" : "copied", { count: batchEntries.length })
        : operation === "create-directory" || operation === "create-file" ? tr(language, "created", { path: createdPath })
          : operation === "rename" ? tr(language, "renamed", { path: entry?.path ?? createdPath })
            : operation === "move" ? tr(language, "moved", { count: 1 })
              : tr(language, "copied", { count: 1 }));
      if (operation === "create-file" && createdPath) {
        const file = nativeBackendAvailable ? await backend.readContainerTextFile(target, createdPath) : { path: createdPath, content: "" };
        setEditor({ path: file.path, content: file.content, original: file.content, writable: true });
      }
    } catch (nextError) { setError(tr(language, "fileOperationFailed", { error: String(nextError) })); }
    finally { setBusy(false); }
  };

  const uploadFiles = async (files: FileList | File[]) => {
    if (!target || files.length === 0) return;
    setBusy(true); setError("");
    let uploaded = 0;
    try {
      for (const file of Array.from(files)) {
        if (file.size > 64 * 1024 * 1024) throw new Error(tr(language, "uploadLimit", { name: file.name }));
        const destination = joinPath(path, file.name);
        if (nativeBackendAvailable) {
          const data = Array.from(new Uint8Array(await file.arrayBuffer()));
          try {
            await backend.uploadContainerFile(target, destination, data, false);
          } catch (uploadError) {
            if (!String(uploadError).toLowerCase().includes("exists") || !window.confirm(tr(language, "overwritePrompt", { path: destination }))) throw uploadError;
            await backend.uploadContainerFile(target, destination, data, true);
          }
        } else {
          const data = new Uint8Array(await file.arrayBuffer());
          const entry: ContainerFileEntry = { name: file.name, path: destination, kind: "file", size: file.size, modifiedAt: Math.floor(Date.now() / 1000), permissions: "644", readable: true, writable: true };
          setDemoFilesystem((current) => ({ ...current, [path]: [...(current[path] ?? []).filter((item) => item.path !== destination), entry] }));
          setDemoContents((current) => ({ ...current, [destination]: new TextDecoder().decode(data) }));
        }
        uploaded += 1;
      }
      onToast("success", tr(language, "uploaded", { count: uploaded, plural: uploaded === 1 ? "" : "s", path })); refresh();
    } catch (nextError) { setError(tr(language, "uploadFailed", { count: uploaded, plural: uploaded === 1 ? "" : "s", error: String(nextError) })); }
    finally { setBusy(false); if (uploadRef.current) uploadRef.current.value = ""; }
  };

  const openEntryMenu = (event: ReactMouseEvent, entry: ContainerFileEntry) => {
    if (!selectedPaths.includes(entry.path)) setSelectedPaths([entry.path]);
    openContextMenu(event, [
      { type: "item", id: "open", label: entry.kind === "directory" ? tr(language, "openFolder") : tr(language, "editTextFile"), icon: entry.kind === "directory" ? FolderOpen : Pencil, onSelect: () => void openEntry(entry) },
      { type: "item", id: "download", label: entry.kind === "directory" ? tr(language, "downloadArchive") : tr(language, "downloadSelected"), icon: Download, onSelect: () => void download(entry) },
      { type: "separator" },
      { type: "item", id: "rename", label: `${tr(language, "rename")}...`, icon: PenLine, onSelect: () => setDialog({ operation: "rename", entry }) },
      { type: "item", id: "move", label: `${tr(language, "moveToPath")}...`, icon: ArrowLeft, onSelect: () => setDialog({ operation: "move", entry }) },
      { type: "item", id: "copy", label: `${tr(language, "copyToPath")}...`, icon: Copy, onSelect: () => setDialog({ operation: "copy", entry }) },
      { type: "separator" },
      { type: "item", id: "delete", label: tr(language, "delete"), icon: Trash2, hoverDestructive: true, onSelect: () => void remove(entry) },
    ]);
  };

  const onKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key.toLowerCase() === "a" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); setSelectedPaths(filtered.map((entry) => entry.path)); return; }
    if (event.key === "Delete" || event.key === "Backspace" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void removeSelected(); return; }
    if (!selected) return;
    if (event.key === "Enter") { event.preventDefault(); void openEntry(selected); }
    else if (event.key === "F2") { event.preventDefault(); setDialog({ operation: "rename", entry: selected }); }
  };

  if (!target) return <div className="file-explorer-unavailable"><HardDrive size={26} /><strong>{tr(language, "containerFilesUnavailable")}</strong><span>{tr(language, "loadingDirectoryContext")}</span></div>;

  return <div className={cn("container-file-explorer", `file-theme-${appTheme}`, dragging && "is-dragging")} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }} onDrop={(event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDragging(false); void uploadFiles(event.dataTransfer.files); }}>
    <div className="file-explorer-toolbar">
      {sessionTargetControls && <><div className="file-explorer-session-controls">{sessionTargetControls}</div><span className="file-session-action-divider" /></>}
      <div className="file-navigation-actions"><Button variant="ghost" size="icon" aria-label={tr(language, "backToParentFolder")} title={tr(language, "parentFolder")} disabled={!path || path === "/" || loading || busy || containerState !== "ready"} onClick={() => navigate(parentPath(path))}><ArrowUp size={14} /></Button><Button variant="ghost" size="icon" aria-label={tr(language, "homeDirectory")} title={homeDir ? `${tr(language, "homeDirectory")} · ${homeDir}` : tr(language, "homeDirectory")} disabled={!homeDir || path === homeDir || loading || busy || containerState !== "ready"} onClick={() => navigate(homeDir)}><House size={14} /></Button><Button variant="ghost" size="icon" aria-label={tr(language, "workingDirectory")} title={workDir ? `${tr(language, "workingDirectory")} · ${workDir}` : tr(language, "workingDirectory")} disabled={!workDir || path === workDir || loading || busy || containerState !== "ready"} onClick={() => navigate(workDir)}><FolderOpen size={14} /></Button><Button variant="ghost" size="icon" aria-label={tr(language, "refreshFiles")} title={tr(language, "refresh")} disabled={!path || loading || busy || targetChanged} onClick={refresh}><RefreshCw className={cn(loading && "spin")} size={14} /></Button></div>
      <div className="file-breadcrumbs" aria-label={tr(language, "currentPath")}><button aria-label={tr(language, "filesystemRoot")} title={tr(language, "filesystemRoot")} onClick={() => navigate("/")}><HardDrive size={12} /></button>{!targetChanged && breadcrumbs.map((part, index) => <span key={`${part}-${index}`}><i aria-hidden="true">/</i><button onClick={() => navigate(`/${breadcrumbs.slice(0, index + 1).join("/")}`)}>{part}</button></span>)}</div>
      <label className="file-search"><Search size={13} /><input aria-label={tr(language, "filterFiles")} value={query} placeholder={tr(language, "filterFiles")} onChange={(event) => setQuery(event.target.value)} />{query && <button aria-label={tr(language, "clear")} onClick={() => setQuery("")}><X size={11} /></button>}</label>
      <span className="file-action-divider" />
      <Button variant="ghost" size="icon" aria-label={tr(language, "uploadFiles")} title={tr(language, "uploadFiles")} disabled={busy || containerState !== "ready"} onClick={() => uploadRef.current?.click()}><Upload size={14} /></Button><input ref={uploadRef} hidden type="file" multiple onChange={(event) => { if (event.target.files) void uploadFiles(event.target.files); }} />
      <Button variant="ghost" size="icon" aria-label={tr(language, "newFile")} title={tr(language, "newFile")} disabled={busy || containerState !== "ready"} onClick={() => setDialog({ operation: "create-file" })}><FilePlus2 size={14} /></Button>
      <Button variant="ghost" size="icon" aria-label={tr(language, "newFolder")} title={tr(language, "newFolder")} disabled={busy || containerState !== "ready"} onClick={() => setDialog({ operation: "create-directory" })}><FolderPlus size={14} /></Button>
      <div className="file-toolbar-end">
        {!editor && selectedEntries.length > 1 && <div className="file-bulk-actions" role="toolbar" aria-label={tr(language, "selectedFileActions")}><strong>{selectedEntries.length}</strong><Button variant="ghost" size="icon" aria-label={tr(language, "downloadSelected")} title={tr(language, "packageSelected")} disabled={busy} onClick={() => void downloadSelected()}><Download size={14} /></Button><Button variant="ghost" size="icon" aria-label={tr(language, "moveSelected")} title={tr(language, "moveSelected")} disabled={busy} onClick={() => setDialog({ operation: "move", entries: selectedEntries })}><ArrowLeft size={13} /></Button><Button variant="ghost" size="icon" aria-label={tr(language, "copySelected")} title={tr(language, "copySelected")} disabled={busy} onClick={() => setDialog({ operation: "copy", entries: selectedEntries })}><Copy size={13} /></Button><Button variant="ghost" size="icon" className="hover-destructive" aria-label={tr(language, "deleteSelected")} title={tr(language, "deleteSelected")} disabled={busy} onClick={() => void removeSelected()}><Trash2 size={13} /></Button><Button variant="ghost" size="icon" aria-label={tr(language, "clearSelection")} title={tr(language, "clearSelection")} onClick={() => setSelectedPaths([])}><X size={13} /></Button></div>}
        <div className="file-view-switch" role="group" aria-label={tr(language, "fileLayout")}><button className={cn(view === "list" && "active")} aria-label={tr(language, "listView")} aria-pressed={view === "list"} onClick={() => setView("list")}><List size={14} /></button><button className={cn(view === "grid" && "active")} aria-label={tr(language, "gridView")} aria-pressed={view === "grid"} onClick={() => setView("grid")}><Grid2X2 size={14} /></button></div>
      </div>
    </div>
    {!targetChanged && error && <div className="file-explorer-error" role="alert"><span>{error}</span><button onClick={() => setError("")} aria-label={tr(language, "dismiss")}><X size={12} /></button></div>}
    {editor ? <div className="file-text-editor">
      <header><Button variant="ghost" size="icon" aria-label={tr(language, "backToFiles")} title={tr(language, "backToFiles")} onClick={() => setEditor(null)}><ArrowLeft size={14} /></Button><Pencil size={15} /><div><strong>{editor.path.split("/").at(-1)}</strong><small>{editor.path}</small></div>{!editor.writable && <Badge tone="neutral">{tr(language, "readOnly")}</Badge>}{editor.content !== editor.original && <Badge tone="amber">{tr(language, "modified")}</Badge>}<Button size="sm" disabled={!editor.writable || editorBusy || editor.content === editor.original} onClick={() => void saveEditor()}>{editorBusy ? <LoaderCircle className="spin" size={13} /> : <Save size={13} />}{tr(language, "save")}</Button></header>
      <textarea aria-label={tr(language, "editFile", { path: editor.path })} readOnly={!editor.writable} spellCheck={false} value={editor.content} style={{ fontFamily: contentFont, fontSize: contentFontSize }} onChange={(event) => setEditor({ ...editor, content: event.target.value })} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void saveEditor(); } }} />
      <footer><span>{tr(language, "fileBytes", { count: new TextEncoder().encode(editor.content).length.toLocaleString(language === "en" ? "en" : language) })}</span><span>{tr(language, "saveShortcut")}</span></footer>
    </div> : <div className="file-explorer-content" tabIndex={0} onKeyDown={onKeyboard}>
      {(targetChanged || containerState === "loading") && <div className="file-explorer-state"><LoaderCircle className="spin" size={22} /><strong>{tr(language, "connectingToFilesystem")}</strong><span>{tr(language, "loadingDirectoryContext")}</span></div>}
      {!targetChanged && containerState === "unavailable" && <div className="file-explorer-state file-explorer-unavailable-state" role="alert"><HardDrive size={25} /><strong>{tr(language, "containerFilesUnavailable")}</strong><span>{containerError || tr(language, "filesystemCouldNotReach")}</span></div>}
      {!targetChanged && containerState === "ready" && loading && <div className="file-explorer-state"><LoaderCircle className="spin" size={22} /><strong>{tr(language, "loading", { path })} {path}</strong></div>}
      {!targetChanged && containerState === "ready" && !loading && filtered.length === 0 && <div className="file-explorer-state"><FolderOpen size={25} /><strong>{query ? tr(language, "noMatchingFiles") : tr(language, "folderEmpty")}</strong><span>{query ? tr(language, "tryDifferentFilter") : tr(language, "dropOrCreate")}</span></div>}
      {!targetChanged && containerState === "ready" && !loading && filtered.length > 0 && view === "list" && <table className="file-list"><thead><tr><th className="file-selection-column"><input type="checkbox" aria-label={tr(language, "selectAllFiles")} checked={filtered.length > 0 && filtered.every((entry) => selectedPaths.includes(entry.path))} onChange={(event) => setSelectedPaths(event.target.checked ? filtered.map((entry) => entry.path) : [])} /></th><th>{tr(language, "name")}</th><th>{tr(language, "size")}</th><th>{tr(language, "modified")}</th><th>{tr(language, "mode")}</th><th aria-label={tr(language, "actions")} /></tr></thead><tbody>{filtered.map((entry) => <tr key={entry.path} className={cn(selectedPaths.includes(entry.path) && "selected")} onClick={() => toggleSelection(entry)} onDoubleClick={() => void openEntry(entry)} onContextMenu={(event) => openEntryMenu(event, entry)}><td className="file-selection-column"><input type="checkbox" aria-label={tr(language, "selectFile", { name: entry.name })} checked={selectedPaths.includes(entry.path)} onClick={(event) => event.stopPropagation()} onChange={() => toggleSelection(entry)} /></td><td><span className={cn("file-entry-icon", `kind-${entry.kind}`)}>{fileIcon(entry, 15)}</span><div><strong>{entry.name}</strong>{entry.kind === "symlink" && <small>{tr(language, "symbolicLink")}</small>}</div></td><td>{entry.kind === "directory" ? "—" : formatBytes(entry.size)}</td><td>{formatModified(entry.modifiedAt, language)}</td><td><code>{entry.permissions}</code></td><td><button aria-label={`${tr(language, "actions")} ${entry.name}`} onClick={(event) => { event.stopPropagation(); openEntryMenu(event, entry); }}><MoreHorizontal size={14} /></button></td></tr>)}</tbody></table>}
      {!targetChanged && containerState === "ready" && !loading && filtered.length > 0 && view === "grid" && <div className="file-grid">{filtered.map((entry) => <button key={entry.path} className={cn("file-grid-item", selectedPaths.includes(entry.path) && "selected")} onClick={() => toggleSelection(entry)} onDoubleClick={() => void openEntry(entry)} onContextMenu={(event) => openEntryMenu(event, entry)}><span className="file-grid-check" aria-hidden="true">{selectedPaths.includes(entry.path) ? "✓" : ""}</span><span className={cn("file-entry-icon", `kind-${entry.kind}`)}>{fileIcon(entry, 27)}</span><strong>{entry.name}</strong><small>{entry.kind === "directory" ? tr(language, "folder") : formatBytes(entry.size)}</small></button>)}</div>}
    </div>}
    {!editor && <div className="file-explorer-status">{targetChanged || containerState !== "ready" ? <><span>{tr(language, "filesystemUnavailable")}</span><span>{tr(language, "chooseAnotherContainer")}</span></> : <><span>{tr(language, "itemCount", { count: filtered.length, plural: filtered.length === 1 ? "" : "s" })}{query ? ` ${tr(language, "matchingTotal", { total: visibleEntries.length })}` : ""}</span>{selectedEntries.length > 1 ? <><strong>{tr(language, "itemsSelected", { count: selectedEntries.length })}</strong><span>{tr(language, "doubleClickToOpen")}</span></> : selected ? <><strong>{selected.name}</strong><span>{selected.kind === "directory" ? tr(language, "folder") : formatBytes(selected.size)} · {selected.readable ? "read" : "no read"}/{selected.writable ? "write" : "no write"}</span></> : <span>{tr(language, "doubleClickToOpen")}</span>}</>}</div>}
    {dragging && <div className="file-drop-overlay"><Upload size={28} /><strong>{tr(language, "uploadTo", { path })}</strong><span>{tr(language, "dropFiles")}</span></div>}
    {dialog && <OperationDialog state={dialog} busy={busy} language={language} onClose={() => setDialog(null)} onSubmit={(value) => void runOperation(value)} />}
    {deleteDialog && <DeleteConfirmationDialog entries={deleteDialog.entries} busy={busy} language={language} onClose={() => setDeleteDialog(null)} onConfirm={() => void confirmRemove()} />}
  </div>;
}
