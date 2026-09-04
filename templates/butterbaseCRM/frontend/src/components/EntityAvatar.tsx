import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { useDownloadUrl } from '@/lib/storage';

interface Props {
  objectId?: string | null;
  fallback: string;
  className?: string;
}

function initials(text: string): string {
  return (
    text
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase() || '?'
  );
}

export function EntityAvatar({ objectId, fallback, className }: Props) {
  const { data: url, isLoading } = useDownloadUrl(objectId);
  if (objectId && isLoading) {
    return <Skeleton className={className ?? 'h-8 w-8 rounded-full'} />;
  }
  return (
    <Avatar className={className ?? 'h-8 w-8'}>
      {url ? <AvatarImage src={url} alt={fallback} /> : null}
      <AvatarFallback>{initials(fallback)}</AvatarFallback>
    </Avatar>
  );
}
