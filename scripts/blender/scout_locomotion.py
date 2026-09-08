"""Retarget selected CMU lower-body motion onto the original Kannon scout rig.

Only Walk/Run are replaced. Data rights and provenance are retained separately
under art/source/motion/cmu-09; upper-body poses and all six other clips are ours.
"""
import bpy, json, math, statistics, hashlib
from mathutils import Matrix, Vector
from cmu_asf import parse_asf, parse_amc, forward_kinematics, mv, rotation as axis_rotation, sub


def retarget_locomotion(rig, body, clips, source):
    provenance=json.loads((source/'provenance.json').read_text())
    for entry in provenance['sources']:
        assert entry['file'] in ['09.asf','09_01.amc']
        assert hashlib.sha256((source/entry['file']).read_bytes()).hexdigest()==entry['sha256'], 'CMU source hash differs from recorded provenance.'
    skeleton=parse_asf(source/'09.asf')
    captures=parse_amc(source/'09_01.amc',skeleton)
    first,last=15,103
    points=[];roots=[]
    for capture in captures[first-1:last]:
        positions,rotations=forward_kinematics(skeleton,capture['values'])
        root=positions['root'];roots.append(Vector(root))
        forward=mv(rotations['root'],(0,0,1));yaw=math.atan2(forward[0],forward[2]);inverse=axis_rotation('y',-math.degrees(yaw))
        row={}
        for name,point in positions.items():
            normalized=mv(inverse,sub(point,(root[0],0,root[2])))
            row[name]=Vector((-normalized[0],normalized[2],normalized[1]))
        points.append(row)
    names=list(points[0]);assert len(points)==89
    distance=math.hypot(roots[-1].x-roots[0].x,roots[-1].z-roots[0].z)
    source_duration=(last-first)/120
    # Remove the measured position mismatch across the loop without adding endpoint
    # velocity. This does not equalize the source endpoint derivatives; the separate
    # validator reports the remaining velocity seam.
    for name in names:
        delta=points[-1][name]-points[0][name]
        for index,row in enumerate(points):
            phase=index/(len(points)-1)
            row[name]-=delta*(phase*phase*(3-2*phase))
    points[-1]={name:value.copy() for name,value in points[0].items()}
    scene=bpy.context.scene
    original={name:item[0] for name,item in clips.items()}
    source_leg=sum((points[0][b]-points[0][a]).length for a,b in [('lhipjoint','lfemur'),('lfemur','ltibia')])
    target_leg=rig.data.bones['thigh_l'].length+rig.data.bones['shin_l'].length
    scale=target_leg/source_leg
    source_hip=[(row['lhipjoint']+row['rhipjoint'])*.5 for row in points]
    hip_median=statistics.median(point.z for point in source_hip)
    footverts={}
    for side in ['l','r']:
        group=body.vertex_groups['foot_'+side]
        footverts[side]=[v.co.copy() for v in body.data.vertices if any(g.group==group.index and g.weight>.9 for g in v.groups)]

    def activate(action,frame):
        rig.animation_data.action=action
        if action.slots:rig.animation_data.action_slot=action.slots[0]
        scene.frame_set(int(frame),subframe=frame%1);bpy.context.view_layer.update()

    # Keep authored upper-body animation in local bone space so both weapon hands
    # follow one coherent torso. Only pelvis and leg chains receive captured motion.
    upper=[]
    for index in range(len(points)):
        activate(original['Run'],1+(original['Run'].frame_range[1]-1)*index/(len(points)-1))
        upper.append({bone.name:bone.matrix_basis.copy() for bone in rig.pose.bones})
    rest_pelvis=rig.data.bones['pelvis'].matrix_local.copy()
    raw=[]
    for index,row in enumerate(points):
        rig.animation_data.action=None
        for bone in rig.pose.bones:bone.matrix_basis=upper[index][bone.name]
        right=(row['rhipjoint']-row['lhipjoint']).normalized()
        up=(row['lowerback']-row['root']).normalized();up=(up-right*up.dot(right)).normalized()
        forward=up.cross(right).normalized();up=right.cross(forward).normalized()
        rotation=Matrix((right,forward,up)).transposed().to_quaternion()
        hip=source_hip[index]
        pelvis_position=Vector((hip.x*scale,hip.y*scale,.91+(hip.z-hip_median)*scale))
        rig.pose.bones['pelvis'].matrix=Matrix.Translation(pelvis_position)@rotation.to_matrix().to_4x4()@rest_pelvis.to_quaternion().to_matrix().to_4x4()
        bpy.context.view_layer.update()
        for side in ['l','r']:
            for name,a,b in [('thigh','hipjoint','femur'),('shin','femur','tibia'),('foot','tibia','foot')]:
                pose=rig.pose.bones[name+'_'+side];rest=rig.data.bones[pose.name]
                start=pose.head.copy();direction=(row[side+b]-row[side+a]).normalized()
                rotation=(rest.tail_local-rest.head_local).rotation_difference(direction)@rest.matrix_local.to_quaternion()
                pose.matrix=Matrix.Translation(start)@rotation.to_matrix().to_4x4();bpy.context.view_layer.update()
        raw.append({'basis':{bone.name:bone.matrix_basis.copy() for bone in rig.pose.bones}})

    def apply_pose(record):
        for bone in rig.pose.bones:bone.matrix_basis=record['basis'][bone.name]
        bpy.context.view_layer.update()
    def feet_geometry():
        out={}
        for side,vertices in footverts.items():
            transform=rig.pose.bones['foot_'+side].matrix@rig.data.bones['foot_'+side].matrix_local.inverted()
            positions=[transform@vertex for vertex in vertices]
            out[side]=positions
        return out

    source_floor=min(min(row[side+name].z for side in ['l','r'] for name in ['foot','toes']) for row in points)
    for index,record in enumerate(raw):
        apply_pose(record);geometry=feet_geometry()
        source_min=min(points[index][side+name].z for side in ['l','r'] for name in ['foot','toes'])
        # Preserve captured flight height, correcting only the target mesh's sole offset.
        desired=.006+max(0,(source_min-source_floor)*scale)
        minimum=min(point.z for vertices in geometry.values() for point in vertices)
        pelvis=rig.pose.bones['pelvis'];matrix=pelvis.matrix.copy();matrix.translation.z+=desired-minimum;pelvis.matrix=matrix
        bpy.context.view_layer.update()
        record['basis']={bone.name:bone.matrix_basis.copy() for bone in rig.pose.bones}
        record['feet']=feet_geometry()
        record['minimum']=min(point.z for vertices in record['feet'].values() for point in vertices)

    # For each interval, track the same low sole vertex; using changing min vertices
    # would falsely report pivoting contact as horizontal foot sliding.
    intervals=[]
    for index,(a,b) in enumerate(zip(raw,raw[1:])):
        options=[]
        for side in ['l','r']:
            for vertex,(pa,pb) in enumerate(zip(a['feet'][side],b['feet'][side])):
                if max(pa.z,pb.z)<.040 and pb.y<pa.y-.0005:
                    options.append((max(pa.z,pb.z),side,vertex,pa,pb))
        chosen=min(options,key=lambda entry:entry[0]) if options else None
        intervals.append(chosen)

    report={'source':'CMU 09_01','source_frames':[first,last],'source_duration':source_duration,'source_root_distance_metres':distance,'target_leg_scale':scale,'target_reference_speed':distance*scale/source_duration,'original_lower_body_boundary_rms_metres':.01822,'seam_cleanup':'Smoothstep distributes the measured endpoint difference through one full source cycle; endpoint made identical.','candidates':[]}

    def metrics(records,times,speed):
        errors=[];lateral=[];heights=[]
        for index,(a,b) in enumerate(zip(records,records[1:])):
            dt=times[index+1]-times[index]
            if dt<=1e-8:continue
            heights.extend([a['minimum'],b['minimum']])
            choice=intervals[index]
            if choice:
                _,side,vertex,_,_=choice;pa=a['feet'][side][vertex];pb=b['feet'][side][vertex]
                velocity=(pb-pa)/dt+Vector((0,speed,0));errors.append(velocity.length);lateral.append(abs(velocity.x))
        return {'contactIntervals':len(errors),'contactVelocityMedian':statistics.median(errors) if errors else None,'contactVelocityMax':max(errors) if errors else None,'contactLateralVelocityMedian':statistics.median(lateral) if lateral else None,'floorMin':min(heights),'floorMax':max(heights)}

    new_actions={}
    for name,speed,cycle_frames in [('Walk',6.5,16),('Run',9,14)]:
        total=cycle_frames/30
        contact_dt=[(item[3].y-item[4].y)/speed if item else None for item in intervals]
        contact_sum=sum(value for value in contact_dt if value is not None)
        free_count=sum(value is None for value in contact_dt)
        assert free_count>0 and contact_sum<total, 'Cannot preserve cadence without viable flight phases.'
        free_dt=(total-contact_sum)/free_count
        durations=[value if value is not None else free_dt for value in contact_dt]
        # Smooth the sharp contact/flight boundary over two samples. This trades a
        # small measured slip for continuous angular speed; the report exposes it.
        durations=[.18*durations[(i-1)%len(durations)]+.64*durations[i]+.18*durations[(i+1)%len(durations)] for i in range(len(durations))]
        times=[0]
        for duration in durations:times.append(times[-1]+duration)
        old=original[name];old.name='Original_'+name;old.use_fake_user=True
        for track in list(rig.animation_data.nla_tracks):
            if track.name==name:rig.animation_data.nla_tracks.remove(track)
        action=bpy.data.actions.new(name);new_actions[name]=action;rig.animation_data.action=action
        for index,record in enumerate(raw):
            apply_pose(record);frame=1+times[index]*30
            for bone in rig.pose.bones:
                bone.keyframe_insert('rotation_euler',frame=frame,group=bone.name)
                bone.keyframe_insert('location',frame=frame,group=bone.name)
        # Linear interpolation avoids overshoot beyond measured joint limits at dense sample times.
        for layer in action.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    for curve in bag.fcurves:
                        for key in curve.keyframe_points:key.interpolation='LINEAR'
        clips[name]=(action,cycle_frames)
        native_rate=speed/report['target_reference_speed']
        uniform_times=[index/120/native_rate for index in range(len(raw))]
        # Original hand-authored gait contact comparison under the current runtime reference rate.
        entry={'clip':name,'targetSpeed':speed,'cycleDuration':times[-1],'stepsPerSecond':2/times[-1],'uniformCaptureRate':native_rate,'uniformStepsPerSecond':2/(source_duration/native_rate),'contactTime':contact_sum,'freeIntervals':free_count,'timeWarpRateRange':[1/(120*max(durations)),1/(120*min(durations))],'contactAware':metrics(raw,times,speed),'uniform':metrics(raw,uniform_times,speed),'runtimeProposal':{'clip':name,'playbackAtTarget':1,'referenceSpeed':speed,'note':'Playback is actual speed divided by this clip reference, including aiming and slow analog movement. Runtime turns use world-up and preserve upper orientation.'}}
        report['candidates'].append(entry)
    return report
