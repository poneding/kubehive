import { Badge, Button, Checkbox, ScrollArea } from "@/components/ui";
import { cn } from "@/lib/utils";
import { Box, ChevronRight, Code2, Power, Search, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { descriptorForResource, nativeBackendAvailable, type ApiResourceDescriptor } from "../backend";
import { clusterAccent, clusterConnectionStatus, navGroups, type Cluster } from "../data";
import { tr } from "../i18n";
import { groupLabel, resourceLabel, t, type AppLanguage } from "../preferences";
import { StatusDot } from "./app-controls";
import { customResourceGroups, navWidthMax, NAV_WIDTH_MIN, platform } from "./app-state";
import { iconMap } from "./resource-icons";
import type { CustomResourceNavEntry } from "./types";

function VisibilityCheckbox({ checked, indeterminate = false, label, onChange }: { checked: boolean; indeterminate?: boolean; label: string; onChange: (checked: boolean) => void }) {
  return <Checkbox className="resource-tree-checkbox" checked={indeterminate ? "indeterminate" : checked} aria-label={label} onCheckedChange={(nextChecked) => onChange(nextChecked === true)} />;
}

/** Navigation group that hosts the CRDs discovered in the active cluster. */
const customResourceGroup = "Custom Resources";

/**
 * Rows of one navigation group in the visibility filter: the static items
 * first, then the installed CRDs bucketed by API group so a whole group can be
 * shown or hidden in one click. `ids` covers every togglable row.
 */
function resourceFilterRows(group: { label: string; items: string[] }, language: AppLanguage, customResources: CustomResourceNavEntry[]) {
  const items = group.items.map((item) => ({ id: item, label: resourceLabel(language, item) }));
  const apiGroups = group.label === customResourceGroup
    ? customResourceGroups(customResources).map(({ group: apiGroup, items: kinds }) => ({
      apiGroup,
      items: kinds.map((entry) => ({ id: entry.name, label: entry.kind })),
    }))
    : [];
  return {
    items,
    apiGroups,
    ids: [...items.map((item) => item.id), ...apiGroups.flatMap((entry) => entry.items.map((item) => item.id))],
  };
}

function ResourceTreeFilter({ language, hidden, customResources, onToggleItem, onToggleGroup, onReset }: {
  language: AppLanguage;
  hidden: Set<string>;
  customResources: CustomResourceNavEntry[];
  onToggleItem: (item: string, visible: boolean) => void;
  onToggleGroup: (items: string[], visible: boolean) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", closeOnEscape); };
  }, [open]);
  return <div ref={root} className={cn("resource-tree-filter", open && "open")}>
    <Button type="button" variant="ghost" size="icon" className="resource-tree-filter-trigger" aria-label={t(language, "resourceVisibility")} title={t(language, "resourceVisibility")} aria-expanded={open} onClick={() => setOpen((value) => !value)}><SlidersHorizontal size={14} /></Button>
    {open && <div className="resource-tree-filter-popover" role="dialog" aria-label={t(language, "resourceVisibility")}>
      <header><div><strong>{t(language, "resourceVisibility")}</strong><small>{t(language, "resourceVisibilityHint")}</small></div><button type="button" onClick={onReset}>{t(language, "showAll")}</button></header>
      <ScrollArea className="resource-tree-filter-scroll-area" viewportClassName="resource-tree-filter-list">
        <div className="resource-tree-filter-list-content">{navGroups.map((group) => {
          const { items, apiGroups, ids } = resourceFilterRows(group, language, customResources);
          const visibleCount = ids.filter((id) => !hidden.has(id)).length;
          const checked = visibleCount === ids.length;
          const itemRow = (entry: { id: string; label: string }, className?: string) => <label key={entry.id} className={className}><VisibilityCheckbox checked={!hidden.has(entry.id)} label={`${t(language, "showResource")} ${entry.label}`} onChange={(visible) => onToggleItem(entry.id, visible)} /><span>{entry.label}</span></label>;
          return <section key={group.label} data-filter-group={group.label}>
            <label className="resource-tree-filter-group"><VisibilityCheckbox checked={checked} indeterminate={visibleCount > 0 && !checked} label={`${t(language, "showGroup")} ${groupLabel(language, group.label)}`} onChange={(visible) => onToggleGroup(ids, visible)} /><strong>{groupLabel(language, group.label)}</strong><small>{visibleCount}/{ids.length}</small></label>
            <div>
              {items.map((entry) => itemRow(entry))}
              {apiGroups.map(({ apiGroup, items: kinds }) => {
                const kindIds = kinds.map((entry) => entry.id);
                const visibleKinds = kindIds.filter((id) => !hidden.has(id)).length;
                const allKindsVisible = visibleKinds === kindIds.length;
                return <div key={apiGroup} className="resource-tree-filter-subgroup" data-filter-api-group={apiGroup}>
                  <label className="resource-tree-filter-group resource-tree-filter-api-group"><VisibilityCheckbox checked={allKindsVisible} indeterminate={visibleKinds > 0 && !allKindsVisible} label={`${t(language, "showGroup")} ${apiGroup}`} onChange={(visible) => onToggleGroup(kindIds, visible)} /><strong>{apiGroup}</strong><small>{visibleKinds}/{kindIds.length}</small></label>
                  {kinds.map((entry) => itemRow(entry, "resource-tree-filter-api-item"))}
                </div>;
              })}
            </div>
          </section>;
        })}</div>
      </ScrollArea>
    </div>}
  </div>;
}

