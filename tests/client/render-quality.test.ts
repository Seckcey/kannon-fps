import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { DIRECT_GRADE, DirectGrade, DirectGradeShader, FILM_GRADE, GRADED_TONE_MAPPING, RenderQuality, applyGradedToneMapping, directGradeValues, hasGradedToneMapping, scenePixelRatio, screenCondition } from '../../src/game/RenderQuality';

/** Tone mapping changes a shared three.js shader chunk: put it back after each test that installs the grade. */
function withOriginalChunk(run: () => void) {
  const original = THREE.ShaderChunk.tonemapping_pars_fragment;
  try { run(); } finally { THREE.ShaderChunk.tonemapping_pars_fragment = original; }
}

test('render resolution responds to sustained GPU pressure, keeps a floor, and recovers slowly', () => {
  const quality = new RenderQuality();
  quality.observe(15, .7, 'auto'); quality.observe(59, .7, 'auto');
  assert.equal(quality.scale, 1, 'a single hitch does not lower detail');
  for (let i = 0; i < 40; i++) quality.observe(25, .75, 'auto');
  assert.equal(quality.scale, .55, 'sustained slow rendering stops at the readable floor');
  for (let i = 0; i < 19; i++) quality.observe(60, .75, 'auto');
  assert.equal(quality.scale, .55, 'recovery waits fifteen seconds');
  quality.observe(60, .75, 'auto'); assert.ok(Math.abs(quality.scale - .6) < 1e-6);
  quality.reset();
  for (let i = 0; i < 40; i++) quality.observe(20, .75, 'high');
  assert.equal(quality.scale, .65, 'High retains more scene detail');
  quality.reset(); quality.observe(5, 10, 'low'); assert.equal(quality.scale, 1);
});

test('visibility resets discard partial slowdown and pixel budgets bound high-DPI screens', () => {
  const quality = new RenderQuality(); quality.observe(10, 1.5, 'auto'); quality.resetTiming(); quality.observe(10, .8, 'auto');
  assert.equal(quality.scale, 1);
  for (const [width, height, device, touch, setting, budget] of [
    [3840, 2160, 2, false, 'auto', 1600 * 900],
    [844, 390, 3, true, 'auto', 1280 * 720],
    [3840, 2160, 2, false, 'high', 2560 * 1440],
    [1920, 1080, 1, false, 'low', 1024 * 768],
  ] as const) {
    const ratio = scenePixelRatio(width, height, device, touch, setting);
    assert.ok(width * height * ratio ** 2 <= budget + 1);
    assert.ok(ratio <= device);
  }
});

test('screen condition is clamped to 0..1 and ignores bad numbers', () => {
  assert.deepEqual(screenCondition(0.4, 0.7), { lowHealth: 0.4, flash: 0.7 });
  assert.deepEqual(screenCondition(-1, 3), { lowHealth: 0, flash: 1 });
  assert.deepEqual(screenCondition(Number.NaN, Number.POSITIVE_INFINITY), { lowHealth: 0, flash: 0 });
});

