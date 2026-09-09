"""Reproducible Kannon Town surface/architecture release, Blender 5.2.1.

Uses the byte-verified common town and approved vehicles; collision, routes,
truck, character and animation sources are not regenerated. New art is original
procedural mesh and texture work. No network access or paid assets are needed.
"""
import bpy, bmesh, math, json, hashlib, subprocess
from pathlib import Path
from collections import defaultdict
from mathutils import Vector
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT/'art/source'
TEX = SOURCE/'town-graphics-materials'
TEX.mkdir(exist_ok=True)
MAP = json.loads(subprocess.check_output(['node', '--import', 'tsx', str(ROOT/'scripts/blender/export_map.ts')], cwd=str(ROOT)))
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
bpy.context.preferences.filepaths.save_version = 0
for name in ['environment-vehicle-test.glb', 'vehicles-improved.glb']:
    bpy.ops.import_scene.gltf(filepath=str(ROOT/'public/models'/name))
rng = np.random.default_rng(9092026)
def bv(p): return (p[0], -p[2], p[1])
def gv(p): return (p[0], p[2], -p[1])
def linear(c): return c/12.92 if c <= .04045 else ((c+.055)/1.055)**2.4
def tint(h): return tuple(linear(int(h[i:i+2],16)/255) for i in (1,3,5))

def image(name, rgb, data=False):
    h,w=rgb.shape[:2]; rgba=np.ones((h,w,4),np.float32); rgba[:,:,:3]=np.clip(rgb,0,1)
    im=bpy.data.images.new(name,width=w,height=h,alpha=False)
    im.colorspace_settings.name='Non-Color' if data else 'sRGB'
    im.pixels.foreach_set(rgba.ravel());im.file_format='PNG' if data else 'JPEG'
    im.filepath_raw=str(TEX/(name+('.png' if data else '.jpg')));im.save();im.pack();return im

