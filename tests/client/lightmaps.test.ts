import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LIGHTMAP_EXTENSION, LightmapPlugin, patchLightmapFragment, readLightmapDefinition } from '../../src/game/Lightmaps.js';

test('reads a valid lightmap definition and rejects malformed ones', () => {
  assert.deepEqual(readLightmapDefinition({ extensions: { [LIGHTMAP_EXTENSION]: { intensity: 0.8, texture: { index: 3, texCoord: 1 } } } }),
    { intensity: 0.8, texture: { index: 3, texCoord: 1 } });
  assert.deepEqual(readLightmapDefinition({ extensions: { [LIGHTMAP_EXTENSION]: { texture: { index: 0 } } } }),
    { intensity: 1, texture: { index: 0, texCoord: 1 } });
  assert.equal(readLightmapDefinition({}), null);
  assert.equal(readLightmapDefinition(null), null);
  assert.equal(readLightmapDefinition({ extensions: { [LIGHTMAP_EXTENSION]: { texture: { index: -1 } } } }), null);
  assert.equal(readLightmapDefinition({ extensions: { [LIGHTMAP_EXTENSION]: { intensity: 'x', texture: { index: 0 } } } }), null);
  assert.equal(readLightmapDefinition({ extensions: { [LIGHTMAP_EXTENSION]: { texture: { index: 0, texCoord: 2 } } } }), null);
});

test('plugin assigns the lightmap texture and intensity through the parser', async () => {
  const assigned: unknown[] = [];
  const parser = {
    json: { materials: [{ extensions: { [LIGHTMAP_EXTENSION]: { intensity: 0.7, texture: { index: 2, texCoord: 1 } } } }, {}] },
    assignTexture: async (params: Record<string, unknown>, key: string, mapDef: unknown, colorSpace: string) => { params[key] = mapDef; assigned.push([key, mapDef, colorSpace]); },
  };
  const plugin = new LightmapPlugin(parser as never);
  const params: Record<string, unknown> = {};
  await plugin.extendMaterialParams(0, params);
  assert.equal(params.lightMapIntensity, 0.7);
  assert.deepEqual(assigned, [['lightMap', { index: 2, texCoord: 1 }, THREE.SRGBColorSpace]]);
  const untouched: Record<string, unknown> = {};
  await plugin.extendMaterialParams(1, untouched);
  assert.deepEqual(untouched, {});
});

test('environment patch removes the direct sun but keeps its shadow on the lightmap', () => {
  const patched = patchLightmapFragment(THREE.ShaderLib.standard.fragmentShader);
  assert.ok(!patched.includes('#include <lights_fragment_begin>'));
  assert.ok(!patched.includes('#include <lights_fragment_maps>'));
  assert.ok(patched.includes('float kannonSunShadow = 1.0;'));
  assert.ok(patched.includes('irradiance += lightMapIrradiance * mix( 1.0, kannonSunShadow, uSunShadowStrength );'));
  assert.ok(patched.includes('uniform float uSunShadowStrength;'));
  // The directional loop no longer calls RE_Direct; point and spot loops still do.
  const start = patched.indexOf('NUM_DIR_LIGHTS > 0');
  const directionalBlock = patched.slice(start, patched.indexOf('#pragma unroll_loop_end', start));
  assert.ok(start > 0);
  assert.ok(!directionalBlock.includes('RE_Direct( directLight'));
  assert.ok(directionalBlock.includes('kannonSunShadow = min( kannonSunShadow'));
  const pointStart = patched.indexOf('NUM_POINT_LIGHTS > 0');
  assert.ok(patched.slice(pointStart, patched.indexOf('#pragma unroll_loop_end', pointStart)).includes('RE_Direct( directLight'));
  // Hemisphere light is silenced for lightmapped surfaces.
  assert.ok(patched.includes('getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal ) * 0.0'));
  // Idempotent.
  assert.equal(patchLightmapFragment(patched), patched);
});
