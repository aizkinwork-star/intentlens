import json, time, numpy as np
from collections import defaultdict

names=['1-5-Volt-Battery','3-3-Volt-Battery','7-Segment-Display','9-Volt-Battery','Arduino-Mega','Arduino-Nano','Arduino-Uno','BJT-Transistor','Bluetooth-Module','Breadboard','Bridge-Rectifier','Buck-Converter','Buzzer','Capacitor-10mf','Capacitor-470mf','DC-Motor','Diode','ESP32','ESP32-CAM','FT-232-USB-Serial-Module','Film-Capacitor','Fuse','Fuse-Base','GSM-Module','Gas-Sensor','Heat-Sink','High-Voltage-Ceramic-Capacitor','Humidity-Sensor','IC-Base-14-Pin','IC-Base-28-Pin','IC-Chip','IGBT','IR-Sensor','Inductor','Keypad','LCD-Display','LDR-Sensor','LED-Light','Low-Voltage-Ceramic-Capacitor','MLC-Capacitor','MOSFET','Motion-Sensor','Motor-Driver','NTC-Thermistor','OLED-Display','Pin-Header','Push-Switch','RFID-Scanner','Raindrops-Module','Relay-Module','Resistor','Rocker-Switch','Servo-Motor','Soil-Moisture-Sensor','Sonar-Sensor','TCRT5000','Tact-Switch','Taper-Potentiometer','Trimmer-Potentiometer','Water-Sensor','Zener-Diode']

valid=[json.loads(l) for l in open('C:/Users/hp/Desktop/IntentLens/datasets/processed/features_v1/valid_features.jsonl')]
byclass=defaultdict(list)
for r in valid: byclass[r['class_name']].append(r)
sample=[]
for c in names:
    sample.extend(byclass[c][:5])
print('sample size', len(sample))

def load_db(path):
    db=json.load(open(path))
    R=np.array([r['features'] for r in db['references']], dtype=np.float64)
    labels=[r['className'] for r in db['references']]
    return db,R,labels

def classify_batch(Q, R, labels):
    qn=np.sum(Q*Q, axis=1)[:,None]
    rn=np.sum(R*R, axis=1)[None,:]
    dists=np.sqrt(np.maximum(qn + rn - 2*(Q@R.T), 0))
    order=np.argsort(dists, axis=1)
    preds=[]
    for i in range(Q.shape[0]):
        idxs=order[i,:3]
        ds=dists[i,idxs]
        if ds[0] > 50.6:
            preds.append('unknown'); continue
        votes={}
        for j in range(3):
            w=1.0/(ds[j]+1e-6)
            lab=labels[idxs[j]]
            votes[lab]=votes.get(lab,0)+w
        sortedv=sorted(votes.items(), key=lambda x:-x[1])
        best=sortedv[0][0]; bs=sortedv[0][1]
        second=sortedv[1][1] if len(sortedv)>1 else 0
        if second>0 and bs/(second+1e-6) < 1.5:
            preds.append('unknown')
        else:
            preds.append(best)
    return preds

for dbpath,tag in [('C:/Users/hp/Desktop/IntentLens/datasets/processed/knn_reference_db_compact.json','compact'),
                   ('C:/Users/hp/Desktop/IntentLens/datasets/processed/knn_reference_db_candidate_full.json','candidate_full')]:
    db,R,labels=load_db(dbpath)
    Q=np.array([r['features'] for r in sample], dtype=np.float64)
    y=[r['class_name'] for r in sample]
    t0=time.time()
    preds=classify_batch(Q,R,labels)
    lat=(time.time()-t0)/len(sample)*1000
    correct=sum(1 for a,b in zip(preds,y) if a==b)
    acc=correct/len(y)
    classes=sorted(set(y))
    precisions=[]; recalls=[]; f1s=[]
    for c in classes:
        tp=sum(1 for p,t in zip(preds,y) if p==c and t==c)
        fp=sum(1 for p,t in zip(preds,y) if p==c and t!=c)
        fn=sum(1 for p,t in zip(preds,y) if p!=c and t==c)
        prec=tp/(tp+fp) if tp+fp>0 else 0
        rec=tp/(tp+fn) if tp+fn>0 else 0
        f1=2*prec*rec/(prec+rec) if prec+rec>0 else 0
        precisions.append(prec); recalls.append(rec); f1s.append(f1)
    macro_p=sum(precisions)/len(precisions)
    macro_r=sum(recalls)/len(recalls)
    macro_f=sum(f1s)/len(f1s)
    unknown=sum(1 for p in preds if p=='unknown')
    print(f"{tag}: refs={len(labels)} acc={acc:.4f} macroP={macro_p:.4f} macroR={macro_r:.4f} macroF1={macro_f:.4f} unknown={unknown} latency_ms_per_query={lat:.2f}")
    out={'db':tag,'refs':len(labels),'accuracy':acc,'macro_precision':macro_p,'macro_recall':macro_r,'macro_f1':macro_f,'unknown':unknown,'latency_ms_per_query':lat}
    json.dump(out, open(f'C:/Users/hp/Desktop/IntentLens/datasets/processed/eval_{tag}.json','w'), indent=2)
