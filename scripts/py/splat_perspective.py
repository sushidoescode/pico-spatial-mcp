#!/usr/bin/env python3
"""Headless PERSPECTIVE renderer for a Gaussian-splat .ply/.spz — projects gaussian centers as
colored points via numpy (no GL). Used to give an agent/detector recognizable views of a splat
so objects can be labeled (the SEMANTIC layer). Painter's algorithm + z-test."""
import sys, struct, math, gzip, json
import numpy as np
from PIL import Image
C0 = 0.28209479177387814

def log(*a): print("[PERSP]", *a, file=sys.stderr); sys.stderr.flush()

def parse_ply(path, max_pts):
    with open(path,'rb') as f:
        header=b""
        while b"end_header\n" not in header:
            chunk=f.read(256)
            if not chunk: raise ValueError("not a binary PLY: missing end_header")
            header+=chunk
        he=header.index(b"end_header\n")+len(b"end_header\n"); f.seek(he)
        htxt=header[:he].decode('latin1')
        n=int([l for l in htxt.splitlines() if l.startswith("element vertex")][0].split()[-1])
        props=[l.split()[-1] for l in htxt.splitlines() if l.startswith("property float")]
        dt=np.dtype([(p,'<f4') for p in props])
        data=np.frombuffer(f.read(n*dt.itemsize),dtype=dt,count=n)
    pos=np.stack([data['x'],data['y'],data['z']],1).astype(np.float32)
    if 'f_dc_0' in props:
        rgb=np.clip(0.5+C0*np.stack([data['f_dc_0'],data['f_dc_1'],data['f_dc_2']],1),0,1)
    else:
        rgb=np.full((n,3),0.6,np.float32)
    op=1/(1+np.exp(-data['opacity'])) if 'opacity' in props else np.ones(n)
    keep=op>0.10
    pos,rgb=pos[keep],rgb[keep]
    if len(pos)>max_pts:
        s=np.random.RandomState(0).choice(len(pos),max_pts,replace=False); pos,rgb=pos[s],rgb[s]
    return pos,rgb

def look_at(C,T,up=(0,1,0)):
    f=np.array(T,np.float32)-np.array(C,np.float32); f/=np.linalg.norm(f)+1e-9
    r=np.cross(f,np.array(up,np.float32)); r/=np.linalg.norm(r)+1e-9
    u=np.cross(r,f)
    return f,r,u

def render(pos,rgb,C,T,W=640,H=640,fov=70.0,psize=2,bg=(8,8,12),focal_px=None,cx=None,cy=None):
    C=np.array(C,np.float32)
    f,r,u=look_at(C,T)
    v=pos-C
    zc=v@f; xc=v@r; yc=v@u
    m=zc>0.05
    zc,xc,yc,col=zc[m],xc[m],yc[m],rgb[m]
    focal=(W/2)/math.tan(math.radians(fov)/2) if focal_px is None else float(focal_px)
    principal_x=W/2 if cx is None else float(cx); principal_y=H/2 if cy is None else float(cy)
    px=(principal_x+focal*xc/zc).astype(np.int32); py=(principal_y-focal*yc/zc).astype(np.int32)
    inb=(px>=0)&(px<W)&(py>=0)&(py<H)
    px,py,zc,col=px[inb],py[inb],zc[inb],col[inb]
    order=np.argsort(-zc)  # far -> near (painter)
    px,py,col=px[order],py[order],col[order]
    img=np.zeros((H,W,3),np.uint8); img[:]=bg
    c8=(col*255).astype(np.uint8)
    for dx in range(-psize,psize+1):
        for dy in range(-psize,psize+1):
            xx=np.clip(px+dx,0,W-1); yy=np.clip(py+dy,0,H-1)
            img[yy,xx]=c8
    return img,int(len(px))

def project_box(center,size,C,T,W,H,fov,focal_px=None,principal_cx=None,principal_cy=None):
    """project an axis-aligned 3D box's 8 corners -> 2D bbox (for labeling overlays)."""
    center_x,center_y,center_z=center; sx,sy,sz=[s/2 for s in size]
    corners=np.array([[center_x+i*sx,center_y+j*sy,center_z+k*sz] for i in(-1,1) for j in(-1,1) for k in(-1,1)],np.float32)
    C=np.array(C,np.float32); f,r,u=look_at(C,T)
    v=corners-C; zc=v@f
    if (zc<=0.05).all(): return None
    xc=v@r; yc=v@u; focal=(W/2)/math.tan(math.radians(fov)/2) if focal_px is None else float(focal_px)
    principal_x=W/2 if principal_cx is None else float(principal_cx); principal_y=H/2 if principal_cy is None else float(principal_cy)
    zc=np.clip(zc,0.05,None)
    px=principal_x+focal*xc/zc; py=principal_y-focal*yc/zc
    return [int(px.min()),int(py.min()),int(px.max()),int(py.max())]

