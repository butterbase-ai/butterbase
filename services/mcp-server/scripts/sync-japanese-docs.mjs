import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = path.resolve(packageRoot, '../..');
const sourceMap = JSON.parse(readFileSync(path.join(packageRoot, 'src/docs/japanese-sources.json'), 'utf8'));
const revision = process.argv[2];
function source(file) {
  const relative = 'services/docs/src/content/docs/ja/' + file;
  return revision ? execFileSync('git', ['show', `${revision}:${relative}`], { cwd: repoRoot, encoding: 'utf8' })
    : readFileSync(path.join(repoRoot, relative), 'utf8');
}
function clean(content, file) {
  const pageUrl = `https://docs.butterbase.ai/ja/${file.replace(/\.mdx?$/, '')}/`;
  let fenced = false;
  return content.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n').map(line => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    return fenced ? line : line.replace(/(?<!!)\[([^\]]*)\]\(([^)\s]+)([^)]*)\)/g, (match, label, target, suffix) => {
      if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('//')) return match;
      const localized = target.startsWith('/') && target !== '/ja' && !target.startsWith('/ja/')
        ? '/ja' + target : target;
      const url = new URL(localized, pageUrl);
      if (!url.pathname.endsWith('/') && !/\.[^/]+$/.test(url.pathname)) url.pathname += '/';
      return `[${label}](${url.href}${suffix})`;
    });
  }).join('\n').trim();
}
const output = [`/** Static Japanese public docs, source: ${revision ?? 'services/docs/src/content/docs/ja'}.\n * The local docs tool performs no filesystem, API, or network requests.\n */\nimport type { DocTopic } from './user-documentation.js';\nexport const JAPANESE_SECTIONS: Readonly<Record<Exclude<DocTopic, 'all'>, string>> = {\n`];
for (const [topic, files] of Object.entries(sourceMap)) {
  const content = files.map(file => clean(source(file), file)).join('\n\n---\n\n');
  const escaped = content.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('${', '\\${');
  output.push(`  ${topic}: \`${escaped}\`,\n`);
}
output.push('};\n');
writeFileSync(path.join(packageRoot, 'src/docs/japanese-documentation.ts'), output.join(''));
console.log(`Updated ${Object.keys(sourceMap).length} Japanese topics.`);
