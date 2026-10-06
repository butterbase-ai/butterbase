import { ReactNode } from 'react';
import { cn } from '@/console/lib/utils';

export function SettingsPage({
  label,
  title,
  description,
  children,
  className,
  action,
}: {
  label: string;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="page-header">
        <div>
          <p className="eyebrow mb-3">{label}</p>
          <h1 className="page-title">{title}</h1>
          {description && (
            <p className="mt-3 font-editorial italic text-[15px] text-muted-foreground max-w-md">
              {description}
            </p>
          )}
        </div>
        {action}
      </div>
      <div className={cn('px-8 py-7 max-w-4xl space-y-5', className)}>{children}</div>
    </div>
  );
}
