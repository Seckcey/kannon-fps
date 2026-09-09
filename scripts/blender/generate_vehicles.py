"""Original Blender vehicle graphics experiment; no environment/gameplay mutation.

Rebuild with Blender 5.2 --background --python scripts/blender/generate_vehicles.py.
All dimensions are metres; authoring coordinates are (length, height, half-width).
The three parent transforms stay identity in glTF; all vertices are world positioned.
No external models, photographs, fonts, textures, or paid services are used.
"""
import bpy, math, json, hashlib, os
from pathlib import Path
from collections import defaultdict
from mathutils import Vector
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'art/source'
TEX = SOURCE / 'vehicle-materials'
TEX.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.context.preferences.filepaths.save_version = 0
rng = np.random.default_rng(9022026)
TAU = math.tau

def srgb(hex): return tuple(int(hex[i:i+2],16)/255 for i in (1,3,5))
def lin(c): return c/12.92 if c<=.04045 else ((c+.055)/1.055)**2.4
def linear(hex): return tuple(lin(c) for c in srgb(hex))
def bv(p): return (p[0], -p[2], p[1])

def image(name, rgb, data=False):
    h,w=rgb.shape[:2]
    rgba=np.ones((h,w,4),np.float32);rgba[:,:,:3]=rgb
    img=bpy.data.images.new(name,width=w,height=h,alpha=False)
    img.colorspace_settings.name='Non-Color' if data else 'sRGB'
    img.pixels.foreach_set(rgba.ravel());img.file_format='PNG' if data else 'JPEG'
    img.filepath_raw=str(TEX/(name+('.png' if data else '.jpg')))
    img.save();img.pack();return img

# Low amplitude, physically scaled enamel orange-peel, dust, and fine machining.
# These maps are procedural originals, not generated photographs.
N=256
yy,xx=np.mgrid[:N,:N]/N
grain=rng.normal(0,1,(N,N))
cloud=(np.sin(xx*TAU*3+np.sin(yy*TAU*2)) + np.sin(yy*TAU*4+xx*TAU))*.5
fine=np.clip(.98+grain*.008+cloud*.008,.92,1)
height=grain*.0009
dx=(np.roll(height,-1,1)-np.roll(height,1,1))*1.2
dy=(np.roll(height,-1,0)-np.roll(height,1,0))*1.2
normal=np.stack((-dx,-dy,np.ones_like(dx)),axis=-1)
normal/=np.linalg.norm(normal,axis=2,keepdims=True)
paint_normal=image('Vehicle_EnamelMicroNormal',normal*.5+.5,True)
tire_height=(np.sin(xx*TAU*42)*.0015+grain*.001)
tdx=(np.roll(tire_height,-1,1)-np.roll(tire_height,1,1))*6
tdy=(np.roll(tire_height,-1,0)-np.roll(tire_height,1,0))*6
tire_normal=image('Vehicle_RubberMicroNormal',np.stack((-tdx,-tdy,np.ones_like(tdx)),axis=-1)*.5+.5,True)

def material(key, tint, rough, metallic=0, paint=False, rubber=False, emission=0):
    m=bpy.data.materials.new('Vehicle_'+key);m.use_nodes=True;m.diffuse_color=(*linear(tint),1)
    m.use_backface_culling=True
    bs=m.node_tree.nodes.get('Principled BSDF')
    bs.inputs['Base Color'].default_value=(*linear(tint),1)
    bs.inputs['Roughness'].default_value=rough;bs.inputs['Metallic'].default_value=metallic
    if paint:
        rgb=np.clip(np.array(srgb(tint))[None,None,:]*fine[:,:,None],0,1)
        img=image('Vehicle_'+key+'_Albedo',rgb)
        node=m.node_tree.nodes.new('ShaderNodeTexImage');node.image=img
        m.node_tree.links.new(node.outputs['Color'],bs.inputs['Base Color'])
        r=np.clip(rough+cloud*.022+np.abs(grain)*.005,0,1)
        orm=image('Vehicle_'+key+'_ORM',np.stack((np.ones_like(r),r,np.full_like(r,metallic)),axis=-1),True)
        tex=m.node_tree.nodes.new('ShaderNodeTexImage');tex.image=orm
        sep=m.node_tree.nodes.new('ShaderNodeSeparateColor');m.node_tree.links.new(tex.outputs['Color'],sep.inputs['Color'])
        m.node_tree.links.new(sep.outputs['Green'],bs.inputs['Roughness'])
        m.node_tree.links.new(sep.outputs['Blue'],bs.inputs['Metallic'])
        bs.inputs['Coat Weight'].default_value=.24;bs.inputs['Coat Roughness'].default_value=.22
    if paint or rubber:
        tex=m.node_tree.nodes.new('ShaderNodeTexImage');tex.image=paint_normal if paint else tire_normal
        nm=m.node_tree.nodes.new('ShaderNodeNormalMap');nm.inputs['Strength'].default_value=.6 if paint else .55
        m.node_tree.links.new(tex.outputs['Color'],nm.inputs['Color']);m.node_tree.links.new(nm.outputs['Normal'],bs.inputs['Normal'])
    if emission:
        bs.inputs['Emission Color'].default_value=(*linear(tint),1);bs.inputs['Emission Strength'].default_value=emission
    m['provenance']='Original procedural material authored for the local Kannon Arena graphics experiment.'
    return m

