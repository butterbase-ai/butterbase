/**
 * Automatically preserve verified cron origin for managed API calls. This
 * function is serialized into the isolated Worker; keep it closure-free.
 */
export function createCronFetch(nativeFetch: typeof fetch, token: string, origins: string[]): typeof fetch {
  const allowed = new Set(origins.filter(Boolean).map(origin => new URL(origin).origin));
  const header = 'x-butterbase-cron-origin';
  return async (input, init) => {
    const inputUrl = input instanceof Request ? input.url : String(input);
    if (!allowed.has(new URL(inputUrl).origin)) return nativeFetch(input, init);
    let request = new Request(input, init);
    const redirectMode = request.redirect;
    let redirected = false;
    for (let hops = 0; ; hops++) {
      if (allowed.has(new URL(request.url).origin)) request.headers.set(header, token);
      else request.headers.delete(header);

      // Native fetch follows redirects with arbitrary custom headers intact.
      // Follow explicitly so metadata never leaks to an unrelated destination.
      const replay = request.body ? request.clone() : request;
      const response = await nativeFetch(request, { redirect: 'manual' });
      const location = response.headers.get('location');
      const isRedirect = [301, 302, 303, 307, 308].includes(response.status) && location !== null;
      if (!isRedirect || redirectMode === 'manual') {
        if (replay !== request) void replay.body?.cancel().catch(() => {});
        if (redirected) Object.defineProperty(response, 'redirected', { value: true });
        return response;
      }
      if (redirectMode === 'error' || hops >= 20) {
        void replay.body?.cancel().catch(() => {});
        await response.body?.cancel();
        throw new TypeError('Cron fetch redirect rejected or limit exceeded');
      }
      const nextUrl = new URL(location!, request.url);
      const headers = new Headers(request.headers);
      if (nextUrl.origin !== new URL(request.url).origin) {
        for (const name of ['authorization', 'cookie', 'proxy-authorization', header]) headers.delete(name);
      }
      const changeToGet = (response.status === 303 && request.method !== 'GET' && request.method !== 'HEAD')
        || ((response.status === 301 || response.status === 302) && request.method === 'POST');
      if (changeToGet) {
        for (const name of ['content-encoding', 'content-language', 'content-location', 'content-type', 'content-length']) headers.delete(name);
        void replay.body?.cancel().catch(() => {});
      }
      const body = changeToGet ? null : replay.body;
      request = new Request(nextUrl, {
        method: changeToGet ? 'GET' : request.method,
        headers, body, signal: request.signal,
        credentials: request.credentials, cache: request.cache,
        referrerPolicy: request.referrerPolicy,
        // Required by Node's streaming Request implementation; Deno accepts it.
        ...(body ? { duplex: 'half' } : {}),
      });
      await response.body?.cancel();
      redirected = true;
    }
  };
}
