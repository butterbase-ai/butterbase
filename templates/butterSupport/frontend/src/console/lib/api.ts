import { bb } from './bb';

async function invoke<T = any>(name: string, body: Record<string, unknown> = {}): Promise<T> {
  const res: any = await bb.functions.invoke(name, { body });
  // SDK may return either raw data or {data, error} shape — normalize.
  if (res && typeof res === 'object' && 'error' in res && res.error) {
    throw new Error(res.error.message || `Function ${name} failed`);
  }
  return (res?.data ?? res) as T;
}

export const api = {
  requestDocUploadUrl: (b: { filename: string; content_type: string; size_bytes: number }) =>
    invoke<{ upload_url: string; object_id: string }>('request-doc-upload-url', b),

  ingestDocs: (b: { url?: string; source_kind: 'web' | 'file' | 'text'; display_name?: string; object_id?: string; text?: string }) =>
    invoke<{ source_id: string }>('ingest-docs', b),

  deleteDocsSource: (b: { source_id: string }) =>
    invoke<{ ok: true }>('delete-docs-source', b),

  inviteTeammate: (b: { email: string; default_role: string; send_email?: boolean }) =>
    invoke<{ ok: true; allowlist_id?: string }>('invite-teammate', b),

  removeTeammate: (b: { user_id: string; remove_from_allowlist?: boolean }) =>
    invoke<{ ok: true }>('remove-teammate', b),

  fetchAiUsage: async (range?: { startDate?: string; endDate?: string }) => {
    const qs = new URLSearchParams();
    if (range?.startDate) qs.set('startDate', range.startDate);
    if (range?.endDate) qs.set('endDate', range.endDate);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return invoke<any>(`fetch-ai-usage${suffix}`);
  },

  substrateProxy: (b: { action: string; params: Record<string, unknown> }) =>
    invoke<any>('substrate-proxy', b),

  approveProposal: (b: { proposal_id: string }) =>
    invoke<{ ok: true }>('approve-proposal', b),

  rejectProposal: (b: { proposal_id: string; reason?: string }) =>
    invoke<{ ok: true }>('reject-proposal', b),

  sendDraftReply: (b: {
    ticket_id: string;
    draft_message_id?: string;
    edited_body?: string;
    mark_as_resolved?: boolean;
  }) => invoke<{ ok: true; message_id?: string }>('send-draft-reply', b),

  markAsCommitment: (b: { ticket_id: string; message_id: string; due_date?: string; title?: string; content?: string }) =>
    invoke<{ ok: true; commitment_id?: string }>('mark-as-commitment', b),

  convertToPolicy: (b: { title: string; content: string; scope?: string; rationale?: string; source_ticket_id?: string }) =>
    invoke<{ ok: true; policy_id?: string }>('convert-to-policy', b),

  // Runs the `support-overview` platform agent via a server-side passthrough
  // function (`ask-support-overview`). The /agents/.../runs endpoint requires
  // a service key, which we keep server-side; the function holds the key in
  // its env and forwards the founder's invocation.
  runSupportOverview: (b: { message: string }) =>
    invoke<{ value: string }>('ask-support-overview', b),
};
