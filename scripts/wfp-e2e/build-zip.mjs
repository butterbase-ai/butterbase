// Zip via `archiver` (the package butterbase docs recommend).
// Run: node scripts/wfp-e2e/build-zip.mjs
import { createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';

const root = fileURLToPath(new URL('./dist', import.meta.url));
const out = fileURLToPath(new URL('./frontend.zip', import.meta.url));

const output = createWriteStream(out);
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => console.log(`wrote ${out} (${archive.pointer()} bytes)`));
archive.on('warning', (err) => { if (err.code !== 'ENOENT') throw err; });
archive.on('error', (err) => { throw err; });

archive.pipe(output);
archive.directory(root, false);
await archive.finalize();
