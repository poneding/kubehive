import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { tr, type AppLanguage } from "./i18n";
import { Checkbox } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { ContainerInfo, ResourceLink, ResourceRow } from "./resource-catalog";

export type VirtualTableColumn<T extends ResourceRow> = {
  id: string;
  label: string;
  render: (row: T) => ReactNode;
  sortValue?: (row: T) => unknown;
};

type SortState = { columnId: string; direction: "asc" | "desc" } | null;

type ResourceColumnWidth = "compact" | "standard" | "roomy" | "primary";

const compactColumnIds = new Set([
  "active", "age", "allowExpansion", "available", "completions", "connection", "count", "cpu", "current", "default", "desired",
  "globalDefault", "instances", "max", "maxPods", "maxUnavailable", "memory", "min", "minAvailable", "minPods", "pods",
  "ready", "restarts", "revision", "replicas", "suspend", "upToDate", "value",
]);

const roomyColumnIds = new Set([
  "addresses", "address", "apiVersion", "claim", "clusterIp", "controlledBy", "description", "externalIp", "hosts", "kubeconfig", "labels",
  "localAddress", "message", "nodeSelector", "object", "parameters", "podSelector", "provisioner", "reference", "repository", "resolvedPod",
  "role", "rules", "runAsUser", "schedule", "selector", "server", "subjects", "targets", "volume", "volumes", "webhooks",
]);

const columnWidth = (columnId: string): ResourceColumnWidth => {
  if (columnId === "name") return "primary";
  if (compactColumnIds.has(columnId)) return "compact";
  return roomyColumnIds.has(columnId) ? "roomy" : "standard";
};

const columnWidthPixels: Record<ResourceColumnWidth, number> = {
  compact: 76,
  standard: 100,
  roomy: 150,
  primary: 250,
};

const tableSortStorageKey = (tableKey: string) => `kubehive.tableSort.${tableKey}`;

function loadTableSort(tableKey: string): SortState {
  try {
    const saved = JSON.parse(localStorage.getItem(tableSortStorageKey(tableKey)) ?? "null") as Partial<NonNullable<SortState>> | null;
    if (!saved || typeof saved.columnId !== "string" || !["asc", "desc"].includes(saved.direction ?? "")) return null;
    return { columnId: saved.columnId, direction: saved.direction as "asc" | "desc" };
  } catch {
    return null;
  }
}

function saveTableSort(tableKey: string, sort: SortState) {
  try {
    if (sort) localStorage.setItem(tableSortStorageKey(tableKey), JSON.stringify(sort));
    else localStorage.removeItem(tableSortStorageKey(tableKey));
  } catch {
    // Sorting still works for the current session when storage is unavailable.
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function defaultSortValue(row: ResourceRow, columnId: string): unknown {
  if (columnId === "name") return row.name;
  if (columnId === "namespace") return row.namespace;
  if (columnId === "kind") return row.kind;
  if (columnId === "status") return row.status;
  if (columnId === "age" && row.backend?.ageSeconds !== undefined) return row.backend.ageSeconds;
  return row.data[columnId];
}

function isMissingSortValue(value: unknown) {
  return value === undefined || value === null || value === "" || value === "—";
}

function normalizedSortValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const ratio = text.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)$/);
  if (ratio) return Number(ratio[2]) === 0 ? Number(ratio[1]) : Number(ratio[1]) / Number(ratio[2]);
  const duration = text.match(/^(-?\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w|y)(?:\s+ago)?$/i);
  if (duration) {
    const factors: Record<string, number> = { ms: .001, s: 1, m: 60, h: 3_600, d: 86_400, w: 604_800, y: 31_536_000 };
    return Number(duration[1]) * factors[duration[2].toLowerCase()];
  }
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === "true";
  if (/^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/.test(text)) {
    const timestamp = Date.parse(text);
    if (!Number.isNaN(timestamp)) return timestamp;
  }
  return text;
}

function compareValues(left: unknown, right: unknown): number {
  const normalizedLeft = normalizedSortValue(left);
  const normalizedRight = normalizedSortValue(right);
  if (typeof normalizedLeft === "number" && typeof normalizedRight === "number") return normalizedLeft - normalizedRight;
  if (typeof normalizedLeft === "boolean" && typeof normalizedRight === "boolean") return Number(normalizedLeft) - Number(normalizedRight);
  return collator.compare(String(normalizedLeft), String(normalizedRight));
}

