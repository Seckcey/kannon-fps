"""Original, standard-library-only ASF/AMC parsing and forward kinematics.

This code is separate from CMU motion data rights. See art/source/motion/cmu-09/CMU-USAGE-NOTICE.md.
Supported subset is deliberately strict: CMU subject 09 ASF, fully specified
AMC, Euler-degree rotational bone DOFs and root TX TY TZ RX RY RZ.
Column vectors: R_world = R_parent C M C^T; XYZ applies Rz Ry Rx.
No downloaded code is imported or executed. No network access is performed.
"""
from __future__ import annotations

import math
import pathlib
IDENTITY = ((1., 0., 0.), (0., 1., 0.), (0., 0., 1.))


def mm(a, b):
    return tuple(tuple(sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)) for i in range(3))


def mv(a, v):
    return tuple(sum(a[i][k] * v[k] for k in range(3)) for i in range(3))


def transpose(a):
    return tuple(zip(*a))


def add(a, b):
    return tuple(x + y for x, y in zip(a, b))


def sub(a, b):
    return tuple(x - y for x, y in zip(a, b))


def norm(v):
    return math.sqrt(sum(x * x for x in v))


def rotation(axis, degrees):
    a = math.radians(degrees)
    c, s = math.cos(a), math.sin(a)
    if axis == 'x': return ((1., 0., 0.), (0., c, -s), (0., s, c))
    if axis == 'y': return ((c, 0., s), (0., 1., 0.), (-s, 0., c))
    if axis == 'z': return ((c, -s, 0.), (s, c, 0.), (0., 0., 1.))
    raise ValueError('Unsupported axis: ' + axis)


def euler(angles, order='xyz'):
    # Sequential rotations about fixed axes; active rotation of column vectors.
    values = dict(zip('xyz', angles))
    out = IDENTITY
    for axis in order.lower(): out = mm(rotation(axis, values[axis]), out)
    return out


def finite_values(tokens):
    values = [float(v) for v in tokens]
    if not all(math.isfinite(v) for v in values): raise ValueError('Nonfinite motion values')
    return values


def parse_asf(path):
    sections = {}
    section = None
    for raw in path.read_text(encoding='ascii').splitlines():
        line = raw.split('#', 1)[0].strip()
        if not line: continue
        if line.startswith(':'):
            section = line[1:].split()[0].lower()
            if section in sections: raise ValueError('Duplicate ASF section')
            sections[section] = []
        else:
            if section is None: raise ValueError('Content before ASF section')
            sections[section].append(line)
    units = {line.split()[0]: line.split()[1:] for line in sections['units']}
    if units['angle'] != ['deg']: raise ValueError('Expected degree units')
    scale = 0.0254 / float(units['length'][0])  # CMU-specific documented conversion.
    if not 0 < scale < 1: raise ValueError('Unexpected scale')
    root = {line.split()[0]: line.split()[1:] for line in sections['root']}
    if root['order'] != ['TX', 'TY', 'TZ', 'RX', 'RY', 'RZ']: raise ValueError('Unsupported root order')
    if root['axis'] != ['XYZ']: raise ValueError('Unsupported root axis')
    if any(finite_values(root['orientation'])): raise ValueError('Nonzero root rest rotation not supported in spike')
    bones = {}
    current = None
    for line in sections['bonedata']:
        fields = line.split()
        key = fields[0]
        if key == 'begin':
            if current is not None: raise ValueError('Nested bone')
            current = {}
        elif key == 'end':
            name = current['name'][0]
            if name in bones: raise ValueError('Duplicate bone')
            direction = finite_values(current['direction'])
            direction_length = norm(direction)
            if abs(direction_length - 1) > 1e-5: raise ValueError('Nonunit bone direction')
            axis = finite_values(current['axis'][:3])
            dof = current.get('dof', [])
            if any(d not in ('rx', 'ry', 'rz') for d in dof): raise ValueError('Unsupported bone DOF')
            if len(set(dof)) != len(dof): raise ValueError('Duplicate DOF')
            c = euler(axis, current['axis'][3])
            bones[name] = {'direction': tuple(v / direction_length for v in direction),
                           'length_m': float(current['length'][0]) * scale,
                           'axis_degrees': axis, 'axis_order': current['axis'][3],
                           'dof': dof, 'C': c, 'CT': transpose(c)}
            current = None
        elif key in ('id', 'name', 'direction', 'length', 'axis', 'dof'):
            if current is None or key in current: raise ValueError('Invalid bone field')
            current[key] = fields[1:]
        elif key == 'limits' or key.startswith('('):
            pass  # Limits are capture metadata; they are not runtime clamping rules.
        else: raise ValueError('Unsupported ASF bone field ' + key)
    if current is not None: raise ValueError('Unterminated bone')
    parents = {}
    children = {'root': []}
    for line in sections['hierarchy']:
        if line in ('begin', 'end'): continue
        parent, *names = line.split()
        if parent != 'root' and parent not in bones: raise ValueError('Unknown parent')
        for name in names:
            if name not in bones or name in parents: raise ValueError('Unknown or duplicate child')
            parents[name] = parent
            children.setdefault(parent, []).append(name)
    if set(parents) != set(bones): raise ValueError('Incomplete hierarchy')
    order = []
    def visit(name, ancestry):
        if name in ancestry: raise ValueError('Cyclic hierarchy')
        for child in children.get(name, []):
            order.append(child)
            visit(child, ancestry | {name})
    visit('root', set())
    if len(order) != len(bones): raise ValueError('Disconnected hierarchy')
    return {'scale': scale, 'root_position': tuple(v * scale for v in finite_values(root['position'])),
            'bones': bones, 'parents': parents, 'order': order}


