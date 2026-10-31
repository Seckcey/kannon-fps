import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { AIM_TAPS, AimFocusShader, ArenaPresentation, LOOK, LookShader, aimBlur, lookValues, presentationOptions, writesDepth } from '../../src/game/Presentation';
import { CONTACT_SCALE, applyGradedToneMapping } from '../../src/game/RenderQuality';
import { renderTier } from '../../src/game/RenderTiers';

// SMAA decodes two lookup images through `Image` when it is built. Node has no `Image` and never draws.
(globalThis as { Image?: unknown }).Image ??= class { src = ''; onload: (() => void) | null = null; };

const LUMA = [0.2126, 0.7152, 0.0722];
const luminance = (color: readonly number[]) => color[0] * LUMA[0] + color[1] * LUMA[1] + color[2] * LUMA[2];

interface Entry { op: 'render' | 'clear' | 'clearDepth'; target: string; what?: string; camera?: THREE.Camera; material?: THREE.Material }

/** Just enough of WebGLRenderer for the passes to run, recording every draw and clear in order. */
function fakeRenderer(width = 1280, height = 720) {
  const log: Entry[] = [];
  const targets = new Map<string, THREE.WebGLRenderTarget>();
  const names = new Map<THREE.WebGLRenderTarget, string>();
  let target: THREE.WebGLRenderTarget | null = null;
  const clearColor = new THREE.Color(0, 0, 0);
  let clearAlpha = 1;
  const label = (value: THREE.WebGLRenderTarget | null) => {
    if (value === null) return 'screen';
    let name = names.get(value);
    if (!name) { name = `target${names.size + 1}`; names.set(value, name); targets.set(name, value); }
    return name;
  };
  const renderer = {
    autoClear: true, autoClearColor: true, autoClearDepth: true, autoClearStencil: true,
    toneMapping: THREE.ACESFilmicToneMapping as THREE.ToneMapping, toneMappingExposure: 1, outputColorSpace: THREE.SRGBColorSpace,
    getPixelRatio: () => 1,
    getSize: (size: THREE.Vector2) => size.set(width, height),
    getRenderTarget: () => target,
    setRenderTarget: (next: THREE.WebGLRenderTarget | null) => { target = next; },
    getClearColor: (color: THREE.Color) => color.copy(clearColor),
    setClearColor: (color: THREE.ColorRepresentation, alpha?: number) => { clearColor.set(color); if (alpha !== undefined) clearAlpha = alpha; },
    getClearAlpha: () => clearAlpha,
    setClearAlpha: (alpha: number) => { clearAlpha = alpha; },
    clear: () => { log.push({ op: 'clear', target: label(target) }); },
    clearDepth: () => { log.push({ op: 'clearDepth', target: label(target) }); },
    render: (object: THREE.Object3D, camera: THREE.Camera) => {
      const material = object instanceof THREE.Mesh ? object.material as THREE.Material : undefined;
      log.push({ op: 'render', target: label(target), what: object.name || material?.name || object.type, camera, material });
    },
  };
  return { renderer: renderer as unknown as THREE.WebGLRenderer, log, targets };
}

function setup(options: ConstructorParameters<typeof ArenaPresentation>[3] = { bloom: true }) {
  const fake = fakeRenderer();
  const world = new THREE.Scene(); world.name = 'world';
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.06, 700);
  const presentation = new ArenaPresentation(fake.renderer, world, camera, options);
  presentation.resize(1280, 720);
  const viewmodel = new THREE.Scene(); viewmodel.name = 'viewmodel';
  viewmodel.add(new THREE.HemisphereLight('#ffffff', '#55504a', 1.4));
  const weapon = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.07, 0.5), new THREE.MeshStandardMaterial());
  weapon.name = 'weapon'; viewmodel.add(weapon);
  const viewCamera = new THREE.PerspectiveCamera(60, 16 / 9, 0.01, 10);
  return { ...fake, presentation, viewmodel, viewCamera, weapon };
}

