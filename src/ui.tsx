import { clsx, type ClassValue } from "clsx";
import { type ButtonHTMLAttributes, type ReactNode } from "react";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function Button({ className, variant = "default", size = "default", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "secondary" | "ghost" | "outline"; size?: "default" | "icon" | "sm" }) {
  return <button className={cn("ui-button", `ui-button-${variant}`, "inline-flex items-center justify-center gap-1.5 rounded text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50", variant === "default" && "bg-emerald-400 text-emerald-950 hover:bg-emerald-300", variant === "secondary" && "bg-zinc-800 text-zinc-200 hover:bg-zinc-700", variant === "ghost" && "text-zinc-400 hover:bg-white/5 hover:text-zinc-100", variant === "outline" && "border border-white/10 bg-transparent text-zinc-300 hover:bg-white/5", size === "default" && "h-8 px-2.5", size === "sm" && "h-7 px-2 text-[11px]", size === "icon" && "h-7 w-7", className)} {...props} />;
}

export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "green" | "amber" | "red" | "blue"; className?: string }) {
  return <span className={cn("ui-badge", `tone-${tone}`, className)}>{children}</span>;
}

export function Progress({ value, tone = "green" }: { value: number; tone?: "green" | "amber" | "red" }) {
  return <div className="ui-progress-track h-1.5 w-full overflow-hidden rounded-full bg-white/7"><div className={cn("h-full rounded-full", tone === "green" && "bg-emerald-400", tone === "amber" && "bg-amber-400", tone === "red" && "bg-red-400")} style={{ width: `${Math.min(100, value)}%` }} /></div>;
}
