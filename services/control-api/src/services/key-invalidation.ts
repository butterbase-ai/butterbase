import { getRedisPubClient, getRedisSubClient, onRedisMessage } from './redis.js';

type InvalidationCallback = (appId: string) => void;
const listeners: InvalidationCallback[] = [];
let subscribed = false;

export function onKeyInvalidated(cb: InvalidationCallback): void {
  listeners.push(cb);

  if (!subscribed) {
    subscribed = true;
    const sub = getRedisSubClient();
    sub.subscribe('key:invalidated').catch((err) => {
      console.error('[KeyInvalidation] Failed to subscribe:', err);
    });
    onRedisMessage((channel, appId) => {
      if (channel === 'key:invalidated') {
        for (const cb of listeners) {
          try { cb(appId); } catch (e) { console.error('[KeyInvalidation] handler error:', e); }
        }
      }
    });
  }
}

export function publishKeyInvalidation(appId: string): void {
  getRedisPubClient().publish('key:invalidated', appId).catch((err) => {
    console.error('[KeyInvalidation] Failed to publish:', err);
  });
}
