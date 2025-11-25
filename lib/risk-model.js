// lib/risk-model.js
// Shared RiskXLabs Vision risk model v1.6.4
// This mirrors the logic embedded in workers/server.worker.js

function normHex(addr) {
  if (!addr) return null;
  const s = String(addr).trim().toLowerCase();
  return s && s.startsWith('0x') ? s : null;
}

export function runRiskModel(address, network, txs, neighborCtx, lists) {
  const addr = normHex(address);

  const nowSec = Date.now() / 1000;
  const times = txs.map(t => t.time || 0).filter(Boolean);
  const firstTs = times.length ? Math.min(...times) : nowSec;
  const lastTs = times.length ? Math.max(...times) : nowSec;

  const ageDays = Math.max(0, (nowSec - firstTs) / 86400);
  const activeDays = Math.max(1, (lastTs - firstTs) / 86400);
  const txCount = txs.length;
  const txPerDay = txCount / activeDays;

  const counter = new Map();
  for (const t of txs) {
    const from = normHex(t.from);
    const to = normHex(t.to);
    if (from === addr && to && to !== addr) {
      counter.set(to, (counter.get(to) || 0) + 1);
    } else if (to === addr && from && from !== addr) {
      counter.set(from, (counter.get(from) || 0) + 1);
    }
  }
  const uniqueCounterparties = counter.size;
  const maxFlows = uniqueCounterparties ? Math.max(...counter.values()) : 0;
  const topCounterpartyShare = uniqueCounterparties ? maxFlows / txCount : 0;

  const perDay = new Map();
  for (const t of txs) {
    const d = Math.floor((t.time || nowSec) / 86400);
    perDay.set(d, (perDay.get(d) || 0) + 1);
  }
  const maxDay = perDay.size ? Math.max(...perDay.values()) : 0;
  const avgDay = perDay.size ? txCount / perDay.size : 0;
  const burstScore = avgDay ? Math.min(1, maxDay / (avgDay * 3)) : 0;

  const feats = {
    ageDays,
    firstSeenMs: firstTs * 1000,
    txCount,
    activeDays,
    txPerDay,
    burstScore,
    uniqueCounterparties,
    topCounterpartyShare,
    isDormant: false,
    dormantDays: 0,
    resurrectedRecently: false,
    neighborCount: neighborCtx?.featsLocal?.neighborCount ?? 0,
    sanctionedNeighborRatio: neighborCtx?.featsLocal?.neighborCount
      ? (neighborCtx.sanctionedNeighbors || 0) / neighborCtx.featsLocal.neighborCount
      : 0,
    highRiskNeighborRatio: neighborCtx?.featsLocal?.riskyNeighborRatio ?? 0,
    dormantNeighborRatio: 0,
    mixerProximity: neighborCtx?.mixerNeighbors > 0 ? 0.8 : 0,
    custodianExposure: 0,
    scamPlatformExposure: neighborCtx?.scamNeighbors > 0 ? 0.7 : 0,
    local: neighborCtx?.featsLocal || {
      neighborCount: 0,
      riskyNeighborRatio: 0,
      neighborAvgTx: 0,
      neighborAvgAgeDays: 0,
    },
  };

  let baseScore = 15;
  let rawContribution = 0;
  const parts = {};

  // Age
  let ageImpact = 0;
  let ageBucket = '> 2 years';
  if (ageDays < 7) { ageImpact = 25; ageBucket = '< 1 week'; }
  else if (ageDays < 180) { ageImpact = 10; ageBucket = '1w–6m'; }
  else if (ageDays < 730) { ageImpact = 2; ageBucket = '6m–2y'; }
  else { ageImpact = -10; ageBucket = '> 2 years'; }
  rawContribution += ageImpact;
  parts.age = { id: 'age', label: 'Wallet age', impact: ageImpact, details: { ageDays, bucket: ageBucket } };

  // Velocity
  let velImpact = 0;
  let velBucket = 'normal';
  if (txPerDay > 50 || burstScore > 0.8) {
    velImpact = 22; velBucket = 'extreme';
  } else if (txPerDay > 10 || burstScore > 0.6) {
    velImpact = 14; velBucket = 'elevated';
  } else if (txPerDay > 1 || burstScore > 0.3) {
    velImpact = 6; velBucket = 'active';
  }
  rawContribution += velImpact;
  parts.velocity = {
    id: 'velocity',
    label: 'Transaction velocity & bursts',
    impact: velImpact,
    details: { txPerDay, burstScore, bucket: velBucket },
  };

  // Mix
  let mixImpact = 0;
  let mixBucket = 'diversified';
  if (uniqueCounterparties <= 2 && topCounterpartyShare >= 0.8 && txCount >= 10) {
    mixImpact = 14; mixBucket = 'concentrated';
  } else if (uniqueCounterparties <= 5 && topCounterpartyShare >= 0.6) {
    mixImpact = 6; mixBucket = 'moderate concentration';
  }
  rawContribution += mixImpact;
  parts.mix = {
    id: 'mix',
    label: 'Counterparty mix & concentration',
    impact: mixImpact,
    details: { uniqueCounterparties, topCounterpartyShare, bucket: mixBucket },
  };

  // Neighbor
  let neighborImpact = 0;
  const featsLocal = neighborCtx?.featsLocal || { neighborCount: 0, riskyNeighborRatio: 0 };
  const sanctionedNeighbors = neighborCtx?.sanctionedNeighbors || 0;
  const mixerNeighbors = neighborCtx?.mixerNeighbors || 0;
  const scamNeighbors = neighborCtx?.scamNeighbors || 0;
  const mixedCluster =
    sanctionedNeighbors + mixerNeighbors + scamNeighbors > 0 &&
    featsLocal.neighborCount > 0;

  if (featsLocal.neighborCount > 0) {
    if (featsLocal.riskyNeighborRatio >= 0.5) neighborImpact = 18;
    else if (featsLocal.riskyNeighborRatio >= 0.25) neighborImpact = 10;
    else if (featsLocal.neighborCount >= 10) neighborImpact = 4;
  }
  rawContribution += neighborImpact;
  parts.neighbor = {
    id: 'neighbor',
    label: 'Neighbor & cluster risk',
    impact: neighborImpact,
    details: {
      neighborCount: featsLocal.neighborCount,
      sanctionedNeighborRatio: feats.sanctionedNeighborRatio,
      highRiskNeighborRatio: feats.highRiskNeighborRatio,
      mixedCluster,
    },
  };

  parts.dormant = {
    id: 'dormant',
    label: 'Dormancy & resurrection patterns',
    impact: 0,
    details: { isDormant: false, dormantDays: feats.dormantDays, resurrectedRecently: false },
  };

  const ofacSet = lists?.ofacSet || new Set();
  const scamSet = lists?.scamSet || new Set();
  const tornadoSet = lists?.tornadoSet || new Set();

  let listsImpact = 0;
  const listDetails = {};
  let sanctionHits = 0;
  let block = false;

  if (ofacSet.has(addr)) {
    listsImpact += 70;
    listDetails.ofac = true;
    sanctionHits = 1;
    block = true;
  }
  if (tornadoSet.has(addr)) {
    listsImpact += 25;
    listDetails.tornado = true;
  }
  if (scamSet.has(addr)) {
    listsImpact += 35;
    listDetails.scamCluster = true;
  }
  if (listDetails.tornado && listDetails.scamCluster) {
    listsImpact += 15;
  }

  rawContribution += listsImpact;
  parts.lists = {
    id: 'lists',
    label: 'External fraud & platform signals',
    impact: listsImpact,
    details: listDetails,
  };

  parts.governance = {
    id: 'governance',
    label: 'Governance / override',
    impact: 0,
    details: {},
  };

  const score = Math.max(0, Math.min(100, baseScore + rawContribution));

  const reasons = [];
  const risk_factors = [];
  if (ageImpact > 0) { reasons.push('Wallet age'); risk_factors.push('Wallet age'); }
  if (velImpact > 0) { reasons.push('Transaction velocity & bursts'); risk_factors.push('Transaction velocity & bursts'); }
  if (mixImpact > 0) { reasons.push('Counterparty mix & concentration'); risk_factors.push('Counterparty mix & concentration'); }
  if (neighborImpact > 0) { reasons.push('Neighbor & cluster risk'); risk_factors.push('Neighbor & cluster risk'); }
  if (listsImpact > 0) { reasons.push('OFAC / sanctions list match'); risk_factors.push('OFAC / sanctions list match'); }

  const explain = {
    version: 'RXL-V1.6.4',
    address: addr,
    network,
    baseScore,
    rawContribution,
    score,
    confidence: 1,
    parts,
    feats,
    signals: {
      ofacHit: !!listDetails.ofac,
      chainabuse: false,
      caFraud: false,
      scamPlatform: !!listDetails.scamCluster,
      mixer: !!listDetails.tornado,
      custodian: false,
      unifiedSanctions: null,
      chainalysis: null,
      scorechain: null,
    },
    notes: [],
  };

  return {
    address: addr,
    network,
    risk_score: score,
    score,
    reasons,
    risk_factors,
    block,
    sanctionHits,
    feats,
    explain,
  };
}
