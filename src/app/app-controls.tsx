import { ScrollArea, Switch } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import { statusDotClass } from "../status";

function ToggleSwitch({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return <Switch aria-label={label} checked={checked} className={cn("settings-toggle", checked && "active")} onCheckedChange={onChange} />;
}

function StatusDot({ status }: { status: string }) {
  return <span className={cn("status-dot", statusDotClass(status))} />;
}

export function WorkspaceScroll({ children }: { children: ReactNode }) {
  return <ScrollArea className="workspace-scroll-area" viewportClassName="workspace-scroll" scrollbars="both">{children}</ScrollArea>;
}

export { StatusDot, ToggleSwitch };