const lookMaterial = (log: Entry[]) => {
  const entry = log.findLast(item => item.what === LookShader.name);
  assert.ok(entry?.material instanceof THREE.ShaderMaterial);
  return entry.material;
};

/** Draws between tone mapping and the grade: the edge smoothing. */
const edgePasses = (log: Entry[]) => {
  const output = log.findIndex(entry => entry.what === 'OutputShader');
  const look = log.findIndex(entry => entry.what === LookShader.name);
  return log.slice(output + 1, look).filter(entry => entry.op === 'render');
};

/** Width of the contact shading image: the first draw after the world. */
const contactWidth = (log: Entry[], targets: Map<string, THREE.WebGLRenderTarget>) => {
  const world = log.findIndex(entry => entry.what === 'world');
  return targets.get(log.slice(world + 1).find(entry => entry.op === 'render')!.target)!.width;
};

const drawsFocus = (log: Entry[]) => log.some(entry => entry.what === AimFocusShader.name);

test('the viewmodel is drawn inside render: depth cleared, after contact shading, before bloom and the grade', () => {
  const { presentation, log, viewmodel, viewCamera } = setup({ bloom: true, depthOfField: true });
  assert.equal(presentation.drawsOverlay, true);
  presentation.setOverlay(viewmodel, viewCamera);
  presentation.render(1 / 60);
  // An ordinary hip frame, after the first frame has built the weapon blur shader.
  log.length = 0; presentation.render(1 / 60);

  const world = log.findIndex(entry => entry.what === 'world');
  const overlay = log.findIndex(entry => entry.what === 'viewmodel');
  const output = log.findIndex(entry => entry.what === 'OutputShader');
  const look = log.findIndex(entry => entry.what === LookShader.name);
  assert.ok(world >= 0 && overlay > world && output > overlay && look > output, 'world, viewmodel, tone mapping, grade');
  const target = log[overlay].target;
  assert.deepEqual(log[overlay - 1], { op: 'clearDepth', target }, 'depth is cleared on the same image just before the viewmodel');
  assert.equal(log[overlay].camera, viewCamera);
  const shaded = log.slice(world + 1, overlay - 1).filter(entry => entry.op === 'render').at(-1);
  assert.equal(shaded?.target, target, 'the viewmodel lands on the contact-shaded world image');
  assert.ok(log.slice(overlay + 1, output).some(entry => entry.op === 'render' && entry.target === target), 'bloom adds onto the image with the viewmodel');
  assert.deepEqual([log.at(-1)?.what, log.at(-1)?.target], [LookShader.name, 'screen'], 'the grade is the last pass and draws to the canvas');
  assert.ok(!drawsFocus(log), 'no aim blur while not aiming');
});

test('the weapon blur shader is built on the first frame, at load, instead of on the first aim', () => {
  const { presentation, log, viewmodel, viewCamera } = setup({ bloom: true });
  presentation.setOverlay(viewmodel, viewCamera);
  presentation.render(1 / 60);
  const built = log.filter(entry => entry.what === AimFocusShader.name);
  assert.equal(built.length, 1, 'drawn once with the first frame');
  assert.equal((built[0].material as THREE.ShaderMaterial).uniforms.uBlur.value, 0, 'as a plain copy: nothing blurs');
  const at = log.indexOf(built[0]);
  assert.ok(at > log.findIndex(entry => entry.what === 'viewmodel') && at < log.findIndex(entry => entry.what === 'OutputShader'), 'in its usual place in the stack');
  assert.notEqual(built[0].target, log.find(entry => entry.what === 'viewmodel')!.target, 'into a fresh image, as when aiming');

  log.length = 0; presentation.render(1 / 60);
  assert.ok(!drawsFocus(log), 'after that, hip frames cost nothing extra');
  presentation.setAim(1, 25); log.length = 0; presentation.render(1 / 60);
  assert.ok(drawsFocus(log), 'the first aim uses the shader built at load');

  const off = setup({ bloom: true, depthOfField: false });
  off.presentation.setOverlay(off.viewmodel, off.viewCamera); off.presentation.render(1 / 60);
  assert.ok(!drawsFocus(off.log), 'without depth of field there is nothing to build');
  off.presentation.configure({ bloom: true, depthOfField: true });
  off.log.length = 0; off.presentation.render(1 / 60);
  assert.equal(off.log.filter(entry => entry.what === AimFocusShader.name).length, 1, 'turned on later, it is built on the next frame');
  off.log.length = 0; off.presentation.render(1 / 60);
  assert.ok(!drawsFocus(off.log));
});

