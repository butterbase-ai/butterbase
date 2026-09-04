import { useMemo, useState } from 'react';
import {
  addDays,
  addWeeks,
  endOfWeek,
  format,
  isSameDay,
  isToday,
  isWithinInterval,
  startOfWeek,
} from 'date-fns';
import { toast } from 'sonner';
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  List,
  Plus,
  MapPin,
  Sparkles,
  Table as TableIcon,
} from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ObjectToolbar } from '@/components/toolbar/ObjectToolbar';
import { useObjectView } from '@/components/toolbar/useObjectView';
import { useCustomValueLookup } from '@/hooks/useCustomFields';
import { CustomFieldCell } from '@/components/CustomFieldCell';
import { rowMatches, parseCustomFieldRef } from '@/lib/filterDsl';
import { formatDistanceToNowStrict } from 'date-fns';
import { MeetingAIDialog } from '@/components/MeetingAIDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useMeetings, useCreateMeeting } from '@/hooks/useMeetings';
import { useCompanies } from '@/hooks/useCompanies';
import { useDeals } from '@/hooks/useDeals';
import type { Meeting } from '@/lib/types';

const NONE = '__none__';

/* ────────────────────────────────────────────────────────────── */
/* Constants                                                       */
/* ────────────────────────────────────────────────────────────── */

const HOUR_START = 7;   // 07:00
const HOUR_END = 21;    // 21:00
const HOURS = Array.from({ length: HOUR_END - HOUR_START + 1 }, (_, i) => HOUR_START + i);
const ROW_PX = 48;      // height per hour row

type Mode = 'week' | 'agenda' | 'table';

/* ────────────────────────────────────────────────────────────── */
/* New-meeting dialog                                              */
/* ────────────────────────────────────────────────────────────── */

