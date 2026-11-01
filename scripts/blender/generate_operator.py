"""Kannon operator: the scout's rig and clips re-dressed as an original modern military operator.

    node scripts/blender/run_blender.mjs --python scripts/blender/generate_operator.py -- [options]
      --stage all|preview|poses
                            preview renders the procedural look only (no bake, no export); poses
                            authors the clips, prints the posture-fit audit and renders the side
                            pose sheets with the hit boxes drawn in (seconds; for tuning poses)
      --work DIR            baked atlas PNGs and the raw GLB (default: <system temp>/kannon-operator)
      --size 2048           atlas edge in pixels (square)
      --bake-samples 16     Cycles samples for the colour, metal/roughness and normal bakes
      --ao-samples 128      Cycles samples for the ambient-occlusion bake
      --render-samples 64   Cycles samples for the review renders
      --previews DIR        where review renders go (default: art/source)

Reads art/source/scout.blend: the 18-bone ScoutRig, its seven gameplay clips and their NLA tracks.
Walk/Run hip and leg motion derives from the CMU 09_01 capture (art/source/motion/cmu-09, separate
terms; credited in public/models/operator-motion-NOTICE.txt). Everything else here is original:
the scout body, weapons, muzzles and retired Heal clip are removed; operator gear is modelled on the
same rest pose and skinned to the same bones; Walk/Run keep the scout's hips and legs exactly but
their upper body is re-posed upright so the head stays over the player's hit boxes; Crouch,
CrouchWalk and Slide are authored to fit the shared posture heights and hit boxes read from
shared/physics.ts; an empty weapon_socket is added under hand_r; one gear atlas is baked from
procedural materials; and the model is exported with Walk, Run and CrouchWalk sampled at 120 Hz
(the scout's own merge step in scout_export.py). finish_operator.mjs compresses the raw export to
public/models/operator-v1.glb and validate_operator.mjs checks it. Saves art/source/operator.blend
(before baking) and writes art/source/operator-{front,back,head}.png, operator-poses.jpg,
operator-low-poses.jpg, operator-gait-poses.jpg and operator-manifest.json.
Units: metres. Blender +Y is forward and +Z up; the glTF export is -Z forward and +Y up.
"""
import bpy
import bmesh
import json
import math
import os
import re
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
from mathutils import Matrix, Vector

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from scout_export import _merge_animation_samples  # noqa: E402  (unchanged scout code)

ROOT = HERE.parents[1]
SOURCE = ROOT / 'art' / 'source'
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def option(name, default):
    flag = '--' + name
    return ARGS[ARGS.index(flag) + 1] if flag in ARGS else default


STAGE = option('stage', 'all')
WORK = Path(option('work', str(Path(tempfile.gettempdir()) / 'kannon-operator')))
PREVIEWS = Path(option('previews', str(SOURCE)))
SIZE = int(option('size', 2048))
AO_SAMPLES = int(option('ao-samples', 128))
RENDER_SAMPLES = int(option('render-samples', 64))
WORK.mkdir(parents=True, exist_ok=True)
PREVIEWS.mkdir(parents=True, exist_ok=True)
STARTED = time.time()


def log(message):
    print(f'OPERATOR [{time.time() - STARTED:6.1f}s] {message}', flush=True)


# ---------------------------------------------------------------------------------------------
# Source rig and clips.
bpy.ops.wm.open_mainfile(filepath=str(SOURCE / 'scout.blend'))
bpy.context.preferences.filepaths.save_version = 0
scene = bpy.context.scene
rig = bpy.data.objects['ScoutRig']
for name in ['scout_body', 'weapon_ar', 'weapon_shotgun', 'healing_item', 'muzzle', 'muzzle_shotgun',
             'StudioCamera', 'StudioFill', 'StudioFloor', 'StudioKey', 'StudioRim']:
    obj = bpy.data.objects.get(name)
    if obj:
        bpy.data.objects.remove(obj, do_unlink=True)
for track in list(rig.animation_data.nla_tracks):
    if track.name == 'Heal':
        rig.animation_data.nla_tracks.remove(track)
if 'Heal' in bpy.data.actions:
    bpy.data.actions.remove(bpy.data.actions['Heal'])
for material in list(bpy.data.materials):
    bpy.data.materials.remove(material)
bpy.data.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)
clips = {}
for track in rig.animation_data.nla_tracks:
    strip = track.strips[0]
    clips[track.name] = (strip.action, int(round(strip.action_frame_end - 1)))
assert list(clips) == ['Idle', 'Walk', 'Run', 'Jump', 'Aim', 'Fire', 'Reload'], list(clips)
rig.animation_data.action = None
for pose_bone in rig.pose.bones:
    pose_bone.rotation_mode = 'XYZ'
    pose_bone.rotation_euler = (0, 0, 0); pose_bone.location = (0, 0, 0); pose_bone.scale = (1, 1, 1)
bpy.context.view_layer.update()
REST = {bone.name: (bone.head_local.copy(), bone.tail_local.copy()) for bone in rig.data.bones}
COLLECTION = scene.collection


def clamp(value, low, high):
    return max(low, min(high, value))


def smoothstep(edge0, edge1, value):
    t = clamp((value - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def srgb(hex_colour):
    """'#rrggbb' -> linear RGB tuple."""
    out = []
    for i in (1, 3, 5):
        c = int(hex_colour[i:i + 2], 16) / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return tuple(out)


# ---------------------------------------------------------------------------------------------
# Procedural materials. Each one renders directly (preview) and is baked into the gear atlas.
# BAKE[material] records the sockets for the colour, roughness and metallic passes.
BAKE = {}


class Graph:
    def __init__(self, name):
        self.material = bpy.data.materials.new(name)
        self.material.use_nodes = True
        self.tree = self.material.node_tree
        self.nodes, self.links = self.tree.nodes, self.tree.links
        self.bsdf = self.nodes.get('Principled BSDF')
        self.output = self.nodes.get('Material Output')
        coords = self.nodes.new('ShaderNodeTexCoord')
        self.object = coords.outputs['Object']

    def node(self, kind, inputs=None, **props):
        node = self.nodes.new(kind)
        for key, value in props.items():
            setattr(node, key, value)
        for key, value in (inputs or {}).items():
            socket = node.inputs[key]
            if isinstance(value, bpy.types.NodeSocket):
                self.links.new(value, socket)
            else:
                socket.default_value = value
        return node

    def math(self, operation, a, b=0.0, clamp_result=False):
        node = self.nodes.new('ShaderNodeMath'); node.operation = operation; node.use_clamp = clamp_result
        for index, value in enumerate((a, b)):
            if isinstance(value, bpy.types.NodeSocket):
                self.links.new(value, node.inputs[index])
            else:
                node.inputs[index].default_value = value
        return node.outputs[0]

    def vector(self, operation, a, b):
        node = self.nodes.new('ShaderNodeVectorMath'); node.operation = operation
        for index, value in enumerate((a, b)):
            if isinstance(value, bpy.types.NodeSocket):
                self.links.new(value, node.inputs[index])
            else:
                node.inputs[index].default_value = value
        return node.outputs[0]

    def noise(self, scale, detail=2.0, roughness=0.5, distortion=0.0, offset=(0, 0, 0), stretch=(1, 1, 1)):
        coords = self.object
        if stretch != (1, 1, 1):
            coords = self.vector('MULTIPLY', coords, stretch)
        if offset != (0, 0, 0):
            coords = self.vector('ADD', coords, offset)
        node = self.node('ShaderNodeTexNoise', {'Vector': coords, 'Scale': scale, 'Detail': detail,
                                                'Roughness': roughness, 'Distortion': distortion})
        return node.outputs['Fac']

    def mix(self, factor, a, b, mode='MIX'):
        node = self.nodes.new('ShaderNodeMix'); node.data_type = 'RGBA'; node.blend_type = mode
        for socket, value in [(node.inputs['Factor'], factor), (node.inputs[6], a), (node.inputs[7], b)]:
            if isinstance(value, bpy.types.NodeSocket):
                self.links.new(value, socket)
            elif isinstance(value, (int, float)):
                socket.default_value = value
            else:
                socket.default_value = tuple(value) if len(value) == 4 else (*value, 1.0)
        return node.outputs[2]

    def step(self, value, threshold, softness=0.015):
        """Anti-aliased threshold: 0 below, 1 above."""
        ramp = self.math('SUBTRACT', value, threshold - softness)
        return self.math('MULTIPLY', ramp, 1 / (2 * softness), clamp_result=True)

    def edges(self, distance=0.008):
        """1 on convex edges, 0 on open faces (inside ambient occlusion)."""
        ao = self.node('ShaderNodeAmbientOcclusion', {'Distance': distance}, inside=True, samples=8)
        return self.math('SUBTRACT', 1.0, ao.outputs['AO'], clamp_result=True)

    def cavity(self, distance=0.03):
        """1 in crevices, 0 on open faces."""
        ao = self.node('ShaderNodeAmbientOcclusion', {'Distance': distance}, samples=8)
        return self.math('SUBTRACT', 1.0, ao.outputs['AO'], clamp_result=True)

    def bump(self, height, strength, distance, normal=None):
        inputs = {'Height': height, 'Strength': strength, 'Distance': distance}
        if normal is not None:
            inputs['Normal'] = normal
        return self.node('ShaderNodeBump', inputs).outputs['Normal']

    def finish(self, colour, roughness, metallic, normal=None):
        def connect(value, socket):
            if isinstance(value, bpy.types.NodeSocket):
                self.links.new(value, socket)
            else:
                socket.default_value = value
        connect(colour, self.bsdf.inputs['Base Color'])
        connect(roughness, self.bsdf.inputs['Roughness'])
        connect(metallic, self.bsdf.inputs['Metallic'])
        if normal is not None:
            self.links.new(normal, self.bsdf.inputs['Normal'])
        rough_socket = roughness if isinstance(roughness, bpy.types.NodeSocket) else None
        metal_socket = metallic if isinstance(metallic, bpy.types.NodeSocket) else None
        BAKE[self.material.name] = {'colour': colour, 'roughness': roughness if rough_socket is None else rough_socket,
                                    'metallic': metallic if metal_socket is None else metal_socket}
        return self.material


def fabric_material(name, colours, scale=6.0, roughness=0.88, dust=0.0, wrinkles=0.35, contrast=1.0):
    """Woven field fabric: an original four-tone blotch camouflage when four colours are given."""
    g = Graph(name)
    base = colours[0]
    colour = g.mix(0.0, base, base)
    if len(colours) > 1:
        large = g.noise(scale, 3.0, 0.55, 0.35)
        colour = g.mix(g.step(large, 0.56 - 0.04 * (contrast - 1), 0.012), colour, colours[1])
    if len(colours) > 2:
        mid = g.noise(scale * 1.45, 2.5, 0.6, 0.5, offset=(11.3, 7.1, 3.7))
        colour = g.mix(g.step(mid, 0.61, 0.012), colour, colours[2])
    if len(colours) > 3:
        speck = g.noise(scale * 2.6, 2.0, 0.6, 0.6, offset=(-4.2, 9.9, 1.3))
        colour = g.mix(g.step(speck, 0.665, 0.01), colour, colours[3])
    # Fibre tone and broad sun fading relative to the fabric's own colour, so dark knit stays dark;
    # no lighting is baked into colour.
    fade = g.noise(2.2, 2.0, 0.5, offset=(3.3, 3.3, 3.3))
    bleached = g.mix(1.0, colour, (1.5, 1.45, 1.38), mode='MULTIPLY')
    colour = g.mix(g.math('MULTIPLY', fade, 0.35), colour, bleached)
    fuzz = g.noise(180.0, 2.0, 0.7)
    colour = g.mix(g.math('MULTIPLY', fuzz, 0.10), colour, (0.0, 0.0, 0.0))
    if dust:
        # Lower legs and boots pick up street dust.
        z = g.node('ShaderNodeSeparateXYZ', {'Vector': g.object}).outputs['Z']
        low = g.math('SUBTRACT', 1.0, g.math('MULTIPLY', z, 1 / 0.55), clamp_result=True)
        patch = g.noise(9.0, 3.0, 0.6, 0.4, offset=(7, 1, 3))
        amount = g.math('MULTIPLY', g.math('MULTIPLY', low, patch), dust * 1.6, clamp_result=True)
        colour = g.mix(amount, colour, (0.30, 0.26, 0.20))
    grime = g.cavity(0.025)
    colour = g.mix(g.math('MULTIPLY', grime, 0.45), colour, (0.035, 0.032, 0.026))
    rough = g.math('ADD', roughness - 0.03, g.math('MULTIPLY', g.noise(30.0), 0.06))
    weave = g.bump(g.noise(260.0, 1.0, 0.5), 0.12, 0.0015)
    crease = g.noise(7.0, 2.0, 0.5, 1.2, stretch=(1.0, 1.0, 2.4))
    normal = g.bump(crease, wrinkles, 0.012, weave)
    return g.finish(colour, rough, 0.0, normal)


def nylon_material(name, colour, molle=False, roughness=0.80, wear=0.25):
    """Cordura-style nylon; molle adds 25 mm webbing rows on a 50 mm pitch with bar tacks."""
    g = Graph(name)
    tone = g.noise(14.0, 2.0, 0.55)
    base = g.mix(g.math('MULTIPLY', tone, 0.14), colour, tuple(c * 0.72 for c in colour))
    height = g.math('MULTIPLY', g.noise(220.0, 1.0, 0.5), 0.2)
    if molle:
        xyz = g.node('ShaderNodeSeparateXYZ', {'Vector': g.object})
        # 1 on the 25 mm webbing, 0 in the 25 mm gap, with ~3 mm soft edges.
        row = g.math('FRACT', g.math('MULTIPLY', xyz.outputs['Z'], 1 / 0.0508))
        band = g.math('ADD', g.math('MULTIPLY', g.math('SUBTRACT', 0.25, g.math('ABSOLUTE', g.math('SUBTRACT', row, 0.5))), 18.0), 0.5)
        band = g.math('MINIMUM', g.math('MAXIMUM', band, 0.0), 1.0)
        across = g.math('ADD', xyz.outputs['X'], xyz.outputs['Y'])
        tack = g.math('FRACT', g.math('MULTIPLY', across, 1 / 0.0381))
        tack_line = g.math('ADD', g.math('MULTIPLY', g.math('SUBTRACT', 0.05, g.math('ABSOLUTE', g.math('SUBTRACT', tack, 0.5))), 30.0), 0.5)
        tack_line = g.math('MINIMUM', g.math('MAXIMUM', tack_line, 0.0), 1.0)
        tacks = g.math('MULTIPLY', tack_line, band)
        gap = g.math('SUBTRACT', 1.0, band)
        base = g.mix(g.math('MULTIPLY', gap, 0.45), base, tuple(c * 0.45 for c in colour))
        base = g.mix(g.math('MULTIPLY', tacks, 0.35), base, tuple(c * 0.6 for c in colour))
        height = g.math('ADD', height, g.math('SUBTRACT', band, g.math('MULTIPLY', tacks, 0.5)))
    edge = g.edges(0.010)
    base = g.mix(g.math('MULTIPLY', edge, wear), base, tuple(min(1.0, c * 1.55 + 0.03) for c in colour))
    grime = g.cavity(0.03)
    base = g.mix(g.math('MULTIPLY', grime, 0.5), base, (0.03, 0.028, 0.022))
    rough = g.math('ADD', roughness - 0.04, g.math('MULTIPLY', g.noise(24.0), 0.08))
    normal = g.bump(height, 0.35, 0.004)
    return g.finish(base, rough, 0.0, normal)


def paint_material(name, colour, roughness=0.62, wear=0.6, scuffs=0.35):
    """Matte polymer paint over a darker composite shell; edges and scuffs show through."""
    g = Graph(name)
    tone = g.noise(9.0, 3.0, 0.5)
    base = g.mix(g.math('MULTIPLY', tone, 0.12), colour, tuple(c * 0.8 for c in colour))
    texture = g.noise(140.0, 2.0, 0.6)
    edge = g.edges(0.012)
    scratch = g.step(g.noise(55.0, 3.0, 0.7, 0.8, stretch=(1, 1, 6)), 0.72, 0.02)
    worn = g.math('ADD', g.math('MULTIPLY', edge, wear), g.math('MULTIPLY', scratch, scuffs), clamp_result=True)
    base = g.mix(worn, base, (0.045, 0.045, 0.040))
    rough = g.math('ADD', g.math('ADD', roughness, g.math('MULTIPLY', texture, 0.08)), g.math('MULTIPLY', worn, -0.15))
    normal = g.bump(g.math('ADD', texture, g.math('MULTIPLY', scratch, -1.0)), 0.18, 0.0015)
    return g.finish(base, rough, 0.0, normal)


def simple_material(name, colour, roughness, metallic=0.0, grain=120.0, grain_strength=0.15, edge_light=0.0):
    g = Graph(name)
    tone = g.noise(18.0, 2.0, 0.5)
    base = g.mix(g.math('MULTIPLY', tone, 0.12), colour, tuple(c * 0.75 for c in colour))
    if edge_light:
        base = g.mix(g.math('MULTIPLY', g.edges(0.006), edge_light), base, tuple(min(1.0, c * 2.2 + 0.05) for c in colour))
    grime = g.cavity(0.02)
    base = g.mix(g.math('MULTIPLY', grime, 0.4), base, (0.02, 0.02, 0.018))
    rough = g.math('ADD', roughness, g.math('MULTIPLY', g.noise(40.0), 0.06))
    normal = g.bump(g.noise(grain, 2.0, 0.6), grain_strength, 0.0015)
    return g.finish(base, rough, metallic, normal)


CAMO = [srgb('#55533f'), srgb('#41372a'), srgb('#282c21'), srgb('#6f6750')]
M = {
    'uniform': fabric_material('UniformCamo', CAMO, 6.5, 0.9, dust=0.45, wrinkles=0.4),
    'shirt': fabric_material('CombatShirt', CAMO, 6.5, 0.9, dust=0.0, wrinkles=0.3),
    'wrap': fabric_material('FaceWrap', [srgb('#262721'), srgb('#1f201b')], 14.0, 0.95, dust=0.0, wrinkles=0.7),
    'carrier': nylon_material('CarrierNylon', srgb('#363a2e'), molle=True),
    'nylon': nylon_material('PouchNylon', srgb('#363a2e')),
    'coyote': nylon_material('CoyoteNylon', srgb('#6b5a42'), wear=0.3),
    'webbing': nylon_material('Webbing', srgb('#23251e'), roughness=0.72, wear=0.15),
    'helmet': paint_material('HelmetPaint', srgb('#45473a')),
    'velcro': simple_material('VelcroLoop', srgb('#30322a'), 0.96, grain=320, grain_strength=0.3),
    'knit': simple_material('KnitBalaclava', srgb('#1c1d1a'), 0.95, grain=300, grain_strength=0.25),
    'glove': simple_material('GloveSynthetic', srgb('#2b2a26'), 0.66, grain=200, grain_strength=0.2, edge_light=0.35),
    'rubber': simple_material('Rubber', srgb('#1b1b19'), 0.82, grain=150, grain_strength=0.15, edge_light=0.25),
    'suede': fabric_material('BootSuede', [srgb('#6e5b40')], 1.0, 0.86, dust=0.6, wrinkles=0.25),
    'metal': simple_material('DarkMetal', srgb('#34363a'), 0.42, 0.85, grain=90, grain_strength=0.08, edge_light=0.5),
    'polymer': simple_material('Polymer', srgb('#26272a'), 0.5, grain=110, grain_strength=0.1, edge_light=0.3),
}
accent_material = bpy.data.materials.new('PlayerAccent')
accent_material.use_nodes = True
accent_bsdf = accent_material.node_tree.nodes.get('Principled BSDF')
accent_bsdf.inputs['Base Color'].default_value = (*srgb('#4aa3ff'), 1)
accent_bsdf.inputs['Roughness'].default_value = 0.62
accent_bsdf.inputs['Metallic'].default_value = 0.0
accent_material.diffuse_color = (*srgb('#4aa3ff'), 1)
lens_material = bpy.data.materials.new('Visor')
lens_material.use_nodes = True
lens_bsdf = lens_material.node_tree.nodes.get('Principled BSDF')
lens_bsdf.inputs['Base Color'].default_value = (0.012, 0.014, 0.015, 1)
lens_bsdf.inputs['Roughness'].default_value = 0.08
lens_bsdf.inputs['Metallic'].default_value = 0.9


# ---------------------------------------------------------------------------------------------
# Mesh construction. Every part is built directly in armature space (identity object transform)
# so all parts share one coordinate system for patterns, baking and skinning.
PARTS = {'atlas': [], 'accent': [], 'lens': []}


def build(name, verts, faces, material, weights, kind='atlas', smooth=True, sharp=None):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(v) for v in verts], [], faces)
    mesh.validate(clean_customdata=False)
    mesh.update()
    bm = bmesh.new(); bm.from_mesh(mesh)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh); bm.free()
    return finish_object(name, mesh, material, weights, kind, smooth, sharp)


