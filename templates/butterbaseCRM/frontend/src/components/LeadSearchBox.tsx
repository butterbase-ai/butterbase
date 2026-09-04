import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface Props {
  onSubmit: () => void;
  loading?: boolean;
  queryText: string;
  onQueryTextChange: (text: string) => void;
}

export function LeadSearchBox({ onSubmit, loading, queryText, onQueryTextChange }: Props) {
  return (
    <div className="flex gap-2">
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={queryText}
          onChange={(e) => onQueryTextChange(e.target.value)}
          placeholder="Describe who you're looking for…  e.g. VPs of engineering at NYC fintechs"
          className="pl-9"
          onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(); }}
        />
      </div>
      <Button onClick={onSubmit} disabled={loading}>
        {loading ? 'Searching…' : 'Search'}
      </Button>
    </div>
  );
}