M={
 'bus':material('SchoolYellow_Enamel','#E7AB23',.34,.12,paint=True),
 'south':material('SeaGreen_Metallic','#397E78',.29,.48,paint=True),
 'north':material('Champagne_Metallic','#AD8C4F',.31,.43,paint=True),
 'rubber':material('TireRubber','#171C1D',.91,rubber=True),
 'trim':material('BlackPolymer','#20292B',.64),
 'glass':material('TintedAutomotiveGlass','#253E4A',.125,.18),
 'chrome':material('BrushedAluminium','#A9B1B3',.23,.9),
 'steel':material('WheelSteel','#576266',.43,.78),
 'recess':material('DeepRecess','#101719',.98),
 'red':material('RedLens','#9C1113',.22,.05),
 'amber':material('AmberLens','#C45A07',.23,.03),
 'lamp':material('HeadlampGlass','#BFCED0',.16,.18),
 'dust':material('RoadDust','#6E6756',.94),
}
M['glass']['glassApproximation']='Opaque tinted PBR glass: environment reflection, no transmission or alpha sorting.'
batches=defaultdict(lambda:{'v':[],'f':[],'uv':[],'smooth':[],'parts':[]})
current='bus'
transforms={ 'bus':lambda p:(-2.4+p[2],p[1],-4.4+((-4.824+(p[0]+4.824)*.96) if p[0]<-4.824 else p[0])),
             'south':lambda p:(-3.9+p[0],p[1],16.2+p[2]),
             'north':lambda p:(4-p[0],p[1],-17.4-p[2]) }

def add(key, verts, faces, smooth=True, uvs=None, part=''):
    b=batches[(current,key)];offset=len(b['v'])
    b['v'].extend(bv(transforms[current](p)) for p in verts)
    # Bus length/width axes are swapped in its world transform (a reflection).
    # Reverse its face order to retain the authored outward-facing normals.
    b['f'].extend(tuple(offset+i for i in (reversed(face) if current=='bus' else face)) for face in faces)
    b['smooth'].extend([smooth]*len(faces))
    b['uv'].extend(uvs or [(p[0],p[1]+p[2]*.37) for p in verts])
    if part:b['parts'].append((part,offset,len(verts)))

def panel(key, points, part=''):
    normal=(Vector(points[1])-Vector(points[0])).cross(Vector(points[2])-Vector(points[0]))
    axis=max(range(3),key=lambda i:abs(normal[i]))
    center=sum((Vector(p) for p in points),Vector())/len(points)
    expected=center[axis]-(.9 if axis==1 else 0)
    face=tuple(range(len(points)))
    if normal[axis]*expected<0:face=tuple(reversed(face))
    add(key,points,[face],False,part=part)

def grid(key, rows, smooth=True, part='',outward=(0,1,0)):
    n=len(rows[0]);v=[p for row in rows for p in row]
    f=[(r*n+i,r*n+i+1,(r+1)*n+i+1,(r+1)*n+i) for r in range(len(rows)-1) for i in range(n-1)]
    expected=Vector(outward)
    normals=[(Vector(v[face[1]])-Vector(v[face[0]])).cross(Vector(v[face[-1]])-Vector(v[face[0]])) for face in f]
    if sum(normal.dot(expected) for normal in normals)<0:f=[tuple(reversed(face)) for face in f]
    add(key,v,f,smooth,part=part)

def rounded_rect(hl,hw,r,segments=3):
    r=min(r,hl*.8,hw*.8)
    return [(cx+math.cos(a)*r,cz+math.sin(a)*r)
            for cx,cz,a0 in [(hl-r,hw-r,0),(-hl+r,hw-r,math.pi/2),(-hl+r,-hw+r,math.pi),(hl-r,-hw+r,math.pi*1.5)]
            for a in [a0+i*(math.pi/2)/segments for i in range(segments+1)]]

def box(key,c,size,bevel=.025,part='',segments=1):
    l,y,w=c;hl,hy,hw=(s*.5 for s in size);b=min(bevel,hy*.49,hl*.4,hw*.4)
    rings=[]
    for yy,shrink in [(-hy,b),(-hy+b,0),(hy-b,0),(hy,b)]:
        rings.append([(l+u,y+yy,w+v) for u,v in rounded_rect(hl-shrink,hw-shrink,max(b-shrink*.5,.001),segments)])
    count=len(rings[0]);v=[p for r in rings for p in r]
    f=[(j*count+i,j*count+(i+1)%count,(j+1)*count+(i+1)%count,(j+1)*count+i) for j in range(3) for i in range(count)]
    f += [tuple(reversed(range(count))),tuple(range(3*count,4*count))]
    add(key,v,[tuple(reversed(face)) for face in f],True,part=part)

def tube(key,pts,r,segments=7,closed=False,part=''):
    points=[Vector(p) for p in pts];rings=[]
    for i,p in enumerate(points):
        prev=points[(i-1)%len(points)] if i>0 or closed else points[0]
        nex=points[(i+1)%len(points)] if i<len(points)-1 or closed else points[-1]
        t=(nex-prev).normalized();a=t.cross(Vector((0,1,0)))
        if a.length<.01:a=t.cross(Vector((0,0,1)))
        a.normalize();b=t.cross(a).normalized()
        rings.append([tuple(p+r*(a*math.cos(j*TAU/segments)+b*math.sin(j*TAU/segments))) for j in range(segments)])
    vs=[p for ring in rings for p in ring];f=[]
    for i in range(len(rings) if closed else len(rings)-1):
        for j in range(segments):f.append((i*segments+j,i*segments+(j+1)%segments,((i+1)%len(rings))*segments+(j+1)%segments,((i+1)%len(rings))*segments+j))
    if not closed:f.extend([tuple(reversed(range(segments))),tuple(range((len(rings)-1)*segments,len(rings)*segments))])
    add(key,vs,f,True,part=part)

def lathe(key,center,profile,segments=40,axis='w',part='',flip=False):
    l,y,w=center;v=[];uv=[];rings=[];f=[]
    for r,a in profile:
        ring=[]
        for j in range(1 if r==0 else segments+1):
            t=j*TAU/segments;ring.append(len(v))
            v.append((l+math.cos(t)*r,y+math.sin(t)*r,w+a) if axis=='w' else (l+a,y+math.sin(t)*r,w+math.cos(t)*r))
            uv.append((j/segments,a+r))
        rings.append(ring)
    for a,b in zip(rings,rings[1:]):
        for j in range(segments):
            if len(a)==1:f.append((a[0],b[j+1],b[j]))
            elif len(b)==1:f.append((a[j],a[j+1],b[0]))
            else:f.append((a[j],a[j+1],b[j+1],b[j]))
    if (axis=='l')!=flip:f=[tuple(reversed(face)) for face in f]
    add(key,v,f,True,uv,part)