def finish_object(name, mesh, material, weights, kind='atlas', smooth=True, sharp=None):
    obj = bpy.data.objects.new(name, mesh)
    COLLECTION.objects.link(obj)
    mesh.materials.append(material)
    if smooth:
        mesh.shade_smooth()
        if sharp is not None:
            mesh.set_sharp_from_angle(angle=math.radians(sharp))
    else:
        mesh.shade_flat()
    groups = {}
    for vertex in mesh.vertices:
        values = {weights: 1.0} if isinstance(weights, str) else weights(vertex.co.copy())
        values = {bone: w for bone, w in values.items() if w > 1e-4}
        total = sum(values.values())
        for bone, w in values.items():
            if bone not in groups:
                groups[bone] = obj.vertex_groups.new(name=bone)
            groups[bone].add([vertex.index], w / total, 'REPLACE')
    modifier = obj.modifiers.new('Operator Skin', 'ARMATURE')
    modifier.object = rig
    obj.parent = rig
    PARTS[kind].append(obj)
    return obj


def rounded_box(name, centre, size, radius, material, weights, segments=2, rotation=None, kind='atlas', deform=None):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for vertex in bm.verts:
        vertex.co = Vector((vertex.co.x * size[0], vertex.co.y * size[1], vertex.co.z * size[2]))
    radius = min(radius, min(size) * 0.49)
    if radius > 0:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=radius, segments=segments, affect='EDGES', profile=0.5)
    matrix = Matrix.Translation(Vector(centre))
    if rotation is not None:
        matrix = matrix @ rotation.to_matrix().to_4x4() if hasattr(rotation, 'to_matrix') else matrix @ rotation
    for vertex in bm.verts:
        vertex.co = matrix @ vertex.co
        if deform:
            vertex.co = deform(vertex.co)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh); bm.free()
    return finish_object(name, mesh, material, weights, kind, True, 35)


def loft(rings, caps=(True, True)):
    """Quad strips between equal-length rings; caps are fans around a centre vertex."""
    n = len(rings[0])
    verts = [p for ring in rings for p in ring]
    faces = []
    for r in range(len(rings) - 1):
        for j in range(n):
            faces.append((r * n + j, r * n + (j + 1) % n, (r + 1) * n + (j + 1) % n, (r + 1) * n + j))
    for end, ring_index in [(caps[0], 0), (caps[1], len(rings) - 1)]:
        if not end:
            continue
        centre = sum((Vector(p) for p in rings[ring_index]), Vector()) / n
        verts.append(centre)
        c = len(verts) - 1
        for j in range(n):
            faces.append((ring_index * n + j, ring_index * n + (j + 1) % n, c))
    return verts, faces


class Stack:
    """Horizontal elliptical sections (cx, cy, z, rx, ry), interpolated linearly in z."""

    def __init__(self, sections):
        self.sections = sorted(sections, key=lambda item: item[2])

    def at(self, z):
        s = self.sections
        z = clamp(z, s[0][2], s[-1][2])
        for i in range(len(s) - 1):
            if z <= s[i + 1][2]:
                break
        t = (z - s[i][2]) / max(1e-9, s[i + 1][2] - s[i][2])
        return [s[i][k] + (s[i + 1][k] - s[i][k]) * t for k in (0, 1, 3, 4)]

    def point(self, theta, z, d=0.0):
        cx, cy, rx, ry = self.at(z)
        return Vector((cx + (rx + d) * math.cos(theta), cy + (ry + d) * math.sin(theta), z))

    def side(self, x, z, d=0.0, back=False):
        """Point on the front (or back) half at lateral position x."""
        cx, cy, rx, ry = self.at(z)
        q = clamp((x - cx) / (rx + d), -1.0, 1.0)
        y = (ry + d) * math.sqrt(1 - q * q)
        return Vector((x, cy - y if back else cy + y, z))

    def mesh(self, segments, extra_z=()):
        heights = sorted(set([s[2] for s in self.sections] + list(extra_z)))
        rings = [[self.point(2 * math.pi * j / segments, z) for j in range(segments)] for z in heights]
        return loft(rings)


class Sweep:
    """Elliptical tube along a jointed path with rotation-minimising frames.

    stations: (s, ru, rv) with s the arc length from the path start (negative extends backwards).
    u follows `up` projected off the tangent; v = tangent x u."""

    def __init__(self, path, stations, up, blend=0.05):
        self.path = [Vector(p) for p in path]
        self.lengths = [0.0]
        for a, b in zip(self.path, self.path[1:]):
            self.lengths.append(self.lengths[-1] + (b - a).length)
        self.blend = blend
        self.stations = []
        u = None
        previous_t = None
        for s, ru, rv in stations:
            centre, t = self.centre(s), self.tangent(s)
            if u is None:
                u = (Vector(up) - t * Vector(up).dot(t)).normalized()
            else:
                u = previous_t.rotation_difference(t) @ u
                u = (u - t * u.dot(t)).normalized()
            previous_t = t
            self.stations.append((s, centre, t, u.copy(), t.cross(u).normalized(), ru, rv))

    def segment(self, s):
        for i in range(len(self.path) - 1):
            if s <= self.lengths[i + 1] or i == len(self.path) - 2:
                return i

    def centre(self, s):
        i = self.segment(s)
        a, b = self.path[i], self.path[i + 1]
        return a + (b - a).normalized() * (s - self.lengths[i])

    def tangent(self, s):
        i = self.segment(s)
        direction = (self.path[i + 1] - self.path[i]).normalized()
        for j in range(1, len(self.path) - 1):
            joint = self.lengths[j]
            if abs(s - joint) < self.blend:
                before = (self.path[j] - self.path[j - 1]).normalized()
                after = (self.path[j + 1] - self.path[j]).normalized()
                direction = before.lerp(after, smoothstep(joint - self.blend, joint + self.blend, s)).normalized()
        return direction

    def frame(self, s):
        """Interpolated (centre, tangent, u, v, ru, rv); continues straight past either end."""
        st = self.stations
        if s <= st[0][0] or s >= st[-1][0]:
            end = st[0] if s <= st[0][0] else st[-1]
            return (end[1] + end[2] * (s - end[0]),) + tuple(end[2:])
        for i in range(len(st) - 1):
            if s <= st[i + 1][0]:
                t = (s - st[i][0]) / (st[i + 1][0] - st[i][0])
                a, b = st[i], st[i + 1]
                return (a[1].lerp(b[1], t), a[2].lerp(b[2], t).normalized(), a[3].lerp(b[3], t).normalized(),
                        a[4].lerp(b[4], t).normalized(), a[5] + (b[5] - a[5]) * t, a[6] + (b[6] - a[6]) * t)
        return st[-1][1:]

    def point(self, theta, s, d=0.0):
        centre, _, u, v, ru, rv = self.frame(s)
        return centre + u * ((ru + d) * math.cos(theta)) + v * ((rv + d) * math.sin(theta))

    def theta(self, s, direction):
        _, _, u, v, _, _ = self.frame(s)
        direction = Vector(direction)
        return math.atan2(direction.dot(v), direction.dot(u))

    def mesh(self, segments, caps=(True, True)):
        rings = [[self.point(2 * math.pi * j / segments, s) for j in range(segments)] for s, *_ in self.stations]
        return loft(rings, caps)


def patch(name, surface, span, rows, columns, d_in, d_out, material, weights, pillow=0.5, kind='atlas', sharp=55, wrap=False):
    """A closed padded panel on a parametric surface.

    surface(u, v, d) -> point; span(v) -> (u0, u1); rows: v values. The outer face sits at d_out in
    the middle and falls towards d_in by `pillow` at the borders, like stitched padding."""
    verts, faces = [], []
    nr, nc = len(rows), columns
    for side in ('outer', 'inner'):
        for i, v in enumerate(rows):
            u0, u1 = span(v)
            for j in range(nc):
                uu = j / (nc - 1) if not wrap else j / nc
                u = u0 + (u1 - u0) * uu
                if side == 'outer':
                    edge_u = 1.0 if wrap else 1 - abs(2 * uu - 1) ** 3
                    edge_v = 1 - abs(2 * i / (nr - 1) - 1) ** 3
                    d = d_in + (d_out - d_in) * (1 - pillow * (1 - min(edge_u, edge_v)))
                else:
                    d = d_in
                verts.append(surface(u, v, d))
    o, n_in = 0, nr * nc
    cols = nc if wrap else nc - 1
    for i in range(nr - 1):
        for j in range(cols):
            a, b = i * nc + j, i * nc + (j + 1) % nc
            c, d = (i + 1) * nc + (j + 1) % nc, (i + 1) * nc + j
            faces.append((o + a, o + b, o + c, o + d))
            faces.append((n_in + d, n_in + c, n_in + b, n_in + a))
    for j in range(cols):
        for i in (0, nr - 1):
            a, b = i * nc + j, i * nc + (j + 1) % nc
            faces.append((o + a, n_in + a, n_in + b, o + b))
    if not wrap:
        for i in range(nr - 1):
            for j in (0, nc - 1):
                a, b = i * nc + j, (i + 1) * nc + j
                faces.append((o + a, o + b, n_in + b, n_in + a))
    return build(name, verts, faces, material, weights, kind, True, sharp)


def strap(name, points, width, thickness, outward, material, weights, kind='atlas'):
    """Flat band along an open path; outward(point) gives the band's face normal."""
    points = [Vector(p) for p in points]
    rings = []
    for i, p in enumerate(points):
        a, b = points[max(0, i - 1)], points[min(len(points) - 1, i + 1)]
        t = (b - a).normalized()
        n = Vector(outward(p)); n = (n - t * n.dot(t)).normalized()
        w = t.cross(n).normalized()
        rings.append([p + w * width / 2, p + w * width / 2 + n * thickness, p - w * width / 2 + n * thickness, p - w * width / 2])
    verts, faces = loft(rings)
    return build(name, verts, faces, material, weights, kind, True, 50)


def tube(name, points, radii, material, weights, segments=10, kind='atlas', caps=(True, True), up=(0, 0, 1)):
    points = [Vector(p) for p in points]
    lengths = [0.0]
    for a, b in zip(points, points[1:]):
        lengths.append(lengths[-1] + (b - a).length)
    if isinstance(radii, (int, float)):
        radii = [radii] * len(points)
    sweep = Sweep(points, [(s, r, r) for s, r in zip(lengths, radii)], up, blend=0.0001)
    verts, faces = sweep.mesh(segments, caps)
    return build(name, verts, faces, material, weights, kind, True, 60)


# ---------------------------------------------------------------------------------------------
# Skin weights.
def torso_weights(co):
    z = co.z
    chest = clamp((z - 1.22) / 0.22, 0, 1)
    pelvis = clamp((1.13 - z) / 0.17, 0, 0.6)
    return {'spine': 1 - chest - pelvis, 'chest': chest, 'pelvis': pelvis}


def neck_weights(co):
    neck = smoothstep(1.47, 1.53, co.z)
    head = smoothstep(1.575, 1.61, co.z) * 0.6
    return {'chest': 1 - neck, 'neck': neck - head, 'head': head}


def limb_weights(sweep, upper, lower, joint_s, top_bone=None, top_span=0.0, top_weight=0.0, half=0.05):
    """Blend upper -> lower across the joint, and optionally share the top rings with the parent."""
    def weights(co):
        s = nearest_s(sweep, co)
        low = smoothstep(joint_s - half, joint_s + half, s)
        out = {upper: 1 - low, lower: low}
        if top_bone and s < top_span:
            share = top_weight * (1 - s / top_span) ** 2
            out = {k: w * (1 - share) for k, w in out.items()}
            out[top_bone] = out.get(top_bone, 0) + share
        return out
    return weights


