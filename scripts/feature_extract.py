import os, json, math
from PIL import Image
import numpy as np

ROOT = r"C:\Users\hp\Desktop\IntentLens\datasets\staging\ElectroCom61 A Multiclass Dataset for Detection of Electronic Components\ElectroCom61"
CROPS_META = r"C:\Users\hp\Desktop\IntentLens\datasets\processed\crops_v1\crop_metadata.jsonl"
SCALER = json.load(open(r"C:\Users\hp\Desktop\IntentLens\datasets\processed\feature_scaler.json"))
OUT = r"C:\Users\hp\Desktop\IntentLens\datasets\processed\features_v1"
os.makedirs(OUT, exist_ok=True)
FEAT_JSONL = os.path.join(OUT, "train_features.jsonl")
CHECKPOINT = os.path.join(OUT, "feat_checkpoint.json")

names = json.load(open(r"C:\Users\hp\Desktop\IntentLens\class_map.json")) if os.path.exists(r"C:\Users\hp\Desktop\IntentLens\class_map.json") else None

# load class map from data.yaml names order (same as extraction)
class_names = ['1-5-Volt-Battery','3-3-Volt-Battery','7-Segment-Display','9-Volt-Battery','Arduino-Mega','Arduino-Nano','Arduino-Uno','BJT-Transistor','Bluetooth-Module','Breadboard','Bridge-Rectifier','Buck-Converter','Buzzer','Capacitor-10mf','Capacitor-470mf','DC-Motor','Diode','ESP32','ESP32-CAM','FT-232-USB-Serial-Module','Film-Capacitor','Fuse','Fuse-Base','GSM-Module','Gas-Sensor','Heat-Sink','High-Voltage-Ceramic-Capacitor','Humidity-Sensor','IC-Base-14-Pin','IC-Base-28-Pin','IC-Chip','IGBT','IR-Sensor','Inductor','Keypad','LCD-Display','LDR-Sensor','LED-Light','Low-Voltage-Ceramic-Capacitor','MLC-Capacitor','MOSFET','Motion-Sensor','Motor-Driver','NTC-Thermistor','OLED-Display','Pin-Header','Push-Switch','RFID-Scanner','Raindrops-Module','Relay-Module','Resistor','Rocker-Switch','Servo-Motor','Soil-Moisture-Sensor','Sonar-Sensor','TCRT5000','Tact-Switch','Taper-Potentiometer','Trimmer-Potentiometer','Water-Sensor','Zener-Diode']

def uniform_map():
    m=[0]*256; idx=0
    for pattern in range(256):
        bits=[(pattern>>i)&1 for i in range(8)]
        trans=0
        for i in range(8):
            if bits[i]!=bits[(i+1)%8]: trans+=1
        if trans<=2:
            m[pattern]=idx; idx+=1
        else:
            m[pattern]=58
    return m
UNIFORM_MAP=uniform_map()
N_UNIFORM=59

def resize_region(arr, srcW, srcH, tW, tH):
    out=np.zeros((tH,tW,4),dtype=np.uint8)
    for y in range(tH):
        for x in range(tW):
            sx=min(srcW-1, int(x*srcW/tW))
            sy=min(srcH-1, int(y*srcH/tH))
            out[y,x]=arr[sy,sx]
    return out

def hsv_hist(region):
    bins=np.zeros(16)
    for i in range(0, region.shape[0]*region.shape[1]):
        r=region.flat[i*4]/255.0; g=region.flat[i*4+1]/255.0; b=region.flat[i*4+2]/255.0
        mx=max(r,g,b); mn=min(r,g,b); d=mx-mn
        hue=0.0
        if d>0:
            if mx==r: hue=((g-b)/d)%6
            elif mx==g: hue=(b-r)/d+2
            else: hue=(r-g)/d+4
            hue*=60
            if hue<0: hue+=360
        sat=0 if mx==0 else d/mx
        val=mx
        binv=int(hue/22.5)+int(sat*4)*6+int(val*4)
        bins[min(15, binv%16)]+=1
    total=bins.sum() or 1
    return (bins/total).tolist()

def to_binary(region):
    gray=0.299*region[:,:,0]+0.587*region[:,:,1]+0.114*region[:,:,2]
    mean=gray.mean()
    return (gray>mean).astype(int)

