export function buildExplain(score, contributions, feats, meta={}){
  const topReasons = contributions.slice().sort((a,b)=>(b.add??0)-(a.add??0)).slice(0,5);
  return {
    score, topReasons, contributions,
    features: summarize(feats),
    ruleset: meta.ruleset || 'unknown',
  };
}

function summarize(f){
  return {
    ageDays: f.ageDays ?? null,
    mixerTaint: f.mixerTaint ?? null,
    fanInZ: f.fanInZ ?? null,
    fanOutZ: f.fanOutZ ?? null,
    category: f.category ?? null,
    sanctionHits: !!f.sanctionHits,
    local: f.local ? {
      riskyNeighborRatio: f.local.riskyNeighborRatio ?? null,
      shortestPathToSanctioned: f.local.shortestPathToSanctioned ?? null,
      centralityZ: f.local.centralityZ ?? null,
      riskyFlowRatio: f.local.riskyFlowRatio ?? null,
    } : null,
    anomaly: f.anomaly ? { burstZ: f.anomaly.burstZ ?? null } : null
  };
}
