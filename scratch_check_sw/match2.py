import json, numpy as np, sys, csv, collections
exec(open(sys.argv[1]+'/match.py').read().split('cb=[')[0].replace('S=sys.argv[1]','S="'+sys.argv[1]+'"'))
# page area in DWG
corners=np.array([tr(p) for p in [(0,0),(842,0),(0,1191),(842,1191)]]); lo,hi=corners.min(0),corners.max(0)
inpage=[i for i,c in enumerate(ch) if ((np.array(c['pts'])>=lo)&(np.array(c['pts'])<=hi)).all()]
cb={i:(np.min(np.array(ch[i]['pts']),0),np.max(np.array(ch[i]['pts']),0)) for i in inpage}
assign=collections.defaultdict(list); extra=[]
for a in sh:
  P=np.array([tr(p) for p in a['points_pt']]); Ps=sample(P); l,h=P.min(0)-100,P.max(0)+100
  best=None
  for i in inpage:
    if (cb[i][0]>h).any() or (cb[i][1]<l).any(): continue
    d=segdist(Ps,ch[i]['pts']); s=np.percentile(d,90)
    if best is None or s<best[0]: best=(s,i)
  if best and best[0]<40: assign[best[1]].append(a)
  else: extra.append((a['tag'],a['shape'],a['true_length_mm'], round(best[0]) if best else None))
rows=[]
for i in inpage:
  c=ch[i]; fs=assign.get(i,[]); fl=sum(a['true_length_mm'] for a in fs)
  kind=('MISSED' if not fs else 'ok' if len(fs)==1 else f'SPLIT into {len(fs)}')
  ctr=np.mean(np.array(c['pts']),0)
  rows.append(dict(dwg_chain=i,layer='/'.join(c['layers']),dwg_pieces='+'.join(t[0] for t in c['typs']),dwg_mm=round(c['L'],1),
    finder_tags=' '.join(a['tag'] for a in fs),finder_shape=' | '.join(a['shape'] for a in fs),beam=' '.join(sorted({a['beam'] or '' for a in fs})),
    finder_mm=' + '.join(str(a['true_length_mm']) for a in fs),finder_total=round(fl,1) if fs else '',diff_mm=round(fl-c['L'],1) if fs else '',status=kind,
    x=round(ctr[0]),y=round(ctr[1])))
w=csv.DictWriter(open(__import__('os').environ.get('OUTCSV',sys.argv[1]+'/compare2.csv'),'w'),fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
json.dump(extra,open(sys.argv[1]+'/extra.json','w'))
print(len(inpage),'DWG bars in page area;', len(extra),'finder shapes not on any DWG bar')
