const fs = require('fs');
const path = require('path');
const { ZipArchive } = require('archiver');

const out = fs.createWriteStream(path.join(__dirname, 'frontend.zip'));
const archive = new ZipArchive({ zlib: { level: 9 } });

out.on('close', () => console.log(`frontend.zip ${archive.pointer()} bytes`));
archive.on('error', (err) => { throw err; });
archive.pipe(out);
archive.directory('dist/', false);
archive.finalize();
