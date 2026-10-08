import type { ComponentPropsWithRef, JSX } from "react";
import { Root as LabelPrimitiveRoot } from "@radix-ui/react-label";
import { cn } from "@/lib/utils";

const LabelPrimitive = { Root: LabelPrimitiveRoot };


function Label({ ref, className, ...props }: Readonly<ComponentPropsWithRef<typeof LabelPrimitive.Root>>): JSX.Element {
  return (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(
      "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
      className,
    )}
    {...props}
  />
);
}
Label.displayName = LabelPrimitive.Root.displayName;

export { Label };
