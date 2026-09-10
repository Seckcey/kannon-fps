"""Kannon Town v2: textured, prop-dressed, lightmapped town built on the refined town geometry.

Stages (run in order, or --stage all):
  prepare  open art/source/kannon-town-graphics.blend, replace every material with a CC0 PBR
           set, split interior faces to plaster, re-project UVs at one metre per unit, import,
           decimate and place Poly Haven props, add grass cards, add collision guides and the
           calibrated sun/sky, save art/source/town-v2/kannon-town-v2.blend (ignored by git)
  uv       lightmap-unwrap the three atlas groups into a 'Lightmap' UV layer and save
  preview  render three Cycles viewpoints at low samples to art/source/town-v2/preview-*.png
  bake     bake diffuse direct+indirect lighting per atlas, normalise, write LM_*.png and the
           finish-script sidecar art/source/town-v2/town-v2-lightmaps.json
  export   write art/source/town-v2/town-v2-raw.glb (uncompressed; finish_town_v2.mjs compresses)

blender --background --python scripts/blender/generate_town_v2.py -- --stage all [--samples 192] [--atlas 2048]

Provenance: base geometry is the repository's own refined town; textures and props are CC0
Poly Haven assets listed in art/source/town-v2/cc0-manifest.json (see art/PURCHASED_ASSETS.md).
"""
import argparse, json, math, os, random, sys, time
from pathlib import Path

import bpy, bmesh
import numpy as np
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'art/source'
OUT = SOURCE / 'town-v2'
sys.path.insert(0, str(ROOT / 'scripts/blender'))
import import_collision_layout as guides  # noqa: E402

MANIFEST = json.loads((OUT / 'cc0-manifest.json').read_text(encoding='utf-8'))
MAP = json.loads((OUT / 'map.json').read_text(encoding='utf-8'))
BASE_BLEND = SOURCE / 'kannon-town-graphics.blend'
V2_BLEND = OUT / 'kannon-town-v2.blend'  # working file with packed textures; regenerated, not committed
SUN_STRENGTH = 4.0
SKY_STRENGTH = 0.6
TARGET_SUNLIT_IRRADIANCE = 3.2  # three.js: sun 3.3 * cos(47.8 deg) + hemisphere sky on an upward normal
rng = random.Random(9102026)


def log(*parts):
    print('[town-v2]', *parts, flush=True)


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', default='all')
    parser.add_argument('--samples', type=int, default=192)
    parser.add_argument('--atlas', type=int, default=2048)
    parser.add_argument('--preview-samples', type=int, default=48)
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
        'fabric': pbr_material('V2_Fabric', 'fabric_pattern_07', 1.0),
        'metal': plain_material('V2_Metal', (0.8, 0.8, 0.8), 0.42, 0.75),
        'glass': plain_material('V2_Glass', (0.22, 0.32, 0.36), 0.12, 0.3, vertex_color=False),
        'markings': plain_material('V2_Markings', (0.9, 0.9, 0.9), 0.85),
        'leaves': plain_material('V2_Leaves', (0.9, 0.95, 0.85), 0.9, double_sided=True),
    }
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

# Props whose natural pose is not how they are used: the tyre lies flat.
PRE_ROTATE = {'tyre': (math.radians(90), 0.0, 0.0), 'wheel_rim': (math.radians(90), 0.0, 0.0)}

# (prop, x, y, z, yaw degrees, scale) in game coordinates; y is the base height.
# Solid props sit inside existing collision boxes, against walls, beyond the fences or on
# roofs; foliage and flat items may be walked through. Collision never changes.
PLACEMENTS = []


def place(prop, x, y, z, yaw=0.0, scale=1.0):
    PLACEMENTS.append((prop, x, y, z, yaw, scale))


