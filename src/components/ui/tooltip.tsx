import { Content, Portal, Provider, Root, Trigger } from "@radix-ui/react-tooltip";
import type { JSX, ReactNode } from "react";
import { cn } from "@/lib/utils";

const DEFAULT_SIDE_OFFSET = 6;
const DEFAULT_COLLISION_PADDING = 12;

const TooltipProvider = Provider;
const Tooltip = Root;
const TooltipTrigger = Trigger;

function TooltipContent({
  children,
  className,
  collisionPadding = DEFAULT_COLLISION_PADDING,
  sideOffset = DEFAULT_SIDE_OFFSET,
}: Readonly<{
  children: ReactNode;
  className?: string;
  collisionPadding?: number;
  sideOffset?: number;
}>): JSX.Element {
  return (
    <Portal>
      <Content
        className={cn(
          "z-50 max-w-[min(20rem,calc(100vw-1.5rem))] break-words rounded-md border border-border bg-popover px-3 py-2 text-xs leading-relaxed text-popover-foreground shadow-md",
          className,
        )}
        collisionPadding={collisionPadding}
        sideOffset={sideOffset}
      >
        {children}
      </Content>
    </Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
