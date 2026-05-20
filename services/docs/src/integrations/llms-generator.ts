// services/docs/src/integrations/llms-generator.ts
import type { AstroIntegration } from 'astro';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Types ────────────────────────────────────────────────────────────────────

type SidebarItem = { label: string; slug: string };
type SidebarGroup =
  | { label: string; items: SidebarItem[] }
  | { label: string; autogenerate: { directory: string } };

export type Sidebar = SidebarGroup[];

interface ResolvedItem {
  group: string;
  label: string;
  slug: string;
  filePath: string;
}

// ── Utilities ────────────────────────────────────────────────────────────────

/** Strip the leading ---...--- frontmatter block from markdown content. */
export function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content;
  const end = content.indexOf('---', 3);
  if (end === -1) return content; // malformed — return as-is
  return content.slice(end + 3).trimStart();
}

/** Read the `title:` field from a frontmatter block. Returns null if not found. */
function parseFrontmatterTitle(content: string): string | null {
  if (!content.startsWith('---')) return null;
  const end = content.indexOf('---', 3);
  if (end === -1) return null;
  const frontmatter = content.slice(3, end);
  const match = frontmatter.match(/^title:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

/**
 * Walk the sidebar in declared order and resolve each entry to an absolute
 * file path. Throws a hard error if a slug has no corresponding .md/.mdx file.
 * For autogenerate entries, globs the directory and sorts alphabetically.
 */
export function resolveSidebarItems(sidebar: Sidebar, docsDir: string): ResolvedItem[] {
  const items: ResolvedItem[] = [];

  for (const group of sidebar) {
    if ('items' in group) {
      for (const item of group.items) {
        const mdPath = join(docsDir, `${item.slug}.md`);
        const mdxPath = join(docsDir, `${item.slug}.mdx`);
        let filePath: string | undefined;

        if (existsSync(mdPath))       filePath = mdPath;
        else if (existsSync(mdxPath)) filePath = mdxPath;

        if (!filePath) {
          throw new Error(
            `[llms-generator] No source file found for slug "${item.slug}" ` +
            `(tried ${mdPath} and ${mdxPath})`
          );
        }

        items.push({ group: group.label, label: item.label, slug: item.slug, filePath });
      }
    } else if ('autogenerate' in group) {
      const dir = join(docsDir, group.autogenerate.directory);
      let files: string[];

      try {
        files = readdirSync(dir)
          .filter(f => f.endsWith('.md') || f.endsWith('.mdx'))
          .sort();
      } catch {
        console.warn(`[llms-generator] autogenerate directory not found: ${dir}`);
        files = [];
      }

      for (const file of files) {
        // Skip underscore-prefixed files (excluded from Starlight routing via docsLoader)
        if (file.startsWith('_')) continue;

        const filePath = join(dir, file);
        const raw = readFileSync(filePath, 'utf-8');

        // Skip draft pages
        const frontmatterEnd = raw.indexOf('---', 3);
        const isDraft = frontmatterEnd !== -1 && /^draft:\s*true\s*$/m.test(raw.slice(3, frontmatterEnd));
        if (isDraft) continue;

        // Use the frontmatter title for accuracy (handles acronyms like "AI API", "MCP Tools")
        const label = parseFrontmatterTitle(raw) ?? file.replace(/\.mdx?$/, '');
        const slug = `${group.autogenerate.directory}/${file.replace(/\.mdx?$/, '')}`;
        items.push({ group: group.label, label, slug, filePath });
      }
    }
  }

  return items;
}

// ── File generators ──────────────────────────────────────────────────────────

export function generateLlmsFullTxt(items: ResolvedItem[], siteUrl: string): string {
  const today = new Date().toISOString().slice(0, 10);

  const header = [
    '# Butterbase Documentation — Full Content',
    '',
    '> Complete documentation for Butterbase, concatenated for LLM consumption.',
    `> Source: ${siteUrl} | Generated: ${today}`,
    '> For the index of links, see /llms.txt',
  ].join('\n');

  const sections = items.map(({ group, label, filePath }) => {
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch (err) {
      // Should never happen — resolveSidebarItems already verified file existence
      throw new Error(`[llms-generator] Failed to read ${filePath}: ${err}`);
    }

    const content = stripFrontmatter(raw);
    return `## ${group} / ${label}\n\n${content.trim()}`;
  });

  return [header, ...sections].join('\n\n---\n\n');
}

export function generateLlmsTxt(items: ResolvedItem[], siteUrl: string): string {
  // Group items by sidebar group, preserving order
  const groups = new Map<string, ResolvedItem[]>();
  for (const item of items) {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group)!.push(item);
  }

  const preamble = [
    '# Butterbase Docs',
    '',
    '> Butterbase is an AI-native backend platform for building full-stack apps quickly.',
    '> This file helps LLM/AI agents discover canonical documentation for accurate answers.',
    '',
    '## Canonical URLs',
    '',
    `- Docs home: ${siteUrl}/`,
    `- Sitemap: ${siteUrl}/sitemap.xml`,
    `- Robots: ${siteUrl}/robots.txt`,
  ].join('\n');

  const sections = Array.from(groups.entries()).map(([groupLabel, groupItems]) => {
    const links = groupItems
      .map(item => `- ${item.label}: ${siteUrl}/${item.slug}/`)
      .join('\n');
    return `## ${groupLabel}\n\n${links}`;
  });

  const footer = [
    '## Agent Guidance',
    '',
    '- For tool usage and product behavior, prefer docs pages above over assumptions.',
    '- For latest coverage, crawl the sitemap before answering broad product questions.',
  ].join('\n');

  return [preamble, ...sections, footer].join('\n\n');
}

// ── Astro integration ────────────────────────────────────────────────────────

export function llmsGenerator(options: { sidebar: Sidebar }): AstroIntegration {
  return {
    name: 'llms-generator',
    hooks: {
      'astro:config:done': ({ config, logger }) => {
        const docsDir = fileURLToPath(new URL('src/content/docs/', config.root));
        const publicDir = fileURLToPath(config.publicDir);
        const siteUrl = (config.site ?? 'https://docs.butterbase.ai').replace(/\/$/, '');

        logger.info('Generating llms.txt and llms-full.txt…');

        const items = resolveSidebarItems(options.sidebar, docsDir);

        const llmsFullTxt = generateLlmsFullTxt(items, siteUrl);
        writeFileSync(join(publicDir, 'llms-full.txt'), llmsFullTxt, 'utf-8');

        const llmsTxt = generateLlmsTxt(items, siteUrl);
        writeFileSync(join(publicDir, 'llms.txt'), llmsTxt, 'utf-8');

        logger.info(`Generated llms-full.txt (${items.length} sections) and llms.txt`);
      },
    },
  };
}