def plan_placements():
    for side in (-1, 1):
        s = side
        # Yard cover boxes (±27, 0.6, -15; 3.5 x 1.2 x 1.3): barrels and crates instead of plain wood.
        if side < 0:
            place('barrel_wood', -28.0, 0, -15.0, 20); place('barrel_steel', -27.1, 0, -15.1, 0)
            place('crate', -25.9, 0, -15.0, 90); place('tyre', -25.9, 0.45, -15.0, 90, 1.0)
        else:
            place('compost_bags', 27.15, 0, -15.0, -90); place('crate', 26.0, 0, -15.0, 90)
            place('plastic_crate', 26.0, 0.45, -15.0, 15); place('barrel_steel', 28.2, 0, -15.0, 0)
            place('tyre', 27.2, 0.7, -15.1, 0)
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
        # Potted plant beside the front door, on the sidewalk against the wall.
        place('potted_plant', s * 9.5, 0, -4.0, 0)
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
    # North mail crates (-4.8, 0.7, -17; 2.3 x 1.4 x 2.2): a stacked delivery pile as tall as
    # the collision box so nothing feels like an invisible wall.
    place('barrel_steel', -5.4, 0, -17.2, 0); place('tyre', -5.4, 0.88, -17.2, 20)
    place('cardboard_box', -5.4, 0, -16.35, -15); place('cardboard_box', -5.4, 0.34, -16.4, 30); place('plastic_crate', -5.4, 0.68, -16.35, 10)
    place('crate', -4.3, 0, -17.0, 0); place('crate', -4.3, 0.46, -17.0, 180); place('cardboard_box', -4.3, 0.92, -17.2, 10)
    place('tyre', -4.8, 0, -17.0, 0); place('tyre', -4.8, 0.17, -17.05, 35)
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
    if key in PRE_ROTATE:
        obj.rotation_euler = PRE_ROTATE[key]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
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

    for side in (-1, 1):
        s = side
        area(f'Fill_main_{side}', s * 13.8, 2.85, 0.0, 6.0, 10.0, 420)
        area(f'Fill_rear_{side}', s * 20.0, 2.85, 0.0, 3.0, 10.0, 220)
        area(f'Fill_upstairs_{side}', s * 16.0, 6.05, 0.0, 10.0, 10.0, 520)
        area(f'Fill_garage_{side}', s * 14.0, 2.8, 9.75, 7.0, 6.0, 320)
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
    guides.build(MAP)
    build_interior_lights()
    sun = bpy.data.objects['Sun']; sun.data.energy = SUN_STRENGTH
    bpy.data.worlds[bpy.context.scene.world.name].node_tree.nodes['Background'].inputs['Strength'].default_value = SKY_STRENGTH
    for o in bpy.data.objects:
        ensure_color_attribute(o)
    for image in bpy.data.images:
        if image.size[0] and not image.packed_file and image.filepath:
            image.pack()
    bpy.ops.wm.save_as_mainfile(filepath=str(V2_BLEND))
    log('saved', V2_BLEND)


LIGHTMAP_GROUPS = {
    'LM_arch': lambda o: o.name in ('Town_siding', 'Refined_siding', 'Town_trim', 'Refined_trim', 'Town_roof', 'Refined_roof', 'Refined_concrete', 'Refined_glass', 'Refined_metal', 'Town_metal', 'Town_wood', 'Refined_wood', 'Refined_fabric'),
    'LM_ground': lambda o: o.name in ('Town_asphalt', 'Town_grass', 'Town_concrete', 'Refined_markings'),
    'LM_foliage': lambda o: o.name == 'Bushes',
    'LM_props': lambda o: o.name.startswith('Prop_') or o.name.startswith('Vehicle_') or o.name in ('Town_paint', 'Town_rubber', 'Town_glass'),
}
# Foliage cards only need a soft per-card light level, so they share a quarter-size atlas.
# The architecture group carries the most surface (both wall faces, trim, fences), so it bakes at twice the size.
ATLAS_SCALE = {'LM_arch': 2, 'LM_ground': 1, 'LM_props': 1, 'LM_foliage': 0.25}


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
    bpy.ops.wm.open_mainfile(filepath=str(V2_BLEND))
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
            bpy.ops.uv.pack_islands(udim_source='ACTIVE_UDIM', rotate=True, rotate_method='CARDINAL', scale=True, margin_method='FRACTION', margin=0.003, shape_method='CONCAVE' if name != 'LM_arch' else 'AABB')
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


