/**
 * Tests for dashboard-agent routes.
 *
 * Auth is stubbed by decorating request.auth directly (same pattern as
 * people.test.ts). No real database connections are used — all store functions
 * are mocked via vi.mock.
 *
 * runAgentTurn is mocked so SSE tests are fully synchronous.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// ── Module mocks (hoisted before imports) ───────────────────────────────────

vi.mock('../../services/dashboard-agent/store.js', () => ({
  createConversation: vi.fn(),
  listConversations: vi.fn(),
  getConversation: vi.fn(),
  deleteConversation: vi.fn(),
  listMessages: vi.fn(),
}));

vi.mock('../../services/dashboard-agent/loop.js', () => ({
  runAgentTurn: vi.fn(),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { dashboardAgentRoutes } from '../dashboard-agent.js';
import {
  createConversation,
  listConversations,
  getConversation,
  deleteConversation,
  listMessages,
} from '../../services/dashboard-agent/store.js';
import { runAgentTurn } from '../../services/dashboard-agent/loop.js';

// ── Constants ────────────────────────────────────────────────────────────────

const USER_A = 'user-a-id';
const USER_B = 'user-b-id';

const SAMPLE_CONVERSATION = {
  id: '11111111-1111-1111-1111-111111111111',
  userId: USER_A,
  title: 'Hello world',
  model: 'claude-sonnet-4-5',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  lastMessageAt: null,
};

const SAMPLE_MESSAGE = {
  id: '22222222-2222-2222-2222-222222222222',
  conversationId: SAMPLE_CONVERSATION.id,
  role: 'user' as const,
  content: 'Hello',
  toolCallId: null,
  toolName: null,
  toolArgs: null,
  toolResult: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

// ── Factory helpers ──────────────────────────────────────────────────────────

/**
 * Build a test Fastify app with auth stubbed to userId and controlDb mocked.
 * Pass userId=null to simulate unauthenticated requests (request.auth.userId
 * will be null, causing requireUserId to throw 401).
 */
