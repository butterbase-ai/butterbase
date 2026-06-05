// Cloudflare Pages-compatible `_redirects` parser.
//
// Supports the common subset:
//   - Comments (lines starting with `#`)
//   - Blank lines
//   - `<from> <to> [status]` (default status: 301)
//   - Splat patterns: `from` may end with `/*`, `to` may reference `:splat`
//   - Status codes: 200 (rewrite), 301/302/303/307/308 (redirect)
//
// Not yet supported (defer to v2 if a customer asks):
//   - Named placeholders (`:id`)
//   - Query/header matchers (`status=200 country=US`)
//   - Force matching with `!`
//
// Invalid lines are skipped with a warning rather than failing the parse —
// a malformed rule should not bring down the deploy.

export interface RedirectRule {
  from: string;
  to: string;
  status: number;
}

export interface ParsedRedirects {
  rules: RedirectRule[];
  warnings: string[];
}

const VALID_STATUSES = new Set([200, 301, 302, 303, 307, 308]);
const DEFAULT_STATUS = 301;

export function parseRedirects(text: string): ParsedRedirects {
  const rules: RedirectRule[] = [];
  const warnings: string[] = [];

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const raw = lines[i];
    const line = raw.replace(/#.*$/, '').trim();
    if (line.length === 0) continue;

    const tokens = line.split(/\s+/);
    if (tokens.length < 2) {
      warnings.push(`line ${lineNumber}: expected at least 2 tokens, got ${tokens.length}`);
      continue;
    }
    const [from, to, statusToken] = tokens;

    let status = DEFAULT_STATUS;
    if (statusToken !== undefined) {
      // Some advanced syntax uses `key=value` (e.g. `status=200`). Reject those
      // explicitly so we don't silently treat them as a literal status code.
      if (statusToken.includes('=')) {
        warnings.push(
          `line ${lineNumber}: query/header matchers (\`${statusToken}\`) not supported, rule skipped`,
        );
        continue;
      }
      const parsed = Number.parseInt(statusToken, 10);
      if (Number.isNaN(parsed) || !VALID_STATUSES.has(parsed)) {
        warnings.push(`line ${lineNumber}: invalid status code \`${statusToken}\`, rule skipped`);
        continue;
      }
      status = parsed;
    }

    if (!from.startsWith('/')) {
      warnings.push(`line ${lineNumber}: \`from\` must start with /, got \`${from}\`, rule skipped`);
      continue;
    }
    if (from.includes(':') && !from.endsWith('/*')) {
      // We don't support named placeholders yet. Splat-only is fine.
      warnings.push(
        `line ${lineNumber}: named placeholders (\`${from}\`) not supported, rule skipped`,
      );
      continue;
    }

    rules.push({ from, to, status });
  }

  return { rules, warnings };
}

/**
 * Match a request path against a rule's `from` pattern. Returns null on no
 * match, or the resolved `to` (with `:splat` substituted) on match.
 */
export function matchRule(path: string, rule: RedirectRule): string | null {
  if (rule.from.endsWith('/*')) {
    const prefix = rule.from.slice(0, -2); // strip /*
    // Match the prefix at the start of the path. The captured suffix is
    // everything after the prefix's trailing slash boundary.
    if (path === prefix || path.startsWith(prefix + '/') || prefix === '') {
      let splat: string;
      if (prefix === '') {
        // `/*` matches everything; splat is the path minus leading /.
        splat = path.replace(/^\/+/, '');
      } else if (path === prefix) {
        splat = '';
      } else {
        splat = path.slice(prefix.length + 1); // drop the boundary slash
      }
      return rule.to.replace(/:splat/g, splat);
    }
    return null;
  }
  return path === rule.from ? rule.to : null;
}

/**
 * Find the FIRST matching rule for a path. Cloudflare Pages applies first-match
 * semantics — order in the file matters.
 */
export function findMatchingRule(
  path: string,
  rules: RedirectRule[],
): { rule: RedirectRule; resolvedTo: string } | null {
  for (const rule of rules) {
    const resolvedTo = matchRule(path, rule);
    if (resolvedTo !== null) return { rule, resolvedTo };
  }
  return null;
}