def nearest_s(sweep, co):
    best, best_d = 0.0, 1e9
    for s, centre, t, *_ in sweep.stations:
        d = abs((co - centre).dot(t)) + 0.25 * ((co - centre) - t * (co - centre).dot(t)).length
        if d < best_d:
            best, best_d = s + (co - centre).dot(t), d
    return best


# ---------------------------------------------------------------------------------------------
# Body: combat shirt torso, trousers, sleeves.
TORSO = Stack([(0, -0.008, 1.00, 0.160, 0.110), (0, -0.009, 1.10, 0.165, 0.118), (0, -0.005, 1.20, 0.188, 0.134),
               (0, 0.0, 1.33, 0.216, 0.141), (0, -0.004, 1.415, 0.222, 0.131), (0, -0.004, 1.455, 0.230, 0.123),
               (0, -0.008, 1.494, 0.156, 0.105), (0, -0.011, 1.524, 0.090, 0.078)])
verts, faces = TORSO.mesh(28, extra_z=(1.05, 1.15, 1.26, 1.375))
build('combat_shirt', verts, faces, M['shirt'], torso_weights)
PELVIS = Stack([(0, 0.0, 0.815, 0.148, 0.108), (0, 0.0, 0.90, 0.178, 0.121), (0, 0.0, 0.99, 0.175, 0.119), (0, -0.004, 1.06, 0.166, 0.113)])
verts, faces = PELVIS.mesh(26)
build('trouser_seat', verts, faces, M['uniform'], lambda co: {'pelvis': 1.0} if co.z > 0.86 else {'pelvis': 0.8, 'thigh_r' if co.x > 0 else 'thigh_l': 0.2})

LEGS, ARMS = {}, {}
for side, sign in (('r', 1), ('l', -1)):
    hip, knee = REST['thigh_' + side][0], REST['shin_' + side][0]
    ankle = REST['foot_' + side][0]
    top = hip + Vector((0, 0, 0.05))
    path = [top, hip, knee, ankle]
    knee_s = (hip - top).length + (knee - hip).length
    # (s, lateral radius, front-back radius): loose field trousers bloused over the boot tops.
    stations = [(0.0, 0.110, 0.104), (0.05, 0.112, 0.106), (0.12, 0.110, 0.104), (0.22, 0.104, 0.098), (0.31, 0.096, 0.091),
                (0.38, 0.088, 0.085), (knee_s - 0.035, 0.080, 0.081), (knee_s, 0.078, 0.081), (knee_s + 0.04, 0.074, 0.077),
                (knee_s + 0.11, 0.077, 0.081), (knee_s + 0.19, 0.075, 0.077), (knee_s + 0.255, 0.073, 0.073),
                (knee_s + 0.30, 0.076, 0.076), (knee_s + 0.322, 0.075, 0.075)]
    leg = Sweep(path, stations, (sign, 0, 0))
    LEGS[side] = (leg, knee_s)
    verts, faces = leg.mesh(20)
    build('trouser_leg_' + side, verts, faces, M['uniform'],
          limb_weights(leg, 'thigh_' + side, 'shin_' + side, knee_s, 'pelvis', 0.11, 0.55, half=0.05))

    shoulder, elbow, wrist = REST['upper_arm_' + side][0], REST['forearm_' + side][0], REST['hand_' + side][0]
    upper_length, fore_length = (elbow - shoulder).length, (wrist - elbow).length
    path = [shoulder - (elbow - shoulder).normalized() * 0.03, shoulder, elbow, wrist]
    e = 0.03 + upper_length
    stations = [(0.0, 0.074, 0.078), (0.03, 0.083, 0.086), (0.07, 0.085, 0.084), (0.13, 0.080, 0.077), (0.20, 0.072, 0.068),
                (0.26, 0.066, 0.062), (e - 0.03, 0.061, 0.059), (e, 0.059, 0.058), (e + 0.035, 0.058, 0.055),
                (e + 0.09, 0.056, 0.051), (e + 0.15, 0.051, 0.046), (e + 0.205, 0.047, 0.043), (e + 0.225, 0.046, 0.042)]
    arm = Sweep(path, stations, (0, 0, 1))
    ARMS[side] = (arm, e)
    verts, faces = arm.mesh(18)
    build('sleeve_' + side, verts, faces, M['shirt'],
          limb_weights(arm, 'upper_arm_' + side, 'forearm_' + side, e, 'chest', 0.09, 0.45, half=0.045))

# ---------------------------------------------------------------------------------------------
# Legs: knee pads, cargo pockets; boots with the scout's exact sole so ground contact is unchanged.
for side, sign in (('r', 1), ('l', -1)):
    leg, knee_s = LEGS[side]
    front = leg.theta(knee_s, (0, 1, 0))
    patch('knee_pad_' + side, lambda u, v, d, leg=leg: leg.point(u, v, d),
          lambda v, front=front: (front - 1.15, front + 1.15), [knee_s - 0.075 + i * 0.03 for i in range(6)], 9,
          0.004, 0.032, M['nylon'], 'shin_' + side, pillow=0.55)
    patch('knee_cap_' + side, lambda u, v, d, leg=leg: leg.point(u, v, d),
          lambda v, front=front: (front - 0.72, front + 0.72), [knee_s - 0.055 + i * 0.022 for i in range(5)], 7,
          0.030, 0.046, M['polymer'], 'shin_' + side, pillow=0.6)
    for s in (knee_s - 0.095, knee_s + 0.085):
        patch('knee_strap_' + side, lambda u, v, d, leg=leg: leg.point(u, v, d), lambda v: (0, 2 * math.pi),
              [s - 0.012, s + 0.012], 20, 0.001, 0.007, M['webbing'], 'shin_' + side if s > knee_s else 'thigh_' + side,
              pillow=0.0, wrap=True)
    outer = leg.theta(0.24, (sign, 0, 0))
    patch('cargo_pocket_' + side, lambda u, v, d, leg=leg: leg.point(u, v, d),
          lambda v, outer=outer: (outer - 0.62, outer + 0.62), [0.16 + i * 0.03 for i in range(6)], 7,
          0.002, 0.030, M['uniform'], 'thigh_' + side, pillow=0.55)
    patch('cargo_flap_' + side, lambda u, v, d, leg=leg: leg.point(u, v, d),
          lambda v, outer=outer: (outer - 0.66, outer + 0.66), [0.145 + i * 0.016 for i in range(4)], 7,
          0.026, 0.036, M['uniform'], 'thigh_' + side, pillow=0.4)

    # Sole, heel and tread match generate_scout.py so the boots meet the floor where the gait expects.
    def taper(co, sign=sign):
        y = co.y
        factor = 0.86 if y < -0.028 else 1 - 0.08 * max(0, (y - 0.12) / 0.075)
        return Vector((sign * 0.12 + (co.x - sign * 0.12) * factor, y, co.z + 0.008 * max(0, (y - 0.13) / 0.065)))
    rounded_box('boot_sole_' + side, (sign * 0.12, 0.057, 0.032), (0.127, 0.273, 0.047), 0.011, M['rubber'], 'foot_' + side, segments=2, deform=taper)
    # Lugs keep the scout's lowest point (z = 7 mm) but sit inside the sole outline.
    for y, width in ((-0.05, 0.094), (0.0, 0.104), (0.055, 0.11), (0.11, 0.11), (0.175, 0.098)):
        rounded_box('boot_lug_' + side, (sign * 0.12, y, 0.014), (width, 0.016, 0.014), 0.003, M['rubber'], 'foot_' + side, segments=1)
    verts, faces = Stack([(sign * 0.12, -0.031, 0.043, 0.054, 0.056), (sign * 0.12, -0.035, 0.09, 0.057, 0.061),
                          (sign * 0.12, -0.024, 0.13, 0.051, 0.054)]).mesh(20)
    build('boot_heel_' + side, verts, faces, M['suede'], 'foot_' + side)
    verts, faces = Stack([(sign * 0.12, 0.058, 0.046, 0.061, 0.124), (sign * 0.12, 0.060, 0.082, 0.060, 0.119),
                          (sign * 0.12, 0.034, 0.117, 0.056, 0.094), (sign * 0.12, -0.004, 0.158, 0.048, 0.057)]).mesh(22)
    build('boot_upper_' + side, verts, faces, M['suede'], 'foot_' + side)
    rounded_box('boot_toe_' + side, (sign * 0.12, 0.139, 0.07), (0.108, 0.08, 0.048), 0.02, M['rubber'], 'foot_' + side, segments=3)
    verts, faces = Stack([(sign * 0.12, -0.012, 0.10, 0.057, 0.062), (sign * 0.12, -0.010, 0.17, 0.055, 0.058),
                          (sign * 0.12, -0.010, 0.215, 0.057, 0.059), (sign * 0.12, -0.010, 0.238, 0.061, 0.063)]).mesh(20)
    build('boot_shaft_' + side, verts, faces, M['suede'],
          lambda co, side=side: {'foot_' + side: 1 - 0.75 * smoothstep(0.15, 0.235, co.z), 'shin_' + side: 0.75 * smoothstep(0.15, 0.235, co.z)})
    rounded_box('boot_tongue_' + side, (sign * 0.12, 0.045, 0.165), (0.05, 0.018, 0.11), 0.008, M['suede'], 'foot_' + side,
                rotation=Matrix.Rotation(math.radians(-18), 4, 'X'))
    for i, z in enumerate((0.118, 0.142, 0.166, 0.19, 0.214)):
        rounded_box('boot_lace_' + side, (sign * 0.12, 0.056 - i * 0.004, z), (0.056, 0.008, 0.007), 0.002, M['webbing'], 'foot_' + side, segments=1)
    patch('boot_collar_' + side, lambda u, v, d, sign=sign: Stack([(sign * 0.12, -0.010, 0.215, 0.057, 0.059), (sign * 0.12, -0.010, 0.245, 0.061, 0.063)]).point(u, v, d),
          lambda v: (0, 2 * math.pi), [0.222, 0.233, 0.244], 20, 0.0, 0.008, M['rubber'], 'shin_' + side, pillow=0.0, wrap=True)

# ---------------------------------------------------------------------------------------------
# Arms: shoulder pockets with a team patch, armbands, gloves.
for side, sign in (('r', 1), ('l', -1)):
    arm, e = ARMS[side]
    outer = arm.theta(0.11, (sign, 0, 0.25))
    patch('shoulder_pocket_' + side, lambda u, v, d, arm=arm: arm.point(u, v, d),
          lambda v, outer=outer: (outer - 0.78, outer + 0.78), [0.055 + i * 0.024 for i in range(5)], 8,
          0.003, 0.016, M['shirt'], 'upper_arm_' + side, pillow=0.5)
    patch('shoulder_velcro_' + side, lambda u, v, d, arm=arm: arm.point(u, v, d),
          lambda v, outer=outer: (outer - 0.62, outer + 0.62), [0.062 + i * 0.019 for i in range(5)], 7,
          0.012, 0.019, M['velcro'], 'upper_arm_' + side, pillow=0.2)
    patch('shoulder_patch_' + side, lambda u, v, d, arm=arm: arm.point(u, v, d),
          lambda v, outer=outer: (outer - 0.5, outer + 0.5), [0.07 + i * 0.0155 for i in range(4)], 6,
          0.017, 0.022, accent_material, 'upper_arm_' + side, pillow=0.1, kind='accent')
    patch('armband_' + side, lambda u, v, d, arm=arm: arm.point(u, v, d), lambda v: (0, 2 * math.pi),
          [0.168, 0.188, 0.208], 22, 0.002, 0.0075, accent_material, 'upper_arm_' + side, pillow=0.0, kind='accent', wrap=True)
    patch('glove_cuff_' + side, lambda u, v, d, arm=arm: arm.point(u, v, d), lambda v: (0, 2 * math.pi),
          [e + 0.19, e + 0.22, e + 0.25, e + 0.282], 16, 0.002, 0.012, M['glove'],
          lambda co, side=side: {'forearm_' + side: 0.6, 'hand_' + side: 0.4}, pillow=0.0, wrap=True)

    wrist, tip = REST['hand_' + side]
    palm = (wrist + tip) / 2
    hand = 'hand_' + side
    rounded_box('glove_palm_' + side, palm + Vector((0, -0.004, -0.004)), (0.088, 0.096, 0.058), 0.026, M['glove'], hand, segments=3)
    rounded_box('glove_knuckle_guard_' + side, palm + Vector((0, 0.016, 0.026)), (0.074, 0.046, 0.016), 0.007, M['rubber'], hand, segments=2)
    rounded_box('glove_back_' + side, palm + Vector((0, -0.022, 0.024)), (0.07, 0.05, 0.012), 0.005, M['polymer'], hand, segments=1)
    for f in range(4):
        start = tip + Vector(((f - 1.5) * 0.018, -0.012, 0.002))
        middle = start + Vector((0, 0.026, 0.012 if side == 'l' else -0.015))
        end = middle + Vector((0, -0.002, 0.021 if side == 'l' else -0.027))
        tube('glove_finger_' + side, [start, middle, end], [0.0105, 0.0095, 0.0078], M['glove'], hand, segments=8)
    tube('glove_thumb_' + side, [palm + Vector((-sign * 0.036, 0.0, 0.0)), palm + Vector((-sign * 0.03, 0.022, -0.012)), palm + Vector((-sign * 0.024, 0.04, -0.028))],
         [0.0135, 0.012, 0.010], M['glove'], hand, segments=9)

# ---------------------------------------------------------------------------------------------
# Plate carrier: front and back plate bags shaped to the torso, cummerbund, shoulder straps,
# magazine and admin pouches, back panel, radio. Weighted like the shirt beneath it.
def plate_span(z, bottom, top, width, cut=0.06, cut_depth=0.065):
    corner = 0.025
    w = width
    if z > top - cut:
        w -= cut_depth * smoothstep(top - cut, top, z) ** 0.8
    if z < bottom + corner:
        w -= corner * (1 - math.sqrt(max(0.0, 1 - ((bottom + corner - z) / corner) ** 2)))
    return (-w, w)


def rows(bottom, top, count):
    return [bottom + (top - bottom) * i / (count - 1) for i in range(count)]


patch('plate_front', lambda u, v, d: TORSO.side(u, v, d), lambda v: plate_span(v, 1.125, 1.455, 0.148), rows(1.125, 1.455, 12), 13,
      0.008, 0.048, M['carrier'], torso_weights, pillow=0.45)
patch('plate_back', lambda u, v, d: TORSO.side(u, v, d, back=True), lambda v: plate_span(v, 1.115, 1.475, 0.152, cut=0.05, cut_depth=0.05), rows(1.115, 1.475, 12), 13,
      0.008, 0.05, M['carrier'], torso_weights, pillow=0.45)
for side, sign in (('r', 1), ('l', -1)):
    # Cummerbund from the front bag's side edge around to the back bag's side edge.
    front_edge, back_edge = math.radians(42), math.radians(-40)
    if sign < 0:
        front_edge, back_edge = math.pi - front_edge, math.pi - back_edge
    patch('cummerbund_' + side, lambda u, v, d: TORSO.point(u, v, d),
          lambda v, a=front_edge, b=back_edge: (min(a, b), max(a, b)), rows(1.10, 1.30, 7), 11, 0.004, 0.022, M['carrier'], torso_weights, pillow=0.35)
    # Padded shoulder straps over the trapezius, front bag to back bag.
    x = sign * 0.112
    path = [TORSO.side(x, 1.43, 0.042), TORSO.side(x * 1.02, 1.47, 0.03), Vector((x * 1.05, 0.062, 1.502)), Vector((x * 1.06, 0.0, 1.516)),
            Vector((x * 1.05, -0.062, 1.503)), TORSO.side(x * 1.02, 1.475, 0.03, back=True), TORSO.side(x, 1.44, 0.044, back=True)]
    strap('shoulder_strap_' + side, path, 0.062, 0.016, lambda p: Vector((p.x * 0.4, p.y, max(0.0, p.z - 1.45) * 4.0)), M['carrier'], 'chest')
    # Radio and utility pouches ride on the cummerbund.
radio_centre = TORSO.point(math.radians(212), 1.205, 0.045)
rounded_box('radio_pouch', radio_centre, (0.05, 0.075, 0.135), 0.012, M['nylon'], torso_weights,
            rotation=Matrix.Rotation(math.radians(32), 4, 'Z'))
tube('radio_antenna', [radio_centre + Vector((0.004, -0.012, 0.07)), radio_centre + Vector((-0.004, -0.03, 0.2)),
                       radio_centre + Vector((-0.012, -0.055, 0.33)), radio_centre + Vector((-0.016, -0.075, 0.41))],
     [0.0065, 0.0045, 0.0035, 0.003], M['polymer'], 'chest', segments=6)
