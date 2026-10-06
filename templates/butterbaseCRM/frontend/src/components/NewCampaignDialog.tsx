import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { bb } from '@/lib/butterbase';
import { useCampaignLists, useCreateCampaign, useStartCampaign } from '@/hooks/useCampaigns';

interface Props {
  defaultListId?: string;
}

export function NewCampaignDialog({ defaultListId }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [listId, setListId] = useState(defaultListId ?? '');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('Hi {{first_name}},\n\n');
  const [dailyLimit, setDailyLimit] = useState(25);
  const [throttleSec, setThrottleSec] = useState(180);
  const [userId, setUserId] = useState<string | null>(null);
  const [startNow, setStartNow] = useState(true);

  const { data: lists } = useCampaignLists();
  const create = useCreateCampaign();
  const start = useStartCampaign();
  const navigate = useNavigate();

  useEffect(() => {
    bb.auth.getUser().then(({ data }: any) => setUserId(data?.id ?? null));
  }, []);

  useEffect(() => {
    if (defaultListId) setListId(defaultListId);
  }, [defaultListId]);

  const peopleLists = (lists ?? []).filter((l) => l.entity_type === 'people');

  async function submit() {
    if (!userId) { toast.error('No user'); return; }
    if (!name.trim() || !listId || !subject.trim() || !body.trim()) return;
    try {
      const campaign = await create.mutateAsync({
        name: name.trim(),
        list_id: listId,
        subject: subject.trim(),
        body_template: body,
        from_user_id: userId,
        daily_limit: dailyLimit,
        throttle_seconds: throttleSec,
      });
      if (startNow) {
        await start.mutateAsync(campaign.id);
        toast.success(`Campaign “${campaign.name}” started`);
      } else {
        toast.success(`Draft “${campaign.name}” saved`);
      }
      setOpen(false);
      setName(''); setSubject(''); setBody('Hi {{first_name}},\n\n');
      navigate(`/campaigns?campaign=${campaign.id}`);
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to create campaign');
    }
  }

  const busy = create.isPending || start.isPending;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="h-9 gap-1.5 bg-foreground text-background hover:bg-foreground/85">
          <Plus className="h-3.5 w-3.5" />
          New campaign
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="font-display tracking-tight">New email campaign</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="eyebrow !text-[10px]">Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Q3 fintech intro" className="mt-1" />
          </div>
          <div>
            <Label className="eyebrow !text-[10px]">Audience list</Label>
            <Select value={listId} onValueChange={setListId}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="Pick a people list" />
              </SelectTrigger>
              <SelectContent>
                {peopleLists.length === 0 ? (
                  <div className="px-3 py-2 text-[12px] text-muted-foreground">No people lists yet — run AI search and click “Save as list”.</div>
                ) : peopleLists.map((l) => (
                  <SelectItem key={l.id} value={l.id}>{l.name} · {l.member_count}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="eyebrow !text-[10px]">Subject</Label>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Quick question for {{first_name}}" className="mt-1" />
          </div>
          <div>
            <Label className="eyebrow !text-[10px]">Body</Label>
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} className="mt-1 min-h-[160px] font-mono text-[12.5px]" />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Variables: <code>{'{{first_name}}'}</code>, <code>{'{{last_name}}'}</code>, <code>{'{{full_name}}'}</code>, <code>{'{{title}}'}</code>, <code>{'{{company}}'}</code>, <code>{'{{email}}'}</code>
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="eyebrow !text-[10px]">Daily limit (max 30)</Label>
              <Input
                type="number"
                min={1}
                max={30}
                value={dailyLimit}
                onChange={(e) => setDailyLimit(Math.max(1, Math.min(30, Number(e.target.value) || 25)))}
                className="mt-1"
              />
            </div>
            <div>
              <Label className="eyebrow !text-[10px]">Throttle (sec between sends)</Label>
              <Input
                type="number"
                min={60}
                max={3600}
                value={throttleSec}
                onChange={(e) => setThrottleSec(Math.max(60, Math.min(3600, Number(e.target.value) || 180)))}
                className="mt-1"
              />
            </div>
          </div>
          <label className="flex items-center gap-2 pt-1 text-[12.5px] text-muted-foreground">
            <input type="checkbox" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} />
            Start sending immediately (otherwise saves as draft)
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button onClick={submit} disabled={busy || !name.trim() || !listId || !subject.trim() || !body.trim()} className="bg-foreground text-background hover:bg-foreground/85 gap-2">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {startNow ? 'Create & start' : 'Save draft'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
