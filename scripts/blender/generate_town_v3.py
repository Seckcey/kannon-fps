"""Kannon Town v3: the v2 town re-dressed as a military checkpoint after an evacuation, re-baked
at golden hour.

Built on generate_town_v2.py (same CC0 materials, props, grass, bushes and lightmap pipeline).
v3 adds render geometry for the eight checkpoint cover boxes in shared/map.ts (stacked sandbag
walls and concrete barriers, exactly on their collision boxes), re-skins the box truck as a
canvas-covered military cargo truck and the school bus as a dusty evacuation bus in their own
footprints, burns out the north car, stacks ammunition crates under tarps in the three prop
cover boxes, boards up windows, strings wire along the boundary fences, adds breakable window
panes (Breakable_Glass_*, two of them already broken) and plant pots (Breakable_Pot_*), traffic
cones, rubble, splinters and spent cases, ground decals and distant smoke columns, and bakes a
low, warm sun with long shadows across the street and cool sky light in the shade.

Every lightmap carries a sun mask in a companion image (the share of each texel's baked light
that is direct sun), so the runtime can let a character's shadow take away the baked sun and
nothing else. The pots are baked in their own atlas and are invisible to the other groups'
bakes: their shadows are real-time and leave with them when they shatter.

Stages (run in order, or --stage all):
  prepare  open art/source/kannon-town-graphics.blend, retexture, place props, dress the
           checkpoint, add guides and the golden-hour sun and sky, save
           art/source/town-v3/kannon-town-v3.blend (ignored by git)
  uv       lightmap-unwrap the four atlas groups into a 'Lightmap' UV layer and save
  preview  render Cycles viewpoints at low samples to art/source/town-v3/preview-*.png
  bake     calibrate against the real-time sun, bake diffuse direct+indirect per atlas and the
           direct sun alone, write LM_*.png, the LM_*_sun.png masks and the finish-script
           sidecar art/source/town-v3/town-v3-lightmaps.json
  export   write art/source/town-v3/town-v3-raw.glb (uncompressed; finish_town_v3.mjs compresses)
  shade    (optional) re-measure the wire's and grass cards' sun visibility in the working file;
           prepare already does it, and it does not affect the bake

node scripts/blender/run_blender.mjs --python scripts/blender/generate_town_v3.py -- --stage all [--samples 128] [--atlas 2048]

Provenance: base geometry is the repository's own refined town; textures and props are CC0
Poly Haven assets listed in art/source/town-v2/cc0-manifest.json (see art/PURCHASED_ASSETS.md).
Sandbags, barriers' geometry, crates, wire, decals, smoke and every procedural texture are
original to this script.
"""
import argparse, json, math, os, random, sys, time
from pathlib import Path

import bpy, bmesh
import numpy as np
from mathutils import Euler, Matrix, Vector

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'art/source'
OUT = SOURCE / 'town-v3'
sys.path.insert(0, str(ROOT / 'scripts/blender'))
import import_collision_layout as guides  # noqa: E402

MANIFEST = json.loads((SOURCE / 'town-v2' / 'cc0-manifest.json').read_text(encoding='utf-8'))
MAP = json.loads((OUT / 'map.json').read_text(encoding='utf-8'))
BASE_BLEND = SOURCE / 'kannon-town-graphics.blend'
WORK_BLEND = OUT / 'kannon-town-v3.blend'  # working file with packed textures; regenerated, not committed

# Golden-hour light. These numbers are the bake's half of src/game/Atmosphere.ts; the asset test
# tests/assets/town-v3-light.test.ts proves the two agree through the sidecar the bake writes.
SUN_DIRECTION_GAME = Vector((-0.8461, 0.3584, 0.3946)).normalized()  # Atmosphere.ts SUN_DIRECTION
SUN_COLOR_SRGB = (1.0, 0.788, 0.561)   # Atmosphere.ts SUN_COLOR '#ffc98f' (about 3800 K)
SUN_INTENSITY_RUNTIME = 5.2            # Atmosphere.ts SUN_INTENSITY, three.js irradiance units
SUN_STRENGTH = 4.0                     # Blender irradiance of the sun lamp (W/m2)
SUN_ANGLE_DEG = 1.2                    # low sun, slightly soft shadow edges
SKY_FRACTION = 0.2                     # sky-only irradiance on an open, upward surface / sun strength
LIGHTMAP_HEADROOM = 1.3                # stored 1.0 = this many times the sun strength
EXPOSURE_RUNTIME = 1.0                 # Atmosphere.ts EXPOSURE; previews use the same brightness
# Cycles bakes the diffuse light pass as irradiance / pi (the radiance of a white Lambertian
# surface); three.js lightmaps and lights are irradiance. Every baked value is scaled by pi.
BAKE_TO_IRRADIANCE = math.pi
rng = random.Random(9102026)


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


SUN_COLOR_LINEAR = tuple(srgb_to_linear(c) for c in SUN_COLOR_SRGB)


def log(*parts):
    print('[town-v3]', *parts, flush=True)


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', default='all')
    parser.add_argument('--samples', type=int, default=128)
    parser.add_argument('--atlas', type=int, default=2048)
    parser.add_argument('--preview-samples', type=int, default=48)
    parser.add_argument('--views', default='')
    return parser.parse_args(argv)


def gb(x, y, z):
    """Game (Y up) to Blender (Z up)."""
    return Vector((x, -z, y))


def bg(v):
    """Blender to game."""
    return (v.x, v.z, -v.y)


# ---------------------------------------------------------------------------------------------
# Materials
# ---------------------------------------------------------------------------------------------

def asset_path(asset_id, key):
    return MANIFEST['assets'][asset_id]['files'][key]['path']


def load_image(path, noncolor=False):
    image = bpy.data.images.load(path, check_existing=True)
    image.colorspace_settings.name = 'Non-Color' if noncolor else 'sRGB'
    return image