def draw_boxes(img, clusters, C, T, W, H, fov, focal_px=None, cx=None, cy=None):
    """draw each cluster's projected 2D bbox + id onto the rendered view; return which ids are visible."""
    from PIL import ImageDraw, ImageFont
    pil=Image.fromarray(img); d=ImageDraw.Draw(pil)
    try: font=ImageFont.load_default()
    except Exception: font=None
    vis=[]
    palette=[(0,229,255),(255,62,165),(120,255,90),(255,196,60),(180,120,255),(255,120,80),(90,200,255),(255,255,120)]
    for c in clusters:
        b=project_box(c["center"],c["size"],C,T,W,H,fov,focal_px,cx,cy)
        if b is None: continue
        x0,y0,x1,y1=b
        # skip boxes essentially off-frame or covering the whole view (behind camera / huge)
        if x1<0 or y1<0 or x0>W or y0>H: continue
        if (x1-x0)>W*1.6 and (y1-y0)>H*1.6: continue
        col=palette[c["id"]%len(palette)]
        d.rectangle([max(0,x0),max(0,y0),min(W-1,x1),min(H-1,y1)],outline=col,width=3)
        lbl=f'#{c["id"]}'
        d.rectangle([max(0,x0),max(0,y0-14),max(0,x0)+22,max(0,y0)],fill=col)
        d.text((max(0,x0)+2,max(0,y0-13)),lbl,fill=(0,0,0),font=font)
        vis.append(c["id"])
    return np.asarray(pil),vis

if __name__=="__main__":
    cfg=json.loads(sys.argv[1])
    pos,rgb=parse_ply(cfg["splat"], cfg.get("maxPts",500000))
    lo,hi=np.percentile(pos,[2,98],axis=0)
    cen=pos[((pos>=lo)&(pos<=hi)).all(1)].mean(0)
    log("points",len(pos),"centroid",cen.round(2).tolist(),"bounds",lo.round(2).tolist(),hi.round(2).tolist())
    clusters=cfg.get("clusters",[])
    W,H,fov=cfg.get("W",640),cfg.get("H",640),cfg.get("fov",70)
    focal_px,cx,cy=cfg.get("f"),cfg.get("cx"),cfg.get("cy")
    save_clean=cfg.get("saveClean",False)  # unannotated copies + 2D boxes, for a headless detector (OWL-v2)
    emit_bgra=cfg.get("emitBgra",False)
    out=[]
    for view in cfg["views"]:
        img,points_rendered=render(pos,rgb,view["C"],view["T"],W,H,fov,focal_px=focal_px,cx=cx,cy=cy)
        clean=None; boxes2d={}
        if save_clean:
            stem=view["out"][:-4] if view["out"].endswith(".png") else view["out"]
            clean=stem+"-clean.png"
            Image.fromarray(img).save(clean)
            for c in clusters:
                b=project_box(c["center"],c["size"],view["C"],view["T"],W,H,fov,focal_px,cx,cy)
                if b is None: continue
                x0,y0,x1,y1=b
                if x1<0 or y1<0 or x0>W or y0>H: continue
                # for the MATCHER, drop boxes exploding past the frame in EITHER axis (a wall seen
                # edge-on clamps to a frame-spanning band that steals IoU matches); draw_boxes keeps
                # the looser AND since there it is only a visual overlay
                if (x1-x0)>W*1.6 or (y1-y0)>H*1.6: continue
                boxes2d[str(c["id"])]=[max(0,x0),max(0,y0),min(W-1,x1),min(H-1,y1)]
        vis=[]
        if clusters:
            img,vis=draw_boxes(img,clusters,view["C"],view["T"],W,H,fov,focal_px,cx,cy)
        Image.fromarray(img).save(view["out"])
        entry={"out":view["out"],"name":view.get("name"),"C":view["C"],"T":view["T"],"visibleIds":vis,"pointsRendered":points_rendered}
        if save_clean: entry["clean"]=clean; entry["boxes2d"]=boxes2d
        if emit_bgra and view.get("bgraOut"):
            # Same array the PNG encodes, so the raw sibling and the PNG are provably identical
            # pixels. RGB -> BGRA with an opaque alpha; C-contiguous, top row first, 4 bytes/px.
            if cfg.get("clusters"):
                raise SystemExit("emitBgra requires an unannotated frame: clusters must be empty")
            raw = np.dstack([img[:, :, ::-1], np.full(img.shape[:2], 255, np.uint8)]).tobytes()
            with open(view["bgraOut"], "wb") as handle:
                handle.write(raw)
            entry["bgraOut"] = view["bgraOut"]
            entry["bgraBytes"] = len(raw)
        out.append(entry)
    print(json.dumps({"points":len(pos),"centroid":cen.round(3).tolist(),"bounds":[lo.round(3).tolist(),hi.round(3).tolist()],"floorY":round(float(lo[1]),3),"views":out}))
