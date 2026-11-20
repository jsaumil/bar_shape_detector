import csv, numpy as np, json, sys, collections
sh={a['tag']:a for a in json.load(open(sys.argv[2]))['shapes']}
r=list(csv.DictReader(open(sys.argv[1])))
r=[x for x in r if x['layer']!='REINF.HATCH.']
print(collections.Counter(x['status'] for x in r))
ok=[x for x in r if x['status']=='ok']
same=[];legs=[]
for x in ok:
  nd=x['dwg_pieces'].count('L'); nf=len(sh[x['finder_tags']]['segments_mm'])
  (same if nd==nf else legs).append(x)
for name,g in (('same shape',same),('shape differs',legs)):
  if not g: continue
  d=np.array([float(x['diff_mm']) for x in g]); print(name,len(g),'mean abs',abs(d).mean().round(1),'median',np.median(abs(d)).round(1),'max',abs(d).max().round(1), [(t,int((abs(d)<=t).sum())) for t in (2,5,10,20,50)])
if len(sys.argv)>3:
  for x in r:
    if x['status']!='ok' or x in legs or abs(float(x['diff_mm']))>15: print(x['dwg_chain'],x['layer'],x['dwg_pieces'],x['dwg_mm'],x['finder_tags'],x['finder_shape'],x['finder_mm'],x['diff_mm'],x['status'])
