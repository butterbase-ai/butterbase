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
    return new Response('do-invoker: not yet implemented', { status: 501 });
  },
};

export interface Env {
  DO_DISPATCH: DispatchNamespace;
  DO_INVOKER_TOKEN: string;
}
