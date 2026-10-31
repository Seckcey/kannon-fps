import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LIGHTMAP_EXTENSION, LightmapPlugin, SHADE_ALPHA_FLAG, applyLightmapShading, lightmapHasShadeAlpha, patchLightmapFragment, readLightmapDefinition } from '../../src/game/Lightmaps.js';
import {
  DECAL_MATERIAL, FOLIAGE_SWAY, SMOKE_MATERIAL, SMOKE_SWAY, WINDOW_GLASS_MATERIAL, WIRE_MATERIAL,
  castsRealtimeShadow, createDecalMaterial, createSmokeMaterial, patchSwayVertex, swayOffset,
} from '../../src/game/World.js';

test('reads a valid lightmap definition and rejects malformed ones', () => {
  assert.deepEqual(readLightmapDefinition({ extensions: { [LIGHTMAP_EXTENSION]: { intensity: 0.8, texture: { index: 3, texCoord: 1 } } } }),
    { intensity: 0.8, texture: { index: 3, texCoord: 1 }, shadeAlpha: false });
  assert.deepEqual(readLightmapDefinition({ extensions: { [LIGHTMAP_EXTENSION]: { texture: { index: 0 } } } }),
    { intensity: 1, texture: { index: 0, texCoord: 1 }, shadeAlpha: false });
  assert.equal(readLightmapDefinition({}), null);
  assert.equal(readLightmapDefinition(null), null);
  assert.equal(readLightmapDefinition({ extensions: { [LIGHTMAP_EXTENSION]: { texture: { index: -1 } } } }), null);
  assert.equal(readLightmapDefinition({ extensions: { [LIGHTMAP_EXTENSION]: { intensity: 'x', texture: { index: 0 } } } }), null);
  assert.equal(readLightmapDefinition({ extensions: { [LIGHTMAP_EXTENSION]: { texture: { index: 0, texCoord: 2 } } } }), null);
});

test('a lightmap declares its shade level in the extension extras, and only exactly true counts', () => {
  const definition = (extras: unknown) => readLightmapDefinition({ extensions: { [LIGHTMAP_EXTENSION]: { extras, texture: { index: 1 } } } });
  assert.equal(definition({ shadeAlpha: true })?.shadeAlpha, true);
  for (const extras of [undefined, null, 'yes', { shadeAlpha: 1 }, { shadeAlpha: 'true' }, { sunMask: true }]) assert.equal(definition(extras)?.shadeAlpha, false, JSON.stringify(extras));
});

