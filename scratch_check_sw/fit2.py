import fitz, re, ezdxf, json, numpy as np, sys
S=sys.argv[1]
d=fitz.open('pdf/smart_world/1.pdf'); p=d[0]
pw={}
for w in p.get_text('words'):
  m=re.match(r'(B\d+)\(',w[4])
  if m: pw.setdefault(m.group(1),[]).append(((w[0]+w[2])/2,(w[1]+w[3])/2))
x=ezdxf.readfile(S+'/sw.dxf')
dw={}
for e in x.modelspace():
  if e.dxftype()=='TEXT' and e.dxf.layer=='BEAM NO':
    m=re.match(r'(?:%%U)?(B\d+)\(',e.dxf.text)
    if m:
      b=e.bbox() if hasattr(e,'bbox') else None
      from ezdxf import bbox
      bx=bbox.extents([e]); dw.setdefault(m.group(1),[]).append(((bx.extmin.x+bx.extmax.x)/2,(bx.extmin.y+bx.extmax.y)/2))
A=[];B=[]
for k in pw:
  if k in dw and len(pw[k])==1 and len(dw[k])==1: A.append(pw[k][0]); B.append(dw[k][0])
A=np.array(A);B=np.array(B)
M=np.c_[A,np.ones(len(A))]
T,res,_,_=np.linalg.lstsq(M,B,rcond=None)
r=M@T-B; print(len(A),'labels; affine\n',T,'\nresid mm',np.round(np.hypot(*r.T),0))
np.save(S+'/T.npy',T)
