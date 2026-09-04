import { cn } from '@/console/lib/utils';

export function Separator({ className, orientation = 'horizontal' }: { className?: string; orientation?: 'horizontal' | 'vertical' }) {
  return (
    <div
      className={cn(
        orientation === 'horizontal' ? 'h-px w-full' : 'w-px h-full',
        'bg-rule',
        className,
      )}
    />
  );
}
