import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "./ui";
import type { ContainerInfo, ResourceLink } from "./resource-catalog";
import { t, type AppLanguage } from "./preferences";
import { Combobox } from "./combobox";

export const PAGE_SIZE_OPTIONS = [10, 15, 20, 30, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

export function useTablePagination<T>(items: T[], storageKey: string, resetKey = "") {
  const [pageSize, setPageSize] = useState<PageSize>(() => {
    const saved = Number(localStorage.getItem(`kubehive.pageSize.${storageKey}`) || 10);
    return (PAGE_SIZE_OPTIONS as readonly number[]).includes(saved) ? saved as PageSize : 10;
  });
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [pageSize, storageKey, resetKey, items.length]);

  useEffect(() => {
    localStorage.setItem(`kubehive.pageSize.${storageKey}`, String(pageSize));
  }, [pageSize, storageKey]);

  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  const pageItems = useMemo(() => items.slice(start, start + pageSize), [items, start, pageSize]);
  const showPager = total > 10;

  return {
    page: safePage,
    pageSize,
    total,
    totalPages,
    pageItems,
    showPager,
    setPage,
    setPageSize: (size: PageSize) => { setPageSize(size); setPage(1); },
    rangeLabel: total === 0 ? "0–0" : `${start + 1}–${Math.min(start + pageSize, total)}`,
  };
}

export function TablePagination({
  language,
  page,
  pageSize,
  total,
  totalPages,
  rangeLabel,
  onPageChange,
  onPageSizeChange,
}: {
  language: AppLanguage;
  page: number;
  pageSize: PageSize;
  total: number;
  totalPages: number;
  rangeLabel: string;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: PageSize) => void;
}) {
  return <div className="table-pagination">
    <div className="table-pagination-size">
      <span>{t(language, "rowsPerPage")}</span>
      <Combobox
        className="table-page-size-combobox"
        value={String(pageSize)}
        ariaLabel={t(language, "rowsPerPage")}
        searchable={false}
        options={PAGE_SIZE_OPTIONS.map((size) => ({ value: String(size), label: String(size) }))}
        onChange={(value) => onPageSizeChange(Number(value) as PageSize)}
      />
    </div>
    <div className="table-pagination-meta">
      <span>{rangeLabel} / {total}</span>
    </div>
    <div className="table-pagination-controls">
      <button type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1)} aria-label="Previous page"><ChevronLeft size={14} /></button>
      <strong>{page} / {totalPages}</strong>
      <button type="button" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)} aria-label="Next page"><ChevronRight size={14} /></button>
    </div>
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