function TableSelectionCheckbox({ checked, indeterminate = false, disabled = false, ariaLabel, onChange }: {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (checked: boolean) => void;
}) {
  return <Checkbox className="resource-selection-checkbox" checked={indeterminate ? "indeterminate" : checked} disabled={disabled} aria-label={ariaLabel} onCheckedChange={(nextChecked) => onChange(nextChecked === true)} />;
}

function sortRows<T extends ResourceRow>(rows: T[], columns: VirtualTableColumn<T>[], sort: SortState): T[] {
  if (!sort) return rows;
  const column = columns.find((candidate) => candidate.id === sort.columnId);
  if (!column) return rows;
  const direction = sort.direction === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const leftValue = column.sortValue ? column.sortValue(left.row) : defaultSortValue(left.row, column.id);
      const rightValue = column.sortValue ? column.sortValue(right.row) : defaultSortValue(right.row, column.id);
      const leftMissing = isMissingSortValue(leftValue);
      const rightMissing = isMissingSortValue(rightValue);
      if (leftMissing || rightMissing) return leftMissing === rightMissing ? left.index - right.index : leftMissing ? 1 : -1;
      const result = compareValues(leftValue, rightValue);
      return result === 0 ? left.index - right.index : result * direction;
    })
    .map(({ row }) => row);
}

