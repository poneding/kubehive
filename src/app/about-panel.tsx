import { Badge, Button, ScrollArea } from "@/components/ui";
import { cn } from "@/lib/utils";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Download, ExternalLink, LoaderCircle, RefreshCw, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { UpdateState } from "../app-update";
import kubeHiveLogo from "../assets/kubehive-logo.svg";
import { localizedUpdateError, tr } from "../i18n";
import type { AppLanguage } from "../preferences";
import { appVersion } from "./app-state";

function AboutPanel({ language, updateState, onCheckUpdates, onInstallUpdate, onClose }: { language: AppLanguage; updateState: UpdateState; onCheckUpdates: () => void; onInstallUpdate: () => void; onClose: () => void }) {
  const update = updateState.update;
  const releaseVisible = Boolean(update && ["available", "downloading", "error"].includes(updateState.status));
  const checking = updateState.status === "checking";
  const downloading = updateState.status === "downloading";
  const progress = updateState.contentLength && updateState.contentLength > 0
    ? Math.min(100, Math.round((updateState.downloadedBytes / updateState.contentLength) * 100))
    : 35;
  const updateNote = updateState.status === "checking"
    ? tr(language, "verifyingRelease")
    : updateState.status === "current"
      ? tr(language, "latestRelease", { version: appVersion })
      : updateState.status === "unsupported"
        ? tr(language, "packagedAppRequired")
        : updateState.status === "error" && !releaseVisible
          ? localizedUpdateError(language, updateState.message)
          : "";
  const published = update?.date ? tr(language, "published", { date: new Date(update.date).toLocaleDateString(language === "en" ? "en" : language) }) : tr(language, "signedUpdateReady");
  return <div className="modal-backdrop panel-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="about-modal" role="dialog" aria-modal="true" aria-labelledby="about-title" onMouseDown={(event) => event.stopPropagation()}>
    <header className="about-header"><h2 id="about-title">{tr(language, "aboutKubeHive")}</h2><div /><Button variant="ghost" size="icon" aria-label={tr(language, "close")} onClick={onClose}><X size={15} /></Button></header>
    <ScrollArea className="about-scroll-area" viewportClassName="about-scroll">
      <section className="about-hero"><img className="about-logo" src={kubeHiveLogo} alt="" /><h1>KubeHive</h1><p>{tr(language, "desktopClientDescription")}</p><div className="about-version"><code>v{appVersion}</code><Badge tone="green">{tr(language, "stable")}</Badge></div><div className="about-meta"><a href="https://github.com/poneding/kubehive" target="_blank" rel="noreferrer" onClick={(event) => { event.preventDefault(); void openUrl("https://github.com/poneding/kubehive"); }}><ExternalLink size={12} />{tr(language, "githubRepository")}</a></div></section>
      {!releaseVisible && <div className="about-update-controls"><Button variant="outline" size="sm" disabled={checking} onClick={onCheckUpdates}>{checking ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}{checking ? tr(language, "checkingForUpdates") : tr(language, "checkForUpdates")}</Button>{updateNote && <span className={cn(updateState.status === "error" && "error")}>{updateNote}</span>}</div>}
      {releaseVisible && update && <section className="about-release" aria-label={tr(language, "whatsNew")}><header><span className="about-release-icon">{downloading ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}</span><div className="about-release-title"><strong>{tr(language, "versionReady", { version: update.version })}</strong><span>{downloading ? (updateState.contentLength ? tr(language, "downloadedBytes", { done: Math.round(updateState.downloadedBytes / 1024 / 1024), total: Math.round(updateState.contentLength / 1024 / 1024) }) : tr(language, "downloadingUpdate")) : published}</span></div><div className="about-release-actions"><Button size="sm" disabled={downloading} onClick={onInstallUpdate}>{downloading ? <LoaderCircle className="spin" size={13} /> : <Download size={13} />}{downloading ? tr(language, "installingUpdate") : tr(language, "installAndRestart")}</Button></div></header>{downloading && <div className="about-progress" aria-label={tr(language, "updateDownloadProgress")}><i style={{ width: `${progress}%` }} /></div>}{updateState.status === "error" && <div className="about-update-controls"><span className="error">{localizedUpdateError(language, updateState.message)}</span></div>}<div className="about-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => { const safeHref = typeof href === "string" && /^https?:\/\//i.test(href) ? href : null; return safeHref ? <a href={safeHref} target="_blank" rel="noreferrer" onClick={(event) => { event.preventDefault(); void openUrl(safeHref); }}>{children}</a> : <span>{children}</span>; }, pre: ({ children }) => <ScrollArea className="about-code-scroll" viewportClassName="about-code-scroll-viewport" viewportProps={{ tabIndex: 0, role: "region", "aria-label": tr(language, "whatsNew") }} scrollbars="horizontal" type="scroll"><pre>{children}</pre></ScrollArea> }}>{update.body?.trim() || tr(language, "noReleaseNotes")}</ReactMarkdown></div></section>}
    </ScrollArea>
  </section></div>;
}

export { AboutPanel };
