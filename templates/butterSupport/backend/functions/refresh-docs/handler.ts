function htmlToText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function ragIngest(ctx, body) {
  const url = `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/rag/collections/${ctx.env.RAG_COLLECTION}/ingest`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${ctx.env.BUTTERBASE_API_KEY}` },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`RAG ingest ${r.status}: ${await r.text()}`);
  return await r.json();
}

export default async function handler(_req, ctx) {
  const sources = await ctx.db.query(
    `SELECT id, url, display_name, crawl_config FROM docs_sources WHERE source_kind = 'web' AND url IS NOT NULL`
  );

  const results = [];
  for (const s of sources.rows) {
    try {
      const resp = await fetch(s.url, { redirect: "follow" });
      if (!resp.ok) throw new Error(`fetch ${resp.status}`);
      const html = await resp.text();
      const txt = htmlToText(html);
      if (txt.length < 50) throw new Error("extracted_text_too_short");
      const hash = await sha256Hex(txt);

      // Determine if changed: compare against stored hash in crawl_config.last_content_hash
      const prevHash = s.crawl_config?.last_content_hash;
      if (prevHash === hash) {
        await ctx.db.query(
          "UPDATE docs_sources SET last_crawl_at = now(), last_crawl_status = 'unchanged', updated_at = now() WHERE id = $1",
          [s.id]
        );
        results.push({ id: s.id, status: "unchanged" });
        continue;
      }

      // Changed: re-ingest
      await ragIngest(ctx, {
        text: txt,
        filename: s.display_name || s.url,
        metadata: { docs_source_id: s.id, url: s.url, content_hash: hash, source_kind: "web", crawled_at: new Date().toISOString() }
      });

      const newConfig = { ...(s.crawl_config || {}), last_content_hash: hash };
      await ctx.db.query(
        "UPDATE docs_sources SET last_crawl_at = now(), last_crawl_status = 'reingested', last_crawl_error = NULL, crawl_config = $1, updated_at = now() WHERE id = $2",
        [JSON.stringify(newConfig), s.id]
      );
      results.push({ id: s.id, status: "reingested" });
    } catch (err) {
      console.error("refresh-docs: source failed", s.id, err?.message);
      await ctx.db.query(
        "UPDATE docs_sources SET last_crawl_at = now(), last_crawl_status = 'failed', last_crawl_error = $1, updated_at = now() WHERE id = $2",
        [err?.message || "unknown", s.id]
      );
      results.push({ id: s.id, status: "failed", error: err?.message });
    }
  }

  console.info(`refresh-docs: processed ${results.length} sources`);
  return new Response(JSON.stringify({ ok: true, results }), {
    headers: { "Content-Type": "application/json" }
  });
}