function NewMeetingDialog({ defaultStart }: { defaultStart?: Date }) {
  const createMut = useCreateMeeting();
  const { data: companies = [] } = useCompanies();
  const { data: deals = [] } = useDeals();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [startsAt, setStartsAt] = useState(
    defaultStart ? format(defaultStart, "yyyy-MM-dd'T'HH:mm") : '',
  );
  const [endsAt, setEndsAt] = useState('');
  const [location, setLocation] = useState('');
  const [notes, setNotes] = useState('');
  const [companyId, setCompanyId] = useState<string>(NONE);
  const [dealId, setDealId] = useState<string>(NONE);

  const sortedCompanies = useMemo(
    () => [...companies].sort((a, b) => a.name.localeCompare(b.name)),
    [companies],
  );
  // Narrow the deal picker to the chosen company (when one is selected).
  const filteredDeals = useMemo(() => {
    const list = companyId !== NONE
      ? deals.filter((d) => d.company_id === companyId)
      : deals;
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [deals, companyId]);

  function reset() {
    setTitle('');
    setStartsAt('');
    setEndsAt('');
    setLocation('');
    setNotes('');
    setCompanyId(NONE);
    setDealId(NONE);
  }

  async function submit() {
    if (!title.trim() || !startsAt) {
      toast.error('Title and start time are required');
      return;
    }
    try {
      // If a deal was picked, derive its company so the meeting is double-linked.
      const dealRow = dealId !== NONE ? deals.find((d) => d.id === dealId) : null;
      const finalCompanyId =
        companyId !== NONE ? companyId : dealRow?.company_id ?? null;

      await createMut.mutateAsync({
        title: title.trim(),
        starts_at: new Date(startsAt).toISOString(),
        ends_at: endsAt ? new Date(endsAt).toISOString() : null,
        location: location.trim() || null,
        notes: notes.trim() || null,
        company_id: finalCompanyId,
        deal_id: dealId !== NONE ? dealId : null,
      });
      toast.success('Meeting scheduled');
      reset();
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to schedule');
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2 bg-foreground text-background hover:bg-foreground/85">
          <Plus className="h-3.5 w-3.5" />
          New meeting
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display text-[22px] tracking-tight">
            New meeting
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="eyebrow !text-[10px] block mb-1.5">Title</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
              placeholder="Quarterly review · Acme"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="eyebrow !text-[10px] block mb-1.5">Starts</label>
              <Input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
            </div>
            <div>
              <label className="eyebrow !text-[10px] block mb-1.5">Ends (optional)</label>
              <Input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="min-w-0">
              <label className="eyebrow !text-[10px] block mb-1.5">Linked company</label>
              <Select
                value={companyId}
                onValueChange={(v) => {
                  setCompanyId(v);
                  // Clear the deal selection if it no longer belongs to the chosen company.
                  if (v !== NONE && dealId !== NONE) {
                    const d = deals.find((x) => x.id === dealId);
                    if (d && d.company_id !== v) setDealId(NONE);
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>
                    <span className="font-editorial italic text-muted-foreground">None</span>
                  </SelectItem>
                  {sortedCompanies.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-0">
              <label className="eyebrow !text-[10px] mb-1.5 flex items-center justify-between">
                <span>Linked deal</span>
                {companyId !== NONE && (
                  <span className="font-editorial italic !text-[9.5px] tracking-normal normal-case text-muted-foreground/70 ml-2">
                    filtered
                  </span>
                )}
              </label>
              <Select value={dealId} onValueChange={setDealId} disabled={filteredDeals.length === 0}>
                <SelectTrigger>
                  <SelectValue
                    placeholder={filteredDeals.length === 0 ? 'No deals' : 'None'}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>
                    <span className="font-editorial italic text-muted-foreground">None</span>
                  </SelectItem>
                  {filteredDeals.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <label className="eyebrow !text-[10px] block mb-1.5">Location</label>
            <Input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="In-person address or video link"
            />
          </div>
          <div>
            <label className="eyebrow !text-[10px] block mb-1.5">Notes</label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={createMut.isPending}
            className="bg-foreground text-background hover:bg-foreground/85"
          >
            {createMut.isPending ? 'Saving…' : 'Schedule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* Week grid                                                       */
/* ────────────────────────────────────────────────────────────── */

function meetingPlacement(m: Meeting, dayStart: Date) {
  const start = new Date(m.starts_at);
  const end = m.ends_at ? new Date(m.ends_at) : new Date(start.getTime() + 30 * 60_000);
  const startHours = start.getHours() + start.getMinutes() / 60;
  const endHours = end.getHours() + end.getMinutes() / 60;
  const top = (Math.max(startHours, HOUR_START) - HOUR_START) * ROW_PX;
  const height = Math.max(
    24,
    (Math.min(endHours, HOUR_END + 1) - Math.max(startHours, HOUR_START)) * ROW_PX - 4,
  );
  // dayStart used to anchor (kept for symmetry / typing)
  void dayStart;
  return { top, height };
}

function WeekView({ days, meetings, onOpen }: { days: Date[]; meetings: Meeting[]; onOpen: (m: Meeting) => void }) {
  const now = new Date();
  const nowOffset =
    now.getHours() >= HOUR_START && now.getHours() <= HOUR_END
      ? (now.getHours() + now.getMinutes() / 60 - HOUR_START) * ROW_PX
      : null;
  const todayIdx = days.findIndex((d) => isSameDay(d, now));

  return (
    <div className="card-flat overflow-hidden">
      {/* Header strip */}
      <div className="grid grid-cols-[64px_repeat(7,minmax(0,1fr))] border-b border-border">
        <div className="border-r border-border" />
        {days.map((d) => {
          const today = isToday(d);
          return (
            <div
              key={d.toISOString()}
              className={cn(
                'px-3 py-3 text-left border-r last:border-r-0 border-border',
                today && 'bg-butter/[0.07]',
              )}
            >
              <p className="eyebrow !text-[9.5px]">{format(d, 'EEE')}</p>
              <p
                className={cn(
                  'font-display text-[22px] leading-none tracking-tight mt-1',
                  today ? 'text-foreground' : 'text-foreground/80',
                )}
              >
                {format(d, 'd')}
                {today && (
                  <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-butter align-middle" />
                )}
              </p>
            </div>
          );
        })}
      </div>

      {/* Time grid */}
      <div className="relative grid grid-cols-[64px_repeat(7,minmax(0,1fr))]">
        {/* hour gutter */}
        <div className="border-r border-border">
          {HOURS.map((h) => (
            <div
              key={h}
              style={{ height: ROW_PX }}
              className="px-2 pt-1 text-right border-b border-border/60 last:border-b-0"
            >
              <span className="font-mono text-[10px] text-muted-foreground num">
                {format(new Date().setHours(h, 0, 0, 0), 'h a')}
              </span>
            </div>
          ))}
        </div>

        {/* day columns */}
        {days.map((d, di) => {
          const dayMeetings = meetings.filter((m) => isSameDay(new Date(m.starts_at), d));
          return (
            <div
              key={d.toISOString()}
              className={cn(
                'relative border-r last:border-r-0 border-border',
                isToday(d) && 'bg-butter/[0.04]',
              )}
            >
              {HOURS.map((h) => (
                <div
                  key={h}
                  style={{ height: ROW_PX }}
                  className="border-b border-border/60 last:border-b-0"
                />
              ))}

              {/* now indicator */}
              {di === todayIdx && nowOffset !== null && (
                <div
                  className="absolute left-0 right-0 z-10 pointer-events-none"
                  style={{ top: nowOffset }}
                >
                  <div className="relative h-px bg-coral">
                    <span className="absolute -left-[3px] -top-[3px] h-1.5 w-1.5 rounded-full bg-coral" />
                  </div>
                </div>
              )}

              {/* meeting blocks */}
              {dayMeetings.map((m) => {
                const { top, height } = meetingPlacement(m, d);
                const start = new Date(m.starts_at);
                const end = m.ends_at ? new Date(m.ends_at) : null;
                return (
                  <button
                    key={m.id}
                    onClick={() => onOpen(m)}
                    className="absolute left-1 right-1 text-left rounded-md bg-card border border-butter/40 px-2 py-1.5 shadow-[0_1px_0_0_hsl(var(--butter)/0.3)] hover:border-butter hover:-translate-y-px transition-all cursor-pointer overflow-hidden"
                    style={{ top, height }}
                    title={m.title}
                  >
                    <span className="absolute left-0 top-1 bottom-1 w-[2px] rounded-r-full bg-butter" />
                    <p className="font-display text-[12.5px] leading-tight text-foreground truncate tracking-tight pl-1">
                      {m.title}
                    </p>
                    <p className="font-mono text-[10px] text-muted-foreground num pl-1 mt-0.5">
                      {format(start, 'h:mm')}{end ? `–${format(end, 'h:mm a')}` : format(start, ' a')}
                    </p>
                    {m.location && height > 60 && (
                      <p className="font-editorial italic text-[10.5px] text-muted-foreground truncate pl-1 mt-0.5 flex items-center gap-1">
                        <MapPin className="h-2.5 w-2.5 shrink-0" />
                        {m.location}
                      </p>
                    )}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* Agenda view                                                     */
/* ────────────────────────────────────────────────────────────── */

function AgendaView({ days, meetings, onOpen }: { days: Date[]; meetings: Meeting[]; onOpen: (m: Meeting) => void }) {
  return (
    <div className="space-y-8">
      {days.map((d) => {
        const list = meetings
          .filter((m) => isSameDay(new Date(m.starts_at), d))
          .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
        const today = isToday(d);
        return (
          <section key={d.toISOString()}>
            <div className="flex items-baseline gap-3 mb-3">
              <p className={cn('eyebrow', today && 'text-butter')}>
                {format(d, 'EEEE')}{today && ' · today'}
              </p>
              <span className="h-px flex-1 bg-border" />
              <p className="font-mono text-[11px] text-muted-foreground num">
                {format(d, 'MMM d')}
              </p>
            </div>
            {list.length === 0 ? (
              <p className="font-editorial italic text-[13px] text-muted-foreground/70 pl-1">
                — nothing scheduled —
              </p>
            ) : (
              <ul className="space-y-1.5">
                {list.map((m) => {
                  const start = new Date(m.starts_at);
                  const end = m.ends_at ? new Date(m.ends_at) : null;
                  return (
                    <li
                      key={m.id}
                      onClick={() => onOpen(m)}
                      className="card-flat px-4 py-3 flex items-center gap-4 hover:border-butter/60 cursor-pointer transition-colors"
                    >
                      <div className="w-20 shrink-0 font-mono text-[12px] text-foreground num leading-tight">
                        <div>{format(start, 'h:mm a')}</div>
                        {end && (
                          <div className="text-muted-foreground text-[10.5px]">
                            → {format(end, 'h:mm a')}
                          </div>
                        )}
                      </div>
                      <span className="h-8 w-px bg-border" />
                      <div className="min-w-0 flex-1">
                        <p className="font-display text-[15.5px] tracking-tight text-foreground truncate">
                          {m.title}
                        </p>
                        {m.location && (
                          <p className="font-editorial italic text-[12.5px] text-muted-foreground flex items-center gap-1 truncate">
                            <MapPin className="h-3 w-3 shrink-0" />
                            {m.location}
                          </p>
                        )}
                      </div>
                      <Sparkles className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* Page                                                            */
/* ────────────────────────────────────────────────────────────── */

export default function Meetings() {
  const { data: meetings = [], isLoading } = useMeetings();
  const [cursor, setCursor] = useState<Date>(new Date());
  const [mode, setMode] = useState<Mode>('week');
  const [openMeeting, setOpenMeeting] = useState<Meeting | null>(null);
  const v = useObjectView('meetings');
  const cvLookup = useCustomValueLookup('meetings');

  const tableRows = useMemo(() => {
    const filtered = v.filters.length === 0 ? meetings : meetings.filter((m: Meeting) =>
      v.filters.every((f) => rowMatches(m, f, (row, ref) => {
        const id = parseCustomFieldRef(ref);
        return id ? cvLookup.get(row.id, id) : null;
      })),
    );
    if (!v.sort) return filtered;
    const dir = v.sort.direction === 'asc' ? 1 : -1;
    const field = v.sort.field;
    return [...filtered].sort((a: any, b: any) => {
      const av = a?.[field] ?? ''; const bv = b?.[field] ?? '';
      return av > bv ? dir : av < bv ? -dir : 0;
    });
  }, [meetings, v.filters, v.sort, cvLookup]);

  const weekStart = useMemo(() => startOfWeek(cursor, { weekStartsOn: 1 }), [cursor]);
  const weekEnd = useMemo(() => endOfWeek(cursor, { weekStartsOn: 1 }), [cursor]);
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );

  const weekMeetings = useMemo(
    () =>
      meetings.filter((m) =>
        isWithinInterval(new Date(m.starts_at), { start: weekStart, end: weekEnd }),
      ),
    [meetings, weekStart, weekEnd],
  );

  const sameMonth = format(weekStart, 'MMM yyyy') === format(weekEnd, 'MMM yyyy');
  const rangeLabel = sameMonth
    ? `${format(weekStart, 'MMM d')} – ${format(weekEnd, 'd, yyyy')}`
    : `${format(weekStart, 'MMM d')} – ${format(weekEnd, 'MMM d, yyyy')}`;

  return (
    <div className="flex h-full flex-col">
      <div className="page-header">
        <div>
          <p className="eyebrow mb-3">Section 04 · Schedule</p>
          <h1 className="page-title">
            Calendar <em>in motion</em>
          </h1>
          <p className="mt-3 font-editorial italic text-[15px] text-muted-foreground max-w-md">
            Every conversation, on the books — a week at a glance or a clean agenda you can run from.
          </p>
        </div>
        <NewMeetingDialog />
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-4 px-8 pt-5 pb-3 flex-wrap">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setCursor(addWeeks(cursor, -1))}
            className="h-8 w-8 grid place-items-center rounded-md border border-border bg-card text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
            aria-label="Previous week"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            onClick={() => setCursor(addWeeks(cursor, 1))}
            className="h-8 w-8 grid place-items-center rounded-md border border-border bg-card text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
            aria-label="Next week"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <button
            onClick={() => setCursor(new Date())}
            className="ml-2 h-8 px-3 rounded-md border border-border bg-card text-[12.5px] text-foreground hover:border-foreground/30 transition-colors"
          >
            Today
          </button>
        </div>

        <div className="flex-1 min-w-0 flex items-baseline gap-3">
          <h2 className="font-display text-[22px] leading-none tracking-tight text-foreground truncate">
            {rangeLabel}
          </h2>
          <p className="font-editorial italic text-[13px] text-muted-foreground">
            {weekMeetings.length} {weekMeetings.length === 1 ? 'meeting' : 'meetings'} this week
          </p>
        </div>

        {/* mode toggle */}
        <div className="inline-flex rounded-md border border-border bg-card p-0.5">
          <button
            onClick={() => setMode('week')}
            className={cn(
              'h-7 px-3 rounded text-[12px] flex items-center gap-1.5 transition-colors',
              mode === 'week'
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <CalendarIcon className="h-3 w-3" />
            Week
          </button>
          <button
            onClick={() => setMode('agenda')}
            className={cn(
              'h-7 px-3 rounded text-[12px] flex items-center gap-1.5 transition-colors',
              mode === 'agenda'
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <List className="h-3 w-3" />
            Agenda
          </button>
          <button
            onClick={() => setMode('table')}
            className={cn(
              'h-7 px-3 rounded text-[12px] flex items-center gap-1.5 transition-colors',
              mode === 'table'
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <TableIcon className="h-3 w-3" />
            Table
          </button>
        </div>
      </div>
      {mode === 'table' && <ObjectToolbar objectType="meetings" />}

      <div className="flex-1 overflow-auto px-8 pb-8">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12" />
            <Skeleton className="h-[420px]" />
          </div>
        ) : mode === 'week' ? (
          <WeekView days={days} meetings={weekMeetings} onOpen={setOpenMeeting} />
        ) : mode === 'agenda' ? (
          <AgendaView days={days} meetings={weekMeetings} onOpen={setOpenMeeting} />
        ) : (
          <MeetingsTable meetings={tableRows} visibleFields={v.visibleFields} cvLookup={cvLookup} onOpen={setOpenMeeting} />
        )}
      </div>
      <MeetingAIDialog
        meeting={openMeeting as any}
        open={openMeeting !== null}
        onOpenChange={(o) => { if (!o) setOpenMeeting(null); }}
      />
    </div>
  );
}

function meetingLabel(slug: string): string {
  switch (slug) {
    case 'title': return 'Title';
    case 'starts_at': return 'Starts';
    case 'ends_at': return 'Ends';
    case 'location': return 'Location';
    case 'created_at': return 'Created';
    default: return slug;
  }
}

function renderMeetingBuiltin(m: Meeting, slug: string) {
  if (slug === 'starts_at' || slug === 'ends_at' || slug === 'created_at') {
    const v = (m as any)[slug];
    return <span className="text-muted-foreground">{v ? formatDistanceToNowStrict(new Date(v), { addSuffix: true }) : '—'}</span>;
  }
  return (m as any)[slug] ?? '—';
}

function MeetingsTable({ meetings, visibleFields, cvLookup, onOpen }: {
  meetings: Meeting[];
  visibleFields: string[];
  cvLookup: ReturnType<typeof useCustomValueLookup>;
  onOpen: (m: Meeting) => void;
}) {
  const visibleBuilt = visibleFields.filter((s) => !parseCustomFieldRef(s));
  const visibleCustom = visibleFields.map(parseCustomFieldRef).filter((x): x is string => !!x);
  if (meetings.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center">
        <h3 className="font-medium">No matches</h3>
        <p className="mt-1 text-sm text-muted-foreground">Adjust filters or switch to Week / Agenda.</p>
      </div>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {visibleBuilt.map((slug) => <TableHead key={slug}>{meetingLabel(slug)}</TableHead>)}
          {visibleCustom.map((id) => {
            const f = cvLookup.fields.find((x) => x.id === id);
            return <TableHead key={id}>{f?.name ?? '—'}</TableHead>;
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {meetings.map((m) => (
          <TableRow key={m.id} className="cursor-pointer hover:bg-butter/[0.04]" onClick={() => onOpen(m)}>
            {visibleBuilt.map((slug) => (
              <TableCell key={slug} className="text-sm">{renderMeetingBuiltin(m, slug)}</TableCell>
            ))}
            {visibleCustom.map((id) => (
              <TableCell key={id} onClick={(e) => e.stopPropagation()} className="text-sm">
                <CustomFieldCell field={cvLookup.fields.find((x) => x.id === id)} entityId={m.id} value={cvLookup.get(m.id, id)} />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
