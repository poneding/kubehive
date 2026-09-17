import { Button, Dialog, DialogContent, DialogTitle } from "@/components/ui";
import { LoaderCircle, Save, X } from "lucide-react";
import { useEffect, useState } from "react";
import { backend, type KubeconfigDocument } from "../backend";
import type { Cluster } from "../data";
import { tr, type AppLanguage } from "../i18n";
import { t } from "../preferences";
import "./kubeconfig-dialog.css";

/**
 * In-app editor for the kubeconfig file that backs a cluster context. Saving
 * validates and rewrites the file in the native process, so the dialog never
 * hands the raw file back to the frontend for persistence.
 */
export function KubeconfigDialog({ cluster, language, onClose, onSaved }: {
  cluster: Cluster;
  language: AppLanguage;
  onClose: () => void;
  onSaved: (path: string) => void;
}) {
  const [document, setDocument] = useState<KubeconfigDocument | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    backend.readKubeconfig(cluster.id)
      .then((nextDocument) => {
        if (cancelled) return;
        setDocument(nextDocument);
        setDraft(nextDocument.contents);
      })
      .catch((nextError) => {
        if (!cancelled) setError(tr(language, "kubeconfigLoadFailed", { error: String(nextError) }));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cluster.id]);

  const dirty = document !== null && draft !== document.contents;
  const save = async () => {
    if (!document || !dirty || busy) return;
    setBusy(true);
    setError("");
    try {
      await backend.writeKubeconfig(cluster.id, draft);
      setDocument({ ...document, contents: draft });
      onSaved(document.path);
    } catch (nextError) {
      setError(tr(language, "kubeconfigSaveFailed", { error: String(nextError) }));
    } finally {
      setBusy(false);
    }
  };

  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent
      aria-describedby={undefined}
      className="kubeconfig-dialog block w-auto max-w-none gap-0 p-0 text-inherit"
      overlayClassName="modal-backdrop panel-dialog-backdrop"
      showCloseButton={false}
    >
      <header>
        <DialogTitle>{tr(language, "editKubeconfig")}</DialogTitle>
        <Button type="button" variant="ghost" size="icon" className="kubeconfig-dialog-close" disabled={busy} onClick={onClose} aria-label={tr(language, "close")}><X size={14} /></Button>
      </header>
      <div className="kubeconfig-dialog-body">
        <div className="kubeconfig-dialog-identity"><strong>{cluster.name}</strong><small>{document?.path ?? cluster.sourcePath ?? cluster.context ?? ""}</small></div>
        <textarea
          className="kubeconfig-dialog-editor"
          aria-label={tr(language, "editKubeconfig")}
          spellCheck={false}
          value={draft}
          disabled={loading || busy || document === null}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
              event.preventDefault();
              void save();
            }
          }}
        />
        {loading && <div className="kubeconfig-dialog-status"><LoaderCircle className="spin" size={14} />{tr(language, "loading")}</div>}
        {document && <p className="kubeconfig-dialog-hint">{tr(language, "kubeconfigEditorHint", { path: document.path, context: document.context })}</p>}
        {error && <div className="kubeconfig-dialog-error" role="alert">{error}</div>}
      </div>
      <footer>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onClose}>{t(language, "cancel")}</Button>
        <Button type="button" size="sm" disabled={busy || loading || !dirty} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" size={13} /> : <Save size={13} />}{t(language, "save")}</Button>
      </footer>
    </DialogContent>
  </Dialog>;
}
