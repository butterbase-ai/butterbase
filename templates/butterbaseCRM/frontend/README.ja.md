# React・TypeScript・Vite

[English](README.md) | 日本語

ReactをViteのHMRとESLintで開発するフロントエンドです。[アプリ全体の導入](../QUICKSTART.ja.md)も参照してください。

ログイン画面と上部の言語欄で「日本語」を選べます。初期値は英語で、選択はブラウザーへ保存します。切り替えてもフォームの入力は保持します。利用者が入力した名前・文面、API値やサーバーのエラーを翻訳しません。

公式プラグインには、[Oxc](https://oxc.rs)を使う[@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react)と、[SWC](https://swc.rs/)を使う[@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc)があります。

## React Compiler

開発・ビルド性能への影響を考え、このテンプレートでは有効にしていません。追加する場合は[Reactの導入手順](https://react.dev/learn/react-compiler/installation)を参照してください。

## ESLintの拡張

本番用の開発では、型情報を使うルールを有効にできます。原文の設定例です。

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

React向けに[eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x)と[eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom)も追加できます。

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
