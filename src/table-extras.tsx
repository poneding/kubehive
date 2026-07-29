import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "./ui";
import type { ContainerInfo, ResourceLink, ResourceRow } from "./resource-catalog";

export type VirtualTableColumn<T extends ResourceRow> = {
  id: string;
  label: string;
  render: (row: T) => ReactNode;
  sortValue?: (row: T) => unknown;
};

type SortState = { columnId: string; direction: "asc" | "desc" } | null;

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
  tableKey,
  headerAction,
  renderAction,
  onRowClick,
  onRowContextMenu,
  empty,
  className,
}: {
  rows: T[];
  columns: VirtualTableColumn<T>[];
  tableKey: string;
  headerAction?: ReactNode;
  renderAction?: (row: T) => ReactNode;
  onRowClick?: (row: T) => void;
  onRowContextMenu?: (event: MouseEvent<HTMLTableRowElement>, row: T) => void;
  empty?: ReactNode;
  className?: string;
}) {
  const [sort, setSort] = useState<SortState>(() => loadTableSort(tableKey));
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setSort(loadTableSort(tableKey));
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
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
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 53,
    overscan: 3,
    getItemKey: (index) => sortedRows[index]?.key ?? index,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const paddingTop = virtualRows.length ? virtualRows[0].start : 0;
  const paddingBottom = virtualRows.length ? virtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end : 0;
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
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };

  return <div ref={scrollRef} className={cn("resource-table-wrap", "virtualized", className)} data-row-count={rows.length}>
    <table className="resource-table">
      <thead><tr>{columns.map((column) => {
        const direction = sort?.columnId === column.id ? sort.direction : null;
        const SortIcon = direction === "asc" ? ArrowUp : direction === "desc" ? ArrowDown : ArrowUpDown;
        return <th key={column.id} aria-sort={direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none"}>
          <button type="button" className={cn("table-sort-button", direction && "active")} onClick={() => toggleSort(column.id)} title={`Sort by ${column.label}`}>
            <span>{column.label}</span><SortIcon size={11}/>
          </button>
        </th>;
      })}<th className="actions-col">{headerAction}</th></tr></thead>
      <tbody>
        {paddingTop > 0 && <tr className="virtual-spacer" aria-hidden="true"><td colSpan={columns.length + 1} style={{ height: paddingTop }}/></tr>}
        {virtualRows.map((virtualRow) => {
          const row = sortedRows[virtualRow.index];
          return <tr key={row.key} data-index={virtualRow.index} onClick={() => onRowClick?.(row)} onContextMenu={(event) => onRowContextMenu?.(event, row)}>
            {columns.map((column) => <td key={column.id}>{column.render(row)}</td>)}
            <td className="actions-col" onClick={(event) => event.stopPropagation()}>{renderAction?.(row)}</td>
          </tr>;
        })}
        {paddingBottom > 0 && <tr className="virtual-spacer" aria-hidden="true"><td colSpan={columns.length + 1} style={{ height: paddingBottom }}/></tr>}
        {rows.length === 0 && empty !== undefined && <tr className="empty-row"><td colSpan={columns.length + 1}>{empty}</td></tr>}
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

function ContainerSquare({ container }: { container: ContainerInfo }) {
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
      aria-label={`${container.name} ${container.status}`}
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
        <small>Status · {container.status}</small>
        <small>Ready · {container.ready ? "true" : "false"}</small>
        <small>Restarts · {container.restarts}</small>
        <small>Image · {container.image}</small>
        {container.port && <small>Port · {container.port}</small>}
      </span>,
      document.body,
    )}
  </>;
}

export function ContainerSquares({ containers }: { containers: ContainerInfo[] }) {
  if (!containers.length) return <span>—</span>;
  return <div className="container-squares" onClick={(event) => event.stopPropagation()}>
    {containers.map((container) => <ContainerSquare key={container.name} container={container} />)}
  </div>;
}

export function ResourceLinkButton({
  link,
  label,
  stacked = false,
  onOpen,
}: {
  link: ResourceLink;
  label: string;
  stacked?: boolean;
  onOpen: (link: ResourceLink) => void;
}) {
  if (stacked) {
    return <button
      type="button"
      className="resource-link resource-link-stacked"
      onClick={(event) => { event.stopPropagation(); onOpen(link); }}
      title={`Open ${link.kind}/${link.name}`}
    >
      <small>{link.kind}</small>
      <strong>{link.name}</strong>
    </button>;
  }

  return <button
    type="button"
    className="resource-link"
    onClick={(event) => { event.stopPropagation(); onOpen(link); }}
    title={`Open ${link.kind}/${link.name}`}
  >
    {label}
  </button>;
}