def parse_amc(path, skeleton):
    frames, current, frame_number = [], None, None
    declarations = set()
    expected = {'root': 6, **{name: len(b['dof']) for name, b in skeleton['bones'].items() if b['dof']}}
    def finish():
        if current is None: return
        if set(current) != set(expected): raise ValueError('Missing or extra animated bones in frame')
        frames.append({'number': frame_number, 'values': current})
    for raw in path.read_text(encoding='ascii').splitlines():
        line = raw.split('#', 1)[0].strip()
        if not line: continue
        if line.startswith(':'):
            if current is not None: raise ValueError('Late AMC declaration')
            declarations.add(line)
            continue
        fields = line.split()
        if fields[0].isdigit():
            finish()
            frame_number = int(fields[0])
            if len(fields) != 1 or frame_number != len(frames) + 1: raise ValueError('Nonsequential AMC frame')
            current = {}
            if frame_number > 20000: raise ValueError('Spike frame bound exceeded')
        else:
            name = fields[0]
            if current is None or name not in expected or name in current: raise ValueError('Invalid AMC channel')
            values = finite_values(fields[1:])
            if len(values) != expected[name]: raise ValueError('DOF count mismatch')
            current[name] = values
    finish()
    if not frames or declarations != {':FULLY-SPECIFIED', ':DEGREES'}: raise ValueError('Unsupported AMC declaration')
    return frames


def forward_kinematics(skeleton, values):
    rv = values['root']
    positions = {'root': add(skeleton['root_position'], tuple(v * skeleton['scale'] for v in rv[:3]))}
    rotations = {'root': euler(rv[3:])}
    for name in skeleton['order']:
        bone = skeleton['bones'][name]
        motion = IDENTITY
        for dof, angle in zip(bone['dof'], values.get(name, [])):
            motion = mm(rotation(dof[1], angle), motion)
        local = mm(mm(bone['C'], motion), bone['CT'])
        parent = skeleton['parents'][name]
        rotations[name] = mm(rotations[parent], local)
        offset = mv(rotations[name], tuple(v * bone['length_m'] for v in bone['direction']))
        positions[name] = add(positions[parent], offset)
    return positions, rotations
