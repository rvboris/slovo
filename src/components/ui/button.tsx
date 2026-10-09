import type { ComponentPropsWithRef, JSX } from "react";
import { Slot } from "@radix-ui/react-slot";
import type { VariantProps } from 'class-variance-authority';
import { cn } from "@/lib/utils";
import { cva } from 'class-variance-authority';

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "h-9 px-4 py-2",
        icon: "h-9 w-9",
        lg: "h-10 rounded-md px-8",
        sm: "h-8 rounded-md px-3 text-xs",
      },
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        ghost:
          "hover:bg-accent hover:text-accent-foreground",
        outline:
          "border border-input bg-transparent shadow-sm hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
      },
    },
  },
);

interface ButtonProps
  extends Readonly<ComponentPropsWithRef<"button">>,
    VariantProps<typeof buttonVariants> {
  readonly asChild?: boolean;
}

function Button({ ref, className, variant, size, asChild = false, ...props }: Readonly<ButtonProps>): JSX.Element {
    let Comp: typeof Slot | "button" = "button";
    if (asChild) { Comp = Slot; }
    return (
      <Comp
        className={cn(buttonVariants({ className, size, variant }))}
        ref={ref}
        {...props}
      />
    );
  }
Button.displayName = "Button";

export { Button };
export type { ButtonProps };
