import json, numpy as np, sys, csv
S=sys.argv[1]; T=np.load(S+'/T.npy'); OFF=np.array([180.,0.])
ch=json.load(open(S+'/chains.json')); sh=json.load(open(__import__('os').environ.get('SHAPES','1_results/shapes.json')))['shapes']
H=1191
def tr(p): return np.array([H-p[1],p[0],1.])@T+OFF
def segdist(P,Q):  # dist of points P to polyline Q
  Q=np.asarray(Q); a=Q[:-1]; b=Q[1:]; ab=b-a; L2=(ab**2).sum(1); L2[L2==0]=1e-9
  out=[]
  for p in P:
    t=np.clip(((p-a)*ab).sum(1)/L2,0,1); c=a+t[:,None]*ab; out.append(np.min(np.hypot(*(c-p).T)))
  return np.array(out)
def sample(Q,n=40):
  Q=np.asarray(Q); d=np.r_[0,np.cumsum(np.hypot(*np.diff(Q,axis=0).T))]
  if d[-1]==0: return Q[:1]
  s=np.linspace(0,d[-1],n); return np.c_[np.interp(s,d,Q[:,0]),np.interp(s,d,Q[:,1])]
cb=[(np.min(np.array(c['pts']),0),np.max(np.array(c['pts']),0)) for c in ch]
rows=[]; usedby={}
for a in sh:
  P=np.array([tr(p) for p in a['points_pt']]); lo,hi=P.min(0)-300,P.max(0)+300
  best=None
  for i,c in enumerate(ch):
    if (cb[i][0]>hi).any() or (cb[i][1]<lo).any(): continue
    s=np.mean(segdist(sample(P),c['pts']))+np.mean(segdist(sample(c['pts']),P))
    if best is None or s<best[0]: best=(s,i)
  if best and best[0]<80:
    c=ch[best[1]]; usedby.setdefault(best[1],[]).append(a['tag'])
    rows.append([a['tag'],a['beam'],a['shape'],a['true_length_mm'],round(c['L'],1),round(a['true_length_mm']-c['L'],1),round(best[0],1),best[1],'/'.join(c['layers'])])
  else: rows.append([a['tag'],a['beam'],a['shape'],a['true_length_mm'],'','', round(best[0],1) if best else '', '', 'NO DWG MATCH'])
w=csv.writer(open(S+'/compare.csv','w')); w.writerow(['tag','beam','shape','finder_mm','dwg_mm','diff_mm','fit_mm','chain','layer']); w.writerows(rows)
missed=[(i,c) for i,c in enumerate(ch) if i not in usedby]
json.dump([[i,round(c['L'],1),c['layers'],np.round(np.mean(c['pts'],0)).tolist()] for i,c in missed],open(S+'/missed.json','w'))
dup={k:v for k,v in usedby.items() if len(v)>1}
print('dup chains',dup)
