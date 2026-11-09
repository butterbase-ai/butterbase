// services/docs/src/integrations/llms-generator.ts
import type { AstroIntegration } from 'astro';
import { load } from 'js-yaml';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Types ────────────────────────────────────────────────────────────────────

type SidebarItem = { label: string; slug: string; translations?: Record<string, string> };
type SidebarGroup =
  | { label: string; translations?: Record<string, string>; items: SidebarItem[] }
  | { label: string; translations?: Record<string, string>; autogenerate: { directory: string } };

export type Sidebar = SidebarGroup[];

interface ResolvedItem {
  group: string;
  label: string;
  slug: string;
  filePath: string;
}

// ── Utilities ────────────────────────────────────────────────────────────────

/** Read frontmatter as YAML so publication checks match Astro's schema. */
function frontmatter(content: string): { data: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { data: {}, body: content };
  const parsed = load(match[1]);
  return {
    data: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {},
    body: content.slice(match[0].length).trimStart(),
  };
}

export function stripFrontmatter(content: string): string {
  return frontmatter(content).body;
}

function isPublished(filePath: string): boolean {
  return frontmatter(readFileSync(filePath, 'utf8')).data.draft !== true;
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

        if (isPublished(filePath)) {
          items.push({ group: group.label, label: item.label, slug: item.slug, filePath });
        }
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

        const data = frontmatter(raw).data;
        if (data.draft === true) continue;
        const label = typeof data.title === 'string' ? data.title : file.replace(/\.mdx?$/, '');
        const slug = `${group.autogenerate.directory}/${file.replace(/\.mdx?$/, '')}`;
        items.push({ group: group.label, label, slug, filePath });
      }
    }
  }

  return items;
}

/** Resolve only genuinely translated pages; never label English fallback as Japanese. */
export function localizeSidebar(sidebar: Sidebar, docsDir: string, locale: string): Sidebar {
  return sidebar.flatMap<SidebarGroup>(group => {
    const label = group.translations?.[locale] ?? group.label;
    if ('items' in group) {
      const items = group.items.flatMap(item => {
        const slug = `${locale}/${item.slug}`;
        if (!existsSync(join(docsDir, `${slug}.md`)) && !existsSync(join(docsDir, `${slug}.mdx`))) return [];
        return [{ label: item.translations?.[locale] ?? item.label, slug }];
      });
      return items.length ? [{ label, items }] : [];
    }
    const directory = `${locale}/${group.autogenerate.directory}`;
    return existsSync(join(docsDir, directory)) ? [{ label, autogenerate: { directory } }] : [];
  });
}

// ── File generators ──────────────────────────────────────────────────────────

export function generateLlmsFullTxt(items: ResolvedItem[], siteUrl: string, locale?: string): string {
  const today = new Date().toISOString().slice(0, 10);

  const header = [
    locale === 'ja' ? '# Butterbase 日本語ドキュメント' : '# Butterbase Documentation — Full Content',
    '',
    locale === 'ja' ? '> 日本語で提供しているButterbaseの文書を、LLMが読める形でまとめています。' : '> Complete documentation for Butterbase, concatenated for LLM consumption.',
    locale === 'ja' ? `> 出典：${siteUrl}/ja/ | 生成日：${today}` : `> Source: ${siteUrl} | Generated: ${today}`,
    locale === 'ja' ? '> リンクの一覧は /ja/llms.txt を参照してください。' : '> For the index of links, see /llms.txt',
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

export function generateLlmsTxt(items: ResolvedItem[], siteUrl: string, locale?: string): string {
  // Group items by sidebar group, preserving order
  const groups = new Map<string, ResolvedItem[]>();
  for (const item of items) {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group)!.push(item);
  }

  const preamble = [
    locale === 'ja' ? '# Butterbase 日本語ドキュメント' : '# Butterbase Docs',
    '',
    locale === 'ja' ? '> Butterbaseは、AIを使うアプリのためのバックエンドです。' : '> Butterbase is an AI-native backend platform for building full-stack apps quickly.',
    locale === 'ja' ? '> AIエージェントが正しい文書を見つけるための一覧です。' : '> This file helps LLM/AI agents discover canonical documentation for accurate answers.',
    '',
    locale === 'ja' ? '## 文書のURL' : '## Canonical URLs',
    '',
    locale === 'ja' ? `- 文書の入口：${siteUrl}/ja/` : `- Docs home: ${siteUrl}/`,
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
    locale === 'ja' ? '## エージェント向けの案内' : '## Agent Guidance',
    '',
    locale === 'ja' ? '- ツールの使い方や製品の挙動は、上記の文書で確認してください。' : '- For tool usage and product behavior, prefer docs pages above over assumptions.',
    locale === 'ja' ? '- 製品全体の質問に答える前に、サイトマップで文書の範囲を確認してください。' : '- For latest coverage, crawl the sitemap before answering broad product questions.',
  ].join('\n');

  return [preamble, ...sections, footer].join('\n\n');
}

// ── Astro integration ────────────────────────────────────────────────────────

export function llmsGenerator(options: { sidebar: Sidebar; locales?: string[] }): AstroIntegration {
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
        for (const locale of options.locales ?? []) {
          const translated = resolveSidebarItems(localizeSidebar(options.sidebar, docsDir, locale), docsDir);
          const outputDir = join(publicDir, locale);
          mkdirSync(outputDir, { recursive: true });
          writeFileSync(join(outputDir, 'llms.txt'), generateLlmsTxt(translated, siteUrl, locale), 'utf8');
          writeFileSync(join(outputDir, 'llms-full.txt'), generateLlmsFullTxt(translated, siteUrl, locale), 'utf8');
          logger.info(`Generated ${locale} LLM documentation (${translated.length} translated sections)`);
        }
      },
    },
  };
}