def disc(key,c,r,depth,axis='w',segments=24,part=''):
    segments=min(segments,6 if r<.031 else 12 if r<.115 else segments)
    profile=[(0,-depth/2),(r,-depth/2),(r,depth/2),(0,depth/2)] if r<.115 or key in ['recess','steel'] else [(0,-depth/2),(r*.95,-depth/2),(r,-depth*.3),(r,depth*.3),(r*.95,depth/2),(0,depth/2)]
    lathe(key,c,profile,segments,axis,part)

def wheel(l,y,w,r,bus=False):
    side=1 if w>0 else -1;half=.16 if bus else .118
    profile=[(.50*r,-half*.91),(.75*r,-half),(r*.92,-half),(r*.99,-half*.65),(r,-half*.36),(r,half*.36),(r*.99,half*.65),(r*.92,half),(.75*r,half),(.50*r,half*.91)]
    lathe('rubber',(l,y,w),profile,40,part='Rounded tire carcass')
    # Raised shoulder ribs and a real narrow central tread groove.
    for a in [-half*.79,half*.79]:
        lathe('rubber',(l,y,w),[(r*.926,a-.009),(r*.941,a),(r*.926,a+.009)],40)
    for j in range(24):
        a=j*TAU/24
        for row in [-1,1]:
            pts=[]
            for dt,ax in [(-.024,row*half*.12),(.017,row*half*.71)]:
                pts.append((l+math.cos(a+dt)*(r+.002),y+math.sin(a+dt)*(r+.002),w+ax))
            tube('trim',pts,.009 if bus else .0065,4,part='Tread sipes')
    face=w+side*(half+.003)
    rr=r*.62
    lathe('chrome' if not bus else 'steel',(l,y,face),[(rr*.99,-side*.014),(rr,0),(rr*.93,side*.016),(rr*.80,side*.018),(rr*.76,-side*.023),(0,-side*.023)],40,part='Dished wheel rim',flip=side<0)
    disc('recess',(l,y,face+side*.017),rr*.72,.012,segments=32)
    disc('steel',(l,y,face+side*.025),rr*.64,.012,segments=32,part='Brake rotor')
    if not bus:
        # Five paired tapered spokes, modeled rather than painted.
        for j in range(5):
            a=j*TAU/5
            for delta in [-.09,.09]:
                p=[]
                for rad,ang in [(rr*.27,a+delta-.09),(rr*.91,a+delta-.025),(rr*.91,a+delta+.025),(rr*.27,a+delta+.09)]:
                    p.append((l+math.cos(ang)*rad,y+math.sin(ang)*rad,face+side*.042))
                panel('chrome',p,'Twin-spoke alloy')
    else:
        disc('steel',(l,y,face+side*.036),rr*.76,.016,segments=32)
        for j in range(8):
            a=j*TAU/8
            disc('recess',(l+math.cos(a)*rr*.61,y+math.sin(a)*rr*.61,face+side*.047),rr*.105,.008,segments=10)
    disc('chrome',(l,y,face+side*.05),rr*.28,.031,segments=24,part='Wheel hub')
    for j in range(6 if bus else 5):
        a=j*TAU/(6 if bus else 5)
        disc('chrome',(l+math.cos(a)*rr*.35,y+math.sin(a)*rr*.35,face+side*.05),.025 if bus else .016,.022,segments=6)

def opening(l,centers,r,cy,base):
    result=base
    for c in centers:
        d=abs(l-c)
        if d<r:result=max(result,cy+math.sqrt(max(0,r*r-d*d)))
    return result

def arch_samples(start,end,centers,r,cy,base,step):
    samples=list(np.arange(start,end,step))+[end]
    for c in centers:
        # Vertical portions connect the semicircle cleanly to the lower sill.
        samples.extend([c-r-.002,c-r,c+r,c+r+.002])
        samples.extend(c+r*math.cos(a) for a in np.linspace(0,math.pi,25))
    return sorted(set(round(float(l),6) for l in samples if start<=l<=end))

def body_side(key,ls,upper,width,centers,r,cy,base,side,bus=False):
    rows=[]
    for l in ls:
        lo=opening(l,centers,r,cy,base);hi=upper(l)
        if not bus:lo=max(lo,.30+.205*max(0,(abs(l)-1.93)/.345))
        rows.append([(l,lo+(hi-lo)*t,side*(width(l)-(.045 if bus else .075)*(1-t)**2+.012*math.sin(math.pi*t))) for t in [0,.13,.32,.72,1]])
    grid(key,rows,part='Formed body side with open wheel arches',outward=(0,0,side))
    # Deep wheel-house surface follows each aperture, with no box behind tire.
    for center in centers:
        rows=[]
        for a in np.linspace(0,math.pi,33):
            l=center+r*math.cos(a);y=cy+r*math.sin(a)
            rows.append([(l,y,side*(width(l)-.02)),(l,y,side*(width(l)-.28))])
        grid('recess',rows,part='Wheel-well liner',outward=(0,-1,0))
        pts=[(center+r*math.cos(a),cy+r*math.sin(a),side*(width(center+r*math.cos(a))+.008)) for a in np.linspace(0,math.pi,33)]
        tube(key,pts,.026 if bus else .023,7,part='Rolled fender lip')

def window(points,seal=.027,chrome=False):
    panel('glass',points,'Inset tinted glazing')
    tube('trim',points,seal,7,True,'Window rubber seal')
    if chrome:
        center=sum((Vector(p) for p in points),Vector())/len(points)
        outer=[tuple(center+(Vector(p)-center)*1.045) for p in points]
        tube('chrome',outer,seal*.4,5,True,'Window brightwork')