test('contact shading multiplies into the world image in place, without copying the frame', () => {
  const { presentation, log, viewmodel, viewCamera } = setup({ bloom: true });
  presentation.setOverlay(viewmodel, viewCamera);
  presentation.render(1 / 60);
  const world = log.findIndex(entry => entry.what === 'world');
  const overlay = log.findIndex(entry => entry.what === 'viewmodel');
  const between = log.slice(world + 1, overlay).filter(entry => entry.op === 'render');
  const worldTarget = log[world].target;
  assert.equal(log[overlay].target, worldTarget, 'the viewmodel goes onto the same image');
  assert.equal(between.at(-1)?.target, worldTarget, 'occlusion lands on the world image');
  assert.equal(between.filter(entry => entry.target === worldTarget).length, 1, 'one multiply, no copy');
  assert.ok(between.every(entry => entry.target !== 'screen'));
});

test('anti-aliasing: one FXAA pass unless SMAA is asked for (High)', () => {
  const fxaa = setup({ bloom: true, depthOfField: true }); fxaa.presentation.render(1 / 60);
  assert.deepEqual(edgePasses(fxaa.log).map(entry => entry.what), ['FXAAShader'], 'GameView\'s bare { bloom, depthOfField } never costs more than Automatic');
  const material = edgePasses(fxaa.log)[0].material as THREE.ShaderMaterial;
  assert.deepEqual((material.uniforms.resolution.value as THREE.Vector2).toArray(), [1 / 1280, 1 / 720]);
  const smaa = setup({ bloom: true, antialias: 'smaa' }); smaa.presentation.render(1 / 60);
  assert.equal(edgePasses(smaa.log).length, 3, 'SMAA: edges, weights, blend');
});

test('without an overlay the stack renders the world only', () => {
  const { presentation, log, viewmodel, viewCamera } = setup();
  presentation.render(1 / 60);
  presentation.setAim(1, 20);
  log.length = 0; presentation.render(1 / 60);
  assert.ok(!log.some(entry => entry.what === 'viewmodel' || entry.op === 'clearDepth' || entry.what === AimFocusShader.name));
  presentation.setOverlay(viewmodel, viewCamera); presentation.setOverlay(null, null);
  log.length = 0; presentation.render(1 / 60);
  assert.ok(!log.some(entry => entry.what === 'viewmodel' || entry.what === AimFocusShader.name), 'clearing the overlay stops drawing it');
});

test('aiming blurs the weapon from the viewmodel depth and stops when the aim ends', () => {
  const { presentation, log, targets, viewmodel, viewCamera } = setup({ bloom: true, depthOfField: true });
  presentation.setOverlay(viewmodel, viewCamera);
  presentation.setAim(1, 25);
  presentation.render(1 / 60);
  const overlay = log.findIndex(entry => entry.what === 'viewmodel');
  const focus = log.findIndex(entry => entry.what === AimFocusShader.name);
  const output = log.findIndex(entry => entry.what === 'OutputShader');
  assert.ok(overlay >= 0 && focus > overlay && output > focus, 'the weapon blur runs after the viewmodel and before tone mapping');
  const material = log[focus].material as THREE.ShaderMaterial;
  const source = targets.get(log[overlay].target)!;
  assert.notEqual(log[focus].target, log[overlay].target, 'it writes a fresh image, never the one it reads');
  assert.equal(material.uniforms.tDiffuse.value, source.texture);
  assert.equal(material.uniforms.tDepth.value, source.depthTexture, 'weapon pixels are found from the viewmodel depth');
  assert.ok(material.uniforms.uBlur.value > 0 && material.uniforms.uBlur.value <= LOOK.aim.maxBlur);
  assert.equal(material.depthTest, false); assert.equal(material.depthWrite, false);

  presentation.setAim(0, 25); log.length = 0; presentation.render(1 / 60);
  assert.ok(!drawsFocus(log), 'hip fire costs nothing extra');
});