rounded_box('utility_pouch', TORSO.point(math.radians(-18), 1.19, 0.04), (0.055, 0.085, 0.11), 0.012, M['coyote'], torso_weights,
            rotation=Matrix.Rotation(math.radians(-18), 4, 'Z'))

# Triple magazine pouch (closed flaps) on the lower front; admin pouch with a velcro patch above.
for i, x in enumerate((-0.081, 0.0, 0.081)):
    base = TORSO.side(x, 1.17, 0.048)
    rounded_box('mag_pouch', base + Vector((0, 0.022, 0)), (0.074, 0.046, 0.13), 0.012, M['coyote'], torso_weights, segments=2)
    rounded_box('mag_flap', base + Vector((0, 0.026, 0.06)), (0.078, 0.052, 0.034), 0.008, M['coyote'], torso_weights, segments=2,
                rotation=Matrix.Rotation(math.radians(-8), 4, 'X'))
    rounded_box('mag_flap_tab', base + Vector((0, 0.054, 0.045)), (0.024, 0.006, 0.03), 0.002, M['webbing'], torso_weights, segments=1)
admin = TORSO.side(0.0, 1.35, 0.048) + Vector((0, 0.014, 0))
rounded_box('admin_pouch', admin, (0.17, 0.03, 0.09), 0.012, M['carrier'], torso_weights, segments=2)
rounded_box('admin_velcro', admin + Vector((0, 0.016, 0.004)), (0.13, 0.004, 0.064), 0.002, M['velcro'], torso_weights, segments=1)
rounded_box('chest_patch', admin + Vector((0.03, 0.019, 0.006)), (0.06, 0.004, 0.04), 0.0015, accent_material, torso_weights, segments=1, kind='accent')

# Back: flat assault panel, team panel and drag handle.
panel_centre = TORSO.side(0.0, 1.29, 0.05, back=True) + Vector((0, -0.024, 0))
rounded_box('back_panel', panel_centre, (0.24, 0.05, 0.28), 0.02, M['carrier'], torso_weights, segments=3,
            deform=lambda co: Vector((co.x, co.y + 0.18 * co.x * co.x, co.z)))
rounded_box('back_panel_zip', panel_centre + Vector((0, -0.026, 0.0)), (0.008, 0.004, 0.25), 0.0015, M['polymer'], torso_weights, segments=1)
rounded_box('back_patch', panel_centre + Vector((0, -0.027, 0.098)), (0.105, 0.005, 0.064), 0.002, accent_material, torso_weights, segments=1, kind='accent')
top = TORSO.side(0.0, 1.47, 0.05, back=True)
strap('drag_handle', [top + Vector((-0.05, 0.0, -0.01)), top + Vector((-0.045, -0.02, 0.03)), top + Vector((0.0, -0.028, 0.045)),
                      top + Vector((0.045, -0.02, 0.03)), top + Vector((0.05, 0.0, -0.01))], 0.026, 0.006,
      lambda p: Vector((0, -1, 0.6)), M['webbing'], 'chest')

# ---------------------------------------------------------------------------------------------
# Battle belt with pouches.
patch('battle_belt', lambda u, v, d: PELVIS.point(u, v, d), lambda v: (0, 2 * math.pi), [0.985, 1.015, 1.045], 32,
      0.012, 0.030, M['nylon'], 'pelvis', pillow=0.2, wrap=True)
rounded_box('belt_buckle', PELVIS.side(0.0, 1.015, 0.032), (0.07, 0.016, 0.048), 0.006, M['metal'], 'pelvis', segments=2)
for x, colour in ((0.105, 'coyote'), (-0.105, 'nylon')):
    p = PELVIS.side(x, 1.0, 0.03)
    rounded_box('belt_pouch', p + Vector((0, 0.022, -0.02)), (0.06, 0.04, 0.085), 0.01, M[colour], 'pelvis', segments=2,
                rotation=Matrix.Rotation(math.radians(-math.degrees(math.atan2(x, 0.3))), 4, 'Z'))
rounded_box('dump_pouch', PELVIS.side(0.10, 0.975, 0.03, back=True) + Vector((0.01, -0.035, 0)), (0.11, 0.06, 0.12), 0.024, M['nylon'], 'pelvis', segments=3,
            rotation=Matrix.Rotation(math.radians(25), 4, 'Z'))
rounded_box('med_pouch', PELVIS.side(-0.07, 0.99, 0.03, back=True) + Vector((0, -0.028, 0)), (0.12, 0.05, 0.085), 0.016, M['coyote'], 'pelvis', segments=2,
            rotation=Matrix.Rotation(math.radians(-18), 4, 'Z'))
rounded_box('med_handle', PELVIS.side(-0.07, 0.99, 0.03, back=True) + Vector((0, -0.056, 0.0)), (0.05, 0.006, 0.018), 0.002, M['webbing'], 'pelvis', segments=1,
            rotation=Matrix.Rotation(math.radians(-18), 4, 'Z'))

# ---------------------------------------------------------------------------------------------
# Head: neck gaiter, knit balaclava, ballistic glasses, headset and a high-cut helmet.
verts, faces = Stack([(0, -0.004, 1.465, 0.080, 0.076), (0, 0.004, 1.545, 0.066, 0.064), (0, 0.012, 1.60, 0.058, 0.058)]).mesh(18)
build('neck', verts, faces, M['knit'], neck_weights)
# A scarf-weight wrap pulled up over the nose and bunched at the collar; folds deepen towards the neck.
# The throat is drawn in under a clear chin so the covered face keeps a jawline.
WRAP = Stack([(0, -0.004, 1.462, 0.091, 0.087), (0, -0.004, 1.50, 0.083, 0.079), (0, 0.002, 1.545, 0.075, 0.073),
              (0, 0.021, 1.588, 0.079, 0.093), (0, 0.017, 1.615, 0.083, 0.101), (0, 0.010, 1.645, 0.087, 0.107),
              (0, 0.006, 1.672, 0.088, 0.109), (0, 0.004, 1.687, 0.087, 0.108)])


def wrap_weights(co):
    head = smoothstep(1.555, 1.60, co.z)
    neck = smoothstep(1.47, 1.53, co.z) * (1 - head)
    return {'chest': 1 - neck - head, 'neck': neck, 'head': head}


def wrap_surface(u, v, d):
    folds = 0.007 * math.sin(7 * u + v * 48) * smoothstep(1.63, 1.50, v)
    nose = 0.011 * math.exp(-((u - math.pi / 2) / 0.2) ** 2) * math.exp(-((v - 1.668) / 0.022) ** 2)
    return WRAP.point(u, v, d + folds + nose)


patch('face_wrap', wrap_surface, lambda v: (0, 2 * math.pi),
      [1.47, 1.485, 1.50, 1.522, 1.545, 1.565, 1.578, 1.588, 1.60, 1.615, 1.63, 1.645, 1.66, 1.672, 1.687], 28,
      -0.008, 0.0, M['wrap'], wrap_weights, pillow=0.0, wrap=True)
# Rolled hem along the top edge of the wrap, just under the glasses.
patch('face_wrap_hem', lambda u, v, d: WRAP.point(u, v, d + 0.012 * math.exp(-((u - math.pi / 2) / 0.2) ** 2) * math.exp(-((v - 1.668) / 0.022) ** 2)),
      lambda v: (0, 2 * math.pi), [1.676, 1.681, 1.686, 1.69], 28, -0.002, 0.006, M['wrap'], wrap_weights, pillow=0.0, wrap=True)
# Mandarin collar of the combat shirt around the base of the wrap.
COLLAR = Stack([(0, -0.006, 1.468, 0.101, 0.096), (0, -0.004, 1.50, 0.098, 0.093), (0, -0.002, 1.528, 0.096, 0.091)])
patch('shirt_collar', lambda u, v, d: COLLAR.point(u, v, d), lambda v: (0, 2 * math.pi), [1.468, 1.485, 1.50, 1.515, 1.528], 28,
      -0.007, 0.0, M['shirt'], wrap_weights, pillow=0.0, wrap=True)
HEAD = Stack([(0, 0.034, 1.575, 0.038, 0.036), (0, 0.028, 1.59, 0.060, 0.066), (0, 0.017, 1.615, 0.071, 0.086),
              (0, 0.009, 1.645, 0.076, 0.096), (0, 0.004, 1.675, 0.079, 0.101), (0, 0.000, 1.705, 0.080, 0.103),
              (0, -0.004, 1.735, 0.080, 0.102), (0, -0.008, 1.765, 0.076, 0.096), (0, -0.012, 1.790, 0.065, 0.082),
              (0, -0.014, 1.808, 0.045, 0.057), (0, -0.015, 1.818, 0.012, 0.016)])
verts, faces = HEAD.mesh(24, extra_z=(1.69, 1.72))
build('balaclava', verts, faces, M['knit'], 'head')
# Wraparound ballistic lens and frame; the lower edge lifts over the bridge of the nose.
def lens_surface(u, v, d):
    off = u - math.pi / 2
    bottom = 1.686 + 0.011 * math.exp(-(off / 0.11) ** 2) + 0.006 * (abs(off) / 0.98) ** 2
    top = 1.721 - 0.003 * (abs(off) / 0.98) ** 2
    return HEAD.point(u, bottom + (top - bottom) * v, d)


patch('glasses_lens', lens_surface, lambda v: (math.pi / 2 - 0.98, math.pi / 2 + 0.98), [0.0, 0.34, 0.67, 1.0], 25,
      0.013, 0.017, lens_material, 'head', pillow=0.0, kind='lens', sharp=80)
patch('glasses_brow', lambda u, v, d: HEAD.point(u, v, d), lambda v: (math.pi / 2 - 1.02, math.pi / 2 + 1.02),
      rows(1.719, 1.728, 2), 16, 0.011, 0.02, M['polymer'], 'head', pillow=0.0)
for sign in (1, -1):
    a = math.pi / 2 - sign * 1.0
    tube('glasses_arm', [HEAD.point(a, 1.722, 0.016), HEAD.point(a - sign * 0.5, 1.72, 0.012), HEAD.point(a - sign * 1.0, 1.715, 0.006)],
         0.0028, M['polymer'], 'head', segments=6)
# Headset ear cups below the helmet's high cut, with a boom microphone on the left.
for sign in (1, -1):
    centre = Vector((sign * 0.086, -0.006, 1.69))
    verts, faces = Stack([(0, 0, -0.016, 0.044, 0.046), (0, 0, 0.0, 0.046, 0.048), (0, 0, 0.018, 0.043, 0.045), (0, 0, 0.026, 0.036, 0.038)]).mesh(18)
    rotation = Matrix.Rotation(math.radians(90 * sign), 4, 'Y')
    build('ear_cup', [centre + rotation @ Vector(v) for v in verts], faces, M['polymer'], 'head')
    verts, faces = Stack([(0, 0, -0.02, 0.046, 0.048), (0, 0, -0.008, 0.049, 0.051), (0, 0, 0.0, 0.047, 0.049)]).mesh(18)
    build('ear_seal', [centre + rotation @ Vector(v) for v in verts], faces, M['rubber'], 'head')
mic_root = Vector((-0.112, 0.012, 1.672))
tube('boom_mic', [mic_root, mic_root + Vector((0.012, 0.045, -0.02)), mic_root + Vector((0.04, 0.085, -0.04)), Vector((-0.04, 0.108, 1.628))],
     [0.0045, 0.0035, 0.0032, 0.0032], M['polymer'], 'head', segments=6)
rounded_box('boom_mic_foam', (-0.034, 0.112, 1.627), (0.022, 0.016, 0.014), 0.006, M['knit'], 'head', segments=2)

HELMET_C = Vector((0.0, 0.004, 1.700))
HELMET_R = Vector((0.121, 0.129, 0.150))
RIM = [(0, 1.744), (40, 1.739), (75, 1.742), (105, 1.741), (128, 1.712), (152, 1.68), (180, 1.668)]


def rim_height(alpha):
    """Rim height around the helmet: alpha in degrees from the front, high cut over the ears."""
    a = abs((math.degrees(alpha) + 180) % 360 - 180)
    for (a0, z0), (a1, z1) in zip(RIM, RIM[1:]):
        if a <= a1:
            return z0 + (z1 - z0) * smoothstep(a0, a1, a)
    return RIM[-1][1]


def helmet_point(alpha, phi, d=0.0):
    """alpha: azimuth from the front (+Y), positive to the left (-X); phi: polar angle from the top."""
    r = HELMET_R + Vector((d, d, d))
    # A slightly squared superellipse crown reads as a modern high-cut shell rather than a bowl.
    s, c = math.sin(phi), math.cos(phi)
    sa, ca = math.sin(alpha), math.cos(alpha)
    k = 2.0 / 2.3
    sx = math.copysign(abs(sa) ** k, sa)
    cy = math.copysign(abs(ca) ** k, ca)
    return HELMET_C + Vector((-r.x * s * sx, r.y * s * cy, r.z * c))


def rim_phi(alpha, d=0.0):
    z = rim_height(alpha)
    return math.acos(clamp((z - HELMET_C.z) / (HELMET_R.z + d), -1, 1))


def helmet_patch(name, a0, a1, phi_rows, d_in, d_out, material, kind='atlas', columns=8, pillow=0.2, sharp=50):
    """phi_rows: callables alpha -> phi (or numbers) from top row to bottom row."""
    def surface(u, v, d):
        phi = v(u) if callable(v) else v
        return helmet_point(u, phi, d)
    return patch(name, surface, lambda v: (a0, a1), phi_rows, columns, d_in, d_out, material, 'head', pillow=pillow, kind=kind, sharp=sharp)


# Shell: outer and inner surfaces joined at the rim; a pole cap at the crown.
shell_columns, shell_rows = 40, 11
verts, faces = [], []
for layer, d in ((0, 0.0), (1, -0.013)):
    verts.append(helmet_point(0, 0, d))
    for i in range(1, shell_rows + 1):
        for j in range(shell_columns):
            alpha = 2 * math.pi * j / shell_columns
            phi = rim_phi(alpha) * (i / shell_rows) ** 0.95
            verts.append(helmet_point(alpha, phi, d))
per_layer = 1 + shell_rows * shell_columns
for layer in (0, 1):
    base = layer * per_layer
    flip = layer == 1
    for j in range(shell_columns):
        a, b = base + 1 + j, base + 1 + (j + 1) % shell_columns
        faces.append((base, b, a) if flip else (base, a, b))
    for i in range(shell_rows - 1):
        for j in range(shell_columns):
            a = base + 1 + i * shell_columns + j
            b = base + 1 + i * shell_columns + (j + 1) % shell_columns
            c, dd = b + shell_columns, a + shell_columns
            faces.append((a, dd, c, b) if flip else (a, b, c, dd))
last = 1 + (shell_rows - 1) * shell_columns
for j in range(shell_columns):
    a, b = last + j, last + (j + 1) % shell_columns
    faces.append((a, b, per_layer + b, per_layer + a))
build('helmet_shell', verts, faces, M['helmet'], 'head', sharp=70)
# Accessory rails above the high cut, front shroud, velcro, counterweight and a team patch.
for sign in (1, -1):
    a0, a1 = sorted((sign * math.radians(58), sign * math.radians(122)))
    helmet_patch('helmet_rail', a0, a1, [lambda a: rim_phi(a) - 0.22, lambda a: rim_phi(a) - 0.12, lambda a: rim_phi(a) - 0.035],
                 -0.004, 0.011, M['polymer'], columns=12, pillow=0.15)
    a0, a1 = sorted((sign * math.radians(64), sign * math.radians(112)))
    helmet_patch('helmet_side_velcro', a0, a1, [lambda a: rim_phi(a) - 0.52, lambda a: rim_phi(a) - 0.40, lambda a: rim_phi(a) - 0.28],
                 -0.002, 0.003, M['velcro'], columns=8, pillow=0.1)
helmet_patch('helmet_shroud', math.radians(-15), math.radians(15), [rim_phi(0) - 0.30, rim_phi(0) - 0.17, rim_phi(0) - 0.05],
             -0.003, 0.012, M['metal'], columns=7, pillow=0.25)
