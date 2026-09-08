"""Export denser locomotion without altering any other animation's sampler data."""
import copy
import json
import struct
import tempfile
import os
from pathlib import Path

import bpy


def _read_glb(path):
    data=path.read_bytes()
    magic,version,size=struct.unpack_from('<III',data)
    assert magic==0x46546C67 and version==2 and size==len(data)
    json_size,json_kind=struct.unpack_from('<II',data,12)
    assert json_kind==0x4E4F534A
    model=json.loads(data[20:20+json_size])
    offset=20+json_size
    bin_size,bin_kind=struct.unpack_from('<II',data,offset)
    assert bin_kind==0x004E4942 and offset+8+bin_size==len(data)
    return model,bytearray(data[offset+8:])


def _merge_animation_samples(base_path,dense_path,names):
    base,binary=_read_glb(base_path);dense,dense_binary=_read_glb(dense_path)
    # Keep every original byte offset stable, including embedded atlas images.
    binary=binary[:base['buffers'][0]['byteLength']]
    views={};accessors={}
    def accessor(index,time_origin=None):
        if index in accessors:return accessors[index]
        item=copy.deepcopy(dense['accessors'][index])
        assert 'sparse' not in item
        view_index=item['bufferView']
        if view_index not in views:
            view=copy.deepcopy(dense['bufferViews'][view_index])
            assert view.get('buffer',0)==0
            start=view.get('byteOffset',0);end=start+view['byteLength']
            binary.extend(b'\0'*((-len(binary))%4))
            view['byteOffset']=len(binary);binary.extend(dense_binary[start:end])
            views[view_index]=len(base['bufferViews']);base['bufferViews'].append(view)
        item['bufferView']=views[view_index]
        if time_origin is not None:
            assert item['componentType']==5126 and item['type']=='SCALAR'
            view=base['bufferViews'][item['bufferView']]
            offset=view['byteOffset']+item.get('byteOffset',0)
            stride=view.get('byteStride',4)
            for sample in range(item['count']):
                time=struct.unpack_from('<f',binary,offset+sample*stride)[0]
                struct.pack_into('<f',binary,offset+sample*stride,max(0,time-time_origin))
            item['min']=[max(0,item['min'][0]-time_origin)]
            item['max']=[item['max'][0]-time_origin]
        accessors[index]=len(base['accessors']);base['accessors'].append(item)
        return accessors[index]
    node_indices={node['name']:index for index,node in enumerate(base['nodes']) if 'name' in node}
    assert len(node_indices)==len([n for n in base['nodes'] if 'name' in n]), 'Node names must be unique.'
    replaced=[]
    for index,old in enumerate(base['animations']):
        if old['name'] not in names:continue
        animation=copy.deepcopy(next(a for a in dense['animations'] if a['name']==old['name']))
        # Blender frame 1 exports at 1/FPS. The in-place loop starts at time zero,
        # so remove that leading hold only from the two replacement animations.
        origin=min(dense['accessors'][s['input']]['min'][0] for s in animation['samplers'])
        for sampler in animation['samplers']:
            sampler['input']=accessor(sampler['input'],origin);sampler['output']=accessor(sampler['output'])
        for channel in animation['channels']:
            name=dense['nodes'][channel['target']['node']]['name']
            channel['target']['node']=node_indices[name]
        base['animations'][index]=animation;replaced.append(old['name'])
    assert set(replaced)==set(names)
    base['buffers'][0]['byteLength']=len(binary)
    encoded=json.dumps(base,separators=(',',':')).encode('utf8');encoded+=b' '*((-len(encoded))%4)
    binary.extend(b'\0'*((-len(binary))%4))
    output=struct.pack('<III',0x46546C67,2,28+len(encoded)+len(binary))
    output+=struct.pack('<II',len(encoded),0x4E4F534A)+encoded
    output+=struct.pack('<II',len(binary),0x004E4942)+binary
    base_path.write_bytes(output)


def export_scout(path,rig,clips,options,factor=4):
    """Bake only Walk/Run at 120 Hz; retain all other 30 Hz exported tracks exactly.

    Duplicate actions temporarily expand their frames with matching scene FPS.
    Their duration in seconds stays fixed. Only their exported animation buffers
    are spliced into the normal export; source actions and geometry stay intact.
    """
    assert factor>=2 and int(factor)==factor
    scene=bpy.context.scene;original_fps=scene.render.fps
    # Stage on the destination filesystem. Failed dense baking must not replace
    # the last good public asset with a coarse intermediate export.
    descriptor,temporary=tempfile.mkstemp(prefix='.scout-staged-',suffix='.glb',dir=path.parent)
    os.close(descriptor);base_path=Path(temporary)
    replacements=[]
    try:
        bpy.ops.export_scene.gltf(filepath=str(base_path),**options)
        scene.render.fps=original_fps*factor
        for name in ['Walk','Run']:
            original,frames=clips[name]
            dense=original.copy();dense.name='DenseExport_'+name
            for layer in dense.layers:
                for strip in layer.strips:
                    for bag in strip.channelbags:
                        for curve in bag.fcurves:
                            for key in curve.keyframe_points:
                                for vector in [key.co,key.handle_left,key.handle_right]:
                                    vector.x=1+(vector.x-1)*factor
                            curve.update()
            track=next(t for t in rig.animation_data.nla_tracks if t.name==name)
            nla=track.strips[0]
            replacements.append((nla,original,dense,nla.action_frame_end,nla.frame_end))
            nla.action=dense
            if dense.slots:nla.action_slot=dense.slots[0]
            nla.action_frame_start=1;nla.action_frame_end=frames*factor+1
            nla.frame_end=frames*factor+1
        descriptor,temporary=tempfile.mkstemp(prefix='kannon-scout-export-',suffix='.glb')
        os.close(descriptor);dense_path=Path(temporary)
        try:
            bpy.ops.export_scene.gltf(filepath=str(dense_path),**options)
            _merge_animation_samples(base_path,dense_path,{'Walk','Run'})
            os.replace(base_path,path)
        finally:
            dense_path.unlink(missing_ok=True)
    finally:
        base_path.unlink(missing_ok=True)
        for nla,original,dense,action_end,frame_end in replacements:
            nla.action=original
            if original.slots:nla.action_slot=original.slots[0]
            nla.action_frame_start=1;nla.action_frame_end=action_end;nla.frame_end=frame_end
            bpy.data.actions.remove(dense)
        scene.render.fps=original_fps
    return {'locomotion_hz':original_fps*factor,'other_clips_hz':original_fps,'method':'Only Walk/Run sampler buffers replaced; other clips and geometry retained from base export.'}
