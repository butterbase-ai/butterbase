import * as React from 'react';
import { cn } from '@/console/lib/utils';

const variants: Record<string, string> = {
  default: 'border-transparent bg-primary text-primary-foreground',
  secondary: 'border-transparent bg-secondary text-secondary-foreground',
  destructive: 'border-transparent bg-destructive text-destructive-foreground',
  outline: 'text-foreground border-border',
  // Editorial color tints used across the app
  amber: 'border-butter/30 bg-butter/15 text-foreground',
  red: 'border-coral/30 bg-coral/10 text-coral',
  green: 'border-sage/30 bg-sage/10 text-sage',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: keyof typeof variants;
}

export function Badge({ className, variant = 'default', ...p }: BadgeProps) {
  return (
    <div
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold tracking-wide uppercase',
        variants[variant],
        className,
      )}
      {...p}
    />
  );
}
