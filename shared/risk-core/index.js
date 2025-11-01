import { RULES, WEIGHTS, RULESET_VERSION } from './rules.js';
import { extractFeatures } from './features.js';
import { buildExplain } from './explain.js';

export async function scoreOne(input, ctx){
  const feats = await extractFeatures(input, ctx);
  let raw = 0; const contributions = [];
  for (const rule of RULES) {
    const val = rule.fn(feats, ctx);
    const w = WEIGHTS[rule.key] ?? 0;
    const add = clamp01(val) * w;
    raw += add;
    contributions.push({ key: rule.key, val, w, add });
  }
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  const label = labelFromScore(score);
  const explain = buildExplain(score, contributions, feats, { ruleset: RULESET_VERSION });
  return { id: input.id, kind: input.type||'address', network: input.network, score, label, explain, feats };
}

export async function scoreBatch(items, ctx){
  const out = new Array(items.length);
  const limit = pLimit(ctx?.concurrency || 6);
  await Promise.all(items.map((it,i)=>limit(async()=>{ out[i] = await scoreOne(it, ctx); })));
  return out;
}

function clamp01(x){ return x<0?0:x>1?1:x; }
function labelFromScore(s){ return s>=80?'High': s>=60?'Elevated': s>=40?'Moderate': s>=20?'Low':'Minimal'; }

function pLimit(conc){
  const q=[]; let active=0;
  const next=()=>{ if(!q.length || active>=conc) return;
    active++; const {fn,res,rej}=q.shift();
    fn().then(res,rej).finally(()=>{ active--; next(); });
  };
  return (fn)=>new Promise((res,rej)=>{ q.push({fn,res,rej}); next(); });
}
