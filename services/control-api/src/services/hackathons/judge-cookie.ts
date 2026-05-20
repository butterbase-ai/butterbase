import type { FastifyRequest, FastifyReply } from 'fastify';

const MAX_AGE_SEC = 30 * 24 * 60 * 60; // 30 days

export interface JudgePayload {
  hackathon_id: string;
  code_set_at: string; // ISO; rotation invalidates by mismatch
}

export function cookieName(hackathonId: string): string {
  return `bb_judge_${hackathonId}`;
}

export function setJudgeCookie(reply: FastifyReply, payload: JudgePayload): void {
  reply.setCookie(cookieName(payload.hackathon_id), JSON.stringify(payload), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SEC,
    signed: true,
  });
}

export function clearJudgeCookie(reply: FastifyReply, hackathonId: string): void {
  reply.clearCookie(cookieName(hackathonId), { path: '/' });
}

export function readJudgeCookie(request: FastifyRequest, hackathonId: string): JudgePayload | null {
  const raw = request.cookies[cookieName(hackathonId)];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || unsigned.value === null) return null;
  try {
    const payload = JSON.parse(unsigned.value) as JudgePayload;
    if (payload.hackathon_id !== hackathonId) return null;
    return payload;
  } catch {
    return null;
  }
}