def car(name):
    global current
    current=name;key=name
    centers=[-1.47,1.45];r=.473;cy=.448;base=.30
    ls=arch_samples(-2.275,2.275,centers,r,cy,base,.13)
    width=lambda l:.98-.105*(abs(l)/2.275)**5
    top=lambda l:1.075-.125*(abs(l)/2.275)**4
    def side_width(l,y):
        lo=max(opening(l,centers,r,cy,base),.30+.205*max(0,(abs(l)-1.93)/.345))
        t=max(0,min(1,(y-lo)/(top(l)-lo)))
        return width(l)-.075*(1-t)**2+.012*math.sin(math.pi*t)
    def deck_height(l,w):
        return top(l)+float(np.interp(abs(w),[0,.61,width(l)-.06,width(l)],[.060,.053,.037,0]))
    for side in [-1,1]:
        body_side(key,ls,top,width,centers,r,cy,base,side)
        # Fender shoulders have a bulged outer crease and crowned deck surface.
        rows=[]
        for l in ls:rows.append([(l,top(l),side*width(l)),(l,top(l)+.037,side*(width(l)-.06)),(l,top(l)+.053,side*.61),(l,top(l)+.060,0)])
        grid(key,rows,part='Crowned hood, deck and fender shoulders')
        # Door shut-lines follow the side curvature, black within a fine rolled edge.
        for l0 in [-.95,.10,1.03]:
            if abs(l0)>1:bottom=.92
            else:bottom=.37
            tube('recess',[(l0,float(y),side*(side_width(l0,float(y))+.007)) for y in np.linspace(bottom,1.06,13)],.005,4,part='Door panel gap')
        tube('trim',[(-.92,.353,side*.925),(.89,.353,side*.927)],.018,6,part='Rocker trim')
        tube('chrome',[(float(l),deck_height(float(l),.88)+.009,side*.88) for l in np.linspace(-1.18,1.16,13)],.007,5,part='Beltline bright strip')
        # Recessed, body-integrated handles at normal human scale.
        for l in [-.64,.47]:
            box('recess',(l,.983,side*(width(l)+.003)),(.20,.048,.012),.009,part='Handle recess',segments=1)
            box('chrome',(l,.992,side*(width(l)+.012)),(.15,.021,.025),.008,part='Door handle',segments=1)
        # A shaped greenhouse: raked A and C pillars, not a rectangular cabin.
        sidepoints=[(-1.20,1.119,side*.860),(-.73,1.630,side*.702),(.57,1.640,side*.705),(1.19,1.121,side*.861)]
        # Pillar backing follows glass edges; pane divisions expose painted pillars.
        panel(key,sidepoints,'Cabin side outline')
        window([(-1.085,1.150,side*.855),(-.709,1.589,side*.726),(-.185,1.604,side*.726),(-.182,1.153,side*.855)],.024,True)
        window([(-.086,1.154,side*.855),(-.086,1.605,side*.726),(.539,1.604,side*.726),(1.060,1.154,side*.855)],.024,True)
        tube('trim',[(-.14,1.143,side*.864),(-.14,1.615,side*.734)],.028,6,part='B pillar')
        # Small quarter-panel fuel door, stamped rather than sticker-flat.
        if side<0:
            tube('recess',[(-1.89,.84,side*.933),(-1.63,.855,side*.963),(-1.63,1.025,side*.968),(-1.89,1.005,side*.94)],.005,4,True,'Fuel flap seam')
        # Compact mirrors fold inward to preserve the exact collision union.
        box('trim',(.83,1.215,side*.854),(.19,.11,.073),.027,part='Folded mirror housing')
        box('glass',(.811,1.225,side*.891),(.13,.065,.01),.005,part='Mirror glass',segments=1)
        for l in centers:wheel(l,cy,side*.818,.438)
    # Curved roof, with longitudinal and crosswise crown.
    rows=[]
    for l in np.linspace(-.78,.62,13):
        row=[]
        for w in np.linspace(-.713,.713,17):
            row.append((float(l),1.637+.061*(1-(w/.713)**2)-.014*((l+.08)/.70)**2,float(w)))
        rows.append(row)
    grid(key,rows,part='Compound-curved metal roof')
    # Windshield and rear window curve in width and connect to the upper hood.
    for front in [True,False]:
        upper_l,lower_l,upper_y=(.59,1.188,1.622) if front else (-.755,-1.185,1.613)
        rows=[]
        for t in np.linspace(0,1,7):
            row=[]
            for u in np.linspace(-1,1,19):
                l=upper_l+(lower_l-upper_l)*t+.028*(1-u*u)
                y=upper_y+(1.127-upper_y)*t+.027*(1-u*u)
                row.append((float(l),float(y),float(u*(.709+(.854-.709)*t))))
            rows.append(row)
        grid('glass',rows,part='Curved laminated windshield' if front else 'Curved rear glass',outward=(1 if front else -1,.5,0))
        border=[*rows[0],*[row[-1] for row in rows[1:]],*reversed(rows[-1][:-1]),*[row[0] for row in reversed(rows[1:-1])]]
        tube('trim',border,.022,6,True,'Windscreen gasket')
        # Hairline defroster geometry is intentionally omitted: at gameplay
        # resolution those sub-pixel wires alias into dots on the rear glass.
    for side in [-1,1]:
        tube('trim',[(1.171,1.141,side*.34),(1.029,1.245,side*.09),(1.050,1.241,side*.48)],.012,6,part='Windshield wiper')
    # Front fascia: shaped valance, physical grille opening and lamp assemblies.
    box(key,(2.242,.678,0),(.143,.485,1.790),.067,part='Rounded front fascia')
    box('trim',(2.317,.564,0),(.035,.157,1.64),.013,part='Bumper polymer insert')
    box('recess',(2.321,.829,0),(.022,.234,.888),.012,part='Recessed radiator grille')
    for y in [.752,.800,.848,.896]:box('chrome',(2.335,y,0),(.014,.013,.845),.004,segments=1)
    for side in [-1,1]:
        box('chrome',(2.305,.879,side*.660),(.039,.205,.384),.026,part='Headlamp bezel')
        box('lamp',(2.329,.881,side*.657),(.019,.154,.315),.02,part='Headlamp lens')
        for j in [-1,0,1]:
            box('chrome',(2.341,.881,side*.657+j*.077),(.008,.12,.006),.001,segments=1)
        box('amber',(2.307,.738,side*.734),(.035,.057,.155),.012,part='Indicator')
        box('recess',(2.308,.521,side*.602),(.025,.088,.178),.016,part='Fog light surround')
        box('lamp',(2.324,.525,side*.602),(.012,.045,.119),.009,segments=1)
    # Hood shut line and crisp pressed creases create a manufactured panel read.
    for side in [-1,1]:
        tube('recess',[(float(l),deck_height(float(l),float(w))+.007,side*float(w)) for l,w in zip(np.linspace(1.223,2.205,17),np.linspace(.707,.639,17))],.004,4,part='Hood panel gap')
        tube(key,[(float(l),deck_height(float(l),float(w))+.005,side*float(w)) for l,w in zip(np.linspace(1.26,2.16,17),np.linspace(.44,.40,17))],.007,5,part='Hood press line')
    # Rear bumper, split colored lamps, license inset, subtle exhaust.
    box(key,(-2.245,.681,0),(.147,.455,1.790),.066,part='Rounded rear fascia')
    box('trim',(-2.322,.55,0),(.035,.135,1.653),.014,part='Rear bumper insert')
    box('recess',(-2.322,.77,0),(.026,.151,.431),.008,part='License recess')
    box('chrome',(-2.338,.772,0),(.008,.108,.332),.003,segments=1)
    for side in [-1,1]:
        box('trim',(-2.315,.887,side*.638),(.034,.196,.460),.022,part='Tail lamp surround')
        box('red',(-2.337,.910,side*.638),(.017,.107,.395),.010,part='Red tail lens')
        box('amber',(-2.337,.845,side*.761),(.017,.044,.144),.007,segments=1)
        box('lamp',(-2.337,.845,side*.563),(.017,.044,.162),.007,segments=1)
    disc('steel',(-2.205,.319,-.61),.054,.20,'l',20,'Exhaust tip')
    disc('recess',(-2.307,.319,-.61),.042,.012,'l',20)
    box('recess',(0,.292,0),(3.4,.055,1.26),.012,part='Undercarriage')
    # Restrained small scuffs confined to lower bumper; no exaggerated rust.
    for side in [-1,1]:
        for j in range(3):
            tube('dust',[(-2.323,.54+j*.018,side*(.60+j*.042)),(-2.328,.544+j*.018,side*(.69+j*.03))],.0028,4)