def surface(name, kind, rough=.8, metal=0, scale=2):
    mat=bpy.data.materials.new(name);mat.use_nodes=True;mat.use_backface_culling=True;mat['uvMetres']=scale
    nodes=mat.node_tree.nodes;links=mat.node_tree.links;bs=nodes.get('Principled BSDF')
    bs.inputs['Roughness'].default_value=rough;bs.inputs['Metallic'].default_value=metal
    attr=nodes.new('ShaderNodeVertexColor');attr.layer_name='Color'
    n=256;y,x=np.mgrid[:n,:n]/n;noise=rng.normal(0,1,(n,n))
    # Seamless isotropic variation avoids visible repeated checker patterns.
    frequency=np.fft.fftfreq(n)*n
    falloff=np.exp(-(frequency[:,None]**2+frequency[None,:]**2)/18)
    cloud=np.fft.ifft2(np.fft.fft2(rng.normal(0,1,(n,n)))*falloff).real
    cloud=np.clip(cloud/(cloud.std()*2.5),-1,1)
    h=noise*.003;value=.9+noise*.012+cloud*.02
    if kind=='siding':
        h=np.sin(x*math.tau*65+np.sin(y*math.tau*3))*.004+noise*.001
        value=.94+noise*.009+cloud*.009
    elif kind=='asphalt':
        aggregate=rng.random((n,n));h=aggregate*.025
        value=.48+noise*.032+cloud*.032+(aggregate>.96)*.10-(aggregate<.05)*.04
    elif kind=='concrete':
        pores=rng.random((n,n))<.013;h=noise*.001-pores*.011;value=.86+noise*.012+cloud*.035-pores*.065
    elif kind=='wood':
        grain=np.sin(x*math.tau*38+np.sin(y*math.tau*2)*.8)*.022+np.sin(x*math.tau*81+np.sin(y*math.tau)*2)*.01
        seams=((x*5)%1<.012);h=grain*.11-seams*.008;value=.87+grain+noise*.009-seams*.13+cloud*.025
    elif kind=='roof':
        row=np.floor(y*8);u=(x*7+row%2*.5)%1;v=(y*8)%1
        seams=(u<.025)|(v<.055);h=.005*np.minimum(v/.07,1)-seams*.009
        value=.73+noise*.025+.04*np.sin(row*8+np.floor(x*7+row%2*.5)*3)-seams*.14
    elif kind=='grass':
        h=noise*.015;value=.76+noise*.035+cloud*.045
    elif kind=='bark':
        grain=np.sin(x*math.tau*21+np.sin(y*math.tau*3))
        h=grain*.026+noise*.007;value=.67+grain*.10+noise*.025+cloud*.025
    elif kind=='fabric':
        weave=np.sin(x*math.tau*85)*np.sin(y*math.tau*85)
        h=weave*.003;value=.84+weave*.018+noise*.008
    rgb=np.repeat(np.clip(value,.16,1)[:,:,None],3,axis=2)
    tex=nodes.new('ShaderNodeTexImage');tex.image=image(name+'_Albedo',rgb)
    mul=nodes.new('ShaderNodeMixRGB');mul.blend_type='MULTIPLY';mul.inputs[0].default_value=1
    links.new(tex.outputs['Color'],mul.inputs[1]);links.new(attr.outputs['Color'],mul.inputs[2]);links.new(mul.outputs[0],bs.inputs['Base Color'])
    dx=(np.roll(h,-1,1)-np.roll(h,1,1))*2;dy=(np.roll(h,-1,0)-np.roll(h,1,0))*2
    normal=np.stack([-dx,-dy,np.ones_like(dx)],axis=-1);normal/=np.linalg.norm(normal,axis=2,keepdims=True)
    nt=nodes.new('ShaderNodeTexImage');nt.image=image(name+'_Normal',normal*.5+.5,True)
    nm=nodes.new('ShaderNodeNormalMap');nm.inputs['Strength'].default_value=.5
    links.new(nt.outputs['Color'],nm.inputs['Color']);links.new(nm.outputs['Normal'],bs.inputs['Normal'])
    orm=image(name+'_ORM',np.stack([np.ones_like(value),np.clip(rough+cloud*.035+noise*.008,.05,1),np.full_like(value,metal)],axis=-1),True)
    ot=nodes.new('ShaderNodeTexImage');ot.image=orm;sep=nodes.new('ShaderNodeSeparateColor');links.new(ot.outputs['Color'],sep.inputs['Color'])
    links.new(sep.outputs['Green'],bs.inputs['Roughness']);links.new(sep.outputs['Blue'],bs.inputs['Metallic'])
    mat['provenance']='Original seeded procedural Kannon Town graphics release material.'
    return mat

def plain(name, rough=.65, metal=0):
    mat=bpy.data.materials.new(name);mat.use_nodes=True;mat.use_backface_culling=True;mat['uvMetres']=2
    bs=mat.node_tree.nodes.get('Principled BSDF');bs.inputs['Roughness'].default_value=rough;bs.inputs['Metallic'].default_value=metal
    a=mat.node_tree.nodes.new('ShaderNodeVertexColor');a.layer_name='Color';mat.node_tree.links.new(a.outputs['Color'],bs.inputs['Base Color'])
    return mat