def gltf_output_group():
    """The node group Blender's glTF exporter reads ambient occlusion from."""
    group = bpy.data.node_groups.get('glTF Material Output')
    if group:
        return group
    group = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
    group.interface.new_socket(name='Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
    group.nodes.new('NodeGroupInput')
    return group


def flattened_diffuse(asset_id, amount):
    """A copy of the asset's diffuse map blended `amount` toward its mean colour, so board-to-board
    contrast does not read as stripes across a whole facade."""
    target = OUT / 'textures' / f'{asset_id}_flat_{int(amount * 100)}.png'
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        source = bpy.data.images.load(asset_path(asset_id, 'Diffuse'), check_existing=False)
        width, height = source.size
        pixels = np.empty(width * height * 4, np.float32)
        source.pixels.foreach_get(pixels)
        rgba = pixels.reshape(height, width, 4)
        mean = rgba[:, :, :3].reshape(-1, 3).mean(axis=0)
        rgba[:, :, :3] = rgba[:, :, :3] * (1 - amount) + mean[None, None, :] * amount
        flat = bpy.data.images.new(f'{asset_id}_flat', width, height, alpha=False)
        flat.colorspace_settings.name = 'sRGB'
        flat.pixels.foreach_set(rgba.ravel())
        flat.filepath_raw = str(target); flat.file_format = 'PNG'; flat.save()
        bpy.data.images.remove(source); bpy.data.images.remove(flat)
    return str(target)


def pbr_material(name, asset_id, tile, rotation=0.0, vertex_color=True, roughness_offset=0.0, normal_strength=1.0, double_sided=False, alpha=False, flatten=0.0):
    """Principled material from a Poly Haven texture set, tiled every `tile` metres over
    world-space UVs, optionally multiplied by the 'Color' vertex attribute."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.use_backface_culling = not double_sided
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes['Principled BSDF']
    uv = nodes.new('ShaderNodeUVMap'); uv.uv_map = 'UVMap'
    mapping = nodes.new('ShaderNodeMapping')
    mapping.inputs['Scale'].default_value = (1.0 / tile, 1.0 / tile, 1.0)
    mapping.inputs['Rotation'].default_value = (0.0, 0.0, math.radians(rotation))
    links.new(uv.outputs['UV'], mapping.inputs['Vector'])
    files = MANIFEST['assets'][asset_id]['files']
    diffuse = nodes.new('ShaderNodeTexImage'); diffuse.image = load_image(flattened_diffuse(asset_id, flatten) if flatten else files['Diffuse']['path'])
    links.new(mapping.outputs['Vector'], diffuse.inputs['Vector'])
    if vertex_color:
        attribute = nodes.new('ShaderNodeVertexColor'); attribute.layer_name = 'Color'
        mix = nodes.new('ShaderNodeMixRGB'); mix.blend_type = 'MULTIPLY'; mix.inputs['Fac'].default_value = 1.0
        links.new(diffuse.outputs['Color'], mix.inputs['Color1']); links.new(attribute.outputs['Color'], mix.inputs['Color2'])
        links.new(mix.outputs['Color'], bsdf.inputs['Base Color'])
    else:
        links.new(diffuse.outputs['Color'], bsdf.inputs['Base Color'])
    normal_image = nodes.new('ShaderNodeTexImage'); normal_image.image = load_image(files['nor_gl']['path'], True)
    links.new(mapping.outputs['Vector'], normal_image.inputs['Vector'])
    normal_map = nodes.new('ShaderNodeNormalMap'); normal_map.inputs['Strength'].default_value = normal_strength
    links.new(normal_image.outputs['Color'], normal_map.inputs['Color']); links.new(normal_map.outputs['Normal'], bsdf.inputs['Normal'])
    if 'arm' in files:
        arm = nodes.new('ShaderNodeTexImage'); arm.image = load_image(files['arm']['path'], True)
        links.new(mapping.outputs['Vector'], arm.inputs['Vector'])
        separate = nodes.new('ShaderNodeSeparateColor')
        links.new(arm.outputs['Color'], separate.inputs['Color'])
        links.new(separate.outputs['Green'], bsdf.inputs['Roughness'])
        links.new(separate.outputs['Blue'], bsdf.inputs['Metallic'])
        occlusion = nodes.new('ShaderNodeGroup'); occlusion.node_tree = gltf_output_group()
        links.new(separate.outputs['Red'], occlusion.inputs['Occlusion'])
    elif 'Rough' in files:
        rough = nodes.new('ShaderNodeTexImage'); rough.image = load_image(files['Rough']['path'], True)
        links.new(mapping.outputs['Vector'], rough.inputs['Vector'])
        links.new(rough.outputs['Color'], bsdf.inputs['Roughness'])
    if alpha:
        links.new(diffuse.outputs['Alpha'], bsdf.inputs['Alpha'])
    mat['tileMetres'] = tile
    mat['roughnessOffset'] = roughness_offset
    mat['provenance'] = f'Poly Haven {asset_id} (CC0 1.0), see art/source/town-v2/cc0-manifest.json'
    return mat


def plain_material(name, color, roughness, metallic=0.0, vertex_color=True, double_sided=False):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.use_backface_culling = not double_sided
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*color, 1.0)
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = metallic
    if vertex_color:
        attribute = nodes.new('ShaderNodeVertexColor'); attribute.layer_name = 'Color'
        mix = nodes.new('ShaderNodeMixRGB'); mix.blend_type = 'MULTIPLY'; mix.inputs['Fac'].default_value = 1.0
        mix.inputs['Color1'].default_value = (*color, 1.0)
        links.new(attribute.outputs['Color'], mix.inputs['Color2'])
        links.new(mix.outputs['Color'], bsdf.inputs['Base Color'])
    mat['provenance'] = 'Original Kannon material.'
    return mat


TEXTURES = OUT / 'textures'


def periodic_noise(size, feature_px, seed, height=None):
    """Tileable smooth noise with unit variance: white noise low-passed in the frequency domain
    by a Gaussian of `feature_px` pixels, so it wraps seamlessly on both axes."""
    h = height or size
    r = np.random.default_rng(seed)
    white = r.standard_normal((h, size))
    fy = np.fft.fftfreq(h)[:, None]; fx = np.fft.fftfreq(size)[None, :]
    response = np.exp(-2.0 * (math.pi ** 2) * (feature_px ** 2) * (fx ** 2 + fy ** 2))
    field = np.real(np.fft.ifft2(np.fft.fft2(white) * response))
    return (field / (field.std() + 1e-9)).astype(np.float32)


def fbm(size, feature_px, seed, octaves=4, height=None):
    total = np.zeros((height or size, size), np.float32); amplitude = 1.0; norm = 0.0
    for octave in range(octaves):
        total += amplitude * periodic_noise(size, feature_px / (2 ** octave), seed + octave * 101, height)
        norm += amplitude; amplitude *= 0.5
    return total / norm


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def save_texture(name, data, noncolor=False):
    """Write an H x W x 3|4 float array (row 0 is the bottom of the image) as a PNG under
    art/source/town-v3/textures and return its path. Colour data is authored in sRGB."""
    TEXTURES.mkdir(parents=True, exist_ok=True)
    path = TEXTURES / f'{name}.png'
    h, w, channels = data.shape
    rgba = np.ones((h, w, 4), np.float32)
    rgba[:, :, :channels] = np.clip(data, 0.0, 1.0)
    image = bpy.data.images.new(name, w, h, alpha=channels == 4)
    image.colorspace_settings.name = 'Non-Color' if noncolor else 'sRGB'
    image.pixels.foreach_set(rgba.ravel())
    image.filepath_raw = str(path); image.file_format = 'PNG'; image.save()
    bpy.data.images.remove(image)
    return str(path)


def normal_from_height(height, strength):
    """OpenGL-convention tangent-space normal map from a tileable height field."""
    dx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * 0.5 * strength
    dy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * 0.5 * strength
    n = np.stack([-dx, -dy, np.ones_like(height)], axis=2)
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    return n * 0.5 + 0.5


def burlap_textures():
    """Plain-weave sacking: a tan base meant to be tinted by vertex colour (sandbags, canvas, tarp)."""
    n, threads = 512, 40
    y, x = np.mgrid[0:n, 0:n].astype(np.float32)
    r = np.random.default_rng(3101)
    tu, tv = x / n * threads, y / n * threads
    iu, iv = np.floor(tu).astype(int) % threads, np.floor(tv).astype(int) % threads
    fu, fv = tu - np.floor(tu), tv - np.floor(tv)
    width_u, width_v = 0.70 + 0.22 * r.random(threads), 0.70 + 0.22 * r.random(threads)
    wobble = periodic_noise(n, 6, 3102) * 0.06
    warp = np.clip(1 - np.abs(fu - 0.5 + wobble) * 2 / width_u[iu], 0, 1) ** 0.55
    weft = np.clip(1 - np.abs(fv - 0.5 - wobble) * 2 / width_v[iv], 0, 1) ** 0.55
    over = (iu + iv) % 2 == 0
    warp_h = warp * np.where(over, 0.78 + 0.22 * np.sin(np.pi * fv), 0.5)
    weft_h = weft * np.where(over, 0.5, 0.78 + 0.22 * np.sin(np.pi * fu))
    height = np.maximum(warp_h, weft_h) + periodic_noise(n, 1.0, 3103) * 0.07
    stain = fbm(n, 70, 3104, 3)
    tone = 0.62 + 0.38 * np.clip(height, 0, 1)
    base = np.array([0.80, 0.72, 0.58], np.float32)
    colour = base[None, None, :] * tone[..., None] * (1 + 0.07 * stain[..., None])
    colour *= np.where(height[..., None] < 0.1, 0.55, 1.0)
    occlusion = np.clip(0.55 + 0.5 * height, 0, 1)
    arm = np.stack([occlusion, np.full_like(height, 0.93), np.zeros_like(height)], axis=2)
    return (save_texture('V3_Burlap_col', colour), save_texture('V3_Burlap_nor', normal_from_height(height, 2.4), True),
            save_texture('V3_Burlap_arm', arm, True))


def canvas_textures():
    """Heavy cotton duck for the truck cover and tarps: a tight weave, sewn panel seams, sun
    fading and dirt run-off, neutral so vertex colour sets olive or green. One tile is a metre."""
    n = 512
    y, x = np.mgrid[0:n, 0:n].astype(np.float32)
    weave = 0.5 + 0.25 * np.sin(x / n * math.tau * 160) * np.sin(y / n * math.tau * 160) + 0.25 * periodic_noise(n, 0.7, 3121)
    fade = fbm(n, 110, 3122, 3)
    runs = periodic_noise(n, 3, 3123, None)
    drip = np.clip(np.roll(fbm(n, 30, 3124, 2), 0, axis=0) * 0.5 + 0.5, 0, 1)
    streak = smoothstep(0.55, 0.95, np.abs(np.repeat(periodic_noise(n, 6, 3125)[:1, :], n, axis=0)) * 0.6 + 0.4 * drip)
    seam = np.exp(-((((y / n) * 2.0) % 1.0 - 0.5) * 48) ** 2)  # two sewn seams per tile
    tone = 0.78 + 0.05 * fade + 0.02 * runs - 0.07 * streak - 0.12 * seam
    colour = np.stack([tone * 1.0, tone * 0.95, tone * 0.8], axis=2)
    height = 0.12 * weave + 0.5 * seam + 0.08 * fade
    rough = np.clip(0.88 + 0.05 * fade, 0, 1)
    arm = np.stack([np.clip(1 - 0.35 * seam, 0, 1), rough, np.zeros_like(rough)], axis=2)
    return (save_texture('V3_Canvas_col', colour), save_texture('V3_Canvas_nor', normal_from_height(height, 1.6), True),
            save_texture('V3_Canvas_arm', arm, True))


def paint_textures():
    """Worn, neutral painted steel: mottling, scratches and chips; tinted by vertex colour."""
    n = 512
    r = np.random.default_rng(3201)
    mottle = fbm(n, 60, 3202, 4)
    speck = periodic_noise(n, 0.8, 3203)
    scratch = np.zeros((n, n), np.float32)
    for _ in range(140):
        x0, y0 = r.integers(0, n, 2); angle = r.uniform(0, math.pi); length = r.integers(12, 90)
        for t in range(length):
            xx = int(x0 + math.cos(angle) * t) % n; yy = int(y0 + math.sin(angle) * t) % n
            scratch[yy, xx] = max(scratch[yy, xx], r.uniform(0.4, 1.0))
    chips = smoothstep(1.9, 2.4, fbm(n, 9, 3204, 3) + 0.6 * periodic_noise(n, 30, 3205))
    tone = 0.78 + 0.035 * mottle + 0.02 * speck
    colour = np.repeat(tone[..., None], 3, axis=2)
    colour = colour * (1 - 0.35 * chips[..., None]) + np.array([0.30, 0.24, 0.20])[None, None, :] * 0.35 * chips[..., None]
    colour = colour * (1 + 0.18 * scratch[..., None])
    rough = np.clip(0.52 + 0.08 * mottle - 0.18 * scratch + 0.25 * chips, 0.3, 0.95)
    arm = np.stack([np.ones_like(rough), rough, 0.25 * chips], axis=2)
    height = 0.6 * mottle * 0.05 - chips * 0.6 - scratch * 0.2
    return (save_texture('V3_Paint_col', colour), save_texture('V3_Paint_nor', normal_from_height(height, 1.2), True),
            save_texture('V3_Paint_arm', arm, True))


def burnt_textures():
    """Fire-damaged sheet metal: soot black, blistered paint, ash and rust."""
    n = 512
    soot = fbm(n, 40, 3301, 5)
    rust_mask = smoothstep(0.15, 0.75, fbm(n, 55, 3302, 4) + 0.35 * periodic_noise(n, 8, 3303))
    ash_mask = smoothstep(1.1, 1.6, fbm(n, 14, 3304, 3))
    blister = smoothstep(0.8, 1.6, periodic_noise(n, 3.5, 3305))
    black = np.array([0.10, 0.09, 0.085], np.float32)
    rust = np.array([0.42, 0.21, 0.10], np.float32)
    ash = np.array([0.55, 0.53, 0.50], np.float32)
    colour = black[None, None, :] * (1 + 0.35 * soot[..., None])
    colour = colour * (1 - rust_mask[..., None]) + rust[None, None, :] * (0.75 + 0.25 * soot[..., None]) * rust_mask[..., None]
    colour = colour * (1 - 0.6 * ash_mask[..., None]) + ash[None, None, :] * 0.6 * ash_mask[..., None]
    rough = np.clip(0.82 + 0.1 * soot - 0.1 * (1 - rust_mask) * 0.5, 0.6, 1.0)
    arm = np.stack([np.clip(0.75 + 0.25 * soot, 0, 1), rough, 0.15 * (1 - rust_mask)], axis=2)
    height = 0.4 * blister + 0.3 * rust_mask + 0.1 * soot
    return (save_texture('V3_Burnt_col', colour), save_texture('V3_Burnt_nor', normal_from_height(height, 2.0), True),
            save_texture('V3_Burnt_arm', arm, True))


DECAL_CELLS = {'scorch': (0, 0), 'oil': (1, 0), 'tracks': (0, 1), 'mud': (1, 1)}


def decal_texture():
    """Multiply decals in a 2 x 2 atlas: white leaves the ground unchanged. Scorch, oil, tyre
    tracks and mud. The runtime draws them with multiply blending, so they never brighten."""
    cell = 512
    out = np.ones((cell * 2, cell * 2, 3), np.float32)
    y, x = np.mgrid[0:cell, 0:cell].astype(np.float32) / (cell - 1) * 2 - 1
    radius = np.sqrt(x * x + y * y)
    angle = np.arctan2(y, x)
    edge = fbm(cell, 18, 3401, 4)
    window = 1 - smoothstep(0.86, 0.99, np.maximum(np.abs(x), np.abs(y)))  # exactly white at the cell border

    def multiply(amount, colour):
        """Per-pixel multiply factor: white where amount is 0, `colour` where it is 1."""
        a = np.clip(amount * window, 0, 1)[..., None]
        return 1 - a * (1 - np.array(colour, np.float32))[None, None, :]

    # Scorch: black core, ragged soot edge and radial streaks.
    streaks = 0.5 + 0.5 * np.sin(angle * 23 + 2.0 * periodic_noise(cell, 25, 3402))
    soot = 1 - smoothstep(0.3, 0.92, radius + 0.12 * edge - 0.1 * streaks * radius)
    scorch = multiply(soot * (0.84 + 0.1 * edge), (0.08, 0.075, 0.07))
    # Oil: a dark, slightly brown blob with a softer halo.
    blob = 1 - smoothstep(0.25, 0.75, radius + 0.22 * fbm(cell, 40, 3403, 3))
    halo = 1 - smoothstep(0.4, 0.9, radius + 0.15 * edge)
    oil = multiply(0.7 * blob + 0.2 * halo, (0.3, 0.28, 0.25))
    # Tyre tracks: two muddy tread bands running the length of the cell.
    tread = 0.5 + 0.5 * np.sign(np.sin(y * 70 + np.where(x > 0, 0.0, 1.7)))
    band = np.zeros_like(x)
    for centre in (-0.55, 0.55):
        band = np.maximum(band, 1 - smoothstep(0.12, 0.3, np.abs(x - centre) + 0.06 * edge))
    fade = 1 - smoothstep(0.7, 0.95, np.abs(y) + 0.1 * edge)
    tracks = multiply(band * fade * (0.6 + 0.3 * tread), (0.42, 0.36, 0.27))
    # Mud: irregular brown patch with a darker wet core.
    patch = 1 - smoothstep(0.35, 0.88, radius + 0.3 * fbm(cell, 30, 3404, 4))
    core = 1 - smoothstep(0.1, 0.55, radius + 0.25 * edge)
    mud = multiply(np.clip(0.75 * patch + 0.25 * core, 0, 1), (0.5, 0.38, 0.26))
    for name, data in (('scorch', scorch), ('oil', oil), ('tracks', tracks), ('mud', mud)):
        cx, cy = DECAL_CELLS[name]
        out[cy * cell:(cy + 1) * cell, cx * cell:(cx + 1) * cell] = np.clip(data, 0, 1)
    return save_texture('V3_Decals_col', out)


def smoke_texture():
    """A tall smoke column (RGBA): dark at the base, lifting into a wide, sunlit, wind-bent plume."""
    w, h = 256, 1024
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    v = y / (h - 1); u = x / (w - 1) * 2 - 1
    density_noise = fbm(1024, 40, 3501, 5, height=1024)[:, :w] * 0.5 + fbm(1024, 120, 3502, 3, height=1024)[:, :w] * 0.5
    lean = 0.45 * v ** 1.6                 # the plume bends downwind as it rises
    width = 0.12 + 0.72 * v ** 0.8
    across = np.abs(u - lean + 0.15) / width
    shape = (1 - smoothstep(0.35, 1.0, across + 0.25 * density_noise)) * smoothstep(0.0, 0.06, v) * (1 - smoothstep(0.72, 1.0, v))
    alpha = np.clip(shape * (0.62 + 0.38 * np.clip(density_noise + 0.6, 0, 1)), 0, 1) * 0.92
    tone = 0.22 + 0.42 * smoothstep(0.05, 0.85, v) + 0.06 * density_noise
    colour = np.stack([tone * 1.06, tone * 1.0, tone * 0.93], axis=2)
    return save_texture('V3_Smoke_col', np.concatenate([colour, alpha[..., None]], axis=2))


def texture_material(name, colour, normal=None, arm=None, roughness=0.8, metallic=0.0, vertex_color=True,
                     double_sided=False, alpha=False, normal_strength=1.0, provenance='Original procedural texture (generate_town_v3.py).'):
    """Principled material over the mesh's own 'UVMap' (already in texture tiles), optionally
    multiplied by the 'Color' vertex attribute."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.use_backface_culling = not double_sided
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes['Principled BSDF']
    uv = nodes.new('ShaderNodeUVMap'); uv.uv_map = 'UVMap'
    tex = nodes.new('ShaderNodeTexImage'); tex.image = load_image(colour)
    links.new(uv.outputs['UV'], tex.inputs['Vector'])
    if vertex_color:
        attribute = nodes.new('ShaderNodeVertexColor'); attribute.layer_name = 'Color'
        mix = nodes.new('ShaderNodeMixRGB'); mix.blend_type = 'MULTIPLY'; mix.inputs['Fac'].default_value = 1.0
        links.new(tex.outputs['Color'], mix.inputs['Color1']); links.new(attribute.outputs['Color'], mix.inputs['Color2'])
        links.new(mix.outputs['Color'], bsdf.inputs['Base Color'])
    else:
        links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    if normal:
        normal_image = nodes.new('ShaderNodeTexImage'); normal_image.image = load_image(normal, True)
        links.new(uv.outputs['UV'], normal_image.inputs['Vector'])
        normal_map = nodes.new('ShaderNodeNormalMap'); normal_map.inputs['Strength'].default_value = normal_strength
        links.new(normal_image.outputs['Color'], normal_map.inputs['Color']); links.new(normal_map.outputs['Normal'], bsdf.inputs['Normal'])
    if arm:
        arm_image = nodes.new('ShaderNodeTexImage'); arm_image.image = load_image(arm, True)
        links.new(uv.outputs['UV'], arm_image.inputs['Vector'])
        separate = nodes.new('ShaderNodeSeparateColor')
        links.new(arm_image.outputs['Color'], separate.inputs['Color'])
        links.new(separate.outputs['Green'], bsdf.inputs['Roughness'])
        links.new(separate.outputs['Blue'], bsdf.inputs['Metallic'])
        occlusion = nodes.new('ShaderNodeGroup'); occlusion.node_tree = gltf_output_group()
        links.new(separate.outputs['Red'], occlusion.inputs['Occlusion'])
    else:
        bsdf.inputs['Roughness'].default_value = roughness
        bsdf.inputs['Metallic'].default_value = metallic
    if alpha:
        links.new(tex.outputs['Alpha'], bsdf.inputs['Alpha'])
    mat['provenance'] = provenance
    return mat


def bus_paint_material():
    """The school bus repainted by weather: its yellow enamel faded toward ochre and greyed."""
    base = bpy.data.materials.get('Vehicle_SchoolYellow_Enamel')
    mat = base.copy(); mat.name = 'V3_BusPaint'
    for node in mat.node_tree.nodes:
        if node.bl_idname == 'ShaderNodeTexImage' and node.image and node.image.name.startswith('Vehicle_SchoolYellow_Enamel_Albedo'):
            source = node.image
            w, h = source.size
            pixels = np.empty(w * h * 4, np.float32); source.pixels.foreach_get(pixels)
            rgba = pixels.reshape(h, w, 4)
            grey = rgba[:, :, :3].mean(axis=2, keepdims=True)
            faded = rgba[:, :, :3] * 0.4 + grey * 0.6
            faded *= np.array([0.84, 0.77, 0.64], np.float32)[None, None, :]
            faded *= (1 - 0.06 * fbm(w, 50, 3601, 4, height=h))[..., None]
            node.image = load_image(save_texture('V3_BusPaint_col', faded))
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes['Principled BSDF']
    colour_link = next((l for l in links if l.to_node == bsdf and l.to_socket.name == 'Base Color'), None)
    if colour_link:
        attribute = nodes.new('ShaderNodeVertexColor'); attribute.layer_name = 'Color'
        mix = nodes.new('ShaderNodeMixRGB'); mix.blend_type = 'MULTIPLY'; mix.inputs['Fac'].default_value = 1.0
        source_socket = colour_link.from_socket
        links.remove(colour_link)
        links.new(source_socket, mix.inputs['Color1']); links.new(attribute.outputs['Color'], mix.inputs['Color2'])
        links.new(mix.outputs['Color'], bsdf.inputs['Base Color'])
    mat['provenance'] = 'Repository vehicle material, faded for Kannon Town v3.'
    return mat


def build_materials():
    m = {
        'asphalt': pbr_material('V2_Asphalt', 'asphalt_02', 6.0),
        'concrete': pbr_material('V2_Concrete', 'concrete_floor_01', 3.0),
        'roof': pbr_material('V2_Roof', 'grey_roof_01', 2.4),
        'grass': pbr_material('V2_Grass', 'leafy_grass', 3.0),
        'siding': pbr_material('V2_Siding', 'white_planks_clean', 2.0, rotation=90, flatten=0.7),
        'trim': pbr_material('V2_Trim', 'white_planks_clean', 0.9),
        'fence': pbr_material('V2_Fence', 'white_planks_clean', 2.2),
        'plaster': pbr_material('V2_Plaster', 'painted_plaster_wall', 3.0),
        'floor': pbr_material('V2_FloorWood', 'wood_floor_deck', 3.0),
        'hills': pbr_material('V2_Hills', 'aerial_grass_rock', 45.0),
        'bark': pbr_material('V2_Bark', 'bark_brown_02', 1.6),
        # v3: a plain, dust-dulled sofa cover; the patterned 2k fabric set cost 1.2 MB for one sofa.
        'fabric': plain_material('V3_SofaFabric', (0.62, 0.6, 0.55), 0.92),
        'metal': plain_material('V2_Metal', (0.8, 0.8, 0.8), 0.42, 0.75),
        'glass': plain_material('V2_Glass', (0.22, 0.32, 0.36), 0.12, 0.3, vertex_color=False),
        'markings': plain_material('V2_Markings', (0.9, 0.9, 0.9), 0.85),
        'leaves': plain_material('V2_Leaves', (0.9, 0.95, 0.85), 0.9, double_sided=True),
    }
    # Kannon Town v3 checkpoint materials.
    burlap = burlap_textures(); canvas = canvas_textures(); paint = paint_textures(); burnt = burnt_textures()
    barrier = MANIFEST['assets']['concrete_road_barrier']['files']
    barrier_file = lambda key: next(v['path'] for k, v in barrier.items() if key in k)  # noqa: E731
    m.update({
        'burlap': texture_material('V3_Burlap', *burlap, normal_strength=0.8),
        'canvas': texture_material('V3_Canvas', *canvas, normal_strength=0.7),
        'paint': texture_material('V3_Paint', *paint, normal_strength=0.6),
        'burnt': texture_material('V3_Burnt', *burnt, normal_strength=0.9),
        'barrier': texture_material('V3_Barrier', barrier_file('_diff_'), barrier_file('_nor_gl_'), barrier_file('_arm_'),
                                    provenance='Poly Haven concrete_road_barrier textures (CC0 1.0) on original geometry.'),
        'boards': pbr_material('V3_Boards', 'wood_floor_deck', 1.4, rotation=90),
        # The wire's vertex colour is not albedo: it carries the sun visibility shade_wire()
        # measures, which the runtime uses to take the real-time sun off wire in shade.
        'wire': plain_material('V3_Wire', (0.30, 0.30, 0.29), 0.48, 0.85, vertex_color=False),
        'pot': plain_material('V3_Pot', (1.0, 1.0, 1.0), 0.86),
        'cone': plain_material('V3_Cone', (1.0, 1.0, 1.0), 0.6),
        'window_glass': plain_material('V3_WindowGlass', (0.30, 0.38, 0.40), 0.06, 0.0, vertex_color=False),
        'decals': texture_material('V3_Decals', decal_texture(), vertex_color=False, roughness=1.0),
        'smoke': texture_material('V3_Smoke', smoke_texture(), vertex_color=False, double_sided=True, alpha=True, roughness=1.0),
        'bus': bus_paint_material(),
    })
    glass = m['window_glass']
    glass.node_tree.nodes['Principled BSDF'].inputs['Alpha'].default_value = 0.34
    for key in ('window_glass', 'smoke'):
        material = m[key]
        if hasattr(material, 'surface_render_method'):
            material.surface_render_method = 'BLENDED'
        else:
            material.blend_method = 'BLEND'
    return m


HOUSE_INTERIOR = [  # game-space boxes (min, max) that count as "inside"
    ((10.14, 0.0, -5.86), (21.86, 6.3, 5.86)),
    ((10.14, 0.0, 6.14), (17.86, 3.03, 13.36)),
]


def inside_house(p):
    x, y, z = abs(p[0]), p[1], p[2]
    return any(lo[0] < x < hi[0] and lo[1] < y < hi[1] and lo[2] < z < hi[2] for lo, hi in HOUSE_INTERIOR)


FENCE_BOXES = [o for o in MAP['obstacles'] if o.get('surface') == 'fence']


def in_fence(p, pad=0.35):
    return any(abs(p[0] - o['x']) <= o['w'] / 2 + pad and abs(p[2] - o['z']) <= o['d'] / 2 + pad and abs(p[1] - o['y']) <= o['h'] / 2 + pad for o in FENCE_BOXES)


def set_material_slots(obj, materials):
    obj.data.materials.clear()
    for mat in materials:
        obj.data.materials.append(mat)


def assign_by_polygon(obj, chooser, materials):
    """chooser(world_center, world_normal, old_material_name) -> key in materials."""
    mesh = obj.data
    old_names = [mat.name if mat else '' for mat in mesh.materials]
    keys = list(materials.keys())
    world = obj.matrix_world
    normal_matrix = world.to_3x3().inverted().transposed()
    choices = []
    for poly in mesh.polygons:
        center = bg(world @ poly.center)
        normal = bg((normal_matrix @ poly.normal).normalized())
        choices.append(keys.index(chooser(center, normal, old_names[poly.material_index] if old_names else '')))
    set_material_slots(obj, [materials[k] for k in keys])
    for poly, choice in zip(mesh.polygons, choices):
        poly.material_index = choice


def reproject_uv(obj):
    """World-space planar UVs at one metre per unit, projected along each face's dominant axis."""
    mesh = obj.data
    layer = mesh.uv_layers.get('UVMap') or mesh.uv_layers.new(name='UVMap')
    mesh.uv_layers.active = layer
    world = obj.matrix_world
    for poly in mesh.polygons:
        n = (world.to_3x3() @ poly.normal)
        axis = max(range(3), key=lambda i: abs(n[i]))
        a, b = [i for i in range(3) if i != axis]
        for li in poly.loop_indices:
            p = world @ mesh.vertices[mesh.loops[li].vertex_index].co
            layer.data[li].uv = (p[a], p[b])


def set_vertex_color(obj, rgb=None, scale=None, brighten=None):
    mesh = obj.data
    colors = mesh.color_attributes.get('Color')
    if not colors:
        colors = mesh.color_attributes.new(name='Color', type='FLOAT_COLOR', domain='CORNER')
        for item in colors.data:
            item.color = (1, 1, 1, 1)
    if rgb is not None:
        for item in colors.data:
            item.color = (*rgb, 1.0)
    elif scale is not None:
        for item in colors.data:
            c = item.color
            item.color = (min(1, c[0] * scale), min(1, c[1] * scale), min(1, c[2] * scale), 1.0)
    elif brighten is not None:
        for item in colors.data:
            c = item.color
            item.color = (min(1, c[0] / brighten), min(1, c[1] / brighten), min(1, c[2] / brighten), 1.0)


def ensure_color_attribute(obj):
    if obj.type != 'MESH':
        return
    mesh = obj.data
    if not mesh.color_attributes.get('Color'):
        if mesh.color_attributes:
            mesh.color_attributes[0].name = 'Color'
        else:
            colors = mesh.color_attributes.new(name='Color', type='FLOAT_COLOR', domain='CORNER')
            for item in colors.data:
                item.color = (1, 1, 1, 1)
    colors = mesh.color_attributes['Color']
    if colors.domain != 'CORNER':
        # Per-face edits below index colours by loop; move point colours onto the corners.
        point = [tuple(item.color) for item in colors.data]
        mesh.color_attributes.remove(colors)
        corner = mesh.color_attributes.new(name='Color', type='FLOAT_COLOR', domain='CORNER')
        for li, loop in enumerate(mesh.loops):
            corner.data[li].color = point[loop.vertex_index] if loop.vertex_index < len(point) else (1, 1, 1, 1)


def remove_polygons_inside(obj, boxes, pad=0.02):
    """Delete faces of obj whose world centre lies inside any of the game-space obstacle boxes."""
    mesh = obj.data
    world = obj.matrix_world
    doomed = []
    for poly in mesh.polygons:
        c = bg(world @ poly.center)
        for o in boxes:
            if abs(c[0] - o['x']) <= o['w'] / 2 + pad and abs(c[1] - o['y']) <= o['h'] / 2 + pad and abs(c[2] - o['z']) <= o['d'] / 2 + pad:
                doomed.append(poly.index); break
    if not doomed:
        return 0
    bm = bmesh.new(); bm.from_mesh(mesh); bm.faces.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[bm.faces[i] for i in doomed], context='FACES')
    bm.to_mesh(mesh); bm.free(); mesh.update()
    return len(doomed)


def retexture(materials):
    """Replace the refined town's grey procedural materials with the CC0 sets."""
    M = materials
    obstacles = {o['id']: o for o in MAP['obstacles']}
    replaced_boxes = [obstacles[i] for i in ('north-mail-crates', 'teal-yard-cover', 'yellow-yard-cover')]

    def siding_chooser(center, normal, old):
        probe = (center[0] + normal[0] * 0.25, center[1] + normal[1] * 0.25, center[2] + normal[2] * 0.25)
        return 'plaster' if inside_house(probe) else 'siding'

    def trim_chooser(center, normal, old):
        probe = (center[0] + normal[0] * 0.25, center[1] + normal[1] * 0.25, center[2] + normal[2] * 0.25)
        if inside_house(probe):
            return 'plaster'
        if in_fence(center):
            return 'fence'
        return 'trim'

    def wood_chooser(center, normal, old):
        return 'bark' if abs(center[0]) > 31.5 or abs(center[2]) > 23.5 else 'floor'

    rules = {
        'Town_asphalt': ('asphalt', 'white'), 'Town_grass': ('grass', 'white'),
        'Town_concrete': ('concrete', 'white'), 'Refined_concrete': ('concrete', 'white'),
        'Town_roof': ('roof', 'white'), 'Refined_roof': ('roof', 'white'),
        'Refined_siding': ('siding', 'brighten'),
        'Refined_trim': ('trim', 'white'), 'Refined_wood': ('floor', 'white'),
        'Refined_metal': ('metal', 'keep'), 'Town_metal': ('metal', 'keep'),
        'Refined_glass': ('glass', 'keep'), 'Town_glass': ('glass', 'keep'),
        'Refined_markings': ('markings', 'keep'), 'Refined_fabric': ('fabric', 'rgb', (0.55, 0.6, 0.55)),
        'Horizon_Refined_bark': ('bark', 'white'), 'Horizon_Refined_leaves': ('leaves', 'keep'),
        'Horizon_Town_earth': ('hills', 'white'),
    }
    for name, rule in rules.items():
        obj = bpy.data.objects.get(name)
        if not obj:
            log('missing base object', name); continue
        set_material_slots(obj, [M[rule[0]]])
        if rule[0] not in ('metal', 'glass', 'markings', 'leaves'):
            reproject_uv(obj)
        if rule[1] == 'white':
            set_vertex_color(obj, rgb=(1, 1, 1))
        elif rule[1] == 'rgb':
            set_vertex_color(obj, rgb=rule[2])
        elif rule[1] == 'brighten':
            set_vertex_color(obj, brighten=0.72)
        else:
            ensure_color_attribute(obj)
    # Faceted splits: exterior siding vs interior plaster, trim vs fence vs plaster, floors vs trunks.
    siding = bpy.data.objects['Town_siding']
    assign_by_polygon(siding, siding_chooser, {'siding': M['siding'], 'plaster': M['plaster']})
    reproject_uv(siding); set_vertex_color(siding, brighten=0.72)
    _tint_interior(siding, 'plaster')
    trim = bpy.data.objects['Town_trim']
    assign_by_polygon(trim, trim_chooser, {'trim': M['trim'], 'fence': M['fence'], 'plaster': M['plaster']})
    reproject_uv(trim); set_vertex_color(trim, rgb=(0.96, 0.95, 0.92))
    _tint_interior(trim, 'plaster')
    wood = bpy.data.objects['Town_wood']
    removed = remove_polygons_inside(wood, replaced_boxes)
    log('removed crate/yard-cover faces from Town_wood:', removed)
    assign_by_polygon(wood, wood_chooser, {'floor': M['floor'], 'bark': M['bark']})
    reproject_uv(wood); set_vertex_color(wood, rgb=(1, 1, 1))
    # Truck paint keeps its authored material; give it and the rubber sane roughness.
    for name in ('TownPaint', 'TownRubber', 'TownBronzeMetal'):
        mat = bpy.data.materials.get(name)
        if mat and mat.use_nodes and 'Principled BSDF' in mat.node_tree.nodes:
            bsdf = mat.node_tree.nodes['Principled BSDF']
            bsdf.inputs['Roughness'].default_value = 0.55 if name == 'TownPaint' else 0.85 if name == 'TownRubber' else 0.4
    # v3: weathered paint on the houses, dry late-summer lawns, and the military truck.
    for name in ('Town_siding', 'Refined_siding'):
        weather_vertex_colors(bpy.data.objects[name], desaturate=0.32, darken=0.9, skip_material='V2_Plaster')
    set_vertex_color(bpy.data.objects['Town_grass'], rgb=(0.95, 0.88, 0.66))
    repaint_truck(M)


