import type pg from 'pg'

export type UsageRow = {
  userId: string
  conversationId: string
  model: string
  promptTokens: number
  completionTokens: number
  toolCallsCount: number
  fileWritesCount: number
  deploymentsCount: number
}

export async function recordUsage(pool: pg.Pool, row: UsageRow): Promise<void> {
  await pool.query(
    `INSERT INTO dashboard_agent_usage
       (user_id, conversation_id, model, prompt_tokens, completion_tokens,
        tool_calls_count, file_writes_count, deployments_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      row.userId, row.conversationId, row.model,
      row.promptTokens, row.completionTokens,
      row.toolCallsCount, row.fileWritesCount, row.deploymentsCount,
    ],
  )
}

export async function listUsage(
  pool: pg.Pool,
  filter: { userId?: string; conversationId?: string },
): Promise<Array<UsageRow & { createdAt: Date }>> {
  const conds: string[] = []
  const args: unknown[] = []
  if (filter.userId) { args.push(filter.userId); conds.push(`user_id = $${args.length}`) }
  if (filter.conversationId) { args.push(filter.conversationId); conds.push(`conversation_id = $${args.length}`) }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const { rows } = await pool.query(
    `SELECT user_id, conversation_id, model, prompt_tokens, completion_tokens,
            tool_calls_count, file_writes_count, deployments_count, created_at
     FROM dashboard_agent_usage ${where}
     ORDER BY created_at DESC LIMIT 200`,
    args,
  )
  return rows.map(r => ({
    userId: r.user_id,
    conversationId: r.conversation_id,
    model: r.model,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    toolCallsCount: r.tool_calls_count,
    fileWritesCount: r.file_writes_count,
    deploymentsCount: r.deployments_count,
    createdAt: r.created_at,
  }))
}
