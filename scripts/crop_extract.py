import os, json, hashlib
from PIL import Image

ROOT = r"C:\Users\hp\Desktop\IntentLens\datasets\staging\ElectroCom61 A Multiclass Dataset for Detection of Electronic Components\ElectroCom61"
OUT = r"C:\Users\hp\Desktop\IntentLens\datasets\processed\crops_v1"
os.makedirs(OUT, exist_ok=True)
names = ['1-5-Volt-Battery','3-3-Volt-Battery','7-Segment-Display','9-Volt-Battery','Arduino-Mega','Arduino-Nano','Arduino-Uno','BJT-Transistor','Bluetooth-Module','Breadboard','Bridge-Rectifier','Buck-Converter','Buzzer','Capacitor-10mf','Capacitor-470mf','DC-Motor','Diode','ESP32','ESP32-CAM','FT-232-USB-Serial-Module','Film-Capacitor','Fuse','Fuse-Base','GSM-Module','Gas-Sensor','Heat-Sink','High-Voltage-Ceramic-Capacitor','Humidity-Sensor','IC-Base-14-Pin','IC-Base-28-Pin','IC-Chip','IGBT','IR-Sensor','Inductor','Keypad','LCD-Display','LDR-Sensor','LED-Light','Low-Voltage-Ceramic-Capacitor','MLC-Capacitor','MOSFET','Motion-Sensor','Motor-Driver','NTC-Thermistor','OLED-Display','Pin-Header','Push-Switch','RFID-Scanner','Raindrops-Module','Relay-Module','Resistor','Rocker-Switch','Servo-Motor','Soil-Moisture-Sensor','Sonar-Sensor','TCRT5000','Tact-Switch','Taper-Potentiometer','Trimmer-Potentiometer','Water-Sensor','Zener-Diode']

meta_path = os.path.join(OUT, "crop_metadata.jsonl")
failed_path = os.path.join(OUT, "failed_crops.jsonl")
checkpoint_path = os.path.join(OUT, "checkpoint.json")

# resume
done = set()
if os.path.exists(checkpoint_path):
    done = set(json.load(open(checkpoint_path))["done"])

meta_f = open(meta_path, "a", encoding="utf-8")
failed_f = open(failed_path, "a", encoding="utf-8")

count_ok=0; count_fail=0; per_split={}; per_class={}
for split in ["train","valid","test"]:
    img_dir=os.path.join(ROOT, split if split!="valid" else "valid", "images")
    lbl_dir=os.path.join(ROOT, split if split!="valid" else "valid", "labels")
    if not os.path.isdir(img_dir):
        img_dir=os.path.join(ROOT, "val","images"); lbl_dir=os.path.join(ROOT,"val","labels")
    per_split[split]={"images":0,"crops":0,"failed":0}
    for img_name in sorted(os.listdir(img_dir)):
        if not img_name.lower().endswith((".jpg",".jpeg",".png")): continue
        per_split[split]["images"]+=1
        stem=os.path.splitext(img_name)[0]
        lbl_path=os.path.join(lbl_dir, stem+".txt")
        if not os.path.exists(lbl_path):
            continue
        try:
            im=Image.open(os.path.join(img_dir,img_name)).convert("RGB")
        except Exception as e:
            failed_f.write(json.dumps({"split":split,"image":img_name,"reason":"image_open_error","error":str(e)})+"\n"); failed_f.flush()
            count_fail+=1; per_split[split]["failed"]+=1
            continue
        W,H=im.size
        with open(lbl_path) as f:
            lines=[l.strip() for l in f if l.strip()]
        for ai,line in enumerate(lines):
            parts=line.split()
            if len(parts)<5:
                failed_f.write(json.dumps({"split":split,"image":img_name,"ann":ai,"reason":"bad_label_line"})+"\n"); failed_f.flush()
                count_fail+=1; per_split[split]["failed"]+=1
                continue
            try:
                cid=int(parts[0])
                xc=float(parts[1]); yc=float(parts[2]); bw=float(parts[3]); bh=float(parts[4])
            except Exception as e:
                failed_f.write(json.dumps({"split":split,"image":img_name,"ann":ai,"reason":"parse_error","error":str(e)})+"\n"); failed_f.flush()
                count_fail+=1; per_split[split]["failed"]+=1
                continue
            # normalized to absolute
            x1=(xc-bw/2)*W; y1=(yc-bh/2)*H; x2=(xc+bw/2)*W; y2=(yc+bh/2)*H
            # clip
            x1=max(0,min(W,x1)); y1=max(0,min(H,y1)); x2=max(0,min(W,x2)); y2=max(0,min(H,y2))
            if x2-x1 < 1 or y2-y1 < 1:
                failed_f.write(json.dumps({"split":split,"image":img_name,"ann":ai,"reason":"zero_area"})+"\n"); failed_f.flush()
                count_fail+=1; per_split[split]["failed"]+=1
                continue
            if cid<0 or cid>=len(names):
                failed_f.write(json.dumps({"split":split,"image":img_name,"ann":ai,"reason":"bad_class_id"})+"\n"); failed_f.flush()
                count_fail+=1; per_split[split]["failed"]+=1
                continue
            key=f"{split}/{img_name}/{ai}"
            if key in done:
                continue
            crop=im.crop((int(x1),int(y1),int(x2),int(y2)))
            crop_name=f"{split}_{stem}_ann{ai}_cls{cid}.jpg"
            crop_path=os.path.join(OUT, crop_name)
            # avoid overwrite existing verified
            if not os.path.exists(crop_path):
                crop.save(crop_path, "JPEG", quality=95)
            rec={
                "crop_file": crop_name,
                "source_image": img_name,
                "split": split,
                "annotation_id": ai,
                "class_id": cid,
                "class_name": names[cid],
                "bbox_norm": [xc,yc,bw,bh],
                "bbox_abs": [x1,y1,x2,y2],
                "crop_w": crop.width,
                "crop_h": crop.height,
            }
            meta_f.write(json.dumps(rec)+"\n"); meta_f.flush()
            done.add(key)
            count_ok+=1
            per_split[split]["crops"]+=1
            per_class[names[cid]]=per_class.get(names[cid],0)+1
        # checkpoint
        json.dump({"done":sorted(done)}, open(checkpoint_path,"w"))

meta_f.close(); failed_f.close()
report={
  "total_crops": count_ok,
  "total_failed": count_fail,
  "per_split": per_split,
  "num_classes": len(per_class),
  "per_class": per_class,
}
json.dump(report, open(os.path.join(OUT,"extraction_report.json"),"w"), indent=2)
print(json.dumps(report, indent=2))
