/**
 * Route-level body limit for AI endpoints. Fastify defaults to 1 MB, which a
 * multi-turn conversation carrying base64 images (or a decision call with a
 * large `state`) blows through — the client sees a bare 413 with no hint of
 * the cause. 25 MB clears realistic payloads while still bounding a request.
 */
export const AI_BODY_LIMIT_BYTES = 25 * 1024 * 1024;
