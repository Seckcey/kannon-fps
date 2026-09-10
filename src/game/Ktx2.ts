import * as THREE from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';

/** Basis transcoder worker served from this origin instead of a blob: URL. The Emscripten
 *  transcoder builds its bindings with `new Function`, which the page's Content Security
 *  Policy forbids; a worker loaded from its own URL carries its own policy (server/app.ts
 *  grants that one file `'unsafe-eval'`), so the page policy stays strict.
 *  scripts/build-ktx2-worker.mjs writes both files before dev and build. */
export const KTX2_WORKER_URL = '/basis/ktx2-worker.js';
export const KTX2_WASM_URL = '/basis/basis_transcoder.wasm';

class SameOriginKtx2Loader extends KTX2Loader {
  override init(): Promise<void> {
    if (!this.transcoderPending) {
      const binaryLoader = new THREE.FileLoader(this.manager);
      binaryLoader.setResponseType('arraybuffer');
      this.transcoderPending = binaryLoader.loadAsync(KTX2_WASM_URL).then(binary => {
        this.transcoderBinary = binary as ArrayBuffer;
        this.workerSourceURL = KTX2_WORKER_URL;
        this.workerPool.setWorkerCreator(() => {
          const worker = new Worker(this.workerSourceURL);
          const transcoderBinary = (this.transcoderBinary as ArrayBuffer).slice(0);
          worker.postMessage({ type: 'init', config: this.workerConfig, transcoderBinary }, [transcoderBinary]);
          return worker;
        });
      });
    }
    return this.transcoderPending;
  }
}

let shared: KTX2Loader | null = null;
let detected = false;

/** One transcoder for every GLB on the page. The renderer must be seen once, before the
 *  first KTX2 texture is parsed, so the loader knows which GPU formats it can use. */
export function ktx2Loader(renderer?: THREE.WebGLRenderer): KTX2Loader {
  shared ??= new SameOriginKtx2Loader();
  if (renderer && !detected) { shared.detectSupport(renderer); detected = true; }
  return shared;
}
