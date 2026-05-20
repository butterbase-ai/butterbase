// services/build-runner/src/auth.ts
export function checkAuth(req: Request, secret: string): Response | null {
  const got = req.headers.get('authorization') ?? '';
  const expected = `Bearer ${secret}`;
  if (got !== expected) return new Response('unauthorized', { status: 401 });
  return null;
}