M={
 'siding':surface('RefinedLimestoneSiding','siding',.72,scale=2),
 'trim':surface('RefinedLimestoneTrim','siding',.65,scale=2),
 'concrete':surface('RefinedGroundConcrete','concrete',.88,scale=2),
 'asphalt':surface('RefinedGroundAsphalt','asphalt',.93,scale=3),
 'wood':surface('RefinedGroundWood','wood',.8,scale=2),
 'roof':surface('RefinedGroundRoof','roof',.9,scale=2.8),
 'grass':surface('RefinedGroundGrass','grass',.96,scale=2.5),
 'bark':surface('RefinedBark','bark',.91,scale=1),
 'cliff':surface('RefinedCliff','concrete',.96,scale=8),
 'fabric':surface('RefinedFabric','fabric',.94,scale=1),
 'metal':plain('RefinedBronzeMetal',.32,.8),
 'glass':plain('RefinedArchitecturalGlass',.16,.15),
 'leaves':plain('RefinedLeaves',.9),
 'markings':plain('RefinedGroundMarkings',.94),
}
replacements={'TownLimestoneSiding':'siding','TownLimestoneTrim':'trim','TownGroundConcrete':'concrete','TownGroundAsphalt':'asphalt','TownGroundWood':'wood','TownGroundRoof':'roof','TownGroundGrass':'grass'}
base_meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']
roots=[]
for obj in base_meshes:
    if obj.name.startswith('Town_wood'):
        # Original outside-map trunk roots, recovered from the actual common mesh.
        pts=[gv(obj.matrix_world@v.co) for v in obj.data.vertices]
        ground=[p for p in pts if abs(p[0])>32 and abs(p[1])<.01]
        groups=[]
        for p in ground:
            group=next((g for g in groups if math.hypot(p[0]-g[0][0],p[2]-g[0][2])<.7),None)
            if group is None:groups.append([p])
            else:group.append(p)
        for g in groups:
            x=(min(p[0] for p in g)+max(p[0] for p in g))/2;z=(min(p[2] for p in g)+max(p[2] for p in g))/2
            height=max(p[1] for p in pts if math.hypot(p[0]-x,p[2]-z)<.4)
            roots.append((x,height,z))
    if obj.name.startswith('Town_leaves'):
        bpy.data.objects.remove(obj,do_unlink=True);continue
    if obj.name.startswith('Horizon_Town'):
        bm=bmesh.new();bm.from_mesh(obj.data);bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=.00001)
        # The inherited hill strips face downward, exposing sky under the ridge.
        # Only outside-map hills are corrected; the playable terrain is intact.
        for face in bm.faces:
            if face.calc_center_median().z>.05 and face.normal.z<0:face.normal_flip()
        bm.normal_update();bm.to_mesh(obj.data);bm.free()
        for p in obj.data.polygons:p.use_smooth=True
        if 'earth' in obj.name.lower():
            for i in range(len(obj.data.materials)):obj.data.materials[i]=M['cliff']
    # Preserve the cargo truck's authored material assignments as well as geometry.
    # Shared materials are copied before replacing surfaces on architecture batches.
    if not obj.name.startswith('Town_'):continue
    for i,old in enumerate(list(obj.data.materials)):
        if old.name in replacements:
            obj.data.materials[i]=M[replacements[old.name]]
            truck_polys=[p for p in obj.data.polygons if p.material_index==i and .7<gv(obj.matrix_world@p.center)[0]<4.6 and -.5<gv(obj.matrix_world@p.center)[2]<10.7]
            if truck_polys:
                obj.data.materials.append(old)
                for p in truck_polys:p.material_index=len(obj.data.materials)-1
    colors=obj.data.color_attributes.get('Color')
    if not colors and obj.data.color_attributes:colors=obj.data.color_attributes[0];colors.name='Color'
    if colors and obj.name.startswith('Town_siding'):
        for poly in obj.data.polygons:
            center=gv(obj.matrix_world@poly.center)
            c=tint('#6F948F' if center[0]<0 else '#CDB178')
            for li in poly.loop_indices:colors.data[li].color=(*c,1)

batches=defaultdict(lambda:{'v':[],'f':[],'uv':[],'c':[],'smooth':[]})
def poly(key,points,c='#ffffff',smooth=False):
    b=batches[key];start=len(b['v']);b['v'].extend(bv(p) for p in points);b['f'].append(tuple(range(start,start+len(points))))
    n=(Vector(points[1])-Vector(points[0])).cross(Vector(points[2])-Vector(points[0]));axis=max(range(3),key=lambda i:abs(n[i]))
    axes=[i for i in range(3) if i!=axis];scale=M[key]['uvMetres'];b['uv'].extend((p[axes[0]]/scale,p[axes[1]]/scale) for p in points)
    b['c'].extend([(*tint(c),1)]*len(points));b['smooth'].append(smooth)
