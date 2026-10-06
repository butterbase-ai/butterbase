import archiver from 'archiver';
import { createWriteStream, existsSync, readdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const distDir = resolve(__dirname, 'dist');
const outZip = resolve(__dirname, '..', 'frontend.zip');

if (!existsSync(distDir)) {
  console.error('dist/ not found — run `npm run build` first.');
  process.exit(1);
}

// Guardrail: a console-only build would silently ship a zip whose install
// snippet points at a widget.js that isn't there. Bail loudly instead.
if (!existsSync(join(distDir, 'widget.js'))) {
  console.error('dist/widget.js missing — you ran a console-only build. Run `npm run build` (which does console + widget) before zipping.');
  process.exit(1);
}

// --- app-id injection ---------------------------------------------------
// Rewrites <meta name="butterbase-app-id" content="__BB_APP_ID__" /> in every
// .html file under dist/ with the caller-supplied value. Lets one build serve
// every clone: run `node zip-dist.js --app-id app_xxx` per target, no rebuild.
// If no --app-id is passed we leave the placeholder alone (bb.ts falls back to
// VITE_BUTTERBASE_APP_ID, which is what local dev already uses).
function parseAppIdFlag(argv) {
  const i = argv.indexOf('--app-id');
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith('--app-id='));
  if (eq) return eq.slice('--app-id='.length);
  return process.env.DEPLOY_APP_ID || null;
}

function injectAppId(dir, appId) {
  if (!appId) return { htmlFiles: 0, rewrites: 0 };
  const APP_ID_RE = /^app_[a-z0-9]{6,32}$/;
  if (!APP_ID_RE.test(appId)) {
    console.error(`--app-id "${appId}" does not match ^app_[a-z0-9]{6,32}$`);
    process.exit(1);
  }
  let htmlFiles = 0, rewrites = 0;
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const st = statSync(full);
      if (st.isDirectory()) { walk(full); continue; }
      if (!entry.endsWith('.html')) continue;
      htmlFiles++;
      const src = readFileSync(full, 'utf8');
      if (!src.includes('__BB_APP_ID__')) continue;
      const next = src.replaceAll('__BB_APP_ID__', appId);
      writeFileSync(full, next);
      rewrites++;
    }
  };
  walk(dir);
  return { htmlFiles, rewrites };
}

const appId = parseAppIdFlag(process.argv);
if (appId) {
  const { htmlFiles, rewrites } = injectAppId(distDir, appId);
  console.log(`✓ Injected app id ${appId} into ${rewrites}/${htmlFiles} html file(s)`);
} else {
  console.log('ℹ No --app-id passed; leaving __BB_APP_ID__ placeholder untouched (build-time env will win)');
}

// --- zip ----------------------------------------------------------------

const output = createWriteStream(outZip);
const archive = archiver('zip', { zlib: { level: 9 }, forceLocalTime: true });

output.on('close', () => {
  console.log(`✓ Wrote ${outZip} (${archive.pointer()} bytes)`);
});

archive.on('error', (err) => {
  throw err;
});

archive.pipe(output);
// directory() with prefix '' keeps forward slashes (archiver always uses '/')
archive.directory(distDir, false);
archive.finalize();
