import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';

interface Props { label: string; action: { type: 'navigate' | 'open_proposal' | 'link_account'; params: any } }

export function SuggestNextStepCard({ label, action }: Props) {
  const navigate = useNavigate();
  function click() {
    if (action.type === 'navigate' && typeof action.params?.path === 'string') navigate(action.params.path);
  }
  return (
    <Button variant="outline" size="sm" className="h-7 text-[12px]" onClick={click}>
      {label}
    </Button>
  );
}
