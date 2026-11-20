import ezdxf, sys, json, math, collections
from ezdxf import path as P
doc = ezdxf.readfile(sys.argv[1]); msp = doc.modelspace()
LAYERS = set(sys.argv[2].split(','))
TOL = 5.0
pieces = []  # (pts, length, layer)
def add(e):
    try: p = P.make_path(e)
    except Exception: return
    pts = [(v.x, v.y) for v in p.flattening(0.05)]
    if len(pts) < 2: return
    if e.dxftype()=='LINE': L = math.dist(pts[0], pts[-1])
    elif e.dxftype()=='ARC': L = math.radians((e.dxf.end_angle-e.dxf.start_angle)%360)*e.dxf.radius
    else: L = sum(math.dist(a,b) for a,b in zip(pts,pts[1:]))
    if e.dxftype()=='LWPOLYLINE' and e.closed: closed=True
    else: closed=False
    pieces.append(dict(pts=pts, L=L, layer=e.dxf.layer, closed=closed, typ=e.dxftype()))
for e in msp:
    if e.dxf.layer in LAYERS and e.dxftype() in ('LINE','ARC','LWPOLYLINE','POLYLINE'): add(e)
# dedupe
seen=set(); uniq=[]
for p in pieces:
    a=tuple(round(c) for xy in (p['pts'][0],p['pts'][-1]) for c in xy); k=(min(a[:2],a[2:]),max(a[:2],a[2:]),round(p['L']))
    if k in seen: continue
    seen.add(k); uniq.append(p)
pieces=[p for p in uniq if p['L']>0.5]
# chain: union endpoints within TOL, only for degree-2 nodes
ends=[]
for i,p in enumerate(pieces):
    if p['closed']: continue
    ends.append((i,0,p['pts'][0])); ends.append((i,1,p['pts'][-1]))
import itertools
grid=collections.defaultdict(list)
for k,(i,s,pt) in enumerate(ends): grid[(int(pt[0]//TOL),int(pt[1]//TOL))].append(k)
nbr=collections.defaultdict(list)
for k,(i,s,pt) in enumerate(ends):
    gx,gy=int(pt[0]//TOL),int(pt[1]//TOL)
    for dx in (-1,0,1):
        for dy in (-1,0,1):
            for k2 in grid[(gx+dx,gy+dy)]:
                if k2!=k and ends[k2][0]!=i and math.dist(pt,ends[k2][2])<=TOL: nbr[k].append(k2)
link={}
for k,v in nbr.items():
    if len(v)==1 and len(nbr[v[0]])==1: link[k]=v[0]
used=set(); chains=[]
def endkey(i,s): return 2*i+s if False else None
idx={(i,s):k for k,(i,s,_) in enumerate(ends)}
for i,p in enumerate(pieces):
    if i in used: continue
    if p['closed']:
        used.add(i); chains.append(dict(pieces=[i],pts=p['pts'],L=p['L'],layers=[p['layer']])); continue
    # walk back to start
    cur,s=i,0; visited={i}
    while True:
        k=idx[(cur,s)]
        if k not in link: break
        n=ends[link[k]]; 
        if n[0] in visited: break
        cur,s=n[0],1-n[1]; visited.add(cur)
    start,ss=cur,s  # ss = free end side
    order=[]; cur,free=start,ss; vis=set()
    while cur not in vis:
        vis.add(cur); order.append((cur, free==0))
        k=idx[(cur,1-free)]
        if k not in link: break
        n=ends[link[k]]; cur,free=n[0],n[1]
    pts=[]; L=0; lay=set()
    for j,fwd in order:
        q=pieces[j]['pts'] if fwd else pieces[j]['pts'][::-1]
        pts+=q; L+=pieces[j]['L']; lay.add(pieces[j]['layer']); used.add(j)
    chains.append(dict(pieces=[j for j,_ in order],pts=pts,L=L,layers=sorted(lay)))
for c in chains:
    c['typs']=[pieces[j]['typ'] for j in c['pieces']]
json.dump(chains, open(sys.argv[3],'w'))
print(len(pieces),'pieces',len(chains),'chains')
