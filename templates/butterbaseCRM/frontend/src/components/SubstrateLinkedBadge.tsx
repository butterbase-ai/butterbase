import { uiText, useUiLocale } from "../i18n";
import { Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface Props {
  substrateEntityId: string | null | undefined;
}

export function SubstrateLinkedBadge({ substrateEntityId }: Props) {
  useUiLocale();
  if (!substrateEntityId) return null;
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="secondary" className="gap-1">
            <Sparkles className="h-3 w-3" />
            {uiText("Linked to substrate")}</Badge>
        </TooltipTrigger>
        <TooltipContent>
          <p className="font-mono text-xs">{substrateEntityId}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
