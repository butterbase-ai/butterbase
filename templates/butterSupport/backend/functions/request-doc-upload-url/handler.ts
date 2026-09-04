function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

const ALLOWED_CONTENT_TYPES = new Set([
  "application/pdf",
  "text/markdown",
  "text/plain",
  "text/html",
  "text/csv",
  "application/json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation"
]);

export default async function handler(req, ctx) {
  if (!ctx.user) return json({ error: "unauthorized" }, 401);

  const adm = await ctx.db.query(
    "SELECT 1 FROM memberships WHERE user_id = $1 AND role IN ('owner','admin')",
    [ctx.user.id]
  );
  if (adm.rows.length === 0) return json({ error: "forbidden", reason: "admin_only" }, 403);

  let body;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const { filename, content_type, size_bytes } = body || {};
  if (!filename || !content_type || !size_bytes) return json({ error: "missing_fields" }, 400);

  if (!ALLOWED_CONTENT_TYPES.has(content_type)) {
    return json({ error: "content_type_not_allowed", allowed: Array.from(ALLOWED_CONTENT_TYPES) }, 415);
  }
  if (Number(size_bytes) > 10 * 1024 * 1024) {
    return json({ error: "file_too_large", max_bytes: 10 * 1024 * 1024 }, 413);
  }

  const r = await fetch(`${ctx.env.BUTTERBASE_API_URL}/storage/${ctx.env.BUTTERBASE_APP_ID}/upload`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ctx.env.BUTTERBASE_API_KEY}`
    },
    body: JSON.stringify({ filename, contentType: content_type, sizeBytes: Number(size_bytes) })
  });
  if (!r.ok) {
    const errText = await r.text();
    return json({ error: "storage_api_error", status: r.status, message: errText }, 502);
  }
  const upload = await r.json();

  return json({
    ok: true,
    upload_url: upload.uploadUrl,
    object_id: upload.objectId,
    expires_in_seconds: upload.expiresIn,
    next: "After PUTing the file, call ingest-docs with source_kind=uploaded_file + object_id."
  });
}

