import * as React from 'react';
import { cn } from '@/console/lib/utils';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'outline' | 'ghost' | 'destructive' | 'secondary' | 'crust' | 'link';
  size?: 'sm' | 'md' | 'lg' | 'icon';
}

const variants: Record<string, string> = {
  default:
    'bg-primary text-primary-foreground hover:bg-primary/90',
  destructive:
    'bg-destructive text-destructive-foreground hover:bg-destructive/90',
  outline:
    'border border-input bg-background hover:bg-accent/10 hover:text-foreground hover:border-foreground/30',
  secondary:
    'bg-secondary text-secondary-foreground hover:bg-secondary/80',
  ghost:
    'hover:bg-foreground/[0.04] hover:text-foreground text-muted-foreground',
  link:
    'text-primary underline-offset-4 hover:underline',
  // Warm accent button for escalations
  crust:
    'bg-butter text-foreground hover:bg-butter/90',
};

const sizes: Record<string, string> = {
  sm: 'h-9 px-3 text-sm rounded-md',
  md: 'h-10 px-4 py-2 text-sm rounded-md',
  lg: 'h-11 px-8 text-sm rounded-md',
  icon: 'h-10 w-10 rounded-md',
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'md', ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
        '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = 'Button';