def box(key,p,size,c='#ffffff'):
    x,y,z=p;w,h,d=(v/2 for v in size)
    v=[(x-w,y-h,z-d),(x+w,y-h,z-d),(x+w,y+h,z-d),(x-w,y+h,z-d),(x-w,y-h,z+d),(x+w,y-h,z+d),(x+w,y+h,z+d),(x-w,y+h,z+d)]
    for f in [(0,3,2,1),(4,5,6,7),(0,4,7,3),(1,2,6,5),(0,1,5,4),(3,7,6,2)]:poly(key,[v[i] for i in f],c)
def tube(key,a,b,r,c='#ffffff',r2=None,n=10):
    a,b=Vector(a),Vector(b);axis=(b-a).normalized();u=axis.cross(Vector((0,1,0)))
    if u.length<.01:u=axis.cross(Vector((1,0,0)))
    u.normalize();v=axis.cross(u);r2=r if r2 is None else r2
    rings=[[p+(u*math.cos(i*math.tau/n)+v*math.sin(i*math.tau/n))*rad for i in range(n)] for p,rad in [(a,r),(b,r2)]]
    for i in range(n):j=(i+1)%n;poly(key,[rings[0][i],rings[0][j],rings[1][j],rings[1][i]],c,True)
    poly(key,list(reversed(rings[0])),c);poly(key,rings[1],c)

# Formed clapboards cast a fine physical edge shadow; cut to every existing
# wall segment so doors, firing windows and all routes remain open.
clapboards=0
for ob in MAP['obstacles']:
    if ob.get('surface') not in ('teal','yellow') or 'car' in ob['id'] or 'shed' in ob['id']:continue
    x,y,z,w,h,d=(ob[k] for k in ('x','y','z','w','h','d'))
    if min(w,d)>.3:continue
    side=-1 if x<0 else 1;c='#71958F' if side<0 else '#CBB17C'
    horizontal_x=d<w
    # Only the exterior face; original wall faces remain the collision witness.
    sign=(-1 if z<0 else 1) if horizontal_x else (-side if abs(x)<16 else side)
    at=z+sign*(d/2+.004) if horizontal_x else x+sign*(w/2+.004)
    lo=max(.48,y-h/2);hi=y+h/2
    for bottom in np.arange(math.floor(lo/.21)*.21,hi,.21):
        b=max(lo,float(bottom));t=min(hi,float(bottom)+.21)
        if t-b<.025:continue
        length=w if horizontal_x else d;center=x if horizontal_x else z
        # Wedge depth 24mm at the lower lap, tapering to the original face.
        coords=[(center-length/2,b,at+sign*.026),(center+length/2,b,at+sign*.026),(center+length/2,t,at),(center-length/2,t,at)]
        pts=coords if horizontal_x else [(p[2],p[1],p[0]) for p in coords]
        expected=Vector((0,0,sign) if horizontal_x else (sign,0,0))
        if (Vector(pts[1])-Vector(pts[0])).cross(Vector(pts[2])-Vector(pts[0])).dot(expected)<0:pts.reverse()
        poly('siding',pts,c);clapboards+=1
    # Foundation blocks stay below the door/window cuts, never across an opening.
    if y-h/2<.01:
        p=(x,.235,at+sign*.005) if horizontal_x else (at+sign*.005,.235,z)
        size=(w,.47,.025) if horizontal_x else (.025,.47,d)
        box('concrete',p,size,'#AAA79B')

