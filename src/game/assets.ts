/** Versioned URLs keep a new art release from reusing the previous cached model. */
export const ARENA_ASSETS = {
  character: '/models/scout-v2.glb?v=scout-v2',
  environment: '/models/environment-v2.glb?v=kannon-town-v2',
  environmentPhone: '/models/environment-v2-phone.glb?v=kannon-town-v2',
} as const;
export type TextureTier = 'phone' | 'full';
/** Phones load a smaller-texture build of the same town. */
export const environmentAssetUrl = (tier: TextureTier) => tier === 'phone' ? ARENA_ASSETS.environmentPhone : ARENA_ASSETS.environment;

const knownUrls = new Set<string>(Object.values(ARENA_ASSETS));
// Explicit local experiment assets share the same validated, retryable buffers.
export const VEHICLE_TEST_ASSETS = {
  environment: '/models/environment-vehicle-test.glb', current: '/models/vehicles-current.glb', improved: '/models/vehicles-improved.glb',
  originalTown: '/models/environment.glb?v=kannon-town-v1',
  refinedTown: '/models/environment-refined.glb?v=kannon-town-graphics-v2',
  townV2: '/models/environment-v2.glb', townV2Phone: '/models/environment-v2-phone.glb',
} as const;
for (const url of Object.values(VEHICLE_TEST_ASSETS)) knownUrls.add(url);
const buffers = new Map<string, Promise<ArrayBuffer>>();
const retries = new Set<string>();

function validateGlb(buffer: ArrayBuffer): void {
  const invalid = () => new Error('The arena artwork is incomplete or unavailable. Please try again.');
  if (buffer.byteLength < 20) throw invalid();
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== buffer.byteLength) throw invalid();
  let offset = 12;
  while (offset < buffer.byteLength) {
    if (offset + 8 > buffer.byteLength) throw invalid();
    const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true);
    if (length % 4 !== 0 || offset + 8 + length > buffer.byteLength) throw invalid();
    if (offset === 12) {
      if (type !== 0x4e4f534a || !length) throw invalid();
      try {
        const json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(buffer, offset + 8, length)));
        if (json?.asset?.version !== '2.0') throw invalid();
      } catch { throw invalid(); }
    }
    offset += 8 + length;
  }
}

/** One download per versioned model for this page's lifetime (two URLs maximum).
 * Consumers may read or parse the shared buffer, but must not mutate/transfer it.
 * Keeping the bytes makes room admission independent of a second network fetch. */
export function getArenaAssetBuffer(url: string): Promise<ArrayBuffer> {
  if (!knownUrls.has(url)) return Promise.reject(new Error('Unknown arena artwork.'));
  const cached = buffers.get(url); if (cached) return cached;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 60_000);
  const pending = (async () => {
    // Production URLs carry a version, so the cache is authoritative; development revalidates
    // so a freshly exported model is never hidden behind yesterday's copy.
    const response = await fetch(url, { cache: retries.has(url) ? 'reload' : import.meta.env?.DEV ? 'no-cache' : 'force-cache', signal: controller.signal });
    if (!response.ok) { await response.body?.cancel(); throw new Error('The arena artwork could not load. Please try again.'); }
    const buffer = await response.arrayBuffer(); validateGlb(buffer);
    retries.delete(url); return buffer;
  })().catch(error => {
    if (buffers.get(url) === pending) buffers.delete(url);
    retries.add(url);
    if (controller.signal.aborted) throw new Error('The arena download took too long. Check your connection and try again.');
    if (error instanceof Error && error.message.startsWith('The arena artwork')) throw error;
    throw new Error('The arena artwork could not load. Check your connection and try again.');
  }).finally(() => clearTimeout(deadline));
  buffers.set(url, pending); return pending;
}

/** Warm the same retained buffers that the GLTF parsers will consume. */
export function warmArenaAssets(tier: TextureTier = 'full'): Promise<void> {
  if (import.meta.env?.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).get('graphics') === 'current') {
    return Promise.all([ARENA_ASSETS.character, VEHICLE_TEST_ASSETS.originalTown].map(getArenaAssetBuffer)).then(() => {});
  }
  return Promise.all([ARENA_ASSETS.character, environmentAssetUrl(tier)].map(getArenaAssetBuffer)).then(() => {});
}
