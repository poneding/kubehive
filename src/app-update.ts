import { isTauri } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";

export type UpdateCheckStatus = "idle" | "checking" | "current" | "available" | "downloading" | "error" | "unsupported";

export type UpdateState = {
  status: UpdateCheckStatus;
  update: Update | null;
  message: string;
  downloadedBytes: number;
  contentLength: number | null;
};

export const initialUpdateState: UpdateState = {
  status: "idle",
  update: null,
  message: "",
  downloadedBytes: 0,
  contentLength: null,
};

export function updateProgress(event: DownloadEvent, current: UpdateState): UpdateState {
  if (event.event === "Started") {
    return { ...current, downloadedBytes: 0, contentLength: event.data.contentLength ?? null };
  }
  if (event.event === "Progress") {
    return { ...current, downloadedBytes: current.downloadedBytes + event.data.chunkLength };
  }
  return current;
}

export async function checkForUpdate(): Promise<Update | null> {
  if (!isTauri()) return null;
  return check({ timeout: 30_000 });
}

export async function installAndRelaunch(update: Update, onProgress: (event: DownloadEvent) => void): Promise<void> {
  await update.downloadAndInstall(onProgress);
  await relaunch();
}
