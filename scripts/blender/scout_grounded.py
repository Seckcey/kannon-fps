"""Offline stance constraints and a periodic seam for the two locomotion clips.

Works only on pelvis/leg curves after the capture has been retimed. Geometry,
bone lengths, upper-body local curves, and the six other actions are untouched.
The actor root, gameplay speeds and contact-selection masks are not altered.
This improves sampled support; it does not guarantee perfect foot locking or
eliminate all reverse foot-roll drift and resampling acceleration.
"""
import math
import os
import statistics

import bpy
from mathutils import Euler, Matrix, Vector


LOWER = ('pelvis', 'thigh_l', 'shin_l', 'foot_l', 'thigh_r', 'shin_r', 'foot_r')


def ground_locomotion(rig, body, action, duration, speed):
    scene = bpy.context.scene
    count = round(duration * 240)
    dt = duration / count
    # Retain the established skin-clearance allowance through offline IK.
    clearance = .006
    # Repair only two 120 Hz export intervals on either side of the loop seam.
    seam_window = 1 / 60
    # Animated hip flexion supplies reach while actor/root height stays fixed.
    pelvis_drop = .040
    # Return corrections during flight with matching endpoint velocity.
    horizontal_fade = .030
    # Keep a meaningful bend reserve away from the straight-leg singularity.
    reach_margin = .005
    diagnostics_enabled = os.environ.get('KANNON_GAIT_DIAGNOSTICS') == '1'
    local_soles = {}
    for side in ('l', 'r'):
        name = 'foot_' + side
        group = body.vertex_groups[name]
        inverse = rig.data.bones[name].matrix_local.inverted()
        local_soles[side] = [inverse @ vertex.co for vertex in body.data.vertices
                             if any(item.group == group.index and item.weight > .9 for item in vertex.groups)]
        assert local_soles[side]

    def evaluate(time):
        rig.animation_data.action = action
        if action.slots:
            rig.animation_data.action_slot = action.slots[0]
        frame = 1 + time * 30
        scene.frame_set(int(frame), subframe=frame % 1)
        bpy.context.view_layer.update()

    def apply(basis):
        for name, matrix in basis.items():
            rig.pose.bones[name].matrix_basis = matrix
        bpy.context.view_layer.update()

    def sole_min(side):
        transform = rig.pose.bones['foot_' + side].matrix
        return min((transform @ vertex).z for vertex in local_soles[side])

    # Cache the existing action before replacing any curves. Contact selection is
    # fixed from this baseline, not recomputed after corrected feet are moved.
    cached = []
    for index in range(count + 1):
        evaluate(index * dt)
        planes, source_bends = {}, {}
        for side in ('l', 'r'):
            hip = rig.pose.bones['thigh_' + side].head
            knee = rig.pose.bones['shin_' + side].head
            ankle = rig.pose.bones['foot_' + side].head
            planes[side] = (ankle - hip).cross(knee - hip)
            source_bends[side] = planes[side].length / (ankle-hip).length
        cached.append({'basis': {bone.name: bone.matrix_basis.copy() for bone in rig.pose.bones},
                       'minimum': {side: sole_min(side) for side in ('l', 'r')},
                       'originalFoot': {side: rig.pose.bones['foot_' + side].matrix.copy() for side in ('l', 'r')},
                       'capturedPlane': planes, 'sourceBendHeight': source_bends})
    for side in ('l', 'r'):
        for index, record in enumerate(cached):
            if record['capturedPlane'][side].length_squared < 1e-10:
                neighbors = sorted(range(count), key=lambda other: min((other-index) % count, (index-other) % count))
                record['capturedPlane'][side] = next(cached[other]['capturedPlane'][side].copy() for other in neighbors
                                                     if cached[other]['capturedPlane'][side].length_squared >= 1e-10)
            record['capturedPlane'][side].normalize()

    # Repair a short window across the periodic boundary in *final clip time*.
    # One Hermite segment spans [-window,+window], so time0 and timeT have the
    # same value and derivative. Dense LINEAR export approximates that smooth
    # segment; the GLB validator must still measure its actual endpoint slopes.
    def smooth_seam(values):
        def sample(time):
            time %= duration
            position = time / dt
            index = min(count - 1, int(position))
            return values[index].lerp(values[index + 1], position - index)

        start = sample(duration - seam_window)
        end = sample(seam_window)
        start_velocity = (sample(duration - seam_window + dt) - sample(duration - seam_window - dt)) / (2 * dt)
        end_velocity = (sample(seam_window + dt) - sample(seam_window - dt)) / (2 * dt)
        length = 2 * seam_window
        out = [value.copy() for value in values]
        for index in range(count + 1):
            time = index * dt
            if seam_window < time < duration - seam_window:
                continue
            unwrapped = time if time <= seam_window else time - duration
            u = (unwrapped + seam_window) / length
            out[index] = (start * (2*u**3 - 3*u*u + 1)
                          + start_velocity * (length * (u**3 - 2*u*u + u))
                          + end * (-2*u**3 + 3*u*u)
                          + end_velocity * (length * (u**3 - u*u)))
        out[-1] = out[0].copy()
        return out

    for name in LOWER:
        locations, angles, scales = [], [], []
        previous = None
        for record in cached:
            location, rotation, scale = record['basis'][name].decompose()
            angle = rotation.to_euler('XYZ', previous) if previous else rotation.to_euler('XYZ')
            previous = angle.copy()
            locations.append(location); angles.append(Vector(angle)); scales.append(scale)
        # The capture is one gait cycle, never a full turn about a joint axis.
        for axis in range(3):
            angles[-1][axis] += round((angles[0][axis] - angles[-1][axis]) / math.tau) * math.tau
        locations = smooth_seam(locations)
        angles = smooth_seam(angles)
        for index, record in enumerate(cached):
            record['basis'][name] = Matrix.LocRotScale(locations[index], Euler(angles[index], 'XYZ').to_quaternion(), scales[index])

    # An almost straight captured leg has an ill-conditioned knee plane: a tiny
    # knee offset can rotate its normal sharply. Added stance flexion must not
    # amplify that uncertainty. Weight neighboring planes by squared original
    # bend height, and retain reliable captured directions above 60 mm bend.
    plane_radius = math.ceil(.060 / dt)
    plane_sigma = .025
    for side in ('l', 'r'):
        stable_planes, confidences = [], []
        for index in range(count):
            neighbors = []
            for offset in range(-plane_radius, plane_radius + 1):
                other = cached[(index+offset) % count]
                weight = math.exp(-.5*(offset*dt/plane_sigma)**2) * max(1e-8, other['sourceBendHeight'][side]**2)
                neighbors.append((other['capturedPlane'][side], weight))
            reference = max(neighbors, key=lambda item: item[1])[0]
            weighted = Vector((0, 0, 0))
            for plane, weight in neighbors:
                weighted += plane * (weight if plane.dot(reference) >= 0 else -weight)
            stable_planes.append(weighted.normalized())
            u = max(0, min(1, (cached[index]['sourceBendHeight'][side]-.020)/.040))
            confidences.append(Vector((u*u*(3-2*u), 0, 0)))
        stable_planes.append(stable_planes[0].copy())
        confidences.append(confidences[0].copy())
        # The circular filter has no startup transient; the same final-time
        # Hermite repair also makes its boundary value/tangent periodic.
        stable_planes = smooth_seam(stable_planes)
        confidences = smooth_seam(confidences)
        for index, record in enumerate(cached):
            record.setdefault('stablePlane', {})[side] = stable_planes[index].normalized()
            record.setdefault('planeConfidence', {})[side] = max(0, min(1, confidences[index].x))

    rig.animation_data.action = None
    for record in cached:
        apply(record['basis'])
        record['desiredMinimum'] = {side: max(clearance, sole_min(side)) for side in ('l', 'r')}
        # Lower the animated pelvis, not the actor/root or rig rest pose. Keeping
        # the post-seam world ankle heights below adds modest stance knee flexion
        # and horizontal reach without discarding the repaired loop derivatives.
        pelvis = rig.pose.bones['pelvis']
        matrix = pelvis.matrix.copy()
        matrix.translation.z -= pelvis_drop
        pelvis.matrix = matrix
        bpy.context.view_layer.update()
        record['basis']['pelvis'] = pelvis.matrix_basis.copy()
        record['foot'] = {side: rig.pose.bones['foot_' + side].matrix.copy() for side in ('l', 'r')}
        record['hip'] = {side: rig.pose.bones['thigh_' + side].head.copy() for side in ('l', 'r')}
        record['desiredAnkle'] = {}
        for side in ('l', 'r'):
            ankle = record['foot'][side].translation.copy()
            ankle.z += record['desiredMinimum'][side] - sole_min(side)
            record['desiredAnkle'][side] = ankle

    constraints = {side: {} for side in ('l', 'r')}
    windows = {side: [] for side in ('l', 'r')}
    for side in ('l', 'r'):
        mask = [record['minimum'][side] < .040 for record in cached[:-1]]
        assert not all(mask), 'A running clip must retain a flight/swing phase.'
        for start in range(count):
            if not mask[start] or mask[(start - 1) % count]:
                continue
            length = 1
            while length < count and mask[(start + length) % count]:
                length += 1
            if length * dt < .025:
                continue
            # Roll over the material point that was lowest in the *baseline*
            # interval. Cancel that same vertex's rotation-induced travel at
            # both endpoints, integrating a continuous ankle trajectory instead
            # of pinning one mid-stance heel/toe through the entire foot roll.
            trajectory = [cached[start]['foot'][side].translation.copy()]
            labels = []
            for offset in range(length - 1):
                a = cached[(start + offset) % count]
                b = cached[(start + offset + 1) % count]
                original_a, original_b = a['originalFoot'][side], b['originalFoot'][side]
                label = min(range(len(local_soles[side])), key=lambda vertex:
                            max((original_a @ local_soles[side][vertex]).z, (original_b @ local_soles[side][vertex]).z))
                anchor = local_soles[side][label]
                rotation_delta = b['foot'][side].to_3x3() @ anchor - a['foot'][side].to_3x3() @ anchor
                trajectory.append(trajectory[-1] + Vector((-rotation_delta.x, -speed*dt-rotation_delta.y, 0)))
                labels.append(label)
            translation = Vector((statistics.median(cached[(start+i) % count]['foot'][side].translation.x - point.x for i, point in enumerate(trajectory)),
                                  statistics.median(cached[(start+i) % count]['foot'][side].translation.y - point.y for i, point in enumerate(trajectory)), 0))
            corrections = []
            for offset, point in enumerate(trajectory):
                record = cached[(start + offset) % count]
                delta = point + translation - record['foot'][side].translation
                delta.z = 0
                corrections.append(delta)
            extension = math.ceil(horizontal_fade / dt)
            start_velocity = (corrections[1] - corrections[0]) / dt
            end_velocity = (corrections[-1] - corrections[-2]) / dt
            extended = {}
            for offset in range(-extension, length + extension):
                unwrapped = start + offset
                active = 0 <= offset < length
                if not active and mask[unwrapped % count]:
                    continue
                if active:
                    correction = corrections[offset]
                elif offset < 0:
                    # Join the measured correction velocity at touchdown;
                    # a value-only fade would introduce a new velocity seam.
                    u = max(0, min(1, (offset*dt + horizontal_fade) / horizontal_fade))
                    correction = (corrections[0] * (-2*u**3 + 3*u*u)
                                  + start_velocity * (horizontal_fade * (u**3 - u*u)))
                else:
                    u = max(0, min(1, (offset-length+1)*dt / horizontal_fade))
                    correction = (corrections[-1] * (2*u**3 - 3*u*u + 1)
                                  + end_velocity * (horizontal_fade * (u**3 - 2*u*u + u)))
                extended[unwrapped % count] = correction
            # Check one continuous trajectory, including its flight return.
            # Scaling only planted samples can leave the very next flight key
            # unreachable and contaminate stance through export interpolation.
            scale = min(1, .08 / max(.000001, max(delta.length for delta in extended.values())))
            reach = rig.data.bones['thigh_' + side].length + rig.data.bones['shin_' + side].length - reach_margin
            for index, correction in extended.items():
                record = cached[index]
                origin = record['desiredAnkle'][side]
                hip = record['hip'][side]
                if (origin + correction*scale - hip).length > reach and (origin-hip).length <= reach:
                    low, high = 0.0, scale
                    for _ in range(24):
                        middle = (low+high)/2
                        if (origin + correction*middle - hip).length <= reach:
                            low = middle
                        else:
                            high = middle
                    scale = low
            for index, correction in extended.items():
                constraints[side][index] = correction*scale
            windows[side].append({'firstSample': start, 'samples': length, 'seconds': length * dt,
                                 'rollingSupportVertexChanges': sum(a != b for a, b in zip(labels, labels[1:])),
                                 'windowCorrectionScale': scale, 'reachIncludesFlightBlend': True,
                                 'maximumHorizontalCorrectionMetres': max(delta.length*scale for delta in extended.values())})

    reach_limited = 0
    maximum_unreachable = 0
    maximum_correction = 0
    ankle_diagnostics = []
    previous_leg_rotations = {}
    previous_original_planes = {}

    def solve(side, target, captured_plane, stable_plane, plane_confidence, index, baseline_minimum):
        nonlocal reach_limited, maximum_unreachable
        thigh = rig.pose.bones['thigh_' + side]
        shin = rig.pose.bones['shin_' + side]
        foot = rig.pose.bones['foot_' + side]
        hip, knee, ankle = thigh.head.copy(), shin.head.copy(), foot.head.copy()
        thigh_rotation = thigh.matrix.to_quaternion()
        shin_rotation = shin.matrix.to_quaternion()
        foot_rotation = foot.matrix.to_quaternion()
        length_a = rig.data.bones[thigh.name].length
        length_b = rig.data.bones[shin.name].length
        limit = length_a + length_b - reach_margin
        requested = target.copy()
        outside = max(0, (requested - hip).length - limit)
        if (target - hip).length > limit:
            # Explicit last-resort nearest point on the reachable sphere. The
            # source ankle can itself be fully extended, so it is not a valid
            # feasible endpoint for bisection toward an unreachable target.
            reach_limited += 1
            maximum_unreachable = max(maximum_unreachable, (target - hip).length - limit)
            target = hip + (target-hip).normalized()*limit
        delta = target - hip
        distance = delta.length
        assert distance > abs(length_a - length_b) + .000001
        direction = delta / distance
        original_bend = knee - hip
        normal = (ankle - hip).cross(original_bend)
        original_knee_height_squared = normal.length_squared / (ankle-hip).length_squared
        if normal.length_squared < 1e-10:
            normal = captured_plane.copy()
        elif normal.dot(captured_plane) < 0:
            normal = -normal
        original_plane = normal.normalized()
        plane_step = (math.acos(max(-1, min(1, original_plane.dot(previous_original_planes[side]))))
                      if side in previous_original_planes else None)
        previous_original_planes[side] = original_plane
        normal = original_plane if original_plane.dot(stable_plane) >= 0 else -original_plane
        normal = (stable_plane*(1-plane_confidence) + normal*plane_confidence).normalized()
        bend = normal.cross(direction)
        if bend.length_squared < 1e-10:
            bend = captured_plane.cross(direction)
        assert bend.length_squared >= 1e-10, 'No stable captured knee plane.'
        bend.normalize()
        along = (length_a*length_a - length_b*length_b + distance*distance) / (2*distance)
        height = math.sqrt(max(0, length_a*length_a - along*along))
        new_knee = hip + direction * along + bend * height
        rotation = (knee - hip).rotation_difference(new_knee - hip) @ thigh_rotation
        thigh.matrix = Matrix.Translation(hip) @ rotation.to_matrix().to_4x4()
        bpy.context.view_layer.update()
        rotation = (ankle - knee).rotation_difference(target - new_knee) @ shin_rotation
        shin.matrix = Matrix.Translation(shin.head.copy()) @ rotation.to_matrix().to_4x4()
        bpy.context.view_layer.update()
        foot.matrix = Matrix.Translation(foot.head.copy()) @ foot_rotation.to_matrix().to_4x4()
        bpy.context.view_layer.update()
        actual = foot.head.copy()
        local_rotations = {'thigh': thigh.matrix_basis.to_quaternion().normalized(),
                           'shin': shin.matrix_basis.to_quaternion().normalized()}
        angular_steps = {name: (2*math.acos(min(1, abs(rotation.dot(previous_leg_rotations[side][name]))))
                               if side in previous_leg_rotations else None)
                         for name, rotation in local_rotations.items()}
        previous_leg_rotations[side] = local_rotations
        ankle_diagnostics.append({'sample': index, 'timeSeconds': index*dt, 'side': side,
                                  'baselineFootMask40mm': baseline_minimum < .040,
                                  'unreachableMetres': outside,
                                  'requested': list(requested), 'feasible': list(target), 'solved': list(actual),
                                  'requestedToSolvedMetres': (requested-actual).length,
                                  'feasibleToSolvedMetres': (target-actual).length,
                                  'kneeHeightSquaredMetres2': height*height,
                                  'originalKneeHeightSquaredMetres2': original_knee_height_squared,
                                  'originalHip': list(hip), 'originalKnee': list(knee), 'originalAnkle': list(ankle),
                                  'originalPlane': list(original_plane), 'originalPlaneStepRadians': plane_step,
                                  'capturedPlane': list(captured_plane), 'targetDirection': list(direction),
                                  'stablePlane': list(stable_plane), 'planeConfidence': plane_confidence,
                                  'solvedPlane': list(normal),
                                  'solvedBendDirection': list(bend),
                                  'localRotationStepRadians': angular_steps})

    solved = []
    floors = []
    for index, record in enumerate(cached):
        apply(record['basis'])
        for side in ('l', 'r'):
            foot = rig.pose.bones['foot_' + side]
            origin = foot.head.copy()
            target = origin.copy()
            minimum = sole_min(side)
            item = constraints[side].get(index % count)
            if item is not None:
                target += item
            # Preserve the post-Hermite per-foot height profile. Reapplying the
            # original C0 profile here would undo the periodic seam repair.
            target.z = origin.z + record['desiredMinimum'][side] - minimum
            maximum_correction = max(maximum_correction, (target - origin).length)
            solve(side, target, record['capturedPlane'][side], record['stablePlane'][side],
                  record['planeConfidence'][side], index, record['minimum'][side])
        floors.append(min(sole_min(side) for side in ('l', 'r')))
        solved.append({name: rig.pose.bones[name].matrix_basis.copy() for name in LOWER})
    solved[-1] = {name: matrix.copy() for name, matrix in solved[0].items()}

    # Replace only the seven lower-body bones' curves. Existing upper-body keys
    # retain their exact times and values, including both weapon hands.
    prefixes = tuple('pose.bones["' + name + '"]' for name in LOWER)
    for layer in action.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                for curve in list(bag.fcurves):
                    if curve.data_path.startswith(prefixes):
                        bag.fcurves.remove(curve)
    rig.animation_data.action = action
    if action.slots:
        rig.animation_data.action_slot = action.slots[0]
    for index, basis in enumerate(solved):
        for name, matrix in basis.items():
            bone = rig.pose.bones[name]
            bone.matrix_basis = matrix
            bone.keyframe_insert('rotation_euler', frame=1 + index*dt*30, group=name)
            bone.keyframe_insert('location', frame=1 + index*dt*30, group=name)
    for layer in action.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                for curve in bag.fcurves:
                    if curve.data_path.startswith(prefixes):
                        for key in curve.keyframe_points:
                            key.interpolation = 'LINEAR'
    maximum_vertical_error = max(abs(item['requested'][2] - item['solved'][2]) for item in ankle_diagnostics)
    report = {'method': 'Post-warp periodic seam and baseline-labelled rolling support with stable-plane two-bone ankle IK',
            'samplesHz': 240, 'samples': count + 1, 'seamWindowSeconds': seam_window,
            'constantPelvisDropMetres': pelvis_drop,
            'planeStabilization': {'radiusSeconds': plane_radius*dt, 'sigmaSeconds': plane_sigma,
                                   'confidenceBendMetres': [.020, .060], 'neighborWeight': 'Original bend height squared'},
            'horizontalFadeOutsideMaskSeconds': horizontal_fade, 'reachMarginMetres': reach_margin,
            'fixedBaselineContactHeight': .040, 'fullSupportHeight': .040, 'maximumHorizontalCorrection': .08,
            'flightBlend': 'Cubic Hermite preserving support-edge correction value and derivative',
            'contactWindows': windows, 'postSeamFootHeightProfilePreserved': maximum_vertical_error < .00001,
            'maximumAnkleVerticalErrorMetres': maximum_vertical_error,
            'reachLimitedSamples': reach_limited, 'maximumUnreachableMetres': maximum_unreachable,
            'unreachableFallback': 'Nearest fixed-length sphere projection; occurrence count and errors reported',
            'maximumRequestedToSolvedMetres': max(item['requestedToSolvedMetres'] for item in ankle_diagnostics),
            'maximumFeasibleToSolvedMetres': max(item['feasibleToSolvedMetres'] for item in ankle_diagnostics),
            'minimumKneeHeightMetres': math.sqrt(min(item['kneeHeightSquaredMetres2'] for item in ankle_diagnostics)),
            'minimumOriginalKneeHeightMetres': math.sqrt(min(item['originalKneeHeightSquaredMetres2'] for item in ankle_diagnostics)),
            'maximumLocalRotationStepRadians': {
                name: max(item['localRotationStepRadians'][name] or 0 for item in ankle_diagnostics)
                for name in ('thigh', 'shin')},
            'maximumAnkleCorrectionMetres': maximum_correction, 'sampledFloorMin': min(floors),
            'unchangedUpperBodyLocalCurves': True,
            'limits': 'Actual 120 Hz GLB skin, seam velocities and controller transitions require independent validation. Residual reverse foot-roll drift and acceleration remain measurable; this is not a perfect foot-locking guarantee.'}
    if diagnostics_enabled:
        report['ankleDiagnostics'] = ankle_diagnostics
    return report