# Linear vertex tints for the neutral v3 textures (texture x tint = albedo).
OLIVE_PAINT = (0.215, 0.235, 0.11)
OLIVE_CANVAS = (0.38, 0.44, 0.31)
TARP_GREEN = (0.3, 0.32, 0.24)
SANDBAG_KHAKI = (0.74, 0.72, 0.58)


def weather_vertex_colors(obj, desaturate, darken, skip_material=None):
    ensure_color_attribute(obj)
    mesh = obj.data
    colors = mesh.color_attributes.get('Color')
    if not colors:
        return
    skip = {i for i, mat in enumerate(mesh.materials) if mat and mat.name == skip_material}
    for poly in mesh.polygons:
        if poly.material_index in skip:
            continue
        for li in poly.loop_indices:
            c = colors.data[li].color
            grey = (c[0] + c[1] + c[2]) / 3
            colors.data[li].color = tuple(min(1.0, (c[i] * (1 - desaturate) + grey * desaturate) * darken) for i in range(3)) + (1.0,)


def planar_face_uv(obj, poly, layer, tile, world=None):
    """World-space planar UVs for one face, in texture tiles."""
    world = world or obj.matrix_world
    n = world.to_3x3() @ poly.normal
    axis = max(range(3), key=lambda i: abs(n[i]))
    a, b = [i for i in range(3) if i != axis]
    for li in poly.loop_indices:
        p = world @ obj.data.vertices[obj.data.loops[li].vertex_index].co
        layer.data[li].uv = (p[a] / tile, p[b] / tile)


def repaint_truck(M):
    """The box truck becomes a military cargo truck in the same boxes: olive cab and drop sides,
    a canvas cover where the box body was. Every collision face keeps its rendered face."""
    obj = bpy.data.objects['Town_paint']
    mesh = obj.data
    ensure_color_attribute(obj)
    colors = mesh.color_attributes['Color']
    layer = mesh.uv_layers.get('UVMap') or mesh.uv_layers.new(name='UVMap')
    paint_index = len(mesh.materials); mesh.materials.append(M['paint'])
    canvas_index = len(mesh.materials); mesh.materials.append(M['canvas'])
    world = obj.matrix_world
    counts = {'paint': 0, 'canvas': 0}
    for poly in mesh.polygons:
        pts = [bg(world @ mesh.vertices[v].co) for v in poly.vertices]
        lo = [min(p[i] for p in pts) for i in range(3)]; hi = [max(p[i] for p in pts) for i in range(3)]
        if not (lo[0] >= 0.8 and hi[0] <= 4.6 and lo[2] >= -0.3 and hi[2] <= 10.3 and hi[1] <= 3.3):
            continue
        cab = hi[1] <= 2.55 and hi[2] <= 2.51 and lo[0] >= 1.09 and hi[0] <= 4.21
        rail = (hi[0] <= 0.92 or lo[0] >= 4.38) and hi[1] <= 1.41
        painted = cab or rail
        poly.material_index = paint_index if painted else canvas_index
        tint = OLIVE_PAINT if painted else OLIVE_CANVAS
        for li in poly.loop_indices:
            colors.data[li].color = (*tint, 1.0)
        planar_face_uv(obj, poly, layer, 1.0, world)
        counts['paint' if painted else 'canvas'] += 1
    # The box truck's bright hinges, posts and lamp housings go dark to suit the paint.
    for name, tint in (('Town_metal', (0.1, 0.11, 0.085)), ('Town_trim', (0.09, 0.09, 0.08))):
        part = bpy.data.objects[name]
        ensure_color_attribute(part)
        pmesh, pworld = part.data, part.matrix_world
        pcolors = pmesh.color_attributes['Color']
        for poly in pmesh.polygons:
            c = bg(pworld @ poly.center)
            if 0.8 <= c[0] <= 4.6 and -0.4 <= c[2] <= 10.4 and c[1] <= 3.3:
                for li in poly.loop_indices:
                    pcolors.data[li].color = (*tint, 1.0)
                counts[name] = counts.get(name, 0) + 1
    log('truck repainted:', counts)


def _tint_interior(obj, plaster_key):
    """Interior plaster faces get a warm off-white instead of the exterior house tint."""
    mesh = obj.data
    colors = mesh.color_attributes.get('Color')
    plaster_index = [i for i, mat in enumerate(mesh.materials) if mat and mat.name == 'V2_Plaster']
    if not plaster_index or not colors:
        return
    for poly in mesh.polygons:
        if poly.material_index == plaster_index[0]:
            for li in poly.loop_indices:
                colors.data[li].color = (0.94, 0.91, 0.85, 1.0)


# ---------------------------------------------------------------------------------------------
# Props
# ---------------------------------------------------------------------------------------------

PROPS = {
    # id: (poly haven asset, object names or None for all meshes, triangle budget)
    'trash_can': ('metal_trash_can', ['metal_trash_can', 'metal_trash_can_lid', 'metal_trash_can_handle_left', 'metal_trash_can_handle_right'], 3000),
    'trash_can_rust': ('metal_trash_can', ['metal_trash_can_rust', 'metal_trash_can_rust_lid', 'metal_trash_can_rust_handle_left', 'metal_trash_can_rust_handle_right'], 3000),
    'tyre': ('old_tyre', None, 2000),
    'hydrant': ('fire_hydrant', ['fire_hydrant', 'fire_hydrant_cap_01', 'fire_hydrant_cap_02', 'fire_hydrant_cap_03', 'fire_hydrant_chain'], 4000),
    'street_lamp': ('street_lamp_01', None, 4500),
    'utility_box': ('utility_box_01', None, 2000),
    'planter': ('planter_box_02', None, 2500),
    'cardboard_box': ('cardboard_box_01', None, 1500),
    'crate': ('wooden_crate_02', None, 2000),
    'barrel_steel': ('Barrel_02', None, 1500),
    'aircon': ('exterior_aircon_unit', ['exterior_aircon_unit'], 3000),
    'manhole': ('water_manhole_cover', None, 1500),
    'bench': ('painted_wooden_bench', None, 700),
    'plastic_crate': ('plastic_crate_03', None, 2000),
    'picnic_table': ('wooden_picnic_table', None, 3000),
    'compost_bags': ('compost_bags', ['compost_bags_standing', 'compost_bags_leaning'], 3500),
    'wheel_rim': ('rusted_wheel_rim_01', None, 2000),
    'security_light': ('security_light', None, 1500),
    'trashbag': ('trashbag', None, 1500),
    'hand_truck': ('hand_truck', None, 3000),
    'propane': ('propane_tank', None, 2000),
    'generator': ('portable_generator', None, 4000),
    'ladder': ('ladder_sectioned_01', ['ladder_section_01'], 2000),
    'hose': ('garden_hose_wall_mounted_01', None, 2500),
    'patio_set': ('outdoor_table_chair_set_01', None, 3500),
    'barrel_wood': ('wooden_barrels_01', ['wooden_barrels_01_barrel01'], 3000),
    'potted_plant': ('potted_plant_02', ['potted_plant_02_pot', 'potted_plant_02_leaves'], 5000),
}

# Procedural leaf-cluster bushes (game x, z, radius, height); foliage may be walked through.
BUSHES = []

# Props whose imported pose is not how they are used: the tyre imports standing on its tread and
# lies flat on top of the yard crate stacks. Applied to the mesh itself after import (the glTF
# importer uses quaternion rotation, so an Euler rotation set on the object was ignored; v2's
# entries here never took effect, which is why the wheel rim keeps its upright v2 pose).
PRE_ROTATE = {'tyre': (math.radians(90), 0.0, 0.0)}

# (prop, x, y, z, yaw degrees, scale) in game coordinates; y is the base height.
# Solid props sit inside existing collision boxes, against walls, beyond the fences or on
# roofs; foliage and flat items may be walked through. Collision never changes.
PLACEMENTS = []


def place(prop, x, y, z, yaw=0.0, scale=1.0):
    PLACEMENTS.append((prop, x, y, z, yaw, scale))


def plan_placements():
    for side in (-1, 1):
        s = side
        # Yard cover boxes (±27, 0.6, -15; 3.5 x 1.2 x 1.3): v3 fills each with a crate stack that
        # reaches every face of the box (build_crate_stacks); v2's barrels and bags left gaps that
        # blocked shots. A spare tyre lies on the end the tarp leaves bare.
        place('tyre', s * 25.95, 1.2, -15.0, 90 if s < 0 else 0)
        # Sheds (±28, 1.3, 16; 4.2 x 2.6 x 3.5): utility box in the unreachable gap by the fence,
        # generator and propane against the shed's north face.
        place('utility_box', s * 30.45, 0, 15.2, 90 if s > 0 else -90)
        place('generator', s * 28.6, 0, 13.85, 0); place('propane', s * 27.4, 0, 13.95, 0)
        place('trash_can' if s < 0 else 'trash_can_rust', s * 25.35, 0, 17.2, 30); place('trashbag', s * 25.3, 0, 16.4, -20)
        # Under the balcony (±24.08, 3.08, 4.38; 4.16 x 3.16): outdoor furniture.
        if side < 0:
            place('picnic_table', -24.1, 0, 4.4, 90, 0.85)
        else:
            place('patio_set', 24.0, 0, 4.4, 0)
        # Wall mounted: air conditioner on the north wall, security lights over doors, hose and
        # ladder on the garage's outer side wall.
        place('aircon', s * 19.6, 2.15, -6.36, 0 if s < 0 else 0)
        place('security_light', s * 9.72, 3.15, 9.75, -90 if s < 0 else 90)
        place('security_light', s * 22.28, 3.15, 4.0, 90 if s < 0 else -90)
        place('hose', s * 18.3, 1.15, 10.2, 90 if s < 0 else -90)
        place('ladder', s * 18.22, 0.0, 8.0, 90 if s < 0 else -90)
        # v3: the potted plants by the front doors became Breakable_Pot_* (build_breakable_pots).
        # Bushes along the north wall and in the fence corners.
        for i in range(4):
            BUSHES.append((s * (11.6 + i * 2.7), -7.0, rng.uniform(0.75, 1.05), rng.uniform(0.9, 1.25)))
        BUSHES.append((s * 29.9, -21.6, 1.1, 1.2)); BUSHES.append((s * 29.9, 21.4, 1.0, 1.15)); BUSHES.append((s * 24.6, 21.5, 0.9, 1.0))
        # Street lamps beyond the boundary fences; only their heads show over the fence.
        place('street_lamp', s * 9.4, 0, -24.3, 0); place('street_lamp', s * 9.4, 0, 24.3, 180)
        place('street_lamp', s * 32.6, 0, 0.0, 90 if s < 0 else -90)
        place('hydrant', s * 9.5, 0, -19.6 if s < 0 else 19.6, 90)
        # Roof: an air conditioner on the garage roof.
        place('aircon', s * 12.0, 3.27, 11.5, 90)
    # North mail crates (-4.8, 0.7, -17; 2.3 x 1.4 x 2.2): v3 stacks military ammunition crates
    # under a tarp there instead (build_ammo_crates).
    # South planter (6.5, 0.68, 16.5; 2.2 x 1.36 x 3.5): shrubs on the concrete planter.
    BUSHES.append((6.5, 15.7, 0.8, 0.9)); BUSHES.append((6.5, 17.4, 0.8, 0.95)); place('planter', 6.5, 1.36, 16.5, 90, 0.9)
    # Truck cargo crates (1.7/3.4, 0.76, 3.3/3.7): a box on top of one.
    place('cardboard_box', 1.7, 1.16, 3.3, 20)
    # Manhole covers on the road, flat.
    place('manhole', 2.2, 0.004, -13.0, 0); place('manhole', -2.6, 0.004, 13.5, 0)
    # A bench against the west house front wall between door and garage is walkable; put it
    # against the shed instead.
    place('bench', -29.8, 0, 18.3, 180); place('bench', 29.8, 0, 18.3, 180)
    place('hand_truck', 17.6, 0, 13.1, 200)
    place('wheel_rim', -17.55, 1.05, 11.8, 0, 0.8)


