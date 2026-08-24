import { Button, Dialog, DialogContent, DialogTitle, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui";
import { Copy, FileUp, LoaderCircle, Settings, ShieldCheck, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import { backend, nativeBackendAvailable } from "../backend";
import { tr } from "../i18n";
import { t, type AppLanguage } from "../preferences";
import { ToggleSwitch } from "./app-controls";

function AddClusterDialog({ language, onClose, onAdd }: { language: AppLanguage; onClose: () => void; onAdd: (request: { displayName: string; kubeconfigYaml?: string; server?: string; token?: string; insecureSkipTlsVerify?: boolean }) => Promise<void> }) {
  const methods = [
    { id: "file", label: tr(language, "kubeconfigFile"), icon: FileUp },
    { id: "paste", label: tr(language, "pasteConfig"), icon: Copy },
    { id: "manual", label: tr(language, "manual"), icon: Settings },
  ] as const;
  const returnFocusRef = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const [mode, setMode] = useState<(typeof methods)[number]["id"]>("file");
  const [fileName, setFileName] = useState("");
  const [clusterName, setClusterName] = useState("");
  const [kubeconfig, setKubeconfig] = useState("");
  const [server, setServer] = useState("https://");
  const [token, setToken] = useState("");
  const [insecure, setInsecure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const applyKubeconfigFile = async (file?: File) => {
    setError("");
    try {
      setFileName(file?.name ?? "");
      setKubeconfig(file ? await file.text() : "");
    } catch (nextError) {
      setFileName("");
      setKubeconfig("");
      setError(String(nextError));
    }
  };
  const chooseKubeconfigFile = async () => {
    setError("");
    if (!nativeBackendAvailable) {
      fileInputRef.current?.click();
      return;
    }
    try {
      const file = await backend.selectKubeconfigFile();
      if (file) {
        setFileName(file.fileName);
        setKubeconfig(file.contents);
      }
    } catch (nextError) { setError(String(nextError)); }
  };
  const suggested = clusterName.trim() || fileName.replace(/\.(yaml|yml|config)$/i, "") || "imported-cluster";
  const addDisabled = busy || (mode === "file" ? !kubeconfig.trim() : mode === "paste" ? !kubeconfig.trim() : !server.startsWith("http") || !token.trim());
  const submit = async () => {
    setBusy(true); setError("");
    try {
      await onAdd(mode === "manual" ? { displayName: suggested, server, token, insecureSkipTlsVerify: insecure } : { displayName: suggested, kubeconfigYaml: kubeconfig });
    } catch (nextError) { setError(String(nextError)); }
    finally { setBusy(false); }
  };
  const bodyClassName = "add-cluster-body mt-0 outline-none";

  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent
      aria-describedby={undefined}
      className="add-cluster-dialog left-1/2 top-[9vh] block w-auto max-w-none -translate-x-1/2 translate-y-0 gap-0 p-0 text-inherit"
      overlayClassName="modal-backdrop add-cluster-backdrop"
      showCloseButton={false}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        returnFocusRef.current?.focus();
      }}
    >
      <header><DialogTitle>{t(language, "addCluster")}</DialogTitle><div /><Button variant="ghost" size="icon" aria-label={tr(language, "closeAddCluster")} onClick={onClose}><X size={15} /></Button></header>
      <Tabs value={mode} onValueChange={(value) => setMode(value as typeof mode)}>
        <div className="add-cluster-tabs-row">
          <TabsList className="add-cluster-tabs h-8 gap-0 border-0 bg-transparent p-[3px]" aria-label={tr(language, "clusterConnectionMethod")}>
            {methods.map(({ id, label, icon: Icon }) => <TabsTrigger key={id} id={`add-cluster-tab-${id}`} aria-controls={`add-cluster-mode-panel-${id}`} value={id}><Icon size={13} /><span>{label}</span></TabsTrigger>)}
          </TabsList>
        </div>
        <TabsContent id="add-cluster-mode-panel-file" aria-labelledby="add-cluster-tab-file" value="file" className={bodyClassName}>
          <label className="field-label"><span>{tr(language, "displayName")} <small>{tr(language, "optional")}</small></span><input value={clusterName} onChange={(event) => setClusterName(event.target.value)} placeholder="e.g. production-eu" /></label>
          <div className="file-drop" role="button" tabIndex={0} aria-label={tr(language, "chooseFile")} onClick={() => void chooseKubeconfigFile()} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void chooseKubeconfigFile(); } }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void applyKubeconfigFile(event.dataTransfer.files?.[0]); }}><input ref={fileInputRef} type="file" accept=".yaml,.yml,.config" onClick={(event) => event.stopPropagation()} onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; void applyKubeconfigFile(file); }} /><Upload size={22} /><strong>{fileName || tr(language, "dropKubeconfig")}</strong><span>{fileName ? tr(language, "readyToImport") : tr(language, "chooseFile")}</span></div>
          <div className="import-note"><ShieldCheck size={14} /><span>{tr(language, "credentialsNotice")}</span></div>{error && <div className="related-empty">{error}</div>}
        </TabsContent>
        <TabsContent id="add-cluster-mode-panel-paste" aria-labelledby="add-cluster-tab-paste" value="paste" className={bodyClassName}>
          <label className="field-label"><span>{tr(language, "displayName")} <small>{tr(language, "optional")}</small></span><input value={clusterName} onChange={(event) => setClusterName(event.target.value)} placeholder="e.g. production-eu" /></label>
          <label className="field-label"><span>Kubeconfig YAML</span><textarea value={kubeconfig} onChange={(event) => setKubeconfig(event.target.value)} placeholder={'apiVersion: v1\nclusters:\n  - cluster: ...'} /></label>
          <div className="import-note"><ShieldCheck size={14} /><span>{tr(language, "credentialsNotice")}</span></div>{error && <div className="related-empty">{error}</div>}
        </TabsContent>
        <TabsContent id="add-cluster-mode-panel-manual" aria-labelledby="add-cluster-tab-manual" value="manual" className={bodyClassName}>
          <label className="field-label"><span>{tr(language, "displayName")} <small>{tr(language, "optional")}</small></span><input value={clusterName} onChange={(event) => setClusterName(event.target.value)} placeholder="e.g. production-eu" /></label>
          <label className="field-label"><span>{tr(language, "apiServerUrl")}</span><input value={server} onChange={(event) => setServer(event.target.value)} placeholder="https://kubernetes.example.com:6443" /></label><label className="field-label"><span>{tr(language, "bearerToken")}</span><textarea rows={3} value={token} onChange={(event) => setToken(event.target.value)} placeholder="eyJhbGciOiJSUzI1NiIs..." /></label><label className="settings-input-row"><span>{tr(language, "skipTlsVerification")}</span><ToggleSwitch label={tr(language, "skipTlsVerification")} checked={insecure} onChange={setInsecure} /></label>
          <div className="import-note"><ShieldCheck size={14} /><span>{tr(language, "credentialsNotice")}</span></div>{error && <div className="related-empty">{error}</div>}
        </TabsContent>
      </Tabs>
      <footer><span>{mode === "file" ? tr(language, "kubeconfigSupported") : tr(language, "connectionValidated")}</span><div /><Button variant="outline" size="sm" onClick={onClose}>{t(language, "cancel")}</Button><Button size="sm" disabled={addDisabled} onClick={() => void submit()}>{busy && <LoaderCircle className="spin" size={13} />} {t(language, "add")}</Button></footer>
    </DialogContent>
  </Dialog>;
}

export { AddClusterDialog };
