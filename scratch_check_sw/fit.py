import json, math, collections, sys
ch=json.load(open(sys.argv[1])); sh=json.load(open(sys.argv[2]))['shapes']
s=37.9041
def bb(pts): xs=[p[0] for p in pts]; ys=[p[1] for p in pts]; return min(xs),min(ys),max(xs),max(ys)
# vote offsets using long shapes: center of bbox
votes=collections.Counter()
for flip in (1,-1):
  for a in sh:
    if a['true_length_mm']<1500: continue
    b=bb(a['points_pt']); ca=((b[0]+b[2])/2*s, flip*(b[1]+b[3])/2*s); wa=(b[2]-b[0])*s; ha=(b[3]-b[1])*s
    for c in ch:
      if abs(c['L']-a['true_length_mm'])>150: continue
      d=bb(c['pts']); 
      if abs((d[2]-d[0])-wa)>100 or abs((d[3]-d[1])-ha)>100: continue
      cc=((d[0]+d[2])/2,(d[1]+d[3])/2)
      votes[(flip,round((cc[0]-ca[0])/50)*50,round((cc[1]-ca[1])/50)*50)]+=1
print(votes.most_common(8))