rounded_box('helmet_mount', helmet_point(0, rim_phi(0) - 0.09, 0.014), (0.03, 0.022, 0.026), 0.005, M['metal'], 'head', segments=2)
helmet_patch('helmet_top_velcro', math.radians(-38), math.radians(38), [0.12, 0.28, 0.44], -0.002, 0.003, M['velcro'], columns=8, pillow=0.1)
helmet_patch('helmet_back_velcro', math.radians(146), math.radians(214), [0.72, 0.86, 1.0, 1.12], -0.002, 0.003, M['velcro'], columns=9, pillow=0.1)
helmet_patch('helmet_patch', math.radians(160), math.radians(200), [0.78, 0.88, 0.98, 1.06], 0.002, 0.006, accent_material, kind='accent', columns=7, pillow=0.1)
rounded_box('helmet_counterweight', helmet_point(math.pi, rim_phi(math.pi) - 0.13, 0.016), (0.085, 0.032, 0.045), 0.012, M['nylon'], 'head', segments=2)
for sign in (1, -1):
    points = [helmet_point(sign * a, rim_phi(sign * a) - 0.2 - 0.25 * math.sin((a - 0.6) / 1.9 * math.pi), 0.004) for a in [0.6 + i * 1.9 / 8 for i in range(9)]]
    tube('helmet_bungee', points, 0.0032, M['webbing'], 'head', segments=6)

# ---------------------------------------------------------------------------------------------
# Weapon socket: right palm on the pistol grip, axes aligned with the weapon models
# (Blender +Y forward / +Z up here, which exports as -Z forward / +Y up).
SOCKET_REST = Vector((0.14, 0.336, 1.39))
socket = bpy.data.objects.new('weapon_socket', None)
COLLECTION.objects.link(socket)
socket.empty_display_type = 'ARROWS'
socket.empty_display_size = 0.08
socket.parent = rig
socket.parent_type = 'BONE'
socket.parent_bone = 'hand_r'
bpy.context.view_layer.update()
socket.matrix_world = Matrix.Translation(SOCKET_REST)
bpy.context.view_layer.update()
log(f'parts: atlas {len(PARTS["atlas"])}, accent {len(PARTS["accent"])}, lens {len(PARTS["lens"])}')

# ---------------------------------------------------------------------------------------------
# Authored clips on the scout's conventions (generate_scout.py): every bone keyed with XYZ Euler
# rotation and location; limbs placed with world-space two-bone solves baked into the same 18 bones.
READY_ROTATIONS = {'pelvis': (0, 13, 0), 'spine': (-9, 4, 0), 'chest': (-2, 0, 0), 'neck': (3, 0, 0), 'head': (4, -12, 0)}
READY_LOCATIONS = {'pelvis': (0, -0.050, -0.012)}
foot_points = {}
for side in ('l', 'r'):
    foot_points[side] = []
    for obj in PARTS['atlas']:
        if obj.name.startswith(('boot_sole_' + side, 'boot_lug_' + side, 'boot_toe_' + side, 'boot_heel_' + side, 'boot_upper_' + side)):
            foot_points[side].extend(v.co.copy() for v in obj.data.vertices)


def shared_rule(name, fallback):
    """A posture table from shared/physics.ts, so the low poses follow the shared rules
    (validate_operator.mjs imports the live module and checks the export against it)."""
    try:
        text = (ROOT / 'shared' / 'physics.ts').read_text(encoding='utf-8')
        body = re.search(r'\b' + name + r'\b[^=]*=\s*\{([^}]*)\}', text).group(1)
        values = {key: float(value) for key, value in re.findall(r'(\w+)\s*:\s*([0-9.]+)', body)}
        assert {'stand', 'crouch', 'slide'} <= set(values), values
        return values
    except Exception as error:  # noqa: BLE001  (fall back to the contract numbers)
        log(f'{name} not read from shared/physics.ts ({error}); using {fallback}')
        return fallback


def shared_zones():
    """Hit boxes per posture as (zone, bottom, top, half width), for the review renders only."""
    fallback = {'stand': [('head', 1.45, 1.8, 0.15), ('torso', 0.85, 1.45, 0.3), ('legs', 0.0, 0.85, 0.25)],
                'crouch': [('head', 0.95, 1.25, 0.15), ('torso', 0.5, 0.95, 0.3), ('legs', 0.0, 0.5, 0.28)],
                'slide': [('head', 0.72, 1.0, 0.15), ('torso', 0.35, 0.72, 0.3), ('legs', 0.0, 0.35, 0.3)]}
    try:
        text = (ROOT / 'shared' / 'physics.ts').read_text(encoding='utf-8')
        block = re.search(r'const ZONES\b.*?=\s*\{(.*?)\n\};', text, re.S).group(1)
        zones = {}
        for posture, body in re.findall(r'(\w+):\s*\[(.*?)\],?\s*$', block, re.M):
            zones[posture] = [(zone, float(b), float(t), float(h)) for zone, b, t, h in
                              re.findall(r"\['(\w+)',\s*([0-9.]+),\s*([0-9.]+),\s*([0-9.]+)\]", body)]
        assert all(len(zones.get(posture, [])) == 3 for posture in fallback), zones
        return zones
    except Exception as error:  # noqa: BLE001
        log(f'ZONES not read from shared/physics.ts ({error}); drawing the contract boxes')
        return fallback


POSTURE_HEIGHT = shared_rule('POSTURE_HEIGHT', {'stand': 1.8, 'crouch': 1.25, 'slide': 1.0})
EYE_HEIGHT = shared_rule('EYE_HEIGHT', {'stand': 1.62, 'crouch': 1.12, 'slide': 0.92})
ZONES = shared_zones()
CLIP_POSTURE = {'Idle': 'stand', 'Walk': 'stand', 'Run': 'stand', 'Jump': 'stand', 'Aim': 'stand', 'Fire': 'stand',
                'Reload': 'stand', 'Crouch': 'crouch', 'CrouchWalk': 'crouch', 'Slide': 'slide'}
log(f'posture heights {POSTURE_HEIGHT}, eye heights {EYE_HEIGHT}')


def rigid_on(bone_name):
    """Rest-pose vertices of every part skinned wholly to one bone (fast posed extents)."""
    points = []
    for obj in PARTS['atlas'] + PARTS['accent'] + PARTS['lens']:
        if [group.name for group in obj.vertex_groups] == [bone_name]:
            points.extend(v.co.copy() for v in obj.data.vertices)
    return points


HEAD_POINTS = rigid_on('head')
LENS_POINTS = [v.co.copy() for obj in PARTS['lens'] for v in obj.data.vertices]
KNEE_POINTS = {side: rigid_on('shin_' + side) for side in ('l', 'r')}
ARM = {side: rig.data.bones['upper_arm_' + side].length + rig.data.bones['forearm_' + side].length for side in ('l', 'r')}
SUPPORT_REST = REST['hand_l'][0] - Vector((0.14, 0.336, 1.39))   # left wrist in the weapon socket's frame at rest


def deform(bone_name):
    """Rest-to-posed transform of a bone (the rig object sits at the origin)."""
    return rig.pose.bones[bone_name].matrix @ rig.data.bones[bone_name].matrix_local.inverted()


def head_centre():
    """Skull centre: 11 cm up the head bone from the top of the neck (validate_operator.mjs agrees)."""
    head = rig.pose.bones['head']
    return head.head + (head.tail - head.head).normalized() * 0.11


def head_extent():
    """Posed helmet top, glasses (eye) height and skull centre."""
    bpy.context.view_layer.update()
    matrix = deform('head')
    top = max((matrix @ p).z for p in HEAD_POINTS)
    eye = sum((matrix @ p).z for p in LENS_POINTS) / len(LENS_POINTS)
    return top, eye, head_centre()


def knee_minimum():
    bpy.context.view_layer.update()
    return min(min((deform('shin_' + side) @ p).z for p in KNEE_POINTS[side]) for side in ('l', 'r'))


def fcurves(action):
    for layer in action.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                yield from bag.fcurves


def set_pose(name, frame):
    action = clips[name][0]
    rig.animation_data.action = action
    if action.slots:
        rig.animation_data.action_slot = action.slots[0]
    scene.frame_set(int(frame), subframe=frame % 1)
    bpy.context.view_layer.update()


rig.animation_data.action = None
for pose_bone in rig.pose.bones:
    pose_bone.rotation_euler = (0, 0, 0); pose_bone.location = (0, 0, 0)
REST_TOP, REST_EYE, REST_CENTRE = head_extent()
TOP_ABOVE_CENTRE, EYE_ABOVE_CENTRE = REST_TOP - REST_CENTRE.z, REST_EYE - REST_CENTRE.z
# Idle holds the weapon level at this offset from the middle of the shoulders; the left arm is then
# about 96% straight, its elbow bent 144-149 degrees.
set_pose('Idle', 1)
IDLE_SHOULDERS = (rig.pose.bones['upper_arm_l'].head + rig.pose.bones['upper_arm_r'].head) / 2
IDLE_HOLD = rig.pose.bones['hand_r'].head - IDLE_SHOULDERS
IDLE_REACH = {side: (rig.pose.bones['hand_' + side].head - rig.pose.bones['upper_arm_' + side].head).length / ARM[side] for side in ('l', 'r')}
rig.animation_data.action = None
log(f'helmet top {TOP_ABOVE_CENTRE:.3f} m and glasses {EYE_ABOVE_CENTRE:.3f} m above the skull centre; '
    f'Idle reach l {IDLE_REACH["l"]:.3f} r {IDLE_REACH["r"]:.3f}')


def begin(name, frames):
    action = bpy.data.actions.new(name)
    rig.animation_data.action = action
    for pose_bone in rig.pose.bones:
        pose_bone.rotation_mode = 'XYZ'
        pose_bone.rotation_euler = (0, 0, 0); pose_bone.location = (0, 0, 0); pose_bone.scale = (1, 1, 1)
    clips[name] = (action, frames)
    return action


def key(frame, rotations=None, locations=None):
    rotations, locations = rotations or {}, locations or {}
    for name, pose_bone in rig.pose.bones.items():
        base, extra = READY_ROTATIONS.get(name, (0, 0, 0)), rotations.get(name, (0, 0, 0))
        pose_bone.rotation_euler = tuple(math.radians(base[i] + extra[i]) for i in range(3))
        base, extra = READY_LOCATIONS.get(name, (0, 0, 0)), locations.get(name, (0, 0, 0))
        pose_bone.location = tuple(base[i] + extra[i] for i in range(3))
        pose_bone.keyframe_insert('rotation_euler', frame=frame, group=name)
        pose_bone.keyframe_insert('location', frame=frame, group=name)
    bpy.context.view_layer.update()


def pose_chain(frame, upper_name, lower_name, end_name, target, bend, orientation=None):
    """World-space two-bone solve baked into the skeleton, with an explicit end orientation."""
    bpy.context.view_layer.update()
    upper, lower, end_bone = rig.pose.bones[upper_name], rig.pose.bones[lower_name], rig.pose.bones[end_name]
    origin = upper.head.copy(); target = Vector(target); direction = target - origin
    distance = min(direction.length, upper.length + lower.length - 0.0005); direction.normalize()
    bend = Vector(bend); bend = (bend - direction * bend.dot(direction)).normalized()
    along = (upper.length ** 2 - lower.length ** 2 + distance ** 2) / (2 * distance)
    joint = origin + direction * along + bend * math.sqrt(max(0, upper.length ** 2 - along ** 2))
    target = origin + direction * distance
    for pose, start, finish in [(upper, origin, joint), (lower, joint, target)]:
        rest = rig.data.bones[pose.name]
        rotation = (rest.tail_local - rest.head_local).rotation_difference(finish - start) @ rest.matrix_local.to_quaternion()
        pose.matrix = Matrix.Translation(start) @ rotation.to_matrix().to_4x4(); bpy.context.view_layer.update()
    rotation = orientation or rig.data.bones[end_name].matrix_local.to_quaternion()
    end_bone.matrix = Matrix.Translation(target) @ rotation.to_matrix().to_4x4()
    bpy.context.view_layer.update()
    for pose in [upper, lower, end_bone]:
        pose.keyframe_insert('rotation_euler', frame=frame, group=pose.name)
        pose.keyframe_insert('location', frame=frame, group=pose.name)
    return joint


def grip_weapon(frame, target, kick=0.0, roll=0.0, rotation=None, bends=((0.7, -0.2, -1), (-0.65, 0.1, -1))):
    """Trigger hand at `target` (level weapon, or the given world rotation); the support hand keeps
    its rest grip on the weapon. `bends` are the right and left elbow directions."""
    if rotation is None:
        rest_rotation = rig.data.bones['hand_r'].matrix_local.to_quaternion()
        rotation = Matrix.Rotation(math.radians(kick * 2.8), 4, 'X').to_quaternion() @ Matrix.Rotation(math.radians(roll), 4, 'Y').to_quaternion() @ rest_rotation
    pose_chain(frame, 'upper_arm_r', 'forearm_r', 'hand_r', target, bends[0], rotation)
    transform = rig.pose.bones['hand_r'].matrix @ rig.data.bones['hand_r'].matrix_local.inverted()
    left_target = transform @ REST['hand_l'][0]
    left_rotation = transform.to_quaternion() @ rig.data.bones['hand_l'].matrix_local.to_quaternion()
    pose_chain(frame, 'upper_arm_l', 'forearm_l', 'hand_l', left_target, bends[1], left_rotation)


SUPPORT_REACH = 0.95   # the left arm at most 95% straight: an elbow bent about 144 degrees, like Idle
GRIP = REST['hand_l'][0] - REST['hand_r'][0]   # support wrist from the trigger wrist, weapon level


def hold_weapon(frame, offset=(0.0, 0.0, 0.0)):
    """Hold the weapon level where Idle holds it relative to the shoulders, drawn back toward the
    body if the support arm would have to reach further than in Idle. Both hands keep their grip."""
    bpy.context.view_layer.update()
    bones = rig.pose.bones
    shoulder = {side: bones['upper_arm_' + side].head.copy() for side in ('l', 'r')}
    target = (shoulder['l'] + shoulder['r']) / 2 + IDLE_HOLD + Vector(offset)
    for _ in range(3):
        for side, grip, limit in (('l', GRIP, SUPPORT_REACH), ('r', Vector(), max(SUPPORT_REACH, IDLE_REACH['r']))):
            arm = target + grip - shoulder[side]
            excess = arm.length - limit * ARM[side]
            if excess > 0:
                target = target - arm.normalized() * excess
    grip_weapon(frame, target)
    return target


def fit_trunk(frame, rotations, locations, head_xy, top):
    """Key the trunk, then move the pelvis so the skull centre sits over head_xy (Blender metres)
    and the helmet top at `top`. Moving the pelvis carries everything above it rigidly, so one
    correction is exact. Returns the pelvis location (bone space: x, up, back)."""
    location = Vector(locations.get('pelvis', (0.0, 0.0, 0.0)))
    key(frame, rotations, {**locations, 'pelvis': tuple(location)})
    current, _, centre = head_extent()
    error = Vector((head_xy[0] - centre.x, head_xy[1] - centre.y, top - current))
    location += Vector((error.x, error.z, -error.y))
    key(frame, rotations, {**locations, 'pelvis': tuple(location)})
    return location


def foot_frame(side, ankle, pitch=0.0, yaw=0.0, roll=0.0, pivot=None):
    """Foot orientation rotated about world X (pitch: + lifts the toes), Z (yaw) and Y (roll).
    With a pivot (a point fixed relative to the flat foot), the ankle moves so the pivot stays put."""
    sign = 1 if side == 'r' else -1
    base = Matrix.Rotation(math.radians(-sign * 5 + yaw), 4, 'Z') @ Matrix.Rotation(math.radians(roll), 4, 'Y') @ Matrix.Rotation(math.radians(pitch), 4, 'X')
    ankle = Vector(ankle)
    if pivot is not None:
        offset = Vector(pivot)
        ankle = ankle + offset - base.to_3x3() @ offset
    return ankle, base.to_quaternion() @ rig.data.bones['foot_' + side].matrix_local.to_quaternion()


def place_leg(frame, side, ankle, orientation, bend):
    return pose_chain(frame, 'thigh_' + side, 'shin_' + side, 'foot_' + side, ankle, bend, orientation)


def sole_minimum(side):
    bpy.context.view_layer.update()
    deform = rig.pose.bones['foot_' + side].matrix @ rig.data.bones['foot_' + side].matrix_local.inverted()
    return min((deform @ p).z for p in foot_points[side])


