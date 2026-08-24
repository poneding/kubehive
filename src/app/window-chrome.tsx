import { Button, ScrollArea } from "@/components/ui";
import { cn } from "@/lib/utils";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Box, Code2, Menu, Minus, Square, X } from "lucide-react";
import { useEffect } from "react";
import { openContextMenu } from "../context-menu";
import { tr } from "../i18n";
import { resourceLabel, type AppLanguage } from "../preferences";
import { useHorizontalTabRail } from "../tab-scroll";
import { isPreviewTab, platform } from "./app-state";
import { iconMap } from "./resource-icons";
import type { ResourceTab } from "./types";

const TITLEBAR_GESTURE_HEIGHT = 42;

/**
 * Clicks inside these surfaces never dismiss the resource details sheet. Resource
 * instances swap the sheet's content, and overlays close it through their own handlers.
 */
const DETAIL_SHEET_PERSIST_SELECTOR = [
  ".sheet-right",
  ".resource-table tbody tr",
  ".compact-list",
  ".modal-backdrop",
  ".panel-dialog-backdrop",
  ".context-menu",
  ".app-context-menu",
  ".combobox-popover",
  "[role='dialog']",
  "[role='menu']",
].join(", ");

async function toggleWindowMaximize() {
  try { await getCurrentWindow().toggleMaximize(); } catch { /* Browser prototype. */ }
}

function isWindowChromeInteractiveTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return true;
  return Boolean(target.closest([
    "button",
    "a",
    "input",
    "textarea",
    "select",
    "label",
    "[role='button']",
    "[role='menuitem']",
    "[role='option']",
    "[contenteditable='true']",
    ".combobox",
    ".window-controls",
    ".cluster-icon",
    ".brand-mark",
    ".rail-button",
    ".modal-backdrop",
    ".panel-dialog-backdrop",
    ".context-menu",
    ".combobox-popover",
    "[role='dialog']",
    "[role='menu']",
  ].join(", ")));
}

/** Whole top strip: blank area drag + double-click maximize/restore (VS Code / native titlebar feel). */
function useTitlebarWindowGestures() {
  useEffect(() => {
    let dragListeners: (() => void) | null = null;

    const clearDragListeners = () => {
      dragListeners?.();
      dragListeners = null;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (event.clientY > TITLEBAR_GESTURE_HEIGHT) return;
      if (isWindowChromeInteractiveTarget(event.target)) return;

      const startX = event.clientX;
      const startY = event.clientY;
      let started = false;

      const onMove = (move: PointerEvent) => {
        if (started) return;
        if (Math.hypot(move.clientX - startX, move.clientY - startY) < 4) return;
        started = true;
        clearDragListeners();
        void getCurrentWindow().startDragging().catch(() => { /* Browser prototype. */ });
      };

      const onUp = () => clearDragListeners();
      clearDragListeners();
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp, { once: true });
      window.addEventListener("pointercancel", onUp, { once: true });
      dragListeners = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
    };

    const onDblClick = (event: MouseEvent) => {
      if (event.clientY > TITLEBAR_GESTURE_HEIGHT) return;
      if (isWindowChromeInteractiveTarget(event.target)) return;
      event.preventDefault();
      void toggleWindowMaximize();
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("dblclick", onDblClick);
    return () => {
      clearDragListeners();
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("dblclick", onDblClick);
    };
  }, []);
}

function WindowControls({ language }: { language: AppLanguage }) {
  if (platform === "macos") return null;
  const run = (action: "minimize" | "maximize" | "close") => async () => {
    try {
      const window = getCurrentWindow();
      if (action === "minimize") await window.minimize();
      if (action === "maximize") await window.toggleMaximize();
      if (action === "close") await window.close();
    } catch { /* Browser prototype: controls are visual only. */ }
  };
  return <div className="window-controls" aria-label={tr(language, "windowControls")}><button aria-label={tr(language, "minimize")} onClick={run("minimize")}><Minus size={13} /></button><button aria-label={tr(language, "maximize")} onClick={run("maximize")}><Square size={11} /></button><button className="close" aria-label={tr(language, "closeWindow")} onClick={run("close")}><X size={13} /></button></div>;
}

function WorkspaceTabs({ tabs, activeId, language, onActivate, onClose, onCloseOthers, onCloseAll, onKeepOpen, onMenu }: {
  tabs: ResourceTab[];
  activeId: string;
  language: AppLanguage;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onCloseAll: () => void;
  onKeepOpen: (id: string) => void;
  onMenu: () => void;
}) {
  const tabListRef = useHorizontalTabRail(activeId);
  return <div className="workspace-tabs titlebar-chrome">
    <Button variant="ghost" size="icon" className="mobile-only tabs-menu-button" onClick={onMenu}><Menu size={15} /></Button>
    <ScrollArea className="workspace-tab-scroll-area" viewportClassName="workspace-tab-list" viewportRef={tabListRef} scrollbars="horizontal" hideScrollbars type="hover">
      <div className="workspace-tab-list-content">{tabs.map((tab) => {
        const Icon = tab.crdKind ? Code2 : (iconMap[tab.resource] ?? Box);
        const preview = isPreviewTab(tab);
        return <button
          key={tab.id}
          type="button"
          className={cn(activeId === tab.id && "active", preview && "preview")}
          title={preview ? tr(language, "previewTab") : tab.label}
          onClick={() => onActivate(tab.id)}
          onDoubleClick={(event) => {
            event.stopPropagation();
            if (preview) onKeepOpen(tab.id);
          }}
          onContextMenu={(event) => openContextMenu(event, [
            { type: "item", id: "keep-open", label: tr(language, "keepOpen"), disabled: !preview, onSelect: () => onKeepOpen(tab.id) },
            { type: "separator" },
            { type: "item", id: "close", label: tr(language, "close"), disabled: tab.id === "overview", onSelect: () => onClose(tab.id) },
            { type: "item", id: "close-others", label: tr(language, "closeOthers"), disabled: tabs.length <= 1, onSelect: () => onCloseOthers(tab.id) },
            { type: "item", id: "close-all", label: tr(language, "closeAll"), disabled: tabs.every((item) => item.id === "overview"), onSelect: onCloseAll },
          ])}
        ><Icon className="tab-icon" size={13} /><strong>{tab.crdKind ? tab.label : resourceLabel(language, tab.label)}</strong>{tab.id !== "overview" && <i role="button" aria-label={`${tr(language, "close")} ${tab.label}`} onClick={(event) => { event.stopPropagation(); onClose(tab.id); }}><X size={11} /></i>}</button>;
      })}</div></ScrollArea>
    <WindowControls language={language} />
  </div>;
}

export { DETAIL_SHEET_PERSIST_SELECTOR, WindowControls, WorkspaceTabs, useTitlebarWindowGestures };
