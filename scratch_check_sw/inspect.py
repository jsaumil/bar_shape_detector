import ezdxf, sys, collections
doc = ezdxf.readfile(sys.argv[1])
msp = doc.modelspace()
c = collections.Counter((e.dxf.layer, e.dxftype()) for e in msp)
for k,v in sorted(c.items(), key=lambda x:-x[1])[:60]: print(v, k)
print("layouts", [l.name for l in doc.layouts])
for l in doc.layouts:
    if l.name!='Model':
        vps=[e for e in l if e.dxftype()=='VIEWPORT']
        for v in vps: print(l.name, v.dxf.center, v.dxf.width, v.dxf.height, v.dxf.view_center_point, v.dxf.view_height)