function ResourceNav({ active, activeCustomResource, cluster, language, discovered, customResources, navWidth, onNavWidthChange, onSelect, onSelectCustomResource, onCloseCluster, closing, open, onClose, onCommand }: { active: string; activeCustomResource: string | null; cluster: Cluster; language: AppLanguage; discovered: ApiResourceDescriptor[]; customResources: CustomResourceNavEntry[]; navWidth: number; onNavWidthChange: (width: number) => void; onSelect: (item: string, permanent?: boolean) => void; onSelectCustomResource: (entry: CustomResourceNavEntry, permanent?: boolean) => void; onCloseCluster: () => void; closing: boolean; open: boolean; onClose: () => void; onCommand: () => void }) {
  const [query, setQuery] = useState("");
  const [resizing, setResizing] = useState(false);
  const resizeDrag = useRef<{ startX: number; startWidth: number } | null>(null);
  const startNavResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeDrag.current = { startX: event.clientX, startWidth: navWidth };
    setResizing(true);
    document.body.style.userSelect = "none";
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const moveNavResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeDrag.current;
    if (!drag) return;
    onNavWidthChange(drag.startWidth + event.clientX - drag.startX);
  };
  const endNavResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizeDrag.current) return;
    resizeDrag.current = null;
    setResizing(false);
    document.body.style.userSelect = "";
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
  const [hiddenItems, setHiddenItems] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("kubehive.resourceTreeHidden") ?? "[]") as string[]); }
    catch { return new Set(); }
  });
  const updateHiddenItems = (update: (current: Set<string>) => Set<string>) => setHiddenItems((current) => {
    const next = update(current);
    localStorage.setItem("kubehive.resourceTreeHidden", JSON.stringify([...next]));
    return next;
  });
  // API groups start collapsed: a cluster with operators installed serves far
  // more custom kinds than the built-in tree has entries.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("kubehive.customResourceGroups") ?? "[]") as string[]); }
    catch { return new Set(); }
  });
  const toggleApiGroup = (group: string) => setExpandedGroups((current) => {
    const next = new Set(current);
    if (next.has(group)) next.delete(group);
    else next.add(group);
    localStorage.setItem("kubehive.customResourceGroups", JSON.stringify([...next]));
    return next;
  });
  const served = (item: string) => {
    if (!nativeBackendAvailable || discovered.length === 0 || ["Overview", "Port Forwarding", "Helm Charts", "Helm Releases"].includes(item)) return true;
    const descriptor = descriptorForResource(item, discovered);
    return Boolean(descriptor && discovered.some((resource) => resource.kind === descriptor.kind && resource.apiVersion === descriptor.apiVersion));
  };
  const shortcutMod = platform === "macos" ? "⌘" : "Ctrl";
  // A custom resource page keeps its own entry highlighted, not the CRD list.
  const activeItem = activeCustomResource ? "" : active;
  const matchesQuery = (id: string, label: string) => `${id} ${label}`.toLowerCase().includes(query.toLowerCase());
  return <aside className={cn("resource-nav", open && "mobile-open")}>
    <div className="nav-title"><span>{t(language, "resources")}</span><div className="nav-title-actions"><ResourceTreeFilter language={language} hidden={hiddenItems} customResources={customResources} onToggleItem={(item, visible) => updateHiddenItems((current) => { const next = new Set(current); if (visible) next.delete(item); else next.add(item); return next; })} onToggleGroup={(items, visible) => updateHiddenItems((current) => { const next = new Set(current); items.forEach((item) => visible ? next.delete(item) : next.add(item)); return next; })} onReset={() => updateHiddenItems(() => new Set())} /><Button variant="ghost" size="icon" className="mobile-only" aria-label={tr(language, "closeNavigation")} onClick={onClose}><X size={15} /></Button></div></div>
    <div className={cn("nav-search", query && "has-value")}>
      <Search size={13} aria-hidden="true" />
      <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t(language, "filterResources")} placeholder={t(language, "filterResources")} />
      {query
        ? <button type="button" className="table-search-clear" aria-label={tr(language, "clear")} onClick={() => setQuery("")}><X size={12} /></button>
        : <button type="button" className="nav-search-command" aria-label={t(language, "searchResources")} title={t(language, "searchResources")} onClick={onCommand}><span className="command-shortcut"><kbd>{shortcutMod}</kbd><kbd>K</kbd></span></button>}
    </div>
    <ScrollArea className="resource-nav-scroll-area overflow-visible" verticalScrollbarOffset={-10} viewportClassName="resource-nav-scroll"><nav>{navGroups.map((group) => {
      const items = group.items.filter((item) => !hiddenItems.has(item) && matchesQuery(item, resourceLabel(language, item)));
      // Installed CRDs are appended to their group: they only exist while the
      // cluster serves them, so they cannot live in the static nav tree.
      const customItems = group.label === customResourceGroup ? customResources.filter((entry) => !hiddenItems.has(entry.name) && matchesQuery(entry.name, entry.label)) : [];
      if (!items.length && !customItems.length) return null;
      return <section key={group.label}>{group.label !== "Overview" && <p>{groupLabel(language, group.label)}</p>}{items.map((item) => { const Icon = iconMap[item] ?? Box; const available = served(item); return <button key={item} type="button" aria-label={item} disabled={!available} title={available ? undefined : "This API is not served by the active cluster"} className={cn(activeItem === item && "selected", !available && "unavailable")} onClick={() => { onSelect(item, false); onClose(); }} onDoubleClick={() => { onSelect(item, true); onClose(); }}><Icon size={14} /><span>{resourceLabel(language, item)}</span>{!available && <small>—</small>}</button>; })}{customResourceGroups(customItems).map(({ group: apiGroup, items: kinds }) => {
        // A filter query reveals the matches it found inside collapsed groups.
        const expanded = expandedGroups.has(apiGroup) || query.trim().length > 0;
        const holdsActive = kinds.some((entry) => entry.name === activeCustomResource);
        return <div key={apiGroup} className="nav-custom-group">
          <button type="button" className={cn("nav-custom-group-toggle", !expanded && holdsActive && "has-active")} aria-label={apiGroup} aria-expanded={expanded} title={apiGroup} onClick={() => toggleApiGroup(apiGroup)}><ChevronRight className={cn("nav-custom-group-chevron", expanded && "expanded")} size={13} /><span>{apiGroup}</span><small aria-hidden="true">{kinds.length}</small></button>
          {expanded && <div className="nav-custom-group-items" role="group" aria-label={apiGroup}>{kinds.map((entry) => <button key={entry.name} type="button" aria-label={entry.kind} title={entry.name} className={cn("nav-custom-resource", activeCustomResource === entry.name && "selected")} onClick={() => { onSelectCustomResource(entry, false); onClose(); }} onDoubleClick={() => { onSelectCustomResource(entry, true); onClose(); }}><Code2 size={14} /><span>{entry.kind}</span></button>)}</div>}
        </div>;
      })}</section>;
    })}</nav></ScrollArea>
    <div className="cluster-summary" style={{ ["--cluster-accent" as string]: clusterAccent(cluster) }}><div className="cluster-summary-head"><span className="cluster-summary-icon">{cluster.name.slice(0, 2).toUpperCase()}</span><div><small>{t(language, "currentCluster")}</small><strong>{cluster.name}</strong></div><StatusDot status={clusterConnectionStatus(cluster)} /></div><div className="cluster-summary-meta"><span>{cluster.provider} · {cluster.region}</span><Badge>{cluster.version}</Badge></div><div className="cluster-summary-stats"><div className="cluster-summary-metrics"><span><strong>{cluster.nodes}</strong> nodes</span><span><strong>{cluster.cpu}%</strong> CPU</span></div><div className="cluster-summary-actions"><Button type="button" variant="ghost" size="icon" className="hover-destructive" disabled={closing} aria-label={closing ? t(language, "closingConnection") : t(language, "closeConnection")} title={closing ? t(language, "closingConnection") : t(language, "closeConnection")} onClick={onCloseCluster}><Power size={12} /></Button></div></div></div>
    <div role="separator" aria-orientation="vertical" aria-label={t(language, "resizeNav")} aria-valuemin={NAV_WIDTH_MIN} aria-valuemax={navWidthMax()} aria-valuenow={navWidth} tabIndex={0} title={t(language, "resizeNav")} className={cn("nav-resize-handle", resizing && "resizing")} onPointerDown={startNavResize} onPointerMove={moveNavResize} onPointerUp={endNavResize} onPointerCancel={endNavResize} onDoubleClick={() => onNavWidthChange(NAV_WIDTH_MIN)} onKeyDown={(event) => { if (event.key === "ArrowLeft") { event.preventDefault(); onNavWidthChange(navWidth - 10); } else if (event.key === "ArrowRight") { event.preventDefault(); onNavWidthChange(navWidth + 10); } else if (event.key === "Home") { event.preventDefault(); onNavWidthChange(NAV_WIDTH_MIN); } else if (event.key === "End") { event.preventDefault(); onNavWidthChange(navWidthMax()); } }} />
  </aside>;
}

export { ResourceNav };
