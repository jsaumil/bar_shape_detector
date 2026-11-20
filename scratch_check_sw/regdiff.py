import json, sys, os, glob
A,B=sys.argv[1],sys.argv[2]
for d in sorted(glob.glob(A+'/*/shapes.json')):
  n=d.split('/')[-2]; e=os.path.join(B,n,'shapes.json')
  if not os.path.exists(e): print(n,'MISSING in dev'); continue
  a=json.load(open(d)); b=json.load(open(e))
  if a['shapes']==b['shapes']: print(f'{n}: identical ({len(a["shapes"])})'); continue
  key=lambda s:(s['page'],tuple(tuple(round(v,1) for v in p) for p in s['points_pt']))
  ka={key(s):s for s in a['shapes']}; kb={key(s):s for s in b['shapes']}
  same=[k for k in ka if k in kb]
  dl=[kb[k]['true_length_mm']-ka[k]['true_length_mm'] for k in same]
  ch=[x for x in dl if abs(x)>0.05]
  sa=[p.get('mm_per_pt') for p in a['pages']]; sb=[p.get('mm_per_pt') for p in b['pages']]
  print(f'{n}: base {len(ka)} dev {len(kb)}; same geometry {len(same)}, length changed {len(ch)} (max {max(map(abs,ch)) if ch else 0:.1f}); only base {len(ka)-len(same)}, only dev {len(kb)-len(same)}; scale {sa} -> {sb}')
  if '-v' in sys.argv:
    for k in ka:
      if k not in kb: s=ka[k]; print('   -', s['tag'], s['shape'], s['true_length_mm'], s['points_pt'][:3])
    for k in kb:
      if k not in ka: s=kb[k]; print('   +', s['tag'], s['shape'], s['true_length_mm'], s['points_pt'][:3])