async function buildTestApp(userId: string | null = USER_A): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Stub auth — mirrors the pattern in people.test.ts
  app.decorateRequest('auth', null as any);
  app.addHook('onRequest', async (request) => {
    (request as any).auth = { userId, authMethod: 'jwt', scopes: ['*'] };
  });

  // Provide a mock controlDb so the plugin has the decoration
  app.decorate('controlDb', {} as any);

  await app.register(dashboardAgentRoutes);
  await app.ready();
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('dashboard-agent routes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.DASHBOARD_ASSISTANT_ENABLED = '1';
  });

  afterEach(async () => {
    await app?.close();
    delete process.env.DASHBOARD_ASSISTANT_ENABLED;
  });

  // ── Case 1: Feature flag off → 404 on all endpoints ─────────────────────

  describe('Case 1: feature flag off → 404 on all endpoints', () => {
    beforeEach(async () => {
      delete process.env.DASHBOARD_ASSISTANT_ENABLED;
      app = await buildTestApp();
    });

    const endpoints: Array<{ method: 'GET' | 'POST' | 'DELETE'; url: string }> = [
      { method: 'POST', url: '/conversations' },
      { method: 'GET', url: '/conversations' },
      { method: 'GET', url: '/conversations/some-id' },
      { method: 'DELETE', url: '/conversations/some-id' },
      { method: 'POST', url: '/messages' },
    ];

    for (const { method, url } of endpoints) {
      it(`${method} ${url} returns 404`, async () => {
        const r = await app.inject({ method, url, payload: {} });
        expect(r.statusCode).toBe(404);
        expect(r.json()).toMatchObject({ error: 'not enabled' });
      });
    }
  });

  // ── Case 2: Flag on, missing auth → 401 ─────────────────────────────────

  describe('Case 2: flag on, unauthenticated → 401', () => {
    beforeEach(async () => {
      // userId=null → request.auth.userId is null → requireUserId throws 401
      app = await buildTestApp(null);
    });

    it('POST /conversations returns 401', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/conversations',
        payload: { title: 'test', model: 'claude-sonnet-4-5' },
      });
      expect(r.statusCode).toBe(401);
    });

    it('GET /conversations returns 401', async () => {
      const r = await app.inject({ method: 'GET', url: '/conversations' });
      expect(r.statusCode).toBe(401);
    });
  });

  // ── Case 3: POST /conversations returns the created row ─────────────────

  describe('Case 3: POST /conversations creates and returns conversation', () => {
    beforeEach(async () => {
      app = await buildTestApp();
    });

    it('returns 201 with the conversation object', async () => {
      vi.mocked(createConversation).mockResolvedValueOnce(SAMPLE_CONVERSATION);

      const r = await app.inject({
        method: 'POST',
        url: '/conversations',
        payload: { title: 'Hello world', model: 'claude-sonnet-4-5' },
      });

      expect(r.statusCode).toBe(201);
      const body = r.json();
      expect(body.conversation.id).toBe(SAMPLE_CONVERSATION.id);
      expect(body.conversation.title).toBe(SAMPLE_CONVERSATION.title);
      expect(createConversation).toHaveBeenCalledWith(
        expect.anything(), // pool (mocked controlDb)
        USER_A,
        'Hello world',
        'claude-sonnet-4-5',
      );
    });
  });

  // ── Case 4: GET /conversations returns only caller's rows ────────────────

  describe("Case 4: GET /conversations returns only the caller's rows", () => {
    beforeEach(async () => {
      app = await buildTestApp();
    });

    it('calls listConversations with the authenticated userId', async () => {
      const convs = [SAMPLE_CONVERSATION];
      vi.mocked(listConversations).mockResolvedValueOnce(convs);

      const r = await app.inject({ method: 'GET', url: '/conversations' });

      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.conversations).toHaveLength(1);
      expect(body.conversations[0].id).toBe(SAMPLE_CONVERSATION.id);
      // Verify the store was called with the correct userId — not a different user
      expect(listConversations).toHaveBeenCalledWith(expect.anything(), USER_A);
    });
  });

  // ── Case 5: GET /conversations/:id for another user's id returns 404 ────

  describe("Case 5: GET /conversations/:id for another user's id returns 404", () => {
    beforeEach(async () => {
      app = await buildTestApp(USER_A);
    });

    it('returns 404 when conversation belongs to a different user', async () => {
      // getConversation returns null because USER_A doesn't own the conversation
      vi.mocked(getConversation).mockResolvedValueOnce(null);

      const r = await app.inject({
        method: 'GET',
        url: `/conversations/${SAMPLE_CONVERSATION.id}`,
      });

      expect(r.statusCode).toBe(404);
      expect(r.json()).toMatchObject({ error: 'conversation not found' });
      // Confirm it was called with USER_A (not USER_B)
      expect(getConversation).toHaveBeenCalledWith(
        expect.anything(),
        SAMPLE_CONVERSATION.id,
        USER_A,
      );
    });
  });

  // ── Case 6: POST /messages — SSE stream ─────────────────────────────────

  describe('Case 6: POST /messages — SSE stream', () => {
    beforeEach(async () => {
      app = await buildTestApp();
    });

    it('returns SSE content-type and frames in order', async () => {
      // Ownership check succeeds
      vi.mocked(getConversation).mockResolvedValueOnce(SAMPLE_CONVERSATION);

      // Mock runAgentTurn as an async generator that yields three events
      async function* mockGen() {
        yield { type: 'token', text: 'Hello' };
        yield { type: 'assistant_message', content: 'Hello world' };
        yield { type: 'done' };
      }
      vi.mocked(runAgentTurn).mockReturnValueOnce(mockGen() as any);

      const r = await app.inject({
        method: 'POST',
        url: '/messages',
        payload: {
          conversation_id: SAMPLE_CONVERSATION.id,
          message: 'hi',
          model: 'claude-sonnet-4-5',
        },
        headers: { authorization: 'Bearer test-jwt-token' },
      });

      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toContain('text/event-stream');

      // Parse SSE frames from body
      const frames = r.body
        .split('\n\n')
        .filter((f: string) => f.startsWith('data: '))
        .map((f: string) => JSON.parse(f.slice(6)));

      expect(frames).toHaveLength(3);
      expect(frames[0]).toMatchObject({ type: 'token', text: 'Hello' });
      expect(frames[1]).toMatchObject({ type: 'assistant_message', content: 'Hello world' });
      expect(frames[2]).toMatchObject({ type: 'done' });

      // Verify JWT was extracted and passed to the loop
      expect(runAgentTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          jwt: 'test-jwt-token',
          conversationId: SAMPLE_CONVERSATION.id,
          userId: USER_A,
          userMessage: 'hi',
          model: 'claude-sonnet-4-5',
        }),
      );
    });

    it('forwards Task-7 builder-mode SSE frames (file_change, active_app_change, deployment_progress)', async () => {
      vi.mocked(getConversation).mockResolvedValueOnce(SAMPLE_CONVERSATION);

      async function* mockGen() {
        yield { type: 'active_app_change', app_id: 'app_1' };
        yield { type: 'file_change', app_id: 'app_1', path: 'src/App.tsx', kind: 'write', sha256: 'abc' };
        yield { type: 'deployment_progress', deployment_id: 'dep_1', status: 'live', url: 'https://x' };
        yield { type: 'done' };
      }
      vi.mocked(runAgentTurn).mockReturnValueOnce(mockGen() as any);

      const r = await app.inject({
        method: 'POST',
        url: '/messages',
        payload: {
          conversation_id: SAMPLE_CONVERSATION.id,
          message: 'ship it',
          model: 'claude-sonnet-4-5',
        },
        headers: { authorization: 'Bearer test-jwt-token' },
      });

      expect(r.statusCode).toBe(200);
      const frames = r.body
        .split('\n\n')
        .filter((f: string) => f.startsWith('data: '))
        .map((f: string) => JSON.parse(f.slice(6)));

      expect(frames).toHaveLength(4);
      expect(frames[0]).toEqual({ type: 'active_app_change', app_id: 'app_1' });
      expect(frames[1]).toMatchObject({ type: 'file_change', app_id: 'app_1', path: 'src/App.tsx', kind: 'write' });
      expect(frames[2]).toMatchObject({ type: 'deployment_progress', deployment_id: 'dep_1', status: 'live', url: 'https://x' });
      expect(frames[3]).toEqual({ type: 'done' });
    });
  });

  // ── Case 7: POST /messages — invalid conversation_id → 404 ──────────────

  describe('Case 7: POST /messages — invalid conversation_id → 404', () => {
    beforeEach(async () => {
      app = await buildTestApp();
    });

    it('returns 404 (not 500) when conversation does not exist', async () => {
      vi.mocked(getConversation).mockResolvedValueOnce(null);

      const r = await app.inject({
        method: 'POST',
        url: '/messages',
        payload: {
          conversation_id: '00000000-0000-0000-0000-000000000000',
          message: 'hi',
          model: 'claude-sonnet-4-5',
        },
        headers: { authorization: 'Bearer test-jwt-token' },
      });

      // Must be 404, not 500, and must be JSON (SSE headers not sent yet)
      expect(r.statusCode).toBe(404);
      expect(r.headers['content-type']).toContain('application/json');
      expect(r.json()).toMatchObject({ error: 'conversation not found' });

      // runAgentTurn must NOT have been called
      expect(runAgentTurn).not.toHaveBeenCalled();
    });
  });
});
