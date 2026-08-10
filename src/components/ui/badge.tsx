import { cva, type VariantProps } from "class-variance-authority";
import { type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva("ui-badge", {
  variants: {
    tone: {
      neutral: "tone-neutral",
      green: "tone-green",
      amber: "tone-amber",
      red: "tone-red",
      blue: "tone-blue",
    },
  },
  defaultVariants: {
    tone: "neutral",
  },
});

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export { Badge, badgeVariants };
