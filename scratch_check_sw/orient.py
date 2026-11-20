import json, numpy as np, sys
def cKDTree(P):
  class K:
    def query(s,Q): 
      import numpy as np; d=np.array([np.min(np.hypot(*(P-q).T)) for q in Q]); return d,None
  return K()
S=sys.argv[1]; T=np.load(S+'/T.npy')
ch=json.load(open(S+'/chains.json')); sh=json.load(open('1_results/shapes.json'))['shapes']
allp=np.array([q for c in ch for q in c['pts']]); tree=cKDTree(allp)
pts=np.array([q for a in sh for q in a['points_pt']])
W,H=842,1191
cands={'y,x':lambda x,y:(y,x),'H-y,x':lambda x,y:(H-y,x),'y,W-x':lambda x,y:(y,W-x),'H-y,W-x':lambda x,y:(H-y,W-x),'x,y':lambda x,y:(x,y),'x,H-y':lambda x,y:(x,H-y)}
for n,f in cands.items():
  u=np.array([f(*p) for p in pts]); D=np.c_[u,np.ones(len(u))]@T
  dd,_=tree.query(D); print(n, np.median(dd).round(1), (dd<20).mean().round(2))
import collections
f=cands['H-y,x']; u=np.array([f(*p) for p in pts]); D=np.c_[u,np.ones(len(u))]@T
v=collections.Counter()
for q in D[::3]:
  d=np.hypot(*(allp-q).T); 
  for j in np.where(d<1500)[0]: v[tuple(np.round((allp[j]-q)/10).astype(int))]+=1
print(v.most_common(5))
