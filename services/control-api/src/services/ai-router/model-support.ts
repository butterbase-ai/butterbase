import type { CatalogEntry } from './catalog.js';
import type { RouterAdapter } from './adapters/types.js';
import type { RouterName } from './normalize.js';

/** Discovery does not imply that a configured adapter can generate the model. */
export function isMediaModelRoutable(
  entry: CatalogEntry,
  adapters: ReadonlyMap<RouterName, RouterAdapter>,
  enabledRouters: ReadonlySet<RouterName>,
): boolean {
  const modality = entry.routers[0]?.modality ?? 'chat';
  if (modality !== 'image' && modality !== 'video') return true;
  return entry.routers.some(router => {
    if (router.modality !== modality || !enabledRouters.has(router.name)) return false;
    const adapter = adapters.get(router.name);
    if (!adapter) return false;
    if (modality === 'image') {
      return typeof adapter.submitImage === 'function'
        && adapter.getSupportedImageParams?.(entry.canonicalId) != null;
    }
    return typeof adapter.submitVideo === 'function'
      && typeof adapter.pollVideo === 'function'
      && typeof adapter.fetchVideoContent === 'function';
  });
}
