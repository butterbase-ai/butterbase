import { officeActionSchema, officeErrorSchema, officeStatusSchema, officeTurnSchema, confirmationReceiptSchema } from '@butterbase/shared';
import type { OfficeClientOptions } from '@butterbase/shared';
import { OfficeClientError, type OfficeResponse } from './types.js';

export { officeHttpRequest, type OfficeHttpRequest } from '@butterbase/shared';
import { officeHttpRequest, type OfficeHttpRequest } from '@butterbase/shared';

export function officeError(code: ConstructorParameters<typeof OfficeClientError>[0]['code'], message: string): OfficeClientError {
  return new OfficeClientError({ code, message });
}
/** Bounds observation even if an injected transport/token refresh ignores abort. */
function observe<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(officeError('aborted', 'Observation was cancelled.')); };
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}
export class OfficeTransport {
  private readonly fetch: typeof globalThis.fetch;
  private readonly base: string;
  constructor(private readonly options: OfficeClientOptions) {
    let url: URL;
    try { url = new URL(options.apiUrl); } catch { throw officeError('invalid_request', 'apiUrl must be an HTTP or HTTPS API URL.'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      !officeActionSchema.safeParse({ action: 'status', org_id: options.organizationId }).success) throw officeError('invalid_request', 'Supply an API URL and an explicit organization UUID.');
    this.base = options.apiUrl.replace(/\/$/, ''); this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }
  async open(request: OfficeHttpRequest, signal?: AbortSignal, stream = false): Promise<Response> {
    const body = request.body ? JSON.stringify(request.body) : undefined;
    const retrySafe = request.method === 'GET' || typeof request.body?.idempotency_key === 'string';
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw officeError('aborted', 'Observation was cancelled.');
      let token: string;
      try { token = await observe(Promise.resolve().then(() => this.options.getToken()), signal); }
      catch { throw officeError(signal?.aborted ? 'aborted' : 'unauthenticated', signal?.aborted ? 'Observation was cancelled.' : 'A platform credential is required.'); }
      if (!token) throw officeError('unauthenticated', 'A platform credential is required.');
      let response: Response;
      try {
        response = await observe(this.fetch(`${this.base}${request.path}`, { method: request.method, body, signal,
          headers: { Authorization: `Bearer ${token}`, 'x-organization-id': request.organizationId,
            ...(body ? { 'Content-Type': 'application/json' } : {}), ...(stream ? { Accept: 'text/event-stream' } : {}) } }), signal);
      } catch {
        if (signal?.aborted) throw officeError('aborted', 'Observation was cancelled.');
        if (attempt === 0 && retrySafe) continue;
        throw officeError('connection_error', 'The connection ended. Inspect the exact request or retry with its original idempotency key.');
      }
      if (response.ok) return response;
      if (attempt === 0 && retrySafe && [502, 503, 504].includes(response.status)) { await response.body?.cancel().catch(() => {}); continue; }
      const payload = await observe(response.json().catch(() => null), signal);
      const parsed = officeErrorSchema.safeParse(payload?.error);
      throw parsed.success ? new OfficeClientError(parsed.data, response.status)
        : new OfficeClientError({ code: response.status === 401 ? 'unauthenticated' : response.status === 403 ? 'forbidden' : 'service_unavailable', message: 'Office request failed.' }, response.status);
    }
  }
  async request<T>(input: unknown, signal?: AbortSignal): Promise<OfficeResponse<T>> {
    const parsed = officeActionSchema.safeParse(input);
    if (!parsed.success) return { data: null, error: officeError('invalid_request', 'Invalid Office action or fields.') };
    try {
      const response = await this.open(officeHttpRequest(parsed.data), signal);
      let data = await observe(response.json(), signal);
      const action = parsed.data.action;
      // Preserve the dashboard's existing REST envelope while exposing the
      // standalone client's agreed OfficeStatus value.
      if (action === 'status' && !parsed.data.confirmation_id) data = data?.status ?? data;
      const schema = action === 'ask' ? officeTurnSchema : ['enable', 'pause', 'resume', 'approve'].includes(action)
        || (action === 'status' && parsed.data.confirmation_id) ? confirmationReceiptSchema : action === 'status' ? officeStatusSchema : undefined;
      if (!data || typeof data !== 'object' || (schema && !schema.safeParse(data).success)) throw officeError('protocol_error', 'Office returned an invalid response.');
      return { data: data as T, error: null };
    } catch (error) {
      return { data: null, error: error instanceof OfficeClientError ? error
        : officeError(signal?.aborted ? 'aborted' : error instanceof SyntaxError ? 'protocol_error' : 'connection_error', 'Office response could not be read.') };
    }
  }
}