for side in [-1,1]:
    x=lambda u:side*u
    # Roof thickness, ridge caps, formed metal gutters and downspouts.
    for cx,cz,w,d,base,rise in [(x(16),0,12.3,12.3,6.42,1.65),(x(14),9.75,8.5,7.75,3.29,.7),(x(28),16,4.4,3.7,2.6,.6)]:
        # Existing gable triangles face inward. Add the proper exterior skin;
        # otherwise the ridge appears to float when viewed from the street.
        for end in [-1,1]:
            face=[(cx+end*(w/2+.003),base,cz-d/2),(cx+end*(w/2+.003),base+rise,cz),(cx+end*(w/2+.003),base,cz+d/2)]
            if end<0:face.reverse()
            poly('siding',face,'#71958F' if side<0 else '#CBB17C')
        tube('roof',(cx-w/2-.3,base+rise+.04,cz),(cx+w/2+.3,base+rise+.04,cz),.11,'#5E615C',n=8)
        for zsign in [-1,1]:
            edge=cz+zsign*(d/2+.34)
            tube('metal',(cx-w/2-.32,base-.03,edge),(cx+w/2+.32,base-.03,edge),.055,'#B8B9AD',n=8)
            # Small repeating rafter ends are confined to the roof edge.
            for u in np.arange(cx-w/2,cx+w/2,.8):box('trim',(float(u),base-.13,edge-zsign*.1),(.065,.19,.3),'#C6C3B4')
        if base>3:
            for sx in [-1,1]:
                px=cx+sx*(w/2-.2);pz=cz-d/2-.2
                tube('metal',(px,.15,pz),(px,base-.05,pz),.05,'#A5B0A7',n=8)
                for h in np.arange(.6,base,1.35):box('metal',(px,float(h),pz),(.13,.035,.13),'#7F8E88')
    # Solid side-wall decorative windows. Existing open front firing windows
    # deliberately receive no glass, shutters or new occlusion.
    for u in [12.7,19.4]:
        for y in [1.7,4.85]:
            cx=x(u);z=-6.215
            box('glass',(cx,y,z),(1.58,1.34,.024),'#4B6870')
            for dx in [-.86,.86]:box('trim',(cx+dx,y,z-.045),(.13,1.57,.10),'#D5D2C6')
            for dy in [-.74,.74]:box('trim',(cx,y+dy,z-.045),(1.85,.13,.10),'#D5D2C6')
            box('trim',(cx,y,z-.065),(.055,1.42,.07),'#B6BDB4');box('trim',(cx,y,z-.065),(1.62,.055,.07),'#B6BDB4')
            box('concrete',(cx,y-.82,z-.06),(2,.1,.26),'#A7A79B')
    # Open-front casement depth and mullion handles, outside traversable openings.
    for y,z,w in [(2.57,2.85,3.8),(5.94,0,6.95)]:
        box('trim',(x(9.75),y,z),(.19,.1,w),'#C4C4B5')
        box('metal',(x(9.69),y-.035,z-w/2+.13),(.075,.045,.16),'#52665D')
    # Wall-mounted porch lanterns; no extra realtime point-light passes.
    for z in [-4.15,6.6]:
        box('metal',(x(9.78),2.3,z),(.11,.48,.23),'#344943')
        box('glass',(x(9.70),2.3,z),(.07,.30,.16),'#D7C694')
        box('metal',(x(9.70),2.54,z),(.23,.045,.3),'#344943')
    # Workbench drawer fronts and sofa upholstery follow existing prop extents.
    for z in [11.65,12.2,12.8]:
        box('wood',(x(16.865),.55,z),(.024,.65,.49),'#9B7C56')
        box('metal',(x(16.845),.70,z),(.045,.035,.19),'#58645A')
    for z in [2.85,3.8,4.75]:box('fabric',(x(12),.862,z),(1.05,.006,.88),'#747F71')
    # Concrete expansion joints and narrow road-side drainage channels.
    for z in np.arange(-22,23,2.5):box('markings',(x(9.55),.033,float(z)),(1.3,.004,.014),'#777E77')
    for z in [-17,0,17]:
        box('metal',(x(8.74),.005,z),(.26,.012,.68),'#3B4945')
        for dz in np.arange(-.27,.28,.09):box('markings',(x(8.74),.013,z+float(dz)),(.21,.004,.031),'#141F1B')
    # Flush, worn road-edge line sections and restrained surface repairs.
    for z in np.arange(-21,22,2.1):box('markings',(x(8.31),.004,float(z)),(.075,.006,1.94),'#CCC6A5')
    for z in [-13.5,15]:
        for k in range(5):box('markings',(x(8.75)+side*k*.14,.005,z+.12*k),(.022,.007,.75),'#454C46')

