// F3: multi-page crawl. Same-domain BFS up to max_depth (default 2),
// page cap to bound function runtime, sitemap.xml support. No robots.txt
// honoring yet (intentional cut — most help centers don't block these UAs;
// add when we hit a host that does).

const DEFAULT_MAX_DEPTH = 2;
const HARD_PAGE_CAP = 30;       // safety net so a runaway crawl can't exhaust the function budget
const PER_PAGE_TIMEOUT_MS = 15_000;
const USER_AGENT = "ButterSupport-Crawler/1.0 (+https://github.com/your-org/butter-support)";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

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

// Pull href attrs out of anchors. Crude but adequate for help-center markup;
// we don't need a real HTML parser since we only act on absolute/relative URLs.
function extractLinks(html, baseUrl) {
  const out = [];
  const re = /<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = (m[2] ?? m[3] ?? "").trim();
    if (!href) continue;
    try {
      const abs = new URL(href, baseUrl);
      // Strip the fragment so /a#section and /a are treated as the same page.
      abs.hash = "";
      out.push(abs.toString());
    } catch { /* malformed href */ }
  }
  return out;
}

function matches(patterns, url) {
  if (!patterns || !patterns.length) return false;
  for (const p of patterns) {
    try { if (new RegExp(p).test(url)) return true; } catch { /* bad regex — ignore */ }
  }
  return false;
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": USER_AGENT }
    });
  } finally {
    clearTimeout(t);
  }
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
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`RAG ingest failed (${r.status}): ${err}`);
  }
  return await r.json();
}

// Parse <loc>https://…</loc> entries from a sitemap.xml. Handles sitemap-index
// nesting one level deep (a sitemap that lists more sitemaps).
async function fetchSitemapUrls(sitemapUrl, depth = 0) {
  if (depth > 1) return [];
  const r = await fetchWithTimeout(sitemapUrl, PER_PAGE_TIMEOUT_MS);
  if (!r.ok) throw new Error(`sitemap fetch ${r.status}`);
  const body = await r.text();
  const isIndex = /<sitemapindex\b/i.test(body);
  const locs = Array.from(body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)).map(m => m[1]);
  if (isIndex) {
    const all = [];
    for (const child of locs.slice(0, 5)) {
      try {
        all.push(...await fetchSitemapUrls(child, depth + 1));
      } catch (e) {
        console.warn("sitemap child failed", child, e?.message);
      }
    }
    return all;
  }
  return locs;
}

// Single-page crawl + RAG ingest. Returns { documentId, ok, error?, hash? }.
async function crawlAndIngest(ctx, url, sourceId, displayName) {
  try {
    const resp = await fetchWithTimeout(url, PER_PAGE_TIMEOUT_MS);
    if (!resp.ok) return { ok: false, error: `fetch ${resp.status}`, url };
    const html = await resp.text();
    const txt = htmlToText(html);
    if (txt.length < 50) return { ok: false, error: "extracted_text_too_short", url };
    const hash = await sha256Hex(txt);
    const urlObj = new URL(url);
    const filename = `${urlObj.hostname}${urlObj.pathname}`.replace(/\/$/, "") || displayName || urlObj.hostname;
    const result = await ragIngest(ctx, {
      text: txt,
      filename,
      metadata: {
        docs_source_id: sourceId,
        url,
        content_hash: hash,
        source_kind: "web",
        crawled_at: new Date().toISOString()
      }
    });
    const docId = result?.documentId || result?.document_id || null;
    return { ok: true, documentId: docId, html, hash, url };
  } catch (err) {
    return { ok: false, error: err?.message || "unknown", url };
  }
}

