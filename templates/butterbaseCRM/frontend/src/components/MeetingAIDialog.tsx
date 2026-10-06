import { useQuery } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Sparkles, FileText, MapPin, Users, Clock } from 'lucide-react';
import { getEntity, listEntities } from '@/lib/substrate';
import { format } from 'date-fns';
import type { Meeting } from '@/lib/types';
import { MeetingNotetakerPanel } from '@/components/MeetingNotetakerPanel';

interface AttendeeDisplay {
  person_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  display: string;
  response: string | null;
}

function stripHtml(s: string): string {
  const noTags = s.replace(/<[^>]+>/g, ' ');
  return noTags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

const RESPONSE_DOT: Record<string, string> = {
  accepted: 'bg-sage',
  declined: 'bg-coral',
  tentative: 'bg-butter',
  pending: 'bg-muted-foreground/40',
};

interface Props {
  meeting: Meeting | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MeetingAIDialog({ meeting, open, onOpenChange }: Props) {
  const meetingId = meeting?.id;
  const { data: attendeeDisplays = [] } = useQuery({
    queryKey: ['meeting_substrate_attendees', meetingId],
    enabled: !!meetingId && open,
    queryFn: async (): Promise<AttendeeDisplay[]> => {
      const ev = await getEntity(meetingId!);
      const attendees: Array<{ entity_id: string; email: string; response: string }> =
        ev?.attrs?.attendees ?? [];
      if (attendees.length === 0) return [];
      const persons = await listEntities('person', { limit: 200 });
      const personById = new Map(persons.map((p) => [p.id, p]));
      return attendees.map((a) => {
        const p = personById.get(a.entity_id);
        const first_name = p?.attrs?.first_name ?? null;
        const last_name = p?.attrs?.last_name ?? null;
        const fullName = [first_name, last_name].filter(Boolean).join(' ').trim();
        const display =
          p?.display_name ?? (fullName.length > 0 ? fullName : null) ?? a.email ?? 'Unknown';
        return {
          person_id: a.entity_id,
          first_name,
          last_name,
          email: a.email ?? p?.attrs?.email ?? p?.primary_email ?? null,
          display,
          response: a.response ?? null,
        };
      });
    },
  });

  if (!meeting) return null;

  const cleanNotes = meeting.notes ? stripHtml(meeting.notes) : '';
  const endLabel = meeting.ends_at ? format(new Date(meeting.ends_at), 'h:mm a') : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-start gap-2 font-display tracking-tight">
            <Sparkles className="h-4 w-4 text-butter mt-1" />
            <div className="min-w-0 flex-1">
              <div className="text-[18px] leading-tight">{meeting.title}</div>
              <div className="font-mono text-[11px] text-muted-foreground mt-1 flex items-center gap-1.5">
                <Clock className="h-3 w-3" />
                {format(new Date(meeting.starts_at), 'EEE, MMM d · h:mm a')}
                {endLabel && <span className="text-muted-foreground/70">→ {endLabel}</span>}
              </div>
            </div>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          {(meeting.location || cleanNotes || attendeeDisplays.length > 0) && (
            <section className="card-flat p-4 space-y-3">
              {meeting.location && (
                <div className="flex items-start gap-2">
                  <MapPin className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                  {isUrl(meeting.location) ? (
                    <a
                      href={meeting.location}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[13px] text-butter hover:underline break-all"
                    >
                      {meeting.location}
                    </a>
                  ) : (
                    <p className="text-[13px] text-foreground break-words">{meeting.location}</p>
                  )}
                </div>
              )}
              {attendeeDisplays.length > 0 && (
                <div className="flex items-start gap-2">
                  <Users className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                  <ul className="flex flex-wrap gap-x-3 gap-y-1.5 text-[13px]">
                    {attendeeDisplays.map((a) => {
                      const dot = RESPONSE_DOT[a.response ?? 'pending'] ?? RESPONSE_DOT.pending;
                      return (
                        <li key={a.person_id} className="flex items-center gap-1.5">
                          <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
                          <span className="text-foreground">{a.display}</span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
              {cleanNotes && (
                <div className="flex items-start gap-2">
                  <FileText className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                  <p className="text-[13px] text-foreground/85 leading-relaxed whitespace-pre-wrap">
                    {cleanNotes}
                  </p>
                </div>
              )}
            </section>
          )}

          <section>
            <MeetingNotetakerPanel meetingId={meeting.id} />
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