# Small custom 5x7 block glyphs are authored here, avoiding font dependencies.
FONT={
 'S':['01111','10000','10000','01110','00001','00001','11110'],
 'C':['01111','10000','10000','10000','10000','10000','01111'],
 'H':['10001','10001','10001','11111','10001','10001','10001'],
 'O':['01110','10001','10001','10001','10001','10001','01110'],
 'L':['10000','10000','10000','10000','10000','10000','11111'],
 'B':['11110','10001','10001','11110','10001','10001','11110'],
 'U':['10001','10001','10001','10001','10001','10001','01110'],
 '8':['01110','10001','10001','01110','10001','10001','01110'],
 '2':['01110','10001','00001','00110','01000','10000','11111'],
 ' ':['00000']*7,
}
def label(text,l,y,w,width,front=True):
    px=width/(len(text)*6-1)
    for char_i,ch in enumerate(text):
        for row,line in enumerate(FONT[ch]):
            # Coalesce contiguous lit pixels into one face, saving geometry.
            start=None
            for col in range(6):
                on=col<5 and line[col]=='1'
                if on and start is None:start=col
                if not on and start is not None:
                    a=-width/2+(char_i*6+start)*px;b=-width/2+(char_i*6+col)*px
                    yy=y+(3.5-row)*px
                    sign=-1 if front else 1
                    panel('trim',[(l,yy,w+sign*a),(l,yy-px*.92,w+sign*a),(l,yy-px*.92,w+sign*b),(l,yy,w+sign*b)],'Original block lettering')
                    start=None

