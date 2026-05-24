import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';
import { stripFrontmatter } from '../../integrations/llms-generator';

export const getStaticPaths: GetStaticPaths = async () => {
  const entries = await getCollection('docs');
  return entries.map((entry) => ({
    params: { slug: entry.id.replace(/\.(md|mdx)$/, '') },
    props: { body: entry.body ?? '' },
  }));
};

export const GET: APIRoute = ({ props }) => {
  const body = stripFrontmatter((props as { body: string }).body).trimStart();
  return new Response(body, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
};
