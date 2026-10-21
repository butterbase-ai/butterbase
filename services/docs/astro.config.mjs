import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { sidebar } from './src/docs-sidebar.ts';
import { llmsGenerator } from './src/integrations/llms-generator.ts';

export default defineConfig({
  // Pages that moved. Kept so external links and search results don't 404.
  redirects: {
    '/guides/clone-from-template': '/templates/cloning',
    '/core-concepts/staging': '/core-concepts/preview-deployments',
    '/ja/guides/clone-from-template': '/ja/templates/cloning',
    '/ja/core-concepts/staging': '/ja/core-concepts/preview-deployments',
    '/ja/roadmap': '/ja/changelog',
  },
  // Don't set `site` here: Starlight auto-enables @astrojs/sitemap when `site` is set,
  // and that can pull a Zod + sitemap version combo that breaks `astro build` in CI/Docker.
  // Our `llms` integration still defaults the canonical public URL in generated llms files.
  integrations: [
    starlight({
      title: 'Butterbase',
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        ja: { label: '日本語', lang: 'ja' },
      },
      logo: {
        src: './src/assets/logo-white.png',
        replacesTitle: true,
      },
      favicon: '/favicon.ico',
      customCss: ['./src/styles/custom.css'],
      components: {
        Header: './src/components/Header.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
      },
      expressiveCode: {
        // Astro glob-loader URLs may be source-file URLs rather than page routes.
        getBlockLocale: ({ file }) =>
          /(?:^|\/)ja\//.test(file.url?.pathname ?? file.path) ? 'ja' : 'en',
      },
      sidebar,
    }),
    llmsGenerator({ sidebar, locales: ['ja'] }),
  ],
});