export function VirtualResourceTable<T extends ResourceRow>({
  rows,
  columns,
  language,
  tableKey,
  headerAction,
  renderAction,
  onRowClick,
  onRowDoubleClick,
  onRowContextMenu,
  rowClassName,
  rowStyle,
  selectedKeys,
  onSelectionChange,
  empty,
  className,
  actionWidth,
}: {
  rows: T[];
  columns: VirtualTableColumn<T>[];
  language?: AppLanguage;
  tableKey: string;
  headerAction?: ReactNode;
  renderAction?: (row: T) => ReactNode;
  onRowClick?: (row: T) => void;
  onRowDoubleClick?: (row: T) => void;
  onRowContextMenu?: (event: MouseEvent<HTMLTableRowElement>, row: T) => void;
  rowClassName?: (row: T) => string | undefined;
  rowStyle?: (row: T) => CSSProperties | undefined;
  selectedKeys?: ReadonlySet<string>;
  onSelectionChange?: (selectedKeys: Set<string>) => void;
  empty?: ReactNode;
  className?: string;
  actionWidth?: number;
}) {
  const displayLanguage = language ?? (document.documentElement.lang === "zh-TW" ? "zh-TW" : document.documentElement.lang === "zh-CN" ? "zh-CN" : "en");
  const [sort, setSort] = useState<SortState>(() => loadTableSort(tableKey));
  const scrollRef = useRef<HTMLDivElement>(null);
  const [tableContentWidth, setTableContentWidth] = useState(0);
  const [virtualScrollElement, setVirtualScrollElement] = useState<HTMLElement | null>(null);
  const [virtualScrollMargin, setVirtualScrollMargin] = useState(0);
  useEffect(() => {
    setSort(loadTableSort(tableKey));
    const node = scrollRef.current;
    const scroller = (node?.closest(".workspace-scroll, .cluster-home-scroll") as HTMLElement | null) ?? node;
    if (scroller) scroller.scrollTop = 0;
  }, [tableKey]);
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const scrollViewport = node.closest(".workspace-scroll, .cluster-home-scroll") as HTMLElement | null;
    const measurementTarget = scrollViewport ?? node;
    const updateWidth = () => {
      const style = scrollViewport ? getComputedStyle(scrollViewport) : null;
      const horizontalPadding = style ? Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight) : 0;
      const nextWidth = Math.max(0, measurementTarget.clientWidth - horizontalPadding);
      setTableContentWidth((current) => Math.abs(current - nextWidth) < 0.5 ? current : nextWidth);
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(measurementTarget);
    return () => observer.disconnect();
  }, [tableKey]);
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const scroller = (node.closest(".workspace-scroll, .cluster-home-scroll") as HTMLElement | null) ?? node;
    const nextMargin = scroller === node
      ? 0
      : node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    setVirtualScrollElement((current) => current === scroller ? current : scroller);
    setVirtualScrollMargin((current) => Math.abs(current - nextMargin) < 0.5 ? current : nextMargin);
  });
  // Shift+wheel pans horizontally on the workspace scroller (panel must not be a
  // scrollport or sticky thead/toolbar stacking breaks).
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const scroller = (node.closest(".workspace-scroll") as HTMLElement | null) ?? node;
    const onWheel = (event: WheelEvent) => {
      if (!event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta || scroller.scrollWidth <= scroller.clientWidth) return;
      scroller.scrollLeft += delta;
      event.preventDefault();
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [tableKey]);
  useEffect(() => {
    setSort((current) => {
      if (!current || columns.some((column) => column.id === current.columnId)) return current;
      saveTableSort(tableKey, null);
      return null;
    });
  }, [columns, tableKey]);
  const sortedRows = useMemo(() => sortRows(rows, columns, sort), [rows, columns, sort]);
  const virtualizer = useVirtualizer({
    count: sortedRows.length,
    getScrollElement: () => virtualScrollElement,
    estimateSize: () => 53,
    overscan: 3,
    getItemKey: (index) => sortedRows[index]?.key ?? index,
    scrollMargin: virtualScrollMargin,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const selectionEnabled = selectedKeys !== undefined && onSelectionChange !== undefined;
  const activeSelectedKeys = selectedKeys ?? new Set<string>();
  const selectedVisibleCount = selectionEnabled ? rows.reduce((count, row) => count + Number(activeSelectedKeys.has(row.key)), 0) : 0;
  const allVisibleSelected = selectionEnabled && rows.length > 0 && selectedVisibleCount === rows.length;
  const someVisibleSelected = selectionEnabled && selectedVisibleCount > 0 && !allVisibleSelected;
  const tableColumnCount = columns.length + 1 + Number(selectionEnabled);
  const setAllVisibleSelected = (checked: boolean) => {
    if (!selectionEnabled) return;
    const next = new Set(activeSelectedKeys);
    rows.forEach((row) => checked ? next.add(row.key) : next.delete(row.key));
    onSelectionChange?.(next);
  };
  const setRowSelected = (row: T, checked: boolean) => {
    if (!selectionEnabled) return;
    const next = new Set(activeSelectedKeys);
    if (checked) next.add(row.key);
    else next.delete(row.key);
    onSelectionChange?.(next);
  };
  const paddingTop = virtualRows.length ? Math.max(0, virtualRows[0].start - virtualScrollMargin) : 0;
  const paddingBottom = virtualRows.length ? Math.max(0, virtualizer.getTotalSize() - (virtualRows[virtualRows.length - 1].end - virtualScrollMargin)) : 0;
  const toggleSort = (columnId: string) => {
    setSort((current) => {
      const next: SortState = current?.columnId !== columnId
        ? { columnId, direction: "asc" }
        : current.direction === "asc"
          ? { columnId, direction: "desc" }
          : null;
      saveTableSort(tableKey, next);
      return next;
    });
    const node = scrollRef.current;
    const scroller = (node?.closest(".workspace-scroll, .cluster-home-scroll") as HTMLElement | null) ?? node;
    if (scroller) scroller.scrollTop = 0;
  };

  const columnClassName = (columnId: string) => cn(columnId === "name" && "name-col", `column-${columnWidth(columnId)}`);
  // Short counters and timestamps should not consume the room needed for names,
  // controllers, selectors, and other reference-like values.
  const actionColumnWidth = actionWidth ?? 44;
  const selectionColumnWidth = 36;
  const tableMinWidth = columns.reduce((total, column) => total + columnWidthPixels[columnWidth(column.id)], actionColumnWidth + Number(selectionEnabled) * selectionColumnWidth);
  const adaptableColumnBaseWidth = tableMinWidth - selectionColumnWidth;
  const adaptableColumnScale = selectionEnabled && adaptableColumnBaseWidth > 0
    ? (Math.max(tableMinWidth, tableContentWidth) - selectionColumnWidth) / adaptableColumnBaseWidth
    : 1;
  const adaptableColumnWidth = (width: number) => width * adaptableColumnScale;

  return <div ref={scrollRef} className={cn("resource-table-wrap", "virtualized", className)} data-row-count={rows.length}>
    <table
      className="resource-table"
      style={{
        minWidth: tableMinWidth,
        ["--resource-table-min-width" as string]: `${tableMinWidth}px`,
        ["--resource-compact-col-width" as string]: `${adaptableColumnWidth(columnWidthPixels.compact)}px`,
        ["--resource-standard-col-width" as string]: `${adaptableColumnWidth(columnWidthPixels.standard)}px`,
        ["--resource-roomy-col-width" as string]: `${adaptableColumnWidth(columnWidthPixels.roomy)}px`,
        ["--resource-name-col-min" as string]: `${adaptableColumnWidth(columnWidthPixels.primary)}px`,
        ["--resource-name-col-width" as string]: `${adaptableColumnWidth(columnWidthPixels.primary)}px`,
        ["--resource-action-col-width" as string]: `${adaptableColumnWidth(actionColumnWidth)}px`,
        ["--resource-selection-col-width" as string]: `${selectionColumnWidth}px`,
        ["--resource-col-min" as string]: `${adaptableColumnWidth(columnWidthPixels.standard)}px`,
      }}
    >
      {selectionEnabled && <colgroup><col className="selection-col" style={{ width: selectionColumnWidth }} /></colgroup>}
      <thead><tr>{selectionEnabled && <th className="selection-col"><TableSelectionCheckbox checked={allVisibleSelected} indeterminate={someVisibleSelected} disabled={rows.length === 0} ariaLabel={tr(displayLanguage, "selectAllVisibleResources")} onChange={setAllVisibleSelected} /></th>}{columns.map((column) => {
        const direction = sort?.columnId === column.id ? sort.direction : null;
        const SortIcon = direction === "asc" ? ArrowUp : direction === "desc" ? ArrowDown : ArrowUpDown;
        return <th key={column.id} className={columnClassName(column.id)} aria-sort={direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none"}>
          <button type="button" className={cn("table-sort-button", direction && "active")} onClick={() => toggleSort(column.id)} title={tr(displayLanguage, "sortBy", { column: column.label })}>
            <span>{column.label}</span><SortIcon size={11}/>
          </button>
        </th>;
      })}<th className="actions-col">{headerAction}</th></tr></thead>
      <tbody>
        {paddingTop > 0 && <tr className="virtual-spacer" aria-hidden="true"><td colSpan={tableColumnCount} style={{ height: paddingTop }}/></tr>}
        {virtualRows.map((virtualRow) => {
          const row = sortedRows[virtualRow.index];
          const selected = selectionEnabled && activeSelectedKeys.has(row.key);
          return <tr key={row.key} className={cn(selected && "selected", rowClassName?.(row))} style={rowStyle?.(row)} data-index={virtualRow.index} onClick={() => onRowClick?.(row)} onDoubleClick={() => onRowDoubleClick?.(row)} onContextMenu={(event) => onRowContextMenu?.(event, row)}>
            {selectionEnabled && <td className="selection-col" onClick={(event) => event.stopPropagation()}><TableSelectionCheckbox checked={selected} ariaLabel={tr(displayLanguage, "selectResource", { kind: row.kind, name: row.name })} onChange={(checked) => setRowSelected(row, checked)} /></td>}
            {columns.map((column) => <td key={column.id} className={columnClassName(column.id)}>{column.render(row)}</td>)}
            <td className="actions-col" onClick={(event) => event.stopPropagation()}>{renderAction?.(row)}</td>
          </tr>;
        })}
        {paddingBottom > 0 && <tr className="virtual-spacer" aria-hidden="true"><td colSpan={tableColumnCount} style={{ height: paddingBottom }}/></tr>}
        {rows.length === 0 && empty !== undefined && <tr className="empty-row"><td colSpan={tableColumnCount}>{empty}</td></tr>}
      </tbody>
    </table>
  </div>;
}

type TooltipPlacement = {
  style: CSSProperties;
  side: "top" | "bottom";
  align: "center" | "left" | "right";
};

function placeTooltip(anchor: DOMRect, tooltip: DOMRect): TooltipPlacement {
  const gap = 8;
  const margin = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const spaceAbove = anchor.top - margin;
  const spaceBelow = vh - anchor.bottom - margin;
  const preferTop = spaceAbove >= tooltip.height + gap || spaceAbove >= spaceBelow;
  const side: "top" | "bottom" = preferTop && spaceAbove >= 48 ? "top" : "bottom";

  let left = anchor.left + anchor.width / 2 - tooltip.width / 2;
  let align: TooltipPlacement["align"] = "center";
  if (left < margin) {
    left = margin;
    align = "left";
  } else if (left + tooltip.width > vw - margin) {
    left = Math.max(margin, vw - margin - tooltip.width);
    align = "right";
  }

  const top = side === "top"
    ? Math.max(margin, anchor.top - tooltip.height - gap)
    : Math.min(vh - margin - tooltip.height, anchor.bottom + gap);

  return {
    side,
    align,
    style: {
      position: "fixed",
      top,
      left,
      zIndex: 200,
    },
  };
}

function ContainerSquare({ container, language }: { container: ContainerInfo; language?: AppLanguage }) {
  const displayLanguage = language ?? (document.documentElement.lang === "zh-TW" ? "zh-TW" : document.documentElement.lang === "zh-CN" ? "zh-CN" : "en");
  const squareRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<TooltipPlacement | null>(null);

  useLayoutEffect(() => {
    if (!open || !squareRef.current || !tooltipRef.current) return;
    const update = () => {
      if (!squareRef.current || !tooltipRef.current) return;
      setPlacement(placeTooltip(squareRef.current.getBoundingClientRect(), tooltipRef.current.getBoundingClientRect()));
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, container.name]);

  return <>
    <span
      ref={squareRef}
      className={cn("container-square", container.status)}
      tabIndex={0}
      aria-label={tr(displayLanguage, "containerStatus", { status: container.status })}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    />
    {open && createPortal(
      <span
        ref={tooltipRef}
        className={cn("container-tooltip", placement && `side-${placement.side}`, placement && `align-${placement.align}`)}
        style={placement?.style ?? { position: "fixed", top: -9999, left: -9999, visibility: "hidden" }}
        role="tooltip"
      >
        <strong>{container.name}</strong>
        <small>{tr(displayLanguage, "containerStatus", { status: container.status })}</small>
        <small>{tr(displayLanguage, "containerReady", { ready: container.ready ? "true" : "false" })}</small>
        <small>{tr(displayLanguage, "containerRestarts", { count: container.restarts })}</small>
        <small>{tr(displayLanguage, "containerImage", { image: container.image })}</small>
        {container.port && <small>{tr(displayLanguage, "containerPort", { port: container.port })}</small>}
      </span>,
      document.body,
    )}
  </>;
}

export function ContainerSquares({ containers, language }: { containers: ContainerInfo[]; language?: AppLanguage }) {
  if (!containers.length) return <span>—</span>;
  return <div className="container-squares" onClick={(event) => event.stopPropagation()}>
    {containers.map((container) => <ContainerSquare key={container.name} container={container} language={language} />)}
  </div>;
}

export function ResourceLinkButton({
  link,
  label,
  stacked = false,
  language,
  onOpen,
}: {
  link: ResourceLink;
  label: string;
  stacked?: boolean;
  language?: AppLanguage;
  onOpen: (link: ResourceLink) => void;
}) {
  const displayLanguage = language ?? (document.documentElement.lang === "zh-TW" ? "zh-TW" : document.documentElement.lang === "zh-CN" ? "zh-CN" : "en");
  if (stacked) {
    return <button
      type="button"
      className="resource-link resource-link-stacked"
      onClick={(event) => { event.stopPropagation(); onOpen(link); }}
      title={tr(displayLanguage, "openResource", { kind: link.kind, name: link.name })}
    >
      <small>{link.kind}</small>
      <strong>{link.name}</strong>
    </button>;
  }

  return <button
    type="button"
    className="resource-link"
    onClick={(event) => { event.stopPropagation(); onOpen(link); }}
    title={tr(displayLanguage, "openResource", { kind: link.kind, name: link.name })}
  >
    {label}
  </button>;
}
