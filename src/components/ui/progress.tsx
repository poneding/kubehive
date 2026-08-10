import * as ProgressPrimitive from "@radix-ui/react-progress";
import { forwardRef } from "react";
import { cn } from "@/lib/utils";

type ProgressTone = "green" | "amber" | "red";

export interface ProgressProps extends React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> {
  tone?: ProgressTone;
}

const Progress = forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  ProgressProps
>(({ className, value = 0, tone = "green", ...props }, ref) => {
  const normalizedValue = Math.min(100, Math.max(0, value ?? 0));

  return (
    <ProgressPrimitive.Root
      ref={ref}
      className={cn("ui-progress-track h-1.5 w-full overflow-hidden rounded-full bg-white/7", className)}
      value={normalizedValue}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className={cn(
          "h-full rounded-full transition-all",
          tone === "green" && "bg-success",
          tone === "amber" && "bg-warning",
          tone === "red" && "bg-destructive",
        )}
        style={{ width: `${normalizedValue}%` }}
      />
    </ProgressPrimitive.Root>
  );
});
Progress.displayName = ProgressPrimitive.Root.displayName;

export { Progress };