# Fence post caps, horizontal rails and muted hardware retain the original
# continuous collision-backed fence and never widen a playable doorway.
for ob in MAP['obstacles']:
    if ob.get('surface')!='fence':continue
    x,y,z,w,h,d=(ob[k] for k in ('x','y','z','w','h','d'));along_z=d>w;length=max(w,d)
    for a in np.arange(-length/2,length/2+.01,2.4):
        px=x if along_z else x+float(a);pz=z+float(a) if along_z else z
        box('trim',(px,y+h/2+.052,pz),(.26,.104,.26),'#BABCAF')
        box('metal',(px,y+h/2-.20,pz),(.225,.032,.225),'#88958A')
    if h>1.5:
        for dy in [-.66,.58]:box('trim',(x,y+dy,z),(.24,.075,d) if along_z else (w,.075,.24),'#B9BDAC')

# Original trunks are retained. Replace faceted canopy blobs with modeled,
# tapered branches and clusters of individual, curved leaf silhouettes.
def leaf(center,u,v,c):
    center,u,v=Vector(center),Vector(u),Vector(v)
    p=[center-u,center-u*.42+v*.62,center+u*.40+v*.60,center+u,center+u*.40-v*.60,center-u*.42-v*.62]
    ridge=center+Vector((0,.025,0));
    for i in range(6):poly('leaves',[p[i],p[(i+1)%6],ridge],c)
for tree,(x,height,z) in enumerate(roots):
    if height>5.2:
        for frond in range(9):
            a=frond*math.tau/9+tree*.43;radial=Vector((math.cos(a),0,math.sin(a)));across=Vector((-math.sin(a),0,math.cos(a)))
            start=Vector((x,height,z));tip=start+radial*2.5+Vector((0,-.65,0));tube('bark',start,tip,.028,'#69744C',.008,n=6)
            for k in range(1,8):
                t=k/8;center=start+radial*(2.5*t)+Vector((0,.3*math.sin(t*math.pi)-.65*t*t,0));length=.8*(1-t*.7)
                for sign in [-1,1]:leaf(center+across*sign*length*.65,across*sign*length+radial*.22,radial*.08,'#697D4F' if k%2 else '#829257')
    else:
        for branch in range(7):
            a=branch*2.39996+tree*.37;radius=1.1 if branch else .2
            center=Vector((x+math.cos(a)*radius,height+.15+(branch%3)*.4,z+math.sin(a)*radius))
            tube('bark',(x,height-.7,z),center,.075,'#6B6650',.025,n=8)
            for j in range(64):
                direction=rng.normal(0,1,3);direction/=np.linalg.norm(direction);r=float(rng.uniform(.25,1.2))
                p=center+Vector(tuple(direction*r*np.array([1.1,.85,1.1])))
                a=float(rng.uniform(0,math.tau));length=float(rng.uniform(.25,.42))
                leaf(p,(math.cos(a)*length,.035,math.sin(a)*length),(-math.sin(a)*length*.52,.025,math.cos(a)*length*.52),['#65794D','#71844E','#819057','#526C43'][j%4])

env=bpy.data.objects.get('Environment')
assert env and bpy.data.objects.get('CollisionReferences')
detail_counts={}
for key,b in batches.items():
    mesh=bpy.data.meshes.new('Refined_'+key);mesh.from_pydata(b['v'],[],b['f']);mesh.update()
    ob=bpy.data.objects.new('Horizon_Refined_'+key if key in ('leaves','bark') else 'Refined_'+key,mesh);bpy.context.collection.objects.link(ob);ob.parent=env;mesh.materials.append(M[key])
    uv=mesh.uv_layers.new(name='UVMap');colors=mesh.color_attributes.new(name='Color',type='FLOAT_COLOR',domain='CORNER')
    for p in mesh.polygons:
        p.use_smooth=b['smooth'][p.index]
        for li in p.loop_indices:
            i=mesh.loops[li].vertex_index;uv.data[li].uv=b['uv'][i];colors.data[li].color=b['c'][i]
    mesh.calc_loop_triangles();detail_counts[key]=len(mesh.loop_triangles)

