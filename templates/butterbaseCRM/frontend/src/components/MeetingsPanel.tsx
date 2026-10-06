import { useState } from 'react';
import { formatDistanceToNowStrict } from 'date-fns';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { MoreVertical, Plus } from 'lucide-react';
import { useMeetingsByEntity, useCreateMeeting, useDeleteMeeting } from '@/hooks/useMeetings';

interface Props {
  companyId: string;
}

export function MeetingsPanel({ companyId }: Props) {
  const { data: meetings } = useMeetingsByEntity({ companyId });
  const createMut = useCreateMeeting();
  const deleteMut = useDeleteMeeting();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [location, setLocation] = useState('');
  const [notes, setNotes] = useState('');

  async function handleSubmit() {
    if (!title.trim() || !startsAt) {
      toast.error('Title and start time are required');
      return;
    }
    try {
      await createMut.mutateAsync({
        title: title.trim(),
        starts_at: startsAt,
        ends_at: endsAt || null,
        location: location.trim() || null,
        notes: notes.trim() || null,
        company_id: companyId,
      });
      toast.success('Meeting created');
      setTitle('');
      setStartsAt('');
      setEndsAt('');
      setLocation('');
      setNotes('');
      setDialogOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create meeting');
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteMut.mutateAsync(id);
      toast.success('Meeting deleted');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete meeting');
    }
  }

  return (
    <div className="space-y-4">
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogTrigger asChild>
          <Button><Plus className="mr-2 h-4 w-4" />New meeting</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader><DialogTitle>New meeting</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Title</label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="Meeting title" />
            </div>
            <div>
              <label className="text-sm font-medium">Start time</label>
              <Input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
            </div>
            <div>
              <label className="text-sm font-medium">End time (optional)</label>
              <Input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
            </div>
            <div>
              <label className="text-sm font-medium">Location (optional)</label>
              <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="In-person or video link" />
            </div>
            <div>
              <label className="text-sm font-medium">Notes (optional)</label>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={createMut.isPending}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {!meetings || meetings.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm text-muted-foreground">No meetings yet</p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Start time</TableHead>
              <TableHead>Location</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {meetings.map((m) => (
              <TableRow key={m.id}>
                <TableCell>{m.title}</TableCell>
                <TableCell className="text-sm">
                  {formatDistanceToNowStrict(new Date(m.starts_at), { addSuffix: true })}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{m.location || '—'}</TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button className="text-muted-foreground hover:text-foreground">
                        <MoreVertical className="h-4 w-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => handleDelete(m.id)}
                        disabled={deleteMut.isPending}
                        className="text-destructive"
                      >
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