def school_bus():
    global current
    current='bus';key='bus'
    centers=[-3.2,3.57];r=.636;cy=.797;base=.414
    ls=arch_samples(-4.82,4.81,centers,r,cy,base,.17)
    width=lambda l:1.406-.055*(abs(l)/4.83)**12
    top=lambda l:1.638
    # School-bus lower body: stamped panels with genuine fender openings.
    for side in [-1,1]:
        body_side(key,ls,top,width,centers,r,cy,base,side,True)
        for l in centers:wheel(l,cy,side*1.193,.620,True)
        box('recess',(0,.419,side*1.12),(8.95,.095,.18),.022,part='Chassis rail')
        # Three protective rub rails wrap the rounded side shell. The lower rail
        # naturally rises out of the wheel aperture rather than bridging it.
        for y in [.90,1.21,1.55]:
            for a,b in [(-4.72,-3.9),(-2.51,2.86),(4.24,4.73)]:
                if y<1.45:
                    tube('trim',[(float(l),y,side*(width(float(l))+.025)) for l in np.linspace(a,b,12)],.033,7,part='Protective rub rail')
            if y>1.45:tube('trim',[(float(l),y,side*(width(float(l))+.025)) for l in np.linspace(-4.73,4.73,32)],.030,7)
        # Window rails and curved body pillars. No opaque yellow slab behind glass.
        tube(key,[(-4.79,1.683,side*1.398),(4.79,1.683,side*1.398)],.065,8,part='Window sill')
        tube(key,[(-4.77,2.613,side*1.313),(4.76,2.613,side*1.313)],.073,8,part='Roof eave')
        # Eight school bus passenger windows, separated into actual framed panes.
        bounds=[(-3.73+i*1.02,-2.82+i*1.02) for i in range(8)]
        for a,b in bounds:
            points=[(a,1.739,side*1.391),(a,2.543,side*1.322),(b,2.543,side*1.322),(b,1.739,side*1.391)]
            window(points,.035)
            tube('chrome',[(a+.025,2.181,side*1.359),(b-.025,2.181,side*1.359)],.012,6,part='Sliding sash divider')
            # Slim vertical painted posts between the individual glass openings.
            box(key,(b+.045,2.163,side*1.358),(.09,.99,.125),.022,part='Structural window pillar')
            # Separate dark vertical seat-back cues add depth through dark glass.
        # Continuous formed metal occupies only the gaps between panes. The
        # windshield-side corner, driver's mullion and rear quarter panel must
        # also be closed; the glass is deliberately opaque in this experiment.
        solid_spans=[(-4.815,-4.695),(-3.933,-3.73),(4.32,4.815)]
        solid_spans += [(bounds[i][1],bounds[i+1][0]) for i in range(len(bounds)-1)]
        for a,b in solid_spans:
            panel(key,[(a,1.66,side*1.397),(a,2.614,side*1.316),(b,2.614,side*1.316),(b,1.66,side*1.397)],'Solid window mullion / corner panel')
        # Driver's side window; opposite side has full-height folding entry door.
        if side<0:
            window([(-4.695,1.75,side*1.382),(-4.695,2.545,side*1.316),(-3.933,2.545,side*1.316),(-3.933,1.75,side*1.382)],.033)
            box(key,(-4.812,2.145,side*1.34),(.08,.99,.13),.022,part='Front corner pillar')
        else:
            # Door is integrated in body, with four glass sections and tread steps.
            box('trim',(-4.302,1.500,1.376),(.879,1.987,.041),.025,part='Folding entry door recess')
            for a,b in [(-4.684,-4.323),(-4.271,-3.930)]:
                window([(a,1.624,1.409),(a,2.503,1.335),(b,2.503,1.335),(b,1.624,1.409)],.022)
                window([(a,.713,1.409),(a,1.524,1.409),(b,1.524,1.409),(b,.713,1.409)],.022)
            for y in [.579,.656]:tube('chrome',[(-4.67,y,1.414),(-3.933,y,1.414)],.015,5)
        # Belt-mounted reflectors and a subtle row of rivets catch grazing light.
        for l in [-4.59,-2.35,1.75,4.63]:
            disc('amber' if l<2 else 'red',(l,1.33,side*(width(l)+.014)),.048,.025,segments=16)
        for l in np.arange(-4.57,4.64,.43):
            disc('steel',(float(l),1.681,side*1.423),.011,.014,segments=6)
        # Service hatches with narrow true seams below the passenger windows.
        for l in [-1.60,.10,1.80]:
            hatch=[]
            for x,ys in [(l-.68,np.linspace(.485,1.463,7)),(l+.68,np.linspace(1.463,.485,7))]:
                for y in ys:
                    t=(y-base)/(1.638-base)
                    w=width(x)-.045*(1-t)**2+.012*math.sin(math.pi*t)+.011
                    hatch.append((x,float(y),side*w))
            tube('recess',hatch,.004,4,True,'Luggage panel seam')
        # Mudflaps are tucked behind wheels and remain above the collision floor.
        for l in centers:box('rubber',(l+.61,.423,side*1.204),(.034,.39,.335),.010,part='Mud flap',segments=1)
    # Domed compound roof: long pressed-sheet shell with turned end corners.
    rows=[]
    for l in np.linspace(-4.815,4.815,49):
        round_end=max(0,(abs(l)-4.58)/.235)
        row=[]
        for a in np.linspace(-math.pi/2,math.pi/2,29):
            w=math.sin(a)*(1.323-.07*round_end)
            y=2.593+math.cos(a)*(.381-.075*round_end)
            row.append((float(l),float(y),float(w)))
        rows.append(row)
    grid(key,rows,part='Continuous domed school-bus roof')
    for l in [-4.28,-3.11,-1.94,-.77,.40,1.57,2.74,3.91]:
        pts=[(l,2.602+math.cos(a)*.380,math.sin(a)*1.326) for a in np.linspace(-math.pi/2,math.pi/2,25)]
        tube(key,pts,.011,5,part='Subtle roof pressed rib')
    # End caps, including a curved top sign band rather than a box roof.
    for l in [-4.819,4.819]:
        points=[(l,.485,-1.310),(l,1.60,-1.353),(l,2.593,-1.253)]
        points += [(l,2.593+math.cos(a)*.306,math.sin(a)*1.253) for a in np.linspace(-math.pi/2,math.pi/2,25)]
        points += [(l,1.60,1.353),(l,.485,1.310)]
        panel(key,points,'Curved front/rear end cap')
    # Two-piece windscreen with recessed black gasket and real metal divider.
    for side in [-1,1]:
        lo,hi=sorted([side*.066,side*1.174])
        window([(-4.845,1.780,lo),(-4.845,2.495,lo),(-4.845,2.495,hi*.978),(-4.845,1.780,hi)],.031)
        tube('trim',[(-4.875,1.786,side*.71),(-4.876,2.05,side*.45),(-4.876,2.07,side*.90)],.017,6,part='Bus windshield wiper')
    label('SCHOOL BUS',-4.847,2.750,0,1.380)
    # Compact mirror arms stay within the body union; no hidden collision changes.
    for side in [-1,1]:
        tube('steel',[(-4.69,1.99,side*1.35),(-4.76,2.00,side*1.464),(-4.76,2.23,side*1.464)],.019,7,part='Mirror support')
        box('trim',(-4.745,2.18,side*1.464),(.17,.27,.055),.022,part='Bus mirror housing')
        box('glass',(-4.748,2.183,side*1.494),(.127,.216,.007),.009,part='Bus mirror face',segments=1)
    # Hood: tapered plan, crowned top, angular side fenders. It is its own lower
    # collision box, so y<=1.45 and half-width<=1.4 beyond the cabin front.
    hls=np.linspace(-6.444,-4.824,19)
    rows=[]
    for l in hls:
        t=(l+6.444)/1.62;hw=1.142+.136*t;h=1.225+.113*t
        rows.append([(float(l),h+.064*(1-u*u),float(u*hw)) for u in np.linspace(-1,1,19)])
    grid(key,rows,part='Crowned tapered engine hood')
    for side in [-1,1]:
        rows=[]
        for l in hls:
            t=(l+6.444)/1.62;hw=1.142+.136*t;h=1.225+.113*t
            rows.append([(float(l),.50,side*(hw-.06)),(float(l),.81,side*(hw+.022)),(float(l),h,side*hw)])
        grid(key,rows,part='Rounded hood side panel',outward=(0,0,side))
        hood_seam=[]
        for l,w in zip(np.linspace(-6.22,-5.08,17),np.linspace(.81,.98,17)):
            t=(l+6.444)/1.62;hw=1.142+.136*t
            hood_seam.append((float(l),float(1.225+.113*t+.064*(1-(w/hw)**2)+.007),side*float(w)))
        tube('recess',hood_seam,.004,4,part='Hood separation seam')
        # Vent slits have actual recessed dark surfaces and raised louver edges.
        for l in np.linspace(-5.86,-5.00,9):
            t=(l+6.444)/1.62;hw=1.142+.136*t
            box('recess',(float(l),.954,side*(hw+.013)),(.044,.235,.020),.008,segments=1)
        box('steel',(-4.999,1.016,side*1.285),(.055,.163,.027),.006,part='Hood latch',segments=1)
    # Upright nose with inset radiator grille, chrome surround and circular lamps.
    box(key,(-6.444,.855,0),(.092,.70,2.264),.043,part='School bus nose')
    box('chrome',(-6.499,.870,0),(.025,.640,1.35),.023,part='Radiator bright surround')
    box('recess',(-6.514,.877,0),(.018,.563,1.215),.014,part='Radiator dark core')
    for y in np.linspace(.637,1.117,10):box('chrome',(-6.526,float(y),0),(.014,.017,1.192),.004,segments=1)
    for w in [-.89,.89]:
        disc('chrome',(-6.497,1.044,w),.190,.030,'l',32,'Headlamp chrome bezel')
        disc('lamp',(-6.523,1.044,w),.150,.023,'l',32,'Round headlamp lens')
        for off in [-.065,0,.065]:
            tube('chrome',[(-6.538,.939,w+off),(-6.538,1.15,w+off)],.0035,4)
        disc('amber',(-6.502,.742,w),.066,.033,'l',20,'Front turn signal')
    box('trim',(-6.424,.457,0),(.140,.191,2.587),.045,part='Heavy front bumper')
    tube('steel',[(-6.500,.483,-1.196),(-6.500,.483,1.196)],.012,5)
    # Rear emergency door and lamps, all inside z<=0.5.
    box(key,(4.814,1.045,0),(.105,1.48,2.63),.04,part='Rounded rear lower cap')
    tube('recess',[(4.874,.596,-.505),(4.874,2.49,-.505),(4.874,2.49,.505),(4.874,.596,.505)],.011,6,True,'Rear emergency door seam')
    window([(4.860,1.800,-.424),(4.860,2.429,-.424),(4.860,2.429,.424),(4.860,1.800,.424)],.025)
    for side in [-1,1]:
        window([(4.850,1.806,side*.612),(4.850,2.41,side*.612),(4.850,2.41,side*1.139),(4.850,1.806,side*1.202)],.027)
        for y,key2,rr in [(1.48,'red',.104),(1.22,'amber',.087),(.949,'red',.085)]:
            disc('trim',(4.869,y,side*1.104),rr+.014,.022,'l',24)
            disc(key2,(4.886,y,side*1.104),rr,.020,'l',24)
    label('SCHOOL BUS',4.854,2.750,0,1.380,False)
    box('trim',(4.81,.479,0),(.155,.23,2.805),.043,part='Rear steel bumper')
    box('chrome',(4.877,1.330,0),(.014,.033,.227),.008,part='Emergency door handle',segments=1)
    # Warning flashers sit in black recesses, with refractive-looking raised lenses.
    for l in [-4.845,4.848]:
        for w,key2 in [(-1.035,'red'),(-.779,'amber'),(.779,'amber'),(1.035,'red')]:
            disc('trim',(l,2.659,w),.111,.014,'l',24)
            disc(key2,(l+(-.012 if l<0 else .012),2.659,w),.086,.019,'l',24)
    for w in [-.68,0,.68]:
        box('trim',(-4.756,2.900,w),(.12,.055,.168),.018,part='Roof marker base')
        box('amber',(-4.762,2.926,w),(.102,.023,.129),.009,part='Amber clearance lamp')
    # Little dust in lower seams and a few isolated bumper scuffs keep the bus used
    # but maintained. These marks are a small geometry budget, not broad dirt noise.
    for side in [-1,1]:
        for i in range(10):
            l=-2.40+i*.49
            tube('dust',[(l,.442,side*1.369),(l+.18,.446,side*1.374)],.0038,4)
    box('recess',(0,.427,0),(9.1,.17,1.90),.025,part='Bus underframe')

