import type { HTMLAttributes, JSX } from "react";
import type { VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { cva } from "class-variance-authority";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1",
  {
    defaultVariants: {
      variant: "default",
    },
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        destructive: "border-transparent bg-destructive text-destructive-foreground",
        outline: "text-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
      },
    },
  },
);

interface BadgeProps extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps): JSX.Element | null {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge };
export type { BadgeProps };