def hu_moments(region):
    w=region.shape[1]; h=region.shape[0]
    binary=to_binary(region)
    m00=float(binary.sum()); m10=0.0; m01=0.0
    for y in range(h):
        for x in range(w):
            v=binary[y,x]
            m10+=x*v; m01+=y*v
    cx=m10/m00 if m00 else 0
    cy=m01/m00 if m00 else 0
    mu20=mu02=mu11=mu30=mu03=mu21=mu12=0.0
    for y in range(h):
        for x in range(w):
            v=binary[y,x]
            dx=x-cx; dy=y-cy
            mu20+=dx*dx*v; mu02+=dy*dy*v; mu11+=dx*dy*v
            mu30+=dx*dx*dx*v; mu03+=dy*dy*dy*v
            mu21+=dx*dx*dy*v; mu12+=dx*dy*dy*v
    norm=m00 or 1
    n20=mu20/norm; n02=mu02/norm; n11=mu11/norm
    n30=mu30/norm; n03=mu03/norm; n21=mu21/norm; n12=mu12/norm
    hu=[
     n20+n02,
     (n20-n02)**2+4*n11*n11,
     (n30-3*n12)**2+(3*n21-n03)**2,
     (n30+n12)**2+(n21+n03)**2,
     (n30-3*n12)*(n30+n12)*((n30+n12)**2-3*(n21+n03)**2)+(3*n21-n03)*(n21+n03)*(3*(n30+n12)**2-(n21+n03)**2),
     (n20-n02)*((n30+n12)**2-(n21+n03)**2)+4*n11*(n30+n12)*(n21+n03),
     (3*n21-n03)*(n30+n12)*((n30+n12)**2-3*(n21+n03)**2)-(n30-3*n12)*(n21+n03)*(3*(n30+n12)**2-(n21+n03)**2),
    ]
    eps=1e-10
    return [-math.copysign(1,v)*math.log10(abs(v)+eps) for v in hu]

