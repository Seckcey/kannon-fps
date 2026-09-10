import type * as THREE from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';

let shared: KTX2Loader | null = null;
let detected = false;

/** One transcoder for every GLB on the page. The renderer must be seen once, before the
 *  first KTX2 texture is parsed, so the loader knows which GPU formats it can use. */
export function ktx2Loader(renderer?: THREE.WebGLRenderer): KTX2Loader {
  shared ??= new KTX2Loader();
  if (renderer && !detected) { shared.detectSupport(renderer); detected = true; }
  return shared;
}
