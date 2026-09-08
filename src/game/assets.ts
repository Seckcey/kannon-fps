/** Versioned URLs keep a new art release from reusing the previous cached model. */
export const ARENA_ASSETS = {
  character: '/models/scout.glb?v=scout-grounded-v1',
  environment: '/models/environment.glb?v=sunbreak-coastal-v1',
} as const;

const knownUrls = new Set<string>(Object.values(ARENA_ASSETS));
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
    const response = await fetch(url, { cache: retries.has(url) ? 'reload' : 'force-cache', signal: controller.signal });
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
export function warmArenaAssets(): Promise<void> {
  return Promise.all(Object.values(ARENA_ASSETS).map(getArenaAssetBuffer)).then(() => {});
}
