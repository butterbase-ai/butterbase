import { useState } from 'react';
import { formatDistanceToNowStrict } from 'date-fns';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Trash2 } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useNotes, useCreateNote, useDeleteNote } from '@/hooks/useNotes';
import { bb } from '@/lib/butterbase';
import type { EntityType } from '@/lib/types';

interface Props {
  entityType: EntityType;
  entityId: string;
}

export function NotesPanel({ entityType, entityId }: Props) {
  const { data: notes } = useNotes(entityType, entityId);
  const createMut = useCreateNote();
  const deleteMut = useDeleteNote();
  const [body, setBody] = useState('');
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  const handleLoadUser = async () => {
    const { data: user } = await bb.auth.getUser();
    if (user) setCurrentUserId(user.id);
  };

  if (currentUserId === null) {
    handleLoadUser();
  }

  async function handleAddNote() {
    if (!body.trim()) return;
    try {
      await createMut.mutateAsync({ entity_type: entityType, entity_id: entityId, body: body.trim() });
      setBody('');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to add note');
    }
  }

  async function handleDeleteNote(noteId: string) {
    try {
      await deleteMut.mutateAsync({ id: noteId, entity_type: entityType, entity_id: entityId });
      toast.success('Note deleted');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete note');
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        <Textarea
          placeholder="Add a note..."
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="min-h-20"
        />
        <Button onClick={handleAddNote} disabled={!body.trim() || createMut.isPending} className="h-20">
          Add note
        </Button>
      </div>

      {!notes || notes.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm text-muted-foreground">No notes yet</p>
        </div>
      ) : (
        <ScrollArea className="h-96">
          <div className="space-y-3 pr-4">
            {notes.map((note) => (
              <div key={note.id} className="rounded-lg border p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1">
                    <p className="text-xs text-muted-foreground">
                      {note.created_by.slice(0, 8)} • {formatDistanceToNowStrict(new Date(note.created_at), { addSuffix: true })}
                    </p>
                    <p className="mt-1 text-sm">{note.body}</p>
                  </div>
                  <button
                    onClick={() => handleDeleteNote(note.id)}
                    disabled={deleteMut.isPending}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
