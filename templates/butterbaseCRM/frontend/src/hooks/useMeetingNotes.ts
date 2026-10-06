// Meeting notetaker hooks.
//
// Wraps the three notetaker functions exposed by the backend:
//   - get-meeting-notes        (read: artifact + decisions/commitments/learnings)
//   - start-meeting-bot        (kick off the auto-join bot — stub today)
//   - ingest-meeting-transcript (manual paste / bot delivery)
//
// Reads are cached under ['meeting_notes', meetingId]; writes also invalidate
// the workspace-scoped meetings list so any status badge on cards refreshes.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { bbInvoke } from '@/lib/butterbase';
import { qk } from '@/lib/queryKeys';
import { useCurrentWorkspaceId } from '@/lib/workspace';

export type NotetakerStatus = 'idle' | 'pending_transcript' | 'done' | 'failed';

export interface MeetingNoteArtifact {
  content?: string | null;
  summary?: string | null;
  [k: string]: any;
}

export interface MeetingNotesResponse {
  meeting_id: string;
  status: NotetakerStatus;
  artifact?: MeetingNoteArtifact | null;
  decisions?: Array<{ text: string; [k: string]: any }>;
  commitments?: Array<{ text: string; [k: string]: any }>;
  learnings?: Array<{ text: string; [k: string]: any }>;
  error?: string | null;
  [k: string]: any;
}

export function useMeetingNotes(meetingId: string | null | undefined) {
  return useQuery({
    queryKey: ['meeting_notes', meetingId],
    enabled: !!meetingId,
    queryFn: async (): Promise<MeetingNotesResponse> => {
      const { data, error } = await bbInvoke<MeetingNotesResponse>(
        'get-meeting-notes',
        { meeting_id: meetingId },
      );
      if (error) throw error;
      return (data ?? { meeting_id: meetingId!, status: 'idle' }) as MeetingNotesResponse;
    },
  });
}

export function useStartNotetaker() {
  const ws = useCurrentWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (meeting_id: string) => {
      const { data, error } = await bbInvoke('start-meeting-bot', { meeting_id });
      if (error) throw error;
      return data;
    },
    onSuccess: (_data, meeting_id) => {
      qc.invalidateQueries({ queryKey: ['meeting_notes', meeting_id] });
      qc.invalidateQueries({ queryKey: qk.meetings(ws) });
    },
  });
}

export function useCancelNotetaker() {
  const ws = useCurrentWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (meeting_id: string) => {
      const { data, error } = await bbInvoke('cancel-meeting-bot', { meeting_id });
      if (error) throw error;
      return data;
    },
    onSuccess: (_data, meeting_id) => {
      qc.invalidateQueries({ queryKey: ['meeting_notes', meeting_id] });
      qc.invalidateQueries({ queryKey: qk.meetings(ws) });
    },
  });
}

export interface IngestTranscriptInput {
  meeting_id: string;
  transcript_text: string;
  speaker_turns?: Array<{ speaker: string; text: string; ts?: number | null }>;
  duration_seconds?: number;
  recording_storage_object_id?: string;
}

export function useIngestMeetingTranscript() {
  const ws = useCurrentWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: IngestTranscriptInput) => {
      const { data, error } = await bbInvoke('ingest-meeting-transcript', input);
      if (error) throw error;
      return data;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['meeting_notes', vars.meeting_id] });
      qc.invalidateQueries({ queryKey: qk.meetings(ws) });
    },
  });
}
