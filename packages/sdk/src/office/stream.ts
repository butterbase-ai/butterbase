import { officeErrorSchema, officePublicEventSchema, type OfficePublicEvent } from '@butterbase/shared';
import { OfficeClientError, OfficeStreamError } from './types.js';
import { officeError } from './transport.js';

export async function* readOfficeEvents(response: Response, conversationId: string, turnId: string, afterSequence: number, signal?: AbortSignal): AsyncGenerator<OfficePublicEvent> {
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') || !response.body) throw officeError('protocol_error', 'Expected an Office event stream.');
  const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', event = '', id = '', data: string[] = [], size = 0, lastSequence = afterSequence, suspended = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw officeError('aborted', 'Observation was cancelled.');
    while (true) {
      const chunk = await reader.read();
      if (signal?.aborted) throw officeError('aborted', 'Observation was cancelled.');
      try { buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true }); }
      catch { throw officeError('protocol_error', 'Invalid UTF-8 in the Office event stream.'); }
      let boundary: number;
      while ((boundary = buffer.search(/[\r\n]/)) >= 0) {
        if (buffer[boundary] === '\r' && boundary === buffer.length - 1 && !chunk.done) break;
        const line = buffer.slice(0, boundary);
        const separator = buffer[boundary] === '\r' && buffer[boundary + 1] === '\n' ? 2 : 1;
        buffer = buffer.slice(boundary + separator);
        if (line !== '') {
          if (line.startsWith(':')) continue;
          size += line.length;
          if (size > 131072) throw officeError('protocol_error', 'Office event exceeds the public frame limit.');
          const colon = line.indexOf(':'); const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') event = value;
          else if (field === 'id') id = value;
          else if (field === 'data') data.push(value);
          continue;
        }
        const kind = event, sequence = id, text = data.join('\n');
        event = ''; id = ''; data = []; size = 0;
        if (!text) continue;
        let value: unknown;
        try { value = JSON.parse(text); } catch { throw officeError('protocol_error', 'Malformed Office event data.'); }
        if (kind === 'error') {
          const parsed = officeErrorSchema.safeParse((value as { error?: unknown })?.error);
          throw parsed.success ? new OfficeClientError(parsed.data) : officeError('protocol_error', 'Invalid Office stream error.');
        }
        const parsed = officePublicEventSchema.safeParse(value);
        if (!parsed.success || (kind && kind !== parsed.data.type) || (sequence && (!/^\d+$/.test(sequence) || Number(sequence) !== parsed.data.sequence))) throw officeError('protocol_error', 'Invalid Office public event.');
        const publicEvent = parsed.data;
        if ((publicEvent.type === 'started' || publicEvent.type === 'completed') &&
          (publicEvent.conversation_id !== conversationId || publicEvent.turn_id !== turnId)) throw officeError('protocol_error', 'Office event belongs to a different turn.');
        if (publicEvent.sequence <= lastSequence) continue;
        if (publicEvent.sequence !== lastSequence + 1) throw officeError('protocol_error', 'Office event sequence has a gap.');
        lastSequence = publicEvent.sequence;
        suspended = publicEvent.type === 'approval_required';
        yield publicEvent;
        if (['completed', 'blocked', 'failed', 'interrupted', 'decision_resolved'].includes(publicEvent.type)) return;
      }
      if (buffer.length + size > 131072) throw officeError('protocol_error', 'Office event exceeds the public frame limit.');
      if (chunk.done) {
        if (suspended && !buffer && !data.length) return;
        throw officeError('connection_error', 'Office stream ended before a terminal event. Resume using the exact turn and last sequence.');
      }
    }
  } catch (error) {
    throw new OfficeStreamError(error instanceof OfficeClientError ? error : officeError(signal?.aborted ? 'aborted' : 'connection_error', 'Office event observation ended.'), conversationId, turnId, lastSequence);
  } finally {
    signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
