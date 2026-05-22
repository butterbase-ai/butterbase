export interface Env {
  CONTROL_API_URL: string;
  REDIS_HOST_US: string;
  REDIS_HOST_EU: string;
  REDIS_PORT: string;
  INTERNAL_SECRET: string;
}

export default {
  async fetch(_req: Request, _env: Env): Promise<Response> {
    return new Response(JSON.stringify({ status: 'kv-gateway ok' }), {
      headers: { 'content-type': 'application/json' },
    });
  },
};