test('the weapon blur stops by itself while the viewmodel hides everything (fully scoped)', () => {
  const { presentation, log, viewmodel, viewCamera, weapon } = setup({ bloom: true });
  presentation.setOverlay(viewmodel, viewCamera); presentation.setAim(1, 25);
  const blurs = () => { log.length = 0; presentation.render(1 / 60); return drawsFocus(log); };
  assert.equal(blurs(), true);
  weapon.visible = false;
  assert.equal(blurs(), false, 'scoped: the weapon and arms are hidden but the aim blend stays full');
  assert.ok(log.some(entry => entry.what === 'viewmodel'), 'the viewmodel pass itself still runs (it is cheap)');
  weapon.visible = true; viewmodel.visible = false;
  assert.equal(blurs(), false, 'the whole viewmodel hidden');
  viewmodel.visible = true;
  assert.equal(blurs(), true, 'back as soon as the weapon shows');
});

test('the weapon blur looks only for what the viewmodel leaves in the depth buffer', () => {
  const camera = new THREE.PerspectiveCamera();
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(), new THREE.DirectionalLight());
  assert.equal(writesDepth(scene, camera.layers), false, 'lights alone leave nothing');
  const holder = new THREE.Group(); scene.add(holder);
  const material = new THREE.MeshStandardMaterial();
  const weapon = new THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>(new THREE.BoxGeometry(), material); holder.add(weapon);
  assert.equal(writesDepth(scene, camera.layers), true);
  holder.visible = false; assert.equal(writesDepth(scene, camera.layers), false, 'a hidden parent hides its children');
  holder.visible = true; weapon.layers.set(3); assert.equal(writesDepth(scene, camera.layers), false, 'other layers are not drawn');
  weapon.layers.set(0); material.visible = false; assert.equal(writesDepth(scene, camera.layers), false, 'an invisible material is not drawn');
  material.visible = true; material.depthWrite = false; assert.equal(writesDepth(scene, camera.layers), false, 'flashes and smoke leave no depth');
  material.depthWrite = true; material.depthTest = false; assert.equal(writesDepth(scene, camera.layers), false, 'no depth test means no depth write');
  material.depthTest = true;
  weapon.material = [new THREE.MeshBasicMaterial({ depthWrite: false }), material];
  assert.equal(writesDepth(scene, camera.layers), true, 'any material of a multi-material mesh');
  holder.remove(weapon);
  const casings = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial(), 8); holder.add(casings);
  casings.count = 0; assert.equal(writesDepth(scene, camera.layers), false, 'an empty instanced mesh draws nothing');
  casings.count = 3; assert.equal(writesDepth(scene, camera.layers), true);
  scene.visible = false; assert.equal(writesDepth(scene, camera.layers), false);
});

test('depth of field can be turned off and is on by default for the desktop stack', () => {
  const off = setup({ bloom: true, depthOfField: false });
  off.presentation.setOverlay(off.viewmodel, off.viewCamera); off.presentation.setAim(1, 25); off.presentation.render(1 / 60);
  assert.ok(!drawsFocus(off.log));
  const defaulted = setup({ bloom: true });
  defaulted.presentation.setOverlay(defaulted.viewmodel, defaulted.viewCamera); defaulted.presentation.setAim(1, 25); defaulted.presentation.render(1 / 60);
  assert.ok(drawsFocus(defaulted.log));
});

