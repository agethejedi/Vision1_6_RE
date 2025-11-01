export const RULESET_VERSION = 'safesend-2025.10.1';

export const WEIGHTS = {
  sanctionedCounterparty: 40,
  knownMixerProximity: 18,
  newAddressAge: 8,
  fanInHigh: 10,
  fanOutHigh: 10,
  exchangeCategoryUnverified: 8,
  localRiskyNeighborRatio: 14,
  shortestPathToSanctioned: 12,
  hubCentralityRisk: 10,
  burstAnomaly: 8,
};

export const RULES = [
  { key:'sanctionedCounterparty', fn: f => f.sanctionHits ? 1 : 0 },
  { key:'knownMixerProximity',    fn: f => scale01(f.mixerTaint) },
  { key:'newAddressAge',          fn: f => invertAgeDays(f.ageDays, 14) },
  { key:'fanInHigh',              fn: f => scale01(f.fanInZ) },
  { key:'fanOutHigh',             fn: f => scale01(f.fanOutZ) },
  { key:'exchangeCategoryUnverified', fn: f => f.category === 'exchange_unverified' ? 1 : 0 },
  { key:'localRiskyNeighborRatio', fn: f => f.local?.riskyNeighborRatio ?? 0 },
  { key:'shortestPathToSanctioned',fn: f => f.local?.shortestPathToSanctioned ? invLen(f.local.shortestPathToSanctioned, 6) : 0 },
  { key:'hubCentralityRisk',       fn: f => scale01(f.local?.centralityZ || 0) * (f.local?.riskyFlowRatio || 0) },
  { key:'burstAnomaly',            fn: f => scale01(f.anomaly?.burstZ || 0) },
];

function scale01(z){ return Math.max(0, Math.min(1, (z||0) / 3)); }
function invertAgeDays(days, horizon){ if(days==null) return 0; const d=Math.min(days,horizon); return (horizon - d)/horizon; }
function invLen(len,max){ if(len==null) return 0; const L=Math.min(len,max); return (max - L)/max; }
