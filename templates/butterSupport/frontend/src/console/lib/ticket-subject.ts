import { bb } from './bb';

const SYSTEM_PROMPT =
  'You write short ticket subjects for a customer-support inbox. ' +
  'Return ONLY the subject — no quotes, no trailing period, max 60 characters, ' +
  "sentence case. Focus on the user's problem, not greetings.";

export async function regenerateTicketSubject(ticketId: string): Promise<string | null> {
  const msgsRes: any = await bb
    .from('support_messages')
    .select('*')
    .eq('ticket_id', ticketId)
    .order('created_at', { ascending: true });
  const rows = Array.isArray(msgsRes?.data) ? msgsRes.data : Array.isArray(msgsRes) ? msgsRes : [];
  const firstCustomer = rows.find((m: any) => m.role === 'customer');
  if (!firstCustomer?.body) return null;

  const res: any = await (bb as any).ai.chat(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: String(firstCustomer.body).slice(0, 2000) },
    ],
    { maxTokens: 40, temperature: 0.2 },
  );
  const completion = res?.data ?? res;
  const raw: string = completion?.choices?.[0]?.message?.content ?? '';
  const subject = raw.trim().replace(/^["']|["']$/g, '').slice(0, 80);
  if (!subject) return null;

  await bb.from('support_tickets').update({ subject }).eq('id', ticketId);
  return subject;
}
