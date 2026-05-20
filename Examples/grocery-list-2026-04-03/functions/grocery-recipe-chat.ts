/**
 * Butterbase serverless function: AI recipe assistant (OpenAI).
 * Deploy: MCP `deploy_function` — set env OPENAI_API_KEY (never commit).
 * Runtime calls: handler(request, ctx) with ctx.db.query, ctx.env, ctx.user
 */
/** Deployed via MCP `deploy_function` (name: `grocery-recipe-chat`). */
export async function handler(request: Request, ctx: {
  db: {
    query: (
      sql: string,
      params?: unknown[]
    ) => Promise<{ rows: Record<string, unknown>[] }>;
  };
  env: Record<string, string>;
  user: { id: string } | null;
}): Promise<Response> {
  const jsonHeaders = { 'Content-Type': 'application/json' };

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: jsonHeaders,
    });
  }

  if (!ctx.user?.id) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: jsonHeaders,
    });
  }

  // Prefer encrypted env var; fall back to inline key for local dev where envVars decryption may not work
  const apiKey = ctx.env?.OPENAI_API_KEY;

  let body: { messages?: { role: string; content: string }[] };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: jsonHeaders,
    });
  }

  const clientMessages = Array.isArray(body.messages) ? body.messages : [];
  const trimmed = clientMessages
    .filter(
      (m) =>
        m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string'
    )
    .slice(-20);

  const { rows } = await ctx.db.query(
    `SELECT title, description, completed FROM grocery_items WHERE user_id = $1::uuid ORDER BY created_at ASC`,
    [ctx.user.id]
  );

  const listText =
    rows.length > 0
      ? rows
          .map((r, i) => {
            const title = String(r.title ?? '');
            const desc = r.description ? ` — ${r.description}` : '';
            const status = r.completed ? 'have / done' : 'still need';
            return `${i + 1}. ${title} (${status})${desc}`;
          })
          .join('\n')
      : '(empty list — suggest a simple meal and what to shop for)';

  const systemPrompt = `You are a helpful cooking assistant. The user is using a grocery list app.

Their current items:
${listText}

Rules:
- Use this list as ground truth. "still need" items are on their shopping list; "have / done" may already be at home.
- Suggest additional ingredients to complete a dish or full meal when helpful, and give a practical recipe: ingredients, numbered steps, rough servings or timing where helpful.
- Structure your answer with markdown: use ## for section titles like "## Suggested additions", "## Recipe", "## Steps".
- If the list is empty, still offer meal ideas and what to buy.
- Keep food safety reasonable (cooking temperatures, leftovers).`;

  const openaiMessages = [
    { role: 'system', content: systemPrompt },
    ...trimmed.map((m) => ({ role: m.role, content: m.content })),
  ];

  const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: openaiMessages,
      temperature: 0.7,
      max_tokens: 2000,
    }),
  });

  if (!openaiRes.ok) {
    const errText = await openaiRes.text();
    return new Response(
      JSON.stringify({
        error: 'OpenAI request failed',
        details: errText.slice(0, 800),
      }),
      { status: 502, headers: jsonHeaders }
    );
  }

  const data = (await openaiRes.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const reply = data.choices?.[0]?.message?.content ?? '';

  return new Response(JSON.stringify({ reply }), {
    status: 200,
    headers: jsonHeaders,
  });
}