# Give every primitive a well-defined vertex color, then merge shared materials
# across the three vehicles. This preserves geometry while removing duplicate
# tire/glass/chrome submissions. Keep named semantic Blender source objects.
all_meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']
for obj in all_meshes:
    if not obj.data.color_attributes:
        color=obj.data.color_attributes.new(name='Color',type='FLOAT_COLOR',domain='CORNER')
        color.data.foreach_set('color',[1,1,1,1]*len(color.data))
    elif not obj.data.color_attributes.get('Color'):obj.data.color_attributes[0].name='Color'
    for v in obj.data.vertices:assert all(math.isfinite(n) for n in v.co)
for im in bpy.data.images:
    if im.size[0] and not im.packed_file:im.pack()
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE/'kannon-town-graphics.blend'))

# Export copies grouped by material; editable originals above remain untouched.
groups=defaultdict(list)
for obj in all_meshes:
    groups[(obj.data.materials[0].name,obj.name.startswith('Horizon'))].append(obj)
export_meshes=[]
for (name,horizon),objects in groups.items():
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects:obj.select_set(True)
    bpy.context.view_layer.objects.active=objects[0]
    if len(objects)>1:bpy.ops.object.join()
    obj=bpy.context.view_layer.objects.active;obj.name=('Horizon_' if horizon else '')+'Release_'+name;obj.parent=env
    export_meshes.append(obj)
bpy.ops.object.select_all(action='DESELECT')
for o in [env,bpy.data.objects.get('CollisionReferences'),*export_meshes,*[o for o in bpy.context.scene.objects if o.name.startswith('Collision_')]]:o.select_set(True)
out=ROOT/'public/models/environment-refined.glb';staged=out.with_name('environment-refined.staged.glb')
# Blender's default 12-bit shared-exponent filter merges millimetre-separated
# world-space layers. Use full mantissa precision within this process, without
# changing the installed Blender files. Compression remains Meshopt compatible.
from io_scene_gltf2.io.exp import meshopt
meshopt.EXP_FILTER_BITS=24
bpy.ops.export_scene.gltf(filepath=str(staged),export_format='GLB',use_selection=True,export_apply=True,export_yup=True,export_extras=True,export_animations=False,export_cameras=False,export_lights=False,export_vertex_color='NAME',export_vertex_color_name='Color',export_all_vertex_colors=False,export_meshopt_compression_enable=True)
data=staged.read_bytes();assert data[:4]==b'glTF' and len(data)<8_500_000
length=int.from_bytes(data[12:16],'little');gltf=json.loads(data[20:20+length])
triangles=sum(gltf['accessors'][p['indices']]['count']//3 for m in gltf['meshes'] for p in m['primitives'])
primitives=sum(len(m['primitives']) for m in gltf['meshes']);assert triangles<190000 and primitives<=42,(triangles,primitives)
staged.replace(out)
manifest={'name':'Kannon Town graphics release','blenderVersion':bpy.app.version_string,'generator':'scripts/blender/generate_town_graphics.py','source':'art/source/kannon-town-graphics.blend','export':'public/models/environment-refined.glb','bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'triangles':triangles,'primitives':primitives,'materials':len(gltf['materials']),'images':len(gltf.get('images',[])),'clapboardCourses':clapboards,'trees':len(roots),'detailTriangles':detail_counts,'collisionReferences':len(MAP['obstacles']),'mapSha256':hashlib.sha256((ROOT/'shared/map.ts').read_bytes()).hexdigest(),'vehicleSourceSha256':hashlib.sha256((ROOT/'public/models/vehicles-improved.glb').read_bytes()).hexdigest(),'commonSourceSha256':hashlib.sha256((ROOT/'public/models/environment-vehicle-test.glb').read_bytes()).hexdigest(),'provenance':'Original procedural additions and maps; common town and approved vehicle inputs retained from this repository. No purchases or third-party source assets.'}
(SOURCE/'town-graphics-export.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('KANNON_TOWN_GRAPHICS',json.dumps(manifest))
