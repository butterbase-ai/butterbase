/**
 * Turn an MCP client's self-declared `client_name` into UTM params for the
 * consent redirect, so a signup that starts inside Cursor / Claude Code / Qoder
 * is attributable instead of landing as signup_source = NULL.
 *
 * Without this, MCP-originated signups carry no attribution at all: the
 * /oauth/authorize redirect hands the dashboard only `?st=<state>`, so the
 * first-touch capture in the dashboard's main.tsx finds no utm_* params, and
 * document.referrer is our own API host rather than a real source.
 *
 * SECURITY — `client_name` is attacker-controlled. Anyone may POST
 * /oauth/register with any name (RFC 7591 registration is open, and we don't
 * verify it). That string would otherwise flow:
 *
 *     client_name -> URL query param -> dashboard localStorage
 *                 -> X-Signup-Source request header -> platform_users
 *
 * so it is slugified down to [a-z0-9-] here rather than anywhere downstream.
 * That single rule removes CR/LF (header injection), quotes and angle brackets
 * (injection into admin UI that renders the value), and '&' / '=' (forging
 * extra UTM keys inside the composed source string the dashboard builds).
 * The length cap bounds the eventual header — the control API slices incoming
 * attribution headers at 2048, and an over-long value could otherwise push a
 * request past the server's header limit and 431 the user mid-signup.
 */

/** Keep well under the 2048-byte header budget; DCR allows names up to 200. */
const MAX_SLUG_LEN = 40;

/** Marks these signups as coming through the MCP OAuth flow. */
export const MCP_UTM_MEDIUM = 'mcp';
export const MCP_UTM_CAMPAIGN = 'mcp-oauth';

/** Prefix on utm_source so MCP clients group together and cannot collide with
 *  a marketing source that happens to share a name. */
const SOURCE_PREFIX = 'mcp-';

/**
 * Lowercase, collapse every non-alphanumeric run to a single '-', trim, cap.
 * Returns null when nothing usable survives (a name of only punctuation, an
 * empty name, or a client that registered without one) — the caller then omits
 * the params entirely rather than emitting a bare `mcp-`.
 */
export function slugifyClientName(clientName: string | null | undefined): string | null {
  if (!clientName) return null;
  const slug = clientName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LEN)
    // Slicing can leave a trailing '-' behind; strip it again.
    .replace(/-+$/g, '');
  return slug === '' ? null : slug;
}

export interface McpAttributionParams {
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
}

/**
 * UTM params for a consent redirect, or null when the client name yields no
 * usable slug. Null means "add nothing" — an untagged signup is strictly better
 * than a garbage source that pollutes the attribution report.
 */
export function mcpAttributionParams(
  clientName: string | null | undefined,
): McpAttributionParams | null {
  const slug = slugifyClientName(clientName);
  if (!slug) return null;
  return {
    utm_source: `${SOURCE_PREFIX}${slug}`,
    utm_medium: MCP_UTM_MEDIUM,
    utm_campaign: MCP_UTM_CAMPAIGN,
  };
}
