// Tiny SSE consumer. Emits each `data:` line to stdout (un-escaping \\n back
// to \n), resolves on `event: done`. Bearer auth only.
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

export function streamSSE(
  url: string,
  headers: Record<string, string>,
  options?: { offset?: number },
): Promise<{ done: boolean; bytesReceived: number }> {
  return new Promise((resolve, reject) => {
    const finalUrl = options?.offset
      ? url + (url.includes('?') ? '&' : '?') + `offset=${options.offset}`
      : url;
    const u = new URL(finalUrl);
    const lib = u.protocol === 'https:' ? https : http;
    let bytesReceived = options?.offset ?? 0;
    const req = lib.request(
      {
        method: 'GET',
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: { accept: 'text/event-stream', ...headers },
      },
      (res) => {
        if (res.statusCode! >= 400) {
          reject(new Error(`logs returned ${res.statusCode}`));
          return;
        }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const evt = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            if (evt.startsWith('event: done')) {
              resolve({ done: true, bytesReceived });
            } else if (evt.startsWith('event: error')) {
              const dataLine = evt.split('\n').find((l) => l.startsWith('data: '));
              reject(new Error(dataLine ? dataLine.slice(6) : 'Build error'));
            } else if (evt.startsWith('data: ')) {
              const payload = evt.slice(6);
              bytesReceived += Buffer.byteLength(payload, 'utf8');
              process.stdout.write(payload.replace(/\\n/g, '\n') + '\n');
            } else {
              // multi-line event block: find the data line
              const dataLine = evt.split('\n').find((l) => l.startsWith('data: '));
              if (dataLine) {
                const payload = dataLine.slice(6);
                bytesReceived += Buffer.byteLength(payload, 'utf8');
                process.stdout.write(payload.replace(/\\n/g, '\n') + '\n');
              }
            }
          }
        });
        res.on('end', () => resolve({ done: true, bytesReceived }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}