def bake(objects, image, samples):
    configure_cycles(samples)
    scene = bpy.context.scene
    scene.render.bake.use_pass_direct = True
    scene.render.bake.use_pass_indirect = True
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
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT'}, margin=8, use_clear=True, uv_layer='Lightmap')
    for o in objects:
        o.data.uv_layers['UVMap'].active_render = True


def soften(rgb):
    """One-texel weighted blur that ignores empty (black) texels, so island edges do not bleed."""
    weight = (rgb.sum(axis=2) > 1e-5).astype(np.float32)
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


def calibration_irradiance(samples):
    """Bake a 1 m plane in open sun and return its mean diffuse-light value (Blender units)."""
    mesh = bpy.data.meshes.new('CalibrationPlane')
    # Counter-clockwise seen from above so the face normal points up at the sky.
    mesh.from_pydata([gb(-0.5, 0.02, 12.5), gb(0.5, 0.02, 12.5), gb(0.5, 0.02, 11.5), gb(-0.5, 0.02, 11.5)], [], [(0, 1, 2, 3)]); mesh.update()
    obj = bpy.data.objects.new('CalibrationPlane', mesh); bpy.context.scene.collection.objects.link(obj)
    uv = mesh.uv_layers.new(name='UVMap'); lm = mesh.uv_layers.new(name='Lightmap')
    for li, co in zip(range(4), [(0.1, 0.1), (0.9, 0.1), (0.9, 0.9), (0.1, 0.9)]):
        uv.data[li].uv = co; lm.data[li].uv = co
    mat = bpy.data.materials.new('CalibrationMaterial'); mat.use_nodes = True
    mesh.materials.append(mat)
    image = bpy.data.images.new('LM_calibration', 32, 32, float_buffer=True)
    bake([obj], image, max(32, samples // 4))
    pixels = image_pixels(image)[8:24, 8:24, :3]
    value = float(pixels.mean())
    bpy.data.objects.remove(obj, do_unlink=True); bpy.data.materials.remove(mat); bpy.data.images.remove(image)
    log(f'calibration plane mean diffuse light: {value:.4f}')
    return value


def stage_bake(samples, atlas):
    bpy.ops.wm.open_mainfile(filepath=str(V2_BLEND))
    started = time.time()
    reference = calibration_irradiance(samples)
    normaliser = reference * 1.45  # sunlit walls facing the sun exceed a horizontal plane
    sidecar = {'atlases': {}, 'materials': {}, 'alphaMask': [], 'doubleSided': [], 'calibration': {'referenceDiffuseLight': reference, 'normaliser': normaliser, 'targetIrradiance': TARGET_SUNLIT_IRRADIANCE}}
    intensity = TARGET_SUNLIT_IRRADIANCE * normaliser / reference
    for name in LIGHTMAP_GROUPS:
        objects = group_objects(name)
        size = int(atlas * ATLAS_SCALE[name])
        image = bpy.data.images.new(name, size, size, float_buffer=True)
        image.colorspace_settings.name = 'Non-Color'
        group_started = time.time()
        bake(objects, image, samples)
        pixels = image_pixels(image)
        rgb = np.clip(pixels[:, :, :3] / normaliser, 0, 1)
        rgb = soften(rgb)
        # Store in sRGB 8-bit PNG; the runtime decodes sRGB and multiplies by lightMapIntensity.
        encoded = np.where(rgb <= 0.0031308, rgb * 12.92, 1.055 * np.power(rgb, 1 / 2.4) - 0.055)
        out = bpy.data.images.new(f'{name}_png', size, size, alpha=False)
        out.colorspace_settings.name = 'sRGB'
        rgba = np.concatenate([encoded, np.ones((size, size, 1), np.float32)], axis=2)
        out.pixels.foreach_set(rgba.ravel())
        path = OUT / f'{name}.png'
        out.filepath_raw = str(path); out.file_format = 'PNG'; out.save()
        sidecar['atlases'][name] = f'{name}.png'
        materials = set()
        for o in objects:
            for slot in o.material_slots:
                if slot.material:
                    materials.add(slot.material.name)
        for material in sorted(materials):
            sidecar['materials'][material] = {'atlas': name, 'intensity': intensity}
        log(f'{name}: baked {len(objects)} objects in {time.time() - group_started:.0f}s; max {pixels[:, :, :3].max():.3f}, mean {pixels[:, :, :3].mean():.3f}')
        bpy.data.images.remove(image); bpy.data.images.remove(out)
    remove_bake_nodes()
    for mat in bpy.data.materials:
        if mat.name in ('V2_GrassCard', 'V2_Leaves') or mat.name.startswith('Prop_shrub') or mat.name.startswith('Prop_potted_plant'):
            sidecar['alphaMask'].append(mat.name); sidecar['doubleSided'].append(mat.name)
    (OUT / 'town-v2-lightmaps.json').write_text(json.dumps(sidecar, indent=2) + '\n', encoding='utf-8')
    bpy.ops.wm.save_mainfile()
    log(f'bake complete in {time.time() - started:.0f}s; lightMapIntensity {intensity:.3f}')


def stage_preview(samples):
    bpy.ops.wm.open_mainfile(filepath=str(V2_BLEND))
    configure_cycles(samples)
    scene = bpy.context.scene
    scene.render.resolution_x, scene.render.resolution_y = 1280, 720
    scene.view_settings.view_transform = 'AgX'
    cam = bpy.data.objects.get('PreviewCam') or bpy.data.objects.new('PreviewCam', bpy.data.cameras.new('PreviewCam'))
    if cam.name not in scene.collection.objects:
        scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.lens = 28
    views = {
        'street': (gb(-4.5, 1.7, 14.0), gb(-8.0, 2.5, -8.0)),
        'house': (gb(2.0, 2.2, -12.0), gb(-16.0, 3.5, -3.0)),
        'yard': (gb(-29.5, 2.0, 5.0), gb(-21.0, 1.6, 12.5)),
        'north': (gb(-24.0, 1.7, -12.0), gb(-14.0, 1.5, -6.5)),
        'garage': (gb(-4.0, 1.7, 9.5), gb(-16.0, 1.6, 9.8)),
    }
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


def stage_export():
    bpy.ops.wm.open_mainfile(filepath=str(V2_BLEND))
    remove_bake_nodes()
    # One mesh per family: the exporter emits one primitive per material, so draw calls equal
    # the number of distinct materials rather than the number of objects.
    meshes = [o for o in bpy.data.objects if o.type == 'MESH' and not o.name.startswith('PropSrc_') and o.name != 'CalibrationPlane'
              and not any(c.name == 'Props_Library' or c.name.startswith('Guides_') for c in o.users_collection)]
    names = [o.name for o in meshes]
    join_objects([n for n in names if n.startswith('Horizon_')], 'Horizon')
    join_objects([n for n in names if n.startswith('Vehicle_') or n in ('Town_paint', 'Town_rubber', 'Town_glass')], 'Vehicles')
    join_objects([n for n in names if n.startswith('Prop_')], 'Props')
    join_objects([n for n in names if n.startswith(('Town_', 'Refined_')) and n not in ('Town_paint', 'Town_rubber', 'Town_glass')], 'Town')
    join_objects(['Bushes', 'GrassCards'], 'Foliage')
    bpy.ops.object.select_all(action='DESELECT')
    exported = 0
    for o in bpy.data.objects:
        if o.type == 'MESH' and o.name in ('Horizon', 'Vehicles', 'Props', 'Town', 'Foliage'):
            o.hide_render = False
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
    path = OUT / 'town-v2-raw.glb'
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
        elif stage == 'preview': stage_preview(args.preview_samples)
        elif stage == 'bake': stage_bake(args.samples, args.atlas)
        elif stage == 'export': stage_export()
        else: raise SystemExit(f'unknown stage {stage}')
        log(f'stage {stage} done in {time.time() - started:.0f}s')


if __name__ == '__main__':
    main()
