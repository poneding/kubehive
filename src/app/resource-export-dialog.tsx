import { Button, Checkbox, Dialog, DialogContent, DialogTitle, ScrollArea } from "@/components/ui";
import { cn } from "@/lib/utils";
import { Download, LoaderCircle, X } from "lucide-react";
import { useMemo, useState } from "react";
import { backend } from "../backend";
import { tr, type AppLanguage } from "../i18n";
import { t } from "../preferences";
import type { ColumnDef, ResourceRow } from "../resource-catalog";
import { resourceCellText } from "./resource-cells";
import "./resource-export-dialog.css";

type ExportFormat = "csv" | "xlsx";

/**
 * Export dialog for the resource list. It receives exactly the rows the table
 * is showing (namespace filter + search already applied) and the column set
 * already selected in the column picker, both of which stay customizable here.
 */
export function ResourceExportDialog({ resource, language, defs, visibleColumns, rows, onClose, onToast }: {
  resource: string;
  language: AppLanguage;
  defs: ColumnDef[];
  visibleColumns: string[];
  rows: ResourceRow[];
  onClose: () => void;
  onToast: (tone: "success" | "error", message: string, filePath?: string) => void;
}) {
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [selected, setSelected] = useState<string[]>(visibleColumns);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selectedDefs = useMemo(() => defs.filter((def) => selected.includes(def.id)), [defs, selected]);

  const toggleColumn = (id: string, next: boolean) => {
    setSelected((current) => next ? [...current, id] : current.filter((value) => value !== id));
  };

  const exportNow = async () => {
    if (!selectedDefs.length || busy) return;
    setBusy(true);
    setError("");
    try {
      const columns = selectedDefs.map((def) => def.label);
      const dataRows = rows.map((row) => selectedDefs.map((def) => resourceCellText(def.id, row)));
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const fileName = `${resource.replace(/[\\/:*?"<>|]+/g, "-")}-${timestamp}.${format}`;
      const path = await backend.exportResourceTable({ format, fileName, sheetName: resource, columns, rows: dataRows });
      if (!path) return;
      onToast("success", tr(language, "exportedRows", { count: dataRows.length, path }), path);
      onClose();
    } catch (nextError) {
      setError(tr(language, "exportFailed", { error: String(nextError) }));
    } finally {
      setBusy(false);
    }
  };

  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent
      aria-describedby={undefined}
      className="resource-export-dialog block w-auto max-w-none gap-0 p-0 text-inherit"
      overlayClassName="modal-backdrop panel-dialog-backdrop"
      showCloseButton={false}
    >
      <header>
        <DialogTitle>{tr(language, "exportResources")}</DialogTitle>
        <Button type="button" variant="ghost" size="icon" className="resource-export-close" disabled={busy} onClick={onClose} aria-label={tr(language, "close")}><X size={14} /></Button>
      </header>
      <div className="resource-export-body">
        <div className="resource-export-identity"><strong>{resource}</strong><small>{tr(language, "exportRows", { count: rows.length })}</small></div>
        <div className="resource-export-field">
          <span>{tr(language, "exportFormat")}</span>
          <div className="resource-export-formats" role="group" aria-label={tr(language, "exportFormat")}>
            {(["csv", "xlsx"] as const).map((option) => <button key={option} type="button" className={cn(format === option && "active")} aria-pressed={format === option} onClick={() => setFormat(option)}>{option === "csv" ? "CSV (.csv)" : "Excel (.xlsx)"}</button>)}
          </div>
        </div>
        <div className="resource-export-columns-head">
          <span>{tr(language, "exportColumns")} <small>{selectedDefs.length}/{defs.length}</small></span>
          <div><button type="button" onClick={() => setSelected(defs.map((def) => def.id))}>{tr(language, "exportSelectAll")}</button><button type="button" onClick={() => setSelected([])}>{tr(language, "exportClearAll")}</button></div>
        </div>
        <ScrollArea className="resource-export-columns" viewportClassName="resource-export-columns-viewport">
          <div className="resource-export-columns-content">
            {defs.map((def) => <label key={def.id} className="resource-export-column">
              <Checkbox checked={selected.includes(def.id)} aria-label={def.label} onCheckedChange={(next) => toggleColumn(def.id, next === true)} />
              <span>{def.label}</span>
            </label>)}
          </div>
        </ScrollArea>
        {error && <div className="resource-export-error" role="alert">{error}</div>}
      </div>
      <footer>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onClose}>{t(language, "cancel")}</Button>
        <Button type="button" size="sm" disabled={busy || selectedDefs.length === 0} onClick={() => void exportNow()}>{busy ? <LoaderCircle className="spin" size={13} /> : <Download size={13} />}{busy ? tr(language, "exporting") : tr(language, "exportAction")}</Button>
      </footer>
    </DialogContent>
  </Dialog>;
}
