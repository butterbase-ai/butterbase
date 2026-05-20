import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

const SITE_ORIGIN = 'https://docs.butterbase.ai';

function normalizePath(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  if (!trimmed) {
    return '/';
  }
  return `/${trimmed}/`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatLastModified(
  dateValue: Date | string | undefined
): string | undefined {
  if (!dateValue) return undefined;
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

export const GET: APIRoute = async () => {
  const docs = await getCollection('docs');

  const entries = docs
    .filter((entry) => !entry.data.draft)
    .map((entry) => {
      const path = normalizePath(entry.slug || entry.id.replace(/\.(md|mdx)$/i, ''));
      const lastmod = formatLastModified(
        entry.data.lastUpdated as Date | string | undefined
      );
      return {
        loc: `${SITE_ORIGIN}${path}`,
        lastmod,
      };
    })
    .sort((a, b) => a.loc.localeCompare(b.loc));

  const urls = [
    {
      loc: `${SITE_ORIGIN}/`,
      lastmod: undefined,
    },
    ...entries,
  ];

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map((url) => `  <url>
    <loc>${escapeXml(url.loc)}</loc>${url.lastmod ? `
    <lastmod>${escapeXml(url.lastmod)}</lastmod>` : ''}
  </url>`)
  .join('\n')}
</urlset>`;

  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
