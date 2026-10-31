import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { EXPOSURE, FOG, GOLDEN_CLOUDS, HEMISPHERE, SKY, SUN_COLOR, SUN_DIRECTION, SUN_INTENSITY } from '../../src/game/Atmosphere.js';

/** The bake records the light it baked; the runtime must light characters with the same sun and
 *  a sky that matches the baked shade, or players glow or sink against the walls they stand by. */
interface Calibration {
  sunDirection: [number, number, number]; sunColorSrgb: [number, number, number]; sunIntensity: number;
  blenderToRuntime: number; skyUp: [number, number, number]; sunPerpendicular: [number, number, number];
  openStreetHorizontal: [number, number, number]; groundBounceDown: [number, number, number];
  normaliser: number; lightMapIntensity: number;
}
const sidecar = JSON.parse(readFileSync(new URL('../../art/source/town-v3/town-v3-lightmaps.json', import.meta.url), 'utf8')) as {
  calibration: Calibration; materials: Record<string, { atlas: string; intensity: number }>; alphaBlend: string[];
  atlases: Record<string, string>; sunMasks: Record<string, string>;
};
const calibration = sidecar.calibration;
const luminance = ([r, g, b]: readonly number[]) => 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
const linear = (hex: string) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b] as const; };

test('the baked sun is the runtime sun: same direction, colour and strength', () => {
  const baked = new THREE.Vector3(...calibration.sunDirection).normalize();
  assert.ok(baked.distanceTo(SUN_DIRECTION) < 1e-3, `bake ${baked.toArray()} vs runtime ${SUN_DIRECTION.toArray()}`);
  const srgb = new THREE.Color(SUN_COLOR); srgb.convertLinearToSRGB();
  calibration.sunColorSrgb.forEach((channel, i) => assert.ok(Math.abs(channel - srgb.toArray()[i]!) < 1.5 / 255, `sun colour channel ${i}`));
  assert.equal(calibration.sunIntensity, SUN_INTENSITY);
  // Measured in Blender on a plane facing the sun, scaled into three.js units: it must equal the
  // DirectionalLight's irradiance, which proves the bake's units (irradiance / pi) were handled.
  const runtime = linear(SUN_COLOR).map(c => c * SUN_INTENSITY);
  calibration.sunPerpendicular.forEach((measured, i) => {
    assert.ok(Math.abs(measured - runtime[i]!) / runtime[i]! < 0.12, `sun channel ${i}: baked ${measured.toFixed(3)} vs runtime ${runtime[i]!.toFixed(3)}`);
  });
});

test('golden hour: a low western sun throws shadows across the north-south street', () => {
  const elevation = THREE.MathUtils.radToDeg(Math.asin(SUN_DIRECTION.y));
  assert.ok(elevation >= 15 && elevation <= 25, `sun elevation ${elevation.toFixed(1)} deg`);
  assert.ok(SUN_DIRECTION.x < 0 && Math.abs(SUN_DIRECTION.x) > 2 * Math.abs(SUN_DIRECTION.z), 'the sun sits west of the street, mostly across it');
  const [r, g, b] = linear(SUN_COLOR);
  assert.ok(r > g && g > b && b / r < 0.45, 'the sun is warm');
  const [sr, , sb] = linear(HEMISPHERE.sky);
  assert.ok(sb > sr, 'the sky light is cool');
  assert.ok(FOG.near >= 20 && FOG.far <= 400 && FOG.near < FOG.far, 'a haze softens the hills');
  assert.ok(EXPOSURE > 0.8 && EXPOSURE < 1.6);
});

