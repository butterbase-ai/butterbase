// Self-contained realtime smoke test. Subscribes to posts, prints any incoming change events.
// Node 22 has WebSocket built in.
const APP = 'app_tjdow67aaus5';
const URL = `ws://localhost:4000/v1/${APP}/realtime`;
const ws = new WebSocket(URL);

const got = [];
const timeout = setTimeout(() => {
  console.log('TIMEOUT after 15s. Received:', JSON.stringify(got, null, 2));
  process.exit(got.length ? 0 : 2);
}, 15000);

ws.addEventListener('open', () => {
  console.log('open');
  ws.send(JSON.stringify({ type: 'subscribe', table: 'posts' }));
});
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data.toString());
  console.log('msg:', JSON.stringify(msg));
  got.push(msg);
  // Stop after a "change" event arrives.
  if (msg.type === 'change') {
    clearTimeout(timeout);
    ws.close();
    process.exit(0);
  }
});
ws.addEventListener('error', (e) => { console.log('error:', e.message); });
ws.addEventListener('close', (e) => { console.log('close', e.code, e.reason); });
