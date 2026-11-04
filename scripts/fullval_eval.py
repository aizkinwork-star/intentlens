import json, time, numpy as np
from collections import defaultdict, Counter

names=[... ] if False else None
# reuse names list
names=['1-5-Volt-Battery','3-3-Volt-Battery','7-Segment-Display','9-Volt-Battery','Arduino-Mega','Arduino-Nano','Arduino-Uno','BJT-Transistor','Bluetooth-Module','Breadboard','Bridge-Rectifier','Buck-Converter','Buzzer','Capacitor-10mf','Capacitor-470mf','DC-Motor','Diode','ESP32','ESP32-CAM','FT-232-USB-Serial-Module','Film-Capacitor','Fuse','Fuse-Base','GSM-Module','Gas-Sensor','Heat-Sink','High-Voltage-Ceramic-Capacitor','Humidity-Sensor','IC-Base-14-Pin','IC-Base-28-Pin','IC-Chip','IGBT','IR-Sensor','Inductor','Keypad','LCD-Display','LDR-Sensor','LED-Light','Low-Voltage-Ceramic-Capacitor','MLC-Capacitor','MOSFET','Motion-Sensor','Motor-Driver','NTC-Thermistor','OLED-Display','Pin-Header','Push-Switch','RFID-Scanner','Raindrops-Module','Relay-Module','Resistor','Rocker-Switch','Servo-Motor','Soil-Moisture-Sensor','Sonar-Sensor','TCRT5000','Tact-Switch','Taper-Potentiometer','Trimmer-Potentiometer','Water-Sensor','Zener-Diode']

valid=[json.loads(l) for l in open('C:/Users/hp/Desktop/IntentLens/datasets/processed/features_v1/valid_features.jsonl')]
db=json.load(open('C:/Users/hp/Desktop/IntentLens/datasets/processed/knn_reference_db_candidate_full.json'))
R=np.array([r['features'] for r in db['references']], dtype=np.float64)
labels=np.array([r['className'] for r in db['references']])
Q=np.array([r['features'] for r in valid], dtype=np.float64)
y=[r['class_name'] for r in valid]

def eval_k(Q,y,R,labels,k,maxdist):
    qn=np.sum(Q*Q,axis=1)[:,None]; rn=np.sum(R*R,axis=1)[None,:]
    dists=np.sqrt(np.maximum(qn+rn-2*(Q@R.T),0))
    order=np.argsort(dists,axis=1)
    preds=[]; top3hits=0; d1s=[]
    t0=time.time()
    for i in range(Q.shape[0]):
        idxs=order[i,:k]
        ds=dists[i,idxs]
        d1s.append(ds[0])
        # top3
        top3labels=labels[order[i,:3]]
        if y[i] in top3labels: top3hits+=1
        if ds[0]>maxdist:
            preds.append('unknown'); continue
        votes={}
        for j in range(k):
            w=1.0/(ds[j]+1e-6)
            lab=labels[idxs[j]]
            votes[lab]=votes.get(lab,0)+w
        sv=sorted(votes.items(), key=lambda x:-x[1])
        best=sv[0][0]; bs=sv[0][1]
        second=sv[1][1] if len(sv)>1 else 0
        if second>0 and bs/(second+1e-6)<1.5:
            preds.append('unknown')
        else:
            preds.append(best)
    lat=(time.time()-t0)/len(y)*1000
    # metrics
    correct=sum(1 for p,t in zip(preds,y) if p==t)
    acc=correct/len(y)
    accepted=[p for p in preds if p!='unknown']
    acc_acc=sum(1 for p,t in zip(preds,y) if p!='unknown' and p==t)/len(accepted) if accepted else 0
    unknown=sum(1 for p in preds if p=='unknown')
    classes=sorted(set(y))
    precisions=[];recalls=[];f1s=[]
    for c in classes:
        tp=sum(1 for p,t in zip(preds,y) if p==c and t==c)
        fp=sum(1 for p,t in zip(preds,y) if p==c and t!=c)
        fn=sum(1 for p,t in zip(preds,y) if p!=c and t==c)
        prec=tp/(tp+fp) if tp+fp>0 else 0
        rec=tp/(tp+fn) if tp+fn>0 else 0
        f1=2*prec*rec/(prec+rec) if prec+rec>0 else 0
        precisions.append(prec);recalls.append(rec);f1s.append(f1)
    macro_p=sum(precisions)/len(precisions)
    macro_r=sum(recalls)/len(recalls)
    macro_f=sum(f1s)/len(f1s)
    return {'k':k,'maxdist':maxdist,'accuracy':acc,'macro_precision':macro_p,'macro_recall':macro_r,'macro_f1':macro_f,
            'unknown':unknown,'unknown_rate':unknown/len(y),'accepted_rate':len(accepted)/len(y),'accuracy_accepted':acc_acc,
            'top3_accuracy':top3hits/len(y),'latency_ms_per_query':lat,'median_nn_dist':float(np.median(d1s))}

# Full validation baseline k=3, 50.6
res=eval_k(Q,y,R,labels,3,50.6)
print(json.dumps(res,indent=2))
json.dump(res, open('C:/Users/hp/Desktop/IntentLens/datasets/processed/fullval_baseline.json','w'), indent=2)

# threshold sweep
sweep=[]
for k in [1,3,5,7]:
    for md in [30.0,40.0,50.6,60.0,70.0]:
        r=eval_k(Q,y,R,labels,k,md)
        sweep.append(r)
        print(f"k={k} md={md}: acc={r['accuracy']:.4f} macroF1={r['macro_f1']:.4f} unknown_rate={r['unknown_rate']:.4f} accepted_acc={r['accuracy_accepted']:.4f}")
json.dump(sweep, open('C:/Users/hp/Desktop/IntentLens/datasets/processed/threshold_sweep.json','w'), indent=2)
