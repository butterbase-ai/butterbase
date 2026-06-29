export function normalizeLinkedinUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`Invalid URL: ${raw}`); }
  const host = u.hostname.toLowerCase();
  if (!host.endsWith('linkedin.com')) throw new Error(`Not a LinkedIn URL: ${raw}`);
  let path = u.pathname.toLowerCase();
  if (!path.startsWith('/in/')) throw new Error(`Not a LinkedIn profile URL: ${raw}`);
  if (path.endsWith('/')) path = path.slice(0, -1);
  return `https://www.linkedin.com${path}`;
}