test('plugin assigns the lightmap texture, intensity and shade-level flag through the parser', async () => {
  const assigned: unknown[] = [];
  const parser = {
    json: { materials: [
      { extensions: { [LIGHTMAP_EXTENSION]: { intensity: 0.7, texture: { index: 2, texCoord: 1 } } } },
      {},
      { extensions: { [LIGHTMAP_EXTENSION]: { intensity: 6.76, extras: { shadeAlpha: true }, texture: { index: 4, texCoord: 1 } } } },
    ] },
    assignTexture: async (params: Record<string, unknown>, key: string, mapDef: unknown, colorSpace: string) => { params[key] = mapDef; assigned.push([key, mapDef, colorSpace]); },
  };
  const plugin = new LightmapPlugin(parser as never);
  const params: Record<string, unknown> = {};
  await plugin.extendMaterialParams(0, params);
  assert.equal(params.lightMapIntensity, 0.7);
  assert.equal(params.userData, undefined, 'no shade level, no flag');
  assert.deepEqual(assigned, [['lightMap', { index: 2, texCoord: 1 }, THREE.SRGBColorSpace]]);
  const untouched: Record<string, unknown> = {};
  await plugin.extendMaterialParams(1, untouched);
  assert.deepEqual(untouched, {});
  const shaded: Record<string, unknown> = { userData: { kept: 1 } };
  await plugin.extendMaterialParams(2, shaded);
  assert.deepEqual(shaded.userData, { kept: 1, [SHADE_ALPHA_FLAG]: true });
  // The flag survives material construction the way GLTFLoader builds materials.
  const material = new THREE.MeshStandardMaterial(shaded as THREE.MeshStandardMaterialParameters);
  assert.equal(lightmapHasShadeAlpha(material), true);
  assert.equal(lightmapHasShadeAlpha(new THREE.MeshStandardMaterial()), false);
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

/** The shading the patched shader computes, for one texel: baked light `baked`, shade level
 *  `shade` (lightmap alpha), real-time sun reaching it `lit` (1 open, 0 in a character's shadow). */
const shadeLevelShading = (baked: number, shade: number, lit: number, strength = 1) => baked * (1 + (shade - 1) * (1 - lit) * strength);

test('with a shade level a real-time shadow removes the baked sun and nothing else', () => {
  const patched = patchLightmapFragment(THREE.ShaderLib.standard.fragmentShader, true);
  assert.ok(patched.includes('irradiance += lightMapIrradiance * mix( 1.0, lightMapTexel.a, ( 1.0 - kannonSunShadow ) * uSunShadowStrength );'));
  assert.ok(!patched.includes('mix( 1.0, kannonSunShadow, uSunShadowStrength )'));
  // The formula above, evaluated: in baked shade or indoors the shade level is 1, so a character
  // standing there casts no phantom shadow however long the golden-hour shadow is.
  assert.equal(shadeLevelShading(0.4, 1, 0), 0.4);
  // In the sun (80 % of the baked light is sun) a full shadow leaves the sky and bounce, exactly
  // the level of the baked shade next to it; half shadow removes half the sun.
  assert.ok(Math.abs(shadeLevelShading(2.0, 0.2, 0) - 0.4) < 1e-9);
  assert.ok(Math.abs(shadeLevelShading(2.0, 0.2, 0.5) - 1.2) < 1e-9);
  assert.equal(shadeLevelShading(2.0, 0.2, 1), 2.0);
  // A texture that lost its alpha reads 1: nothing is removed rather than everything.
  assert.equal(shadeLevelShading(2.0, 1, 0), 2.0);
});

test('lightmap shading picks the formula and strength from the shade level and never shares programs', () => {
  const compile = (material: THREE.MeshStandardMaterial) => {
    const shader = { fragmentShader: THREE.ShaderLib.standard.fragmentShader, vertexShader: THREE.ShaderLib.standard.vertexShader, uniforms: {} as Record<string, { value: number }> };
    material.onBeforeCompile(shader as never, undefined as never);
    return shader;
  };
  const legacy = new THREE.MeshStandardMaterial(), shaded = new THREE.MeshStandardMaterial();
  applyLightmapShading(legacy);
  applyLightmapShading(shaded, { shadeAlpha: true });
  assert.equal(compile(legacy).uniforms.uSunShadowStrength!.value, 0.6);
  assert.equal(compile(shaded).uniforms.uSunShadowStrength!.value, 1);
  assert.ok(compile(shaded).fragmentShader.includes('lightMapTexel.a'));
  assert.ok(!compile(legacy).fragmentShader.includes('lightMapTexel.a'));
  assert.notEqual(legacy.customProgramCacheKey(), shaded.customProgramCacheKey());
});

test('v3 material names route decals, smoke, window glass and wire', () => {
  assert.ok(DECAL_MATERIAL.test('V3_Decals'));
  assert.ok(SMOKE_MATERIAL.test('V3_Smoke'));
  assert.ok(WINDOW_GLASS_MATERIAL.test('V3_WindowGlass'));
  assert.ok(WIRE_MATERIAL.test('V3_Wire'));
  for (const name of ['V2_Glass', 'V3_Paint', 'Prop_crate_wood', 'V3_Burlap', 'V3_Cone']) {
    assert.ok(![DECAL_MATERIAL, SMOKE_MATERIAL, WINDOW_GLASS_MATERIAL, WIRE_MATERIAL].some(pattern => pattern.test(name)), name);
  }
});

test('shadow casting is decided per mesh, so meshes that share a material all get it right', () => {
  // GLTFLoader shares one material between every mesh that uses it: six panes, four pots, the
  // truck's paint and the props'. A per-material decision only ever reached the first mesh.
  const material = (name: string, lightmapped = false) => {
    const m = new THREE.MeshStandardMaterial(); m.name = name;
    if (lightmapped) m.lightMap = new THREE.Texture();
    return m;
  };
  const glass = material('V3_WindowGlass'), pot = material('V3_Pot', true), paint = material('V3_Paint', true);
  const wire = material('V3_Wire'), grass = material('V2_GrassCard'), hills = material('V2_Hills');
  const mesh = (name: string, m: THREE.Material, parent?: THREE.Object3D) => {
    const object = new THREE.Mesh(new THREE.BufferGeometry(), m); object.name = name; parent?.add(object); return object;
  };
  const panes = Array.from({ length: 6 }, (_, i) => mesh(`Breakable_Glass_${i}`, glass));
  const pots = Array.from({ length: 4 }, (_, i) => mesh(`Breakable_Pot_${i}`, pot));
  const props = new THREE.Group(); props.name = 'Props';
  const vehicles = new THREE.Group(); vehicles.name = 'Vehicles';
  const propPaint = mesh('Props_1', paint, props), truckPaint = mesh('Vehicles_2', paint, vehicles), wires = mesh('Props_0', wire, props);
  const foliage = new THREE.Group(); foliage.name = 'Foliage';
  const cards = mesh('Foliage_1', grass, foliage);
  const horizon = new THREE.Group(); horizon.name = 'Horizon';
  const hill = mesh('Horizon_1', hills, horizon);
  for (const pane of panes) assert.equal(castsRealtimeShadow(pane), false, `${pane.name}: glass never hides what is behind it`);
  for (const p of pots) assert.equal(castsRealtimeShadow(p), true, `${p.name}: its shadow is not baked, so it must cast`);
  assert.equal(castsRealtimeShadow(propPaint), false);
  assert.equal(castsRealtimeShadow(truckPaint), false, 'the truck shares its paint with the props and is baked too');
  assert.equal(castsRealtimeShadow(wires), false, 'wire strands are thinner than a shadow-map texel');
  assert.equal(castsRealtimeShadow(cards), true, 'unbaked grass cards still cast');
  assert.equal(castsRealtimeShadow(hill), false);
  assert.equal(castsRealtimeShadow(new THREE.Group()), false);
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

test('smoke columns are unlit and soft, and sway in world metres with the shared wind clock', () => {
  const time = { value: 3 };
  const smoke = createSmokeMaterial(null, time);
  assert.equal(smoke.transparent, true);
  assert.equal(smoke.depthWrite, false);
  assert.equal(smoke.side, THREE.DoubleSide);
  const shader = { fragmentShader: THREE.ShaderLib.basic.fragmentShader, vertexShader: THREE.ShaderLib.basic.vertexShader, uniforms: {} as Record<string, unknown> };
  smoke.onBeforeCompile(shader as never, undefined as never);
  assert.equal(shader.uniforms.uWindTime, time);
  assert.ok(shader.vertexShader.includes('uniform float uWindTime;'));
  // Meshopt stores positions in the node's unit box, so the sway must not read `position`: it
  // works from the world position and goes back through the node's (uniform) scale.
  assert.ok(shader.vertexShader.includes('vec3 kannonWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;'));
  assert.ok(shader.vertexShader.includes(`smoothstep( ${SMOKE_SWAY.riseFrom.toFixed(4)}, ${SMOKE_SWAY.riseTo.toFixed(4)}, kannonWorld.y )`));
  assert.ok(shader.vertexShader.includes('/ dot( modelMatrix[ 0 ].xyz, modelMatrix[ 0 ].xyz )'));
  assert.ok(!/position\.[xyz]/.test(shader.vertexShader.slice(shader.vertexShader.indexOf('kannonWorld'))), 'no raw position after the patch');
  assert.equal(patchSwayVertex(shader.vertexShader, SMOKE_SWAY), shader.vertexShader, 'idempotent');
  smoke.dispose();
});

test('the local offset the sway shader adds is the world offset through any uniform node scale', () => {
  // Mirror of worldSway in GLSL: transformed += (offset * mat3(model)) / dot(model[0], model[0]).
  const model = new THREE.Matrix4().compose(new THREE.Vector3(7.1, 48, 35), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7), new THREE.Vector3(186.8, 186.8, 186.8));
  const linear = new THREE.Matrix3().setFromMatrix4(model);
  const offset = new THREE.Vector3(3, 0, -2);
  const column0 = new THREE.Vector3().setFromMatrixColumn(model, 0);
  const local = offset.clone().applyMatrix3(linear.clone().transpose()).divideScalar(column0.lengthSq());
  const moved = local.applyMatrix3(linear);
  assert.ok(moved.distanceTo(offset) < 1e-9, 'the vertex moves by the world offset, in metres');
});

test('foliage sways a few centimetres, more the higher the leaf, and the smoke tops drift metres', () => {
  const peak = (sway: typeof SMOKE_SWAY | typeof FOLIAGE_SWAY, y: number) => {
    let most = 0;
    for (let t = 0; t < 120; t += 0.25) { const o = swayOffset(sway, { x: 3, y, z: -2 }, t); most = Math.max(most, Math.hypot(o.x, o.z)); }
    return most;
  };
  assert.ok(peak(FOLIAGE_SWAY, 0.05) < 1e-6, 'grass roots and bush bases stay put');
  assert.ok(peak(FOLIAGE_SWAY, 1.2) > 0.02 && peak(FOLIAGE_SWAY, 1.2) < 0.06, `bush tops move ${peak(FOLIAGE_SWAY, 1.2).toFixed(3)} m`);
  assert.ok(peak(SMOKE_SWAY, -8) < 1e-6, 'smoke bases stay on the horizon');
  assert.ok(peak(SMOKE_SWAY, 90) > 2, `smoke tops drift ${peak(SMOKE_SWAY, 90).toFixed(2)} m`);
});
