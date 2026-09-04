// backend/functions/lead-cost-preview/handler.ts
// Butterbase People API pricing (observed live, 2026-06-30).
// Search w/ enrichProfiles=true is ~4 credits/result, already paid at search time.
// Email reveal: 3 credits to queue + 1 credit on resolve = 4 credits per email.
const SEARCH_CREDIT = 0;       // already paid during search; not double-charged here
const EMAIL_CREDIT = 4;        // queue (3) + resolve (1)
const USD_PER_CREDIT = 0.02016;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export async function handler(req: Request, ctx: any) {
  if (!ctx.user) return json(401, { error: 'unauthorized' });

  let body: any;
  try { body = await req.json(); } catch { body = {}; }

  const ids: string[] = Array.isArray(body?.result_ids) ? body.result_ids.filter((s: any) => typeof s === 'string') : [];
  const reveal = !!body?.reveal_emails;
  const n = ids.length;
  if (n === 0) return json(400, { error: 'no_results_selected' });

  const credits = reveal ? n * EMAIL_CREDIT : n * SEARCH_CREDIT;
  const usd = +(credits * USD_PER_CREDIT).toFixed(4);

  return json(200, {
    credits,
    usd_estimate: usd,
    reveal_emails: reveal,
    per_unit: {
      search_credit: SEARCH_CREDIT,
      email_credit: EMAIL_CREDIT,
      usd_per_credit: USD_PER_CREDIT,
    },
  });
}

