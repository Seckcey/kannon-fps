"""Kannon Arena first-person weapons and gloved arms (weapons-v1), modelled and baked from code.

Every model is an original design: five firearms, a knife, a frag grenade and a pair of gloved
forearms. Firearms are profile extrusions, lathes and lofts with machined bevels and weighted
normals; hands are jointed fingers, palm and thumb fused by a voxel remesh. Procedural materials
(hard-anodised aluminium, phosphate steel, textured polymer, walnut, rubber, synthetic leather,
ripstop) carry edge wear, cavity dirt and micro surface detail. Cycles bakes them into one base
colour map, one packed occlusion/roughness/metal map and one tangent-space normal map per model.

  node scripts/blender/run_blender.mjs --python scripts/blender/generate_weapons.py -- --stage all

Stages
  look   build the models and render look-dev previews from the procedural materials (fast loop)
  all    build, unwrap, bake, export <work>/weapons-raw.glb and render the shipped-texture previews
         into art/source/weapons/ (finish_weapons.mjs then writes public/models/weapons-v1.glb)
  previews  re-render the shipped-texture previews from <work>/weapons.blend without re-baking

Options
  --work DIR           scratch folder for the raw GLB, baked PNGs and the .blend (default: temp)
  --only a,b           build only these models (see MODEL_IDS)
  --texture-scale F    multiply every bake size (0.25 for quick tests)
  --samples N          bake samples (default 64)
  --preview-samples N  preview render samples (default 64)
  --views a,b          render only these previews
  --debug-tris         list every part of 300 triangles or more

The look-dev backdrop uses the Poly Haven asphalt and concrete in C:/it/kannon-assets when
present (never shipped) and plain grey otherwise.

Conventions (docs/WEAPONS_ART.md): metres; Blender +Y forward and +Z up, exported as glTF -Z
forward and +Y up. A firearm's origin is the right palm grip point; `grip_r` and `grip_l` carry
the rotation that seats the matching arm (parent the arm to the anchor). An arm's origin is its
palm grip point and its forearm runs toward glTF +Z.
"""
import argparse
import json
import math
import sys
import tempfile
import time
from pathlib import Path

import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[2]
ART = ROOT / 'art' / 'source' / 'weapons'
POLYHAVEN = Path('C:/it/kannon-assets/polyhaven/textures')
MODEL_IDS = ['kr5', 'hornet9', 'breaker12', 'longbow', 'sentry9', 'knife', 'frag', 'arm_left', 'arm_right']
ROOT_NAMES = {'kr5': 'weapon_kr5', 'hornet9': 'weapon_hornet9', 'breaker12': 'weapon_breaker12', 'longbow': 'weapon_longbow',
              'sentry9': 'weapon_sentry9', 'knife': 'knife', 'frag': 'frag', 'arm_left': 'arm_left', 'arm_right': 'arm_right'}
# Bake sizes. The carbine is the default weapon and fills the most screen; arms are always visible.
TEXTURE_SIZE = {'kr5': 2048, 'hornet9': 1024, 'breaker12': 1024, 'longbow': 1024, 'sentry9': 1024, 'knife': 512, 'frag': 512,
                'arm_left': 1024, 'arm_right': 1024}
X, Y, Z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
O = Vector((0, 0, 0))
SEP = '__'  # Blender object names are '<root>__<node>'; finish_weapons.mjs strips the prefix.
DEBUG_TRIS = '--debug-tris' in sys.argv
SLIDE_TRAVEL = 0.022  # Sentry 9 slide travel per shot (docs/WEAPONS_ART.md); the slide clears the hand over it
HAND_POINTS = {}      # arm id -> vertices (Blender arm space), filled when the arms are built (before the guns)


def log(*parts):
    print('[weapons]', *parts, flush=True)


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument('--stage', default='look', choices=['look', 'all', 'previews'])
    p.add_argument('--work', default=str(Path(tempfile.gettempdir()) / 'kannon-weapons-v1'))
    p.add_argument('--only', default='')
    p.add_argument('--texture-scale', type=float, default=1.0)
    p.add_argument('--samples', type=int, default=64)
    p.add_argument('--preview-samples', type=int, default=64)
    p.add_argument('--views', default='')
    p.add_argument('--debug-tris', action='store_true')
    return p.parse_args(argv)


# =============================================================================================
# Scene and geometry helpers
# =============================================================================================

BUILD = None  # collection new objects go into


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.scale_length = 1.0
    if scene.world is None:
        scene.world = bpy.data.worlds.new('World')
    return scene


def collection(name, parent=None):
    coll = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    parent = parent or bpy.context.scene.collection
    if coll.name not in parent.children:
        parent.children.link(coll)
    return coll


def apply_mods(ob):
    """Bake the modifier stack into the mesh without operators (safe in background mode)."""
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    old = ob.data
    ob.modifiers.clear()
    ob.data = me
    me.name = ob.name
    if old.users == 0:
        bpy.data.meshes.remove(old)
    return ob


def obj_from_bm(name, bm, mat=None):
    me = bpy.data.meshes.new(name)
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    BUILD.objects.link(ob)
    if mat is not None:
        me.materials.append(mat)
    return ob


def finish(ob, bevel=0.0, seg=1, angle=30, wn=True, smooth=50, profile=0.5):
    """Machined edges: angle-limited bevel, then flat faces with weighted normals."""
    if bevel > 0:
        m = ob.modifiers.new('Bevel', 'BEVEL')
        m.width = bevel
        m.segments = seg
        m.limit_method = 'ANGLE'
        m.angle_limit = math.radians(angle)
        m.use_clamp_overlap = True
        m.profile = profile
        m.miter_outer = 'MITER_ARC'
        apply_mods(ob)
    me = ob.data
    if smooth:
        me.shade_smooth()
        me.set_sharp_from_angle(angle=math.radians(smooth))
    if wn:
        m = ob.modifiers.new('Weighted normals', 'WEIGHTED_NORMAL')
        m.keep_sharp = True
        m.mode = 'FACE_AREA'
        m.weight = 50
        apply_mods(ob)
    return ob