def hog_cells(region):
    w=region.shape[1]; h=region.shape[0]
    cell=8; bins=9
    cellsX=max(1,w//cell); cellsY=max(1,h//cell)
    cellHists=[]
    for cy in range(cellsY):
        for cx in range(cellsX):
            hist=np.zeros(bins)
            for y in range(cy*cell, min((cy+1)*cell, h-1)):
                for x in range(cx*cell, min((cx+1)*cell, w-1)):
                    gx=int(region[y,x+1,0])-int(region[y,x-1,0]) if False else None
            # simpler: use grayscale
            # recompute properly
            hist2=np.zeros(bins)
            for y in range(cy*cell, min((cy+1)*cell, h-1)):
                for x in range(cx*cell, min((cx+1)*cell, w-1)):
                    # grayscale values
                    def gv(yy,xx):
                        return 0.299*region[yy,xx,0]+0.587*region[yy,xx,1]+0.114*region[yy,xx,2]
                    gx=gv(y,x+1)-gv(y,x-1)
                    gy=gv(y+1,x)-gv(y-1,x)
                    mag=math.hypot(gx,gy)
                    ang=math.degrees(math.atan2(gy,gx))
                    if ang<0: ang+=180
                    binv=int(ang/20)
                    hist2[min(bins-1,binv)]+=mag
            tot=hist2.sum() or 1
            cellHists.append(hist2/tot)
    out=[]
    for by in range(cellsY-1):
        for bx in range(cellsX-1):
            block=[]
            for dy in range(2):
                for dx in range(2):
                    ci=(by+dy)*cellsX+(bx+dx)
                    if ci < len(cellHists):
                        block.extend(cellHists[ci].tolist())
            arr=np.array(block)
            norm=math.sqrt((arr*arr).sum())+1e-6
            normalized=arr/norm
            clipped=np.clip(normalized,None,0.2)
            norm2=math.sqrt((clipped*clipped).sum())+1e-6
            out.extend((clipped/norm2).tolist())
    if not out:
        out=[0.0]*36
    return out

def spatial_lbp(region, gridX, gridY):
    w=region.shape[1]; h=region.shape[0]
    cellW=w//gridX; cellH=h//gridY
    result=[]
    for gy in range(gridY):
        for gx in range(gridX):
            xStart=gx*cellW; xEnd=w if gx==gridX-1 else (gx+1)*cellW
            yStart=gy*cellH; yEnd=h if gy==gridY-1 else (gy+1)*cellH
            hist=np.zeros(N_UNIFORM)
            for y in range(yStart, yEnd):
                for x in range(xStart, xEnd):
                    if y==0 or y==h-1 or x==0 or x==w-1: continue
                    center=0.299*region[y,x,0]+0.587*region[y,x,1]+0.114*region[y,x,2]
                    neighbors=[(-1,-1),(0,-1),(1,-1),(1,0),(1,1),(0,1),(-1,1),(-1,0)]
                    pattern=0
                    for ni,(dx,dy) in enumerate(neighbors):
                        nx=x+dx; ny=y+dy
                        nval=0.299*region[ny,nx,0]+0.587*region[ny,nx,1]+0.114*region[ny,nx,2]
                        if nval>=center:
                            pattern|=(1<<ni)
                    hist[UNIFORM_MAP[pattern]]+=1
            total=hist.sum() or 1
            result.extend((hist/total).tolist())
    while len(result)<236: result.append(0.0)
    return result[:236]

def extract_features(crop_path, box_dummy=None):
    im=Image.open(crop_path).convert("RGB")
    arr=np.array(im)  # HxWx3
    # build imageData-like with alpha
    H,W=arr.shape[0],arr.shape[1]
    rgba=np.zeros((H,W,4),dtype=np.uint8)
    rgba[:,:,:3]=arr; rgba[:,:,3]=255
    # extractRegion assumes normalized box; here crop already cropped, use full image box
    region=rgba  # full
    resized=resize_region(region, W, H, 64, 64)
    features=[]
    # aspect ratio/area from original box -> use crop dims
    features.append(W/max(H,1e-6))
    features.append(W*H)
    features.extend(hsv_hist(resized))
    features.extend(hu_moments(resized))
    features.extend(hog_cells(resized))
    # shape descriptors
    area=64*64
    fg=0
    for i in range(0, resized.size, 4):
        if resized.flat[i]+resized.flat[i+1]+resized.flat[i+2] > 128:
            fg+=1
    solidity=fg/max(1,area)
    extent=area/max(1, resized.size//4)
    features.extend([solidity, extent])
    features.extend(spatial_lbp(resized,2,2))
    if len(features)!=2027:
        raise ValueError(f"dim {len(features)}")
    # standardize
    mean=np.array(SCALER['mean']); std=np.array(SCALER['std'])
    scaled=[(v-mean[i])/(std[i]+1e-6) for i,v in enumerate(features)]
    for v in scaled:
        if not math.isfinite(v):
            raise ValueError("non-finite")
    return scaled

# resume
done=set()
if os.path.exists(CHECKPOINT):
    done=set(json.load(open(CHECKPOINT))['done'])

meta_lines=open(CROPS_META).read().splitlines()
recs=[json.loads(l) for l in meta_lines]

# only train split for reference DB
train_recs=[r for r in recs if r['split']=='train']

# limit for time: process up to 500 new
LIMIT=500
processed=0
f=open(FEAT_JSONL,'a')
for r in train_recs:
    if processed>=LIMIT: break
    key=r['crop_file']
    if key in done: 
        continue
    crop_path=os.path.join(r'C:\Users\hp\Desktop\IntentLens\datasets\processed\crops_v1', r['crop_file'])
    try:
        fv=extract_features(crop_path)
    except Exception as e:
        print('ERR', r['crop_file'], e); continue
    rec={'crop_file':r['crop_file'],'class_id':r['class_id'],'class_name':r['class_name'],'split':r['split'],'features':fv}
    f.write(json.dumps(rec)+'\n'); f.flush()
    done.add(key); processed+=1
    if processed%50==0:
        json.dump({'done':sorted(done)}, open(CHECKPOINT,'w'))
        print('processed', processed)
f.close()
json.dump({'done':sorted(done)}, open(CHECKPOINT,'w'))
print('total processed this run', processed, 'done total', len(done))
