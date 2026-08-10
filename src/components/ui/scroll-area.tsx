import { cn } from "@/lib/utils";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type Ref } from "react";

type ScrollAreaAxes = "vertical" | "horizontal" | "both";

export interface ScrollAreaProps extends ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> {
  /** Keep the viewport scrollable while omitting visual Radix tracks/thumbs. */
  hideScrollbars?: boolean;
  scrollbars?: ScrollAreaAxes;
  /** Horizontal offset for the vertical track. Positive values inset it; negative values use an ancestor gutter. */
  verticalScrollbarOffset?: number;
  viewportClassName?: string;
  viewportProps?: Omit<ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Viewport>, "children" | "className">;
  viewportRef?: Ref<ElementRef<typeof ScrollAreaPrimitive.Viewport>>;
}

const ScrollArea = forwardRef<
  ElementRef<typeof ScrollAreaPrimitive.Root>,
  ScrollAreaProps
>(({ className, children, hideScrollbars = false, scrollbars = "vertical", type = "scroll", scrollHideDelay = 1_500, verticalScrollbarOffset = 0, viewportClassName, viewportProps, viewportRef, ...props }, ref) => (
  <ScrollAreaPrimitive.Root
    ref={ref}
    data-slot="scroll-area"
    type={type}
    scrollHideDelay={scrollHideDelay}
    className={cn("relative flex flex-col overflow-hidden", className)}
    {...props}
  >
    <ScrollAreaPrimitive.Viewport
      {...viewportProps}
      ref={viewportRef}
      data-slot="scroll-area-viewport"
      className={cn("min-h-0 min-w-0 w-full flex-auto rounded-[inherit] outline-none focus-visible:ring-1 focus-visible:ring-ring", viewportClassName)}
    >
      {children}
    </ScrollAreaPrimitive.Viewport>
    {!hideScrollbars && (scrollbars === "vertical" || scrollbars === "both") && <ScrollBar orientation="vertical" style={verticalScrollbarOffset ? { right: verticalScrollbarOffset } : undefined} />}
    {!hideScrollbars && (scrollbars === "horizontal" || scrollbars === "both") && <ScrollBar orientation="horizontal" />}
    <ScrollAreaPrimitive.Corner data-slot="scroll-area-corner" className="bg-transparent" />
  </ScrollAreaPrimitive.Root>
));
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

const ScrollBar = forwardRef<
  ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = "vertical", ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    data-slot="scroll-area-scrollbar"
    orientation={orientation}
    className={cn(
      "scroll-area-scrollbar z-30 flex touch-none select-none p-0.5 transition-colors",
      orientation === "vertical" && "h-full w-2.5 border-l border-l-transparent",
      orientation === "horizontal" && "h-2.5 flex-col border-t border-t-transparent",
      className,
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb
      data-slot="scroll-area-thumb"
      className={cn(
        "relative flex-1 rounded-full bg-muted-foreground/80 transition-colors hover:bg-muted-foreground",
        orientation === "vertical" ? "min-h-7 w-full" : "h-full min-w-7",
      )}
    />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
));
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;

export { ScrollArea, ScrollBar };