export default async function handler(req, ctx) {
  if (!ctx.user) return json({ error: "unauthorized" }, 401);

  const adm = await ctx.db.query(
    "SELECT 1 FROM memberships WHERE user_id = $1 AND role IN ('owner','admin')",
    [ctx.user.id]
  );
  if (adm.rows.length === 0) return json({ error: "forbidden", reason: "admin_only" }, 403);

  let body;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const { url, source_kind, display_name, object_id, text, crawl_config } = body || {};

  if (!source_kind || !["web", "sitemap", "uploaded_file", "text"].includes(source_kind)) {
    return json({ error: "invalid_source_kind", allowed: ["web", "sitemap", "uploaded_file", "text"] }, 400);
  }

  const src = await ctx.db.query(
    `INSERT INTO docs_sources (url, source_kind, display_name, rag_collection_id, crawl_config, created_by, last_crawl_status)
     VALUES ($1, $2, $3, $4, $5, $6, 'queued')
     RETURNING id`,
    [url || null, source_kind, display_name || url || "untitled", ctx.env.RAG_COLLECTION, JSON.stringify(crawl_config || {}), ctx.user.id]
  );
  const sourceId = src.rows[0].id;

  ctx.waitUntil((async () => {
    try {
      const docIds = [];
      const failures = [];
      let chunkCount = 0;

      if (source_kind === "web") {
        if (!url) throw new Error("missing url");
        const maxDepth = Math.max(0, Math.min(5, Number(crawl_config?.max_depth ?? DEFAULT_MAX_DEPTH)));
        const includePatterns = Array.isArray(crawl_config?.include_patterns) ? crawl_config.include_patterns : [];
        const excludePatterns = Array.isArray(crawl_config?.exclude_patterns) ? crawl_config.exclude_patterns : [];
        const pageCap = Math.max(1, Math.min(HARD_PAGE_CAP, Number(crawl_config?.max_pages ?? HARD_PAGE_CAP)));

        const startUrl = new URL(url);
        const sameHost = startUrl.hostname;
        const seen = new Set();
        // BFS queue of { url, depth }
        const queue = [{ url: startUrl.toString(), depth: 0 }];
        seen.add(startUrl.toString());

        while (queue.length > 0 && chunkCount + failures.length < pageCap) {
          const { url: cur, depth } = queue.shift();
          const result = await crawlAndIngest(ctx, cur, sourceId, display_name);
          if (result.ok) {
            if (result.documentId) docIds.push(result.documentId);
            chunkCount++;
            // Discover children from THIS page's HTML — only if we still have depth budget.
            if (depth < maxDepth) {
              const links = extractLinks(result.html, cur);
              for (const link of links) {
                if (seen.size >= pageCap * 3) break; // bound the queue itself
                let linkUrl;
                try { linkUrl = new URL(link); } catch { continue; }
                if (linkUrl.hostname !== sameHost) continue;
                if (!["http:", "https:"].includes(linkUrl.protocol)) continue;
                // Skip obvious non-doc binaries.
                if (/\.(png|jpe?g|gif|svg|webp|pdf|zip|tar|gz|css|js|ico|mp4|woff2?)(\?|$)/i.test(linkUrl.pathname)) continue;
                if (excludePatterns.length && matches(excludePatterns, linkUrl.toString())) continue;
                if (includePatterns.length && !matches(includePatterns, linkUrl.toString())) continue;
                const norm = linkUrl.toString();
                if (seen.has(norm)) continue;
                seen.add(norm);
                queue.push({ url: norm, depth: depth + 1 });
              }
            }
          } else {
            failures.push({ url: result.url, error: result.error });
          }
        }
        if (chunkCount === 0) throw new Error(failures[0]?.error || "no_pages_ingested");

      } else if (source_kind === "sitemap") {
        if (!url) throw new Error("missing url");
        const sitemapUrls = await fetchSitemapUrls(url);
        if (sitemapUrls.length === 0) throw new Error("sitemap_empty");
        const pageCap = Math.max(1, Math.min(HARD_PAGE_CAP, Number(crawl_config?.max_pages ?? HARD_PAGE_CAP)));
        for (const pageUrl of sitemapUrls.slice(0, pageCap)) {
          const result = await crawlAndIngest(ctx, pageUrl, sourceId, display_name);
          if (result.ok) {
            if (result.documentId) docIds.push(result.documentId);
            chunkCount++;
          } else {
            failures.push({ url: result.url, error: result.error });
          }
        }
        if (chunkCount === 0) throw new Error(failures[0]?.error || "sitemap_no_pages_ingested");

      } else if (source_kind === "uploaded_file") {
        if (!object_id) throw new Error("missing object_id");
        const result = await ragIngest(ctx, {
          storage_object_id: object_id,
          filename: display_name || `upload-${object_id}`,
          metadata: { docs_source_id: sourceId, object_id, source_kind: "uploaded_file", uploaded_at: new Date().toISOString() }
        });
        const docId = result?.documentId || result?.document_id || null;
        if (docId) docIds.push(docId);
        chunkCount = 1;

      } else { // text
        if (!text) throw new Error("missing text");
        const hash = await sha256Hex(text);
        const result = await ragIngest(ctx, {
          text,
          filename: display_name || `text-${sourceId}`,
          metadata: { docs_source_id: sourceId, content_hash: hash, source_kind: "text", at: new Date().toISOString() }
        });
        const docId = result?.documentId || result?.document_id || null;
        if (docId) docIds.push(docId);
        chunkCount = 1;
      }

      // F2: persist every documentId we captured for precise delete later.
      await ctx.db.query(
        `UPDATE docs_sources
           SET last_crawl_at = now(),
               last_crawl_status = $1,
               chunk_count = $2,
               last_crawl_error = $3,
               rag_document_ids = CASE WHEN array_length($4::text[], 1) IS NULL THEN rag_document_ids ELSE rag_document_ids || $4::text[] END,
               updated_at = now()
           WHERE id = $5`,
        [
          failures.length === 0 ? "ingested" : "partial",
          chunkCount,
          failures.length ? `${failures.length} page(s) failed; first: ${failures[0].url} → ${failures[0].error}` : null,
          docIds,
          sourceId
        ]
      );
      console.info("ingest-docs: done", { sourceId, ingested: chunkCount, failed: failures.length });
    } catch (err) {
      console.error("ingest-docs: failed", err?.message);
      await ctx.db.query(
        `UPDATE docs_sources SET last_crawl_at = now(), last_crawl_status = 'failed', last_crawl_error = $1, updated_at = now() WHERE id = $2`,
        [err?.message || "unknown", sourceId]
      );
    }
  })());

  return json({ ok: true, source_id: sourceId, status: "queued" });
}