def grounded_leg(frame, side, ankle, orientation, bend, clearance=0.0065, lift=0.0):
    """Solve, then raise or lower the ankle so the lowest boot point sits `clearance` above the floor."""
    ankle = Vector(ankle)
    for _ in range(3):
        place_leg(frame, side, ankle, orientation, bend)
        ankle.z += clearance + lift - sole_minimum(side)
    place_leg(frame, side, ankle, orientation, bend)
    return ankle


# Walk and Run: the scout's hips and legs (CMU-derived) stay sample for sample. Their upper body
# leaned about 23 degrees forward with the head tipped 15 degrees down, carrying the head 27-33 cm
# ahead of the player, outside the shared head hit box. The upper body is leaned back about the
# spine joint until the skull centre rides over the player like Idle's, and the head is tipped up
# to Idle's angle (its stride motion kept); both hands keep their grip, so the weapon moves with
# the shoulders. Every 120 Hz export sample (quarter frame) is keyed with linear interpolation.
UPPER_BODY = ('spine', 'chest', 'neck', 'head', 'upper_arm_l', 'forearm_l', 'hand_l', 'upper_arm_r', 'forearm_r', 'hand_r')
GAIT_HEAD_AHEAD = 0.06   # cycle-average skull centre this far ahead of the player (Idle: 0.10)


def head_pitch():
    """Forward tip of the head bone from vertical, in degrees."""
    head = rig.pose.bones['head']
    direction = head.tail - head.head
    return math.degrees(math.atan2(direction.y, direction.z))


set_pose('Idle', 1)
IDLE_HEAD_PITCH = head_pitch()
rig.animation_data.action = None


def upright_gait(name):
    action, frames = clips[name]
    source = action.copy(); source.name = name + 'ScoutSource'
    times = [1 + step / 4 for step in range(frames * 4 + 1)]
    recorded = []
    rig.animation_data.action = source
    if source.slots:
        rig.animation_data.action_slot = source.slots[0]
    for time in times:
        scene.frame_set(int(time), subframe=time % 1); bpy.context.view_layer.update()
        bones = rig.pose.bones
        recorded.append({'basis': {bone: bones[bone].matrix_basis.copy() for bone in UPPER_BODY}, 'pivot': bones['spine'].head.copy(),
                         'joint': bones['head'].head.copy(), 'centre': head_centre(), 'head': bones['head'].matrix.copy(), 'pitch': head_pitch(),
                         'hand': bones['hand_r'].matrix.copy(), 'shoulders': (bones['upper_arm_l'].head + bones['upper_arm_r'].head) / 2,
                         'bends': tuple(bones['forearm_' + s].head - (bones['upper_arm_' + s].head + bones['hand_' + s].head) / 2 for s in ('r', 'l'))})
    level = Matrix.Rotation(math.radians(sum(r['pitch'] for r in recorded) / len(recorded) - IDLE_HEAD_PITCH), 3, 'X')

    def ahead(angle):
        """Cycle-average skull centre after leaning the upper body back `angle` degrees."""
        turn = Matrix.Rotation(math.radians(angle), 3, 'X')
        return sum((r['pivot'] + turn @ (r['joint'] - r['pivot']) + level @ (r['centre'] - r['joint'])).y for r in recorded) / len(recorded)
    low, high = 0.0, 45.0
    for _ in range(40):
        low, high = ((low + high) / 2, high) if ahead((low + high) / 2) > GAIT_HEAD_AHEAD else (low, (low + high) / 2)
    angle = (low + high) / 2

    rig.animation_data.action = action
    if action.slots:
        rig.animation_data.action_slot = action.slots[0]
    for curve in fcurves(action):
        if curve.data_path.split('"')[1] in UPPER_BODY:
            for point in reversed(list(curve.keyframe_points)):
                curve.keyframe_points.remove(point, fast=True)
            curve.update()
    lean = Matrix.Rotation(math.radians(angle), 4, 'X')
    for time, r in zip(times, recorded):
        scene.frame_set(int(time), subframe=time % 1)
        bones = rig.pose.bones
        for bone in UPPER_BODY:
            bones[bone].matrix_basis = r['basis'][bone]
        bpy.context.view_layer.update()
        bones['spine'].matrix = Matrix.Translation(r['pivot']) @ lean @ Matrix.Translation(-r['pivot']) @ bones['spine'].matrix
        bpy.context.view_layer.update()
        bones['head'].matrix = Matrix.Translation(bones['head'].head) @ (level @ r['head'].to_3x3()).to_4x4()
        bpy.context.view_layer.update()
        shoulders = (bones['upper_arm_l'].head + bones['upper_arm_r'].head) / 2
        grip_weapon(time, r['hand'].translation + (shoulders - r['shoulders']), rotation=r['hand'].to_quaternion(), bends=r['bends'])
        for bone in ('spine', 'chest', 'neck', 'head'):
            bones[bone].keyframe_insert('rotation_euler', frame=time, group=bone)
            bones[bone].keyframe_insert('location', frame=time, group=bone)
    for curve in fcurves(action):
        if curve.data_path.split('"')[1] in UPPER_BODY:
            for point in curve.keyframe_points:
                point.interpolation = 'LINEAR'
    bpy.data.actions.remove(source)
    rig.animation_data.action = None
    log(f'{name}: upper body leaned back {angle:.1f} degrees; skull centre averages {ahead(angle):.3f} m ahead')
    return angle


GAIT_LEAN = {name: upright_gait(name) for name in ('Walk', 'Run')}

# Low poses are fitted to the shared posture rules: the helmet top just under the posture height
# (nothing visible above the hit boxes), the skull centre over the player's position, and the
# weapon held where Idle holds it relative to the shoulders.
FIT_MARGIN = 0.006   # helmet top this far under the posture height (breathing and sampling slack)
# Skull centre targets (Blender x, y: right, forward of the player's position), all well inside
# the 0.15 m head box; the slide's sits a little behind because it leans back.
CROUCH_HEAD, CROUCH_WALK_HEAD, SLIDE_HEAD = (0.0, 0.0), (0.0, 0.0), (0.0, -0.05)
# The low poses carry the weapon a little closer to the chest than Idle (a compact ready), which
# keeps the hands and forearms inside the torso hit box.
COMPACT_READY = (0.0, -0.07, 0.0)


def crouch_trunk(breath):
    # Kneeling on the right knee with the hips sat back, the torso leaning in over the left knee
    # and the head level, looking along the weapon.
    return {'pelvis': (-6, 2, 0), 'spine': (-15 - breath * 0.6, 2, 0), 'chest': (-8, 0, 0), 'neck': (14, 0, 0), 'head': (13 + breath * 0.4, -6, 0)}


log('authoring Crouch')
begin('Crouch', 60)
CROUCH_PELVIS = fit_trunk(1, crouch_trunk(0), {'pelvis': (0.0, -0.43, 0.13)}, CROUCH_HEAD, POSTURE_HEIGHT['crouch'] - FIT_MARGIN)
hips = rig.pose.bones['pelvis'].head.copy()
# Sat back toward the right heel: the right knee comes down ahead of the hips and the tucked right
# boot stays close behind them instead of trailing out of the hit boxes.
CROUCH_FEET = {'l': (hips.x - 0.165, hips.y + 0.29, 0.125), 'r': (hips.x + 0.17, hips.y - 0.16, 0.125)}
for frame, breath in [(1, 0), (31, 1), (61, 0)]:
    key(frame, crouch_trunk(breath), {'pelvis': tuple(CROUCH_PELVIS + Vector((0.0, breath * 0.004, 0.0)))})
    ankle, orientation = foot_frame('l', CROUCH_FEET['l'])
    grounded_leg(frame, 'l', ankle, orientation, (-0.25, 1, 0.6))
    ankle, orientation = foot_frame('r', CROUCH_FEET['r'], pitch=-55)
    grounded_leg(frame, 'r', ankle, orientation, (0.25, 1, 0.1))
    hold_weapon(frame, (COMPACT_READY[0], COMPACT_READY[1], COMPACT_READY[2] + breath * 0.003))

# CrouchWalk: in place at a 2.6 m/s reference. Stance feet travel back at exactly that speed, a
# heel roll pivots over the ball of the foot, and swing uses a Hermite path matching stance speed.
# The cycle is phased like Walk/Run, because CharacterBlend fades gait clips at one shared
# normalized phase; out of step, the legs would scissor during a walk-to-crouch fade.
CROUCH_SPEED, CROUCH_FRAMES, DUTY = 2.6, 16, 0.54
CYCLE = CROUCH_FRAMES / 30
STROKE = CROUCH_SPEED * DUTY * CYCLE
SWING_LIFT = 0.10   # peak swing height of the lowest boot point
FEET_AHEAD = 0.28   # the feet's stroke centre sits this far ahead of the hips (which lean back
                    # about 37 cm behind the player), so the trailing foot never falls far behind
                    # them and drags its knee down, and the boots stay within reach of the player


