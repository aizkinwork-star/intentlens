import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { FeatureExtractor } from '../perception/learning/FeatureExtractor.js';

const SPLIT = process.argv[2] || 'train';
const META = 'datasets/processed/crops_v1/crop_metadata.jsonl';
const SCALER = JSON.parse(readFileSync('datasets/processed/feature_scaler.json','utf8'));
const fe = new FeatureExtractor(SCALER);
const OUTDIR = 'datasets/processed/features_v1';
mkdirSync(OUTDIR, {recursive:true});
const FEAT = `${OUTDIR}/${SPLIT}_features.jsonl`;
const CKPT = `${OUTDIR}/${SPLIT}_checkpoint.json`;

const rawDir = 'C:/Users/hp/AppData/Local/Temp/opencode/raw';
mkdirSync(rawDir, {recursive:true});

let done = new Set();
if (existsSync(CKPT)) {
  try { done = new Set(JSON.parse(readFileSync(CKPT,'utf8')).done); } catch {}
}

const lines = readFileSync(META,'utf8').trim().split('\n').map(l=>JSON.parse(l)).filter(r=>r.split===SPLIT);

let count=0;
for (const r of lines) {
  const key = r.crop_file;
  if (done.has(key)) continue;
  const imgPath = 'datasets/processed/crops_v1/'+r.crop_file;
  const rawPath = rawDir+'/'+r.crop_file+'.raw';
  try {
    const out = execFileSync('python', ['scripts/decode_image.py', imgPath, rawPath], {encoding:'utf8'}).trim().split(' ');
    const w=+out[0], h=+out[1];
    const buf = readFileSync(rawPath);
    const data = new Uint8ClampedArray(buf);
    const imageData = { data, width: w, height: h };
    const box = { x:0, y:0, width:1, height:1 };
    const fv = fe.extract(imageData, box);
    if (fv.length !== 2027) throw new Error('dim '+fv.length);
    const rec = { crop_file: r.crop_file, split: r.split, class_id: r.class_id, class_name: r.class_name, source_image: r.source_image, annotation_id: r.annotation_id, features: fv };
    appendFileSync(FEAT, JSON.stringify(rec)+'\n');
    done.add(key);
    count++;
    if (count%25===0) {
      writeFileSync(CKPT, JSON.stringify({done:[...done]}));
      console.log(SPLIT, 'processed', count, 'total done', done.size, '/', lines.length);
    }
  } catch(e) {
    console.error('FAIL', r.crop_file, e.message);
  }
}
writeFileSync(CKPT, JSON.stringify({done:[...done]}));
console.log(SPLIT, 'COMPLETE', 'done', done.size, '/', lines.length);
