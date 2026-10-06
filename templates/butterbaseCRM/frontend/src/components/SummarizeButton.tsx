import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { bb } from '@/lib/butterbase';
import { qk } from '@/lib/queryKeys';

interface Props {
  companyId: string;
}

export function SummarizeButton({ companyId }: Props) {
  const [loading, setLoading] = useState(false);
  const qc = useQueryClient();

  async function handleClick() {
    setLoading(true);
    try {
      const response = await bb.functions.invoke('summarize-company', {
        body: { company_id: companyId },
      });
      if (response.error) {
        const status = (response.error as any).status;
        if (status === 402) {
          toast.error('Insufficient credits. Please upgrade your plan.');
        } else {
          toast.error((response.error as any).message || 'Failed to regenerate summary');
        }
      } else {
        qc.invalidateQueries({ queryKey: qk.company(companyId) });
        toast.success('Summary regenerated');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to regenerate summary');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button onClick={handleClick} disabled={loading} size="sm" variant="outline">
      {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
      Regenerate AI summary
    </Button>
  );
}