def smootherstep(edge0, edge1, value):
    t = clamp((value - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * t * (t * (t * 6 - 15) + 10)


def crouch_foot(side, phase, centre=(0.0, 0.0)):
    """Planted feet travel back at exactly CROUCH_SPEED; the swing is a quintic with the stance
    velocity and zero acceleration at lift-off and touchdown, so the loop has no velocity seam.
    The swing foot rises early (a warped lift curve) so the trailing knee clears the floor."""
    sign = 1 if side == 'r' else -1
    p = (phase + (0.0 if side == 'l' else 0.5)) % 1.0
    x, middle = centre[0] + sign * 0.155, centre[1]
    ball = (0.0, 0.135, -0.118)
    if p < DUTY:
        u = p / DUTY
        y = middle + STROKE / 2 - STROKE * u
        pitch = -24 * smootherstep(0.72, 1.0, u)
        return foot_frame(side, (x, y, 0.125), pitch=pitch, pivot=ball if pitch else None), 0.0
    u = (p - DUTY) / (1 - DUTY)
    swing_time = (1 - DUTY) * CYCLE
    m = -CROUCH_SPEED * swing_time
    h0, h1 = 1 - 10 * u ** 3 + 15 * u ** 4 - 6 * u ** 5, u - 6 * u ** 3 + 8 * u ** 4 - 3 * u ** 5
    h4, h5 = -4 * u ** 3 + 7 * u ** 4 - 3 * u ** 5, 10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5
    y = h0 * (middle - STROKE / 2) + h1 * m + h4 * m + h5 * (middle + STROKE / 2)
    w = u ** 0.7
    lift = SWING_LIFT * 64 * (w * (1 - w)) ** 3
    pitch = -24 * (1 - smootherstep(0.0, 0.4, u)) + 8 * smootherstep(0.45, 0.75, u) * (1 - smootherstep(0.8, 1.0, u))
    return foot_frame(side, (x, y, 0.125), pitch=pitch, pivot=ball if pitch < 0 else None), lift


def foot_phase_shift(count=64):
    """Phase offset that puts CrouchWalk's feet in step with Walk: the circular shift that best
    correlates each foot's fore-and-aft travel (validate_operator.mjs repeats this on the export)."""
    action, frames = clips['Walk']
    walk = {side: [] for side in ('l', 'r')}
    for index in range(count):
        set_pose('Walk', 1 + frames * index / count)
        for side in ('l', 'r'):
            walk[side].append(rig.pose.bones['foot_' + side].head.y)
    rig.animation_data.action = None
    crouch = {side: [crouch_foot(side, index / count)[0][0].y for index in range(count)] for side in ('l', 'r')}

    def normalise(values):
        mean = sum(values) / len(values)
        deviation = math.sqrt(sum((v - mean) ** 2 for v in values) / len(values))
        return [(v - mean) / deviation for v in values]
    pairs = [(normalise(walk[side]), normalise(crouch[side])) for side in ('l', 'r')]
    scores = [sum(sum(a[i] * b[(i + shift) % count] for i in range(count)) for a, b in pairs) for shift in range(count)]
    return scores.index(max(scores)) / count


def crouch_walk_trunk(phase):
    """Torso leaning in over the knees, head level; hips sway over the stance foot, twist with the
    stride and bob twice a cycle (bone-space pelvis offset: x, up, back)."""
    sway = 0.012 * math.sin(2 * math.pi * phase)
    twist = 3.0 * math.sin(2 * math.pi * phase)
    bob = -0.010 * math.cos(4 * math.pi * phase)
    rotations = {'pelvis': (-12, 2 - twist, 0), 'spine': (-22, 2 + twist * 0.6, 0), 'chest': (-10, twist * 0.4, 0), 'neck': (21, 0, 0), 'head': (23, -6, 0)}
    return rotations, Vector((sway, bob, 0.0))


def author_crouch_walk(base, centre):
    """Key every quarter frame (120 Hz); export_operator() writes them densely like Walk/Run, so
    linear interpolation between solved poses cannot dip a planted boot into the floor. Returns the
    highest helmet top and the lowest knee point."""
    top, knee = -1.0, 1.0
    for step in range(CROUCH_FRAMES * 4 + 1):
        frame = 1 + step / 4
        phase = ((step % (CROUCH_FRAMES * 4)) / (CROUCH_FRAMES * 4) + PHASE_SHIFT) % 1.0
        rotations, offset = crouch_walk_trunk(phase)
        key(frame, rotations, {'pelvis': tuple(base + offset)})
        for side in ('l', 'r'):
            (ankle, orientation), lift = crouch_foot(side, phase, centre)
            # Knees point forward with a slight lift; a strongly upward hint would turn
            # antiparallel to a trailing foot and flip the knee. The lowest boot point sits at the
            # stance clearance plus the swing lift, so a toe still pitched down from push-off
            # cannot pass through the floor.
            bend = (-0.15, 1, 0.22) if side == 'l' else (0.15, 1, 0.22)
            grounded_leg(frame, side, ankle, orientation, bend, lift=lift)
        hold_weapon(frame, COMPACT_READY)
        top = max(top, head_extent()[0]); knee = min(knee, knee_minimum())
    return top, knee


log('authoring CrouchWalk')
PHASE_SHIFT = foot_phase_shift()
begin('CrouchWalk', CROUCH_FRAMES)
rotations, offset = crouch_walk_trunk(0.25)   # the top of the bob
base = fit_trunk(1, rotations, {'pelvis': (0.0, -0.45, 0.17)}, CROUCH_WALK_HEAD, POSTURE_HEIGHT['crouch'] - FIT_MARGIN) - offset
key(1, rotations, {'pelvis': tuple(base)})
hips = rig.pose.bones['pelvis'].head.copy()
CROUCH_CENTRE = (hips.x, hips.y + FEET_AHEAD)
top, knee = author_crouch_walk(base, CROUCH_CENTRE)
if top > POSTURE_HEIGHT['crouch'] - FIT_MARGIN + 1e-4:   # twist and sway can add a little height
    base -= Vector((0.0, top - (POSTURE_HEIGHT['crouch'] - FIT_MARGIN), 0.0))
    top, knee = author_crouch_walk(base, CROUCH_CENTRE)
log(f'CrouchWalk: phase shift {PHASE_SHIFT:.3f} to match Walk; hips at {hips.y:.3f} m, feet centred at {CROUCH_CENTRE[1]:.3f} m; '
    f'helmet top {top:.3f} m; lowest knee point {knee:.4f} m')
for curve in fcurves(clips['CrouchWalk'][0]):
    for keyframe in curve.keyframe_points:
        keyframe.interpolation = 'LINEAR'

# Slide: feet first and leaning back, the left leg reaching forward on its heel with the knee bent
# and the right leg folded, weapon held level. Compact, so the body stays inside the slide hit
# boxes and the boots cannot show through a wall. A low shudder keeps the held pose alive.
SLIDE_TOP = POSTURE_HEIGHT['slide'] - FIT_MARGIN - 0.004   # room for the shudder
SLIDE_FEET = {'l': (-0.15, 0.54, 0.125), 'r': (0.22, 0.10, 0.125)}


def slide_trunk(shudder):
    # Leaning well back on the hips with a straight back, so the seat rides on the floor; the head
    # tips back a little to look over the weapon, which lifts the eyes toward the slide camera
    # height without raising the helmet.
    return {'pelvis': (45, 6, 0), 'spine': (-6, 3, 0), 'chest': (-8, 0, 0), 'neck': (-4 + shudder * 200, 0, 0), 'head': (-7, -6, 0)}


log('authoring Slide')
begin('Slide', 30)
SLIDE_PELVIS = fit_trunk(1, slide_trunk(0.0), {'pelvis': (0.0, -0.715, -0.15)}, SLIDE_HEAD, SLIDE_TOP)
for frame in range(1, 32, 3):
    t = (frame - 1) / 30
    shudder = 0.0035 * math.sin(2 * math.pi * 4 * t) + 0.0015 * math.sin(2 * math.pi * 7 * t)
    key(frame, slide_trunk(shudder), {'pelvis': tuple(SLIDE_PELVIS + Vector((0.0, shudder, 0.0)))})
    ankle, orientation = foot_frame('l', SLIDE_FEET['l'], pitch=62, pivot=(0.0, -0.035, -0.11))
    grounded_leg(frame, 'l', ankle, orientation, (-0.5, 0.3, 1))
    ankle, orientation = foot_frame('r', SLIDE_FEET['r'], pitch=10, roll=-12)
    grounded_leg(frame, 'r', ankle, orientation, (0.8, 0.3, 0.6))
    hold_weapon(frame, COMPACT_READY)

# NLA tracks: one per exported clip, matching the scout's layout.
rig.animation_data.action = None
for name in ('Crouch', 'CrouchWalk', 'Slide'):
    action, frames = clips[name]
    track = rig.animation_data.nla_tracks.new(); track.name = name
    strip = track.strips.new(name, 1, action); strip.action_frame_start = 1; strip.action_frame_end = frames + 1
    track.mute = True
for pose_bone in rig.pose.bones:
    pose_bone.rotation_euler = (0, 0, 0); pose_bone.location = (0, 0, 0)
bpy.context.view_layer.update()


def audit(name, frame):
    """Deformed extents of every part in a pose, plus the head centre (validate_operator.mjs repeats
    this on the exported skin)."""
    set_pose(name, frame)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    low, high, lowest, reach, inside, total = 1e9, -1e9, '', 0.0, 0, 0
    for obj in PARTS['atlas'] + PARTS['accent'] + PARTS['lens']:
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        co = np.empty(len(mesh.vertices) * 3, np.float32); mesh.vertices.foreach_get('co', co)
        evaluated.to_mesh_clear()
        x, y, z = co[0::3], co[1::3], co[2::3]
        if z.min() < low:
            low, lowest = float(z.min()), obj.name
        high = max(high, float(z.max()))
        reach = max(reach, float(np.sqrt(x ** 2 + y ** 2).max()))
        boxed = np.zeros(len(z), bool)
        for _, bottom, top, half in ZONES[CLIP_POSTURE[name]]:
            boxed |= (np.abs(x) <= half + 0.01) & (np.abs(y) <= half + 0.01) & (z >= bottom - 0.01) & (z <= top + 0.01)
        inside += int(boxed.sum()); total += len(z)
    centre = head_centre()
    log(f'{name}@{frame}: head ({centre.x:.3f}, {centre.y:.3f}, {centre.z:.3f}) top {high:.3f} lowest {low:.4f} ({lowest}) reach {reach:.3f} '
        f'in boxes {inside / total:.3f}; pelvis z {rig.pose.bones["pelvis"].head.z:.3f}; soles l {sole_minimum("l"):.4f} r {sole_minimum("r"):.4f}')
    return {'clip': name, 'frame': frame, 'head': list(centre), 'top': high, 'lowest': low, 'lowestPart': lowest, 'reach': reach, 'inBoxes': inside / total}


def fit_audit(name, samples=32):
    """The validator's posture checks, measured in Blender over a clip: helmet top against the
    posture height, glasses against the camera height, skull centre against the head box, support
    hand grip and elbow bend, and the lowest knee point."""
    action, frames = clips[name]
    posture = CLIP_POSTURE[name]
    worst = {'top': -1e9, 'eye': [1e9, -1e9], 'centre': [1e9, -1e9], 'offset': 0.0, 'grip': 0.0, 'elbow': 0.0, 'knee': 1e9, 'helmet': [1.0, 0.0]}

    def boxed(p, slack=0.01):
        return any(abs(p.x) <= half + slack and abs(p.y) <= half + slack and bottom - slack <= p.z <= top + slack
                   for _, bottom, top, half in ZONES[posture])
    for index in range(samples + 1):
        set_pose(name, 1 + frames * index / samples)
        top, eye, centre = head_extent()
        matrix = deform('head')
        helmet = sum(boxed(matrix @ p) for p in HEAD_POINTS) / len(HEAD_POINTS)
        worst['helmet'] = [min(worst['helmet'][0], helmet), worst['helmet'][1] + helmet / (samples + 1)]
        worst['boots'] = max(worst.get('boots', 0.0), max((deform('foot_' + side) @ p).xy.length for side in ('l', 'r') for p in foot_points[side]))
        bones = rig.pose.bones
        grip = (socket.matrix_world.inverted() @ bones['hand_l'].head - SUPPORT_REST).length
        shoulder, elbow, wrist = bones['upper_arm_l'].head, bones['forearm_l'].head, bones['hand_l'].head
        worst['top'] = max(worst['top'], top)
        worst['eye'] = [min(worst['eye'][0], eye), max(worst['eye'][1], eye)]
        worst['centre'] = [min(worst['centre'][0], centre.z), max(worst['centre'][1], centre.z)]
        worst['offset'] = max(worst['offset'], abs(centre.x), abs(centre.y))
        worst['grip'] = max(worst['grip'], grip)
        worst['elbow'] = max(worst['elbow'], math.degrees((shoulder - elbow).angle(wrist - elbow)))
        worst['knee'] = min(worst['knee'], knee_minimum())
    log(f'fit {name:10s} top {worst["top"]:.3f} (under {POSTURE_HEIGHT[posture]}) eye {worst["eye"][0]:.3f}..{worst["eye"][1]:.3f} '
        f'(camera {EYE_HEIGHT[posture]}) skull {worst["centre"][0]:.3f}..{worst["centre"][1]:.3f} off centre {worst["offset"]:.3f} '
        f'grip {worst["grip"] * 100:.1f} cm left elbow {worst["elbow"]:.0f} deg knee {worst["knee"]:.4f} '
        f'head gear in boxes {worst["helmet"][0]:.2f} (mean {worst["helmet"][1]:.2f}) boots reach {worst["boots"]:.3f}')
    return {'clip': name, 'posture': posture, **worst}


POSE_AUDIT = [audit(name, frame) for name, frame in [('Idle', 1), ('Aim', 1), ('Walk', 1), ('Walk', 5), ('Run', 1), ('Crouch', 1), ('Crouch', 31),
                                                      ('CrouchWalk', 1), ('CrouchWalk', 5), ('CrouchWalk', 9), ('CrouchWalk', 13), ('Slide', 1), ('Slide', 16)]]
FIT_AUDIT = [fit_audit(name) for name in ('Idle', 'Aim', 'Walk', 'Run', 'Fire', 'Crouch', 'CrouchWalk', 'Slide')]
rig.animation_data.action = None
for pose_bone in rig.pose.bones:
    pose_bone.rotation_euler = (0, 0, 0); pose_bone.location = (0, 0, 0)
bpy.context.view_layer.update()


# ---------------------------------------------------------------------------------------------
# Review renders.
def studio(accent_hex):
    accent_bsdf.inputs['Base Color'].default_value = (*srgb(accent_hex), 1)
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = RENDER_SAMPLES
    scene.cycles.use_denoising = True
    scene.view_settings.view_transform = 'AgX'
    scene.view_settings.look = 'None'
    scene.view_settings.exposure = 0.0
    scene.render.film_transparent = False
    world = scene.world
    world.use_nodes = True
    background = world.node_tree.nodes.get('Background')
    background.inputs['Color'].default_value = (0.20, 0.205, 0.21, 1)
    background.inputs['Strength'].default_value = 0.3


def point_at(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()


def setup_stage():
    if 'StudioFloor' not in bpy.data.objects:
        floor_material = bpy.data.materials.new('StudioGround')
        floor_material.use_nodes = True
        floor_material.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value = (0.05, 0.048, 0.045, 1)
        floor_material.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value = 0.9
        bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, -0.001))
        floor = bpy.context.object; floor.name = 'StudioFloor'; floor.data.materials.append(floor_material)
        bpy.ops.object.camera_add(location=(2.4, 3.1, 1.6))
        camera = bpy.context.object; camera.name = 'StudioCamera'; scene.camera = camera
        for name, location, power, size, colour in [('Key', (2.6, 3.0, 3.6), 420, 3.0, (1.0, 0.9, 0.78)),
                                                     ('Fill', (-3.2, 1.6, 2.4), 150, 3.0, (0.72, 0.82, 1.0)),
                                                     ('Rim', (-0.6, -3.4, 3.0), 600, 2.5, (0.9, 0.95, 1.0))]:
            bpy.ops.object.light_add(type='AREA', location=location)
            light = bpy.context.object; light.name = 'Studio' + name
            light.data.energy = power; light.data.shape = 'DISK'; light.data.size = size; light.data.color = colour
            point_at(light, (0, 0, 1.0))
    return scene.camera


def render(path, camera_location, target, ortho=None, resolution=(1000, 1200), lens=50):
    camera = setup_stage()
    camera.location = camera_location
    point_at(camera, target)
    if ortho:
        camera.data.type = 'ORTHO'; camera.data.ortho_scale = ortho
    else:
        camera.data.type = 'PERSP'; camera.data.lens = lens
    scene.render.resolution_x, scene.render.resolution_y = resolution
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'JPEG' if str(path).endswith('.jpg') else 'PNG'
    if scene.render.image_settings.file_format == 'JPEG':
        scene.render.image_settings.quality = 90
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    log(f'rendered {path}')


def review_material(name, colour, emission=0.0):
    material = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    material.use_nodes = True
    shader = material.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*colour, 1)
    if emission:
        shader.inputs['Emission Color'].default_value = (*colour, 1)
        shader.inputs['Emission Strength'].default_value = emission
    return material


def hitbox_frames(index, offset, turn, posture):
    """Thin wire outlines of the shared hit boxes for a posture, centred on the player's position."""
    material = review_material('Review hit boxes', (1.0, 0.78, 0.25), emission=1.5)
    boxes = []
    for zone, bottom, top, half in ZONES[posture]:
        mesh = bpy.data.meshes.new(f'Review_box_{index}_{zone}')
        bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
        for vertex in bm.verts:
            vertex.co = Vector((vertex.co.x * 2 * half, vertex.co.y * 2 * half, bottom + (vertex.co.z + 0.5) * (top - bottom)))
        bm.to_mesh(mesh); bm.free()
        obj = bpy.data.objects.new(mesh.name, mesh); COLLECTION.objects.link(obj)
        obj.location = offset; obj.rotation_euler.z = math.radians(turn)
        wire = obj.modifiers.new('Wire', 'WIREFRAME'); wire.thickness = 0.007; wire.use_replace = True
        mesh.materials.append(material)
        boxes.append(obj)
    return boxes


def pose_sheet(path, poses, accent_hex, turn=-35, rows_count=2, boxes=False):
    """Real deformed-geometry snapshots of authored poses side by side, optionally inside wire
    outlines of the shared hit boxes for each clip's posture."""
    studio(accent_hex)
    setup_stage()
    body = PARTS_JOINED
    snapshots = []
    label_material = review_material('Review lettering', (0.8, 0.8, 0.77))
    columns = (len(poses) + rows_count - 1) // rows_count
    for index, (name, frame) in enumerate(poses):
        set_pose(name, frame)
        depsgraph = bpy.context.evaluated_depsgraph_get()
        # The camera looks down -Y, so world -X is screen right: lay poses out left to right.
        spacing = 1.25 if turn > -60 else 1.6
        offset = Vector((-(index % columns - (columns - 1) / 2) * spacing, 0, (rows_count - 1 - index // columns) * 2.15 - 0.9))
        for source in body:
            mesh = bpy.data.meshes.new_from_object(source.evaluated_get(depsgraph), depsgraph=depsgraph)
            obj = bpy.data.objects.new(f'Review_{index}_{source.name}', mesh); COLLECTION.objects.link(obj)
            obj.location = offset; obj.rotation_euler.z = math.radians(turn); snapshots.append(obj)
        if boxes:
            snapshots.extend(hitbox_frames(index, offset, turn, CLIP_POSTURE[name]))
        bpy.ops.object.text_add(location=offset + Vector((0, 0.5, -0.12)), rotation=(math.pi / 2, 0, math.pi))
        label = bpy.context.object; label.data.body = name.upper(); label.data.align_x = 'CENTER'; label.data.size = 0.09
        label.data.materials.append(label_material); snapshots.append(label)
    hidden = [obj for obj in body]
    for obj in hidden:
        obj.hide_render = True
    floor = bpy.data.objects['StudioFloor']; floor.hide_render = True
    spacing = 1.25 if turn > -60 else 1.6
    height = 2.35 * rows_count
    width_px, height_px = int(columns * spacing * 264), int(height * 240)
    centre_z = (rows_count - 1) * 2.15 / 2 - 0.9 + 0.95
    render(path, (0.0, 12.0, centre_z), (0.0, 0.0, centre_z), ortho=max(columns * spacing * 1.04, height * width_px / height_px),
           resolution=(width_px, height_px))
    floor.hide_render = False
    for obj in hidden:
        obj.hide_render = False
    for obj in snapshots:
        data = obj.data
        bpy.data.objects.remove(obj, do_unlink=True)
        if isinstance(data, bpy.types.Mesh):
            bpy.data.meshes.remove(data)
    rig.animation_data.action = None


def review(prefix, final):
    set_pose('Idle', 1)
    studio('#4aa3ff')
    render(PREVIEWS / f'{prefix}-front.png', (2.35, 3.15, 1.55), (0.0, 0.05, 0.93), ortho=2.35)
    studio('#ff5a4f')
    render(PREVIEWS / f'{prefix}-back.png', (-2.3, -3.2, 1.65), (0.0, 0.0, 0.95), ortho=2.35)
    studio('#4aa3ff')
    render(PREVIEWS / f'{prefix}-head.png', (0.75, 1.05, 1.78), (0.0, 0.0, 1.66), ortho=0.62, resolution=(800, 800))
    if final:
        pose_sheet(PREVIEWS / f'{prefix}-poses.jpg', [('Idle', 1), ('Aim', 1), ('Walk', 5), ('Run', 4), ('Jump', 6),
                                                      ('Crouch', 1), ('CrouchWalk', 5), ('Slide', 1), ('Reload', 25), ('Fire', 2)], '#ff5a4f')
        side_sheets(prefix)
    rig.animation_data.action = None


LOW_SHEET = [('Crouch', 1), ('CrouchWalk', 1), ('CrouchWalk', 5), ('CrouchWalk', 9), ('Slide', 1)]
GAIT_SHEET = [('Idle', 1), ('Walk', 1), ('Walk', 5), ('Walk', 9), ('Run', 4)]


def side_sheets(prefix):
    """Side views inside the shared hit boxes: the low poses and the upright Walk/Run."""
    pose_sheet(PREVIEWS / f'{prefix}-low-poses.jpg', LOW_SHEET, '#4aa3ff', turn=-90, rows_count=1, boxes=True)
    pose_sheet(PREVIEWS / f'{prefix}-gait-poses.jpg', GAIT_SHEET, '#ff5a4f', turn=-90, rows_count=1, boxes=True)


PARTS_JOINED = PARTS['atlas'] + PARTS['accent'] + PARTS['lens']
if STAGE == 'poses':
    side_sheets('operator-check')
    pose_sheet(PREVIEWS / 'operator-check-front.jpg', [('Crouch', 1), ('CrouchWalk', 5), ('Slide', 1), ('Walk', 5), ('Run', 4)], '#4aa3ff',
               turn=0, rows_count=1, boxes=True)
    pose_sheet(PREVIEWS / 'operator-check-three-quarter.jpg', [('Crouch', 1), ('CrouchWalk', 5), ('Slide', 1)], '#ff5a4f', turn=-50, rows_count=1)
    print('KANNON_OPERATOR_POSES_COMPLETE')
    sys.exit(0)
if STAGE == 'preview':
    review('operator-preview', final=False)
    print('KANNON_OPERATOR_PREVIEW_COMPLETE')
    sys.exit(0)


# ---------------------------------------------------------------------------------------------
# Join the gear, unwrap one atlas and save the editable source (procedural materials, before baking).
def join(objects, name):
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = name; obj.data.name = name
    obj.select_set(False)
    return obj


gear = join(PARTS['atlas'], 'operator_gear')
gear.data.uv_layers.new(name='Surface UV')
bpy.context.view_layer.objects.active = gear
gear.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=math.radians(58), island_margin=0.003, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
try:
    bpy.ops.uv.pack_islands(rotate=True, margin=0.0035, shape_method='CONCAVE')
except TypeError:
    bpy.ops.uv.pack_islands(rotate=True, margin=0.0035)
bpy.ops.object.mode_set(mode='OBJECT')
gear.select_set(False)
for obj in PARTS['accent'] + PARTS['lens']:
    layer = obj.data.uv_layers.new(name='Surface UV')
    for loop in layer.data:
        loop.uv = (0.0, 0.0)
accent_part = join(PARTS['accent'], 'operator_accent')
lens_part = join(PARTS['lens'], 'operator_lens')
rig.animation_data.action = None
scene.frame_set(1)
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE / 'operator.blend'), compress=True)
log(f'saved {SOURCE / "operator.blend"}')

# ---------------------------------------------------------------------------------------------
# Bake the gear atlas on the rest pose: colour and roughness/metal as emission, the shader normal
# in tangent space, and short-range ambient occlusion that is folded into the colour.
BAKE_SAMPLES = int(option('bake-samples', 16))
rig.data.pose_position = 'REST'
bpy.context.view_layer.update()
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.render.bake.use_selected_to_active = False
scene.render.bake.margin = 12
scene.render.bake.margin_type = 'EXTEND'
scene.render.bake.use_clear = True
scene.render.bake.target = 'IMAGE_TEXTURES'
scene.world.light_settings.distance = 0.08
targets = {}
for pass_name in ('colour', 'rm', 'normal', 'ao'):
    image = bpy.data.images.new('bake_' + pass_name, SIZE, SIZE, alpha=False, float_buffer=True)
    image.colorspace_settings.name = 'Non-Color'
    targets[pass_name] = image
gear_materials = list(gear.data.materials)


def prepare(pass_name, emission=None):
    for material in gear_materials:
        tree = material.node_tree; nodes = tree.nodes; links = tree.links
        holder = nodes.get('BakeTarget') or nodes.new('ShaderNodeTexImage')
        holder.name = 'BakeTarget'; holder.image = targets[pass_name]
        nodes.active = holder
        output = nodes.get('Material Output'); bsdf = nodes.get('Principled BSDF')
        if emission is None:
            links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])
            continue
        emit = nodes.get('BakeEmit') or nodes.new('ShaderNodeEmission')
        emit.name = 'BakeEmit'; emit.inputs['Strength'].default_value = 1.0
        value = emission(material, tree)
        if isinstance(value, bpy.types.NodeSocket):
            links.new(value, emit.inputs['Color'])
        else:
            for link in list(emit.inputs['Color'].links):
                links.remove(link)
            emit.inputs['Color'].default_value = (*value[:3], 1.0)
        links.new(emit.outputs['Emission'], output.inputs['Surface'])