test('render applies condition, aim, grain and resolution to the grade', () => {
  const { presentation, log } = setup({ bloom: true });
  presentation.render(1 / 60);
  const rest = lookMaterial(log).uniforms;
  assert.equal(rest.uSaturation.value, LOOK.grade.saturation);
  assert.equal(rest.uFlash.value, 0); assert.equal(rest.uRed.value, 0); assert.equal(rest.uAberration.value, 0);
  assert.deepEqual((rest.uResolution.value as THREE.Vector2).toArray(), [1280, 720]);
  const restVignette = rest.uVignette.value, restSeed = rest.uSeed.value;

  presentation.setCondition(1, 0.5); presentation.setAim(1, 30);
  log.length = 0; presentation.render(0.05);
  const hurt = lookMaterial(log).uniforms;
  assert.ok(hurt.uSaturation.value < LOOK.grade.saturation, 'low health drains colour');
  assert.ok(hurt.uVignette.value > restVignette && hurt.uRed.value > 0, 'and darkens and reddens the edges');
  assert.equal(hurt.uFlash.value, 0.5);
  assert.notEqual(hurt.uSeed.value, restSeed, 'grain moves with time');

  presentation.setCondition(Number.NaN, -3);
  log.length = 0; presentation.render(Number.NaN);
  const cleared = lookMaterial(log).uniforms;
  assert.equal(cleared.uRed.value, 0); assert.equal(cleared.uFlash.value, 0);
});

test('chromatic aberration is compiled in only when asked for (High)', () => {
  const high = setup({ bloom: true, chromaticAberration: true }); high.presentation.render(1 / 60);
  const highLook = lookMaterial(high.log);
  assert.ok('CHROMATIC' in highLook.defines);
  assert.ok(highLook.uniforms.uAberration.value > 0 && highLook.uniforms.uAberration.value <= 3);
  const plain = setup({ bloom: true }); plain.presentation.render(1 / 60);
  const plainLook = lookMaterial(plain.log);
  assert.ok(!('CHROMATIC' in plainLook.defines));
  assert.equal(plainLook.uniforms.uAberration.value, 0);
});

test('configure switches between the Automatic and High stacks in place', () => {
  const { presentation, log, targets } = setup(presentationOptions(renderTier('auto', false, true)));
  const frame = () => { log.length = 0; presentation.render(1 / 60); return [...log]; };
  let entries = frame();
  assert.deepEqual(edgePasses(entries).map(entry => entry.what), ['FXAAShader']);
  assert.ok(!('CHROMATIC' in lookMaterial(entries).defines));
  assert.equal(contactWidth(entries, targets), Math.floor(1280 * 0.35));
  const replaced = new Set<THREE.Material>(edgePasses(entries).map(entry => entry.material!));
  const disposed = new Set<unknown>();
  for (const material of replaced) material.addEventListener('dispose', () => disposed.add(material));

  presentation.configure(presentationOptions(renderTier('high', false, true)));
  assert.equal(disposed.size, replaced.size, 'the replaced edge smoothing is released at once');
  entries = frame();
  assert.equal(edgePasses(entries).length, 3, 'SMAA: edges, weights, blend');
  const highLook = lookMaterial(entries);
  assert.ok('CHROMATIC' in highLook.defines && highLook.uniforms.uAberration.value > 0, 'edge fringing on');
  assert.equal(contactWidth(entries, targets), Math.floor(1280 * 0.6));
  assert.deepEqual([entries.at(-1)?.what, entries.at(-1)?.target], [LookShader.name, 'screen'], 'the grade stays last');

  const smaa = new Set<THREE.Material>(edgePasses(entries).map(entry => entry.material!));
  for (const material of smaa) material.addEventListener('dispose', () => disposed.add(material));
  presentation.configure(presentationOptions(renderTier('auto', false, true)));
  assert.ok([...smaa].every(material => disposed.has(material)), 'SMAA is released when going back');
  entries = frame();
  assert.deepEqual(edgePasses(entries).map(entry => entry.what), ['FXAAShader']);
  const autoLook = lookMaterial(entries);
  assert.ok(!('CHROMATIC' in autoLook.defines));
  assert.equal(autoLook.uniforms.uAberration.value, 0);
  assert.equal(contactWidth(entries, targets), Math.floor(1280 * 0.35));

  // Bloom's blur passes are the only ones with a KERNEL_RADIUS.
  const bloomDraws = (list: Entry[]) => list.filter(entry => entry.material instanceof THREE.ShaderMaterial && 'KERNEL_RADIUS' in entry.material.defines).length;
  assert.ok(bloomDraws(entries) > 0);
  presentation.configure({ bloom: false });
  assert.equal(bloomDraws(frame()), 0, 'bloom can be switched off');
  presentation.configure({ bloom: true });
  assert.ok(bloomDraws(frame()) > 0, 'and on again');
});

