function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

async function ragDeleteDoc(ctx, documentId) {
  const url = `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/rag/collections/${ctx.env.RAG_COLLECTION}/documents/${documentId}`;
  const r = await fetch(url, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${ctx.env.BUTTERBASE_API_KEY}` }
  });
  if (!r.ok && r.status !== 404) {
    const txt = await r.text().catch(() => "");
    throw new Error(`RAG delete ${documentId} ${r.status}: ${txt.slice(0, 300)}`);
  }
  return r.ok || r.status === 404;
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
  const { source_id } = body || {};
  if (!source_id) return json({ error: "missing_source_id" }, 400);

  const src = await ctx.db.query(
    "SELECT id, url, source_kind, rag_document_ids FROM docs_sources WHERE id = $1",
    [source_id]
  );
  if (src.rows.length === 0) return json({ error: "not_found" }, 404);

  // F2: precise delete of the tracked RAG documents.
  const docIds = Array.isArray(src.rows[0].rag_document_ids) ? src.rows[0].rag_document_ids : [];
  const deletedDocs = [];
  const failedDocs = [];
  for (const docId of docIds) {
    try {
      await ragDeleteDoc(ctx, docId);
      deletedDocs.push(docId);
    } catch (err) {
      console.error("delete-docs-source: rag delete failed", docId, err?.message);
      failedDocs.push({ doc_id: docId, error: err?.message });
    }
  }

  await ctx.db.query("DELETE FROM docs_sources WHERE id = $1", [source_id]);

  await ctx.db.query(
    `INSERT INTO activities (actor_user_id, kind, entity_type, entity_id, payload)
     VALUES ($1, 'docs_source.deleted', 'docs_source', $2::text, $3)`,
    [
      ctx.user.id,
      source_id,
      JSON.stringify({
        url: src.rows[0].url,
        source_kind: src.rows[0].source_kind,
        rag_docs_deleted: deletedDocs.length,
        rag_docs_failed: failedDocs.length,
        ...(failedDocs.length ? { failed: failedDocs } : {})
      })
    ]
  );

  return json({
    ok: true,
    source_id,
    rag_documents_deleted: deletedDocs.length,
    rag_documents_failed: failedDocs.length,
    ...(failedDocs.length ? { failures: failedDocs } : {})
  });
}

