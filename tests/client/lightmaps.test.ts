import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LIGHTMAP_EXTENSION, LightmapPlugin, patchLightmapFragment, readLightmapDefinition } from '../../src/game/Lightmaps.js';
import { DECAL_MATERIAL, SMOKE_MATERIAL, WINDOW_GLASS_MATERIAL, createDecalMaterial, createSmokeMaterial } from '../../src/game/World.js';

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

test('v3 material names route decals, smoke and window glass', () => {
  assert.ok(DECAL_MATERIAL.test('V3_Decals'));
  assert.ok(SMOKE_MATERIAL.test('V3_Smoke'));
  assert.ok(WINDOW_GLASS_MATERIAL.test('V3_WindowGlass'));
  for (const name of ['V2_Glass', 'V3_Paint', 'Prop_crate_wood', 'V3_Burlap']) {
    assert.ok(![DECAL_MATERIAL, SMOKE_MATERIAL, WINDOW_GLASS_MATERIAL].some(pattern => pattern.test(name)), name);
  }
});

test('decals multiply the ground: never brighter, untouched by exposure, faded to white by fog', () => {
  const map = new THREE.Texture();
  const decal = createDecalMaterial(map);
  assert.equal(decal.map, map);
  assert.equal(decal.blending, THREE.MultiplyBlending);
  assert.equal(decal.premultipliedAlpha, true, 'three.js multiply blending needs premultiplied alpha');
  assert.equal(decal.toneMapped, false, 'white must stay exactly white');
  assert.equal(decal.depthWrite, false);
  assert.ok(decal.polygonOffset && decal.polygonOffsetFactor < 0, 'decals win the depth fight with the ground');
  const shader = { fragmentShader: THREE.ShaderLib.basic.fragmentShader, vertexShader: THREE.ShaderLib.basic.vertexShader, uniforms: {} };
  decal.onBeforeCompile(shader as never, undefined as never);
  assert.ok(!shader.fragmentShader.includes('#include <fog_fragment>'));
  assert.ok(shader.fragmentShader.includes('mix( gl_FragColor.rgb, vec3( 1.0 ), kannonFog )'));
  decal.dispose();
});

test('smoke columns are unlit, soft and sway with the shared wind clock', () => {
  const time = { value: 3 };
  const smoke = createSmokeMaterial(null, time);
  assert.equal(smoke.transparent, true);
  assert.equal(smoke.depthWrite, false);
  assert.equal(smoke.side, THREE.DoubleSide);
  const shader = { fragmentShader: THREE.ShaderLib.basic.fragmentShader, vertexShader: THREE.ShaderLib.basic.vertexShader, uniforms: {} as Record<string, unknown> };
  smoke.onBeforeCompile(shader as never, undefined as never);
  assert.equal(shader.uniforms.uWindTime, time);
  assert.ok(shader.vertexShader.includes('uniform float uWindTime;'));
  assert.ok(shader.vertexShader.includes('transformed.x += sin( uWindTime'));
  smoke.dispose();
});
