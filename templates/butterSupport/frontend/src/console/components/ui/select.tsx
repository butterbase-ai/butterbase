import * as React from 'react';
import { cn } from '@/console/lib/utils';

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...p }, ref) => (
    <select
      ref={ref}
      className={cn(
        'flex h-10 w-full appearance-none rounded-md border border-input bg-background px-3 pr-9 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50',
        "bg-[url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><path fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round' d='M3 5l3 3 3-3'/></svg>\")] bg-no-repeat bg-[length:12px_12px] bg-[right_0.9rem_center]",
        className,
      )}
      {...p}
    >
      {children}
    </select>
  ),
);
Select.displayName = 'Select';
