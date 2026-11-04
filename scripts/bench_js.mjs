import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { FeatureExtractor } from '../perception/learning/FeatureExtractor.js';

const META = 'datasets/processed/crops_v1/crop_metadata.jsonl';
const SCALER = JSON.parse(readFileSync('datasets/processed/feature_scaler.json','utf8'));
const fe = new FeatureExtractor(SCALER);

const lines = readFileSync(META,'utf8').trim().split('\n');
const sample = lines.slice(0,100).map(l=>JSON.parse(l));

mkdirSync('C:/Users/hp/AppData/Local/Temp/opencode/raw', {recursive:true});
let ok=0, fail=0; const lats=[];
const t0=Date.now();
for (const r of sample) {
  const imgPath = 'datasets/processed/crops_v1/'+r.crop_file;
  const rawPath = 'C:/Users/hp/AppData/Local/Temp/opencode/raw/'+r.crop_file+'.raw';
  const t=Date.now();
  try {
    const out = execFileSync('python', ['scripts/decode_image.py', imgPath, rawPath], {encoding:'utf8'}).trim().split(' ');
    const w=+out[0], h=+out[1];
    const buf = readFileSync(rawPath);
    const data = new Uint8ClampedArray(buf);
    const imageData = { data, width: w, height: h };
    // box full image
    const box = { x:0, y:0, width:1, height:1 };
    const fv = fe.extract(imageData, box);
    if (fv.length !== 2027) throw new Error('dim '+fv.length);
    lats.push(Date.now()-t);
    ok++;
  } catch(e) {
    fail++;
    console.error('FAIL', r.crop_file, e.message);
  }
}
const total=(Date.now()-t0)/1000;
console.log(JSON.stringify({crops:sample.length, ok, fail, totalSec:total, cropsPerSec:(ok/total).toFixed(2), avgLatencyMs:(lats.reduce((a,b)=>a+b,0)/lats.length).toFixed(1), minLatencyMs:Math.min(...lats), maxLatencyMs:Math.max(...lats)}, null, 2));
