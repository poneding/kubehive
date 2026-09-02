import { useCallback, useSyncExternalStore } from "react";
import { appendLogChunks, trimLogChunks, type LogChunk } from "../ansi-log";

/**
 * Live pod log buffers, deliberately kept outside React state.
 *
 * A followed container can push a batch every few hundred milliseconds. Holding
 * the buffer in App state made each batch re-render the whole workspace, so the
 * buffers live here and only the pane reading a given key re-renders when it
 * grows. Buffers outlive tab switches and are released with their session.
 */
export type LogStreamStatus = "connecting" | "live" | "ended" | "error";
export type LogRuntime = {
  streamId: string;
  status: LogStreamStatus;
  feedback: string;
  /** Log target this stream belongs to; a different value means restart it. */
  connectionKey: string;
  chunks: LogChunk[];
  /** Lines already in the trailing chunk, so appends know when to seal it. */
  openLines: number;
};

const noChunks: LogChunk[] = [];
const runtimes = new Map<string, LogRuntime>();
const listeners = new Map<string, Set<() => void>>();

const idle: LogRuntime = {
  streamId: "",
  status: "connecting",
  feedback: "",
  connectionKey: "",
  chunks: noChunks,
  openLines: 0,
};

function notify(key: string) {
  listeners.get(key)?.forEach((listener) => listener());
}

export function getLogRuntime(key: string) {
  return runtimes.get(key);
}

export function logRuntimeKeys() {
  return [...runtimes.keys()];
}

export function patchLogRuntime(key: string, patch: Partial<LogRuntime>) {
  runtimes.set(key, { ...idle, ...runtimes.get(key), ...patch });
  notify(key);
}

/**
 * Appends a streamed batch, sealing full slices and trimming the oldest ones.
 *
 * Status is left alone: the `connected` event owns it, so a snapshot appended after
 * a stream failure does not erase the error the reader needs to see.
 */
export function appendLogRuntimeLines(key: string, lines: string[], maxLines: number) {
  const runtime = runtimes.get(key);
  if (!runtime || lines.length === 0) return;
  const appended = appendLogChunks(runtime.chunks, runtime.openLines, lines);
  runtimes.set(key, {
    ...runtime,
    chunks: trimLogChunks(appended.chunks, appended.openLines, maxLines),
    openLines: appended.openLines,
  });
  notify(key);
}

export function deleteLogRuntime(key: string) {
  if (!runtimes.delete(key)) return;
  notify(key);
}

export function subscribeLogRuntime(key: string, listener: () => void) {
  const existing = listeners.get(key) ?? new Set<() => void>();
  existing.add(listener);
  listeners.set(key, existing);
  return () => {
    existing.delete(listener);
    if (existing.size === 0) listeners.delete(key);
  };
}

/** Re-renders the caller only when the buffer behind `key` changes. */
export function useLogRuntime(key: string) {
  const subscribe = useCallback((listener: () => void) => subscribeLogRuntime(key, listener), [key]);
  const snapshot = useCallback(() => getLogRuntime(key), [key]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