def colour_source(material, tree):
    return BAKE[material.name]['colour']


def rm_source(material, tree):
    nodes, links = tree.nodes, tree.links
    combine = nodes.get('BakeRM') or nodes.new('ShaderNodeCombineColor')
    combine.name = 'BakeRM'
    combine.inputs['Red'].default_value = 1.0
    for channel, key in (('Green', 'roughness'), ('Blue', 'metallic')):
        value = BAKE[material.name][key]
        if isinstance(value, bpy.types.NodeSocket):
            links.new(value, combine.inputs[channel])
        else:
            combine.inputs[channel].default_value = value
    return combine.outputs['Color']


def bake(pass_name, kind, samples, emission=None, **settings):
    prepare(pass_name, emission)
    scene.cycles.samples = samples
    bpy.ops.object.select_all(action='DESELECT')
    gear.select_set(True); bpy.context.view_layer.objects.active = gear
    started = time.time()
    bpy.ops.object.bake(type=kind, margin=12, use_clear=True, **settings)
    log(f'baked {pass_name} ({kind}, {samples} samples) in {time.time() - started:.0f}s')
    pixels = np.empty(SIZE * SIZE * 4, np.float32)
    targets[pass_name].pixels.foreach_get(pixels)
    return pixels.reshape(SIZE, SIZE, 4)[..., :3].copy()


colour = bake('colour', 'EMIT', BAKE_SAMPLES, colour_source)
# Sanity check: average baked colour under each material's faces (UV centroids) in sRGB hex.
uv_layer = gear.data.uv_layers.active.data
samples_by_material = {}
for polygon in gear.data.polygons:
    u = sum(uv_layer[i].uv[0] for i in polygon.loop_indices) / polygon.loop_total
    v = sum(uv_layer[i].uv[1] for i in polygon.loop_indices) / polygon.loop_total
    px = colour[min(SIZE - 1, int(v * SIZE)), min(SIZE - 1, int(u * SIZE))]
    samples_by_material.setdefault(gear_materials[polygon.material_index].name, []).append(px)
for name, values in samples_by_material.items():
    mean = np.mean(values, axis=0)
    hexed = ''.join(f'{int(round(255 * (c * 12.92 if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055))):02x}' for c in np.clip(mean, 0, 1))
    log(f'baked colour {name}: #{hexed} over {len(values)} faces')
rm = bake('rm', 'EMIT', BAKE_SAMPLES, rm_source)
normal = bake('normal', 'NORMAL', max(4, BAKE_SAMPLES // 2), None, normal_space='TANGENT', normal_r='POS_X', normal_g='POS_Y', normal_b='POS_Z')
ao = bake('ao', 'AO', AO_SAMPLES)
prepare('colour', None)
rig.data.pose_position = 'POSE'


def blur(array, radius=1):
    """Small box blur that only softens Cycles noise in the occlusion pass."""
    out = array.copy()
    for axis in (0, 1):
        acc = out.copy()
        for step in range(1, radius + 1):
            acc += np.roll(out, step, axis) + np.roll(out, -step, axis)
        out = acc / (2 * radius + 1)
    return out


occlusion = np.clip(blur(ao[..., :1], 1), 0.0, 1.0) ** 0.85
base = np.clip(colour * (0.42 + 0.58 * occlusion), 0.0, 1.0)
encoded = np.where(base <= 0.0031308, base * 12.92, 1.055 * np.power(base, 1 / 2.4) - 0.055)
orm = np.clip(rm, 0.0, 1.0); orm[..., 0] = 1.0


def save_png(name, rgb, colourspace):
    image = bpy.data.images.new(name, SIZE, SIZE, alpha=False)
    image.colorspace_settings.name = colourspace
    rgba = np.ones((SIZE, SIZE, 4), np.float32); rgba[..., :3] = np.clip(rgb, 0.0, 1.0)
    image.pixels.foreach_set(rgba.ravel())
    image.filepath_raw = str(WORK / f'{name}.png'); image.file_format = 'PNG'
    image.save()
    return image


atlas_images = {'Operator_BaseColor': save_png('Operator_BaseColor', encoded, 'sRGB'),
                'Operator_Normal': save_png('Operator_Normal', normal, 'Non-Color'),
                'Operator_MetalRoughness': save_png('Operator_MetalRoughness', orm, 'Non-Color')}
log('atlas written to ' + str(WORK))

# ---------------------------------------------------------------------------------------------
# Runtime material: the same node layout as the scout's ScoutSurface, so the glTF exporter writes
# baseColor, metallicRoughness (G roughness, B metal) and normal textures.
surface = bpy.data.materials.new('ScoutSurface')
surface.use_nodes = True
nodes, links = surface.node_tree.nodes, surface.node_tree.links
shader = nodes.get('Principled BSDF')
texture = {}
for name, image in atlas_images.items():
    node = nodes.new('ShaderNodeTexImage'); node.image = image; texture[name] = node
links.new(texture['Operator_BaseColor'].outputs['Color'], shader.inputs['Base Color'])
separate = nodes.new('ShaderNodeSeparateColor')
links.new(texture['Operator_MetalRoughness'].outputs['Color'], separate.inputs['Color'])
links.new(separate.outputs['Green'], shader.inputs['Roughness'])
links.new(separate.outputs['Blue'], shader.inputs['Metallic'])
normal_map = nodes.new('ShaderNodeNormalMap'); normal_map.inputs['Strength'].default_value = 1.0
links.new(texture['Operator_Normal'].outputs['Color'], normal_map.inputs['Color'])
links.new(normal_map.outputs['Normal'], shader.inputs['Normal'])
gear.data.materials.clear()
gear.data.materials.append(surface)
gear.data.polygons.foreach_set('material_index', [0] * len(gear.data.polygons))
body = join([gear, accent_part, lens_part], 'scout_body')
assert [m.name for m in body.data.materials] == ['ScoutSurface', 'PlayerAccent', 'Visor'], [m.name for m in body.data.materials]
assert len(body.data.uv_layers) == 1, 'one shared UV layer'
for vertex in body.data.vertices:
    assert vertex.groups and abs(sum(g.weight for g in vertex.groups) - 1) < 1e-4, 'every vertex fully skinned'
PARTS_JOINED = [body]

# ---------------------------------------------------------------------------------------------
# Export: same exporter settings as the scout; Walk/Run re-baked at 120 Hz by scout_export.py.
COPYRIGHT = ('Kannon Arena operator: original geometry, materials and Idle/Jump/Aim/Fire/Reload/Crouch/CrouchWalk/Slide motion. '
             'Walk and Run lower-body motion derives from the CMU Graphics Lab Motion Capture Database (mocap.cs.cmu.edu, '
             'subject 09 trial 01); the database was created with funding from NSF EIA-0196217. See operator-motion-NOTICE.txt.')
rig.animation_data.action = None
for pose_bone in rig.pose.bones:
    pose_bone.rotation_euler = (0, 0, 0); pose_bone.location = (0, 0, 0)
scene.frame_set(1)
bpy.ops.object.select_all(action='DESELECT')
for obj in (rig, body, socket):
    obj.select_set(True)
bpy.context.view_layer.objects.active = rig
raw_path = WORK / 'operator-raw.glb'
DENSE_CLIPS = ('Walk', 'Run', 'CrouchWalk')


def export_operator(path, options, factor=4):
    """scout_export.export_scout with CrouchWalk added to the dense set: a normal 30 Hz export, then
    a second export with the scene at 120 fps and only the dense clips' samplers spliced in."""
    original_fps = scene.render.fps
    descriptor, temporary = tempfile.mkstemp(prefix='.operator-staged-', suffix='.glb', dir=path.parent)
    os.close(descriptor); base_path = Path(temporary)
    replacements = []
    try:
        bpy.ops.export_scene.gltf(filepath=str(base_path), **options)
        scene.render.fps = original_fps * factor
        for name in DENSE_CLIPS:
            original, frames = clips[name]
            dense = original.copy(); dense.name = 'DenseExport_' + name
            for layer in dense.layers:
                for strip in layer.strips:
                    for bag in strip.channelbags:
                        for curve in bag.fcurves:
                            for keyframe in curve.keyframe_points:
                                for vector in (keyframe.co, keyframe.handle_left, keyframe.handle_right):
                                    vector.x = 1 + (vector.x - 1) * factor
                            curve.update()
            track = next(t for t in rig.animation_data.nla_tracks if t.name == name)
            nla = track.strips[0]
            replacements.append((nla, original, dense, nla.action_frame_end, nla.frame_end))
            nla.action = dense
            if dense.slots:
                nla.action_slot = dense.slots[0]
            nla.action_frame_start = 1; nla.action_frame_end = frames * factor + 1; nla.frame_end = frames * factor + 1
        descriptor, temporary = tempfile.mkstemp(prefix='kannon-operator-export-', suffix='.glb')
        os.close(descriptor); dense_path = Path(temporary)
        try:
            bpy.ops.export_scene.gltf(filepath=str(dense_path), **options)
            _merge_animation_samples(base_path, dense_path, set(DENSE_CLIPS))
            os.replace(base_path, path)
        finally:
            dense_path.unlink(missing_ok=True)
    finally:
        base_path.unlink(missing_ok=True)
        for nla, original, dense, action_end, frame_end in replacements:
            nla.action = original
            if original.slots:
                nla.action_slot = original.slots[0]
            nla.action_frame_start = 1; nla.action_frame_end = action_end; nla.frame_end = frame_end
            bpy.data.actions.remove(dense)
        scene.render.fps = original_fps
    return {'denseHz': original_fps * factor, 'denseClips': list(DENSE_CLIPS), 'otherClipsHz': original_fps,
            'method': 'Walk/Run/CrouchWalk samplers from a 120 Hz export spliced into the 30 Hz export (scout_export._merge_animation_samples).'}


export_review = export_operator(raw_path, dict(
    export_format='GLB', use_selection=True, export_yup=True, export_animations=True, export_animation_mode='NLA_TRACKS',
    export_nla_strips=True, export_skins=True, export_all_influences=False, export_apply=False, export_lights=False,
    export_cameras=False, export_morph=False, export_copyright=COPYRIGHT))
log(f'exported {raw_path} ({raw_path.stat().st_size} bytes)')

# ---------------------------------------------------------------------------------------------
# Review renders of the baked asset and the manifest.
review('operator', final=True)
triangles = sum(len(p.vertices) - 2 for p in body.data.polygons)
manifest = {
    'model': 'Kannon operator', 'raw': str(raw_path.name), 'vertices': len(body.data.vertices), 'triangles': triangles,
    'materials': [m.name for m in body.data.materials], 'bones': [b.name for b in rig.data.bones],
    'clips': {name: {'frames': frames, 'fps': 30} for name, (action, frames) in clips.items()},
    'inheritedClips': ['Idle', 'Walk', 'Run', 'Jump', 'Aim', 'Fire', 'Reload'],
    'unchangedClips': ['Idle', 'Jump', 'Aim', 'Fire', 'Reload'],
    'authoredClips': ['Crouch', 'CrouchWalk', 'Slide'], 'retiredClips': ['Heal'],
    'referenceSpeeds': {'Walk': 6.5, 'Run': 9.0, 'CrouchWalk': CROUCH_SPEED},
    'uprightGait': {'clips': ['Walk', 'Run'], 'leanBackDegrees': GAIT_LEAN, 'skullAheadMetres': GAIT_HEAD_AHEAD,
                    'kept': 'root, pelvis and leg tracks sample for sample (CMU-derived)',
                    'changed': 'spine lean, head tip and both arm chains, keyed at every 120 Hz sample'},
    'crouchWalk': {'referenceSpeed': CROUCH_SPEED, 'frames': CROUCH_FRAMES, 'duty': DUTY, 'strokeMetres': STROKE,
                   'feetAheadOfHipsMetres': FEET_AHEAD, 'swingLiftMetres': SWING_LIFT, 'phaseShiftToMatchWalk': PHASE_SHIFT},
    'postureRules': {'source': 'shared/physics.ts', 'postureHeight': POSTURE_HEIGHT, 'eyeHeight': EYE_HEIGHT,
                     'helmetTopAboveSkullCentre': TOP_ABOVE_CENTRE, 'supportArmReach': SUPPORT_REACH},
    'weaponSocket': {'parent': 'hand_r', 'restBlender': list(SOCKET_REST), 'restGltf': [SOCKET_REST.x, SOCKET_REST.z, -SOCKET_REST.y],
                     'axes': 'glTF -Z forward along the barrel, +Y up (identity rotation at rest)'},
    'atlas': {'size': SIZE, 'bakeSamples': BAKE_SAMPLES, 'aoSamples': AO_SAMPLES, 'aoDistanceMetres': 0.08,
              'textures': list(atlas_images)},
    'poseAudit': POSE_AUDIT, 'fitAudit': FIT_AUDIT, 'animationExport': export_review,
    'units': 'metres', 'forward': 'glTF -Z', 'up': 'glTF +Y',
    'source': ('Rig and clips from art/source/scout.blend: Idle, Jump, Aim, Fire and Reload unchanged; Walk and Run keep the '
               'hips and legs derived from CMU 09_01, frames 15-103 (see art/source/motion/cmu-09/CMU-USAGE-NOTICE.md), with '
               'an original upright upper body. Operator geometry, materials and the Crouch, CrouchWalk and Slide clips are '
               'original Kannon work; no third-party textures or models.'),
    'seconds': round(time.time() - STARTED, 1),
}
(SOURCE / 'operator-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', newline='\n')
print('KANNON_OPERATOR_COMPLETE ' + json.dumps({'raw': str(raw_path), 'triangles': triangles, 'vertices': len(body.data.vertices)}))