school_bus();car('south');car('north')

# The strict gameplay envelopes are validated against every output vertex.
ENVELOPES={
 'bus':[(-3.9,-.9,.16,3.,-9.3,.5),(-3.8,-1.,.35,1.45,-10.9,-9.3)],
 'south':[(-6.25,-1.55,0,1.3,15.175,17.225),(-5.175,-2.625,1.02,1.74,15.3,17.1)],
 'north':[(1.65,6.35,0,1.3,-18.425,-16.375),(2.725,5.275,1.02,1.74,-18.3,-16.5)],
}
def world(p):return (p[0],p[2],-p[1])
violations=[]
for (vehicle,key),b in batches.items():
    for v in b['v']:
        x,y,z=world(v)
        if not any(x0-1e-5<=x<=x1+1e-5 and y0-1e-5<=y<=y1+1e-5 and z0-1e-5<=z<=z1+1e-5 for x0,x1,y0,y1,z0,z1 in ENVELOPES[vehicle]):
            violations.append((vehicle,key,tuple(round(n,5) for n in (x,y,z))))
if violations:
    print('VIOLATION_SUMMARY',json.dumps({str(k):{'count':len(v),'min':[min(p[i] for p in v) for i in range(3)],'max':[max(p[i] for p in v) for i in range(3)]} for k,v in [(k,[p for name,key,p in violations if (name,key)==k]) for k in sorted(set((name,key) for name,key,p in violations))]}))
assert not violations, 'Collision envelope violations: '+json.dumps(violations[:30])+' count='+str(len(violations))