test('the hemisphere light matches the baked sky and ground bounce', () => {
  // Characters in shade get the hemisphere plus a small sky probe; the probe adds roughly a
  // quarter, so the hemisphere alone sits between half and the whole of the baked sky.
  const skyUp = luminance(calibration.skyUp);
  const hemisphereUp = luminance(linear(HEMISPHERE.sky)) * HEMISPHERE.intensity;
  assert.ok(hemisphereUp >= 0.5 * skyUp && hemisphereUp <= 1.1 * skyUp, `hemisphere ${hemisphereUp.toFixed(3)} vs baked sky ${skyUp.toFixed(3)}`);
  const skyChroma = calibration.skyUp[2] / calibration.skyUp[0];
  const [hr, , hb] = linear(HEMISPHERE.sky);
  assert.ok(Math.abs(hb / hr - skyChroma) / skyChroma < 0.35, `sky colour ratio ${(hb / hr).toFixed(2)} vs baked ${skyChroma.toFixed(2)}`);
  const ground = luminance(calibration.groundBounceDown);
  const hemisphereDown = luminance(linear(HEMISPHERE.ground)) * HEMISPHERE.intensity;
  assert.ok(hemisphereDown >= 0.4 * ground && hemisphereDown <= 2.0 * ground, `hemisphere ground ${hemisphereDown.toFixed(3)} vs baked bounce ${ground.toFixed(3)}`);
});

test('the golden-hour clouds patch the three.js sky shader in place', () => {
  // Atmosphere.ts rewrites two lines of the Sky shader; a three.js upgrade that renames them
  // would silently drop the warm clouds, so the lines and the names the patch uses must exist.
  const skyShader = Sky.SkyShader as { fragmentShader: string; uniforms: Record<string, unknown> };
  const shader = skyShader.fragmentShader;
  assert.ok(shader.includes('cloudNoise = cloudNoise * 0.5 + 0.5;'));
  assert.ok(shader.includes('cloudColor *= vSunE * 0.00002;'));
  for (const name of ['direction', 'vSunDirection', 'cloudNoise', 'cloudColor']) assert.ok(shader.includes(name) && GOLDEN_CLOUDS.includes(name), name);
  for (const uniform of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG', 'cloudCoverage', 'cloudDensity', 'cloudScale']) {
    assert.ok(uniform in skyShader.uniforms, `${uniform} is a sky uniform`);
  }
  assert.ok(SKY.mieDirectionalG <= 0.8 && SKY.mieCoefficient <= 0.0035, 'the glow around the low sun stays soft enough not to bloom to white');
});

test('every lightmapped material uses the calibrated intensity, and open sun is brighter than shade', () => {
  const intensities = new Set(Object.values(sidecar.materials).map(entry => entry.intensity));
  assert.equal(intensities.size, 1);
  assert.ok(Math.abs([...intensities][0]! - calibration.lightMapIntensity) < 1e-6);
  assert.ok(Math.abs(calibration.lightMapIntensity - calibration.normaliser * calibration.blenderToRuntime * Math.PI) < 1e-6);
  assert.ok(luminance(calibration.openStreetHorizontal) > 1.5 * luminance(calibration.skyUp), 'sunlit ground clearly outshines the shade');
  for (const name of ['V3_WindowGlass', 'V3_Smoke']) assert.ok(sidecar.alphaBlend.some(entry => entry.startsWith(name)), `${name} blends`);
});

test('every atlas has its sun share baked beside it, and the pots bake on their own', () => {
  // The finish script turns each sun-share image into the lightmap's shade-level alpha, so a
  // character's real-time shadow takes away the baked sun and nothing else.
  assert.deepEqual(Object.keys(sidecar.sunMasks).sort(), Object.keys(sidecar.atlases).sort());
  for (const [atlas, file] of Object.entries(sidecar.sunMasks)) assert.equal(file, `${atlas}_sun.png`);
  // Pots are invisible to every other group's bake: no baked shadow is left when one shatters.
  assert.equal(sidecar.materials.V3_Pot?.atlas, 'LM_pots');
  assert.ok(Object.entries(sidecar.materials).every(([name, entry]) => (entry.atlas === 'LM_pots') === name.startsWith('V3_Pot')));
});