test('the desktop look tone-maps with plain ACES Filmic even when the direct path grades in tone mapping', () => {
  const original = THREE.ShaderChunk.tonemapping_pars_fragment;
  try {
    const { presentation, renderer, log } = setup();
    assert.equal(applyGradedToneMapping(renderer), true);
    presentation.render(1 / 60);
    const output = log.find(entry => entry.what === 'OutputShader')!.material as THREE.ShaderMaterial;
    assert.ok('ACES_FILMIC_TONE_MAPPING' in output.defines && !('CUSTOM_TONE_MAPPING' in output.defines), 'graded once, by the look pass');
    assert.equal(renderer.toneMapping, THREE.CustomToneMapping, 'the direct path keeps its graded tone mapping');
  } finally {
    THREE.ShaderChunk.tonemapping_pars_fragment = original;
  }
});

test('look values stay in range for any condition, including bad input', () => {
  const rest = lookValues({ lowHealth: 0, flash: 0, aim: 0, time: 0, height: 1080, chromatic: false });
  assert.equal(rest.saturation, LOOK.grade.saturation);
  assert.equal(rest.vignette, LOOK.grade.vignette);
  assert.deepEqual([rest.red, rest.flash, rest.aberration, rest.seed], [0, 0, 0, 0]);
  const samples = [Number.NaN, -1, 0, 0.25, 0.5, 1, 2, Number.POSITIVE_INFINITY];
  for (const lowHealth of samples) for (const flash of samples) for (const aim of samples) {
    const values = lookValues({ lowHealth, flash, aim, time: 12.34, height: 1440, chromatic: true });
    for (const value of Object.values(values)) assert.ok(Number.isFinite(value));
    assert.ok(values.saturation >= LOOK.condition.saturation - 1e-9 && values.saturation <= LOOK.grade.saturation + 1e-9);
    assert.ok(values.vignette >= LOOK.grade.vignette - 1e-9 && values.vignette <= 0.9);
    assert.ok(values.red >= 0 && values.red <= 1 && values.flash >= 0 && values.flash <= 1);
    assert.ok(values.grain >= 0 && values.grain <= LOOK.grade.grain);
    assert.ok(Number.isInteger(values.seed) && values.seed >= 0 && values.seed < 256);
    assert.ok(values.aberration > 0 && values.aberration <= 3);
  }
  const worse = [0, 0.5, 1].map(lowHealth => lookValues({ lowHealth, flash: 0, aim: 0, time: 0, height: 1080, chromatic: false }));
  assert.ok(worse[0].saturation > worse[1].saturation && worse[1].saturation > worse[2].saturation);
  assert.ok(worse[0].red < worse[1].red && worse[1].red < worse[2].red);
  const flash = lookValues({ lowHealth: 0, flash: 1, aim: 0, time: 0, height: 1080, chromatic: false });
  assert.equal(flash.flash, 1); assert.equal(flash.grain, 0, 'a full white-out hides the grain');
  assert.ok(lookValues({ lowHealth: 0, flash: 0, aim: 1, time: 0, height: 1080, chromatic: false }).vignette > rest.vignette, 'aiming narrows the view a little');
  assert.notEqual(lookValues({ lowHealth: 0, flash: 0, aim: 0, time: 0.5, height: 1080, chromatic: false }).seed, rest.seed);
  assert.equal(lookValues({ lowHealth: 0, flash: 0, aim: 0, time: Number.NaN, height: Number.NaN, chromatic: true }).aberration, LOOK.grade.aberration);
});

