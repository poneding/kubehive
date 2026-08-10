import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "ui-button inline-flex items-center justify-center gap-1.5 rounded text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "ui-button-default bg-primary text-primary-foreground hover:bg-primary/90",
        secondary: "ui-button-secondary bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "ui-button-ghost text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        outline: "ui-button-outline border border-border bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground",
      },
      size: {
        default: "h-8 px-2.5",
        sm: "h-7 px-2 text-[11px]",
        icon: "h-7 w-7",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";

    return <Comp className={cn(buttonVariants({ variant, size }), className)} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