test('RenderQuality stays free of the desktop post-processing code, which phones never download', () => {
  const source = readFileSync(new URL('../../src/game/RenderQuality.ts', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map(match => match[1]);
  assert.deepEqual(imports, ['three', './RenderTiers']);
  assert.match(source, /^import type \{ RenderTier \} from '\.\/RenderTiers';$/m, 'tiers as types only');
});

test('the direct grade is one blended full-screen triangle that reads no textures', () => {
  const grade = new DirectGrade();
  const { material } = grade;
  assert.equal(material.blending, THREE.CustomBlending);
  assert.deepEqual([material.blendEquation, material.blendSrc, material.blendDst], [THREE.AddEquation, THREE.OneFactor, THREE.SrcAlphaFactor], 'result = colour + frame × alpha');
  assert.deepEqual([material.blendSrcAlpha, material.blendDstAlpha], [THREE.ZeroFactor, THREE.OneFactor]);
  assert.deepEqual([material.depthTest, material.depthWrite, material.toneMapped], [false, false, false]);
  assert.doesNotMatch(DirectGradeShader.fragmentShader, /sampler|texture/, 'no framebuffer or texture reads on phones');
  for (const name of Object.keys(DirectGradeShader.uniforms)) assert.match(DirectGradeShader.fragmentShader, new RegExp(`\\b${name}\\b`));
  grade.dispose();
});

test('direct grade values stay in range and respond to aim, low health and flashes', () => {
  const rest = directGradeValues(0, 0, 0);
  assert.equal(rest.vignette, DIRECT_GRADE.vignette);
  assert.deepEqual(rest.lift, [...DIRECT_GRADE.lift]);
  assert.ok(rest.lift[2] > rest.lift[0], 'the lift cools the shadows');
  assert.deepEqual([rest.red, rest.flash], [[0, 0, 0], 0]);
  const samples = [Number.NaN, -1, 0, 0.5, 1, 4];
  for (const graded of [false, true]) for (const lowHealth of samples) for (const flash of samples) for (const aim of samples) {
    const values = directGradeValues(lowHealth, flash, aim, graded);
    assert.ok(values.vignette >= DIRECT_GRADE.vignette - 1e-9 && values.vignette <= 0.9);
    assert.ok(values.flash >= 0 && values.flash <= 1);
    for (const channel of [...values.lift, ...values.red]) assert.ok(channel >= 0 && channel <= 0.25);
  }
  assert.ok(directGradeValues(0, 0, 1).vignette > rest.vignette, 'aiming narrows the view a little');
  const hurt = directGradeValues(1, 0, 0);
  assert.ok(hurt.vignette > rest.vignette && hurt.red[0] > 0.1 && hurt.red[0] > hurt.red[1] * 5, 'badly hurt: dark red edges');
  const white = directGradeValues(1, 1, 1);
  assert.equal(white.flash, 1);
  assert.deepEqual([white.lift, white.red], [[0, 0, 0], [0, 0, 0]], 'a full flash is pure white');
  const graded = directGradeValues(0, 0, 0, true);
  assert.deepEqual(graded.lift, [FILM_GRADE.lift, FILM_GRADE.lift, FILM_GRADE.lift], 'with graded tone mapping: the desktop look\'s neutral lift, no second cool tint');
  assert.deepEqual(directGradeValues(0, 1, 0, true).lift, [0, 0, 0]);
});

test('the direct grade draws over the frame without clearing it and restores the renderer', () => {
  const grade = new DirectGrade();
  const calls: Array<{ object: THREE.Object3D; autoClear: boolean }> = [];
  const renderer = { autoClear: true, toneMapping: THREE.ACESFilmicToneMapping as THREE.ToneMapping, render(object: THREE.Object3D) { calls.push({ object, autoClear: renderer.autoClear }); } };
  grade.setAim(1); grade.setCondition(1, 0.25);
  assert.equal(grade.material.uniforms.uVignette.value, directGradeValues(1, 0.25, 1).vignette);
  assert.equal(grade.material.uniforms.uFlash.value, 0.25);
  assert.ok((grade.material.uniforms.uRed.value as THREE.Vector3).x > 0);
  grade.render(renderer as unknown as THREE.WebGLRenderer);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].autoClear, false, 'drawn over the finished frame');
  assert.equal(renderer.autoClear, true, 'renderer state restored');
  assert.ok(calls[0].object instanceof THREE.Mesh && calls[0].object.frustumCulled === false);
  const position = ((calls[0].object as THREE.Mesh).geometry as THREE.BufferGeometry).getAttribute('position');
  assert.equal(position.count, 3, 'one triangle covers the screen');
  grade.setCondition(Number.NaN, Number.NaN);
  assert.deepEqual([grade.material.uniforms.uFlash.value, (grade.material.uniforms.uRed.value as THREE.Vector3).x], [0, 0]);
  grade.enabled = false; grade.render(renderer as unknown as THREE.WebGLRenderer);
  assert.equal(calls.length, 1, 'disabled draws nothing');

  const disposed: string[] = [];
  grade.material.addEventListener('dispose', () => disposed.push('material'));
  ((calls[0].object as THREE.Mesh).geometry as THREE.BufferGeometry).addEventListener('dispose', () => disposed.push('geometry'));
  grade.dispose();
  assert.deepEqual(disposed.sort(), ['geometry', 'material']);
});

