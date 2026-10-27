import type { ApprovalReference, ApprovalReferenceKind } from './approvals-store.js';

/**
 * Evidence for an approval, derived from the turn’s own tool results.
 *
 * Conservative by construction: only a small set of read tools and their
 * documented result containers are read, only human label fields are used, and
 * anything that looks like an id is dropped. An unknown tool contributes
 * nothing — never a guessed label, never raw JSON.
 */
const READ_ACTIONS: Record<string, ReadonlySet<string>> = {
  manage_substrate: new Set([
    'find_entities',
    'get_entity',
    'list_source_artifacts',
    'get_source_artifact',
    'search_memory',
    'list_memory',
  ]),
  manage_storage: new Set(['list', 'get']),
  manage_app: new Set(['list', 'get']),
  manage_repo: new Set(['pull_latest', 'pull_snapshot']),
  manage_schema: new Set(['get']),
};

const CONTAINERS: Array<{ key: string; kind: ApprovalReferenceKind }> = [
  { key: 'entities', kind: 'entity' },
  { key: 'source_artifacts', kind: 'artifact' },
  { key: 'results', kind: 'record' },
  { key: 'objects', kind: 'file' },
  { key: 'apps', kind: 'app' },
  { key: 'files', kind: 'file' },
];

const LABEL_FIELDS = ['display_name', 'title', 'filename', 'name', 'path', 'subject', 'key', 'label'];
const ID_FIELDS = ['id', 'entity_id', 'artifact_id', 'objectId', 'object_id', 'app_id', 'appId', 'path', 'key'];
const DETAIL_FIELDS = ['type', 'kind', 'content_type', 'subdomain'];

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function first(item: Record<string, unknown>, fields: string[]): string | null {
  for (const field of fields) {
    const value = text(item[field]);
    if (value) return value;
  }
  return null;
}

/** A label that is actually an id is not evidence a person can read. */
function looksLikeId(value: string): boolean {
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    || /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value)
    || /^(ent|art|dec|obj|app|snap|mem|rule|obx|pcf)_[A-Za-z0-9]+$/.test(value)
  );
}

function toReference(item: Record<string, unknown>, kind: ApprovalReferenceKind): ApprovalReference | null {
  const label = first(item, LABEL_FIELDS);
  if (!label || looksLikeId(label)) return null;
  const id = first(item, ID_FIELDS);
  const detail = first(item, DETAIL_FIELDS);
  return {
    kind,
    ...(id ? { id } : {}),
    label,
    ...(detail ? { detail } : {}),
  };
}

function refsFromValue(value: unknown, kind: ApprovalReferenceKind): ApprovalReference[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const ref = toReference(item as Record<string, unknown>, kind);
      return ref ? [ref] : [];
    });
  }
  if (value && typeof value === 'object') {
    const ref = toReference(value as Record<string, unknown>, kind);
    return ref ? [ref] : [];
  }
  return [];
}

function refsFromTables(value: unknown): ApprovalReference[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>)
    .filter((table) => !looksLikeId(table))
    .map((table) => ({ kind: 'record' as const, id: table, label: table }));
}

function singleKind(toolName: string, action: string): ApprovalReferenceKind | null {
  if (toolName === 'manage_substrate' && action === 'get_entity') return 'entity';
  if (toolName === 'manage_substrate' && action === 'get_source_artifact') return 'artifact';
  if (toolName === 'manage_storage' && action === 'get') return 'file';
  if (toolName === 'manage_app' && action === 'get') return 'app';
  if (toolName === 'manage_schema' && action === 'get') return 'record';
  return null;
}

export function referencesForApproval(input: {
  toolName: string;
  toolArgs: unknown;
  toolCalls: Array<{ id: string; name: string; args: unknown }>;
  toolResults: Array<{ id: string; result?: unknown; error?: string }>;
}): ApprovalReference[] {
  const resultById = new Map(input.toolResults.map((entry) => [entry.id, entry]));
  const candidates: ApprovalReference[] = [];

  // Newest first: the evidence nearest the decision is the most relevant.
  for (const call of [...input.toolCalls].reverse()) {
    const entry = resultById.get(call.id);
    if (!entry || entry.error || entry.result === undefined) continue;

    const args =
      call.args && typeof call.args === 'object' && !Array.isArray(call.args)
        ? (call.args as Record<string, unknown>)
        : null;
    const action = text(args?.action) ?? '';
    const allowed = READ_ACTIONS[call.name];
    if (!allowed || !allowed.has(action)) continue;

    const result =
      entry.result && typeof entry.result === 'object' && !Array.isArray(entry.result)
        ? (entry.result as Record<string, unknown>)
        : null;
    if (!result) continue;

    for (const container of CONTAINERS) {
      candidates.push(...refsFromValue(result[container.key], container.kind));
    }
    candidates.push(...refsFromTables(result.tables));

    const kind = singleKind(call.name, action);
    if (kind) {
      const direct = toReference(result, kind);
      if (direct) candidates.push(direct);
    }
  }

  const seen = new Set<string>();
  return candidates
    .filter((ref) => {
      const key = `${ref.kind}:${ref.id ?? ref.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
}