def import_prop(key):
    asset, names, budget = PROPS[key]
    path = asset_path(asset, 'gltf')
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    imported = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in imported if o.type == 'MESH' and (names is None or o.name.split('.')[0] in names)]
    if not meshes:
        raise RuntimeError(f'{key}: none of {names} in {[o.name for o in imported]}')
    # glTF imports may hang meshes under a rotated root empty; bake that into the meshes
    # before the empties go away.
    bpy.ops.object.select_all(action='DESELECT')
    for o in imported:
        if o.type == 'MESH':
            o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
    for o in imported:
        if o not in meshes:
            bpy.data.objects.remove(o, do_unlink=True)
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = f'PropSrc_{key}'
    if obj.data.shape_keys:
        obj.shape_key_clear()
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if key in PRE_ROTATE:
        obj.data.transform(Euler(PRE_ROTATE[key]).to_matrix().to_4x4())
    # Base-centre origin.
    mesh = obj.data
    xs = [v.co.x for v in mesh.vertices]; ys = [v.co.y for v in mesh.vertices]; zs = [v.co.z for v in mesh.vertices]
    offset = Vector(((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, min(zs)))
    for v in mesh.vertices:
        v.co -= offset
    tris = sum(len(p.vertices) - 2 for p in mesh.polygons)
    if tris > budget:
        modifier = obj.modifiers.new('Decimate', 'DECIMATE')
        modifier.ratio = budget / tris
        modifier.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    ensure_color_attribute(obj)
    for mat in mesh.materials:
        if mat:
            mat.name = f'Prop_{key}_{mat.name}' if not mat.name.startswith('Prop_') else mat.name
            mat['provenance'] = f'Poly Haven {asset} (CC0 1.0)'
    obj['propSource'] = asset
    dims = obj.dimensions
    log(f'prop {key}: {tris} -> {sum(len(p.vertices) - 2 for p in mesh.polygons)} tris, {dims.x:.2f} x {dims.y:.2f} x {dims.z:.2f} m')
    return obj


def build_props():
    library = bpy.data.collections.new('Props_Library')
    bpy.context.scene.collection.children.link(library)
    library.hide_render = True
    props_collection = bpy.data.collections.new('Props')
    bpy.context.scene.collection.children.link(props_collection)
    plan_placements()
    sources = {}
    for key in sorted({p[0] for p in PLACEMENTS}):
        obj = import_prop(key)
        for col in list(obj.users_collection):
            col.objects.unlink(obj)
        library.objects.link(obj)
        sources[key] = obj
    instances = {}
    for prop, x, y, z, yaw, scale in PLACEMENTS:
        matrix = Matrix.Translation(gb(x, y, z)) @ Matrix.Rotation(math.radians(-yaw), 4, 'Z') @ Matrix.Scale(scale, 4)
        instances.setdefault(prop, []).append(matrix)
    joined = []
    for prop, matrices in instances.items():
        src = sources[prop]
        # Merge transformed copies of the source mesh directly; no selection-dependent operators.
        bm = bmesh.new()
        for matrix in matrices:
            piece = src.data.copy()
            piece.transform(matrix)
            bm.from_mesh(piece)
            bpy.data.meshes.remove(piece)
        mesh = bpy.data.meshes.new(f'Prop_{prop}')
        bm.to_mesh(mesh); bm.free()
        for mat in src.data.materials:
            mesh.materials.append(mat)
        mesh.update()
        obj = bpy.data.objects.new(f'Prop_{prop}', mesh)
        props_collection.objects.link(obj)
        obj['propSource'] = src.get('propSource', prop)
        ensure_color_attribute(obj)
        xs = [v.co for v in mesh.vertices]
        lo = [round(min(v[i] for v in xs), 1) for i in range(3)]; hi = [round(max(v[i] for v in xs), 1) for i in range(3)]
        log(f'placed {obj.name}: {len(matrices)} instance(s), bounds {lo} .. {hi}')
        joined.append(obj)
    for src in sources.values():
        src.hide_render = True; src.hide_viewport = True
    log(f'props: {len(PLACEMENTS)} placements in {len(joined)} objects')
    return joined


# ---------------------------------------------------------------------------------------------
# Grass cards
# ---------------------------------------------------------------------------------------------

def grass_card_image():
    """Procedural alpha texture of grass blade clusters, 512 x 256."""
    w, h = 512, 256
    rgba = np.zeros((h, w, 4), np.float32)
    r = np.random.default_rng(9102026)
    yy, xx = np.mgrid[:h, :w]
    for cluster in range(4):
        cx = 64 + cluster * 128
        for blade in range(48):
            x0 = cx + r.normal(0, 28); top = r.uniform(0.3, 1.0) * h; lean = r.normal(0, 0.5); width = r.uniform(1.2, 2.6)
            t = (h - yy) / max(1, top)
            curve = lean * (h - yy) + 0.0025 * lean * (h - yy) ** 2 / 4
            centre = x0 + curve
            mask = (np.abs(xx - centre) < width * (1 - t * 0.85) + 0.4) & (t < 1) & (t >= 0)
            shade = r.uniform(0.72, 1.0)
            colour = np.array([0.40 * shade, 0.52 * shade, 0.19 * shade])
            colour = colour * (0.75 + 0.5 * t[..., None])
            rgba[mask, :3] = colour[mask]
            rgba[mask, 3] = 1.0
    image = bpy.data.images.new('V2_GrassCard', w, h, alpha=True)
    image.colorspace_settings.name = 'sRGB'
    image.pixels.foreach_set(rgba.ravel())
    image.filepath_raw = str(OUT / 'grass-card.png'); image.file_format = 'PNG'; image.save(); image.pack()
    return image


def build_grass_cards(materials):
    image = grass_card_image()
    mat = bpy.data.materials.new('V2_GrassCard'); mat.use_nodes = True; mat.use_backface_culling = False
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes['Principled BSDF']; bsdf.inputs['Roughness'].default_value = 0.9
    tex = nodes.new('ShaderNodeTexImage'); tex.image = image
    attribute = nodes.new('ShaderNodeVertexColor'); attribute.layer_name = 'Color'
    mix = nodes.new('ShaderNodeMixRGB'); mix.blend_type = 'MULTIPLY'; mix.inputs['Fac'].default_value = 1.0
    links.new(tex.outputs['Color'], mix.inputs['Color1']); links.new(attribute.outputs['Color'], mix.inputs['Color2'])
    links.new(mix.outputs['Color'], bsdf.inputs['Base Color']); links.new(tex.outputs['Alpha'], bsdf.inputs['Alpha'])
    mat['provenance'] = 'Original procedural grass card.'
    grass = bpy.data.objects['Town_grass']
    world = grass.matrix_world
    polys = [p for p in grass.data.polygons if (world.to_3x3() @ p.normal).z > 0.5]
    areas = np.array([p.area for p in polys]); areas /= areas.sum()
    obstacles = [o for o in MAP['obstacles'] if o.get('surface') != 'fence']
    verts, faces, uvs, colors = [], [], [], []
    r = np.random.default_rng(9102027)
    placed = 0
    for _ in range(2600):
        poly = polys[int(r.choice(len(polys), p=areas))]
        corners = [world @ grass.data.vertices[i].co for i in poly.vertices]
        a, b, c = corners[0], corners[1], corners[2] if len(corners) < 4 else corners[r.integers(2, 4)]
        u, v = r.random(), r.random()
        if u + v > 1: u, v = 1 - u, 1 - v
        p = a + (b - a) * u + (c - a) * v
        g = bg(p)
        if abs(g[0]) < 10.3 or abs(g[0]) > 30.6 or abs(g[2]) > 22.6:
            continue
        if inside_house((abs(g[0]), 0.5, g[2])) or (25.6 < abs(g[0]) < 30.4 and 14.0 < g[2] < 18.0):
            continue
        if any(abs(g[0] - o['x']) < o['w'] / 2 + 0.35 and abs(g[2] - o['z']) < o['d'] / 2 + 0.35 and o['y'] - o['h'] / 2 < 0.3 for o in obstacles):
            continue
        width = r.uniform(0.45, 0.75); height = width * r.uniform(0.4, 0.5); yaw = r.uniform(0, math.pi)
        tint = r.uniform(0.8, 1.05)
        for k in range(2):
            angle = yaw + k * math.pi / 2
            d = Vector((math.cos(angle) * width / 2, math.sin(angle) * width / 2, 0))
            base = len(verts)
            verts += [p - d, p + d, p + d + Vector((0, 0, height)), p - d + Vector((0, 0, height))]
            faces.append((base, base + 1, base + 2, base + 3))
            uvs += [(0, 0), (1, 0), (1, 1), (0, 1)]
            colors += [(tint, tint, tint, 1)] * 4
        placed += 1
    mesh = bpy.data.meshes.new('GrassCards'); mesh.from_pydata(verts, [], faces); mesh.update()
    obj = bpy.data.objects.new('GrassCards', mesh); bpy.context.scene.collection.objects.link(obj)
    mesh.materials.append(mat)
    uv = mesh.uv_layers.new(name='UVMap'); col = mesh.color_attributes.new(name='Color', type='FLOAT_COLOR', domain='CORNER')
    for poly in mesh.polygons:
        for li in poly.loop_indices:
            uv.data[li].uv = uvs[mesh.loops[li].vertex_index]; col.data[li].color = colors[mesh.loops[li].vertex_index]
    log(f'grass cards: {placed} clusters, {len(faces)} quads')
    return obj


# ---------------------------------------------------------------------------------------------
# Bushes: clusters of curved leaf silhouettes, the same construction as the town's trees
# ---------------------------------------------------------------------------------------------

def build_bushes(materials):
    r = np.random.default_rng(9102028)
    verts, faces, colors = [], [], []
    palette = [(0.40, 0.55, 0.30), (0.34, 0.50, 0.26), (0.46, 0.60, 0.32), (0.30, 0.44, 0.24)]

    def leaf(center, u, v, colour):
        p = [center - u, center - u * 0.42 + v * 0.62, center + u * 0.40 + v * 0.60, center + u, center + u * 0.40 - v * 0.60, center - u * 0.42 - v * 0.62]
        ridge = center + Vector((0, 0, 0.02))
        base = len(verts)
        verts.extend(p + [ridge]); colors.extend([(*colour, 1.0)] * 7)
        for i in range(6):
            faces.append((base + i, base + (i + 1) % 6, base + 6))

    for x, z, radius, height in BUSHES:
        centre = gb(x, height * 0.55, z)
        count = int(520 * radius * height)
        for j in range(count):
            direction = r.normal(0, 1, 3); direction /= np.linalg.norm(direction)
            rho = float(r.uniform(0.3, 1.0)) ** 0.45
            offset = Vector((direction[0] * radius * rho, direction[1] * radius * rho, direction[2] * height * 0.55 * rho))
            p = centre + offset
            if p.z < 0.06:
                continue
            # Leaves face outward from the bush centre, tilted like real foliage.
            outward = Vector(direction).normalized()
            side = outward.cross(Vector((0, 0, 1)))
            if side.length < 0.05:
                side = Vector((1, 0, 0))
            side.normalize(); up = side.cross(outward).normalized()
            angle = float(r.uniform(0, math.tau)); length = float(r.uniform(0.09, 0.15))
            u = (side * math.cos(angle) + up * math.sin(angle)) * length
            v = (up * math.cos(angle) - side * math.sin(angle)) * length * 0.6 + outward * float(r.uniform(0.03, 0.08))
            leaf(p, u, v, palette[j % 4])
    mesh = bpy.data.meshes.new('Bushes'); mesh.from_pydata(verts, [], faces); mesh.update()
    obj = bpy.data.objects.new('Bushes', mesh); bpy.context.scene.collection.objects.link(obj)
    mesh.materials.append(materials['leaves'])
    col = mesh.color_attributes.new(name='Color', type='FLOAT_COLOR', domain='CORNER')
    for poly in mesh.polygons:
        poly.use_smooth = True
        for li in poly.loop_indices:
            col.data[li].color = colors[mesh.loops[li].vertex_index]
    mesh.uv_layers.new(name='UVMap')
    log(f'bushes: {len(BUSHES)} bushes, {len(faces)} triangles')
    return obj


# ---------------------------------------------------------------------------------------------
# Kannon Town v3: checkpoint dressing (all geometry here is original to this script)
# ---------------------------------------------------------------------------------------------

OBSTACLES = {o['id']: o for o in MAP['obstacles']}


class MeshBuilder:
    """Collects faces in game coordinates (Y up) with per-corner UVs and linear colours."""

    def __init__(self):
        self.verts, self.faces, self.uvs, self.colors, self.mats = [], [], [], [], []

    def vertex(self, p):
        self.verts.append(gb(float(p[0]), float(p[1]), float(p[2])))
        return len(self.verts) - 1

    def face(self, points, uvs, colour, mat=0):
        """Corners counter-clockwise seen from outside."""
        self.indexed([self.vertex(p) for p in points], uvs, colour, mat)

    def indexed(self, idx, uvs, colour, mat=0):
        colours = colour if isinstance(colour[0], (tuple, list)) else [colour] * len(idx)
        self.faces.append(list(idx)); self.uvs.append(list(uvs)); self.colors.append(list(colours)); self.mats.append(mat)

    def oriented(self, points, uvs, colour, outward, mat=0):
        """Add a planar face, reversing it if its normal does not point along `outward`."""
        p = [np.array(q, float) for q in points]
        normal = np.cross(p[1] - p[0], p[2] - p[0])
        if np.dot(normal, outward) < 0:
            points, uvs = list(reversed(points)), list(reversed(uvs))
        self.face(points, uvs, colour, mat)

    def build(self, name, materials, smooth=False, collection=None):
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata([tuple(v) for v in self.verts], [], [tuple(f) for f in self.faces])
        mesh.update()
        assert len(mesh.polygons) == len(self.faces), f'{name}: {len(mesh.polygons)} of {len(self.faces)} faces survived'
        for mat in materials:
            mesh.materials.append(mat)
        uv = mesh.uv_layers.new(name='UVMap')
        col = mesh.color_attributes.new(name='Color', type='FLOAT_COLOR', domain='CORNER')
        for poly, fuv, fcol, fmat in zip(mesh.polygons, self.uvs, self.colors, self.mats):
            poly.material_index = fmat
            poly.use_smooth = smooth
            for k, li in enumerate(poly.loop_indices):
                uv.data[li].uv = fuv[k]
                c = fcol[k]; col.data[li].color = (c[0], c[1], c[2], 1.0)
        obj = bpy.data.objects.new(name, mesh)
        (collection or checkpoint_collection()).objects.link(obj)
        return obj


def checkpoint_collection():
    col = bpy.data.collections.get('Checkpoint')
    if not col:
        col = bpy.data.collections.new('Checkpoint')
        bpy.context.scene.collection.children.link(col)
    return col


def rot_y(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rot_z(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def add_box(b, centre, size, colour, mat=0, tile=1.0, rot=None, uv_offset=(0.0, 0.0), skip=()):
    """Axis box in a local frame `rot` (3x3, local to game). `skip` lists local normals to omit."""
    R = np.eye(3) if rot is None else rot
    hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
    faces = [((1, 0, 0), [(hx, -hy, hz), (hx, -hy, -hz), (hx, hy, -hz), (hx, hy, hz)], (2, 1)),
             ((-1, 0, 0), [(-hx, -hy, -hz), (-hx, -hy, hz), (-hx, hy, hz), (-hx, hy, -hz)], (2, 1)),
             ((0, 1, 0), [(-hx, hy, hz), (hx, hy, hz), (hx, hy, -hz), (-hx, hy, -hz)], (0, 2)),
             ((0, -1, 0), [(-hx, -hy, -hz), (hx, -hy, -hz), (hx, -hy, hz), (-hx, -hy, hz)], (0, 2)),
             ((0, 0, 1), [(-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz)], (0, 1)),
             ((0, 0, -1), [(hx, -hy, -hz), (-hx, -hy, -hz), (-hx, hy, -hz), (hx, hy, -hz)], (0, 1))]
    c0 = np.array(centre, float)
    for normal, corners, (ua, va) in faces:
        if normal in skip:
            continue
        pts = [tuple(c0 + R @ np.array(c)) for c in corners]
        uvs = [((c[ua] + uv_offset[0]) / tile, (c[va] + uv_offset[1]) / tile) for c in corners]
        b.face(pts, uvs, colour, mat)


def tube_frames(points):
    """Parallel-transport frames along a polyline, so tubes never twist."""
    pts = [np.array(p, float) for p in points]
    tangents = []
    for i in range(len(pts)):
        t = pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]
        tangents.append(t / (np.linalg.norm(t) + 1e-12))
    helper = np.array([0.0, 1.0, 0.0]) if abs(tangents[0][1]) < 0.9 else np.array([1.0, 0.0, 0.0])
    u = np.cross(tangents[0], helper); u /= np.linalg.norm(u)
    frames = []
    for t in tangents:
        u = u - t * np.dot(u, t); u /= (np.linalg.norm(u) + 1e-12)
        frames.append((u, np.cross(t, u)))
    return pts, frames


def add_tube(b, points, radius, sides, colour, mat=0, tile=0.5, caps=False):
    pts, frames = tube_frames(points)
    rings, length = [], 0.0
    for i, (p, (u, v)) in enumerate(zip(pts, frames)):
        if i:
            length += float(np.linalg.norm(p - pts[i - 1]))
        r = radius[i] if isinstance(radius, (list, tuple)) else radius
        rings.append(([b.vertex(tuple(p + r * (math.cos(2 * math.pi * k / sides) * u + math.sin(2 * math.pi * k / sides) * v))) for k in range(sides)], length))
    for i in range(len(rings) - 1):
        (ra, la), (rb, lb) = rings[i], rings[i + 1]
        for k in range(sides):
            k2 = (k + 1) % sides
            b.indexed([ra[k], ra[k2], rb[k2], rb[k]], [(k / sides, la / tile), ((k + 1) / sides, la / tile), ((k + 1) / sides, lb / tile), (k / sides, lb / tile)], colour, mat)
    if caps:
        for ring, outward in ((rings[0][0], -1), (rings[-1][0], 1)):
            idx = list(ring) if outward > 0 else list(reversed(ring))
            b.indexed(idx, [(0.5 + 0.5 * math.cos(2 * math.pi * k / sides), 0.5 + 0.5 * math.sin(2 * math.pi * k / sides)) for k in range(sides)], colour, mat)


def add_sack(b, centre, length, width, height, yaw, colour, r, mat=0, tile=0.5, detail=3):
    """A filled sack: a rounded box, flattened where sacks press together, pinched at the sewn
    ends and sagging in the middle. `yaw` turns the sack's length off the game x axis."""
    n = detail
    hl, hh, hw = length / 2, height / 2, width / 2
    c, s = math.cos(yaw), math.sin(yaw)
    bump = r.uniform(-1, 1, 3)
    keys = {}

    def vert(i, j, k):
        key = (i, j, k)
        if key in keys:
            return keys[key]
        q = np.array([2 * i / n - 1, 2 * j / n - 1, 2 * k / n - 1], float)
        p = q / (np.sum(np.abs(q) ** 3.0) ** (1 / 3.0))
        x, y, z = p
        y = math.copysign(min(abs(y), 0.84), y) / 0.84
        end = max(0.0, (abs(x) - 0.62) / 0.38)
        y *= 1 - 0.18 * end; z *= 1 - 0.12 * end
        lx = x * hl + 0.006 * bump[0] * math.sin(3 * y)
        ly = y * hh - 0.012 * (1 - x * x) + 0.004 * bump[1] * math.cos(4 * z)
        lz = z * hw + 0.008 * bump[2] * math.cos(2.5 * x)
        keys[key] = b.vertex((centre[0] + lx * c + lz * s, centre[1] + ly, centre[2] - lx * s + lz * c))
        return keys[key]

    dims = (length, height, width)
    for axis, (t1, t2) in ((0, (1, 2)), (1, (2, 0)), (2, (0, 1))):
        for sign in (-1, 1):
            a1, a2 = (t1, t2) if sign > 0 else (t2, t1)
            for u in range(n):
                for v in range(n):
                    corners = []
                    for du, dv in ((0, 0), (1, 0), (1, 1), (0, 1)):
                        idx = [0, 0, 0]; idx[axis] = n if sign > 0 else 0; idx[a1] = u + du; idx[a2] = v + dv
                        corners.append(idx)
                    ids = [vert(*cc) for cc in corners]
                    uvs = [(cc[a1] / n * dims[a1] / tile, cc[a2] / n * dims[a2] / tile) for cc in corners]
                    b.indexed(ids, uvs, colour, mat)


# Inside the 3 cm the validator leaves at each face edge, so every sampled ray meets the core.
SANDBAG_CORE_INSET = 0.025


def build_sandbags(M):
    """Six sandbag walls, seven courses of three rows, laid in a broken bond with the bulge of
    every outer sack 1.5 cm proud of its collision face. Hidden inner sacks are skipped; a core
    block of packed sacking 2.5 cm inside the collision faces fills the wall, so the seams
    between sacks are never deeper than the core and never show daylight through the wall."""
    b = MeshBuilder(); r = np.random.default_rng(4101); sacks = 0
    for o in MAP['obstacles']:
        if o.get('surface') != 'sandbag':
            continue
        along_x = o['w'] >= o['d']
        L, D, H = (o['w'], o['d'], o['h']) if along_x else (o['d'], o['w'], o['h'])
        base = o['y'] - H / 2
        courses, rows = 7, 3
        ch, rw = H / courses, D / rows
        per_row = max(1, round(L / 0.62)); sack_len = L / per_row
        # Sacks are wider than their row so neighbours squeeze together without deep gaps.
        sack_w = rw * 1.3
        half_w = sack_w / 2

        def game(a, depth, y):
            return (o['x'] + (a if along_x else depth), y, o['z'] + (depth if along_x else a))

        for k in range(courses):
            y = base + ch * (k + 0.5)
            # Seams never fall on the wall's centre line or at the same place as the course below.
            offset = sack_len * (0.25 if k % 2 == 0 else 0.75)
            cuts = [-L / 2] + [-L / 2 + offset + i * sack_len for i in range(per_row + 1) if -L / 2 + offset + i * sack_len < L / 2 - 1e-6] + [L / 2]
            pieces = [(cuts[i], cuts[i + 1]) for i in range(len(cuts) - 1) if cuts[i + 1] - cuts[i] > 1e-6]
            if pieces[0][1] - pieces[0][0] < 0.3 and len(pieces) > 1:
                pieces = [(pieces[0][0], pieces[1][1])] + pieces[2:]
            if pieces[-1][1] - pieces[-1][0] < 0.3 and len(pieces) > 1:
                pieces = pieces[:-2] + [(pieces[-2][0], pieces[-1][1])]
            for row in range(rows):
                outer = row in (0, rows - 1)
                depth = -D / 2 + rw * (row + 0.5)
                if outer:
                    depth = math.copysign(D / 2 + 0.015 - half_w, depth)
                for i, (a0, a1) in enumerate(pieces):
                    end = i in (0, len(pieces) - 1)
                    if not (outer or end or k == courses - 1):
                        continue
                    centre_a = (a0 + a1) / 2 + (-0.012 if i == 0 else 0.012 if i == len(pieces) - 1 else 0.0)
                    tone = r.uniform(0.84, 1.07); hue = r.uniform(-0.05, 0.05)
                    colour = (SANDBAG_KHAKI[0] * tone * (1 + hue), SANDBAG_KHAKI[1] * tone, SANDBAG_KHAKI[2] * tone * (1 - hue))
                    jitter = r.uniform(-0.006, 0.006, 3)
                    yaw = (0.0 if along_x else math.pi / 2) + r.uniform(-0.03, 0.03)
                    add_sack(b, game(centre_a + jitter[0], depth + jitter[2] * 0.5, y + jitter[1]), (a1 - a0) * 1.03 + 0.03,
                             sack_w, ch * 1.2, yaw, colour, r)
                    sacks += 1
        inset = SANDBAG_CORE_INSET
        core = (L - 2 * inset, H - inset, D - 2 * inset)
        add_box(b, game(0.0, 0.0, base + core[1] / 2), core if along_x else (core[2], core[1], core[0]),
                tuple(c * 0.42 for c in SANDBAG_KHAKI), tile=0.5, skip=((0, -1, 0),))
    obj = b.build('Prop_sandbags', [M['burlap']], smooth=True)
    log(f'sandbags: {sacks} sacks, {len(obj.data.polygons)} faces')
    return obj


# (height, half depth) of a jersey-style barrier on a 0.96 x 0.6 box: a toe and a short slope,
# then nearly upright faces so the concrete stays within a few centimetres of the collision box.
BARRIER_PROFILE = [(0.0, 0.318), (0.075, 0.318), (0.30, 0.284), (0.925, 0.276), (0.96, 0.25)]
# Regions of the Poly Haven barrier texture atlas (u0, u1, v0, v1).
BARRIER_PANELS = [(0.055, 0.37, 0.04, 0.68), (0.415, 0.755, 0.04, 0.69)]
BARRIER_TOP = (0.24, 0.905, 0.735, 0.975)
BARRIER_END = (0.30, 0.40, 0.76, 0.95)  # a clean patch of the top band; the atlas's end strips are smeared


def build_barriers(M):
    """Each barrier box holds two precast units butted together off-centre."""
    b = MeshBuilder(); r = np.random.default_rng(4201)
    for o in MAP['obstacles']:
        if o.get('surface') != 'barrier':
            continue
        along_x = o['w'] >= o['d']
        L, D, H = (o['w'], o['d'], o['h']) if along_x else (o['d'], o['w'], o['h'])
        prof = [(h * H / 0.96, d * (D / 2) / 0.3) for h, d in BARRIER_PROFILE]
        base = o['y'] - H / 2

        def game(a, depth, y):
            return (o['x'] + (a if along_x else depth), base + y, o['z'] + (depth if along_x else a))

        def out(a=0.0, depth=0.0, y=0.0):
            return np.array([a if along_x else depth, y, depth if along_x else a], float)

        arcs = [0.0]
        for i in range(1, len(prof)):
            arcs.append(arcs[-1] + math.hypot(prof[i][0] - prof[i - 1][0], prof[i][1] - prof[i - 1][1]))
        joint = 0.2
        for ui, (a0, a1) in enumerate(((-L / 2, joint - 0.006), (joint + 0.006, L / 2))):
            tone = r.uniform(0.9, 1.04)
            colour = (tone, tone, tone * 0.98)
            for side in (1, -1):
                u0, u1, v0, v1 = BARRIER_PANELS[(ui + (side < 0)) % 2]
                for i in range(len(prof) - 1):
                    (h0, d0), (h1, d1) = prof[i], prof[i + 1]
                    s0, s1 = arcs[i] / arcs[-1], arcs[i + 1] / arcs[-1]
                    pts = [game(a0, side * d0, h0), game(a1, side * d0, h0), game(a1, side * d1, h1), game(a0, side * d1, h1)]
                    uvs = [(u0 + s0 * (u1 - u0), v0), (u0 + s0 * (u1 - u0), v1), (u0 + s1 * (u1 - u0), v1), (u0 + s1 * (u1 - u0), v0)]
                    b.oriented(pts, uvs, colour, out(depth=side, y=0.3))
            dt = prof[-1][1]
            tu0, tu1, tv0, tv1 = BARRIER_TOP
            b.oriented([game(a0, -dt, H), game(a1, -dt, H), game(a1, dt, H), game(a0, dt, H)],
                       [(tu0, tv0), (tu1, tv0), (tu1, tv1), (tu0, tv1)], colour, out(y=1))
            eu0, eu1, ev0, ev1 = BARRIER_END
            for a, direction in ((a0, -1), (a1, 1)):
                ring = [(prof[i][1], prof[i][0]) for i in range(len(prof))] + [(-prof[i][1], prof[i][0]) for i in reversed(range(len(prof)))]
                pts = [game(a, d, h) for d, h in ring]
                uvs = [(eu0 + (d + D / 2) / D * (eu1 - eu0), ev0 + h / H * (ev1 - ev0)) for d, h in ring]
                b.oriented(pts, uvs, colour, out(a=direction))
            # Two lifting loops cast into the top of each unit.
            for f in (0.27, 0.73):
                a = a0 + (a1 - a0) * f
                loop = [game(a - 0.06, 0.0, H - 0.01), game(a - 0.06, 0.0, H + 0.05), game(a + 0.06, 0.0, H + 0.05), game(a + 0.06, 0.0, H - 0.01)]
                add_tube(b, loop, 0.008, 4, (0.32, 0.19, 0.12), mat=1)
        # A filler in the 12 mm joint between the two units closes it: the joint shows shadow,
        # never daylight. It follows the profile a few centimetres inside the faces (a narrower
        # piece under the top chamfer) and stays a millimetre clear of both unit ends, so no face
        # is shared and nothing flickers.
        for y0, y1, depth in ((0.0, H - 0.05, D - 0.056), (H - 0.05, H - 0.015, 0.5 * D / 0.6)):
            slab = (0.010, y1 - y0, depth)
            add_box(b, game(joint, 0.0, (y0 + y1) / 2), slab if along_x else (slab[2], slab[1], slab[0]), (0.3, 0.3, 0.29),
                    tile=8.0, skip=((0, -1, 0),))
    obj = b.build('Prop_barriers', [M['barrier'], M['paint']])
    log(f'barriers: {len(obj.data.polygons)} faces')
    return obj


def build_truck_details(M):
    """Cab front, mirrors and steps, canvas straps and ropes, and the rolled rear flap."""
    b = MeshBuilder()
    dark = (0.07, 0.075, 0.06); strap = (0.2, 0.22, 0.16)
    add_box(b, (2.65, 0.40, -0.21), (3.4, 0.24, 0.22), dark)                          # bumper
    for x in (1.25, 4.05):
        add_box(b, (x, 0.40, -0.36), (0.1, 0.1, 0.12), (0.3, 0.07, 0.04))              # tow hooks
    add_box(b, (2.65, 0.92, -0.115), (2.1, 0.62, 0.03), (0.04, 0.045, 0.04))           # grille recess
    for i in range(6):
        add_box(b, (2.65, 0.66 + i * 0.105, -0.135), (2.1, 0.035, 0.03), OLIVE_PAINT)  # grille slats
    for x in (1.42, 3.88):
        add_box(b, (x, 0.92, -0.215), (0.34, 0.3, 0.05), dark)                          # lamp guard plate
        add_tube(b, [(x, 0.92, -0.24), (x, 0.92, -0.30)], 0.12, 12, dark, caps=True)    # headlight bezel
        add_tube(b, [(x, 0.92, -0.30), (x, 0.92, -0.31)], 0.095, 12, (0.75, 0.74, 0.66), caps=True)
    add_box(b, (2.65, 1.915, -0.155), (0.06, 0.9, 0.03), dark)                         # windscreen divider
    for x in (1.95, 3.35):
        add_box(b, (x, 1.6, -0.16), (0.6, 0.025, 0.02), dark, rot=rot_z(0.35))          # wipers
    for x, side in ((1.1, -1), (4.2, 1)):
        add_box(b, (x + side * 0.16, 2.02, 0.05), (0.32, 0.03, 0.03), dark)             # mirror arm
        add_box(b, (x + side * 0.33, 1.95, 0.05), (0.05, 0.32, 0.2), dark)              # mirror
        add_box(b, (x + side * 0.07, 0.48, 1.3), (0.14, 0.05, 0.55), dark)              # door step
        add_box(b, (x + side * 0.006, 1.25, 2.3), (0.012, 1.9, 0.02), dark)             # door seam
        add_box(b, (x + side * 0.02, 1.15, 2.1), (0.03, 0.04, 0.22), dark)              # door handle
    for z in (3.4, 5.1, 6.8, 8.5, 9.95):
        for x in (0.894, 4.406):
            add_box(b, (x, 2.28, z), (0.012, 1.76, 0.05), strap, mat=1, tile=1.0)       # side straps
        add_box(b, (2.65, 3.166, z), (3.52, 0.012, 0.05), strap, mat=1, tile=1.0)      # roof straps
    for x in (0.884, 4.416):
        add_box(b, (x, 1.43, 6.3), (0.02, 0.025, 7.62), strap, mat=1, tile=1.0)         # lashing rope
    add_tube(b, [(1.0, 2.93, 10.17), (4.3, 2.93, 10.17)], 0.1, 12, tuple(c * 0.9 for c in OLIVE_CANVAS), mat=1, tile=1.0, caps=True)
    obj = b.build('Prop_truck_details', [M['paint'], M['canvas']])
    log(f'truck details: {len(obj.data.polygons)} faces')
    return obj


CRATE_SIDES = (('-x', (-1, 0, 0)), ('+x', (1, 0, 0)), ('-z', (0, 0, -1)), ('+z', (0, 0, 1)))


def add_crate(b, x, y, z, yaw, colour, size, mat=0, stripe=False, exposed=('-x', '+x', '-z', '+z', 'top')):
    """An ammunition crate standing at height y: a body, a lid that overhangs 8 mm, rope handles
    on the ends, latches and corner battens on the long sides and an optional stencil band.
    `size` is (length, height, width), length along the local x axis. Only the `exposed` faces
    and their fittings are built; the rest are pressed against other crates."""
    L, H, W = size
    R = rot_y(yaw)
    lid = tuple(c * 0.82 for c in colour)
    hidden = tuple(normal for key, normal in CRATE_SIDES if key not in exposed)
    add_box(b, (x, y + (H - 0.04) / 2, z), (L, H - 0.04, W), colour, mat, rot=R, uv_offset=(x, z), skip=hidden + ((0, 1, 0), (0, -1, 0)))
    add_box(b, (x, y + H - 0.02, z), (L + 0.016, 0.04, W + 0.016), lid, mat, rot=R, uv_offset=(z, x),
            skip=hidden + ((0, -1, 0),) + (() if 'top' in exposed else ((0, 1, 0),)))
    for end, key in ((-1, '-x'), (1, '+x')):
        if key in exposed:
            centre = np.array([x, y + H * 0.6, z]) + R @ np.array([end * (L / 2 + 0.012), 0, 0])
            add_box(b, tuple(centre), (0.024, 0.04, min(0.16, W * 0.45)), (0.05, 0.05, 0.045), mat, rot=R, skip=((-end, 0, 0),))
    for side, key in ((-1, '-z'), (1, '+z')):
        if key not in exposed:
            continue
        flush = ((0, 0, -side),)
        for along in (-0.3 * L, 0.3 * L):
            centre = np.array([x, y + H - 0.07, z]) + R @ np.array([along, 0, side * (W / 2 + 0.005)])
            add_box(b, tuple(centre), (0.06, 0.05, 0.01), (0.12, 0.12, 0.1), mat, rot=R, skip=flush)
        if stripe:
            # A faded yellow stencil band across the long side.
            centre = np.array([x, y + H * 0.45, z]) + R @ np.array([0.0, 0, side * (W / 2 + 0.0015)])
            add_box(b, tuple(centre), (L * 0.62, 0.035, 0.003), (0.42, 0.33, 0.07), mat, rot=R, skip=flush)
        for end in (-1, 1):
            # Darker corner battens make the crate read as a timber box, not a carton.
            centre = np.array([x, y + (H - 0.04) / 2, z]) + R @ np.array([end * (L / 2 - 0.02), 0, side * (W / 2 + 0.002)])
            add_box(b, tuple(centre), (0.04, H - 0.05, 0.006), tuple(c * 0.7 for c in colour), mat, rot=R, skip=flush)


# The three prop cover boxes become stacks of ammunition crates that fill each box to within a
# centimetre of its faces, so no part of a box blocks shots without something visible there.
# (box id, cells along x, cells along z, layers, tarp x-extent as box fractions, seed)
CRATE_STACKS = [
    ('north-mail-crates', 3, 5, 4, (0.16, 1.0), 4301),
    ('teal-yard-cover', 5, 3, 3, (0.0, 0.62), 4311),
    ('yellow-yard-cover', 5, 3, 3, (0.38, 1.0), 4321),
]
CRATE_COLOURS = (OLIVE_PAINT, (0.13, 0.16, 0.09), (0.24, 0.2, 0.12))


def drape_tarp(t, o, x_from, x_to, r):
    """A canvas sheet over part of a crate stack: across the top between x_from and x_to (box
    fractions) and down the north and south faces to a wavy hem, always 1.5 to 4 cm proud of the
    crates so it never sinks into them and never stands far from the collision face."""
    W, H, D = o['w'], o['h'], o['d']
    top = o['y'] + H / 2
    zn, zs = o['z'] - D / 2, o['z'] + D / 2
    xa = o['x'] - W / 2 + x_from * W + 0.01
    xb = o['x'] - W / 2 + x_to * W - 0.01
    radius, gap = 0.035, 0.016
    nx, nt = max(10, int((xb - xa) / 0.06)), 36
    hem_s = periodic_noise(64, 5, int(r.integers(1, 1 << 30)))[0]
    hem_n = periodic_noise(64, 5, int(r.integers(1, 1 << 30)))[0]
    wrinkle = periodic_noise(64, 2.5, int(r.integers(1, 1 << 30)))
    rows = []
    for i in range(nx + 1):
        x = xa + (xb - xa) * i / nx
        k = int(i / nx * 63)
        drop_s = H * min(0.85, max(0.25, 0.55 + 0.12 * float(hem_s[k])))
        drop_n = H * min(0.85, max(0.25, 0.5 + 0.12 * float(hem_n[k])))
        # Cross-section path (z, y, outward normal): south face up, over the rounded edge, across
        # the top, over the far edge and down the north face.
        path = [(zs + gap, top - drop_s, (1.0, 0.0)), (zs + gap, top - radius, (1.0, 0.0))]
        for a in np.linspace(0, math.pi / 2, 5)[1:]:
            path.append((zs - radius + (radius + gap) * math.cos(a), top - radius + (radius + gap) * math.sin(a), (math.cos(a), math.sin(a))))
        path.append((zn + radius, top + gap, (0.0, 1.0)))
        for a in np.linspace(math.pi / 2, math.pi, 5)[1:]:
            path.append((zn + radius + (radius + gap) * math.cos(a), top - radius + (radius + gap) * math.sin(a), (math.cos(a), math.sin(a))))
        path.append((zn - gap, top - drop_n, (-1.0, 0.0)))
        lengths = [0.0]
        for p, q in zip(path, path[1:]):
            lengths.append(lengths[-1] + math.hypot(q[0] - p[0], q[1] - p[1]))
        fold = lengths[5]  # path[5] is where the top begins: texture seams run straight across it
        row = []
        for j in range(nt + 1):
            s = lengths[-1] * j / nt
            seg = max(0, min(len(path) - 2, int(np.searchsorted(lengths, s, side='right')) - 1))
            f = (s - lengths[seg]) / max(lengths[seg + 1] - lengths[seg], 1e-9)
            (z0, y0, n0), (z1, y1, n1) = path[seg], path[seg + 1]
            z, y = z0 + (z1 - z0) * f, y0 + (y1 - y0) * f
            nz, ny = n0[0] + (n1[0] - n0[0]) * f, n0[1] + (n1[1] - n0[1]) * f
            norm = math.hypot(nz, ny) or 1.0
            # Folds only ever push outward; the hem flares a little. Never more than 4.4 cm from
            # the crates, so the tarp stays part of the cover rather than the walkway.
            hem = max(0.0, 1.0 - min(s, lengths[-1] - s) / 0.12)
            lift = min(0.028, 0.012 * max(0.0, float(wrinkle[j % 64, k])) + 0.008 * hem)
            row.append((t.vertex((x, y + ny / norm * lift, z + nz / norm * lift)), s - fold))
        rows.append(row)
    for i in range(nx):
        for j in range(nt):
            corners = [(i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1)]
            ids = [rows[a][c][0] for a, c in corners]
            uvs = [(xa + (xb - xa) * a / nx, rows[a][c][1]) for a, c in corners]
            t.indexed(ids, uvs, TARP_GREEN)


def build_crate_stacks(M):
    """Ammunition crates stacked in the three prop cover boxes, each partly under a tarp. Long
    crates span two cells so seams do not line up; hidden inner crates are skipped and a dark
    core 5 cm inside the faces closes the gaps between crates."""
    b, t = MeshBuilder(), MeshBuilder()
    crates = 0
    for box_id, cols, rows, layers, (tarp_from, tarp_to), seed in CRATE_STACKS:
        o = OBSTACLES[box_id]
        r = np.random.default_rng(seed)
        W, H, D = o['w'], o['h'], o['d']
        x0, y0, z0 = o['x'] - W / 2, o['y'] - H / 2, o['z'] - D / 2
        cw, ch, cd = W / cols, H / layers, D / rows
        gap = 0.012
        for layer in range(layers):
            for rw in range(rows):
                spans, c = [], 0
                while c < cols:
                    n = 2 if c + 1 < cols and r.random() < 0.35 else 1
                    spans.append((c, n)); c += n
                for c, n in spans:
                    if not (c == 0 or c + n == cols or rw in (0, rows - 1) or layer == layers - 1):
                        continue
                    pick = r.random()
                    base = CRATE_COLOURS[0] if pick < 0.7 else CRATE_COLOURS[1] if pick < 0.9 else CRATE_COLOURS[2]
                    tone = r.uniform(0.82, 1.06)
                    exposed = [key for key, out in (('-x', c == 0), ('+x', c + n == cols), ('-z', rw == 0), ('+z', rw == rows - 1), ('top', layer == layers - 1)) if out]
                    add_crate(b, x0 + cw * (c + n / 2), y0 + ch * layer, z0 + cd * (rw + 0.5), r.uniform(-0.006, 0.006) / n,
                              tuple(v * tone for v in base), (cw * n - gap, ch, cd - gap), stripe=r.random() < 0.4, exposed=exposed)
                    crates += 1
        inset = 0.05
        add_box(b, (o['x'], y0 + (H - inset) / 2, o['z']), (W - 2 * inset, H - inset, D - 2 * inset), (0.05, 0.055, 0.04),
                tile=1.0, skip=((0, -1, 0),))
        drape_tarp(t, o, tarp_from, tarp_to, r)
    stack = b.build('Prop_ammo_crates', [M['paint']])
    tarp = t.build('Prop_tarp', [M['canvas']], smooth=True)
    log(f'crate stacks: {crates} crates, {len(stack.data.polygons)} faces; tarps {len(tarp.data.polygons)} faces')
    return stack, tarp


def reskin_bus(M):
    """Faded paint, and grime that thickens toward the road."""
    body = bpy.data.objects.get('Vehicle_bus_bus')
    if not body:
        log('missing Vehicle_bus_bus'); return
    body.data.materials.clear(); body.data.materials.append(M['bus'])
    ensure_color_attribute(body)
    mesh, world = body.data, body.matrix_world
    colors = mesh.color_attributes['Color']
    for li, loop in enumerate(mesh.loops):
        p = bg(world @ mesh.vertices[loop.vertex_index].co)
        grime = 0.6 + 0.4 * float(smoothstep(0.3, 1.7, p[1]))
        streak = 0.94 + 0.06 * math.sin(p[2] * 7.3 + p[1] * 2.1)
        colors.data[li].color = (grime * streak, grime * streak * 0.98, grime * streak * 0.95, 1.0)


def burn_car(M):
    """The north car burned out: charred and rusted body, smoke-blackened glass, melted tyres."""
    tints = {'north': (1.0, 1.0, 1.0), 'chrome': (0.62, 0.52, 0.46), 'glass': (0.28, 0.27, 0.26), 'lamp': (0.4, 0.38, 0.36),
             'amber': (0.45, 0.36, 0.3), 'red': (0.45, 0.36, 0.3), 'rubber': (0.2, 0.19, 0.18), 'steel': (0.9, 0.72, 0.6),
             'trim': (0.36, 0.34, 0.32), 'recess': (0.25, 0.24, 0.23), 'dust': (0.5, 0.48, 0.45)}
    r = np.random.default_rng(4401)
    for suffix, tint in tints.items():
        obj = bpy.data.objects.get(f'Vehicle_north_{suffix}')
        if not obj:
            continue
        obj.data.materials.clear(); obj.data.materials.append(M['burnt'])
        ensure_color_attribute(obj)
        mesh, world = obj.data, obj.matrix_world
        layer = mesh.uv_layers.get('UVMap') or mesh.uv_layers.new(name='UVMap')
        offset = r.uniform(0, 10, 2)
        for poly in mesh.polygons:
            planar_face_uv(obj, poly, layer, 0.8, world)
            for li in poly.loop_indices:
                u, v = layer.data[li].uv; layer.data[li].uv = (u + offset[0], v + offset[1])
        colors = mesh.color_attributes['Color']
        for li, loop in enumerate(mesh.loops):
            p = bg(world @ mesh.vertices[loop.vertex_index].co)
            soot = 0.8 + 0.2 * math.sin(p[0] * 3.1 + p[2] * 4.7)
            colors.data[li].color = (tint[0] * soot, tint[1] * soot, tint[2] * soot, 1.0)
    log('north car burned out')


def build_window_boards(M):
    """Plywood planks nailed over the ground-floor side windows and one upstairs window."""
    b = MeshBuilder(); r = np.random.default_rng(4501)
    windows = [(s, xa, xb, 1.03, 2.37) for s in (-1, 1) for xa, xb in ((11.91, 13.49), (18.61, 20.19))]
    windows.append((-1, 18.61, 20.19, 4.18, 5.52))
    for s, xa, xb, ya, yb in windows:
        x0, x1 = sorted((s * xa, s * xb))
        cx, width = (x0 + x1) / 2, (x1 - x0) + 0.36
        planks = 5; ph = (yb - ya + 0.3) / planks
        for i in range(planks):
            if r.random() < 0.1:
                continue
            y = ya - 0.15 + ph * (i + 0.5)
            tone = r.uniform(0.62, 0.8)
            colour = (tone, tone * 0.93, tone * 0.85)
            centre = (cx + r.uniform(-0.05, 0.05), y, -6.255 - 0.012 * (i % 2))
            R = rot_z(r.uniform(-0.05, 0.05))
            add_box(b, centre, (width, ph * 0.86, 0.022), colour, rot=R, tile=1.0, uv_offset=(centre[0], centre[1]))
    obj = b.build('Prop_boards', [M['boards']])
    log(f'window boards: {len(obj.data.polygons)} faces')
    return obj


def build_wire(M):
    """Concertina wire coiled along the tops of the boundary and yard fences."""
    b = MeshBuilder(); r = np.random.default_rng(4601)
    paths = [((-30.85, -23.0), (30.85, -23.0)), ((-30.85, 23.0), (30.85, 23.0)), ((-31.0, -22.85), (-31.0, 22.85)), ((31.0, -22.85), (31.0, 22.85))]
    radius, pitch, segments, wire = 0.27, 0.42, 8, 0.0065
    for (ax, az), (bx, bz) in paths:
        length = math.hypot(bx - ax, bz - az)
        dx, dz = (bx - ax) / length, (bz - az) / length
        sx, sz = -dz, dx
        loops = int(length / pitch)
        phase0 = r.uniform(0, math.tau)
        points = []
        for i in range(loops * segments + 1):
            t = i / segments
            angle = math.tau * t + phase0
            along = t * pitch + 0.04 * math.sin(angle * 2.0)
            rr = radius * (1 + 0.08 * math.sin(t * 1.3 + phase0))
            points.append((ax + dx * along + sx * rr * math.cos(angle), 2.6 + radius - 0.03 + rr * math.sin(angle), az + dz * along + sz * rr * math.cos(angle)))
        add_tube(b, points, wire, 3, (1.0, 1.0, 1.0))
    obj = b.build('Checkpoint_Wire', [M['wire']])
    log(f'wire: {len(obj.data.polygons)} faces')
    return obj


# Upstairs street windows: three panes between the mullions found in the base model.
UPSTAIRS_PANES = [(-3.335, -1.14), (-1.06, 1.06), (1.14, 3.335)]
UPSTAIRS_PANE_Y = (4.215, 5.785)


# Panes already broken when the match starts: a jagged hole with shards left in the frame. They
# stay Breakable_Glass_* nodes, so a shot still knocks the remaining shards out.
BROKEN_PANES = {1: 4801, 3: 4803}


def add_broken_pane(b, height, width, seed, thickness=0.008):
    """A pane in the local y-z plane with a jagged hole: radial strips between the frame and a
    spiky inner outline, front, back and the broken edge between them."""
    r = np.random.default_rng(seed)
    n = 28
    hy, hz = height / 2, width / 2
    centre = (r.uniform(-0.12, 0.05) * height, r.uniform(-0.15, 0.15) * width)  # hole a little low, off centre
    # Where the remaining glass begins, as a share of the way from the hole centre to the frame: an
    # uneven edge, a few long shards reaching in (small values) and stretches broken out to the frame.
    edge = np.clip(0.7 + 0.12 * periodic_noise(64, 3, seed)[0][:n] + r.uniform(-0.06, 0.06, n), 0.5, 0.92)
    edge[r.choice(n, 5, replace=False)] = r.uniform(0.25, 0.45, 5)
    edge[r.choice(n, 4, replace=False)] = 0.97
    outer, inner = [], []
    for k in range(n):
        a = 2 * math.pi * k / n
        dy, dz = math.sin(a), math.cos(a)
        # Distance from the hole centre to the frame along this direction.
        limits = [((hz - centre[1]) if dz > 0 else (hz + centre[1])) / abs(dz) if abs(dz) > 1e-6 else 1e9,
                  ((hy - centre[0]) if dy > 0 else (hy + centre[0])) / abs(dy) if abs(dy) > 1e-6 else 1e9]
        reach = min(limits)
        outer.append((centre[0] + dy * reach, centre[1] + dz * reach))
        f = min(float(edge[k]), 1.0 - 0.012 / max(reach, 0.012))
        inner.append((centre[0] + dy * reach * f, centre[1] + dz * reach * f))
    white = (1.0, 1.0, 1.0)
    front = [(b.vertex((thickness / 2, y, z)), b.vertex((thickness / 2, iy, iz))) for (y, z), (iy, iz) in zip(outer, inner)]
    back = [(b.vertex((-thickness / 2, y, z)), b.vertex((-thickness / 2, iy, iz))) for (y, z), (iy, iz) in zip(outer, inner)]
    for k in range(n):
        k2 = (k + 1) % n
        # The outline runs clockwise seen from +x (z points left there). Front faces +x, back
        # faces -x, and the broken edge faces into the hole.
        b.indexed([front[k][0], front[k][1], front[k2][1], front[k2][0]], [(0, 0)] * 4, white)
        b.indexed([back[k][0], back[k2][0], back[k2][1], back[k][1]], [(0, 0)] * 4, white)
        b.indexed([front[k][1], back[k][1], back[k2][1], front[k2][1]], [(0, 0)] * 4, white)


def build_breakable_glass(M):
    """Separate, named panes so the runtime can hide and shatter each one; two start broken."""
    panes = []
    for s in (-1, 1):
        for z0, z1 in UPSTAIRS_PANES:
            b = MeshBuilder()
            y0, y1 = UPSTAIRS_PANE_Y
            index = len(panes)
            if index in BROKEN_PANES:
                add_broken_pane(b, y1 - y0, z1 - z0, BROKEN_PANES[index])
            else:
                add_box(b, (0.0, 0.0, 0.0), (0.008, y1 - y0, z1 - z0), (1.0, 1.0, 1.0))
            obj = b.build(f'Breakable_Glass_{index}', [M['window_glass']])
            obj.location = gb(s * 9.75, (y0 + y1) / 2, (z0 + z1) / 2)
            obj['breakable'] = 'glass'
            panes.append(obj)
    log(f'breakable glass: {len(panes)} panes, {len(BROKEN_PANES)} already broken')
    return panes


POT_SPOTS = [(-9.45, 0.0, -4.0), (9.45, 0.0, -4.0), (-25.72, 3.2, 5.58), (25.72, 3.2, 5.58)]


def build_breakable_pots(M):
    """Terracotta pots with dry, dead plants, each its own object."""
    pots = []
    terracotta, soil, twig = (0.43, 0.13, 0.06), (0.05, 0.035, 0.025), (0.17, 0.12, 0.08)
    profile = [(0.0, 0.0), (0.12, 0.0), (0.135, 0.02), (0.18, 0.31), (0.205, 0.33), (0.205, 0.37), (0.185, 0.37), (0.175, 0.34)]
    for i, (x, y, z) in enumerate(POT_SPOTS):
        b = MeshBuilder(); r = np.random.default_rng(4700 + i)
        segments = 14
        rings = []
        for radius, height in profile:
            rings.append([b.vertex((radius * math.cos(math.tau * k / segments), height, radius * math.sin(math.tau * k / segments))) for k in range(segments)])
        for j in range(len(rings) - 1):
            for k in range(segments):
                k2 = (k + 1) % segments
                b.indexed([rings[j][k], rings[j + 1][k], rings[j + 1][k2], rings[j][k2]],
                          [(k / segments, j / 4), (k / segments, (j + 1) / 4), ((k + 1) / segments, (j + 1) / 4), ((k + 1) / segments, j / 4)], terracotta)
        disc = [b.vertex((0.176 * math.cos(math.tau * k / segments), 0.34, 0.176 * math.sin(math.tau * k / segments))) for k in range(segments)]
        b.indexed(list(reversed(disc)), [(0.5, 0.5)] * segments, soil)
        for _ in range(6):
            a0, a1 = r.uniform(0, math.tau, 2)
            start = (0.06 * math.cos(a0), 0.34, 0.06 * math.sin(a0))
            end = (0.22 * math.cos(a1), r.uniform(0.62, 0.92), 0.22 * math.sin(a1))
            mid = ((start[0] + end[0]) / 2 + r.uniform(-0.04, 0.04), (start[1] + end[1]) / 2, (start[2] + end[2]) / 2 + r.uniform(-0.04, 0.04))
            add_tube(b, [start, mid, end], [0.009, 0.006, 0.002], 3, twig)
        obj = b.build(f'Breakable_Pot_{i}', [M['pot']], smooth=False)
        obj.location = gb(x, y, z)
        obj['breakable'] = 'pot'
        pots.append(obj)
    log(f'breakable pots: {len(pots)}')
    return pots


# Faces of an eight-corner box listed bottom ring then top ring, each ring (-x-z, +x-z, +x+z,
# -x+z): top, bottom and four sides, counter-clockwise seen from outside.
BOX_FACES = ((4, 7, 6, 5), (0, 1, 2, 3), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0))
CONE_ORANGE, CONE_WHITE, CONE_BASE = (0.72, 0.12, 0.025), (0.75, 0.75, 0.72), (0.025, 0.025, 0.025)
# Traffic cones (x, z, yaw degrees, lying on its side). Small street furniture like the trash cans
# and hydrants: walk-through, kept to the edges of the lanes beside the checkpoint cover.
CONES = [
    (8.75, -9.2, 10, False), (8.6, -10.05, 40, False), (4.85, -9.65, 0, False),
    (-4.85, 9.6, 25, False), (-8.75, 9.25, 0, False), (-8.6, 10.1, 60, False),
    (2.25, -13.95, 15, False), (-1.05, 14.45, 0, False), (6.85, -15.4, 70, True),
]
# Spare cones stacked three deep on the north crate stack's tarp.
CONE_STACKS = [(-4.95, 1.43, -16.25)]


def add_cone(b, x, y, z, yaw, tipped=False, stack=1):
    """A 70 cm traffic cone on a square rubber base: faded orange with two white reflective bands,
    grimy toward the ground. `stack` nests that many cones, 6 cm apart."""
    sides = 16
    ring_heights = [0.03, 0.30, 0.36, 0.43, 0.50, 0.56, 0.63, 0.70]
    band = lambda h0, h1: (0.36 <= h0 < 0.43) or (0.50 <= h0 < 0.56)  # noqa: E731
    radius = lambda h: 0.155 - (0.155 - 0.028) * (h - 0.03) / 0.67  # noqa: E731
    # A fallen cone lies on the line from its base plate's edge to its tip: axis 12 deg past level.
    R = rot_y(math.radians(yaw)) @ (rot_z(math.radians(-102)) if tipped else np.eye(3))
    plate = [(sx * 0.18, h, sz * 0.18) for h in (0.0, 0.03) for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    tip = [(0.028 * math.cos(2 * math.pi * k / sides), 0.70, 0.028 * math.sin(2 * math.pi * k / sides)) for k in range(sides)]
    lift = -min(float((R @ np.array(p))[1]) for p in plate + tip)

    def at(p):
        q = R @ np.array(p, float)
        return (x + q[0], y + q[1] + lift, z + q[2])

    def grime(h, colour):
        f = 0.72 + 0.28 * float(smoothstep(0.0, 0.32, np.array(h)))
        return tuple(c * f for c in colour)

    for level in range(stack):
        dy = 0.06 * level
        if level == 0:
            ids = [b.vertex(at(c)) for c in plate]
            for f in BOX_FACES:
                b.indexed([ids[i] for i in f], [(0, 0)] * 4, CONE_BASE)
        rings = [[b.vertex(at((radius(h) * math.cos(2 * math.pi * k / sides), h + dy, radius(h) * math.sin(2 * math.pi * k / sides))))
                  for k in range(sides)] for h in ring_heights]
        for j in range(len(ring_heights) - 1):
            h0, h1 = ring_heights[j], ring_heights[j + 1]
            colour = grime(h0, CONE_WHITE if band(h0, h1) else CONE_ORANGE)
            for k in range(sides):
                k2 = (k + 1) % sides
                b.indexed([rings[j][k], rings[j + 1][k], rings[j + 1][k2], rings[j][k2]], [(k / sides, h0), (k / sides, h1), (k2 / sides, h1), (k2 / sides, h0)], colour)
        cap = [b.vertex(at((0.028 * math.cos(2 * math.pi * k / sides), 0.70 + dy, 0.028 * math.sin(2 * math.pi * k / sides)))) for k in range(sides)]
        b.indexed(list(reversed(cap)), [(0, 0)] * sides, grime(0.7, CONE_ORANGE))


def build_cones(M):
    b = MeshBuilder()
    for x, z, yaw, tipped in CONES:
        add_cone(b, x, 0.0, z, yaw, tipped)
    for x, y, z in CONE_STACKS:
        add_cone(b, x, y, z, 0.0, stack=3)
    obj = b.build('Prop_cones', [M['cone']], smooth=True)
    log(f'cones: {len(CONES)} standing or fallen, {len(CONE_STACKS)} stacks, {len(obj.data.polygons)} faces')
    return obj


def ground_is_free(x, z, pad=0.03):
    """True where a pebble on the ground would not sit inside any collision box."""
    return not any(abs(x - o['x']) <= o['w'] / 2 + pad and abs(z - o['z']) <= o['d'] / 2 + pad and o['y'] - o['h'] / 2 < 0.12
                   for o in MAP['obstacles'])


def add_chunk(b, x, z, size, yaw, colour, r, mat=0, uv_region=(0.3, 0.6, 0.78, 0.93)):
    """A rough lump of rubble resting on the ground: a box with its corners pulled about."""
    sx, sy, sz = size
    R = rot_y(yaw)
    corners = []
    for cy in (0.0, 1.0):
        for cx, cz in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            jitter = r.uniform(0.65, 1.0) if cy else r.uniform(0.85, 1.1)
            local = np.array([cx * sx / 2 * jitter, cy * sy * r.uniform(0.7, 1.0), cz * sz / 2 * jitter])
            q = R @ local
            corners.append(b.vertex((x + q[0], max(0.0, q[1]) + 0.002, z + q[2])))
    u0, u1, v0, v1 = uv_region
    uvs = [(u0 + (u1 - u0) * a, v0 + (v1 - v0) * c) for a, c in ((0.1, 0.1), (0.9, 0.1), (0.9, 0.9), (0.1, 0.9))]
    for f in BOX_FACES[:1] + BOX_FACES[2:]:  # no underside
        b.indexed([corners[i] for i in f], uvs, colour, mat)


def build_debris(M):
    """Rubble, splinters, scrap and spent cases on the ground, all under 10 cm tall so players
    walk over them: concrete chips by the barriers and sandbags, plaster and glazing-bar
    splinters under the broken panes and boarded windows, charred scrap round the burnt car."""
    b = MeshBuilder(); r = np.random.default_rng(4901)
    CONCRETE, SCRAP, BOARDS = 0, 1, 2
    placed = {'chunks': 0, 'splinters': 0, 'scrap': 0, 'cases': 0}

    def scatter(cx, cz, spread_x, spread_z, count, kind):
        for _ in range(count):
            x, z = cx + r.uniform(-spread_x, spread_x), cz + r.uniform(-spread_z, spread_z)
            # A quarter metre clear of every box: chips never read as part of the cover they lie by.
            if not ground_is_free(x, z, pad=0.25) or abs(x) > 30.6 or abs(z) > 22.6:
                continue
            yaw = r.uniform(0, math.tau)
            if kind == 'concrete':
                s = r.uniform(0.03, 0.11)
                tone = r.uniform(0.7, 1.0)
                add_chunk(b, x, z, (s, min(0.09, s * r.uniform(0.4, 0.8)), s * r.uniform(0.6, 1.0)), yaw, (tone, tone * 0.98, tone * 0.95), r, CONCRETE)
                placed['chunks'] += 1
            elif kind == 'plaster':
                s = r.uniform(0.02, 0.07)
                add_chunk(b, x, z, (s, s * 0.35, s * r.uniform(0.5, 1.0)), yaw, (1.0, 0.99, 0.96), r, CONCRETE)
                placed['chunks'] += 1
            elif kind == 'splinter':
                length = r.uniform(0.12, 0.42)
                add_box(b, (x, 0.008, z), (length, 0.014, r.uniform(0.018, 0.045)), (0.7, 0.62, 0.5), BOARDS, tile=1.0, rot=rot_y(yaw), uv_offset=(x, z))
                placed['splinters'] += 1
            elif kind == 'scrap':
                add_box(b, (x, 0.004, z), (r.uniform(0.08, 0.26), 0.006, r.uniform(0.06, 0.2)), (0.045, 0.04, 0.035), SCRAP, tile=1.0, rot=rot_y(yaw) @ rot_z(r.uniform(-0.04, 0.04)))
                placed['scrap'] += 1
            elif kind == 'case':
                start = np.array([x, 0.0057, z]); along = rot_y(yaw) @ np.array([0.045, 0.0, 0.0])
                add_tube(b, [tuple(start), tuple(start + along)], 0.0055, 6, (0.62, 0.42, 0.12), SCRAP, tile=0.05, caps=True)
                placed['cases'] += 1

    # Concrete chipped off the barriers and the kerbs near the checkpoint.
    for o in MAP['obstacles']:
        if o.get('surface') == 'barrier':
            for end in (-1, 1):
                scatter(o['x'] + end * (o['w'] / 2 + 0.35), o['z'], 0.3, 0.6, 7, 'concrete')
        if o.get('surface') == 'sandbag':
            # Spent cases behind each wall on the street side it is fought from.
            along_x = o['w'] >= o['d']
            back = 0.75 if o['z'] < 0 else -0.75
            if along_x:
                scatter(o['x'], o['z'] + back, o['w'] / 2, 0.3, 10, 'case')
            else:
                scatter(o['x'] + (0.75 if o['x'] < 0 else -0.75), o['z'], 0.3, o['d'] / 2, 10, 'case')
            scatter(o['x'], o['z'], o['w'] / 2 + 0.4, o['d'] / 2 + 0.4, 6, 'concrete')
    # Under the two broken upstairs panes: plaster and glazing-bar splinters on the path.
    for index in BROKEN_PANES:
        s = -1 if index < 3 else 1
        z0, z1 = UPSTAIRS_PANES[index % 3]
        scatter(s * 9.35, (z0 + z1) / 2, 0.4, (z1 - z0) / 2, 14, 'plaster')
        scatter(s * 9.35, (z0 + z1) / 2, 0.4, (z1 - z0) / 2, 6, 'splinter')
    # Below the boarded ground-floor windows on the north walls.
    for s in (-1, 1):
        for xa, xb in ((11.91, 13.49), (18.61, 20.19)):
            scatter(s * (xa + xb) / 2, -6.75, 0.8, 0.3, 4, 'splinter')
    # Charred scrap and chips round the burnt-out car.
    car = OBSTACLES['north-car']
    scatter(car['x'], car['z'], car['w'] / 2 + 1.2, car['d'] / 2 + 1.0, 26, 'scrap')
    scatter(car['x'], car['z'], car['w'] / 2 + 1.4, car['d'] / 2 + 1.2, 16, 'concrete')
    obj = b.build('Prop_debris', [M['barrier'], M['paint'], M['boards']])
    log(f'debris: {placed}, {len(obj.data.polygons)} faces')
    return obj


SUN_SHADED = ('Checkpoint_Wire', 'GrassCards')  # unbaked, lit through per-vertex sun visibility


def shade_unbaked():
    """Store in the colour attribute's alpha whether each vertex of the wire and the grass cards
    sees the low sun (1) or lies in the shade of the houses, trees or hills (0). Neither can be
    lightmapped (the wire is too thin, the cards come and go with the graphics setting); the
    runtime uses the alpha to take the real-time sun off them in shade. RGB stays the albedo
    tint (white for the wire)."""
    from mathutils.bvhtree import BVHTree
    targets = [bpy.data.objects[name] for name in SUN_SHADED if name in bpy.data.objects]
    depsgraph = bpy.context.evaluated_depsgraph_get()
    verts, tris, offset = [], [], 0
    for o in bpy.data.objects:
        if o.type != 'MESH' or o in targets or o.hide_render or o.name in UNBAKED or o.name.startswith(('PropSrc_', 'Breakable_Glass_', 'CalibrationPlane')):
            continue
        if any(c.name == 'Props_Library' or c.name.startswith('Guides_') for c in o.users_collection):
            continue
        evaluated = o.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        mesh.calc_loop_triangles()
        co = np.empty(len(mesh.vertices) * 3, np.float32); mesh.vertices.foreach_get('co', co)
        m = np.array(o.matrix_world, np.float64)
        verts.append(co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3])
        ids = np.empty(len(mesh.loop_triangles) * 3, np.int64); mesh.loop_triangles.foreach_get('vertices', ids)
        tris.append(ids.reshape(-1, 3) + offset)
        offset += len(mesh.vertices)
        evaluated.to_mesh_clear()
    tree = BVHTree.FromPolygons(np.concatenate(verts).tolist(), np.concatenate(tris).tolist())
    sun = gb(*SUN_DIRECTION_GAME).normalized()
    lift = Vector((0.0, 0.0, 0.02))  # grass roots sit on the ground: start the ray just above it
    for obj in targets:
        mesh, world = obj.data, obj.matrix_world
        visible = [0.0 if tree.ray_cast(world @ v.co + sun * 0.01 + lift, sun, 3000.0)[0] is not None else 1.0 for v in mesh.vertices]
        colors = mesh.color_attributes.get('Color') or mesh.color_attributes.new(name='Color', type='FLOAT_COLOR', domain='CORNER')
        for li, loop in enumerate(mesh.loops):
            c = colors.data[li].color
            rgb = (1.0, 1.0, 1.0) if obj.name == 'Checkpoint_Wire' else (c[0], c[1], c[2])
            colors.data[li].color = (*rgb, visible[loop.vertex_index])
        log(f'{obj.name} sun visibility: {100 * (1 - sum(visible) / max(1, len(visible))):.1f}% of {len(visible)} vertices in shade')


def stage_shade():
    """Re-measure the unbaked surfaces' sun visibility in a prepared (or baked) working file. Its
    result does not change the bake, so a re-export picks it up without baking again."""
    bpy.ops.wm.open_mainfile(filepath=str(WORK_BLEND))
    shade_unbaked()
    bpy.ops.wm.save_mainfile()


# Distant smoke columns (x, z, height, top width) far beyond the hills' near slopes.
SMOKE_COLUMNS = [(-165.0, -120.0, 112.0, 50.0), (190.0, -40.0, 86.0, 38.0), (70.0, 205.0, 74.0, 32.0), (-150.0, 150.0, 96.0, 42.0)]


def build_smoke(M):
    """One quad per column, facing the arena centre; players never move far from it."""
    b = MeshBuilder()
    for i, (x, z, height, width) in enumerate(SMOKE_COLUMNS):
        n = np.array([-x, 0.0, -z]); n /= np.linalg.norm(n)
        right = np.array([n[2], 0.0, -n[0]])
        base = np.array([x, -8.0, z])
        flip = i % 2 == 1
        u0, u1 = (1.0, 0.0) if flip else (0.0, 1.0)
        pts = [base - right * width / 2, base + right * width / 2, base + right * width / 2 + np.array([0, height, 0]), base - right * width / 2 + np.array([0, height, 0])]
        b.oriented([tuple(p) for p in pts], [(u0, 0.0), (u1, 0.0), (u1, 1.0), (u0, 1.0)], (1.0, 1.0, 1.0), n)
    obj = b.build('Smoke', [M['smoke']])
    log(f'smoke columns: {len(SMOKE_COLUMNS)}')
    return obj


# (cell, x, z, width, length, yaw degrees); width runs across the cell, length along it.
DECALS = [
    ('scorch', 4.0, -17.3, 9.5, 7.0, 8), ('scorch', 5.4, -3.2, 3.2, 3.2, 40), ('scorch', -6.2, 3.4, 2.4, 2.4, 0),
    ('oil', 2.6, 6.2, 2.2, 2.8, 15), ('oil', -2.3, -5.0, 1.8, 2.4, -20), ('oil', 6.4, 2.8, 1.2, 1.2, 0), ('oil', -5.2, -14.6, 1.0, 1.4, 30),
    ('oil', 0.4, -19.5, 1.4, 1.1, 60),
    ('tracks', -11.2, 18.6, 1.9, 7.5, 90), ('tracks', 11.4, -15.8, 1.9, 6.5, 84), ('tracks', -21.5, 15.6, 1.9, 9.0, 12),
    ('tracks', 21.5, 13.6, 1.9, 8.0, -8), ('tracks', 2.7, 13.8, 1.9, 6.0, 0),
    ('mud', -26.0, 11.4, 3.2, 2.6, 20), ('mud', 26.4, 6.0, 2.8, 2.6, -30), ('mud', -24.5, -15.2, 3.4, 3.0, 0),
    ('mud', 25.0, -12.5, 2.6, 2.4, 50), ('mud', -11.4, 15.2, 2.4, 2.0, 0), ('mud', 11.6, -13.4, 2.2, 2.0, 30),
]
GROUND_OBJECTS = ('Town_asphalt', 'Town_grass', 'Town_concrete')


def build_decals(M):
    """Multiply decals projected onto the ground: scorch, oil, tyre tracks and mud."""
    from mathutils.bvhtree import BVHTree
    trees = []
    for name in GROUND_OBJECTS:
        obj = bpy.data.objects.get(name)
        if not obj:
            continue
        world = obj.matrix_world
        trees.append(BVHTree.FromPolygons([world @ v.co for v in obj.data.vertices], [tuple(p.vertices) for p in obj.data.polygons]))

    def ground(x, z):
        heights = [bg(hit[0])[1] for hit in (tree.ray_cast(gb(x, 3.0, z), Vector((0, 0, -1))) for tree in trees) if hit[0] is not None]
        return max(heights) if heights else 0.0
    b = MeshBuilder()
    steps = 6
    for cell, x, z, width, length, yaw in DECALS:
        cx, cy = DECAL_CELLS[cell]
        R = rot_y(math.radians(yaw))
        ids = []
        for j in range(steps + 1):
            row = []
            for i in range(steps + 1):
                u, v = i / steps, j / steps
                local = np.array([(u - 0.5) * width, 0.0, (v - 0.5) * length])
                p = np.array([x, 0.0, z]) + R @ local
                row.append((b.vertex((p[0], ground(p[0], p[2]) + 0.014, p[2])), (cx * 0.5 + 0.01 + u * 0.48, cy * 0.5 + 0.01 + v * 0.48)))
            ids.append(row)
        for j in range(steps):
            for i in range(steps):
                quad = [ids[j][i], ids[j][i + 1], ids[j + 1][i + 1], ids[j + 1][i]]
                idx = [q[0] for q in quad]; uvs = [q[1] for q in quad]
                # +y normal: the local frame keeps x right and z down the length, so reverse.
                b.indexed(list(reversed(idx)), list(reversed(uvs)), (1.0, 1.0, 1.0))
    obj = b.build('Decals', [M['decals']])
    log(f'decals: {len(DECALS)} placed, {len(obj.data.polygons)} faces')
    return obj


def dress_checkpoint(M):
    build_sandbags(M)
    build_barriers(M)
    build_truck_details(M)
    build_crate_stacks(M)
    reskin_bus(M)
    burn_car(M)
    build_window_boards(M)
    build_wire(M)
    build_breakable_glass(M)
    build_breakable_pots(M)
    build_cones(M)
    build_debris(M)
    build_smoke(M)


def configure_light():
    """Golden hour: the sun lamp and the physical sky agree with Atmosphere.ts SUN_DIRECTION."""
    sun = bpy.data.objects['Sun']
    direction = gb(*SUN_DIRECTION_GAME).normalized()
    sun.rotation_euler = (-direction).to_track_quat('-Z', 'Y').to_euler()
    sun.data.energy = SUN_STRENGTH
    sun.data.color = SUN_COLOR_LINEAR
    sun.data.angle = math.radians(SUN_ANGLE_DEG)
    world = bpy.context.scene.world
    sky = world.node_tree.nodes['Sky Texture']
    sky.sun_elevation = math.asin(direction.z)
    sky.sun_rotation = math.atan2(direction.x, direction.y)
    log(f'sun elevation {math.degrees(sky.sun_elevation):.1f} deg, rotation {math.degrees(sky.sun_rotation):.1f} deg')


# ---------------------------------------------------------------------------------------------
# Scene assembly
# ---------------------------------------------------------------------------------------------

def build_interior_lights():
    """Warm area lights under the ceilings so rooms bake bright enough to fight in. They only
    exist for the bake; the runtime never renders a light."""
    collection = bpy.data.collections.new('BakeLights')
    bpy.context.scene.collection.children.link(collection)

    def area(name, x, y, z, size_x, size_z, energy, colour=(1.0, 0.93, 0.82)):
        light = bpy.data.lights.new(name, 'AREA')
        light.shape = 'RECTANGLE'; light.size = size_x; light.size_y = size_z
        light.energy = energy; light.color = colour
        obj = bpy.data.objects.new(name, light)
        obj.location = gb(x, y, z)
        obj['bakeOnly'] = True
        collection.objects.link(obj)

    # v3 calibrates baked light to irradiance (x pi x blenderToRuntime), about four times v2's
    # scale, so the same rooms need a quarter of v2's fill to read as dim evening interiors.
    fill = 0.25
    for side in (-1, 1):
        s = side
        area(f'Fill_main_{side}', s * 13.8, 2.85, 0.0, 6.0, 10.0, 420 * fill)
        area(f'Fill_rear_{side}', s * 20.0, 2.85, 0.0, 3.0, 10.0, 220 * fill)
        area(f'Fill_upstairs_{side}', s * 16.0, 6.05, 0.0, 10.0, 10.0, 520 * fill)
        area(f'Fill_garage_{side}', s * 14.0, 2.8, 9.75, 7.0, 6.0, 320 * fill)
    log('interior fill lights placed')


def stage_prepare():
    bpy.ops.wm.open_mainfile(filepath=str(BASE_BLEND))
    bpy.context.preferences.filepaths.save_version = 0
    # Old collision references are replaced by the guide collections.
    for o in list(bpy.data.objects):
        if o.name.startswith('Collision_') or o.name == 'CollisionReferences':
            bpy.data.objects.remove(o, do_unlink=True)
    materials = build_materials()
    retexture(materials)
    build_props()
    build_bushes(materials)
    build_grass_cards(materials)
    dress_checkpoint(materials)
    build_decals(materials)
    guides.build(MAP)
    build_interior_lights()
    configure_light()
    shade_unbaked()
    # Prepare-time sky strength; the bake recalibrates it against SKY_FRACTION.
    bpy.data.worlds[bpy.context.scene.world.name].node_tree.nodes['Background'].inputs['Strength'].default_value = 1.0
    for o in bpy.data.objects:
        ensure_color_attribute(o)
    for image in bpy.data.images:
        if image.size[0] and not image.packed_file and image.filepath:
            image.pack()
    bpy.ops.wm.save_as_mainfile(filepath=str(WORK_BLEND))
    log('saved', WORK_BLEND)


LIGHTMAP_GROUPS = {
    'LM_arch': lambda o: o.name in ('Town_siding', 'Refined_siding', 'Town_trim', 'Refined_trim', 'Town_roof', 'Refined_roof', 'Refined_concrete', 'Refined_glass', 'Refined_metal', 'Town_metal', 'Town_wood', 'Refined_wood', 'Refined_fabric'),
    'LM_ground': lambda o: o.name in ('Town_asphalt', 'Town_grass', 'Town_concrete', 'Refined_markings'),
    'LM_foliage': lambda o: o.name == 'Bushes',
    'LM_props': lambda o: o.name.startswith(('Prop_', 'Vehicle_')) or o.name in ('Town_paint', 'Town_rubber', 'Town_glass'),
    # The breakable pots bake on their own and are invisible to every other group's bake, so no
    # baked shadow is left behind when one shatters; the runtime gives them a real-time shadow.
    'LM_pots': lambda o: o.name.startswith('Breakable_Pot_'),
}
# Never lightmapped: the wire, window glass, decals (multiply-blended) and the smoke columns.
UNBAKED = ('Checkpoint_Wire', 'Decals', 'Smoke')
# Foliage cards only need a soft per-card light level, so they share a quarter-size atlas.
# The architecture group carries the most surface (both wall faces, trim, fences), so it bakes at twice the size.
ATLAS_SCALE = {'LM_arch': 2, 'LM_ground': 1, 'LM_props': 1, 'LM_foliage': 0.25, 'LM_pots': 0.125}


def group_objects(name):
    return [o for o in bpy.data.objects if o.type == 'MESH' and o.visible_get() is not None and not o.hide_render and LIGHTMAP_GROUPS[name](o)]


def split_materials_per_group():
    """A material used by more than one atlas group is copied per group so each material maps
    to exactly one lightmap."""
    owner = {}
    for name in LIGHTMAP_GROUPS:
        for obj in group_objects(name):
            for slot in obj.material_slots:
                if not slot.material:
                    continue
                first = owner.setdefault(slot.material.name, name)
                if first != name:
                    copy_name = f'{slot.material.name}__{name}'
                    copy = bpy.data.materials.get(copy_name) or slot.material.copy()
                    copy.name = copy_name
                    slot.material = copy
    # Objects outside every group (horizon trees, hills) must not share a lightmapped material.
    grouped = {o.name for name in LIGHTMAP_GROUPS for o in group_objects(name)}
    for obj in bpy.data.objects:
        if obj.type != 'MESH' or obj.name in grouped:
            continue
        for slot in obj.material_slots:
            if slot.material and slot.material.name in owner:
                copy_name = f'{slot.material.name}__unlit'
                copy = bpy.data.materials.get(copy_name) or slot.material.copy()
                copy.name = copy_name
                slot.material = copy


def stage_uv():
    bpy.ops.wm.open_mainfile(filepath=str(WORK_BLEND))
    split_materials_per_group()
    for name in LIGHTMAP_GROUPS:
        objects = group_objects(name)
        started = time.time()
        bpy.ops.object.select_all(action='DESELECT')
        for o in objects:
            layer = o.data.uv_layers.get('Lightmap') or o.data.uv_layers.new(name='Lightmap')
            o.data.uv_layers.active = layer
            o.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        if name in ('LM_arch', 'LM_ground'):
            # Box-built architecture and ground: one island per world plane, so clapboards, trim
            # and floors share continuous texels instead of bleeding between thousands of slivers.
            planar_lightmap_uv(objects, padding_texels=3, atlas=2048 * ATLAS_SCALE[name])
            for o in objects:
                o.data.uv_layers.active = o.data.uv_layers['UVMap']
                o['lightmapGroup'] = name
            log(f'{name}: {len(objects)} objects, planar islands in {time.time() - started:.0f}s')
            continue
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.select_all(action='SELECT')
        bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.0, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
        if name == 'LM_props':
            # Hundreds of thousands of tiny prop islands overwhelm the island packer. Smart
            # project already packs each object into its own unit square; lay those out by area.
            bpy.ops.object.mode_set(mode='OBJECT')
            pack_objects(objects)
        else:
            bpy.ops.uv.average_islands_scale()
            # The small pots atlas needs a wider margin in its own pixels.
            margin = 0.02 if name == 'LM_pots' else 0.003
            bpy.ops.uv.pack_islands(udim_source='ACTIVE_UDIM', rotate=True, rotate_method='CARDINAL', scale=True, margin_method='FRACTION', margin=margin, shape_method='CONCAVE' if name != 'LM_arch' else 'AABB')
            bpy.ops.object.mode_set(mode='OBJECT')
        for o in objects:
            o.data.uv_layers.active = o.data.uv_layers['UVMap']
            o['lightmapGroup'] = name
        faces = sum(len(o.data.polygons) for o in objects)
        log(f'{name}: {len(objects)} objects, {faces} faces unwrapped in {time.time() - started:.0f}s')
    bpy.ops.wm.save_mainfile()
    log('lightmap UVs saved')


DENSITY_WEIGHT = {'Town_grass': 0.5, 'Town_asphalt': 0.8, 'Town_concrete': 0.8, 'Town_trim': 0.7, 'Refined_metal': 0.5, 'Refined_trim': 0.8, 'Town_wood': 0.7, 'Refined_concrete': 0.7}


def skyline_pack(rects):
    """Bottom-left skyline packing of (id, w, h) rectangles into the unit square.
    Returns {id: (x, y)} or None when they do not fit."""
    skyline = [(0.0, 0.0, 1.0)]
    placed = {}
    for rid, w, h in sorted(rects, key=lambda r: (-r[2], -r[1])):
        best = None
        for i, (sx, sy, _) in enumerate(skyline):
            if sx + w > 1.0 + 1e-9:
                continue
            y = sy; span = 0.0; j = i
            while span + 1e-9 < w and j < len(skyline):
                y = max(y, skyline[j][1]); span += skyline[j][2]; j += 1
            if span + 1e-9 < w or y + h > 1.0 + 1e-9:
                continue
            if best is None or y < best[1] - 1e-12 or (abs(y - best[1]) < 1e-12 and sx < best[0]):
                best = (sx, y)
        if best is None:
            return None
        x, y = best
        placed[rid] = (x, y)
        updated = []
        for sx, sy, sw in skyline:
            ex = sx + sw
            if ex <= x + 1e-12 or sx >= x + w - 1e-12:
                updated.append((sx, sy, sw))
            else:
                if sx < x - 1e-12:
                    updated.append((sx, sy, x - sx))
                if ex > x + w + 1e-12:
                    updated.append((x + w, sy, ex - (x + w)))
        updated.append((x, y + h, w))
        updated.sort()
        merged = []
        for seg in updated:
            if merged and abs(merged[-1][1] - seg[1]) < 1e-9 and abs(merged[-1][0] + merged[-1][2] - seg[0]) < 1e-9:
                merged[-1] = (merged[-1][0], merged[-1][1], merged[-1][2] + seg[2])
            else:
                merged.append(seg)
        skyline = merged
    return placed


def planar_lightmap_uv(objects, padding_texels=4, atlas=2048):
    """Project every face along its dominant world axis, grouping faces of one object that lie on
    the same plane into one island, then pack the islands at (weighted) uniform texel density."""
    # Faces grouped by (object, plane); each plane is then split into spatially connected
    # clusters on a 3 m grid so distant pieces on the same plane do not share one huge island.
    planes = {}
    for o in objects:
        mesh = o.data
        layer = mesh.uv_layers['Lightmap']
        world = o.matrix_world
        normal_matrix = world.to_3x3().inverted().transposed()
        weight = DENSITY_WEIGHT.get(o.name, 1.0)
        for poly in mesh.polygons:
            n = (normal_matrix @ poly.normal).normalized()
            axis = max(range(3), key=lambda i: abs(n[i]))
            centre = world @ poly.center
            key = (o.name, axis, n[axis] > 0, round(centre[axis] / 0.3))
            b, c = [i for i in range(3) if i != axis]
            loops = []
            for li in poly.loop_indices:
                p = world @ mesh.vertices[mesh.loops[li].vertex_index].co
                loops.append((li, p[b], p[c]))
            cell = (math.floor(centre[b] / 3.0), math.floor(centre[c] / 3.0))
            planes.setdefault(key, {'layer': layer, 'weight': weight, 'faces': []})['faces'].append((cell, loops, poly.area))
    islands = {}
    for key, plane in planes.items():
        cells = {}
        for index, (cell, _, _) in enumerate(plane["faces"]):
            cells.setdefault(cell, []).append(index)
        parent = {cell: cell for cell in cells}

        def find(cell):
            while parent[cell] != cell:
                parent[cell] = parent[parent[cell]]; cell = parent[cell]
            return cell

        for (cx, cy) in cells:
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    other = (cx + dx, cy + dy)
                    if other in cells:
                        parent[find(other)] = find((cx, cy))
        components = {}
        for cell, indices in cells.items():
            components.setdefault(find(cell), []).extend(indices)
        for root, indices in components.items():
            us = [u for index in indices for _, u, _ in plane['faces'][index][1]]
            vs = [v for index in indices for _, _, v in plane['faces'][index][1]]
            bbox = max(max(us) - min(us), 0.01) * max(max(vs) - min(vs), 0.01)
            real = sum(plane['faces'][index][2] for index in indices)
            # Sparse clusters (a row of fence caps across the map) waste atlas; split them per cell.
            split = bbox > 12.0 and real / bbox < 0.3
            for index in indices:
                cell, loops, _ = plane['faces'][index]
                island_key = (key, cell) if split else (key, root)
                island = islands.setdefault(island_key, {'layer': plane['layer'], 'loops': [], 'min': [1e9, 1e9], 'max': [-1e9, -1e9], 'weight': plane['weight']})
                for li, u, v in loops:
                    island['loops'].append((li, u, v))
                    island['min'][0] = min(island['min'][0], u); island['min'][1] = min(island['min'][1], v)
                    island['max'][0] = max(island['max'][0], u); island['max'][1] = max(island['max'][1], v)
    pad = padding_texels / atlas
    keys = list(islands.keys())
    dims = {}
    for key in keys:
        island = islands[key]
        w = max(island['max'][0] - island['min'][0], 0.02) * island['weight']
        h = max(island['max'][1] - island['min'][1], 0.02) * island['weight']
        dims[key] = (w, h)
    area = sum(w * h for w, h in dims.values())
    lo, hi = 0.0, math.sqrt(1.0 / area)
    best = None
    for _ in range(18):
        scale = (lo + hi) / 2
        rects = []
        for key, (w, h) in dims.items():
            sw, sh = w * scale + pad, h * scale + pad
            rotate = sh > sw
            if rotate:
                sw, sh = sh, sw
            rects.append((key, min(sw, 1.0), min(sh, 1.0), rotate))
        placed = skyline_pack([(k, sw, sh) for k, sw, sh, _ in rects])
        if placed:
            best = (scale, placed, {k: rot for k, _, _, rot in rects}); lo = scale
        else:
            hi = scale
    scale, placed, rotations = best
    for key, (x, y) in placed.items():
        island = islands[key]
        w, h = dims[key]
        sw, sh = w * scale, h * scale
        rotate = rotations[key]
        span_u = island['max'][0] - island['min'][0]; span_v = island['max'][1] - island['min'][1]
        for li, u, v in island['loops']:
            fu = (u - island['min'][0]) / span_u if span_u > 1e-6 else 0.5
            fv = (v - island['min'][1]) / span_v if span_v > 1e-6 else 0.5
            if rotate:
                fu, fv = fv, fu
                cell_w, cell_h = sh, sw
            else:
                cell_w, cell_h = sw, sh
            island['layer'].data[li].uv = (x + pad / 2 + fu * cell_w, y + pad / 2 + fv * cell_h)
    log(f'planar lightmap: {len(placed)} islands, {area:.0f} weighted m2, texel density {scale * atlas:.1f} px/m')


def pack_objects(objects, padding=0.004):
    """Shelf-pack each object's unit-square Lightmap UVs into one atlas, sized by surface area."""
    entries = []
    for o in objects:
        area = sum(p.area for p in o.data.polygons) * (o.matrix_world.to_scale().x ** 2)
        entries.append([o, max(area, 1e-4)])
    total = sum(a for _, a in entries)
    entries.sort(key=lambda e: -e[1])
    for attempt in range(40):
        scale = 0.98 * (0.97 ** attempt)
        sides = [(o, min(0.5, math.sqrt(a / total) * scale)) for o, a in entries]
        x = y = row = 0.0
        placed = []
        for o, side in sides:
            if x + side > 1.0:
                x = 0.0; y += row + padding; row = 0.0
            placed.append((o, x, y, side))
            x += side + padding; row = max(row, side)
        if y + row <= 1.0:
            break
    for o, x, y, side in placed:
        layer = o.data.uv_layers['Lightmap']
        inner = side - padding
        for item in layer.data:
            u, v = item.uv
            item.uv = (x + padding / 2 + max(0.0, min(1.0, u)) * inner, y + padding / 2 + max(0.0, min(1.0, v)) * inner)
    log(f'packed {len(placed)} objects into the props atlas; largest cell {placed[0][3]:.3f}, rows end at {y + row:.3f}')


def configure_cycles(samples):
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = samples
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.adaptive_threshold = 0.05
    scene.cycles.adaptive_min_samples = 16
    scene.cycles.sample_clamp_direct = 0.0
    scene.cycles.sample_clamp_indirect = 6.0
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 6
    scene.cycles.diffuse_bounces = 4
    scene.cycles.caustics_reflective = False
    scene.cycles.caustics_refractive = False
    scene.render.film_transparent = False


def bake_targets(objects, image):
    """Point every material of the objects at `image` through the Lightmap UV and make it active."""
    touched = set()
    for o in objects:
        for slot in o.material_slots:
            mat = slot.material
            if not mat or mat.name in touched:
                continue
            touched.add(mat.name)
            mat.use_nodes = True
            nodes = mat.node_tree.nodes
            node = nodes.get('KannonBakeTarget') or nodes.new('ShaderNodeTexImage')
            node.name = 'KannonBakeTarget'; node.image = image
            uv = nodes.get('KannonBakeUV') or nodes.new('ShaderNodeUVMap')
            uv.name = 'KannonBakeUV'; uv.uv_map = 'Lightmap'
            mat.node_tree.links.new(uv.outputs['UV'], node.inputs['Vector'])
            nodes.active = node
    return touched


def remove_bake_nodes():
    for mat in bpy.data.materials:
        if not mat.use_nodes:
            continue
        for name in ('KannonBakeTarget', 'KannonBakeUV'):
            node = mat.node_tree.nodes.get(name)
            if node:
                mat.node_tree.nodes.remove(node)


def bake(objects, image, samples, passes=('DIRECT', 'INDIRECT')):
    configure_cycles(samples)
    scene = bpy.context.scene
    scene.render.bake.use_pass_direct = 'DIRECT' in passes
    scene.render.bake.use_pass_indirect = 'INDIRECT' in passes
    scene.render.bake.use_pass_color = False
    scene.render.bake.margin = 8
    scene.render.bake.use_clear = True
    scene.render.bake.target = 'IMAGE_TEXTURES'
    bake_targets(objects, image)
    bpy.ops.object.select_all(action='DESELECT')
    for o in objects:
        layer = o.data.uv_layers.get('Lightmap')
        if layer is None:
            raise RuntimeError(f'{o.name} has no Lightmap UV layer')
        layer.active_render = True
        o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.bake(type='DIFFUSE', pass_filter=set(passes), margin=8, use_clear=True, uv_layer='Lightmap')
    for o in objects:
        o.data.uv_layers['UVMap'].active_render = True


def bake_sun_only(objects, image, samples):
    """Direct light from the sun lamp alone: no sky, no interior fills, no bounces."""
    background = bpy.context.scene.world.node_tree.nodes['Background'].inputs['Strength']
    fills = [o for o in bpy.data.objects if o.type == 'LIGHT' and o.get('bakeOnly')]
    strength, hidden = background.default_value, [o.hide_render for o in fills]
    background.default_value = 0.0
    for o in fills:
        o.hide_render = True
    try:
        bake(objects, image, samples, passes=('DIRECT',))
    finally:
        background.default_value = strength
        for o, h in zip(fills, hidden):
            o.hide_render = h


def set_ray_visibility(objects, visible):
    """Hide objects from every kind of ray (shadow, bounce, reflection) while other objects bake."""
    for o in objects:
        o.visible_diffuse = o.visible_glossy = o.visible_transmission = o.visible_volume_scatter = o.visible_shadow = visible


def soften(rgb, weight=None):
    """One-texel weighted blur that ignores empty (black) texels, so island edges do not bleed.
    `weight` marks the texels that hold data when the values themselves can be zero."""
    weight = ((rgb.sum(axis=2) > 1e-5) if weight is None else weight).astype(np.float32)
    padded = np.pad(rgb, ((1, 1), (1, 1), (0, 0)), mode='edge')
    padded_w = np.pad(weight, ((1, 1), (1, 1)), mode='edge')
    total = np.zeros_like(rgb); total_w = np.zeros_like(weight)
    h, w = weight.shape
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            k = 2.0 if (dx == 0 and dy == 0) else 1.0
            window = padded[1 + dy:1 + dy + h, 1 + dx:1 + dx + w]
            window_w = padded_w[1 + dy:1 + dy + h, 1 + dx:1 + dx + w]
            total += k * window * window_w[..., None]
            total_w += k * window_w
    blurred = total / np.maximum(total_w, 1e-6)[..., None]
    return np.where(weight[..., None] > 0, blurred, rgb)


def image_pixels(image):
    pixels = np.empty(image.size[0] * image.size[1] * 4, np.float32)
    image.pixels.foreach_get(pixels)
    return pixels.reshape(image.size[1], image.size[0], 4)


def bake_plane(origin, normal, samples, half=0.5):
    """Bake a small plane at `origin` (game) facing `normal` (game); mean RGB diffuse light in
    Blender units (irradiance from the sun lamp's W/m2 scale)."""
    n = np.array(normal, float); n /= np.linalg.norm(n)
    helper = np.array([0.0, 1.0, 0.0]) if abs(n[1]) < 0.9 else np.array([1.0, 0.0, 0.0])
    u = np.cross(helper, n); u /= np.linalg.norm(u)
    v = np.cross(n, u)  # u x v = n
    o = np.array(origin, float)
    corners = [o - u * half - v * half, o + u * half - v * half, o + u * half + v * half, o - u * half + v * half]
    mesh = bpy.data.meshes.new('CalibrationPlane')
    mesh.from_pydata([gb(*c) for c in corners], [], [(0, 1, 2, 3)]); mesh.update()
    obj = bpy.data.objects.new('CalibrationPlane', mesh); bpy.context.scene.collection.objects.link(obj)
    uv = mesh.uv_layers.new(name='UVMap'); lm = mesh.uv_layers.new(name='Lightmap')
    for li, co in zip(range(4), [(0.1, 0.1), (0.9, 0.1), (0.9, 0.9), (0.1, 0.9)]):
        uv.data[li].uv = co; lm.data[li].uv = co
    mat = bpy.data.materials.new('CalibrationMaterial'); mat.use_nodes = True
    mesh.materials.append(mat)
    image = bpy.data.images.new('LM_calibration', 32, 32, float_buffer=True)
    bake([obj], image, max(32, samples // 4))
    value = image_pixels(image)[8:24, 8:24, :3].reshape(-1, 3).mean(axis=0)
    bpy.data.objects.remove(obj, do_unlink=True); bpy.data.materials.remove(mat); bpy.data.images.remove(image)
    return [float(c) for c in value]


def luminance(rgb):
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]


OPEN_SKY = (0.0, 14.0, 0.0)  # above every roof: an upward plane here sees the whole sky


def set_sky_strength(samples):
    """Scale the physical sky so an open upward surface receives SKY_FRACTION of the sun."""
    background = bpy.context.scene.world.node_tree.nodes['Background'].inputs['Strength']
    sun = bpy.data.objects['Sun'].data
    fills = [o for o in bpy.data.objects if o.type == 'LIGHT' and o.get('bakeOnly')]
    energy, hidden = sun.energy, [o.hide_render for o in fills]
    sun.energy = 0.0; background.default_value = 1.0
    for o in fills:
        o.hide_render = True
    try:
        unit = bake_plane(OPEN_SKY, (0, 1, 0), samples)
    finally:
        sun.energy = energy
        for o, h in zip(fills, hidden):
            o.hide_render = h
    background.default_value = SKY_FRACTION * SUN_STRENGTH / (BAKE_TO_IRRADIANCE * max(luminance(unit), 1e-6))
    log(f'sky strength {background.default_value:.4f} (unit sky {unit})')
    return background.default_value


def calibrate_light(samples):
    """Fix the sky strength so open sky gives SKY_FRACTION of the sun, then measure what the
    runtime must reproduce: sun, sky and ground bounce, all in three.js irradiance units."""
    scene = bpy.context.scene
    background = scene.world.node_tree.nodes['Background'].inputs['Strength']
    sun = bpy.data.objects['Sun'].data
    fills = [o for o in bpy.data.objects if o.type == 'LIGHT' and o.get('bakeOnly')]

    def measure(origin, normal, sun_on=True, sky_on=True):
        energy, strength = sun.energy, background.default_value
        hidden = [o.hide_render for o in fills]
        sun.energy = SUN_STRENGTH if sun_on else 0.0
        background.default_value = strength if sky_on else 0.0
        for o in fills:
            o.hide_render = True
        try:
            return bake_plane(origin, normal, samples)
        finally:
            sun.energy = energy; background.default_value = strength
            for o, h in zip(fills, hidden):
                o.hide_render = h

    open_sky = OPEN_SKY
    set_sky_strength(samples)
    k = SUN_INTENSITY_RUNTIME / SUN_STRENGTH
    sky_up = measure(open_sky, (0, 1, 0), sun_on=False)
    sun_perpendicular = measure(open_sky, tuple(SUN_DIRECTION_GAME), sky_on=False)
    street = (0.0, 0.02, 18.5)
    horizontal = measure(street, (0, 1, 0))
    ground_down = measure((0.0, 1.0, 18.5), (0, -1, 0))
    scaled = lambda rgb: [round(c * k * BAKE_TO_IRRADIANCE, 4) for c in rgb]  # noqa: E731
    calibration = {
        'sunDirection': [round(c, 4) for c in SUN_DIRECTION_GAME], 'sunColorSrgb': list(SUN_COLOR_SRGB),
        'sunIntensity': SUN_INTENSITY_RUNTIME, 'sunStrengthBlender': SUN_STRENGTH, 'skyStrengthBlender': round(background.default_value, 4),
        'blenderToRuntime': k, 'skyUp': scaled(sky_up), 'sunPerpendicular': scaled(sun_perpendicular),
        'openStreetHorizontal': scaled(horizontal), 'groundBounceDown': scaled(ground_down),
    }
    log('calibration', json.dumps(calibration))
    return calibration


def save_png(name, values, srgb):
    """Write an H x W x 3 array in [0, 1] (row 0 at the bottom) as an 8-bit PNG under OUT."""
    size_y, size_x = values.shape[:2]
    out = bpy.data.images.new(f'{name}_png', size_x, size_y, alpha=False)
    out.colorspace_settings.name = 'sRGB' if srgb else 'Non-Color'
    out.pixels.foreach_set(np.concatenate([values, np.ones((size_y, size_x, 1), np.float32)], axis=2).ravel())
    path = OUT / f'{name}.png'
    out.filepath_raw = str(path); out.file_format = 'PNG'; out.save()
    bpy.data.images.remove(out)
    return path.name


def stage_bake(samples, atlas):
    bpy.ops.wm.open_mainfile(filepath=str(WORK_BLEND))
    started = time.time()
    hidden = [o for o in bpy.data.objects if o.name in UNBAKED or o.name.startswith('Breakable_Glass_')]
    for o in hidden:
        o.hide_render = True
    pots = [o for o in bpy.data.objects if o.name.startswith('Breakable_Pot_')]
    calibration = calibrate_light(samples)
    k = calibration['blenderToRuntime']
    normaliser = LIGHTMAP_HEADROOM * SUN_STRENGTH / BAKE_TO_IRRADIANCE  # baked value stored as 1.0
    intensity = k * BAKE_TO_IRRADIANCE * normaliser                      # runtime irradiance = stored * intensity
    calibration.update({'normaliser': normaliser, 'lightMapIntensity': intensity})
    sidecar = {'atlases': {}, 'sunMasks': {}, 'materials': {}, 'alphaMask': [], 'doubleSided': [], 'alphaBlend': [], 'calibration': calibration}
    for name in LIGHTMAP_GROUPS:
        objects = group_objects(name)
        size = int(atlas * ATLAS_SCALE[name])
        # The pots only take part in their own bake (see LIGHTMAP_GROUPS).
        set_ray_visibility(pots, name == 'LM_pots')
        image = bpy.data.images.new(name, size, size, float_buffer=True)
        image.colorspace_settings.name = 'Non-Color'
        sun_image = bpy.data.images.new(f'{name}_sun', size, size, float_buffer=True)
        sun_image.colorspace_settings.name = 'Non-Color'
        group_started = time.time()
        bake(objects, image, samples)
        bake_sun_only(objects, sun_image, max(32, samples // 2))
        pixels = image_pixels(image)
        total, sun = pixels[:, :, :3], image_pixels(sun_image)[:, :, :3]
        filled = total.sum(axis=2) > 1e-5
        rgb = soften(np.clip(total / normaliser, 0, 1))
        # Store in sRGB 8-bit PNG; the runtime decodes sRGB and multiplies by lightMapIntensity.
        encoded = np.where(rgb <= 0.0031308, rgb * 12.92, 1.055 * np.power(rgb, 1 / 2.4) - 0.055)
        sidecar['atlases'][name] = save_png(name, encoded, srgb=True)
        # Sun mask: the share of the baked light that is direct sun. A character's real-time
        # shadow may take that share away and nothing else (src/game/Lightmaps.ts).
        total_luma, sun_luma = luminance(np.moveaxis(total, 2, 0)), luminance(np.moveaxis(sun, 2, 0))
        share = np.where(total_luma > 1e-4, np.clip(sun_luma / np.maximum(total_luma, 1e-4), 0, 1), 0.0)
        share = soften(np.repeat(share[..., None], 3, axis=2), filled)
        sidecar['sunMasks'][name] = save_png(f'{name}_sun', share, srgb=False)
        materials = set()
        for o in objects:
            for slot in o.material_slots:
                if slot.material:
                    materials.add(slot.material.name)
        for material in sorted(materials):
            sidecar['materials'][material] = {'atlas': name, 'intensity': intensity}
        sunny = share[..., 0][filled]
        log(f'{name}: baked {len(objects)} objects in {time.time() - group_started:.0f}s; max {total.max():.3f}, mean {total.mean():.3f}; '
            f'sun share mean {sunny.mean() if sunny.size else 0:.3f}, {100 * (sunny > 0.5).mean() if sunny.size else 0:.1f}% of texels mostly sun')
        bpy.data.images.remove(image); bpy.data.images.remove(sun_image)
    set_ray_visibility(pots, True)
    remove_bake_nodes()
    for mat in bpy.data.materials:
        if mat.name in ('V2_GrassCard', 'V2_Leaves') or mat.name.startswith('Prop_shrub') or mat.name.startswith('Prop_potted_plant'):
            sidecar['alphaMask'].append(mat.name); sidecar['doubleSided'].append(mat.name)
        if mat.name.startswith(('V3_WindowGlass', 'V3_Smoke')):
            sidecar['alphaBlend'].append(mat.name)
        if mat.name.startswith('V3_Smoke'):
            sidecar['doubleSided'].append(mat.name)
    for o in hidden:
        o.hide_render = False
    (OUT / 'town-v3-lightmaps.json').write_text(json.dumps(sidecar, indent=2) + '\n', encoding='utf-8')
    bpy.ops.wm.save_mainfile()
    log(f'bake complete in {time.time() - started:.0f}s; lightMapIntensity {intensity:.3f}')


def preview_decals():
    """Cycles cannot multiply-blend; a tinted transparent surface is the closest preview (the
    exported material stays a plain textured material that the runtime blends)."""
    mat = bpy.data.materials.get('V3_Decals')
    if not mat:
        return
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    tex = next(n for n in nodes if n.bl_idname == 'ShaderNodeTexImage')
    transparent = nodes.new('ShaderNodeBsdfTransparent')
    gamma = nodes.new('ShaderNodeGamma'); gamma.inputs['Gamma'].default_value = 0.5
    links.new(tex.outputs['Color'], gamma.inputs['Color']); links.new(gamma.outputs['Color'], transparent.inputs['Color'])
    links.new(transparent.outputs['BSDF'], nodes['Material Output'].inputs['Surface'])


PREVIEW_VIEWS = {
    'street': ((-4.5, 1.7, 14.0), (-8.0, 2.5, -8.0)),
    'house': ((2.0, 2.2, -12.0), (-16.0, 3.5, -3.0)),
    'yard': ((-29.5, 2.0, 5.0), (-21.0, 1.6, 12.5)),
    'north': ((-24.0, 1.7, -12.0), (-14.0, 1.5, -6.5)),
    'garage': ((-4.0, 1.7, 9.5), (-16.0, 1.6, 9.8)),
    'checkpoint': ((-3.0, 1.65, -21.0), (2.0, 0.8, -9.0)),
    'truck': ((5.5, 1.65, -5.5), (2.6, 1.4, 2.0)),
    'truck-rear': ((-1.0, 1.65, 16.5), (2.7, 1.4, 8.0)),
    'burnt': ((8.5, 1.65, -13.0), (4.0, 0.8, -17.4)),
    'barrier': ((3.0, 1.65, -6.0), (6.6, 0.5, -9.5)),
    'south': ((-5.0, 1.65, 4.5), (1.0, 0.9, 16.0)),
    'skyline': ((0.0, 4.8, 18.0), (-30.0, 8.0, -40.0)),
    'crates': ((-8.2, 1.65, -13.9), (-4.8, 0.8, -17.0)),
    'yard-stack': ((-22.6, 1.65, -11.6), (-27.0, 0.6, -15.0)),
    'broken': ((-5.5, 1.9, 3.0), (-9.75, 5.0, 0.0)),
    'cones': ((1.6, 1.65, -5.6), (6.6, 0.3, -9.8)),
    'sandbag-close': ((-5.0, 1.25, -11.2), (-7.2, 0.6, -12.9)),
}


def stage_preview(samples, only=''):
    bpy.ops.wm.open_mainfile(filepath=str(WORK_BLEND))
    set_sky_strength(32)  # same rule the bake uses, so previews match before a bake too
    configure_cycles(samples)
    preview_decals()
    scene = bpy.context.scene
    scene.render.resolution_x, scene.render.resolution_y = 1280, 720
    # The game tone-maps with ACES Filmic; preview with ACES when this Blender build has it.
    for transform in ('ACES 1.3', 'ACES 2.0', 'AgX'):
        try:
            scene.view_settings.view_transform = transform
            break
        except TypeError:
            continue
    # Same brightness as the runtime: three.js light is the Blender light times blenderToRuntime.
    scene.view_settings.exposure = math.log2(SUN_INTENSITY_RUNTIME / SUN_STRENGTH * EXPOSURE_RUNTIME)
    log('preview view transform', scene.view_settings.view_transform, 'exposure', round(scene.view_settings.exposure, 3))
    cam = bpy.data.objects.get('PreviewCam') or bpy.data.objects.new('PreviewCam', bpy.data.cameras.new('PreviewCam'))
    if cam.name not in scene.collection.objects:
        scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.lens = 24
    wanted = [v for v in only.split(',') if v] or list(PREVIEW_VIEWS)
    views = {name: (gb(*PREVIEW_VIEWS[name][0]), gb(*PREVIEW_VIEWS[name][1])) for name in wanted}
    for name, (eye, target) in views.items():
        cam.location = eye
        cam.rotation_euler = (target - eye).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = str(OUT / f'preview-{name}.png')
        bpy.ops.render.render(write_still=True)
        log('preview', name)


def join_objects(names, new_name):
    objects = [bpy.data.objects[n] for n in names if n in bpy.data.objects and bpy.data.objects[n].type == 'MESH']
    if not objects:
        return None
    bpy.ops.object.select_all(action='DESELECT')
    for o in objects:
        o.hide_set(False); o.hide_viewport = False; o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    if len(objects) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = new_name
    return obj


def record_plain_base_colors():
    """The glTF exporter cannot write a constant colour multiplied by the vertex colour, so it
    drops the constant and the runtime sees white x vertex colour. Keep the constant in the
    material's extras; finish_town_v3.mjs restores it as the base colour factor."""
    recorded = []
    for mat in bpy.data.materials:
        if not mat.use_nodes or 'Principled BSDF' not in mat.node_tree.nodes:
            continue
        bsdf = mat.node_tree.nodes['Principled BSDF']
        link = next((l for l in mat.node_tree.links if l.to_node == bsdf and l.to_socket.name == 'Base Color'), None)
        if not link or link.from_node.bl_idname != 'ShaderNodeMixRGB' or link.from_node.inputs['Color1'].is_linked:
            continue
        mat['baseColor'] = [round(float(c), 4) for c in link.from_node.inputs['Color1'].default_value[:3]]
        recorded.append(mat.name)
    log('plain base colours recorded for', ', '.join(sorted(recorded)))


def stage_export():
    bpy.ops.wm.open_mainfile(filepath=str(WORK_BLEND))
    remove_bake_nodes()
    record_plain_base_colors()
    # One mesh per family: the exporter emits one primitive per material, so draw calls equal
    # the number of distinct materials rather than the number of objects. Breakables stay
    # separate, named nodes so the runtime can hide each one when it shatters.
    meshes = [o for o in bpy.data.objects if o.type == 'MESH' and not o.name.startswith('PropSrc_') and o.name != 'CalibrationPlane'
              and not any(c.name == 'Props_Library' or c.name.startswith('Guides_') for c in o.users_collection)]
    names = [o.name for o in meshes]
    join_objects([n for n in names if n.startswith('Horizon_')], 'Horizon')
    join_objects([n for n in names if n.startswith('Vehicle_') or n in ('Town_paint', 'Town_rubber', 'Town_glass')], 'Vehicles')
    join_objects([n for n in names if n.startswith(('Prop_', 'Checkpoint_'))], 'Props')
    join_objects([n for n in names if n.startswith(('Town_', 'Refined_')) and n not in ('Town_paint', 'Town_rubber', 'Town_glass')], 'Town')
    join_objects(['Bushes', 'GrassCards'], 'Foliage')
    bpy.ops.object.select_all(action='DESELECT')
    exported = 0
    for o in bpy.data.objects:
        if o.type == 'MESH' and (o.name in ('Horizon', 'Vehicles', 'Props', 'Town', 'Foliage', 'Decals', 'Smoke') or o.name.startswith('Breakable_')):
            o.hide_render = False; o.hide_viewport = False; o.hide_set(False)
            o.select_set(True); exported += 1
    # Guides export as empties: no mesh to draw, just the name, position and extras the
    # runtime and validator read.
    for o in list(bpy.data.collections['Guides_Collision'].objects):
        name = o.name
        o.name = f'{name}__mesh'
        empty = bpy.data.objects.new(name, None)
        empty.location = o.location.copy()
        for key in ('sizeXYZ', 'kannonGuide', 'kind', 'surface'):
            if key in o:
                empty[key] = o[key]
        bpy.context.scene.collection.objects.link(empty)
        empty.select_set(True); exported += 1
    for col in bpy.data.collections:
        col.hide_render = False
    path = OUT / 'town-v3-raw.glb'
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
        export_texcoords=True, export_normals=True, export_extras=True, export_materials='EXPORT', export_image_format='AUTO',
        export_animations=False, export_cameras=False, export_lights=False,
        export_vertex_color='NAME', export_vertex_color_name='Color', export_all_vertex_colors=False,
    )
    log(f'exported {exported} objects to {path} ({path.stat().st_size / 1e6:.1f} MB)')


def main():
    args = parse_args()
    stages = ['prepare', 'uv', 'bake', 'export'] if args.stage == 'all' else [args.stage]
    for stage in stages:
        started = time.time()
        if stage == 'prepare': stage_prepare()
        elif stage == 'uv': stage_uv()
        elif stage == 'preview': stage_preview(args.preview_samples, args.views)
        elif stage == 'bake': stage_bake(args.samples, args.atlas)
        elif stage == 'shade': stage_shade()
        elif stage == 'export': stage_export()
        else: raise SystemExit(f'unknown stage {stage}')
        log(f'stage {stage} done in {time.time() - started:.0f}s')


if __name__ == '__main__':
    main()