def prism(name, pts, frame, d0, d1, mat, raw=False, **kw):
    """A 2D polygon `pts` in the frame's (u, v) plane extruded along n from d0 to d1."""
    o, u, v, n = frame
    bm = bmesh.new()
    a = [bm.verts.new(o + u * x + v * y + n * d0) for x, y in pts]
    b = [bm.verts.new(o + u * x + v * y + n * d1) for x, y in pts]
    bm.faces.new(a)
    bm.faces.new(b[::-1])
    k = len(pts)
    for i in range(k):
        j = (i + 1) % k
        bm.faces.new((a[i], b[i], b[j], a[j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    ob = obj_from_bm(name, bm, mat)
    return ob if raw else finish(ob, **kw)


SIDE = (O, Y, Z, X)    # (y, z) profile extruded along x
FRONT = (O, X, Z, Y)   # (x, z) profile extruded along y
TOP = (O, X, Y, Z)     # (x, y) profile extruded along z


def side(name, pts, x0, x1, mat, **kw):
    return prism(name, pts, SIDE, x0, x1, mat, **kw)


def sym(name, pts, width, mat, x=0.0, **kw):
    """Side profile extruded symmetrically about x."""
    return side(name, pts, x - width / 2, x + width / 2, mat, **kw)


def front(name, pts, y0, y1, mat, **kw):
    return prism(name, pts, FRONT, y0, y1, mat, **kw)


def top(name, pts, z0, z1, mat, **kw):
    return prism(name, pts, TOP, z0, z1, mat, **kw)


def box(name, c, s, mat, bevel=0.0007, seg=1, **kw):
    cx, cy, cz = c
    sx, sy, sz = s
    pts = [(cy - sy / 2, cz - sz / 2), (cy + sy / 2, cz - sz / 2), (cy + sy / 2, cz + sz / 2), (cy - sy / 2, cz + sz / 2)]
    return side(name, pts, cx - sx / 2, cx + sx / 2, mat, bevel=bevel, seg=seg, **kw)


def pane(name, pts, y, mat):
    """One-sided window glass: the (x, z) outline `pts` at `y`, facing the shooter (-Y). A single
    sheet, so a blended material is seen through exactly once."""
    bm = bmesh.new()
    face = bm.faces.new([bm.verts.new((x, y, z)) for x, z in pts])
    bm.normal_update()
    if face.normal.y > 0:
        face.normal_flip()
    return obj_from_bm(name, bm, mat)


def basis_for(axis, up=None):
    a = Vector(axis).normalized()
    ref = Vector(up) if up is not None else (Z if abs(a.dot(Z)) < 0.9 else X)
    b2 = (ref - a * ref.dot(a)).normalized()
    b1 = b2.cross(a).normalized()
    return a, b1, b2


def lathe(name, prof, mat, origin=(0, 0, 0), axis=(0, 1, 0), seg=24, phase=0.0, up=None, raw=False, scale2=(1.0, 1.0), closed=False, **kw):
    """Revolve [(s, r), ...] around `axis` through `origin`; r == 0 makes a pole. `closed`
    treats the profile as a loop (a hollow ring such as an eyecup) instead of capping its ends."""
    o = Vector(origin)
    a, b1, b2 = basis_for(axis, up)
    bm = bmesh.new()
    rings = []
    for s, r in prof:
        if r < 1e-7:
            rings.append([bm.verts.new(o + a * s)])
            continue
        ring = []
        for i in range(seg):
            t = phase + 2 * math.pi * i / seg
            ring.append(bm.verts.new(o + a * s + (b1 * math.cos(t) * scale2[0] + b2 * math.sin(t) * scale2[1]) * r))
        rings.append(ring)
    pairs = list(zip(rings, rings[1:])) + ([(rings[-1], rings[0])] if closed else [])
    for r0, r1 in pairs:
        if len(r0) == 1 and len(r1) == 1:
            continue
        for i in range(seg):
            j = (i + 1) % seg
            if len(r0) == 1:
                bm.faces.new((r0[0], r1[j], r1[i]))
            elif len(r1) == 1:
                bm.faces.new((r0[i], r0[j], r1[0]))
            else:
                bm.faces.new((r0[i], r0[j], r1[j], r1[i]))
    if not closed and len(rings[0]) > 1:
        bm.faces.new(rings[0][::-1])
    if not closed and len(rings[-1]) > 1:
        bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    ob = obj_from_bm(name, bm, mat)
    return ob if raw else finish(ob, **kw)


def cyl(name, p0, p1, r, mat, seg=16, r1=None, **kw):
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    return lathe(name, [(0.0, r), (d.length, r if r1 is None else r1)], mat, origin=p0, axis=d, seg=seg, **kw)


def capsule(name, p0, p1, r0, r1, mat, seg=12, rings=4, flat=1.0, up=None, raw=True):
    """Round-ended tube from p0 to p1 (radii r0 -> r1); `flat` squashes the cross-section."""
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    L = max(d.length, 1e-5)
    prof = []
    for i in range(rings, 0, -1):
        t = (math.pi / 2) * i / rings
        prof.append((-r0 * math.sin(t), r0 * math.cos(t)))
    prof.append((0.0, r0))
    prof.append((L, r1))
    for i in range(1, rings + 1):
        t = (math.pi / 2) * i / rings
        prof.append((L + r1 * math.sin(t), r1 * math.cos(t)))
    return lathe(name, prof, mat, origin=p0, axis=d, seg=seg, up=up, raw=raw, scale2=(1.0, flat))


def loft(name, rings, mat, cap0=True, cap1=True, raw=False, **kw):
    bm = bmesh.new()
    vs = [[bm.verts.new(Vector(p)) for p in ring] for ring in rings]
    k = len(rings[0])
    for r0, r1 in zip(vs, vs[1:]):
        for i in range(k):
            j = (i + 1) % k
            bm.faces.new((r0[i], r0[j], r1[j], r1[i]))
    if cap0:
        bm.faces.new(vs[0][::-1])
    if cap1:
        bm.faces.new(vs[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    ob = obj_from_bm(name, bm, mat)
    return ob if raw else finish(ob, **kw)


def rrect(w, h, r, n=3, cx=0.0, cy=0.0):
    """Rounded rectangle, counter-clockwise from the top-right corner."""
    r = max(0.0, min(r, w / 2 - 1e-6, h / 2 - 1e-6))
    if r < 1e-6 or n == 0:
        return [(cx + w / 2, cy + h / 2), (cx - w / 2, cy + h / 2), (cx - w / 2, cy - h / 2), (cx + w / 2, cy - h / 2)]
    pts = []
    for qx, qy, a0 in ((w / 2 - r, h / 2 - r, 0), (-w / 2 + r, h / 2 - r, 90), (-w / 2 + r, -h / 2 + r, 180), (w / 2 - r, -h / 2 + r, 270)):
        for i in range(n + 1):
            a = math.radians(a0 + 90 * i / n)
            pts.append((cx + qx + r * math.cos(a), cy + qy + r * math.sin(a)))
    return pts


def moulded_section(w, h, r, bulge, cx=0.0, cy=0.0, crown=0.0, long_side=9, short_side=3):
    """Stock cross-section: a rounded rectangle (always 44 points, so sections loft together)
    whose long sides bow out by `bulge` (fraction of the half-width) at mid-height and whose top
    crowns by `crown` metres, so moulded stocks never read as flat slabs."""
    corner = 4
    pts = rrect(w, h, r, corner)
    k = corner + 1
    corners = [pts[i * k:(i + 1) * k] for i in range(4)]
    dense = []
    for ci in range(4):
        dense.extend(corners[ci])
        a, b = corners[ci][-1], corners[(ci + 1) % 4][0]
        steps = short_side if ci in (0, 2) else long_side   # top and bottom are the short sides
        for s in range(1, steps + 1):
            f = s / (steps + 1)
            dense.append((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f))
    out = []
    for x, y in dense:
        v = 2 * y / h
        grow = 1.0 + bulge * max(0.0, 1.0 - v * v)
        lift = crown * max(0.0, 1.0 - (2 * x / w) ** 2) if y > 0 else 0.0
        out.append((cx + x * grow, cy + y + lift))
    return out


def superellipse(a, b, p=2.5, n=24, cx=0.0, cy=0.0, phase=0.0):
    pts = []
    for i in range(n):
        t = phase + 2 * math.pi * i / n
        c, s = math.cos(t), math.sin(t)
        pts.append((cx + a * math.copysign(abs(c) ** (2 / p), c), cy + b * math.copysign(abs(s) ** (2 / p), s)))
    return pts


def ring3(pts, o, u, v):
    o, u, v = Vector(o), Vector(u), Vector(v)
    return [o + u * x + v * y for x, y in pts]


def join(objs, name):
    objs = [o for o in objs if o is not None]
    if len(objs) > 1:
        with bpy.context.temp_override(active_object=objs[0], object=objs[0], selected_objects=objs, selected_editable_objects=objs):
            bpy.ops.object.join()
    objs[0].name = name
    objs[0].data.name = name
    return objs[0]


def cut(target, cutters, solver='EXACT'):
    """Boolean difference with all cutters (joined into one tool first)."""
    cutters = [c for c in cutters if c is not None]
    if not cutters:
        return target
    tool = join(cutters, target.name + '_cut')
    m = target.modifiers.new('Cut', 'BOOLEAN')
    m.operation = 'DIFFERENCE'
    m.solver = solver
    m.object = tool
    apply_mods(target)
    bpy.data.objects.remove(tool, do_unlink=True)
    return target


def transform_obj(ob, matrix):
    ob.data.transform(matrix)
    ob.data.update()
    return ob


def grid_tris(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


# =============================================================================================
# Materials
# =============================================================================================

BAKE_SOCKETS = {}   # material name -> {'base', 'rough', 'metal', 'ao', 'bsdf', 'out', 'emit'}
MATS = {}


def sock(node, ident, out=False):
    for s in (node.outputs if out else node.inputs):
        if s.identifier == ident:
            return s
    raise KeyError(f'{node.bl_idname} has no socket {ident}')


class Graph:
    def __init__(self, mat):
        self.nt = mat.node_tree
        self.nodes = self.nt.nodes
        self.links = self.nt.links

    def new(self, kind, **props):
        node = self.nodes.new(kind)
        for key, value in props.items():
            setattr(node, key, value)
        return node

    def put(self, socket, value):
        if isinstance(value, bpy.types.NodeSocket):
            self.links.new(value, socket)
        elif isinstance(value, (tuple, list)) and socket.type == 'RGBA' and len(value) == 3:
            socket.default_value = (*value, 1.0)
        else:
            socket.default_value = value

    def math(self, op, a, b=None, clamp=False):
        node = self.new('ShaderNodeMath', operation=op, use_clamp=clamp)
        self.put(node.inputs[0], a)
        if b is not None:
            self.put(node.inputs[1], b)
        return node.outputs[0]

    def mul(self, a, b, clamp=False):
        return self.math('MULTIPLY', a, b, clamp)

    def add(self, a, b, clamp=False):
        return self.math('ADD', a, b, clamp)

    def sub(self, a, b, clamp=False):
        return self.math('SUBTRACT', a, b, clamp)

    def ramp(self, value, lo, hi, smooth=True):
        """0 below lo, 1 above hi (clamped, smoothstep)."""
        node = self.new('ShaderNodeMapRange', data_type='FLOAT', clamp=True, interpolation_type='SMOOTHSTEP' if smooth else 'LINEAR')
        self.put(node.inputs[0], value)
        node.inputs[1].default_value = lo
        node.inputs[2].default_value = hi
        node.inputs[3].default_value = 0.0
        node.inputs[4].default_value = 1.0
        return node.outputs[0]

    def mix(self, fac, a, b, blend='MIX'):
        node = self.new('ShaderNodeMix', data_type='RGBA', blend_type=blend, clamp_factor=True)
        self.put(sock(node, 'Factor_Float'), fac)
        self.put(sock(node, 'A_Color'), a)
        self.put(sock(node, 'B_Color'), b)
        return sock(node, 'Result_Color', True)

    def lerp(self, fac, a, b):
        node = self.new('ShaderNodeMix', data_type='FLOAT', clamp_factor=True)
        self.put(sock(node, 'Factor_Float'), fac)
        self.put(sock(node, 'A_Float'), a)
        self.put(sock(node, 'B_Float'), b)
        return sock(node, 'Result_Float', True)

    def vmath(self, op, a, b=None, scale=None):
        node = self.new('ShaderNodeVectorMath', operation=op)
        self.put(node.inputs[0], a)
        if b is not None:
            self.put(node.inputs[1], b)
        if scale is not None:
            self.put(node.inputs[3], scale)
        return node.outputs['Value' if op in ('DOT_PRODUCT', 'LENGTH', 'DISTANCE') else 'Vector']

    def noise(self, vec, scale, detail=4.0, rough=0.5, distortion=0.0, lacunarity=2.0):
        node = self.new('ShaderNodeTexNoise', noise_dimensions='3D')
        self.put(node.inputs['Vector'], vec)
        node.inputs['Scale'].default_value = scale
        node.inputs['Detail'].default_value = detail
        node.inputs['Roughness'].default_value = rough
        node.inputs['Distortion'].default_value = distortion
        node.inputs['Lacunarity'].default_value = lacunarity
        return node.outputs['Factor']

    def voronoi(self, vec, scale, feature='F1', randomness=1.0, output='Distance'):
        node = self.new('ShaderNodeTexVoronoi', voronoi_dimensions='3D', feature=feature)
        self.put(node.inputs['Vector'], vec)
        node.inputs['Scale'].default_value = scale
        node.inputs['Randomness'].default_value = randomness
        return node.outputs[output]

    def stretch(self, vec, sx, sy, sz):
        return self.vmath('MULTIPLY', vec, (sx, sy, sz))


def material_base(name):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.use_backface_culling = True
    g = Graph(mat)
    out = g.nodes['Material Output']
    bsdf = g.nodes['Principled BSDF']
    return mat, g, out, bsdf


def surface(name, base, rough, metal=0.0, worn=None, worn_rough=None, worn_metal=None, wear=0.5, dirt=0.35,
            dirt_color=(0.028, 0.024, 0.019), variation=0.10, micro='satin', micro_scale=1.0, micro_depth=0.00008,
            edge_radius=0.0024, round_radius=0.0010, scratches=0.0, scratch_axis='y', coat=0.0, wood=None, zone=None, dust=0.0,
            dust_color=(0.20, 0.17, 0.13)):
    """A procedural PBR surface with edge wear, cavity dirt, field dust and micro relief.

    `zone` (glove) = dict(axis=(x, y, z), leather=material params) switches palm-facing faces
    (normals pointing at the held axis through the origin) to a second surface."""
    mat, g, out, bsdf = material_base(name)
    worn = worn or base
    worn_rough = rough if worn_rough is None else worn_rough
    worn_metal = metal if worn_metal is None else worn_metal
    tc = g.new('ShaderNodeTexCoord')
    geo = g.new('ShaderNodeNewGeometry')
    p = tc.outputs['Object']
    # Edge mask from the difference between a wide bevel normal and the true normal.
    bev = g.new('ShaderNodeBevel', samples=8)
    bev.inputs['Radius'].default_value = edge_radius
    edge = g.ramp(g.sub(1.0, g.vmath('DOT_PRODUCT', bev.outputs['Normal'], geo.outputs['Normal'])), 0.004, 0.07)
    ao_node = g.new('ShaderNodeAmbientOcclusion', samples=12, only_local=False)
    ao_node.inputs['Distance'].default_value = 0.012
    cavity = g.sub(1.0, ao_node.outputs['AO'], clamp=True)
    ao_wide = g.new('ShaderNodeAmbientOcclusion', samples=12, only_local=False)
    ao_wide.inputs['Distance'].default_value = 0.035
    n_fine = g.noise(p, 220.0, 6.0, 0.6)
    n_mid = g.noise(p, 45.0, 5.0, 0.55)
    n_big = g.noise(p, 9.0, 3.0, 0.5)
    # Wear: exposed edges, broken up by noise, never inside crevices.
    wear_raw = g.mul(edge, g.add(0.35, g.mul(n_mid, 1.1)))
    wear_mask = g.mul(g.ramp(g.add(wear_raw, g.mul(g.sub(n_fine, 0.5), 0.5)), 0.42, 0.62), g.sub(1.0, g.mul(cavity, 2.5), clamp=True))
    wear_mask = g.mul(wear_mask, wear, clamp=True)
    if scratches > 0:
        axis = {'x': (6.0, 900.0, 900.0), 'y': (900.0, 6.0, 900.0), 'z': (900.0, 900.0, 6.0)}[scratch_axis]
        lines = g.noise(g.stretch(p, *axis), 1.0, 2.0, 0.5, distortion=0.4)
        band = g.ramp(g.math('ABSOLUTE', g.sub(lines, 0.5)), 0.012, 0.0, smooth=False)
        gate = g.ramp(g.noise(p, 14.0, 2.0), 0.55, 0.7)
        scratch = g.mul(g.mul(band, gate), scratches, clamp=True)
        wear_mask = g.math('MAXIMUM', wear_mask, g.mul(scratch, 0.6))
    dirt_mask = g.mul(g.ramp(g.add(cavity, g.mul(g.sub(n_big, 0.5), 0.5)), 0.18, 0.7), dirt, clamp=True)
    # Base colour with broad tonal variation, worn edges and grime.
    if wood:
        wave = g.new('ShaderNodeTexWave', wave_type='BANDS', bands_direction='Y', wave_profile='SIN')
        warp = g.vmath('ADD', p, g.vmath('SCALE', g.noise_color(p, 22.0, 3.0), scale=0.010))
        g.links.new(warp, wave.inputs['Vector'])
        wave.inputs['Scale'].default_value = wood.get('rings', 70.0)
        wave.inputs['Distortion'].default_value = 3.0
        wave.inputs['Detail'].default_value = 3.0
        grain = g.ramp(wave.outputs['Factor'], 0.15, 0.95)
        fibre = g.noise(g.stretch(p, 500.0, 6.0, 500.0), 1.0, 3.0, 0.6)
        tone = g.mix(g.add(g.mul(grain, 0.75), g.mul(fibre, 0.25)), wood['dark'], wood['light'])
        colour = tone
    else:
        colour_var = g.add(1.0, g.mul(g.sub(n_mid, 0.5), variation * 2))
        colour = _scale_colour(g, base, colour_var)
    colour = g.mix(wear_mask, colour, worn)
    colour = g.mix(g.mul(dirt_mask, 0.65), colour, dirt_color)
    colour = g.mix(g.mul(cavity, 0.45), colour, (0.0, 0.0, 0.0))
    dust_mask = None
    if dust > 0:
        # Field dust: a light, blotchy film on upward-facing surfaces (object space, so it bakes the
        # same whatever the preview pose) and packed into crevices; worn edges stay clean.
        up = g.vmath('DOT_PRODUCT', tc.outputs['Normal'], (0.0, 0.0, 1.0))
        blotch = g.ramp(g.add(n_big, g.mul(g.sub(n_mid, 0.5), 0.6)), 0.38, 0.72)
        film = g.mul(g.ramp(up, 0.25, 0.95), blotch)
        packed = g.mul(g.ramp(cavity, 0.15, 0.55), g.ramp(n_mid, 0.35, 0.6))
        dust_mask = g.mul(g.mul(g.math('MAXIMUM', g.mul(film, 0.8), packed), g.sub(1.0, wear_mask, clamp=True)), dust, clamp=True)
        colour = g.mix(dust_mask, colour, dust_color)
    rough_s = g.add(rough, g.add(g.mul(g.sub(n_mid, 0.5), 0.10), g.mul(g.sub(n_fine, 0.5), 0.06)))
    rough_s = g.lerp(wear_mask, rough_s, worn_rough)
    rough_s = g.add(rough_s, g.mul(dirt_mask, 0.18), clamp=True)
    if dust_mask is not None:
        rough_s = g.add(rough_s, g.mul(dust_mask, 0.35), clamp=True)
    metal_s = g.lerp(wear_mask, metal, worn_metal)
    if dust_mask is not None:
        metal_s = g.lerp(dust_mask, metal_s, 0.0)
    # Micro relief on top of a small rounding of every edge.
    small = g.new('ShaderNodeBevel', samples=8)
    small.inputs['Radius'].default_value = round_radius
    height = micro_height(g, p, micro, micro_scale)
    bump = g.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = 1.0
    bump.inputs['Distance'].default_value = micro_depth
    if height is not None:
        g.put(bump.inputs['Height'], height)
    else:
        bump.inputs['Strength'].default_value = 0.0
    g.links.new(small.outputs['Normal'], bump.inputs['Normal'])
    normal = bump.outputs['Normal']
    if zone:
        colour, rough_s, metal_s, normal = glove_zones(g, tc, colour, rough_s, metal_s, normal, small, zone, n_mid, n_fine, cavity, edge)
    g.links.new(colour, bsdf.inputs['Base Color'])
    g.links.new(rough_s, bsdf.inputs['Roughness'])
    g.links.new(metal_s, bsdf.inputs['Metallic'])
    g.links.new(normal, bsdf.inputs['Normal'])
    if coat:
        bsdf.inputs['Coat Weight'].default_value = coat
        bsdf.inputs['Coat Roughness'].default_value = 0.25
    emit = g.new('ShaderNodeEmission')
    BAKE_SOCKETS[mat.name] = dict(base=colour, rough=rough_s, metal=metal_s, ao=ao_wide.outputs['AO'], bsdf=bsdf, out=out, emit=emit, graph=g)
    MATS[name] = mat
    return mat


def _scale_colour(g, base, factor):
    rgb = g.new('ShaderNodeCombineColor')
    for i, channel in enumerate(('Red', 'Green', 'Blue')):
        g.put(rgb.inputs[channel], g.mul(base[i], factor))
    return rgb.outputs['Color']


def _noise_color(self, vec, scale, detail=3.0):
    node = self.new('ShaderNodeTexNoise', noise_dimensions='3D')
    self.put(node.inputs['Vector'], vec)
    node.inputs['Scale'].default_value = scale
    node.inputs['Detail'].default_value = detail
    centred = self.new('ShaderNodeVectorMath', operation='SUBTRACT')
    self.links.new(node.outputs['Color'], centred.inputs[0])
    centred.inputs[1].default_value = (0.5, 0.5, 0.5)
    return centred.outputs['Vector']


Graph.noise_color = _noise_color


def micro_height(g, p, kind, scale):
    """Height fields for surface relief (metres are set by the bump distance)."""
    if kind == 'none':
        return None
    if kind == 'satin':
        return g.noise(p, 900.0 * scale, 3.0, 0.5)
    if kind == 'cast':
        return g.add(g.noise(p, 420.0 * scale, 4.0, 0.55), g.mul(g.noise(p, 1600.0 * scale, 2.0), 0.4))
    if kind == 'stipple':
        cells = g.voronoi(p, 1100.0 * scale, randomness=0.9)
        return g.add(g.ramp(cells, 0.0, 0.42), g.mul(g.noise(p, 2000.0 * scale, 2.0), 0.3))
    if kind == 'brushed':
        return g.noise(g.stretch(p, 2400.0 * scale, 4.0, 2400.0 * scale), 1.0, 3.0, 0.6)
    if kind == 'rubber':
        return g.add(g.noise(p, 1500.0 * scale, 3.0, 0.6), g.mul(g.voronoi(p, 700.0 * scale), 0.5))
    if kind == 'knurl':
        a = g.math('SINE', g.mul(g.add(sep_axis(g, p, 0), sep_axis(g, p, 1)), 2200.0 * scale))
        b = g.math('SINE', g.mul(g.sub(sep_axis(g, p, 0), sep_axis(g, p, 1)), 2200.0 * scale))
        return g.mul(g.math('ABSOLUTE', a), g.math('ABSOLUTE', b))
    if kind == 'grooves':  # fine circumferential machining marks on round parts (lathe axis y)
        return g.math('SINE', g.mul(sep_axis(g, p, 1), 9000.0 * scale))
    if kind == 'fabric':  # ripstop: fine weave with a faint 5 mm reinforcement grid and soft creases
        u = sep_axis(g, p, 0)
        v = sep_axis(g, p, 1)
        w = sep_axis(g, p, 2)
        weave = g.mul(g.math('SINE', g.mul(g.add(u, w), 5200.0 * scale)), g.math('SINE', g.mul(v, 5200.0 * scale)))
        rip_a = g.ramp(g.math('ABSOLUTE', g.math('SINE', g.mul(g.add(u, w), 600.0 * scale))), 0.975, 1.0)
        rip_b = g.ramp(g.math('ABSOLUTE', g.math('SINE', g.mul(v, 600.0 * scale))), 0.975, 1.0)
        creases = g.noise(g.stretch(p, 60.0, 260.0, 60.0), 1.0, 3.0, 0.55)
        return g.add(g.mul(weave, 0.25), g.add(g.mul(g.math('MAXIMUM', rip_a, rip_b), 0.22), g.mul(creases, 1.4)))
    if kind == 'textile':  # stretch knit on glove backs
        knit = g.mul(g.math('SINE', g.mul(sep_axis(g, p, 0), 6500.0 * scale)), g.math('SINE', g.mul(g.add(sep_axis(g, p, 1), sep_axis(g, p, 2)), 6500.0 * scale)))
        return g.add(g.mul(knit, 0.3), g.add(g.noise(p, 2600.0 * scale, 3.0, 0.6), g.mul(g.noise(p, 160.0, 3.0), 1.2)))
    if kind == 'leather':
        cells = g.voronoi(p, 1400.0 * scale, randomness=1.0)
        return g.add(g.ramp(cells, 0.0, 0.5), g.mul(g.noise(p, 600.0 * scale, 4.0), 0.5))
    if kind == 'foam':
        return g.add(g.noise(p, 700.0 * scale, 4.0, 0.6), g.mul(g.voronoi(p, 380.0 * scale), 0.6))
    raise ValueError(kind)


def sep_axis(g, p, index):
    node = g.new('ShaderNodeSeparateXYZ')
    g.put(node.inputs['Vector'], p)
    return node.outputs[index]


def glove_zones(g, tc, colour, rough_s, metal_s, normal, small, zone, n_mid, n_fine, cavity, edge):
    """Palm-facing faces (the inside of the fist) become synthetic leather with a stitched seam."""
    axis = Vector(zone['axis']).normalized()
    p = tc.outputs['Object']
    n = tc.outputs['Normal']
    along = g.vmath('SCALE', axis, scale=g.vmath('DOT_PRODUCT', p, axis))
    radial = g.vmath('NORMALIZE', g.vmath('SUBTRACT', p, along))
    facing = g.sub(0.0, g.vmath('DOT_PRODUCT', n, radial))
    reach = g.vmath('LENGTH', p)
    near = g.ramp(reach, zone.get('radius', 0.075) + 0.012, zone.get('radius', 0.075), smooth=True)
    inner = g.mul(g.ramp(g.add(facing, g.mul(g.sub(n_mid, 0.5), 0.12)), 0.10, 0.20), near)
    seam = g.mul(g.ramp(g.math('ABSOLUTE', g.sub(g.add(facing, g.mul(g.sub(n_mid, 0.5), 0.12)), 0.10)), 0.012, 0.0), near)
    leather = zone['leather']
    leather_var = g.add(1.0, g.mul(g.sub(n_mid, 0.5), 0.25))
    l_colour = _scale_colour(g, leather['base'], leather_var)
    l_colour = g.mix(g.mul(cavity, 0.5), l_colour, (0.0, 0.0, 0.0))
    colour = g.mix(inner, colour, l_colour)
    colour = g.mix(g.mul(seam, 0.12), colour, zone.get('seam', (0.018, 0.016, 0.014)))
    rough_s = g.lerp(inner, rough_s, g.add(leather['rough'], g.mul(g.sub(n_fine, 0.5), 0.08)))
    rough_s = g.lerp(seam, rough_s, 0.9)
    leather_h = micro_height(g, p, 'leather', 1.0)
    stitch = g.mul(seam, g.ramp(g.math('ABSOLUTE', g.math('SINE', g.mul(g.add(sep_axis(g, p, 0), g.add(sep_axis(g, p, 1), sep_axis(g, p, 2))), 2600.0))), 0.4, 0.9))
    fabric_h = micro_height(g, p, 'textile', zone.get('fabric_scale', 1.0))
    height = g.add(g.lerp(inner, fabric_h, leather_h), g.mul(g.sub(stitch, g.mul(seam, 0.5)), 2.5))
    bump = g.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = 1.0
    bump.inputs['Distance'].default_value = zone.get('depth', 0.00012)
    g.put(bump.inputs['Height'], height)
    g.links.new(small.outputs['Normal'], bump.inputs['Normal'])
    return colour, rough_s, metal_s, bump.outputs['Normal']


def flat_material(name, base, rough, metal=0.0, emission=None, strength=1.0, culling=True):
    mat, g, out, bsdf = material_base(name)
    mat.use_backface_culling = culling
    bsdf.inputs['Base Color'].default_value = (*base, 1.0)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    if emission:
        bsdf.inputs['Emission Color'].default_value = (*emission, 1.0)
        bsdf.inputs['Emission Strength'].default_value = strength
    emit = g.new('ShaderNodeEmission')
    BAKE_SOCKETS[mat.name] = dict(base=tuple(base), rough=rough, metal=metal, ao=1.0, bsdf=bsdf, out=out, emit=emit, graph=g, flat=True)
    MATS[name] = mat
    return mat


def glass_material(name, tint, alpha, rough=0.05):
    """See-through window glass (reflex sights): a faint tint you look through, never baked.
    finish_weapons.mjs ships it as a blended glTF material with this alpha."""
    mat = flat_material(name, tint, rough, 0.0)
    bsdf = BAKE_SOCKETS[mat.name]['bsdf']
    bsdf.inputs['Alpha'].default_value = alpha
    for attr, value in (('surface_render_method', 'BLENDED'), ('blend_method', 'BLEND')):
        try:
            setattr(mat, attr, value)
        except (AttributeError, TypeError):
            pass
    BAKE_SOCKETS[mat.name]['alpha'] = alpha
    return mat


def srgb_to_linear(c):
    return tuple((v / 12.92) if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


def hexcol(h):
    h = h.lstrip('#')
    return srgb_to_linear(tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)))


# Reflex-sight window: a faint blue-green coated glass. Low alpha keeps a standing target at 20 m
# clearly visible through it; finish_weapons.mjs reads these values from weapons-build.json.
REFLEX_GLASS = dict(tint=hexcol('#6c9aa3'), alpha=0.16, roughness=0.05)


def build_materials():
    """Original Kannon finishes. Colours are sRGB hex for readability, converted to linear."""
    bare_al = hexcol('#a6a8aa')
    bare_steel = hexcol('#8d8f90')
    M = {}
    M['anod_black'] = surface('Anodized_Black', hexcol('#1e1f21'), 0.42, 0.0, worn=bare_al, worn_rough=0.32, worn_metal=1.0, wear=0.55, dirt=0.4, micro='satin', micro_depth=0.00004, scratches=0.15, dust=0.22)
    M['anod_grey'] = surface('Cerakote_Grey', hexcol('#4a4d50'), 0.55, 0.0, worn=bare_al, worn_rough=0.34, worn_metal=1.0, wear=0.45, dirt=0.45, micro='cast', micro_depth=0.00004, scratches=0.25, dust=0.25)
    M['steel'] = surface('Phosphate_Steel', hexcol('#38393a'), 0.5, 0.55, worn=bare_steel, worn_rough=0.28, worn_metal=1.0, wear=0.5, dirt=0.5, micro='cast', micro_depth=0.00004, scratches=0.3, dust=0.2)
    M['steel_dark'] = surface('Nitride_Steel', hexcol('#232425'), 0.36, 0.7, worn=bare_steel, worn_rough=0.25, worn_metal=1.0, wear=0.55, dirt=0.35, micro='satin', micro_depth=0.00003, scratches=0.45, dust=0.18)
    M['steel_bright'] = surface('Bright_Steel', hexcol('#6e7072'), 0.40, 1.0, worn=hexcol('#9a9c9d'), worn_rough=0.28, wear=0.5, dirt=0.5, micro='brushed', micro_depth=0.00002, dust=0.12)
    M['polymer_fde'] = surface('Polymer_FDE', hexcol('#8b7457'), 0.62, 0.0, worn=hexcol('#a08a6c'), worn_rough=0.45, wear=0.45, dirt=0.55, dirt_color=hexcol('#2e261c'), micro='cast', micro_depth=0.00005, variation=0.08, dust=0.16)
    M['polymer_fde_grip'] = surface('Polymer_FDE_Stipple', hexcol('#856f53'), 0.7, 0.0, worn=hexcol('#9c8668'), worn_rough=0.5, wear=0.35, dirt=0.6, dirt_color=hexcol('#2e261c'), micro='stipple', micro_depth=0.00022, dust=0.14)
    M['polymer_black'] = surface('Polymer_Black', hexcol('#262728'), 0.62, 0.0, worn=hexcol('#3b3c3d'), worn_rough=0.45, wear=0.4, dirt=0.45, micro='cast', micro_depth=0.00005, dust=0.25)
    M['polymer_black_grip'] = surface('Polymer_Black_Stipple', hexcol('#242526'), 0.72, 0.0, worn=hexcol('#363738'), worn_rough=0.5, wear=0.3, dirt=0.5, micro='stipple', micro_depth=0.00022, dust=0.2)
    M['polymer_od'] = surface('Polymer_Ranger', hexcol('#4d5240'), 0.62, 0.0, worn=hexcol('#646a55'), worn_rough=0.45, wear=0.45, dirt=0.5, dirt_color=hexcol('#26261c'), micro='cast', micro_depth=0.00005, dust=0.22)
    M['polymer_od_grip'] = surface('Polymer_Ranger_Stipple', hexcol('#4a4f3d'), 0.72, 0.0, worn=hexcol('#5f6551'), worn_rough=0.5, wear=0.35, dirt=0.55, dirt_color=hexcol('#26261c'), micro='stipple', micro_depth=0.00022, dust=0.18)
    M['rubber'] = surface('Rubber', hexcol('#1d1e1f'), 0.82, 0.0, wear=0.15, worn=hexcol('#2e2f30'), dirt=0.5, micro='rubber', micro_depth=0.00012, dust=0.2)
    M['walnut'] = surface('Walnut', hexcol('#5a3a22'), 0.42, 0.0, worn=hexcol('#7a5634'), worn_rough=0.3, wear=0.4, dirt=0.45, micro='satin', micro_depth=0.00002, dust=0.12,
                          wood=dict(dark=hexcol('#40291a'), light=hexcol('#6b4528'), rings=38.0))
    M['brass'] = surface('Brass', hexcol('#b08d4a'), 0.3, 1.0, worn=hexcol('#d2b26e'), worn_rough=0.2, wear=0.4, dirt=0.4, micro='satin', micro_depth=0.00002, dust=0.1)
    M['shell_red'] = surface('Shell_Hull', hexcol('#5e1c18'), 0.5, 0.0, worn=hexcol('#7a2f27'), wear=0.3, dirt=0.4, micro='grooves', micro_depth=0.00002, dust=0.12)
    M['od_paint'] = surface('Frag_OD', hexcol('#4f5638'), 0.55, 0.0, worn=hexcol('#7c7f73'), worn_rough=0.35, worn_metal=1.0, wear=0.45, dirt=0.45, micro='cast', micro_depth=0.00004, dust=0.2)
    M['marking_yellow'] = surface('Marking_Yellow', hexcol('#a88a3a'), 0.55, 0.0, worn=hexcol('#7c7f73'), worn_metal=1.0, wear=0.4, dirt=0.5, micro='cast', micro_depth=0.00003, dust=0.15)
    M['blade'] = surface('Blade_Coated', hexcol('#2b2c2d'), 0.48, 0.3, worn=bare_steel, worn_rough=0.22, worn_metal=1.0, wear=0.65, dirt=0.25, micro='satin', micro_depth=0.00002, scratches=0.5, dust=0.08)
    # Gloves: coyote textile on the back, darker synthetic leather on the palm side.
    glove_zone = lambda axis: dict(axis=axis, radius=0.085, leather=dict(base=hexcol('#33352b'), rough=0.6), seam=hexcol('#1d1e19'), depth=0.00007)
    M['glove_r'] = surface('Glove_Right', hexcol('#4a4e3c'), 0.86, 0.0, worn=hexcol('#5d614d'), wear=0.3, dirt=0.55, dirt_color=hexcol('#24231b'), micro='textile', micro_depth=0.00007,
                           zone=glove_zone(RIGHT_HAND['held_axis_arm']))
    M['glove_l'] = surface('Glove_Left', hexcol('#4a4e3c'), 0.86, 0.0, worn=hexcol('#5d614d'), wear=0.3, dirt=0.55, dirt_color=hexcol('#24231b'), micro='textile', micro_depth=0.00007,
                           zone=glove_zone(LEFT_HAND['held_axis_arm']))
    M['pad'] = surface('Knuckle_Pad', hexcol('#1b1c1d'), 0.66, 0.0, worn=hexcol('#2e3031'), wear=0.3, dirt=0.4, micro='foam', micro_depth=0.00015)
    M['cuff'] = surface('Neoprene_Cuff', hexcol('#1f2021'), 0.8, 0.0, worn=hexcol('#303132'), wear=0.2, dirt=0.4, micro='fabric', micro_scale=1.6, micro_depth=0.00008)
    M['sleeve'] = surface('Ripstop_Sleeve', hexcol('#75684f'), 0.9, 0.0, worn=hexcol('#857a62'), wear=0.25, dirt=0.45, dirt_color=hexcol('#2e281d'), micro='fabric', micro_depth=0.00016, edge_radius=0.004)
    M['velcro'] = surface('Hook_Tape', hexcol('#2a2b26'), 0.95, 0.0, wear=0.1, dirt=0.3, micro='foam', micro_scale=2.5, micro_depth=0.00012)
    # The weapon light's lens is part of the baked body (one draw call fewer than a flat lens).
    M['light_lens'] = surface('Light_Lens', hexcol('#161d20'), 0.10, 0.0, worn=hexcol('#2b3337'), worn_rough=0.2, wear=0.15, dirt=0.25, micro='none', edge_radius=0.0012)
    # Untextured primitives shared by every model. Scope glass stays opaque (the view model is
    # hidden while scoped); reflex windows are see-through so the target stays visible when aiming.
    M['lens'] = flat_material('WeaponLens', hexcol('#0d1416'), 0.04, 0.0)
    M['glass'] = glass_material('WeaponReflexGlass', REFLEX_GLASS['tint'], REFLEX_GLASS['alpha'], REFLEX_GLASS['roughness'])
    M['glow_red'] = flat_material('WeaponGlowRed', (0.02, 0.0, 0.0), 0.4, 0.0, emission=(1.0, 0.06, 0.03), strength=8.0)
    M['glow_green'] = flat_material('WeaponGlowGreen', (0.0, 0.02, 0.0), 0.4, 0.0, emission=(0.35, 1.0, 0.3), strength=5.0)
    return M


# =============================================================================================
# Hands
# =============================================================================================
# A fist is modelled in its grip frame F: the held object's axis is +Z (pinky end to index end),
# the grip's front is +Y and the palm presses on its back-right. Arm space A (the exported frame)
# puts the palm grip point at the origin and the forearm along -Y (glTF +Z). The left hand is the
# same construction mirrored in X.

def unit(*v):
    return Vector(v).normalized()


def frame_matrix(xa, ya, za):
    """3x3 rotation whose columns are the given axes."""
    return Matrix((xa, ya, za)).transposed()


def grip_frame(tilt_deg):
    """Weapon-space frame of a pistol grip whose bottom sits `tilt_deg` behind its top."""
    t = math.radians(tilt_deg)
    za = Vector((0, math.sin(t), math.cos(t)))
    ya = Vector((0, math.cos(t), -math.sin(t)))
    return frame_matrix(X, ya, za)


def handguard_frame(roll_deg):
    """Weapon-space frame for the support hand wrapped round a handguard (held axis forward)."""
    a = math.radians(roll_deg)
    xa = Vector((math.cos(a), 0, math.sin(a)))
    za = Vector((0, 1, 0))
    ya = za.cross(xa)
    return frame_matrix(xa, ya, za)


def ellipse_point(ax, ay, phi, offset):
    return Vector(((ax + offset) * math.cos(phi), (ay + offset) * math.sin(phi), 0.0))


def walk(ax, ay, offset, start, phi0, length, z):
    """Next joint along the offset section, `length` from `start` (searching forward in phi)."""
    phi = phi0
    prev = None
    for _ in range(4000):
        phi += math.radians(0.25)
        q = ellipse_point(ax, ay, phi, offset)
        q.z = z
        if (q - start).length >= length:
            return q, phi
        prev = q
    return prev, phi


def hand_skeleton(spec):
    """Joint positions (frame F) for every finger and the thumb."""
    ax, ay = spec['section']
    fingers = {}
    for f in spec['fingers']:
        r = f['r']
        if f.get('chain'):
            pts = [Vector(f['mcp'])]
            for length, d in zip(f['L'], f['chain']):
                pts.append(pts[-1] + Vector(d).normalized() * length)
            pts[-1] = pts[-2] + (pts[-1] - pts[-2]).normalized() * (f['L'][-1] - r)
            fingers[f['name']] = dict(points=pts, r=r)
            continue
        phi0 = math.radians(f['phi'])
        z = f['z']
        mcp = ellipse_point(ax, ay, phi0, r + f.get('proud', 0.0085))
        mcp.z = z + f.get('mcp_dz', 0.0)
        pts = [mcp]
        phi = phi0
        offset = r + f.get('press', 0.0005)
        for i, length in enumerate(f['L']):
            if i == len(f['L']) - 1:
                length -= r
            q, phi = walk(ax, ay, offset, pts[-1], phi, length, z + f.get('dz', (0, 0, 0))[i])
            pts.append(q)
        fingers[f['name']] = dict(points=pts, r=r)
    thumb = dict(points=[Vector(p) for p in spec['thumb']['points']], radii=spec['thumb']['radii'])
    return dict(fingers=fingers, thumb=thumb)


def arm_frames(spec):
    """Rotation F -> A (arm space) from the reference forearm direction in F."""
    d = Vector(spec['forearm_dir_F']).normalized()
    up = Vector(spec['up_F']).normalized()
    ya = -d
    za = (up - ya * up.dot(ya)).normalized()
    xa = ya.cross(za).normalized()
    r_fa = frame_matrix(xa, ya, za)       # columns: A axes in F
    return r_fa


def section_ring(center, u, v, w, h, n=16, p=2.4):
    return ring3(superellipse(w / 2, h / 2, p, n), center, u, v)


def ellipsoid(name, center, axes, mat, seg=16, rings=10):
    """Ellipsoid with the three given semi-axis vectors."""
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=1.0)
    m = Matrix((Vector(axes[0]), Vector(axes[1]), Vector(axes[2]))).transposed()
    c = Vector(center)
    for v in bm.verts:
        v.co = c + m @ v.co
    return obj_from_bm(name, bm, mat)


def palm_outline(ax, ay, knuckle_phi=6.0, knuckle_out=0.0255, length=0.098, thick=0.031):
    """Cross-section of the palm (frame F, across the hand's width): its inner face hugs the held
    section's back and right side, the back of the hand runs straight from the knuckles to the
    wrist, and the heel wraps behind the back strap."""
    inner = [ellipse_point(ax, ay, math.radians(a), 0.0010) for a in (276, 290, 305, 320, 335, 350, 362, 372)]
    k_front = ellipse_point(ax, ay, math.radians(22), 0.0140)
    k_top = ellipse_point(ax, ay, math.radians(knuckle_phi), knuckle_out)
    back = Vector((0.10, -1.0, 0.0)).normalized()
    d_mid = k_top + back * (length * 0.5) + Vector((0.0025, 0, 0))
    d_end = k_top + back * length
    heel_out = d_end + Vector((-thick * 0.45, -0.010, 0))
    heel_in = Vector((ax * 0.15, -(ay + 0.048), 0))
    strap = Vector((-ax * 0.55, -(ay + 0.016), 0))
    pts = [(p.x, p.y) for p in inner + [k_front, k_top, d_mid, d_end, heel_out, heel_in, strap]]
    return chaikin(pts, 2)


def chaikin(pts, iterations):
    """Corner-cutting subdivision of a closed polygon (rounds every corner)."""
    for _ in range(iterations):
        out = []
        for i in range(len(pts)):
            a, b = pts[i], pts[(i + 1) % len(pts)]
            out.append((0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]))
            out.append((0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]))
        pts = out
    return pts


def phalanx(name, p0, p1, r0, r1, mat, flat=0.88, waist=0.92, seg=16, rings=4, tip=False):
    """One finger bone under the glove: full in the middle, narrower at both joints (so every
    joint shows a crease), with round ends that overlap the neighbouring bone. A fingertip (`tip`)
    tapers straight into its rounded end instead of pinching into a bead."""
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    length = max(d.length, 1e-5)
    a0, a1 = r0 * waist, (r1 if tip else r1 * waist)
    prof = []
    for i in range(rings, 0, -1):
        t = (math.pi / 2) * i / rings
        prof.append((-a0 * math.sin(t), a0 * math.cos(t)))
    prof += [(0.0, a0), (length * 0.30, r0), (length * 0.70, r0 * 0.4 + r1 * 0.6), (length, a1)]
    for i in range(1, rings + 1):
        t = (math.pi / 2) * i / rings
        prof.append((length + a1 * math.sin(t), a1 * math.cos(t)))
    return lathe(name, prof, mat, origin=p0, axis=d, seg=seg, raw=True, scale2=(1.0, flat))


def build_hand_parts(spec, skel, glove):
    """Fingers, thumb, palm, heel and wrist in frame F (pre-mirror) to be fused into one skin."""
    fused = []
    for name, f in skel['fingers'].items():
        pts, r = f['points'], f['r']
        # Tapered bones: the fingertip is clearly slimmer than the base, like a real gloved finger.
        radii = [r * 1.03, r * 0.95, r * 0.87, r * 0.80]
        for i in range(3):
            fused.append(phalanx(f'h_{name}_{i}', pts[i], pts[i + 1], radii[i], radii[i + 1], glove, tip=i == 2))
        # A small knuckle on the back of each finger joint (the outside of the bend).
        for i in (1, 2):
            u = (pts[i] - pts[i - 1]).normalized()
            v = (pts[i + 1] - pts[i]).normalized()
            bend = v - u
            back = -bend.normalized() if bend.length > 0.05 else Vector((pts[i].x, pts[i].y, 0.0)).normalized()
            side = u.cross(back).normalized()
            rk = radii[i]
            fused.append(ellipsoid(f'h_{name}_k{i}', pts[i] + back * rk * 0.16, (u * rk * 0.60, back * rk * 0.55, side * rk * 0.74), glove, 12, 8))
    t = skel['thumb']
    for i in range(len(t['points']) - 1):
        fused.append(phalanx(f'h_thumb_{i}', t['points'][i], t['points'][i + 1], t['radii'][i], t['radii'][i + 1], glove, flat=0.92, waist=0.92 if i else 1.0,
                             tip=i == len(t['points']) - 2))
    for blob in spec.get('blobs', []):
        fused.append(capsule('h_blob', blob[0], blob[1], blob[2], blob[3], glove, seg=16, rings=5, flat=blob[4] if len(blob) > 4 else 1.0))
    # Palm: the outline lofted across the hand's width, narrowing toward both edges.
    ax, ay = spec['section']
    outline = palm_outline(ax, ay, **spec.get('palm_shape', {}))
    rings = []
    z0, z1 = spec['palm_z']
    for f, scale in ((0.0, 0.78), (0.025, 0.88), (0.07, 0.95), (0.15, 1.0), (0.85, 1.0), (0.93, 0.95), (0.975, 0.88), (1.0, 0.78)):
        z = z0 + (z1 - z0) * f
        cx = sum(p[0] for p in outline) / len(outline)
        cy = sum(p[1] for p in outline) / len(outline)
        rings.append([Vector((cx + (x - cx) * scale, cy + (y - cy) * scale, z)) for x, y in outline])
    fused.append(loft('h_palm', rings, glove, raw=True))
    # Wrist and forearm under the glove cuff.
    w = spec['wrist']
    d = Vector(spec['forearm_dir_F']).normalized()
    side_u = Vector(w['u']).normalized()
    side_v = d.cross(side_u).normalized()
    side_u = side_v.cross(d).normalized()
    rings = []
    for t_, wscale in w['profile']:
        c = Vector(w['center']) + d * t_
        rings.append(section_ring(c, side_u, side_v, w['size'][0] * wscale[0], w['size'][1] * wscale[1], 18, 2.2))
    fused.append(loft('h_wrist', rings, glove, raw=True))
    return fused


def fuse(objs, name, voxel, target_tris, smooth_iter=14, factor=0.6):
    ob = join(objs, name)
    m = ob.modifiers.new('Fuse', 'REMESH')
    m.mode = 'VOXEL'
    m.voxel_size = voxel
    m.adaptivity = 0.0
    m.use_smooth_shade = True
    apply_mods(ob)
    s = ob.modifiers.new('Relax', 'SMOOTH')
    s.iterations = smooth_iter
    s.factor = factor
    apply_mods(ob)
    tris = grid_tris(ob)
    if tris > target_tris:
        d = ob.modifiers.new('Budget', 'DECIMATE')
        d.decimate_type = 'COLLAPSE'
        d.ratio = target_tris / tris
        d.use_collapse_triangulate = True
        apply_mods(ob)
    ob.data.shade_smooth()
    return ob


def knuckle_plate(spec, skel, pad, name, budget=760):
    """Moulded knuckle guard: one pad per knuckle on a shared plate, plus small guards on the
    backs of the first finger joints (frame F)."""
    names = ('index', 'middle', 'ring', 'pinky')
    stations = []
    for n in names:
        f = skel['fingers'][n]
        k, nxt = f['points'][0], f['points'][1]
        r = f['r']
        along = (nxt - k).normalized()
        out = Vector((k.x, k.y, 0.0)).normalized()
        out = (out - along * out.dot(along)).normalized()
        stations.append((k + out * (r * 1.0 + 0.0012) - along * 0.002, out, along, r))
    # Extend half a finger beyond the index and the little finger, then sample a smooth strip.
    first, last = stations[0], stations[-1]
    span0 = (stations[0][0] - stations[1][0]).normalized()
    span1 = (stations[-1][0] - stations[-2][0]).normalized()
    path = [(first[0] + span0 * first[3] * 0.9, first[1], first[2], 0.55)] + [(c, o, a, 1.0) for c, o, a, r in stations] + [(last[0] + span1 * last[3] * 0.9, last[1], last[2], 0.55)]
    rings = []
    samples = 22
    for s in range(samples + 1):
        t = s / samples * (len(path) - 1)
        i = min(int(t), len(path) - 2)
        f = t - i
        c = path[i][0].lerp(path[i + 1][0], f)
        out = path[i][1].lerp(path[i + 1][1], f).normalized()
        along = path[i][2].lerp(path[i + 1][2], f).normalized()
        size = path[i][3] + (path[i + 1][3] - path[i][3]) * f
        bump = 0.75 + 0.25 * math.cos(math.pi * 2 * (t - round(t))) if 0 < t < len(path) - 1 else 0.6
        width = 0.0215 * (0.65 + 0.35 * size)
        thick = 0.0058 * size * bump
        rings.append(ring3(superellipse(width / 2, thick, 2.6, 14), c, along, out))
    plate = loft(name, rings, pad, raw=True)
    m = plate.modifiers.new('Fuse', 'REMESH')
    m.mode = 'VOXEL'
    m.voxel_size = 0.0008
    m.use_smooth_shade = True
    apply_mods(plate)
    s = plate.modifiers.new('Relax', 'CORRECTIVE_SMOOTH')
    s.iterations = 5
    s.use_only_smooth = True
    apply_mods(plate)
    d = plate.modifiers.new('Budget', 'DECIMATE')
    d.ratio = min(1.0, budget / max(1, grid_tris(plate)))
    apply_mods(plate)
    plate.data.shade_smooth()
    return plate


def sleeve_and_cuff(spec, glove_cuff, sleeve_mat, velcro, name):
    """Neoprene glove cuff over the wrist and the ripstop shirt sleeve beyond it (frame F)."""
    w = spec['wrist']
    d = Vector(spec['forearm_dir_F']).normalized()
    side_u = Vector(w['u']).normalized()
    side_v = d.cross(side_u).normalized()
    side_u = side_v.cross(d).normalized()
    c0 = Vector(w['center'])
    parts = []
    cuff_rings = []
    for t_, s in spec['cuff']:
        cuff_rings.append(section_ring(c0 + d * t_, side_u, side_v, w['size'][0] * s, w['size'][1] * s, 20, 2.3))
    cuff = loft(f'{name}_cuff', cuff_rings, glove_cuff, raw=True)
    finish(cuff, wn=False, smooth=80)
    parts.append(cuff)
    # Strap wrapped over the back of the cuff (a crescent band hugging its curve).
    t_mid, s_mid = spec['cuff'][len(spec['cuff']) // 2]
    a_half, b_half = w['size'][0] * 0.5 * s_mid, w['size'][1] * 0.5 * s_mid
    band = []
    for dt in (-0.0115, -0.0095, 0.0095, 0.0115):
        c = c0 + d * (t_mid + dt)
        lip = 0.0006 if abs(dt) > 0.01 else 0.0
        outer, inner = [], []
        for k in range(13):
            a = math.radians(220 + 100 * k / 12)  # -side_v is the back of the wrist
            ca, sa = math.cos(a), math.sin(a)
            outer.append(c + side_u * ca * (a_half + 0.0026 - lip) + side_v * sa * (b_half + 0.0026 - lip))
            inner.append(c + side_u * ca * (a_half - 0.0008) + side_v * sa * (b_half - 0.0008))
        band.append(outer + inner[::-1])
    tab = loft(f'{name}_strap', band, velcro, raw=True)
    finish(tab, wn=False, smooth=80)
    parts.append(tab)
    # Sleeve: a loose ripstop tube over the glove cuff. It ends in a rolled hem with a clean round
    # edge that sits outside the cuff all the way round (no folds at the hem, so the sleeve never
    # cuts into the cuff); folds start just above the hem, bunch a little toward the wrist and
    # soften toward the elbow. `spec['sleeve']` is [(t, scale, fold), ...] with the hem first.
    n = 32
    profile = spec['sleeve']
    t_h, s_h = profile[0][0], profile[0][1]
    half_a, half_b = w['size'][0] * 0.5, w['size'][1] * 0.5 * 1.08

    def size_at(t_):
        for (ta, sa, fa), (tb, sb, fb) in zip(profile, profile[1:]):
            if ta <= t_ <= tb:
                f = (t_ - ta) / max(1e-6, tb - ta)
                return sa + (sb - sa) * f, fa + (fb - fa) * f
        return profile[-1][1], 0.0

    def ring(t_, s, grow=0.0, fold=0.0):
        c = c0 + d * t_
        pts = []
        for i in range(n):
            a = 2 * math.pi * i / n
            folds = 0.55 * math.sin(3 * a + t_ * 41.0) + 0.35 * math.sin(5 * a - t_ * 67.0) + 0.3 * math.sin(2 * a + t_ * 19.0 + 1.3)
            k = 1.0 + 2.0 * fold * folds
            pts.append(c + side_u * math.cos(a) * (half_a * s * k + grow) + side_v * math.sin(a) * (half_b * s * k + grow))
        return pts

    lip = 0.0022
    rings = [ring(t_h + 0.012, s_h, -lip)]                     # lining turned in under the hem (hidden)
    for phi in (-90, -135, 180, 135, 90):                       # the rolled edge, a half round
        p = math.radians(phi)
        rings.append(ring(t_h + lip + lip * math.cos(p), s_h, lip * math.sin(p)))
    rings.append(ring(t_h + 0.011, s_h, lip * 0.95))            # hem band
    rings.append(ring(t_h + 0.0135, s_h, lip * 0.55))           # hem stitch line
    t_body, t_last = t_h + 0.016, profile[-2][0]
    for k in range(22):
        t_ = t_body + (t_last - t_body) * k / 21
        s, fold = size_at(t_)
        ramp = min(1.0, max(0.0, (t_ - t_body) / 0.035))
        ramp = ramp * ramp * (3 - 2 * ramp)
        near = max(0.0, 1.0 - (t_ - t_body) / 0.12)
        bunch = 1.0 + 0.022 * near * ramp * math.sin((t_ - t_body) * 230.0)
        rings.append(ring(t_, s * bunch, lip * 0.35 * (1 - ramp), fold * ramp * (1.0 + 0.6 * near)))
    rings.append(ring(profile[-1][0], profile[-1][1]))
    sleeve = loft(f'{name}_sleeve', rings, sleeve_mat, cap0=False, raw=True)
    finish(sleeve, wn=False, smooth=80)
    # The fabric surface folds back on itself at the hem: keep the outside facing out.
    me = sleeve.data
    probe = rings[8]
    centre = sum(probe, Vector()) / len(probe)
    outward = sum(((p.co - centre).normalized().dot(p.normal) for p in me.vertices if abs((p.co - centre).dot(d)) < 0.002), 0.0)
    if outward < 0:
        me.flip_normals()
    parts.append(sleeve)
    return parts


def build_arm(spec, M, model_id):
    """One gloved forearm in arm space A (exported frame), origin at the palm grip point."""
    mirror = spec['side'] == 'left'
    glove = M['glove_l'] if mirror else M['glove_r']
    skel = hand_skeleton(spec)
    fused = build_hand_parts(spec, skel, glove)
    hand = fuse(fused, f'{ROOT_NAMES[model_id]}{SEP}hand', 0.00090, spec.get('hand_tris', 4600), smooth_iter=7, factor=0.5)
    plate = knuckle_plate(spec, skel, M['pad'], f'{ROOT_NAMES[model_id]}{SEP}pads')
    extra = sleeve_and_cuff(spec, M['cuff'], M['sleeve'], M['velcro'], f'{ROOT_NAMES[model_id]}{SEP}sl')
    parts = [hand, plate] + extra
    r_fa = arm_frames(spec)
    to_arm = r_fa.transposed().to_4x4()
    for ob in parts:
        transform_obj(ob, to_arm)
        if mirror:
            transform_obj(ob, Matrix.Scale(-1, 4, X))
            ob.data.flip_normals()
    arm = join(parts, f'{ROOT_NAMES[model_id]}{SEP}arm')
    arm.data.shade_smooth()
    return arm, skel, r_fa


# --- Hand specifications ----------------------------------------------------------------------
# Right hand on a pistol grip (cross-section 30 x 47 mm). The index finger reaches the trigger.

def _right_hand_spec():
    spec = dict(
        side='right',
        section=(0.0152, 0.0235),
        fingers=[
            dict(name='index', r=0.0097, L=(0.047, 0.027, 0.023), mcp=(0.0312, 0.0168, 0.0272),
                 chain=[(-0.10, 1.0, 0.16), (-0.78, 0.50, -0.08), (-0.92, -0.32, -0.12)]),
            dict(name='middle', r=0.0101, L=(0.051, 0.031, 0.025), phi=16, z=0.0055, dz=(0.0, -0.001, -0.002), proud=0.0075),
            dict(name='ring', r=0.0097, L=(0.048, 0.030, 0.024), phi=13, z=-0.0155, dz=(0.0, -0.001, -0.002), proud=0.0075),
            dict(name='pinky', r=0.0088, L=(0.039, 0.024, 0.021), phi=10, z=-0.0345, dz=(0.0, -0.001, -0.001), proud=0.0070),
        ],
        thumb=dict(points=[(0.0200, -0.0620, 0.0160), (0.0020, -0.0520, 0.0360), (-0.0200, -0.0280, 0.0410), (-0.0250, 0.0020, 0.0420)],
                   radii=[0.0150, 0.0123, 0.0111, 0.0103]),
        blobs=[((0.0300, -0.0720, 0.0000), (0.0120, -0.0580, 0.0260), 0.0170, 0.0150, 0.9),    # thenar
               ((0.0330, -0.0800, -0.0420), (0.0320, -0.0620, -0.0120), 0.0150, 0.0140, 0.9),  # heel / hypothenar
               ((0.0390, -0.0300, -0.0330), (0.0400, -0.0300, 0.0260), 0.0110, 0.0110, 0.8)],  # back of hand
        palm_z=(-0.047, 0.040),
        wrist=dict(center=(0.0360, -0.0920, -0.0040), u=(0.0, 0.0, 1.0), size=(0.0590, 0.0400),
                   profile=[(-0.012, (0.96, 0.96)), (0.000, (1.0, 1.0)), (0.030, (0.95, 0.96)), (0.070, (0.98, 1.0)), (0.100, (1.04, 1.06))]),
        cuff=[(0.006, 1.02), (0.014, 1.10), (0.040, 1.12), (0.068, 1.14), (0.078, 1.10)],
        sleeve=[(0.064, 1.26, 0.0), (0.090, 1.27, 0.03), (0.120, 1.29, 0.045), (0.160, 1.31, 0.045), (0.210, 1.35, 0.04), (0.260, 1.39, 0.035),
                (0.310, 1.43, 0.03), (0.350, 1.45, 0.025), (0.390, 1.46, 0.02), (0.395, 0.6, 0.0)],
        hand_tris=4600,
    )
    # Reference pose: KR-5 grip (19.5 deg). Forearm back, out to the right and slightly down.
    r_fw = grip_frame(19.5)
    d_w = unit(0.30, -0.93, -0.20)
    spec['forearm_dir_F'] = tuple(r_fw.transposed() @ d_w)
    spec['up_F'] = tuple(r_fw.transposed() @ Z)
    spec['reference_grip'] = r_fw
    return spec


def _left_hand_spec():
    """Support hand wrapped round a 52 mm handguard, thumb along its upper left side.
    Built as a right fist then mirrored; numbers are in the pre-mirror frame."""
    spec = dict(
        side='left',
        section=(0.0262, 0.0262),
        fingers=[
            dict(name='index', r=0.0097, L=(0.047, 0.027, 0.023), phi=22, z=0.0270, dz=(0.0, -0.0005, -0.001), proud=0.0072),
            dict(name='middle', r=0.0101, L=(0.051, 0.031, 0.025), phi=18, z=0.0055, dz=(0.0, -0.0005, -0.001), proud=0.0075),
            dict(name='ring', r=0.0097, L=(0.048, 0.030, 0.024), phi=15, z=-0.0155, dz=(0.0, -0.0005, -0.001), proud=0.0075),
            dict(name='pinky', r=0.0088, L=(0.039, 0.024, 0.021), phi=12, z=-0.0345, dz=(0.0, -0.0005, -0.001), proud=0.0070),
        ],
        thumb=dict(points=[(0.0280, -0.0640, 0.0140), (0.0060, -0.0480, 0.0360), (-0.0060, -0.0410, 0.0630), (-0.0090, -0.0380, 0.0880)],
                   radii=[0.0150, 0.0123, 0.0111, 0.0103]),
        blobs=[((0.0400, -0.0730, 0.0000), (0.0200, -0.0600, 0.0260), 0.0170, 0.0150, 0.9),
               ((0.0430, -0.0800, -0.0420), (0.0420, -0.0620, -0.0120), 0.0150, 0.0140, 0.9),
               ((0.0500, -0.0300, -0.0330), (0.0510, -0.0300, 0.0260), 0.0110, 0.0110, 0.8)],
        palm_z=(-0.047, 0.040),
        wrist=dict(center=(0.0470, -0.0920, -0.0040), u=(0.0, 0.0, 1.0), size=(0.0590, 0.0400),
                   profile=[(-0.012, (0.96, 0.96)), (0.000, (1.0, 1.0)), (0.030, (0.95, 0.96)), (0.070, (0.98, 1.0)), (0.100, (1.04, 1.06))]),
        cuff=[(0.006, 1.02), (0.014, 1.10), (0.040, 1.12), (0.068, 1.14), (0.078, 1.10)],
        sleeve=[(0.064, 1.26, 0.0), (0.090, 1.27, 0.03), (0.120, 1.29, 0.045), (0.160, 1.31, 0.045), (0.210, 1.35, 0.04), (0.260, 1.39, 0.035),
                (0.310, 1.43, 0.03), (0.350, 1.45, 0.025), (0.390, 1.46, 0.02), (0.395, 0.6, 0.0)],
        hand_tris=4600,
    )
    # Reference pose: KR-5 handguard, palm on the lower left, forearm back, left and down.
    r_fw = handguard_frame(LEFT_ROLL['kr5'])
    mirror = Matrix.Scale(-1, 3, X)
    d_w = unit(-0.42, -0.83, -0.36)
    # Pre-mirror frame: F' = mirror(F_left).
    spec['forearm_dir_F'] = tuple(mirror @ (r_fw.transposed() @ d_w))
    spec['up_F'] = tuple(mirror @ (r_fw.transposed() @ Z))
    spec['reference_grip'] = r_fw
    return spec


LEFT_ROLL = {'kr5': 58.0, 'hornet9': 58.0, 'breaker12': 62.0, 'longbow': 66.0}
RIGHT_HAND = _right_hand_spec()
LEFT_HAND = _left_hand_spec()


def hand_axes():
    """Held axis of each fist in arm space (for the glove shader and the GLB extras)."""
    for spec in (RIGHT_HAND, LEFT_HAND):
        r_fa = arm_frames(spec)
        h = r_fa.transposed() @ Z
        if spec['side'] == 'left':
            h = Vector((-h.x, h.y, h.z))
        spec['held_axis_arm'] = tuple(h)


hand_axes()


def trigger_point_F():
    """Where the right index finger's pad meets a trigger face, in frame F."""
    skel = hand_skeleton(RIGHT_HAND)
    pts = skel['fingers']['index']['points']
    r = skel['fingers']['index']['r']
    mid = (pts[2] + pts[3]) / 2
    return Vector((0.0, mid.y - r - 0.0004, mid.z))


def anchor_rotation(spec, r_fw):
    """Rotation of an arm anchor in weapon space for a grip frame `r_fw` (F -> weapon)."""
    r_fa = arm_frames(spec)
    if spec['side'] == 'left':
        mirror = Matrix.Scale(-1, 3, X)
        # Arm space of the left arm is the mirror of the pre-mirror arm space; F_left = mirror(F').
        return r_fw @ mirror @ r_fa @ mirror
    return r_fw @ r_fa


def seated_points(arm_id, rotation, position=(0.0, 0.0, 0.0)):
    """Vertices of an already built arm seated on an anchor (weapon space), or None."""
    pts = HAND_POINTS.get(arm_id)
    if pts is None:
        return None
    return pts @ np.array(rotation.to_3x3()).T + np.array(position)


# =============================================================================================
# Model registry and anchors
# =============================================================================================

class Model:
    def __init__(self, mid):
        self.id = mid
        self.root_name = ROOT_NAMES[mid]
        self.root = bpy.data.objects.new(self.root_name, None)
        self.root.empty_display_size = 0.05
        BUILD.objects.link(self.root)
        self.groups = {}       # node name -> list of textured part objects
        self.flat = {}         # node name -> list of untextured (lens/glow) objects
        self.pivots = {}       # 'mag' / 'action' -> (Matrix pivot)
        self.anchors = {}      # name -> Matrix (weapon space)
        self.meshes = {}       # node name -> final mesh object
        self.extras = {}

    def add(self, node, *objs, flat=False):
        target = self.flat if flat else self.groups
        target.setdefault(node, []).extend(o for o in objs if o is not None)
        if DEBUG_TRIS:
            for o in objs:
                if o is not None and grid_tris(o) >= 300:
                    log(f'  {self.id}.{node}: {o.name} {grid_tris(o)} tris')

    def anchor(self, name, position, rotation=None):
        m = (rotation.to_4x4() if rotation is not None else Matrix.Identity(4))
        m.translation = Vector(position)
        self.anchors[name] = m

    def all_parts(self):
        return [o for objs in list(self.groups.values()) + list(self.flat.values()) for o in objs]


def finalize_model(model):
    """Join parts per node, create pivots and anchors, parent everything to the root."""
    nodes = sorted(set(model.groups) | set(model.flat))
    for node in nodes:
        objs = model.groups.get(node, []) + model.flat.get(node, [])
        mesh_name = f'{model.root_name}{SEP}{node}' + ('_mesh' if node in model.pivots else '')
        ob = join(objs, mesh_name)
        model.meshes[node] = ob
        if node in model.pivots:
            pivot = bpy.data.objects.new(f'{model.root_name}{SEP}{node}', None)
            pivot.empty_display_size = 0.02
            BUILD.objects.link(pivot)
            pivot.parent = model.root
            pivot.matrix_world = model.pivots[node]
            # Mesh vertices stay in weapon space; the child's local transform is the inverse pivot.
            ob.parent = pivot
            ob.matrix_parent_inverse = Matrix.Identity(4)
            ob.matrix_basis = model.pivots[node].inverted()
        else:
            ob.parent = model.root
    for name, m in model.anchors.items():
        e = bpy.data.objects.new(f'{model.root_name}{SEP}{name}', None)
        e.empty_display_type = 'ARROWS'
        e.empty_display_size = 0.02
        BUILD.objects.link(e)
        e.parent = model.root
        e.matrix_basis = m
    return model


def model_objects(model):
    out = [model.root]
    stack = [model.root]
    while stack:
        ob = stack.pop()
        for c in ob.children:
            out.append(c)
            stack.append(c)
    return out


# =============================================================================================
# Shared firearm parts
# =============================================================================================

def pistol_grip(name, tilt, top_len, bottom_len, mat, width=0.0300, depth=0.0470, flare=1.06, n=20, top_extra=0.0):
    """Lofted pistol grip whose axis passes through the palm point (origin) at `tilt` degrees."""
    r = grip_frame(tilt)
    xa, ya, za = r.col[0], r.col[1], r.col[2]
    rings = []
    stations = [(-bottom_len, 0.96 * flare, 1.0 * flare, 0.0), (-bottom_len + 0.006, 1.0 * flare, 1.03 * flare, 0.0),
                (-bottom_len + 0.020, 1.0, 1.0, 0.0), (-0.010, 0.97, 0.98, -0.0015), (0.012, 1.0, 1.0, 0.0),
                (top_len - 0.006, 1.03, 1.02, 0.001), (top_len + top_extra, 1.05, 1.04, 0.002)]
    for s, sw, sd, fwd in stations:
        c = za * s + ya * fwd
        pts = superellipse(width / 2 * sw, depth / 2 * sd, 2.6, n)
        rings.append(ring3(pts, c, xa, ya))
    ob = loft(name, rings, mat, raw=True)
    return finish(ob, bevel=0.0012, seg=2, angle=40, wn=False, smooth=70)


def trigger(name, contact, mat, height=0.026, curve=0.007):
    """A curved trigger blade whose front face passes through `contact` (weapon space)."""
    c = Vector(contact)
    pts = []
    for i in range(7):
        t = i / 6
        z = c.z + 0.010 - t * height
        y = c.y - 0.0035 + curve * (1 - (2 * t - 1) ** 2) * 0.5 - curve * 0.25
        pts.append((y + 0.0045, z))
    for i in range(6, -1, -1):
        t = i / 6
        z = c.z + 0.010 - t * height
        y = c.y - 0.0035 + curve * (1 - (2 * t - 1) ** 2) * 0.5 - curve * 0.25
        pts.append((y, z))
    return sym(name, pts, 0.0058, mat, bevel=0.0008, seg=1)


def picatinny(name, y0, y1, z_base, mat, width=0.0212, pitch=0.01, slot=0.0052, tooth_bevel=0.0004):
    """Accessory rail: base strip plus dovetail teeth (unbevelled teeth where triangles are tight)."""
    parts = []
    base_h = 0.0040
    parts.append(front(name + '_base', [(-width / 2 + 0.002, z_base), (width / 2 - 0.002, z_base), (width / 2 - 0.002, z_base + base_h), (-width / 2 + 0.002, z_base + base_h)], y0, y1, mat, bevel=0.0005))
    tooth = [(-0.0078, z_base + base_h - 0.0002), (0.0078, z_base + base_h - 0.0002), (width / 2, z_base + base_h + 0.0022), (width / 2, z_base + base_h + 0.0040),
             (width / 2 - 0.0014, z_base + base_h + 0.0052), (-width / 2 + 0.0014, z_base + base_h + 0.0052), (-width / 2, z_base + base_h + 0.0040), (-width / 2, z_base + base_h + 0.0022)]
    y = y0 + 0.002
    i = 0
    while y + (pitch - slot) <= y1 - 0.001:
        parts.append(front(f'{name}_t{i}', tooth, y, y + pitch - slot, mat, bevel=tooth_bevel, seg=1, wn=False))
        y += pitch
        i += 1
    return join(parts, name)


def mlok_cutters(name, y0, y1, centers_xz, normal_dirs, length=0.032, height=0.0072, pitch=0.040, depth=0.004, corner=3):
    """Rounded-slot pocket cutters on faces with the given outward normals (handguards)."""
    cutters = []
    for k, ((cx, cz), (nx, nz)) in enumerate(zip(centers_xz, normal_dirs)):
        n = Vector((nx, 0, nz)).normalized()
        t = Vector((-n.z, 0, n.x))
        y = y0
        j = 0
        while y + length <= y1:
            o = Vector((cx, 0, cz)) - n * depth
            frame = (o + Y * (y + length / 2), Y, t, n)
            pts = rrect(length, height, height / 2, corner)
            cutters.append(prism(f'{name}_{k}_{j}', pts, frame, 0.0, depth * 2.5, None, raw=True))
            y += pitch
            j += 1
    return cutters


# =============================================================================================
# KR-5 carbine
# =============================================================================================

def build_kr5(M):
    """KR-5: monolithic-upper carbine, free-float handguard, closed reflex sight, side light."""
    m = Model('kr5')
    tilt = 19.5
    r_grip = grip_frame(tilt)
    trig = r_grip @ trigger_point_F()
    zb = 0.0745                 # bore height above the palm point
    yr = -0.068                 # rear face of the upper receiver
    yf = 0.152                  # front of the upper / start of handguard
    yh = 0.452                  # handguard front
    rail_z = zb + 0.0215
    sight_z = zb + 0.0605
    an, st, poly, polyg, rub = M['anod_black'], M['steel'], M['polymer_fde'], M['polymer_fde_grip'], M['rubber']
    # Upper receiver with a chamfered top edge; ejection port on the right.
    upper = sym('kr5_upper', [(yr, zb - 0.0150), (yf, zb - 0.0150), (yf, zb + 0.0215), (yr + 0.010, zb + 0.0215), (yr, zb + 0.0170)], 0.0290, an, bevel=0.0016, seg=2)
    port = box('kr5_port_cut', (0.0160, 0.040, zb + 0.0035), (0.008, 0.058, 0.0165), None, raw=True)
    cut(upper, [port])
    m.add('body', upper)
    m.add('body', box('kr5_port_floor', (0.0118, 0.040, zb + 0.0035), (0.003, 0.058, 0.0165), st, bevel=0.0003))
    m.add('body', box('kr5_bolt', (0.0126, 0.044, zb + 0.0040), (0.0024, 0.040, 0.0112), M['steel_dark'], bevel=0.0005))
    m.add('body', sym('kr5_deflector', [(0.002, zb + 0.004), (0.010, zb + 0.004), (0.014, zb + 0.018), (0.004, zb + 0.020)], 0.008, an, x=0.0170, bevel=0.0012, seg=2))
    # Lower receiver, trigger guard and flared magazine well with machined side pockets.
    lw_bot = 0.030
    lower = sym('kr5_lower', [(yr + 0.006, zb - 0.0150), (0.150, zb - 0.0150), (0.150, lw_bot + 0.004), (0.142, lw_bot - 0.004), (0.074, lw_bot - 0.004),
                               (0.074, lw_bot + 0.002), (0.020, lw_bot + 0.002), (0.004, lw_bot + 0.0), (-0.020, lw_bot + 0.004), (yr + 0.006, zb - 0.040)],
                 0.0300, an, bevel=0.0018, seg=2)
    m.add('body', lower)
    magwell = sym('kr5_magwell', [(0.074, lw_bot + 0.006), (0.150, lw_bot + 0.006), (0.154, lw_bot - 0.022), (0.150, lw_bot - 0.027), (0.072, lw_bot - 0.027), (0.068, lw_bot - 0.022)],
                  0.0330, an, bevel=0.0018, seg=2)
    pockets = [side(f'kr5_pocket_{s}', rrect(0.054, 0.016, 0.003, 2, 0.111, lw_bot - 0.012), s * 0.0158, s * 0.0200, None, raw=True) for s in (1, -1)]
    cut(magwell, [box('kr5_mag_hole', (0.0, 0.112, lw_bot - 0.020), (0.0250, 0.068, 0.020), None, raw=True)] + pockets)
    m.add('body', magwell)
    guard = sym('kr5_guard', [(0.010, lw_bot + 0.002), (0.074, lw_bot + 0.002), (0.074, trig.z - 0.024), (0.066, trig.z - 0.030), (0.012, trig.z - 0.030), (0.004, trig.z - 0.022)],
                0.0110, an, bevel=0.0014, seg=2)
    guard_hole = sym('kr5_guard_hole', [(0.016, lw_bot + 0.004), (0.068, lw_bot + 0.004), (0.068, trig.z - 0.023), (0.062, trig.z - 0.026), (0.018, trig.z - 0.026), (0.014, trig.z - 0.020)], 0.03, None, raw=True)
    cut(guard, [guard_hole])
    m.add('body', guard)
    m.add('body', trigger('kr5_trigger', trig, M['steel_dark']))
    for sx in (1, -1):
        m.add('body', sym(f'kr5_selector_{sx}', [(-0.006, zb - 0.028), (0.004, zb - 0.030), (0.016, zb - 0.026), (0.016, zb - 0.022), (0.002, zb - 0.020), (-0.006, zb - 0.022)], 0.0030, M['steel_dark'], x=sx * 0.0163, bevel=0.0006))
        m.add('body', cyl(f'kr5_pin_f_{sx}', (sx * 0.0148, 0.140, zb - 0.026), (sx * 0.0162, 0.140, zb - 0.026), 0.0030, M['steel_dark'], seg=10, bevel=0.0004))
        m.add('body', cyl(f'kr5_pin_r_{sx}', (sx * 0.0148, -0.040, zb - 0.030), (sx * 0.0162, -0.040, zb - 0.030), 0.0030, M['steel_dark'], seg=10, bevel=0.0004))
    m.add('body', cyl('kr5_mag_release', (0.0160, 0.088, zb - 0.034), (0.0195, 0.088, zb - 0.034), 0.0042, M['steel_dark'], seg=12, bevel=0.0005))
    m.add('body', sym('kr5_release_fence', [(0.080, zb - 0.042), (0.096, zb - 0.042), (0.098, zb - 0.026), (0.078, zb - 0.026)], 0.0038, an, x=0.0160, bevel=0.0008))
    m.add('body', pistol_grip('kr5_grip', tilt, 0.030, 0.060, polyg, top_extra=0.006))
    # Receiver extension and a sculpted adjustable stock.
    m.add('body', lathe('kr5_buffer', [(0.0, 0.0172), (0.010, 0.0172), (0.012, 0.0158), (0.200, 0.0158), (0.204, 0.0148)], an, origin=(0, yr + 0.004, zb - 0.002), axis=(0, -1, 0), seg=16, bevel=0.0005))
    for i in range(5):
        m.add('body', box(f'kr5_buffer_notch_{i}', (0, yr - 0.062 - i * 0.014, zb - 0.0180), (0.0060, 0.0040, 0.0020), st, bevel=0.0003))
    rings = []
    for y, top_z, bot_z, w, r in ((-0.150, 0.0175, -0.0215, 0.0350, 0.0060), (-0.160, 0.0195, -0.0260, 0.0400, 0.0080), (-0.190, 0.0215, -0.0390, 0.0420, 0.0090),
                                  (-0.225, 0.0235, -0.0640, 0.0420, 0.0090), (-0.258, 0.0250, -0.0880, 0.0430, 0.0090), (-0.284, 0.0255, -0.1000, 0.0430, 0.0080),
                                  (-0.291, 0.0245, -0.0990, 0.0400, 0.0060)):
        h = top_z - bot_z
        rings.append(ring3(rrect(w, h, r, 3, 0.0, zb + (top_z + bot_z) / 2), Vector((0, y, 0)), X, Z))
    stock = loft('kr5_stock', rings, poly, bevel=0.0, wn=False, smooth=60)
    window = sym('kr5_stock_window', [(-0.200, zb - 0.034), (-0.236, zb - 0.034), (-0.262, zb - 0.072), (-0.262, zb - 0.082), (-0.248, zb - 0.082)], 0.06, None, raw=True)
    tube_hole = lathe('kr5_stock_bore', [(0.0, 0.0162), (0.2, 0.0162)], None, origin=(0, -0.140, zb - 0.002), axis=(0, -1, 0), seg=16, raw=True)
    cut(stock, [window, tube_hole])
    m.add('body', stock)
    m.add('body', sym('kr5_cheek', [(-0.158, zb + 0.0190), (-0.276, zb + 0.0240), (-0.282, zb + 0.0320), (-0.180, zb + 0.0290)], 0.0300, polyg, bevel=0.0035, seg=3))
    m.add('body', sym('kr5_buttpad', [(-0.289, zb + 0.0240), (-0.305, zb + 0.0255), (-0.307, zb - 0.0970), (-0.289, zb - 0.1020)], 0.0440, rub, bevel=0.0040, seg=3))
    m.add('body', sym('kr5_stock_lever', [(-0.146, zb - 0.024), (-0.180, zb - 0.026), (-0.182, zb - 0.033), (-0.148, zb - 0.031)], 0.0120, polyg, bevel=0.0012))
    m.add('body', cyl('kr5_qd', (0.0205, -0.215, zb - 0.010), (0.0235, -0.215, zb - 0.010), 0.0068, M['steel_dark'], seg=14, bevel=0.0006))
    # Handguard: rounded octagon, slotted on the sides and bottom; rail on the receiver and the front.
    hg = [(-0.0250, rail_z), (0.0250, rail_z), (0.0262, rail_z - 0.010), (0.0262, zb - 0.020), (0.0150, zb - 0.0345), (-0.0150, zb - 0.0345), (-0.0262, zb - 0.020), (-0.0262, rail_z - 0.010)]
    handguard = front('kr5_handguard', hg, yf - 0.001, yh, an, bevel=0.0028, seg=3, angle=25)
    cutters = mlok_cutters('kr5_slot', yf + 0.040, yh - 0.010, [(0.0262, zb - 0.002), (-0.0262, zb - 0.002), (0.0, zb - 0.0345)], [(1, 0), (-1, 0), (0, -1)], pitch=0.046, corner=2)
    cut(handguard, cutters)
    m.add('body', handguard)
    m.add('body', front('kr5_hg_cap', [(-0.0215, rail_z - 0.004), (0.0215, rail_z - 0.004), (0.0220, zb - 0.020), (0.0120, zb - 0.0300), (-0.0120, zb - 0.0300), (-0.0220, zb - 0.020)], yh, yh + 0.004, an, bevel=0.0012, seg=2))
    m.add('body', picatinny('kr5_rail', yr + 0.006, yf - 0.004, rail_z, an))
    m.add('body', picatinny('kr5_rail_front', yh - 0.072, yh - 0.003, rail_z, an))
    m.add('body', front('kr5_hg_spine', [(-0.0080, rail_z - 0.0005), (0.0080, rail_z - 0.0005), (0.0060, rail_z + 0.0022), (-0.0060, rail_z + 0.0022)], yf - 0.002, yh - 0.071, an, bevel=0.0006))
    # Barrel and a slotted muzzle brake.
    m.add('body', lathe('kr5_barrel', [(0.0, 0.0098), (0.060, 0.0098), (0.064, 0.0090), (0.090, 0.0090)], st, origin=(0, yh - 0.020, zb), seg=16, bevel=0.0004))
    yb = yh + 0.070
    brake = lathe('kr5_brake', [(0.0, 0.0108), (0.004, 0.0118), (0.052, 0.0118), (0.056, 0.0108), (0.058, 0.0070), (0.058, 0.0)], M['steel_dark'], origin=(0, yb - 0.004, zb), seg=16, bevel=0.0005)
    brake_cuts = []
    for k, ang in enumerate((90, 20, 160)):
        a = math.radians(ang)
        for j in range(2):
            c = Vector((math.cos(a) * 0.013, yb + 0.016 + j * 0.017, zb + math.sin(a) * 0.013))
            n = Vector((math.cos(a), 0, math.sin(a)))
            t = Vector((-n.z, 0, n.x))
            brake_cuts.append(prism(f'kr5_brake_cut_{k}_{j}', rrect(0.0110, 0.0065, 0.0032, 2), (c, Y, t, n), -0.006, 0.006, None, raw=True))
    cut(brake, brake_cuts)
    m.add('body', brake)
    # Low folding sights at both ends of the rail.
    m.add('body', sym('kr5_rear_buis', [(yr + 0.012, rail_z + 0.009), (yr + 0.040, rail_z + 0.009), (yr + 0.044, rail_z + 0.016), (yr + 0.016, rail_z + 0.020)], 0.0200, an, bevel=0.0016, seg=2))
    m.add('body', sym('kr5_front_buis', [(yh - 0.040, rail_z + 0.009), (yh - 0.010, rail_z + 0.009), (yh - 0.012, rail_z + 0.017), (yh - 0.036, rail_z + 0.020)], 0.0200, an, bevel=0.0016, seg=2))
    m.add('body', sym('kr5_handstop', [(yh - 0.060, zb - 0.0335), (yh - 0.022, zb - 0.0335), (yh - 0.026, zb - 0.046), (yh - 0.034, zb - 0.049), (yh - 0.050, zb - 0.040)], 0.0180, polyg, bevel=0.0025, seg=2))
    # Weapon light at two o'clock with its clamp.
    la = Vector((0.0225, yh - 0.110, zb + 0.0105))
    light_end = la + Y * 0.112
    m.add('body', lathe('kr5_light', [(0.0, 0.0108), (0.004, 0.0122), (0.020, 0.0122), (0.024, 0.0112), (0.078, 0.0112), (0.082, 0.0136), (0.108, 0.0140), (0.112, 0.0134)],
                        an, origin=la, seg=16, bevel=0.0006))
    m.add('body', cyl('kr5_light_switch', la - Y * 0.006, la + Y * 0.001, 0.0085, rub, seg=12, bevel=0.0012))
    m.add('body', box('kr5_light_mount', (0.0170, la.y + 0.050, zb + 0.0130), (0.0110, 0.030, 0.0120), an, bevel=0.0012, seg=2))
    m.add('body', cyl('kr5_light_lens', light_end - Y * 0.0015, light_end + Y * 0.0002, 0.0118, M['light_lens'], seg=16))
    # Closed reflex sight with a slanted hood.
    lens_y = reflex_sight(m, M, 'kr5_rds', 0.004, rail_z + 0.0092, sight_z)
    # Left-side charging handle, worked by the support hand (moves back on an empty reload).
    ch_y = 0.112
    ch = sym('kr5_charger', [(ch_y - 0.006, zb + 0.004), (ch_y + 0.006, zb + 0.004), (ch_y + 0.008, zb + 0.014), (ch_y - 0.008, zb + 0.014)], 0.0150, M['steel_dark'], x=-0.0222, bevel=0.0018, seg=2)
    m.add('action', ch)
    m.pivots['action'] = Matrix.Translation((0, ch_y, zb))
    m.add('body', box('kr5_charger_slot', (-0.0148, ch_y - 0.024, zb + 0.009), (0.0012, 0.070, 0.0046), M['steel_dark'], bevel=0.0002))
    # Magazine: curved polymer 30-rounder, origin at its top centre in the well.
    mag_top = (0.0, 0.112, lw_bot - 0.004)
    m.add('mag', *curved_magazine(M, 'kr5_mag', mag_top, length=0.205, bend=16.0, depth=(0.064, 0.070), width=0.0234, body=M['polymer_fde'], plate=M['polymer_black']))
    m.pivots['mag'] = Matrix.Translation(mag_top)
    # Anchors.
    m.anchor('grip_r', (0, 0, 0), anchor_rotation(RIGHT_HAND, r_grip))
    m.anchor('grip_l', (0, 0.335, zb - 0.0045), anchor_rotation(LEFT_HAND, handguard_frame(LEFT_ROLL['kr5'])))
    m.anchor('muzzle', (0, yb + 0.056, zb))
    m.anchor('sight', (0, lens_y - 0.0004, sight_z))
    m.anchor('eject', (0.0190, 0.040, zb + 0.0040))
    m.extras = dict(boreHeight=zb, sightHeight=sight_z, trigger=[round(v, 5) for v in trig])
    return m


def reflex_sight(m, M, name, y0, base_z, sight_z, width=0.0320, length=0.058):
    """Closed-emitter reflex sight on a rail clamp. Returns the lens plane position (y)."""
    an = M['anod_black']
    clamp_top = base_z + 0.0075
    m.add('body', box(f'{name}_clamp', (0, y0 + 0.028, base_z + 0.0040), (0.0270, 0.046, 0.0080), an, bevel=0.0012, seg=2))
    m.add('body', box(f'{name}_lever', (-0.0158, y0 + 0.022, base_z + 0.0030), (0.0040, 0.024, 0.0060), M['steel_dark'], bevel=0.0010, seg=2))
    top = sight_z + 0.0175
    housing = sym(f'{name}_housing', [(y0, clamp_top), (y0 + length, clamp_top), (y0 + length, clamp_top + 0.006), (y0 + length - 0.010, top), (y0 + 0.008, top), (y0, top - 0.007)],
                  width, an, bevel=0.0030, seg=3, angle=25)
    window = front(f'{name}_window', rrect(0.0250, 0.0210, 0.0045, 3, 0, sight_z), y0 - 0.02, y0 + length + 0.02, None, raw=True)
    cut(housing, [window])
    m.add('body', housing)
    m.add('body', cyl(f'{name}_turret_r', (width / 2 - 0.001, y0 + 0.014, clamp_top + 0.006), (width / 2 + 0.0035, y0 + 0.014, clamp_top + 0.006), 0.0058, an, seg=14, bevel=0.0008))
    m.add('body', cyl(f'{name}_turret_t', (0, y0 + 0.014, top - 0.001), (0, y0 + 0.014, top + 0.0030), 0.0058, an, seg=14, bevel=0.0008))
    m.add('body', box(f'{name}_buttons', (-width / 2 - 0.0012, y0 + 0.030, clamp_top + 0.006), (0.0030, 0.018, 0.0065), M['rubber'], bevel=0.0010))
    # See-through window (its edge hides inside the housing) with the dot just in front of it.
    lens_y = y0 + length - 0.012
    m.add('body', pane(f'{name}_glass', rrect(0.0256, 0.0216, 0.0046, 3, 0, sight_z), lens_y, M['glass']), flat=True)
    m.add('body', cyl(f'{name}_dot', (0, lens_y - 0.0004, sight_z), (0, lens_y - 0.0002, sight_z), 0.0010, M['glow_red'], seg=10, wn=False), flat=True)
    return lens_y


def curved_magazine(M, name, top, length, bend, depth, width, body, plate, ribs=3, n=14):
    """Box magazine whose spine curves forward by `bend` degrees over `length`."""
    top = Vector(top)
    theta = math.radians(bend)
    radius = length / theta if theta > 1e-6 else 1e9
    rings = []
    frames = []
    for i in range(n + 1):
        s = length * i / n
        a = s / radius
        c = top + Vector((0, radius * (1 - math.cos(a)), -radius * math.sin(a)))
        v = Vector((0, math.cos(a), math.sin(a)))
        d = depth[0] + (depth[1] - depth[0]) * i / n
        w = width if 0 < i < n else width * 0.975
        rings.append(ring3(rrect(w, d, 0.0045, 3), c, X, v))
        frames.append((c, v, d))
    shell = loft(f'{name}_body', rings, body, raw=True)
    finish(shell, wn=False, smooth=70)
    parts = [shell]
    c_end, v_end, d_end = frames[-1]
    down = Vector((0, v_end.z, -v_end.y))  # spine tangent at the bottom
    plate_rings = [ring3(rrect(width + dw, d_end + dd, 0.0055, 3), c_end + down * t, X, v_end)
                   for t, dw, dd in ((-0.006, 0.0026, 0.0034), (0.0, 0.0036, 0.0060), (0.0055, 0.0030, 0.0050), (0.0070, 0.0010, 0.0030))]
    cap = loft(f'{name}_plate', plate_rings, plate, raw=True)
    finish(cap, wn=False, smooth=60)
    parts.append(cap)
    for k in range(ribs):
        c, v, d = frames[int((0.42 + k * 0.16) * n)]
        for sx in (1, -1):
            parts.append(prism(f'{name}_rib_{k}_{sx}', rrect(d * 0.72, 0.0040, 0.0018, 2), (c + X * sx * (width / 2 - 0.0002), v, Vector((0, -v.z, v.y)), X * sx), 0.0, 0.0010, body, bevel=0.0, wn=False))
    return parts


# =============================================================================================
# Build orchestration
# =============================================================================================

def torus(name, center, axis, R, r, mat, seg=20, rseg=8):
    """Ring of major radius R and tube radius r around `axis` through `center`."""
    a, b1, b2 = basis_for(axis)
    c = Vector(center)
    bm = bmesh.new()
    rings = []
    for i in range(seg):
        t = 2 * math.pi * i / seg
        d = b1 * math.cos(t) + b2 * math.sin(t)
        rings.append([bm.verts.new(c + d * (R + r * math.cos(2 * math.pi * j / rseg)) + a * r * math.sin(2 * math.pi * j / rseg)) for j in range(rseg)])
    for i in range(seg):
        r0, r1 = rings[i], rings[(i + 1) % seg]
        for j in range(rseg):
            k = (j + 1) % rseg
            bm.faces.new((r0[j], r1[j], r1[k], r0[k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    ob = obj_from_bm(name, bm, mat)
    return finish(ob, wn=False, smooth=80)


def octagon_guard(name, y0, y1, zb, half_w, top_z, bottom_z, chamfer, mat, bevel=0.0024):
    """Rounded-octagon handguard cross-section extruded along the bore."""
    pts = [(-half_w + chamfer * 0.4, top_z), (half_w - chamfer * 0.4, top_z), (half_w, top_z - chamfer * 0.9), (half_w, bottom_z + chamfer),
           (half_w - chamfer, bottom_z), (-half_w + chamfer, bottom_z), (-half_w, bottom_z + chamfer), (-half_w, top_z - chamfer * 0.9)]
    return front(name, pts, y0, y1, mat, bevel=bevel, seg=3, angle=25)


def iron_sights(m, M, name, rear_y, front_y, sight_z, rear_base_z, front_base_z, mat, glow=None):
    """Aperture rear sight with guard ears and a winged front post whose tip is on the sight line."""
    m.add('body', box(f'{name}_rear_base', (0, rear_y, rear_base_z + 0.0035), (0.0200, 0.0160, 0.0070), mat, bevel=0.0010, seg=2))
    for sx in (1, -1):
        m.add('body', sym(f'{name}_ear_{sx}', [(rear_y - 0.007, rear_base_z + 0.006), (rear_y + 0.007, rear_base_z + 0.006), (rear_y + 0.004, sight_z + 0.010), (rear_y - 0.004, sight_z + 0.010)],
                          0.0032, mat, x=sx * 0.0084, bevel=0.0008))
    ring = front(f'{name}_aperture', superellipse(0.0068, 0.0068, 2.0, 18, 0, sight_z), rear_y - 0.0022, rear_y + 0.0022, mat, bevel=0.0006, seg=1)
    hole = front(f'{name}_aperture_hole', superellipse(0.0030, 0.0030, 2.0, 14, 0, sight_z), rear_y - 0.01, rear_y + 0.01, None, raw=True)
    cut(ring, [hole])
    m.add('body', ring)
    m.add('body', box(f'{name}_aperture_post', (0, rear_y, (rear_base_z + 0.007 + sight_z - 0.0062) / 2), (0.0034, 0.0040, sight_z - 0.0062 - rear_base_z - 0.007 + 0.001), mat, bevel=0.0005))
    # Front post: tip exactly on the sight line, protected by two wings.
    m.add('body', box(f'{name}_front_base', (0, front_y, front_base_z + 0.0035), (0.0160, 0.0180, 0.0070), mat, bevel=0.0010, seg=2))
    m.add('body', sym(f'{name}_post', [(front_y - 0.0030, front_base_z + 0.006), (front_y + 0.0030, front_base_z + 0.006), (front_y + 0.0018, sight_z), (front_y - 0.0018, sight_z)], 0.0026, mat, bevel=0.0003))
    for sx in (1, -1):
        m.add('body', sym(f'{name}_wing_{sx}', [(front_y - 0.006, front_base_z + 0.006), (front_y + 0.006, front_base_z + 0.006), (front_y + 0.004, sight_z + 0.004), (front_y - 0.004, sight_z + 0.004)],
                          0.0026, mat, x=sx * 0.0072, bevel=0.0006))
    if glow:
        m.add('body', cyl(f'{name}_front_dot', (0, front_y - 0.0026, sight_z - 0.0020), (0, front_y - 0.0016, sight_z - 0.0020), 0.0009, glow, seg=8, wn=False), flat=True)


# =============================================================================================
# Hornet 9 submachine gun
# =============================================================================================

def build_hornet9(M):
    """Hornet 9: compact 9 mm carbine with a folding skeleton stock and an open reflex sight."""
    m = Model('hornet9')
    tilt = 17.0
    r_grip = grip_frame(tilt)
    trig = r_grip @ trigger_point_F()
    zb = 0.0690
    yr, yf, yh = -0.070, 0.118, 0.242
    rail_z = zb + 0.0195
    sight_z = zb + 0.0520
    an, poly, polyg, rub, st = M['anod_black'], M['polymer_od'], M['polymer_od_grip'], M['rubber'], M['steel']
    upper = sym('h9_upper', [(yr, zb - 0.0135), (yf, zb - 0.0135), (yf, rail_z), (yr + 0.008, rail_z), (yr, rail_z - 0.005)], 0.0270, an, bevel=0.0016, seg=2)
    port = box('h9_port_cut', (0.0150, 0.032, zb + 0.0030), (0.008, 0.042, 0.0130), None, raw=True)
    cut(upper, [port])
    m.add('body', upper)
    m.add('body', box('h9_bolt', (0.0112, 0.033, zb + 0.0032), (0.0024, 0.032, 0.0090), M['steel_dark'], bevel=0.0004))
    m.add('body', picatinny('h9_rail', yr + 0.004, yf - 0.004, rail_z, an))
    lw_bot = 0.0285
    lower = sym('h9_lower', [(yr + 0.004, zb - 0.0135), (0.112, zb - 0.0135), (0.112, lw_bot + 0.002), (0.064, lw_bot + 0.002), (0.020, lw_bot + 0.002), (0.004, lw_bot), (-0.020, lw_bot + 0.004),
                              (yr + 0.004, zb - 0.034)], 0.0290, poly, bevel=0.0022, seg=2)
    m.add('body', lower)
    magwell = sym('h9_magwell', [(0.068, lw_bot + 0.004), (0.112, lw_bot + 0.004), (0.116, lw_bot - 0.016), (0.112, lw_bot - 0.021), (0.066, lw_bot - 0.021), (0.062, lw_bot - 0.016)],
                  0.0290, poly, bevel=0.0020, seg=2)
    cut(magwell, [box('h9_mag_hole', (0, 0.090, lw_bot - 0.015), (0.0220, 0.036, 0.016), None, raw=True)])
    m.add('body', magwell)
    guard = sym('h9_guard', [(0.008, lw_bot + 0.002), (0.066, lw_bot + 0.002), (0.066, trig.z - 0.024), (0.058, trig.z - 0.030), (0.012, trig.z - 0.030), (0.004, trig.z - 0.022)], 0.0120, poly, bevel=0.0016, seg=2)
    cut(guard, [sym('h9_guard_hole', [(0.015, lw_bot + 0.004), (0.060, lw_bot + 0.004), (0.060, trig.z - 0.023), (0.054, trig.z - 0.026), (0.018, trig.z - 0.026), (0.013, trig.z - 0.020)], 0.03, None, raw=True)])
    m.add('body', guard)
    m.add('body', trigger('h9_trigger', trig, M['steel_dark']))
    m.add('body', pistol_grip('h9_grip', tilt, 0.029, 0.058, polyg, top_extra=0.006))
    for sx in (1, -1):
        m.add('body', sym(f'h9_selector_{sx}', [(-0.004, zb - 0.026), (0.006, zb - 0.028), (0.016, zb - 0.024), (0.016, zb - 0.020), (0.004, zb - 0.019), (-0.004, zb - 0.021)], 0.0030, M['steel_dark'], x=sx * 0.0158, bevel=0.0006))
        m.add('body', cyl(f'h9_pin_{sx}', (sx * 0.0143, 0.100, zb - 0.022), (sx * 0.0157, 0.100, zb - 0.022), 0.0028, M['steel_dark'], seg=10, bevel=0.0004))
    m.add('body', cyl('h9_mag_release', (0.0145, 0.060, zb - 0.030), (0.0178, 0.060, zb - 0.030), 0.0038, M['steel_dark'], seg=12, bevel=0.0005))
    # Short slotted handguard, barrel and a vented compensator.
    guard_hg = octagon_guard('h9_handguard', yf - 0.001, yh, zb, 0.0215, rail_z, zb - 0.0290, 0.0090, an)
    cut(guard_hg, mlok_cutters('h9_slot', yf + 0.024, yh - 0.006, [(0.0215, zb - 0.004), (-0.0215, zb - 0.004)], [(1, 0), (-1, 0)], length=0.026, height=0.0066, pitch=0.040, corner=2))
    m.add('body', guard_hg)
    m.add('body', picatinny('h9_rail_front', yh - 0.050, yh - 0.003, rail_z, an))
    m.add('body', lathe('h9_barrel', [(0.0, 0.0086), (0.040, 0.0086)], st, origin=(0, yh - 0.004, zb), seg=16, bevel=0.0003))
    comp = lathe('h9_comp', [(0.0, 0.0108), (0.003, 0.0122), (0.040, 0.0122), (0.043, 0.0110), (0.044, 0.0065), (0.044, 0.0)], M['steel_dark'], origin=(0, yh + 0.034, zb), seg=16, bevel=0.0005)
    holes = [cyl(f'h9_comp_hole_{i}', (0, yh + 0.046 + i * 0.010, zb + 0.004), (0, yh + 0.046 + i * 0.010, zb + 0.020), 0.0028, None, seg=8, raw=True) for i in range(3)]
    cut(comp, holes)
    m.add('body', comp)
    m.add('body', sym('h9_handstop', [(yh - 0.040, zb - 0.0285), (yh - 0.012, zb - 0.0285), (yh - 0.016, zb - 0.040), (yh - 0.024, zb - 0.043), (yh - 0.034, zb - 0.036)], 0.0160, polyg, bevel=0.0022, seg=2))
    # Folding skeleton stock: hinge block, two struts and a rubber buttplate.
    m.add('body', box('h9_hinge', (0, yr - 0.010, zb - 0.010), (0.0240, 0.022, 0.034), an, bevel=0.0025, seg=2))
    m.add('body', cyl('h9_strut_top', (0, yr - 0.018, zb + 0.004), (0, -0.300, zb + 0.004), 0.0072, poly, seg=12, bevel=0.0))
    m.add('body', cyl('h9_strut_low', (0, yr - 0.018, zb - 0.024), (0, -0.296, zb - 0.074), 0.0060, poly, seg=12, bevel=0.0))
    m.add('body', sym('h9_cheek', [(-0.150, zb + 0.008), (-0.262, zb + 0.008), (-0.270, zb + 0.020), (-0.160, zb + 0.020)], 0.0220, polyg, bevel=0.0035, seg=3))
    m.add('body', sym('h9_buttplate', [(-0.296, zb + 0.016), (-0.312, zb + 0.016), (-0.314, zb - 0.088), (-0.296, zb - 0.092), (-0.292, zb - 0.040)], 0.0360, rub, bevel=0.0040, seg=3))
    # Open reflex sight: low body on the rail, thin hoop holding the window.
    sb = rail_z + 0.0092
    m.add('body', box('h9_rds_body', (0, 0.010, sb + 0.0055), (0.0240, 0.044, 0.0110), an, bevel=0.0024, seg=3))
    hoop = front('h9_rds_hoop', rrect(0.0270, 0.0230, 0.0060, 3, 0, sight_z + 0.0010), 0.023, 0.030, an, bevel=0.0010, seg=2)
    cut(hoop, [front('h9_rds_window', rrect(0.0220, 0.0180, 0.0040, 3, 0, sight_z + 0.0010), 0.0, 0.05, None, raw=True)])
    m.add('body', hoop)
    m.add('body', box('h9_rds_emitter', (0, -0.004, sb + 0.0130), (0.0080, 0.0060, 0.0050), an, bevel=0.0010))
    lens_y = 0.0265
    m.add('body', pane('h9_rds_glass', rrect(0.0224, 0.0184, 0.0041, 3, 0, sight_z + 0.0010), lens_y, M['glass']), flat=True)
    m.add('body', cyl('h9_rds_dot', (0, lens_y - 0.0010, sight_z), (0, lens_y - 0.0008, sight_z), 0.0010, M['glow_red'], seg=10, wn=False), flat=True)
    # Ambidextrous charging handle at the top rear (action).
    ch = top('h9_charger', [(-0.0200, -0.0040), (0.0200, -0.0040), (0.0200, 0.0040), (0.0060, 0.0060), (0.0060, 0.0160), (-0.0060, 0.0160), (-0.0060, 0.0060), (-0.0200, 0.0040)],
             zb + 0.0070, zb + 0.0150, M['steel_dark'], bevel=0.0014, seg=2)
    transform_obj(ch, Matrix.Translation((0, yr - 0.004, 0)))
    m.add('action', ch)
    m.pivots['action'] = Matrix.Translation((0, yr, zb))
    mag_top = (0.0, 0.090, lw_bot - 0.004)
    m.add('mag', *curved_magazine(M, 'h9_mag', mag_top, length=0.170, bend=6.0, depth=(0.0340, 0.0360), width=0.0205, body=M['polymer_black'], plate=M['polymer_od'], ribs=2))
    m.pivots['mag'] = Matrix.Translation(mag_top)
    m.anchor('grip_r', (0, 0, 0), anchor_rotation(RIGHT_HAND, r_grip))
    m.anchor('grip_l', (-0.0030, 0.200, zb - 0.0080), anchor_rotation(LEFT_HAND, handguard_frame(LEFT_ROLL['hornet9'])))
    m.anchor('muzzle', (0, yh + 0.080, zb))
    m.anchor('sight', (0, lens_y - 0.0010, sight_z))
    m.anchor('eject', (0.0170, 0.032, zb + 0.0030))
    m.extras = dict(boreHeight=zb, sightHeight=sight_z, trigger=[round(v, 5) for v in trig])
    return m


# =============================================================================================
# Breaker 12 pump shotgun
# =============================================================================================

def build_breaker12(M):
    """Breaker 12: pump shotgun with a walnut fore-end, vented heat shield and ghost-ring sights."""
    m = Model('breaker12')
    tilt = 17.0
    r_grip = grip_frame(tilt)
    trig = r_grip @ trigger_point_F()
    zb = 0.0720
    yr, yf = -0.036, 0.170
    yb = 0.640
    sight_z = zb + 0.0440   # ghost rings on tall bases: the comb stays well under the line
    an, st, poly, polyg, rub = M['anod_black'], M['steel'], M['polymer_black'], M['polymer_black_grip'], M['rubber']
    tube_z = zb - 0.0275
    # Receiver: arched top, big ejection port, loading port underneath.
    rec_pts = [(-0.0165, zb - 0.034), (0.0165, zb - 0.034), (0.0165, zb + 0.012), (0.0120, zb + 0.021), (0.0, zb + 0.024), (-0.0120, zb + 0.021), (-0.0165, zb + 0.012)]
    receiver = front('b12_receiver', rec_pts, yr, yf, an, bevel=0.0020, seg=2, angle=25)
    cut(receiver, [box('b12_port_cut', (0.0170, 0.104, zb + 0.004), (0.010, 0.072, 0.0190), None, raw=True),
                   box('b12_load_cut', (0, 0.100, zb - 0.036), (0.0230, 0.080, 0.010), None, raw=True)])
    m.add('body', receiver)
    m.add('body', box('b12_bolt', (0.0128, 0.104, zb + 0.0045), (0.0030, 0.060, 0.0150), M['steel_bright'], bevel=0.0006))
    m.add('body', box('b12_elevator', (0, 0.100, zb - 0.0300), (0.0200, 0.070, 0.0040), M['steel_dark'], bevel=0.0004))
    m.add('body', sym('b12_rear_cap', [(yr - 0.010, zb - 0.030), (yr + 0.002, zb - 0.034), (yr + 0.002, zb + 0.020), (yr - 0.010, zb + 0.012)], 0.0300, an, bevel=0.0024, seg=2))
    # Trigger group and safety.
    lw_bot = zb - 0.034
    guard = sym('b12_guard', [(-0.002, lw_bot + 0.002), (0.074, lw_bot + 0.002), (0.074, trig.z - 0.024), (0.066, trig.z - 0.030), (0.010, trig.z - 0.030), (0.002, trig.z - 0.022)], 0.0140, poly, bevel=0.0018, seg=2)
    cut(guard, [sym('b12_guard_hole', [(0.010, lw_bot + 0.004), (0.068, lw_bot + 0.004), (0.068, trig.z - 0.023), (0.062, trig.z - 0.026), (0.016, trig.z - 0.026), (0.010, trig.z - 0.020)], 0.03, None, raw=True)])
    m.add('body', guard)
    m.add('body', trigger('b12_trigger', trig, M['steel_dark']))
    m.add('body', cyl('b12_safety', (-0.0120, 0.000, zb - 0.034), (0.0120, 0.000, zb - 0.034), 0.0038, M['steel_dark'], seg=12, bevel=0.0006))
    m.add('body', pistol_grip('b12_grip', tilt, 0.030, 0.060, polyg, top_extra=0.012))
    # Moulded polymer stock: sides that bow out, a comb that rises toward the cheek, a slim wrist
    # behind the grip, a skeleton opening and a sling slot with rounded edges, a ribbed pad.
    rings = []
    stock_end = (-0.304, 0.0192, -0.1168, 0.0396, 0.0090)
    # The comb stays about 24 mm under the ghost-ring sight line so it never fills the aimed view.
    for y, t, b, w, r, bulge, crown in ((-0.030, 0.0150, -0.0330, 0.0320, 0.0070, 0.03, 0.000), (-0.055, 0.0158, -0.0385, 0.0335, 0.0085, 0.07, 0.001),
                                        (-0.090, 0.0170, -0.0485, 0.0360, 0.0095, 0.10, 0.0015), (-0.140, 0.0184, -0.0645, 0.0388, 0.0105, 0.12, 0.0015),
                                        (-0.190, 0.0194, -0.0815, 0.0404, 0.0110, 0.12, 0.0015), (-0.240, 0.0199, -0.0985, 0.0414, 0.0115, 0.12, 0.0015),
                                        (-0.280, 0.0200, -0.1125, 0.0418, 0.0115, 0.10, 0.0015), (-0.298, 0.0198, -0.1175, 0.0414, 0.0110, 0.06, 0.001),
                                        stock_end + (0.02, 0.0005)):
        rings.append(ring3(moulded_section(w, t - b, r, bulge, 0.0, zb + (t + b) / 2, crown), Vector((0, y, 0)), X, Z))
    stock = loft('b12_stock', rings, poly, raw=True)
    opening = chaikin([(-0.108, -0.0240), (-0.126, -0.0140), (-0.200, -0.0120), (-0.243, -0.0160), (-0.253, -0.0290), (-0.253, -0.0690), (-0.243, -0.0800),
                       (-0.222, -0.0795), (-0.150, -0.0510), (-0.120, -0.0400)], 2)
    cut(stock, [sym('b12_stock_hole', [(y, zb + z) for y, z in opening], 0.06, None, raw=True),
                sym('b12_sling_slot', rrect(0.0170, 0.0060, 0.0029, 3, -0.272, zb - 0.0985), 0.06, None, raw=True)])
    finish(stock, bevel=0.0024, seg=2, angle=35, wn=False, smooth=50)
    m.add('body', stock)
    # Recoil pad: follows the stock's outline, one groove round its side, a slightly domed face.
    y, t, b, w, r = stock_end
    pad_rings = []
    for py, grow in ((-0.302, -0.0004), (-0.3045, 0.0011), (-0.3125, 0.0013), (-0.3135, 0.0001), (-0.3150, 0.0013), (-0.3235, 0.0013), (-0.3258, 0.0004), (-0.3270, -0.0030)):
        pad_rings.append(ring3(moulded_section(w + 2 * grow, t - b + 2 * grow, r + max(0.0, grow), 0.02, 0.0, zb + (t + b) / 2), Vector((0, py, 0)), X, Z))
    m.add('body', loft('b12_pad', pad_rings, rub, wn=False, smooth=50))
    m.add('body', cyl('b12_qd', (-0.0170, -0.068, zb - 0.0120), (-0.0205, -0.068, zb - 0.0120), 0.0060, M['steel_dark'], seg=14, bevel=0.0006))
    # Barrel, vented heat shield, magazine tube, clamp and cap.
    m.add('body', lathe('b12_barrel', [(0.0, 0.0118), (yb - yf - 0.004, 0.0118), (yb - yf, 0.0110)], st, origin=(0, yf, zb), seg=18, bevel=0.0004))
    m.add('body', lathe('b12_bore', [(0.0, 0.0090), (0.003, 0.0090)], M['steel_dark'], origin=(0, yb - 0.0025, zb), seg=14, wn=False))
    shield_pts = [(0.0172 * math.cos(math.radians(a)), zb + 0.0172 * math.sin(math.radians(a))) for a in range(-10, 191, 20)]
    shield_pts += [(0.0136 * math.cos(math.radians(a)), zb + 0.0136 * math.sin(math.radians(a))) for a in range(190, -11, -20)]
    shield = front('b12_shield', shield_pts, yf + 0.010, yf + 0.300, an, bevel=0.0008, seg=1)
    holes = []
    for row, ang in enumerate((55, 125)):
        a = math.radians(ang)
        for i in range(6):
            y = yf + 0.040 + i * 0.042 + (0.021 if row else 0.0)
            c = Vector((math.cos(a) * 0.0155, y, zb + math.sin(a) * 0.0155))
            n = Vector((math.cos(a), 0, math.sin(a)))
            holes.append(cyl(f'b12_hole_{row}_{i}', c - n * 0.006, c + n * 0.006, 0.0058, None, seg=10, raw=True))
    holes.append(cyl('b12_hole_top', Vector((0, yf + 0.280, zb + 0.008)), Vector((0, yf + 0.280, zb + 0.024)), 0.0060, None, seg=10, raw=True))
    cut(shield, holes)
    m.add('body', shield)
    m.add('body', lathe('b12_tube', [(0.0, 0.0128), (0.415, 0.0128)], st, origin=(0, yf - 0.004, tube_z), seg=16, bevel=0.0004))
    m.add('body', lathe('b12_cap', [(0.0, 0.0130), (0.002, 0.0142), (0.020, 0.0142), (0.024, 0.0120), (0.026, 0.0)], M['steel_dark'], origin=(0, yf + 0.411, tube_z), seg=16, bevel=0.0005))
    clamp = front('b12_clamp', [(-0.0155, tube_z - 0.004), (0.0155, tube_z - 0.004), (0.0160, zb + 0.004), (0.0090, zb + 0.0140), (-0.0090, zb + 0.0140), (-0.0160, zb + 0.004)], yf + 0.380, yf + 0.398, M['steel_dark'], bevel=0.0012, seg=2)
    m.add('body', clamp)
    # Ghost-ring sights: aperture on the receiver, post on the barrel.
    iron_sights(m, M, 'b12_sight', 0.004, yb - 0.022, sight_z, zb + 0.0230, zb + 0.0108, M['steel_dark'], glow=M['glow_green'])
    # Left-side shell carrier with four shells.
    m.add('body', box('b12_saddle', (-0.0185, 0.060, zb - 0.012), (0.0040, 0.110, 0.0400), poly, bevel=0.0012, seg=2))
    for i in range(4):
        y = 0.022 + i * 0.026
        shell_axis_c = Vector((-0.0310, y, zb - 0.046))
        m.add('body', lathe(f'b12_shell_{i}', [(0.0, 0.0108), (0.064, 0.0108), (0.066, 0.0100), (0.066, 0.0)], M['shell_red'], origin=shell_axis_c, axis=(0, 0, 1), seg=12, wn=False, smooth=60))
        m.add('body', lathe(f'b12_head_{i}', [(0.0, 0.0), (0.0, 0.0118), (0.002, 0.0118), (0.002, 0.0110), (0.012, 0.0110), (0.012, 0.0)], M['brass'], origin=shell_axis_c - Vector((0, 0, 0.010)), axis=(0, 0, 1), seg=12, wn=False, smooth=60))
    # Walnut pump (action): grooved fore-end around the magazine tube.
    rings = []
    y0p, y1p = 0.300, 0.505
    for k in range(33):
        t = k / 32
        y = y0p + (y1p - y0p) * t
        end = min(t, 1 - t)
        s = 0.86 + 0.14 * min(1.0, end / 0.06)
        groove = 0.0 if (t < 0.20 or t > 0.80) else (0.035 if k % 2 else 0.0)
        rings.append(ring3(superellipse(0.0255 * (s - groove), 0.0225 * (s - groove), 2.4, 20, 0, tube_z + 0.0040), Vector((0, y, 0)), X, Z))
    pump = loft('b12_pump', rings, M['walnut'], wn=False, smooth=40)
    m.add('action', pump)
    m.add('action', box('b12_pump_bar_r', (0.0110, 0.240, tube_z + 0.0110), (0.0020, 0.130, 0.0050), M['steel_dark'], bevel=0.0004))
    m.add('action', box('b12_pump_bar_l', (-0.0110, 0.240, tube_z + 0.0110), (0.0020, 0.130, 0.0050), M['steel_dark'], bevel=0.0004))
    m.pivots['action'] = Matrix.Translation((0, y0p, zb))
    # `mag` is one shell seated just inside the loading port, nose forward.
    shell_c = Vector((0, 0.064, zb - 0.026))
    m.add('mag', lathe('b12_load_shell', [(0.0, 0.0108), (0.062, 0.0108), (0.064, 0.0098), (0.064, 0.0)], M['shell_red'], origin=shell_c, axis=(0, 1, 0), seg=12, wn=False, smooth=60))
    m.add('mag', lathe('b12_load_head', [(0.0, 0.0), (0.0, 0.0118), (0.002, 0.0118), (0.002, 0.0110), (0.012, 0.0110), (0.012, 0.0)], M['brass'], origin=shell_c - Vector((0, 0.010, 0)), axis=(0, 1, 0), seg=12, wn=False, smooth=60))
    m.pivots['mag'] = Matrix.Translation(shell_c - Vector((0, 0.010, 0)))
    m.anchor('grip_r', (0, 0, 0), anchor_rotation(RIGHT_HAND, r_grip))
    m.anchor('grip_l', (0, 0.405, tube_z + 0.0010), anchor_rotation(LEFT_HAND, handguard_frame(LEFT_ROLL['breaker12'])))
    m.anchor('muzzle', (0, yb + 0.002, zb))
    m.anchor('sight', (0, 0.004, sight_z))
    m.anchor('eject', (0.0190, 0.104, zb + 0.0040))
    m.extras = dict(boreHeight=zb, sightHeight=sight_z, trigger=[round(v, 5) for v in trig], magKind='shell')
    return m


# =============================================================================================
# Longbow bolt-action rifle
# =============================================================================================

def build_longbow(M):
    """Longbow: chassis bolt rifle, fluted heavy barrel, big brake, 4x-class scope on a rail."""
    m = Model('longbow')
    tilt = 12.0
    r_grip = grip_frame(tilt)
    trig = r_grip @ trigger_point_F()
    zb = 0.0730
    yr, yf = -0.050, 0.190
    yb = 0.760
    grey, an, st, polyg, rub = M['anod_grey'], M['anod_black'], M['steel'], M['polymer_black_grip'], M['rubber']
    rail_z = zb + 0.0255
    sight_z = rail_z + 0.0095 + 0.0170 + 0.0150
    # Round action on a chassis.
    action_body = lathe('lb_action', [(0.0, 0.0), (0.0, 0.0150), (0.004, 0.0178), (0.236, 0.0178), (0.240, 0.0160), (0.244, 0.0)], st, origin=(0, yr + 0.004, zb), seg=20, bevel=0.0005)
    cut(action_body, [box('lb_port_cut', (0.0150, 0.050, zb + 0.004), (0.012, 0.070, 0.0170), None, raw=True)])
    m.add('body', action_body)
    chassis_pts = [(yr - 0.006, zb - 0.010), (yf + 0.004, zb - 0.010), (yf + 0.004, zb - 0.034), (0.150, zb - 0.048), (0.075, zb - 0.048), (0.075, zb - 0.040),
                   (0.018, zb - 0.040), (0.004, zb - 0.046), (-0.022, zb - 0.042), (yr - 0.006, zb - 0.034)]
    chassis = sym('lb_chassis', chassis_pts, 0.0420, grey, bevel=0.0026, seg=2)
    cut(chassis, [box('lb_mag_hole', (0, 0.112, zb - 0.044), (0.0300, 0.068, 0.020), None, raw=True)])
    m.add('body', chassis)
    port_frame = box('lb_port_floor', (0.0150, 0.050, zb + 0.004), (0.0020, 0.068, 0.0160), M['steel_dark'], bevel=0.0003)
    m.add('body', port_frame)
    m.add('body', box('lb_rail_base', (0, 0.070, zb + 0.0205), (0.0200, 0.270, 0.0060), grey, bevel=0.0010, seg=2))
    m.add('body', picatinny('lb_rail', -0.064, 0.204, rail_z, grey, tooth_bevel=0.0))
    # Trigger guard, grip and controls.
    lw_bot = zb - 0.040
    guard = sym('lb_guard', [(0.000, lw_bot + 0.002), (0.074, lw_bot + 0.002), (0.074, trig.z - 0.024), (0.066, trig.z - 0.030), (0.012, trig.z - 0.030), (0.004, trig.z - 0.022)], 0.0130, grey, bevel=0.0016, seg=2)
    cut(guard, [sym('lb_guard_hole', [(0.010, lw_bot + 0.004), (0.068, lw_bot + 0.004), (0.068, trig.z - 0.023), (0.062, trig.z - 0.026), (0.016, trig.z - 0.026), (0.010, trig.z - 0.020)], 0.03, None, raw=True)])
    m.add('body', guard)
    m.add('body', trigger('lb_trigger', trig, M['steel_bright'], height=0.022, curve=0.004))
    m.add('body', pistol_grip('lb_grip', tilt, 0.032, 0.062, polyg, top_extra=0.010, width=0.0310))
    m.add('body', sym('lb_safety', [(-0.040, zb + 0.008), (-0.022, zb + 0.008), (-0.024, zb + 0.014), (-0.038, zb + 0.014)], 0.0060, M['steel_dark'], x=0.0170, bevel=0.0010))
    # Folding chassis stock: a hinge block, a slotted top spine and an angled lower strut (both kept
    # below the bolt's path), a butt plate with a thick grooved pad, and a cheek riser on two posts
    # set behind the bolt's full travel.
    sd, pb = M['steel_dark'], M['polymer_black']
    m.add('body', box('lb_hinge', (0, -0.068, zb - 0.0330), (0.0320, 0.028, 0.0360), grey, bevel=0.0026, seg=2))
    m.add('body', cyl('lb_hinge_pin', (-0.0150, -0.074, zb - 0.0515), (-0.0150, -0.074, zb - 0.0145), 0.0046, sd, seg=12, bevel=0.0005))
    spine = front('lb_spine', rrect(0.0220, 0.0240, 0.0050, 3, 0, zb - 0.0260), -0.336, -0.078, grey, bevel=0.0012, seg=2)
    cut(spine, mlok_cutters('lb_spine_slot', -0.300, -0.090, [(0.0110, zb - 0.0260), (-0.0110, zb - 0.0260)], [(1, 0), (-1, 0)],
                            length=0.034, height=0.0088, pitch=0.046, depth=0.0024, corner=2))
    m.add('body', spine)
    p0, p1 = Vector((0, -0.074, zb - 0.0460)), Vector((0, -0.338, zb - 0.1010))
    axis = (p1 - p0).normalized()
    across = Vector((0, -axis.z, axis.y))
    m.add('body', loft('lb_strut', [ring3(rrect(0.0160, 0.0130, 0.0040, 3), p0 + axis * t, X, across) for t in (0.0, (p1 - p0).length)], grey, bevel=0.0010, seg=2))
    m.add('body', box('lb_buttplate', (0, -0.3405, zb - 0.0480), (0.0360, 0.0110, 0.1180), grey, bevel=0.0018, seg=2))
    for z in (zb - 0.010, zb - 0.086):
        m.add('body', cyl(f'lb_butt_screw_{round(z, 3)}', (-0.0180, -0.3405, z), (-0.0200, -0.3405, z), 0.0034, sd, seg=10, bevel=0.0004))
    pad_rings = []
    for py, grow in ((-0.3450, -0.0004), (-0.3475, 0.0010), (-0.3560, 0.0012), (-0.3570, 0.0001), (-0.3585, 0.0012), (-0.3670, 0.0012), (-0.3692, 0.0003), (-0.3705, -0.0030)):
        pad_rings.append(ring3(moulded_section(0.0380 + 2 * grow, 0.1220 + 2 * grow, 0.0100 + max(0.0, grow), 0.04, 0.0, zb - 0.0480), Vector((0, py, 0)), X, Z))
    m.add('body', loft('lb_pad', pad_rings, rub, wn=False, smooth=50))
    rings = []
    for y, top_z, w, crown in ((-0.196, zb + 0.0230, 0.0260, 0.001), (-0.202, zb + 0.0270, 0.0300, 0.002), (-0.230, zb + 0.0285, 0.0320, 0.003),
                               (-0.270, zb + 0.0285, 0.0320, 0.003), (-0.296, zb + 0.0270, 0.0300, 0.002), (-0.302, zb + 0.0230, 0.0260, 0.001)):
        bottom = zb - 0.0090
        rings.append(ring3(moulded_section(w, top_z - bottom, 0.0080, 0.05, 0.0, (top_z + bottom) / 2, crown), Vector((0, y, 0)), X, Z))
    m.add('body', loft('lb_riser', rings, pb, wn=False, smooth=50))
    for y in (-0.214, -0.284):
        m.add('body', cyl(f'lb_riser_post_{y}', (0, y, zb - 0.0150), (0, y, zb - 0.0080), 0.0042, sd, seg=10))
    m.add('body', cyl('lb_riser_knob', (-0.0110, -0.214, zb - 0.0240), (-0.0175, -0.214, zb - 0.0240), 0.0068, pb, seg=14, bevel=0.0010))
    # Long slotted handguard.
    hg = octagon_guard('lb_handguard', yf - 0.002, 0.520, zb, 0.0250, zb + 0.0200, zb - 0.0320, 0.0100, grey)
    cut(hg, mlok_cutters('lb_slot', yf + 0.040, 0.510, [(0.0250, zb - 0.006), (-0.0250, zb - 0.006), (0.0, zb - 0.0320)], [(1, 0), (-1, 0), (0, -1)], pitch=0.050, corner=2))
    m.add('body', hg)
    # Fluted heavy barrel and a three-port brake.
    m.add('body', lathe('lb_barrel_root', [(0.0, 0.0145), (0.030, 0.0145), (0.040, 0.0128)], st, origin=(0, 0.505, zb), seg=18, bevel=0.0004))
    flute = []
    for i in range(36):
        a = 2 * math.pi * i / 36
        r = 0.0124 - (0.0016 if (i % 6) in (2, 3) else 0.0)
        flute.append((math.cos(a) * r, zb + math.sin(a) * r))
    m.add('body', front('lb_barrel', flute, 0.544, yb - 0.004, st, bevel=0.0, wn=False, smooth=40))
    yk = yb - 0.004
    brake = front('lb_brake', rrect(0.0300, 0.0260, 0.0080, 3, 0, zb), yk, yk + 0.062, M['steel_dark'], bevel=0.0018, seg=2)
    ports = [box(f'lb_port_{i}', (0, yk + 0.012 + i * 0.016, zb), (0.040, 0.0085, 0.0170), None, raw=True) for i in range(3)]
    cut(brake, ports + [lathe('lb_brake_bore', [(0.0, 0.0060), (0.10, 0.0060)], None, origin=(0, yk - 0.01, zb), seg=12, raw=True)])
    m.add('body', brake)
    # Scope: rings, tube, bells, turrets; lenses are separate glossy primitives.
    for y in (-0.020, 0.120):
        ring_pts = [(-0.0110, rail_z + 0.0090), (0.0110, rail_z + 0.0090), (0.0165, sight_z - 0.006), (0.0165, sight_z + 0.004), (-0.0165, sight_z + 0.004), (-0.0165, sight_z - 0.006)]
        ring = front(f'lb_ring_{y}', ring_pts, y - 0.008, y + 0.008, an, bevel=0.0012, seg=2)
        cut(ring, [lathe(f'lb_ring_bore_{y}', [(0.0, 0.0152), (0.04, 0.0152)], None, origin=(0, y - 0.02, sight_z), seg=20, raw=True)])
        m.add('body', ring)
        m.add('body', box(f'lb_ring_cap_{y}', (0, y, sight_z + 0.0150), (0.0200, 0.016, 0.0050), an, bevel=0.0012, seg=2))
    sc0 = -0.110
    # The ocular end is a recessed glass face inside a hollow rubber eyecup; the objective glass
    # sits a few millimetres inside the bell's rim.
    scope_prof = [(0.0, 0.0), (0.0, 0.0175), (0.004, 0.0195), (0.040, 0.0195), (0.060, 0.0160), (0.072, 0.0150), (0.235, 0.0150), (0.285, 0.0265), (0.315, 0.0275),
                  (0.330, 0.0270), (0.330, 0.0236), (0.324, 0.0236), (0.324, 0.0)]
    m.add('body', lathe('lb_scope', scope_prof, an, origin=(0, sc0, sight_z), seg=24, bevel=0.0006))
    m.add('body', lathe('lb_eyecup', [(0.0, 0.0172), (0.0, 0.0205), (0.020, 0.0212), (0.024, 0.0200), (0.024, 0.0185), (0.004, 0.0172)], M['rubber'],
                        origin=(0, sc0 - 0.024, sight_z), seg=24, closed=True, wn=False, smooth=60))
    m.add('body', lathe('lb_ocular', [(0.0, 0.0), (0.0, 0.0160), (0.0012, 0.0160), (0.0012, 0.0)], M['lens'], origin=(0, sc0 - 0.0016, sight_z), seg=24, wn=False), flat=True)
    m.add('body', lathe('lb_objective', [(0.0, 0.0), (0.0, 0.0234), (0.0010, 0.0234), (0.0010, 0.0)], M['lens'], origin=(0, sc0 + 0.3242, sight_z), seg=24, wn=False), flat=True)
    tz = sc0 + 0.150
    m.add('body', lathe('lb_turret_saddle', [(0.0, 0.0), (0.0, 0.0180), (0.024, 0.0180), (0.024, 0.0)], an, origin=(0, tz - 0.012, sight_z), seg=20, bevel=0.0008))
    for axis, length, r in (((0, 0, 1), 0.020, 0.0125), ((1, 0, 0), 0.020, 0.0115), ((-1, 0, 0), 0.016, 0.0105)):
        a = Vector(axis)
        m.add('body', lathe(f'lb_turret_{axis}', [(0.012, 0.0080), (0.014, 0.0080), (0.015, r), (length + 0.012, r), (length + 0.013, r - 0.0012), (length + 0.013, 0.0)], M['steel_dark'],
                            origin=(0, tz, sight_z), axis=a, seg=16, bevel=0.0005))
    # Bolt (action): body along the bore and a handle with a large round knob on the right.
    bolt_y = yr - 0.006
    bolt = [lathe('lb_bolt', [(0.0, 0.0), (0.0, 0.0110), (0.012, 0.0125), (0.040, 0.0125), (0.044, 0.0090), (0.160, 0.0090)], M['steel_dark'], origin=(0, bolt_y - 0.042, zb), seg=16, bevel=0.0005)]
    root = Vector((0.0085, bolt_y - 0.006, zb))
    knob = Vector((0.0560, bolt_y - 0.028, zb - 0.018))
    bolt.append(cyl('lb_bolt_arm', root, knob, 0.0042, M['steel_dark'], seg=10, r1=0.0040))
    bolt.append(lathe('lb_bolt_knob', [(0.0, 0.0), (0.0, 0.0060), (0.004, 0.0098), (0.016, 0.0102), (0.022, 0.0080), (0.024, 0.0)], M['polymer_black_grip'], origin=knob - Vector((0.004, 0, 0)), axis=(1, 0, 0), seg=18, wn=False, smooth=60))
    m.add('action', *bolt)
    m.pivots['action'] = Matrix.Translation((0, bolt_y, zb))
    # Detachable five-round box magazine.
    mag_top = (0.0, 0.112, zb - 0.030)
    m.add('mag', *curved_magazine(M, 'lb_mag', mag_top, length=0.064, bend=2.0, depth=(0.0640, 0.0660), width=0.0270, body=M['steel_dark'], plate=M['polymer_black'], ribs=1, n=6))
    m.pivots['mag'] = Matrix.Translation(mag_top)
    m.anchor('grip_r', (0, 0, 0), anchor_rotation(RIGHT_HAND, r_grip))
    m.anchor('grip_l', (0, 0.420, zb - 0.0080), anchor_rotation(LEFT_HAND, handguard_frame(LEFT_ROLL['longbow'])))
    m.anchor('muzzle', (0, yk + 0.064, zb))
    m.anchor('sight', (0, sc0 - 0.0020, sight_z))
    m.anchor('eject', (0.0200, 0.050, zb + 0.0040))
    m.extras = dict(boreHeight=zb, sightHeight=sight_z, trigger=[round(v, 5) for v in trig], scope=True)
    return m


# =============================================================================================
# Sentry 9 pistol
# =============================================================================================

def build_sentry9(M):
    """Sentry 9: polymer-frame service pistol with a serrated slide and glowing night sights."""
    m = Model('sentry9')
    tilt = 10.0
    r_grip = grip_frame(tilt)
    trig = r_grip @ trigger_point_F()
    ys0, ys1 = -0.046, 0.142
    travel = SLIDE_TRAVEL
    # The slide must ride clear of the firing hand through its whole travel. The gloved fist is a
    # rifle grip whose web rises well above the trigger finger, so the bore sits higher above the
    # hand than on a real pistol and the grip is fairly upright. With the arms built first, the
    # slide's underside is placed from the seated hand itself: a thin frame tang over the web,
    # then the slide just above it.
    hand = seated_points('arm_right', anchor_rotation(RIGHT_HAND, r_grip))
    if hand is not None:
        under = hand[(np.abs(hand[:, 0]) < 0.0140) & (hand[:, 1] > ys0 - travel - 0.004)]
        web_top = float(under[:, 2].max())
    else:
        web_top = 0.0575
    slide_bot = round(web_top + 0.0034, 4)
    zb = slide_bot + 0.0075
    slide_top = zb + 0.0205
    sight_z = slide_top + 0.0058
    frame_m, frame_g = M['polymer_black'], M['polymer_black_grip']
    # Frame: dust cover with rail, trigger guard, a thin tang over the web of the hand, grip.
    frame_pts = [(ys0 + 0.008, slide_bot), (ys1 - 0.004, slide_bot), (ys1 - 0.006, zb - 0.030), (0.096, zb - 0.030), (0.092, zb - 0.036), (0.016, zb - 0.036),
                 (0.006, zb - 0.040), (-0.012, zb - 0.036), (-0.020, slide_bot - 0.0024), (ys0 - 0.008, slide_bot - 0.0024), (ys0 - 0.011, slide_bot - 0.0010),
                 (ys0 - 0.010, slide_bot)]
    frame = sym('s9_frame', frame_pts, 0.0250, frame_m, bevel=0.0010, seg=2)
    m.add('body', frame)
    tg = sym('s9_guard', [(0.010, zb - 0.036), (0.094, zb - 0.036), (0.098, trig.z - 0.014), (0.090, trig.z - 0.022), (0.016, trig.z - 0.022), (0.006, trig.z - 0.016)], 0.0120, frame_m, bevel=0.0018, seg=2)
    cut(tg, [sym('s9_guard_hole', [(0.016, zb - 0.038), (0.088, zb - 0.038), (0.090, trig.z - 0.012), (0.084, trig.z - 0.017), (0.020, trig.z - 0.017), (0.014, trig.z - 0.012)], 0.03, None, raw=True)])
    m.add('body', tg)
    m.add('body', trigger('s9_trigger', trig, frame_m, height=0.024, curve=0.006))
    bar_top = zb - 0.034
    if bar_top > trig.z + 0.008:  # the trigger blade reaches up into the frame
        m.add('body', box('s9_trigger_bar', (0, trig.y - 0.0028, (trig.z + 0.006 + bar_top) / 2), (0.0050, 0.0040, bar_top - trig.z - 0.006), frame_m, bevel=0.0006))
    m.add('body', pistol_grip('s9_grip', tilt, 0.034, 0.056, frame_g, top_extra=0.004, width=0.0300, depth=0.0480))
    for i in range(3):
        m.add('body', box(f's9_rail_{i}', (0, 0.104 + i * 0.012, zb - 0.0310), (0.0200, 0.0060, 0.0030), frame_m, bevel=0.0005))
    m.add('body', sym('s9_slide_stop', [(0.020, zb - 0.010), (0.052, zb - 0.010), (0.054, zb - 0.005), (0.020, zb - 0.004)], 0.0022, M['steel_dark'], x=-0.0135, bevel=0.0005))
    m.add('body', box('s9_mag_release', (-0.0130, 0.010, zb - 0.022), (0.0030, 0.010, 0.0070), M['steel_dark'], bevel=0.0010))
    m.add('body', box('s9_takedown', (0.0130, 0.078, zb - 0.016), (0.0024, 0.012, 0.0030), M['steel_dark'], bevel=0.0006))
    # Barrel crown and hood visible in the port.
    m.add('body', lathe('s9_barrel', [(0.0, 0.0068), (0.150, 0.0068)], M['steel_bright'], origin=(0, -0.006, zb), seg=14, bevel=0.0003))
    m.add('body', box('s9_hood', (0, 0.012, zb + 0.0150), (0.0150, 0.034, 0.0050), M['steel_bright'], bevel=0.0006))
    # Slide (action): angular top, front and rear serrations, ejection port, night sights.
    slide_pts = [(-0.0130, slide_bot), (0.0130, slide_bot), (0.0130, slide_top - 0.0060), (0.0090, slide_top), (-0.0090, slide_top), (-0.0130, slide_top - 0.0060)]
    slide = front('s9_slide', slide_pts, ys0, ys1, M['steel_dark'], bevel=0.0012, seg=2, angle=25)
    cuts = [box('s9_port', (0.0040, 0.012, zb + 0.0150), (0.0200, 0.036, 0.016), None, raw=True),
            lathe('s9_muzzle_bore', [(0.0, 0.0072), (0.02, 0.0072)], None, origin=(0, ys1 - 0.010, zb), seg=14, raw=True)]
    for side_x in (1, -1):
        for i in range(7):
            cuts.append(box(f's9_ser_r_{side_x}_{i}', (side_x * 0.0135, ys0 + 0.008 + i * 0.0040, zb + 0.004), (0.0016, 0.0016, 0.026), None, raw=True))
        for i in range(5):
            cuts.append(box(f's9_ser_f_{side_x}_{i}', (side_x * 0.0135, ys1 - 0.030 + i * 0.0040, zb + 0.004), (0.0016, 0.0016, 0.026), None, raw=True))
    cut(slide, cuts)
    m.add('action', slide)
    # Night sights. The rear blade and the front post have their tops on the sight line; a deep
    # U-notch (3 mm) frames the front post with light on both sides, so the post and its glowing
    # dot sit inside the notch between the two rear dots when aiming.
    rear = box('s9_rear_sight', (0, -0.030, sight_z - 0.0034), (0.0180, 0.0080, 0.0068), M['steel_dark'], bevel=0.0008, seg=2)
    cut(rear, [box('s9_notch', (0, -0.030, sight_z), (0.0040, 0.012, 0.0060), None, raw=True)])
    m.add('action', rear)
    m.add('action', box('s9_front_sight', (0, 0.130, sight_z - 0.0034), (0.0033, 0.0060, 0.0068), M['steel_dark'], bevel=0.0005))
    for sx in (1, -1):
        m.add('action', cyl(f's9_tritium_r_{sx}', (sx * 0.0050, -0.0342, sight_z - 0.0020), (sx * 0.0050, -0.0337, sight_z - 0.0020), 0.0010, M['glow_green'], seg=8, wn=False), flat=True)
    m.add('action', cyl('s9_tritium_f', (0, 0.1268, sight_z - 0.0018), (0, 0.1273, sight_z - 0.0018), 0.0009, M['glow_green'], seg=8, wn=False), flat=True)
    m.pivots['action'] = Matrix.Translation((0, ys0, zb))
    # Magazine inside the grip; its baseplate shows under the flared well. Drops along local -Y.
    mag_dir = (r_grip @ Vector((0, 0, -1))).normalized()
    mag_top = r_grip @ Vector((0, 0.002, 0.026))
    mag = []
    rings = []
    for t in (0.0, 0.088):
        c = mag_top + mag_dir * t
        rings.append(ring3(rrect(0.0215, 0.0330, 0.0045, 3), c, X, r_grip.col[1]))
    body = loft('s9_mag_body', rings, M['steel_dark'], raw=True)
    finish(body, wn=False, smooth=70)
    mag.append(body)
    base_c = mag_top + mag_dir * 0.088
    plate_rings = [ring3(rrect(0.0300, 0.0480, 0.0070, 3), base_c + mag_dir * t, X, r_grip.col[1]) for t in (0.0, 0.006, 0.010)]
    plate = loft('s9_mag_plate', plate_rings, frame_m, raw=True)
    finish(plate, wn=False, smooth=60)
    mag.append(plate)
    m.add('mag', *mag)
    pivot = r_grip.to_4x4()
    pivot.translation = mag_top
    m.pivots['mag'] = pivot
    # Support hand wraps the firing hand: palm on the left of the grip, fingers round the front.
    m.anchor('grip_r', (0, 0, 0), anchor_rotation(RIGHT_HAND, r_grip))
    # Canted forward so the support thumb lies along the frame rather than pointing up. The pose was
    # set against an 18-degree grip; turning it with the grip keeps it wrapped round the firing hand.
    turn = r_grip @ grip_frame(18.0).transposed()
    r_left = turn @ grip_frame(18.0 + 52.0) @ Matrix.Rotation(math.radians(LEFT_ROLL['sentry9']), 3, Z)
    m.anchor('grip_l', turn @ Vector((-0.0100, 0.0060, -0.0060)), anchor_rotation(LEFT_HAND, r_left))
    m.anchor('muzzle', (0, ys1 + 0.001, zb))
    m.anchor('sight', (0, -0.030, sight_z))
    m.anchor('eject', (0.0080, 0.012, zb + 0.0170))
    m.extras = dict(boreHeight=zb, sightHeight=sight_z, trigger=[round(v, 5) for v in trig])
    return m


# =============================================================================================
# Knife and frag
# =============================================================================================

def build_knife(M):
    """Fixed-blade combat knife: coated drop-point blade, small guard, stippled grip, steel pommel."""
    m = Model('knife')
    ht = Vector((0, 1, 0))
    # Blade: lofted sections with a flat grind and a bright edge bevel.
    rings = []
    stations = 16
    tip_z = -0.0035
    for k in range(stations + 1):
        t = k / stations
        y = 0.058 + 0.170 * t
        s0, b0 = 0.0145 - 0.003 * min(t, 0.62), -0.0175 + 0.002 * min(t, 0.55)
        spine = s0 if t < 0.62 else s0 - (s0 - tip_z) * ((t - 0.62) / 0.38) ** 1.5
        belly = b0 if t < 0.55 else b0 + (tip_z - b0) * ((t - 0.55) / 0.45) ** 1.8
        spine = max(spine, belly + 0.0003)
        thick = max(0.0003, 0.0046 * (1 - 0.55 * t) * (1 - max(0.0, t - 0.8) / 0.2 * 0.85))
        grind = belly + (spine - belly) * 0.45
        rings.append(ring3([(-thick / 2, spine), (thick / 2, spine), (thick / 2, grind), (0.00025, belly), (-0.00025, belly), (-thick / 2, grind)], Vector((0, y, 0)), X, Z))
    blade = loft('knife_blade', rings, M['blade'], wn=False, smooth=25)
    m.add('body', blade)
    m.add('body', box('knife_guard', (0, 0.054, -0.0015), (0.0110, 0.0080, 0.0480), M['steel_dark'], bevel=0.0018, seg=2))
    # Handle: oval sections with finger swells.
    rings = []
    for k in range(13):
        t = k / 12
        y = 0.050 - 0.112 * t
        swell = 1.0 + 0.07 * math.sin(t * math.pi * 3.0)
        rings.append(ring3(superellipse(0.0128 * swell, 0.0180 * swell, 2.3, 20, 0, -0.0010), Vector((0, y, 0)), X, Z))
    m.add('body', loft('knife_handle', rings, M['polymer_fde_grip'], wn=False, smooth=60))
    pommel = lathe('knife_pommel', [(0.0, 0.0132), (0.012, 0.0142), (0.020, 0.0114), (0.022, 0.0)], M['steel_dark'], origin=(0, -0.062, -0.0010), axis=(0, -1, 0), seg=16, bevel=0.0006)
    cut(pommel, [cyl('knife_lanyard', (-0.02, -0.074, -0.0010), (0.02, -0.074, -0.0010), 0.0032, None, seg=10, raw=True)])
    m.add('body', pommel)
    # The right fist holds the handle with the blade forward and the edge down: the held axis
    # runs along +Y, the back of the hand faces right and the fingers wrap underneath.
    r_hold = frame_matrix(Vector((1, 0, 0)), Vector((0, 0, -1)), Vector((0, 1, 0)))
    m.anchor('grip_r', (0, 0, 0), anchor_rotation(RIGHT_HAND, r_hold))
    m.extras = dict(edge='-Y (glTF) / down', length=0.30)
    return m


def build_frag(M):
    """Fragmentation grenade: ovoid body with a marking band, fuze, spoon and pull ring."""
    m = Model('frag')
    prof = [(-0.0400, 0.0), (-0.0392, 0.0080), (-0.0360, 0.0175), (-0.0290, 0.0255), (-0.0180, 0.0305), (-0.0050, 0.0322), (0.0080, 0.0315),
            (0.0190, 0.0280), (0.0270, 0.0220), (0.0320, 0.0150), (0.0340, 0.0110), (0.0340, 0.0)]
    m.add('body', lathe('frag_body', prof, M['od_paint'], origin=(0, 0, 0), axis=(0, 0, 1), seg=28, wn=False, smooth=60))
    m.add('body', lathe('frag_band', [(0.0, 0.0318), (0.0002, 0.0323), (0.0040, 0.0323), (0.0042, 0.0318)], M['marking_yellow'], origin=(0, 0, 0.0122), axis=(0, 0, 1), seg=28, wn=False, smooth=60))
    m.add('body', lathe('frag_fuze', [(0.0, 0.0115), (0.010, 0.0115), (0.012, 0.0100), (0.016, 0.0100), (0.016, 0.0)], M['steel_dark'], origin=(0, 0, 0.0320), axis=(0, 0, 1), seg=16, bevel=0.0005))
    # Spoon: a curved strip from the fuze over the shoulder and down the side.
    rings = []
    path = [(0.0, 0.0480), (0.0100, 0.0482), (0.0175, 0.0445), (0.0245, 0.0340), (0.0305, 0.0215), (0.0335, 0.0080), (0.0338, -0.0040), (0.0330, -0.0100)]
    for i, (x, z) in enumerate(path):
        if i < len(path) - 1:
            dx, dz = path[i + 1][0] - x, path[i + 1][1] - z
        else:
            dx, dz = x - path[i - 1][0], z - path[i - 1][1]
        n = Vector((dz, 0, -dx)).normalized()
        w = 0.0105 if i > 0 else 0.0095
        rings.append(ring3(rrect(w, 0.0014, 0.0005, 1), Vector((x, 0, z)), Y, n))
    m.add('body', loft('frag_spoon', rings, M['steel'], wn=False, smooth=50))
    m.add('body', cyl('frag_pin', (-0.0050, 0.0, 0.0410), (-0.0200, 0.0, 0.0410), 0.0012, M['steel_bright'], seg=8, wn=False))
    m.add('body', torus('frag_ring', (-0.0300, 0.0, 0.0410), (0, 1, 0), 0.0105, 0.0013, M['steel_bright'], seg=20, rseg=6))
    m.extras = dict(diameter=0.064)
    return m


BUILDERS = {'kr5': build_kr5, 'hornet9': build_hornet9, 'breaker12': build_breaker12, 'longbow': build_longbow, 'sentry9': build_sentry9, 'knife': build_knife, 'frag': build_frag}
LEFT_ROLL['sentry9'] = -45.0


def knife_hold_rotation():
    """Where a knife sits in the left fist (arm space): handle along the fist's held axis, blade out
    of the thumb end, edge toward the fingers. The view model puts its knife on the `hold` node."""
    r_hold = frame_matrix(Vector((1, 0, 0)), Vector((0, 0, -1)), Vector((0, 1, 0)))
    return anchor_rotation(LEFT_HAND, r_hold).transposed()


def build_all(only):
    M = build_materials()
    models = {}
    if only and 'sentry9' in only and 'arm_right' not in only:
        only = list(only) + ['arm_right']  # the pistol's slide is fitted over the seated right hand
    # Arms first: the pistol is fitted to the right hand (see build_sentry9).
    for mid in ['arm_left', 'arm_right'] + [m for m in MODEL_IDS if not m.startswith('arm_')]:
        if only and mid not in only:
            continue
        started = time.time()
        if mid in ('arm_left', 'arm_right'):
            spec = LEFT_HAND if mid == 'arm_left' else RIGHT_HAND
            model = Model(mid)
            arm, skel, r_fa = build_arm(spec, M, mid)
            model.add('arm', arm)
            model.extras = dict(heldAxis=list(spec['held_axis_arm']))
            co = np.empty(len(arm.data.vertices) * 3, np.float32)
            arm.data.vertices.foreach_get('co', co)
            HAND_POINTS[mid] = co.reshape(-1, 3).astype(np.float64)
            if mid == 'arm_left':
                model.anchor('hold', (0, 0, 0), knife_hold_rotation())
        elif mid in BUILDERS:
            model = BUILDERS[mid](M)
        else:
            continue
        finalize_model(model)
        for stray in [o for o in BUILD.objects if o.type == 'MESH' and o.parent is None]:
            log(f'removed stray object {stray.name}')
            bpy.data.objects.remove(stray, do_unlink=True)
        tris = sum(grid_tris(ob) for ob in model.meshes.values())
        model.extras['triangles'] = tris
        models[mid] = model
        log(f'{mid}: {tris} triangles, {len(model.meshes)} meshes, built in {time.time() - started:.1f}s')
    return M, {mid: models[mid] for mid in MODEL_IDS if mid in models}


# =============================================================================================
# Unwrap, bake and export
# =============================================================================================

def model_meshes(model):
    return [ob for ob in model_objects(model) if ob.type == 'MESH']


def unwrap(model, size):
    """Smart-project every mesh of a model and pack all islands into one shared atlas."""
    objs = model_meshes(model)
    for ob in objs:
        # Triangles only, so baked tangent space and the exported tangents agree exactly.
        tri = ob.modifiers.new('Triangulate', 'TRIANGULATE')
        tri.min_vertices = 4
        tri.quad_method = 'BEAUTY'
        tri.ngon_method = 'BEAUTY'
        if hasattr(tri, 'keep_custom_normals'):
            tri.keep_custom_normals = True
        apply_mods(ob)
        while ob.data.uv_layers:
            ob.data.uv_layers.remove(ob.data.uv_layers[0])
        ob.data.uv_layers.new(name='UVMap')
    bpy.ops.object.select_all(action='DESELECT')
    for ob in objs:
        ob.hide_viewport = False
        ob.hide_set(False)
        ob.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    # Without a UV editor the UV selection follows the mesh selection only in sync mode.
    bpy.context.scene.tool_settings.use_uv_select_sync = True
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(52), island_margin=0.0, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    # Eight texels of the full-size atlas between islands keeps mip levels clean (and lets
    # reduced test bakes pack exactly like the real ones).
    bpy.ops.uv.pack_islands(rotate=True, margin_method='FRACTION', margin=8.0 / TEXTURE_SIZE[model.id], shape_method='CONCAVE', scale=True)
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='DESELECT')
    lo, hi = np.full(2, 1e9), np.full(2, -1e9)
    for ob in objs:
        uv = np.empty(len(ob.data.uv_layers['UVMap'].data) * 2, np.float32)
        ob.data.uv_layers['UVMap'].data.foreach_get('uv', uv)
        uv = uv.reshape(-1, 2)
        lo, hi = np.minimum(lo, uv.min(0)), np.maximum(hi, uv.max(0))
    if lo.min() < -1e-4 or hi.max() > 1.0001:
        raise RuntimeError(f'{model.id}: UVs left the atlas ({lo} .. {hi})')


def bake_target(mat, image):
    g = BAKE_SOCKETS[mat.name]['graph']
    node = g.nodes.get('KannonBake') or g.new('ShaderNodeTexImage')
    node.name = 'KannonBake'
    node.image = image
    g.nodes.active = node


def set_output(mat, mode):
    info = BAKE_SOCKETS[mat.name]
    g, out, emit, bsdf = info['graph'], info['out'], info['emit'], info['bsdf']
    for link in list(out.inputs['Surface'].links):
        g.links.remove(link)
    for link in list(emit.inputs['Color'].links):
        g.links.remove(link)
    emit.inputs['Strength'].default_value = 1.0
    if mode in ('preview', 'normal'):
        g.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
        return
    if mode == 'base':
        g.put(emit.inputs['Color'], info['base'] if not isinstance(info['base'], tuple) else (*info['base'], 1.0))
    elif mode == 'orm':
        combine = info.get('combine')
        if combine is None:
            combine = g.new('ShaderNodeCombineColor')
            g.put(combine.inputs['Red'], info['ao'])
            g.put(combine.inputs['Green'], info['rough'])
            g.put(combine.inputs['Blue'], info['metal'])
            info['combine'] = combine
        g.links.new(combine.outputs['Color'], emit.inputs['Color'])
    g.links.new(emit.outputs['Emission'], out.inputs['Surface'])


def image_rgba(image):
    w, h = image.size
    px = np.empty(w * h * 4, np.float32)
    image.pixels.foreach_get(px)
    return px.reshape(h, w, 4)


def save_png(path, rgb, colorspace):
    h, w, _ = rgb.shape
    img = bpy.data.images.new(path.stem, w, h, alpha=False)
    img.colorspace_settings.name = colorspace
    rgba = np.concatenate([np.clip(rgb, 0.0, 1.0), np.ones((h, w, 1), np.float32)], axis=2).astype(np.float32)
    img.pixels.foreach_set(rgba.ravel())
    img.filepath_raw = str(path)
    img.file_format = 'PNG'
    img.save()
    return img


def encode_srgb(linear):
    linear = np.clip(linear, 0.0, 1.0)
    return np.where(linear <= 0.0031308, linear * 12.92, 1.055 * np.power(linear, 1 / 2.4) - 0.055)


def bake_model(model, models, size, samples, work):
    """Bake base colour, packed occlusion/roughness/metal and a tangent normal map for one model."""
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = samples
    scene.cycles.use_denoising = False
    scene.render.bake.use_selected_to_active = False
    scene.render.bake.target = 'IMAGE_TEXTURES'
    scene.render.bake.margin = max(8, size // 96)
    scene.render.bake.margin_type = 'EXTEND'
    scene.render.bake.use_clear = True
    scene.render.bake.normal_space = 'TANGENT'
    for other in models.values():
        for ob in model_objects(other):
            ob.hide_render = other is not model
    objs = model_meshes(model)
    mats = {slot.material for ob in objs for slot in ob.material_slots if slot.material}
    results = {}
    for mode in ('base', 'orm', 'normal'):
        image = bpy.data.images.new(f'{model.root_name}_{mode}', size, size, alpha=False, float_buffer=True)
        image.colorspace_settings.name = 'Non-Color'
        for mat in mats:
            set_output(mat, mode)
            bake_target(mat, image)
        bpy.ops.object.select_all(action='DESELECT')
        for ob in objs:
            ob.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        started = time.time()
        bpy.ops.object.bake(type='NORMAL' if mode == 'normal' else 'EMIT', margin=scene.render.bake.margin, margin_type='EXTEND', use_clear=True,
                            normal_space='TANGENT', uv_layer='UVMap')
        log(f'{model.id}: baked {mode} {size}px in {time.time() - started:.0f}s')
        results[mode] = image_rgba(image)[:, :, :3].copy()
        bpy.data.images.remove(image)
    for mat in mats:
        set_output(mat, 'preview')
    for other in models.values():
        for ob in model_objects(other):
            ob.hide_render = False
    out = {}
    base = encode_srgb(results['base'])
    out['base'] = save_png(work / f'{model.root_name}_BaseColor.png', base, 'sRGB')
    orm = results['orm']
    orm[:, :, 0] = np.clip(0.35 + 0.65 * orm[:, :, 0], 0, 1)   # keep occlusion gentle; the colour map already carries cavity shading
    out['orm'] = save_png(work / f'{model.root_name}_ORM.png', orm, 'Non-Color')
    out['normal'] = save_png(work / f'{model.root_name}_Normal.png', results['normal'], 'Non-Color')
    return out


def export_material(name, images):
    """glTF-ready material: base colour, ORM (occlusion R, roughness G, metal B) and normal map."""
    mat, g, out, bsdf = material_base(name)
    base = g.new('ShaderNodeTexImage')
    base.image = images['base']
    base.image.colorspace_settings.name = 'sRGB'
    g.links.new(base.outputs['Color'], bsdf.inputs['Base Color'])
    orm = g.new('ShaderNodeTexImage')
    orm.image = images['orm']
    orm.image.colorspace_settings.name = 'Non-Color'
    sep = g.new('ShaderNodeSeparateColor')
    g.links.new(orm.outputs['Color'], sep.inputs['Color'])
    g.links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
    g.links.new(sep.outputs['Blue'], bsdf.inputs['Metallic'])
    group = bpy.data.node_groups.get('glTF Material Output')
    if group is None:
        group = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
        group.interface.new_socket(name='Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
        group.nodes.new('NodeGroupInput')
    occlusion = g.new('ShaderNodeGroup')
    occlusion.node_tree = group
    g.links.new(sep.outputs['Red'], occlusion.inputs['Occlusion'])
    nrm = g.new('ShaderNodeTexImage')
    nrm.image = images['normal']
    nrm.image.colorspace_settings.name = 'Non-Color'
    nmap = g.new('ShaderNodeNormalMap')
    g.links.new(nrm.outputs['Color'], nmap.inputs['Color'])
    g.links.new(nmap.outputs['Normal'], bsdf.inputs['Normal'])
    return mat


def assign_export_material(model, mat):
    """Every textured face uses the model's baked material; lenses and glows keep theirs."""
    for ob in model_meshes(model):
        me = ob.data
        keep = []
        remap = []
        for slot_mat in [s.material for s in ob.material_slots]:
            target = slot_mat if slot_mat is not None and BAKE_SOCKETS.get(slot_mat.name, {}).get('flat') else mat
            if target not in keep:
                keep.append(target)
            remap.append(keep.index(target))
        indices = np.empty(len(me.polygons), np.int32)
        me.polygons.foreach_get('material_index', indices)
        indices = np.array(remap, np.int32)[indices] if len(remap) else indices
        me.materials.clear()
        for k in keep:
            me.materials.append(k)
        me.polygons.foreach_set('material_index', indices)
        me.update()


def export_glb(models, path):
    bpy.ops.object.select_all(action='DESELECT')
    for model in models.values():
        for ob in model_objects(model):
            ob.hide_viewport = False
            ob.hide_set(False)
            ob.select_set(True)
    kwargs = dict(filepath=str(path), export_format='GLB', use_selection=True, export_yup=True, export_apply=False, export_texcoords=True,
                  export_normals=True, export_tangents=True, export_materials='EXPORT', export_image_format='AUTO', export_extras=True,
                  export_animations=False, export_cameras=False, export_lights=False)
    try:
        bpy.ops.export_scene.gltf(**kwargs, export_vertex_color='NONE')
    except TypeError:
        bpy.ops.export_scene.gltf(**kwargs)
    log(f'exported {path} ({path.stat().st_size / 1e6:.1f} MB)')


def world_matrix_gltf(m):
    """Blender weapon-space matrix -> glTF (Y up, -Z forward) translation and quaternion."""
    conv = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, -1, 0, 0), (0, 0, 0, 1)))
    g = conv @ m @ conv.inverted()
    t = g.to_translation()
    q = g.to_quaternion()
    return [round(t.x, 5), round(t.y, 5), round(t.z, 5)], [round(q.x, 5), round(q.y, 5), round(q.z, 5), round(q.w, 5)]


def build_report(models, sizes):
    report = {'generator': 'scripts/blender/generate_weapons.py', 'units': 'metres', 'up': 'glTF +Y', 'forward': 'glTF -Z', 'models': {},
              'materials': {'WeaponReflexGlass': dict(alphaMode='BLEND', baseColorFactor=[round(v, 5) for v in REFLEX_GLASS['tint']] + [REFLEX_GLASS['alpha']],
                                                      roughnessFactor=REFLEX_GLASS['roughness'], metallicFactor=0.0)}}
    for mid, model in models.items():
        entry = {'root': model.root_name, 'triangles': model.extras.get('triangles'), 'texture': sizes.get(mid), 'nodes': sorted(model.meshes) + sorted(model.anchors)}
        entry['anchors'] = {name: dict(zip(('translation', 'rotation'), world_matrix_gltf(m))) for name, m in model.anchors.items()}
        entry['extras'] = {k: v for k, v in model.extras.items() if k != 'triangles'}
        if 'trigger' in entry['extras']:  # trigger contact point, Blender frame -> glTF frame
            x, y, z = entry['extras']['trigger']
            entry['extras']['trigger'] = [x, z, round(-y, 5)]
        if 'heldAxis' in entry['extras']:  # held axis in the exported arm space (glTF axes, forearm +Z)
            x, y, z = entry['extras']['heldAxis']
            entry['extras']['heldAxis'] = [round(x, 6), round(z, 6), round(-y, 6)]
        report['models'][mid] = entry
    return report


def stage_all(models, args, work):
    sizes = {mid: max(64, int(TEXTURE_SIZE[mid] * args.texture_scale)) for mid in models}
    started = time.time()
    for mid, model in models.items():
        unwrap(model, sizes[mid])
    log(f'unwrapped {len(models)} models in {time.time() - started:.0f}s')
    for mid, model in models.items():
        images = bake_model(model, models, sizes[mid], args.samples, work)
        assign_export_material(model, export_material(f'W_{model.root_name}', images))
    export_glb(models, work / 'weapons-raw.glb')
    bpy.ops.wm.save_as_mainfile(filepath=str(work / 'weapons.blend'))
    report = build_report(models, sizes)
    ART.mkdir(parents=True, exist_ok=True)
    (ART / 'weapons-build.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8', newline='\n')
    return report


# =============================================================================================
# Preview rendering
# =============================================================================================

def setup_render(samples, width, height):
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = samples
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.adaptive_threshold = 0.03
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 6
    scene.cycles.glossy_bounces = 4
    scene.cycles.caustics_reflective = False
    scene.cycles.caustics_refractive = False
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.view_settings.view_transform = 'AgX'
    try:
        scene.view_settings.look = 'AgX - Medium High Contrast'
    except TypeError:
        pass
    scene.render.image_settings.file_format = 'PNG'


def world_sky(strength=1.0, sun_elevation=24.0, sun_rotation=200.0):
    world = bpy.context.scene.world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputWorld')
    bg = nt.nodes.new('ShaderNodeBackground')
    sky = nt.nodes.new('ShaderNodeTexSky')
    for kind in ('MULTIPLE_SCATTERING', 'NISHITA', 'SINGLE_SCATTERING', 'HOSEK_WILKIE'):
        try:
            sky.sky_type = kind
            break
        except TypeError:
            continue
    try:
        sky.sun_elevation = math.radians(sun_elevation)
        sky.sun_rotation = math.radians(sun_rotation)
        sky.sun_disc = False
    except AttributeError:
        pass
    nt.links.new(sky.outputs['Color'], bg.inputs['Color'])
    bg.inputs['Strength'].default_value = strength
    nt.links.new(bg.outputs['Background'], out.inputs['Surface'])


def world_studio():
    world = bpy.context.scene.world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputWorld')
    bg = nt.nodes.new('ShaderNodeBackground')
    grad = nt.nodes.new('ShaderNodeTexGradient')
    tc = nt.nodes.new('ShaderNodeTexCoord')
    mapping = nt.nodes.new('ShaderNodeMapping')
    mapping.inputs['Rotation'].default_value = (0, math.radians(-90), 0)
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.35
    ramp.color_ramp.elements[0].color = (0.010, 0.011, 0.012, 1)
    ramp.color_ramp.elements[1].position = 0.75
    ramp.color_ramp.elements[1].color = (0.30, 0.31, 0.33, 1)
    nt.links.new(tc.outputs['Generated'], mapping.inputs['Vector'])
    nt.links.new(mapping.outputs['Vector'], grad.inputs['Vector'])
    nt.links.new(grad.outputs['Factor'] if 'Factor' in grad.outputs else grad.outputs[1], ramp.inputs[0])
    nt.links.new(ramp.outputs['Color'], bg.inputs['Color'])
    bg.inputs['Strength'].default_value = 1.0
    nt.links.new(bg.outputs['Background'], out.inputs['Surface'])


def add_light(coll, name, kind, location, target, energy, size=1.0, color=(1, 1, 1)):
    data = bpy.data.lights.new(name, kind)
    data.energy = energy
    data.color = color
    if kind == 'AREA':
        data.shape = 'DISK'
        data.size = size
    if kind == 'SUN':
        data.angle = math.radians(1.2)
    ob = bpy.data.objects.new(name, data)
    coll.objects.link(ob)
    ob.location = location
    ob.rotation_euler = (Vector(target) - Vector(location)).to_track_quat('-Z', 'Y').to_euler()
    return ob


def camera(coll, name, location, target, lens=None, fov_h=None, ortho=None, up='Y'):
    data = bpy.data.cameras.new(name)
    if ortho:
        data.type = 'ORTHO'
        data.ortho_scale = ortho
    elif fov_h:
        data.sensor_fit = 'HORIZONTAL'
        data.angle = math.radians(fov_h)
    else:
        data.lens = lens or 50
    data.clip_start = 0.005
    data.clip_end = 100
    ob = bpy.data.objects.new(name, data)
    coll.objects.link(ob)
    ob.location = location
    ob.rotation_euler = (Vector(target) - Vector(location)).to_track_quat('-Z', up).to_euler()
    return ob


def pbr_from_polyhaven(name, asset, tile, tint=None):
    files = {'Diffuse': f'{asset}_Diffuse_2k.jpg', 'nor_gl': f'{asset}_nor_gl_2k.jpg', 'arm': f'{asset}_arm_2k.jpg'}
    if not all((POLYHAVEN / asset / f).exists() for f in files.values()):
        return flat_material(name, hexcol('#6b6d70'), 0.85)
    mat, g, out, bsdf = material_base(name)
    tc = g.new('ShaderNodeTexCoord')
    mp = g.new('ShaderNodeMapping')
    mp.inputs['Scale'].default_value = (1 / tile, 1 / tile, 1 / tile)
    g.links.new(tc.outputs['Object'], mp.inputs['Vector'])
    col = g.new('ShaderNodeTexImage')
    col.image = bpy.data.images.load(str(POLYHAVEN / asset / files['Diffuse']), check_existing=True)
    g.links.new(mp.outputs['Vector'], col.inputs['Vector'])
    col.projection = 'BOX'
    colour = col.outputs['Color']
    if tint:
        colour = g.mix(1.0, colour, tint, blend='MULTIPLY')
    g.links.new(colour, bsdf.inputs['Base Color'])
    nrm = g.new('ShaderNodeTexImage')
    nrm.image = bpy.data.images.load(str(POLYHAVEN / asset / files['nor_gl']), check_existing=True)
    nrm.image.colorspace_settings.name = 'Non-Color'
    nrm.projection = 'BOX'
    g.links.new(mp.outputs['Vector'], nrm.inputs['Vector'])
    nm = g.new('ShaderNodeNormalMap')
    g.links.new(nrm.outputs['Color'], nm.inputs['Color'])
    g.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    arm = g.new('ShaderNodeTexImage')
    arm.image = bpy.data.images.load(str(POLYHAVEN / asset / files['arm']), check_existing=True)
    arm.image.colorspace_settings.name = 'Non-Color'
    arm.projection = 'BOX'
    g.links.new(mp.outputs['Vector'], arm.inputs['Vector'])
    sep = g.new('ShaderNodeSeparateColor')
    g.links.new(arm.outputs['Color'], sep.inputs['Color'])
    g.links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
    return mat


def backdrop(coll, kind):
    if kind == 'street':
        ground_mat = pbr_from_polyhaven('PreviewAsphalt', 'asphalt_02', 3.0)
        bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 10, -1.55))
        ground = bpy.context.object
        ground.data.materials.append(ground_mat)
        for c in ground.users_collection:
            c.objects.unlink(ground)
        coll.objects.link(ground)
        wall_mat = pbr_from_polyhaven('PreviewConcrete', 'concrete_floor_01', 2.5)
        bpy.ops.mesh.primitive_cube_add(size=1, location=(-2.6, 9.0, 0.3))
        wall = bpy.context.object
        wall.scale = (0.4, 12, 3.8)
        wall.data.materials.append(wall_mat)
        for c in wall.users_collection:
            c.objects.unlink(wall)
        coll.objects.link(wall)
        bpy.ops.mesh.primitive_cube_add(size=1, location=(3.5, 14.0, 0.0))
        crate = bpy.context.object
        crate.scale = (2.0, 1.2, 3.2)
        crate.data.materials.append(wall_mat)
        for c in crate.users_collection:
            c.objects.unlink(crate)
        coll.objects.link(crate)
        # A person-sized target 20 m ahead on the aim line: it must stay visible through every sight.
        bpy.ops.mesh.primitive_cube_add(size=1, location=(0.0, 20.0, -1.55 + 0.9))
        board = bpy.context.object
        board.scale = (0.5, 0.05, 1.8)
        board.data.materials.append(flat_material('PreviewTarget', hexcol('#c46a2e'), 0.6))
        for c in board.users_collection:
            c.objects.unlink(board)
        coll.objects.link(board)
    elif kind == 'table':
        mat = flat_material('PreviewTable', hexcol('#55585b'), 0.6)
        bpy.ops.mesh.primitive_plane_add(size=8, location=(0, 0, -0.30))
        plane = bpy.context.object
        plane.data.materials.append(mat)
        for c in plane.users_collection:
            c.objects.unlink(plane)
        coll.objects.link(plane)


def place(model, matrix):
    model.root.matrix_world = matrix


def first_person(models, gun, ads=False):
    """Weapon in camera space (camera at the origin looking +Y), arms seated on its anchors."""
    m = models[gun]
    if ads:
        sight = m.anchors['sight'].translation
        world = Matrix.Translation(Vector((0, ADS_EYE.get(gun, 0.22), 0)) - sight)
    else:
        pose = HIP_POSE.get(gun, HIP_POSE['kr5'])
        rot = (Matrix.Rotation(math.radians(pose['yaw']), 4, Z) @ Matrix.Rotation(math.radians(pose['pitch']), 4, X) @ Matrix.Rotation(math.radians(pose['roll']), 4, Y))
        world = Matrix.Translation(Vector(pose['grip'])) @ rot
    place(m, world)
    for arm_id, anchor in (('arm_right', 'grip_r'), ('arm_left', 'grip_l')):
        if arm_id in models and anchor in m.anchors:
            place(models[arm_id], world @ m.anchors[anchor])
    return world


# Preview eye distance behind the sight anchor when aiming (the view model chooses its own).
ADS_EYE = {'kr5': 0.22, 'hornet9': 0.22, 'breaker12': 0.24, 'longbow': 0.10, 'sentry9': 0.40}

HIP_POSE = {
    'kr5': dict(grip=(0.125, 0.20, -0.215), yaw=4.0, pitch=1.0, roll=-4.0),
    'hornet9': dict(grip=(0.120, 0.20, -0.205), yaw=4.0, pitch=1.0, roll=-4.0),
    'breaker12': dict(grip=(0.125, 0.20, -0.210), yaw=4.0, pitch=1.0, roll=-4.0),
    'longbow': dict(grip=(0.125, 0.20, -0.220), yaw=3.0, pitch=1.0, roll=-3.0),
    'sentry9': dict(grip=(0.075, 0.30, -0.150), yaw=6.0, pitch=2.0, roll=-2.0),
}


def show_only(models, ids):
    for mid, m in models.items():
        hide = mid not in ids
        for ob in model_objects(m):
            ob.hide_render = hide
            ob.hide_viewport = hide


def render(path):
    settings = bpy.context.scene.render.image_settings
    if path.suffix == '.jpg':
        settings.file_format = 'JPEG'
        settings.quality = 88
    else:
        settings.file_format = 'PNG'
    bpy.context.scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    log('rendered', path.name)


LINEUP = {'longbow': (0.0, 0.0, 0.60), 'breaker12': (0.0, 0.0, 0.32), 'kr5': (0.0, 0.0, 0.02), 'hornet9': (0.0, 0.0, -0.38),
          'sentry9': (0.0, -0.62, -0.16), 'knife': (0.0, -0.66, -0.44), 'frag': (0.0, -0.88, -0.16)}


def render_previews(models, samples, views, out_dir, suffix='', ext='png'):
    out_dir.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    stage = collection('Preview')
    want = set(views) if views else None
    rendered = []
    suffix = f'{suffix}.{ext}'
    # First-person views in the street.
    world_sky(0.35, 22.0, 215.0)
    sun = add_light(stage, 'Sun', 'SUN', (-4, -2, 6), (0, 6, 0), 4.5, color=(1.0, 0.86, 0.70))
    sun.rotation_euler = (math.radians(58), 0, math.radians(-40))
    backdrop(stage, 'street')
    cam = camera(stage, 'FirstPerson', (0, 0, 0), (0, 1, 0), fov_h=80.0)
    scene.camera = cam
    setup_render(samples, 1600, 900)
    for gun in ('kr5', 'hornet9', 'breaker12', 'longbow', 'sentry9'):
        if gun not in models:
            continue
        for ads in (False, True):
            name = f'fp-{gun}-{"ads" if ads else "hip"}'
            if want and name not in want:
                continue
            first_person(models, gun, ads)
            show_only(models, {gun, 'arm_left', 'arm_right'})
            scene.camera = cam
            render(out_dir / f'{name}{suffix}')
            rendered.append(name)
        # Close-ups of the hands on the weapon (look-dev only).
        m = models[gun]
        for label, anchor, offset, aim, lens in (('hands-r', 'grip_r', (0.26, 0.05, -0.01), (0.0, 0.02, 0.025), 50), ('hands-l', 'grip_l', (-0.22, -0.10, -0.13), (0.0, 0.0, 0.0), 50),
                                                 ('over', 'grip_r', (0.20, -0.36, 0.26), (0.0, 0.16, 0.03), 35), ('under', 'grip_r', (0.10, 0.22, -0.30), (0.0, 0.14, 0.0), 35)):
            name = f'{label}-{gun}'
            if not want or name not in want or anchor not in m.anchors:
                continue
            world = first_person(models, gun, False)
            show_only(models, {gun, 'arm_left', 'arm_right'})
            focus = world @ (m.anchors[anchor].translation + Vector(aim))
            close = camera(stage, f'Close_{name}', world @ (m.anchors[anchor].translation + Vector(offset)), focus, lens=lens)
            scene.camera = close
            render(out_dir / f'{name}{suffix}')
            rendered.append(name)
    for ob in list(stage.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    # Studio side views.
    world_studio()
    add_light(stage, 'Key', 'AREA', (1.2, -0.9, 1.4), (0, 0.1, 0.05), 160, 1.2, (1.0, 0.95, 0.88))
    add_light(stage, 'Fill', 'AREA', (-1.4, -0.4, 0.6), (0, 0.1, 0.05), 50, 1.5, (0.8, 0.88, 1.0))
    add_light(stage, 'Rim', 'AREA', (0.2, 1.6, 1.1), (0, 0, 0.05), 140, 1.0, (1.0, 1.0, 1.0))
    backdrop(stage, 'table')
    setup_render(samples, 1600, 900)
    for mid in models:
        for label, direction in (('side', Vector((1.0, -0.22, 0.22))), ('left', Vector((-1.0, -0.25, 0.30))), ('back', Vector((0.35, -1.0, 0.45)))):
            name = f'{label}-{mid}'
            if (want and name not in want) or (not want and label != 'side'):
                continue
            m = models[mid]
            place(m, Matrix.Identity(4))
            show_only(models, {mid})
            lo, hi = model_bounds(m)
            centre = (lo + hi) / 2
            span = max(hi.y - lo.y, (hi.z - lo.z) * 1.78, hi.x - lo.x)
            dist = span / 2 / math.tan(math.radians(28.8 / 2)) * 1.12
            cam = camera(stage, f'Cam_{name}', centre + direction.normalized() * dist, centre, lens=70)
            scene.camera = cam
            render(out_dir / f'{name}{suffix}')
            rendered.append(name)
    if want and {'hold-knife', 'grip-knife'} & want and 'knife' in models:
        # The knife in a fist: on the left arm's `hold` node (as the view model shows it) and seated
        # on the knife's own grip_r anchor in the right hand.
        for name, arm_id, seat in (('hold-knife', 'arm_left', 'hold'), ('grip-knife', 'arm_right', 'grip_r')):
            if name not in want or arm_id not in models:
                continue
            arm, knife = models[arm_id], models['knife']
            if seat == 'hold':
                place(arm, Matrix.Identity(4))
                place(knife, arm.anchors['hold'])
            else:
                place(knife, Matrix.Identity(4))
                place(arm, knife.anchors['grip_r'])
            show_only(models, {arm_id, 'knife'})
            lo, hi = model_bounds(knife)
            centre = (lo + hi) / 2
            for k, direction in enumerate((Vector((0.6, -0.5, 0.7)), Vector((-0.8, -0.2, -0.3)))):
                cam = camera(stage, f'Cam_{name}_{k}', centre + direction.normalized() * 0.55, centre, lens=50)
                scene.camera = cam
                render(out_dir / f'{name}-{k}{suffix}')
                rendered.append(f'{name}-{k}')
            place(knife, Matrix.Identity(4))
            place(arm, Matrix.Identity(4))
    if not want or 'lineup' in want:
        # Every model seen from its left side (the side the first-person camera sees).
        for mid, m in models.items():
            place(m, Matrix.Translation(LINEUP.get(mid, (0, 0, -0.6))))
        show_only(models, {mid for mid in models if mid in LINEUP})
        setup_render(samples, 2000, 1500)
        for ob in stage.objects:
            if ob.type == 'MESH':
                ob.hide_render = True
        add_light(stage, 'LineupKey', 'AREA', (-2.0, -1.2, 1.6), (0, -0.06, 0.1), 260, 2.5, (1.0, 0.95, 0.88))
        add_light(stage, 'LineupFill', 'AREA', (-2.2, 1.4, 0.2), (0, -0.06, 0.1), 70, 2.5, (0.82, 0.9, 1.0))
        cam = camera(stage, 'Cam_lineup', (-3.0, -0.06, 0.11), (0.0, -0.06, 0.11), ortho=1.90)
        scene.camera = cam
        render(out_dir / f'lineup{suffix}')
        rendered.append('lineup')
    for m in models.values():
        place(m, Matrix.Identity(4))
    show_only(models, set(models))
    for ob in list(stage.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    return rendered


def model_bounds(m):
    bpy.context.view_layer.update()
    pts = [o.matrix_world @ Vector(v) for o in model_objects(m) if o.type == 'MESH' for v in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


# =============================================================================================
# Main
# =============================================================================================

def models_from_blend():
    """Lightweight models (root and anchors) from a saved, already baked scene."""
    models = {}
    for mid in MODEL_IDS:
        root = bpy.data.objects.get(ROOT_NAMES[mid])
        if root is None:
            continue
        m = Model.__new__(Model)
        m.id, m.root_name, m.root = mid, ROOT_NAMES[mid], root
        m.anchors, m.meshes, m.extras = {}, {}, {}
        for child in root.children:
            name = child.name.split(SEP, 1)[1] if SEP in child.name else child.name
            if child.type == 'EMPTY' and name in ('grip_r', 'grip_l', 'muzzle', 'sight', 'eject', 'hold'):
                m.anchors[name] = child.matrix_basis.copy()
        models[mid] = m
    return models


SHIPPED_VIEWS = [f'fp-{g}-hip' for g in ('kr5', 'hornet9', 'breaker12', 'longbow', 'sentry9')] + [f'fp-{g}-ads' for g in ('kr5', 'hornet9', 'breaker12', 'sentry9')] + \
    ['over-kr5', 'hands-r-sentry9', 'hold-knife', 'lineup']


def main():
    global BUILD
    args = parse_args()
    started = time.time()
    work = Path(args.work)
    views = [s for s in args.views.split(',') if s]
    if args.stage == 'previews':
        bpy.ops.wm.open_mainfile(filepath=str(work / 'weapons.blend'))
        BUILD = collection('Weapons')
        render_previews(models_from_blend(), args.preview_samples, views or SHIPPED_VIEWS, ART, ext='jpg')
        log(f'done in {time.time() - started:.0f}s')
        return
    reset_scene()
    BUILD = collection('Weapons')
    only = [s for s in args.only.split(',') if s]
    M, models = build_all(only)
    work.mkdir(parents=True, exist_ok=True)
    if args.stage == 'look':
        bpy.ops.wm.save_as_mainfile(filepath=str(work / 'weapons-look.blend'))
        render_previews(models, args.preview_samples, views, work / 'look')
    elif args.stage == 'all':
        report = stage_all(models, args, work)
        render_previews(models, args.preview_samples, views or SHIPPED_VIEWS, ART, ext='jpg')
        log('KANNON_WEAPONS_COMPLETE ' + json.dumps({mid: entry['triangles'] for mid, entry in report['models'].items()}))
    log(f'done in {time.time() - started:.0f}s')


if __name__ == '__main__':
    main()
