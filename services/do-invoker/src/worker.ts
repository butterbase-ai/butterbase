// Platform-owned shim that translates HTTPS calls from deno-runtime (Fly)
// into WfP dispatch-namespace calls to user ${appId}_do Workers. Auth is a
// single platform bearer held by control-plane processes only — never in
// user env, never in user code, never in logs.
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${env.DO_INVOKER_TOKEN}`) {
      return new Response('unauthorized', { status: 401 });
    }

    const appId = req.headers.get('x-butterbase-app');
    const className = req.headers.get('x-butterbase-class');
    const instanceKey = req.headers.get('x-butterbase-instance');

    if (!appId) return new Response('x-butterbase-app required', { status: 400 });
    if (!className) return new Response('x-butterbase-class required', { status: 400 });
    if (!instanceKey) return new Response('x-butterbase-instance required', { status: 400 });

    // Build the internal-hostname request the target ${appId}_do fetch
    // handler recognizes as a dispatch arrival. Method, headers, body all
    // preserved so caller identity + loop-depth + content-type propagate.
    const internalUrl = `https://internal.butterbase/_dispatch/${encodeURIComponent(className)}/${encodeURIComponent(instanceKey)}`;
    const dispatchReq = new Request(internalUrl, req);

    let stub;
    try {
      stub = env.DO_DISPATCH.get(`${appId}_do`);
    } catch (err) {
      // WfP dispatch throws when the script name isn't registered — surface
      // as 404 instead of leaking a CF 1101 (uncaught Worker exception).
      return new Response(`unknown app: ${appId}`, { status: 404 });
    }
    try {
      return await stub.fetch(dispatchReq);
    } catch (err) {
      return new Response(`dispatch failed: ${err instanceof Error ? err.message : String(err)}`, { status: 502 });
    }
  },
};

export interface Env {
  DO_DISPATCH: DispatchNamespace;
  DO_INVOKER_TOKEN: string;
}
