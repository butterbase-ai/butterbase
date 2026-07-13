// Platform-owned shim that translates HTTPS calls from deno-runtime (Fly)
// into WfP dispatch-namespace calls to user ${appId}_do Workers. Auth is a
// single platform bearer held by control-plane processes only — never in
// user env, never in user code, never in logs.
//
// Later tasks fill in the auth check and dispatch translation. This stub
// exists so the deploy target and test harness are validated first.
export default {
  async fetch(_req: Request, _env: Env): Promise<Response> {
    return new Response('do-invoker: not yet implemented', { status: 501 });
  },
};

export interface Env {
  DO_DISPATCH: DispatchNamespace;
  DO_INVOKER_TOKEN: string;
}