test('the direct path can fold the film grade into tone mapping, installed once', () => withOriginalChunk(() => {
  const renderer = { toneMapping: THREE.ACESFilmicToneMapping as THREE.ToneMapping };
  assert.equal(hasGradedToneMapping(renderer), false);
  assert.equal(applyGradedToneMapping(renderer), true);
  assert.equal(renderer.toneMapping, THREE.CustomToneMapping);
  assert.equal(hasGradedToneMapping(renderer), true);
  const chunk = THREE.ShaderChunk.tonemapping_pars_fragment;
  assert.equal(chunk.match(/vec3 CustomToneMapping\(/g)?.length, 1, 'fills three\'s pass-through hook instead of adding a second definition');
  assert.ok(chunk.indexOf('vec3 ACESFilmicToneMapping(') < chunk.indexOf('vec3 CustomToneMapping('), 'defined after the ACES curve it builds on');
  assert.ok(chunk.includes(GRADED_TONE_MAPPING));
  assert.equal(applyGradedToneMapping(renderer), true);
  assert.equal(THREE.ShaderChunk.tonemapping_pars_fragment, chunk, 'installing twice changes nothing');
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  assert.equal(hasGradedToneMapping(renderer), false, 'only while the renderer uses it');
}));

test('the graded tone mapping is the desktop look\'s colour, as constants', () => {
  assert.match(GRADED_TONE_MAPPING, /vec3 CustomToneMapping\( vec3 color \) \{/);
  assert.match(GRADED_TONE_MAPPING, /sqrt\( ACESFilmicToneMapping\( color \) \)/, 'ACES Filmic first, as on desktop');
  for (const value of [FILM_GRADE.curve, FILM_GRADE.saturation, ...FILM_GRADE.shadowTint, ...FILM_GRADE.highlightTint]) {
    assert.ok(GRADED_TONE_MAPPING.includes(value.toFixed(6)), `uses ${value}`);
  }
  assert.match(GRADED_TONE_MAPPING, /return display \* display;/, 'back from square-root space exactly');
  assert.doesNotMatch(GRADED_TONE_MAPPING, /uniform|texture|sampler/, 'constants only: nothing extra to upload or read per material');
});

test('without three\'s custom tone mapping hook the renderer is left alone', () => withOriginalChunk(() => {
  THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment.replace('vec3 CustomToneMapping( vec3 color ) { return color; }', '');
  const renderer = { toneMapping: THREE.ACESFilmicToneMapping as THREE.ToneMapping };
  assert.equal(applyGradedToneMapping(renderer), false);
  assert.equal(renderer.toneMapping, THREE.ACESFilmicToneMapping);
}));

test('the direct grade notices graded tone mapping and drops its own cool lift', () => withOriginalChunk(() => {
  const grade = new DirectGrade();
  const renderer = { autoClear: true, toneMapping: THREE.ACESFilmicToneMapping as THREE.ToneMapping, render() {} };
  const lift = () => (grade.material.uniforms.uLift.value as THREE.Vector3).toArray();
  grade.render(renderer as unknown as THREE.WebGLRenderer);
  assert.deepEqual(lift(), [...DIRECT_GRADE.lift]);
  applyGradedToneMapping(renderer);
  grade.render(renderer as unknown as THREE.WebGLRenderer);
  assert.deepEqual(lift(), [...DIRECT_GRADE.gradedLift]);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  grade.render(renderer as unknown as THREE.WebGLRenderer);
  assert.deepEqual(lift(), [...DIRECT_GRADE.lift], 'and back');
  grade.dispose();
}));