parents={};meshes=[];triangles=0;summary={}
for vehicle in ['bus','south','north']:
    parent=bpy.data.objects.new('Vehicle_'+vehicle,None);bpy.context.collection.objects.link(parent);parents[vehicle]=parent
    parent['source']='Original procedural Blender model; generate_vehicles.py'
    parent['collisionContract']='Every vertex stays within union of the existing vehicle collision boxes.'
    summary[vehicle]={'triangles':0,'drawCalls':0,'vertices':0,'bounds':None}
for (vehicle,key),b in batches.items():
    mesh=bpy.data.meshes.new('Vehicle_'+vehicle+'_'+key)
    mesh.from_pydata(b['v'],[],b['f']);mesh.update()
    obj=bpy.data.objects.new(mesh.name,mesh);bpy.context.collection.objects.link(obj);obj.parent=parents[vehicle]
    mesh.materials.append(M[key]);uv=mesh.uv_layers.new(name='UVMap')
    for polygon,smooth in zip(mesh.polygons,b['smooth']):
        polygon.use_smooth=smooth
        for loop in polygon.loop_indices:uv.data[loop].uv=b['uv'][mesh.loops[loop].vertex_index]
    # Original semantic parts remain addressable as vertex groups in the editable
    # source while sharing one GPU batch per vehicle/material in the browser.
    names=defaultdict(list)
    for part,start,count in b['parts']:names[part].extend(range(start,start+count))
    for part,indices in names.items():obj.vertex_groups.new(name=part).add(indices,1,'REPLACE')
    # Geometry is explicitly outward wound, allowing default single-sided
    # shadow casting without inward-face shadow acne on formed body surfaces.
    mesh.materials[0].use_backface_culling=True
    mesh.calc_loop_triangles();n=len(mesh.loop_triangles);triangles+=n
    summary[vehicle]['triangles']+=n;summary[vehicle]['drawCalls']+=1;summary[vehicle]['vertices']+=len(mesh.vertices)
    meshes.append(obj)
for vehicle in summary:
    v=[world(p) for (name,key),b in batches.items() if name==vehicle for p in b['v']]
    summary[vehicle]['bounds']={'min':[min(p[i] for p in v) for i in range(3)],'max':[max(p[i] for p in v) for i in range(3)]}
print('TOPOLOGY',triangles,json.dumps(summary))
assert triangles<=80000,triangles

for obj in bpy.context.selected_objects:obj.select_set(False)
for obj in [*meshes,*parents.values()]:obj.select_set(True)
out=ROOT/'public/models/vehicles-improved.glb'
bpy.ops.export_scene.gltf(filepath=str(out),export_format='GLB',use_selection=True,export_apply=True,
    export_yup=True,export_extras=True,export_animations=False,export_cameras=False,export_lights=False,
    export_normals=True,export_texcoords=True,export_materials='EXPORT',export_image_format='AUTO')
assert out.stat().st_size<=3_000_000,out.stat().st_size

# A neutral source-only preview rig. Blender renders are never gameplay proof.
scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=32
scene.world.use_nodes=True;scene.world.node_tree.nodes.get('Background').inputs['Color'].default_value=(.32,.45,.62,1)
scene.world.node_tree.nodes.get('Background').inputs['Strength'].default_value=.75
sun_data=bpy.data.lights.new('BlenderPreview_Sun','SUN');sun_data.energy=3.8
sun=bpy.data.objects.new('BlenderPreview_Sun',sun_data);bpy.context.collection.objects.link(sun);sun.rotation_euler=(.45,-.6,-.75)
camera_data=bpy.data.cameras.new('BlenderPreview_Camera');camera=bpy.data.objects.new('BlenderPreview_Camera',camera_data);bpy.context.collection.objects.link(camera);scene.camera=camera;camera_data.lens=45
camera.location=bv((-9,5,-15));camera.rotation_euler=(Vector(bv((-2.4,1.45,-5)))-camera.location).to_track_quat('-Z','Y').to_euler()
scene.render.resolution_x=1600;scene.render.resolution_y=1000;scene.render.resolution_percentage=100;scene.view_settings.view_transform='AgX'
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE/'vehicle-test.blend'))
manifest={
 'name':'Kannon Town isolated three-vehicle graphics test',
 'generator':'scripts/blender/generate_vehicles.py','source':'art/source/vehicle-test.blend',
 'export':'public/models/vehicles-improved.glb','blenderVersion':bpy.app.version_string,
 'bytes':out.stat().st_size,'sha256':hashlib.sha256(out.read_bytes()).hexdigest(),
 'triangles':triangles,'materialBatches':len(meshes),'materials':len(M),'vehicles':summary,
 'collisionEnvelopeViolations':len(violations),'mapSha256':hashlib.sha256((ROOT/'shared/map.ts').read_bytes()).hexdigest(),
 'textures':[{'path':str(p.relative_to(ROOT)).replace('\\','/'),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(TEX.iterdir()) if p.is_file()],
 'provenance':{'geometry':'Original parametric mesh authored for this repository. No borrowed vehicle brands, models or scans.',
 'materials':'Original seeded NumPy enamel/dust/roughness/normal maps. No images, photos, AI images, or third-party textures.',
 'lettering':'Original five-by-seven block glyphs defined in generator. No external fonts.',
 'license':'Project-owned original work; no additional third-party asset licenses or fees. Blender is the authoring tool only.',
 'runtimeGlass':'Opaque tinted physically based glass with environment reflection; no transmission, alpha blending, or interior rendering.'},
 'notes':['Actual apertures, liners, and rolled fender lips surround tires.','Original unchanged collision boxes remain authoritative; shaped corners and wheel wells create cosmetic inset space.',
 'Vehicles have compact folded mirrors to satisfy original collision widths.','Shared maps are embedded in GLB; source textures are not separately downloaded by gameplay.',
 'Vertex groups retain semantic authored components in the editable Blender source.','Outward face winding and single-sided materials avoid inward-face self-shadow artifacts.']}
(SOURCE/'vehicle-test-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
if os.environ.get('KANNON_VEHICLE_BLENDER_PREVIEW')=='1':
    scene.render.filepath=str(SOURCE/'vehicle-test-BLENDER-preview.png');bpy.ops.render.render(write_still=True)
print('KANNON_VEHICLE_EXPORT',json.dumps(manifest))
