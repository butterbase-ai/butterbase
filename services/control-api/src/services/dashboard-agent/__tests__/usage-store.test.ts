import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { recordUsage, listUsage } from '../usage-store'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const runIf = TEST_DATABASE_URL ? describe : describe.skip

runIf('usage-store', () => {
  let pool: pg.Pool
  let conversationId = ''
  const userId = `u-${Math.floor(Math.random() * 1e9)}`

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL })
    const conv = await pool.query(
      `INSERT INTO dashboard_agent_conversations (user_id, title, model) VALUES ($1,$2,$3) RETURNING id`,
      [userId, 't', 'anthropic/claude-haiku-4.5'],
    )
    conversationId = conv.rows[0].id
  })
  afterAll(async () => { await pool.end() })

  it('records and lists usage rows', async () => {
    await recordUsage(pool, {
      userId, conversationId,
      model: 'anthropic/claude-haiku-4.5',
      promptTokens: 100, completionTokens: 50,
      toolCallsCount: 2, fileWritesCount: 3, deploymentsCount: 0,
    })
    const rows = await listUsage(pool, { userId })
    expect(rows.length).toBeGreaterThan(0)
    const row = rows.find(r => r.conversationId === conversationId)!
    expect(row.promptTokens).toBe(100)
    expect(row.fileWritesCount).toBe(3)
  })
})