test('the grade is gritty and filmic but subtle', () => {
  const { grade, bloom } = LOOK;
  assert.ok(grade.saturation >= 0.85 && grade.saturation <= 0.95, 'slightly drained colour');
  assert.ok(grade.curve > 0 && grade.curve < 0.6, 'a gentle S-curve');
  assert.ok(grade.lift >= 0 && grade.lift <= 0.03);
  assert.ok(Math.abs(luminance(grade.shadowTint)) < 1e-9 && Math.abs(luminance(grade.highlightTint)) < 1e-9, 'split toning shifts hue, never brightness');
  assert.ok(grade.shadowTint[2] > grade.shadowTint[0], 'cool shadows');
  assert.ok(grade.highlightTint[0] > grade.highlightTint[2], 'warm highlights');
  assert.ok(grade.vignette > 0.2 && grade.vignette < 0.5);
  assert.ok(grade.grain > 0 && grade.grain <= 0.05, 'grain is subtle');
  assert.ok(grade.aberration > 0 && grade.aberration <= 2, 'aberration is slight');
  assert.ok(bloom.threshold > 1.5, 'the sky (about 1.5) never glows; flashes and explosions do');
  assert.ok(bloom.strength > 0 && bloom.strength + bloom.flashBoost <= 1);
});

test('shader definitions use every uniform they declare', () => {
  for (const shader of [LookShader, AimFocusShader]) {
    for (const name of Object.keys(shader.uniforms)) assert.match(shader.fragmentShader, new RegExp(`\\b${name}\\b`), `${shader.name} uses ${name}`);
    assert.match(shader.vertexShader, /vUv = uv/);
  }
  assert.match(LookShader.fragmentShader, /#ifdef CHROMATIC/);
  assert.ok(LookShader.uniforms.uSaturation.value > 0.85 && LookShader.uniforms.uSaturation.value < 0.95);
  assert.equal(Number(AimFocusShader.defines.TAP_COUNT), AIM_TAPS.length);
  assert.ok(Number(AimFocusShader.defines.WEAPON_DEPTH) < 1, 'cleared depth (1.0) is the world, never the weapon');
  assert.equal((AimFocusShader.fragmentShader.match(/vec2\(-?\d\.\d{6},-?\d\.\d{6}\)/g) ?? []).length, AIM_TAPS.length, 'every tap is written into the shader');
});

test('aim blur keeps the aim point sharp and stays bounded', () => {
  assert.equal(aimBlur(0, 20, 1080), 0);
  assert.equal(aimBlur(Number.NaN, 20, 1080), 0);
  const ramp = [0.25, 0.5, 0.75, 1].map(blend => aimBlur(blend, 20, 1080));
  for (let i = 1; i < ramp.length; i++) assert.ok(ramp[i] > ramp[i - 1], 'the blur grows as the sight comes up');
  assert.ok(ramp[3] > 3 && ramp[3] <= LOOK.aim.blur);
  assert.ok(aimBlur(1, 20, 720) < ramp[3], 'measured in pixels of the scene image');
  assert.ok(aimBlur(1, 20, 4320) <= LOOK.aim.maxBlur, 'capped on very large images');
  assert.ok(aimBlur(1, 1, 1080) < aimBlur(1, 30, 1080), 'focusing on something close blurs the weapon less');
  assert.equal(aimBlur(1, Number.NaN, 1080), aimBlur(1, Number.POSITIVE_INFINITY, 1080));
  assert.equal(aimBlur(1, -2, 1080), aimBlur(1, Number.POSITIVE_INFINITY, 1080));
  assert.ok(aimBlur(1, 0.1, 1080) >= 0);
  const { uSharpRadius, uFullRadius } = AimFocusShader.uniforms;
  assert.ok(uSharpRadius.value > 0.05 && uSharpRadius.value < uFullRadius.value && uFullRadius.value <= 1, 'the centre of the screen is never blurred');
  // The radii are in half screen heights: the shader doubles the offset from the centre.
  assert.match(AimFocusShader.fragmentShader, /\( vUv - 0\.5 \) \* vec2\( uResolution\.x \/ uResolution\.y, 1\.0 \) \* 2\.0/);
  assert.ok(Math.abs(uSharpRadius.value * 540 - 65) < 1, 'sharp within about 65 px of the centre on a 1080-line image');
  assert.equal(AIM_TAPS.length, 16);
  for (const [x, y] of AIM_TAPS) assert.ok(Math.hypot(x, y) <= 1 + 1e-9);
  const mean = AIM_TAPS.reduce((sum, [x, y]) => [sum[0] + x / AIM_TAPS.length, sum[1] + y / AIM_TAPS.length], [0, 0]);
  assert.ok(Math.hypot(mean[0], mean[1]) < 0.12, 'taps are spread evenly around the pixel');
});

test('contact shading runs at the requested share of the scene resolution', () => {
  const occlusionWidth = (options: ConstructorParameters<typeof ArenaPresentation>[3]) => {
    const { presentation, log, targets } = setup(options);
    presentation.render(1 / 60);
    return contactWidth(log, targets);
  };
  assert.equal(occlusionWidth({ bloom: true }), Math.floor(1280 * CONTACT_SCALE.automatic), 'Automatic\'s share unless asked');
  assert.equal(occlusionWidth({ bloom: true, contactScale: 0.6 }), 768);
  assert.equal(occlusionWidth({ bloom: true, contactScale: Number.NaN }), Math.floor(1280 * CONTACT_SCALE.automatic));
  assert.equal(occlusionWidth({ bloom: true, contactScale: 0.1 }), 320, 'never below a quarter');
  assert.equal(occlusionWidth({ bloom: true, contactScale: 5 }), 1280, 'never above the scene resolution');
});

for (const options of [{ bloom: true, chromaticAberration: true, antialias: 'smaa' as const }, { bloom: false, contactScale: 0.5 }]) test(`dispose releases every owned target, texture and material, but not the viewmodel (${JSON.stringify(options)})`, () => {
  const { presentation, renderer, viewmodel, viewCamera } = setup(options);
  const weaponMaterial = new THREE.MeshStandardMaterial();
  viewmodel.add(new THREE.Mesh(new THREE.BoxGeometry(), weaponMaterial));
  presentation.setOverlay(viewmodel, viewCamera); presentation.setAim(1, 10);
  presentation.render(1 / 60);

  const targets = new Set<THREE.WebGLRenderTarget>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
  const seen = new Set<unknown>([renderer]);
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 8) return;
    seen.add(value);
    if (value instanceof THREE.WebGLRenderTarget) { targets.add(value); return; }
    if (value instanceof THREE.Texture) { if (!value.renderTarget) textures.add(value); return; }
    if (value instanceof THREE.Object3D || value instanceof THREE.BufferGeometry) return;
    if (value instanceof THREE.Material) materials.add(value);
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child, depth + 1);
  };
  visit(presentation, 0);
  assert.ok(targets.size >= 5 && materials.size >= 9, `found ${targets.size} targets and ${materials.size} materials`);
  assert.ok(!materials.has(weaponMaterial));

  const disposed = new Set<unknown>();
  for (const item of [...targets, ...materials, ...textures, weaponMaterial]) item.addEventListener('dispose', () => disposed.add(item));
  presentation.dispose();
  const describe = (item: THREE.WebGLRenderTarget | THREE.Material | THREE.Texture) =>
    item instanceof THREE.WebGLRenderTarget ? item.texture.name || 'render target' : item.name || item.constructor.name;
  const leaked = [...targets, ...materials, ...textures].filter(item => !disposed.has(item)).map(describe);
  assert.deepEqual(leaked, []);
  assert.ok(!disposed.has(weaponMaterial), 'the viewmodel belongs to its owner');
});
