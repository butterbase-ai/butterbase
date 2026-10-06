import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig(({ mode }) => {
  const isWidget = mode === 'widget';

  const sharedAlias = {
    '@': resolve(__dirname, 'src'),
    'node:crypto': resolve(__dirname, 'src/shims/node-crypto.ts'),
  };

  if (isWidget) {
    return {
      plugins: [react()],
      resolve: { alias: sharedAlias },
      build: {
        emptyOutDir: false,
        cssCodeSplit: false,
        rollupOptions: {
          input: resolve(__dirname, 'src/widget/main.tsx'),
          output: {
            format: 'iife',
            inlineDynamicImports: true,
            entryFileNames: 'widget.js',
            assetFileNames: (asset) =>
              asset.name && asset.name.endsWith('.css') ? 'widget.css' : 'assets/[name]-[hash][extname]',
          },
        },
      },
    };
  }

  // Console (default + 'console' mode)
  return {
    plugins: [react()],
    resolve: { alias: sharedAlias },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'index.html'),
        output: {
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  };
});
