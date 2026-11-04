import json, time, numpy as np
db=json.load(open('C:/Users/hp/Desktop/IntentLens/datasets/processed/knn_reference_db_candidate_full.json'))
R=np.array([r['features'] for r in db['references']], dtype=np.float64)
labels=np.array([r['className'] for r in db['references']])
test=[json.loads(l) for l in open('C:/Users/hp/Desktop/IntentLens/datasets/processed/features_v1/test_features.jsonl')]
Q=np.array([r['features'] for r in test], dtype=np.float64)
y=[r['class_name'] for r in test]
k=3; maxdist=50.6
qn=np.sum(Q*Q,axis=1)[:,None]; rn=np.sum(R*R,axis=1)[None,:]
dists=np.sqrt(np.maximum(qn+rn-2*(Q@R.T),0))
order=np.argsort(dists,axis=1)
preds=[]
for i in range(Q.shape[0]):
    idxs=order[i,:k]; ds=dists[i,idxs]
    if ds[0]>maxdist: preds.append('unknown'); continue
    votes={}
    for j in range(k):
        w=1.0/(ds[j]+1e-6); lab=labels[idxs[j]]; votes[lab]=votes.get(lab,0)+w
    sv=sorted(votes.items(), key=lambda x:-x[1]); best=sv[0][0]; bs=sv[0][1]
    second=sv[1][1] if len(sv)>1 else 0
    if second>0 and bs/(second+1e-6)<1.5: preds.append('unknown')
    else: preds.append(best)
correct=sum(1 for p,t in zip(preds,y) if p==t)
acc=correct/len(y)
unknown=sum(1 for p in preds if p=='unknown')
print('test n=',len(y),'acc=',acc,'unknown=',unknown,'unknown_rate=',unknown/len(y))
json.dump({'n':len(y),'accuracy':acc,'unknown':unknown,'unknown_rate':unknown/len(y)}, open('C:/Users/hp/Desktop/IntentLens/datasets/processed/test_eval.json','w'), indent=2)
