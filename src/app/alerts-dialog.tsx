import { Badge, Button, ScrollArea } from "@/components/ui";
import { AlertTriangle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { backend, nativeBackendAvailable, type ClusterOverview as LiveClusterOverview } from "../backend";
import { tr } from "../i18n";
import type { AppLanguage } from "../preferences";

function AlertsDialog({ clusterId, language, onClose }: { clusterId: string; language: AppLanguage; onClose: () => void }) {
  const [items, setItems] = useState<LiveClusterOverview["events"]>([]);
  useEffect(() => {
    if (!nativeBackendAvailable || clusterId === "unconfigured") return;
    let cancelled = false;
    backend.overview(clusterId).then((snapshot) => { if (!cancelled) setItems(snapshot.events.filter((event) => event.level === "warning")); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [clusterId]);
  return <div className="modal-backdrop panel-dialog-backdrop" onMouseDown={onClose}><section className="alerts-modal" onMouseDown={(event) => event.stopPropagation()}><div className="dialog-header"><h2>{tr(language, "alerts")}</h2><Badge tone="amber">{items.length} {tr(language, "active")}</Badge><div /><Button variant="ghost" size="icon" aria-label={tr(language, "close")} onClick={onClose}><X size={15} /></Button></div><ScrollArea className="alerts-scroll-area" viewportClassName="drawer-events"><div className="drawer-events-content">{items.map((event, index) => <div key={`${event.object}-${index}`}><AlertTriangle size={14} /><div><strong>{event.reason}</strong><span>{event.message}</span><small>{event.time} ago · {event.object}</small></div></div>)}{items.length === 0 && <div className="related-empty">{tr(language, "noActiveWarnings")}</div>}</div></ScrollArea><footer><span>{tr(language, "showingActiveWarnings")}</span><Button variant="outline" size="sm" onClick={onClose}>{tr(language, "close")}</Button></footer></section></div>;
}

export { AlertsDialog };
