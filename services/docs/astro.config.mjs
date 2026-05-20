import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { sidebar } from './src/docs-sidebar.ts';
import { llmsGenerator } from './src/integrations/llms-generator.ts';

export default defineConfig({
  // Don't set `site` here: Starlight auto-enables @astrojs/sitemap when `site` is set,
  // and that can pull a Zod + sitemap version combo that breaks `astro build` in CI/Docker.
  // Our `llms` integration still defaults the canonical public URL in generated llms files.
  integrations: [
    starlight({
      title: 'Butterbase',
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
      sidebar,
    }),
    llmsGenerator({ sidebar }),
  ],
});
