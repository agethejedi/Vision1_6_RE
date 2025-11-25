// lib/risk-model.js
// RiskXLabs Vision risk model v1.6.4 – standalone module
// This mirrors the logic embedded in workers/server.worker.js

const VERSION = "RXL-V1.6.4";

export function parseHexSet(raw) {
  if (!raw) return new Set();
  return new Set(
    String(raw)
      .split(/[\r\n,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.startsWith("0x") && s.length >= 6)
  );
}

export function clamp(x, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, x));
}

export function buildFeatures(address, txs, nowMs = Date.now()) {
  const addr = address.toLowerCase();
  const txList = Array.isArray(txs) ? [...txs] : [];
  if (!txList.length) {
    return {
      ageDays: 0,
      firstSeenMs: null,
      txCount: 0,
      activeDays: 0,
      txPerDay: 0,
      burstScore: 0,
      uniqueCounterparties: 0,
      topCounterpartyShare: 0,
      isDormant: false,
      dormantDays: 0,
      resurrectedRecently: false,
      neighborCount: 0,
      sanctionedNeighborRatio: 0,
      highRiskNeighborRatio: 0,
      dormantNeighborRatio: 0,
      mixerProximity: 0,
      custodianExposure: 0,
      scamPlatformExposure: 0,
      local: {
        riskyNeighborRatio: 0,
        neighborAvgTx: 0,
        neighborAvgAgeDays: 0,
        neighborCount: 0,
      },
    };
  }

  txList.sort((a, b) => (a.timeStamp || 0) - (b.timeStamp || 0));

  const firstTs = txList[0].timeStamp || nowMs;
  const lastTs = txList[txList.length - 1].timeStamp || nowMs;
  const ageDays = (nowMs - firstTs) / (1000 * 60 * 60 * 24);
  const spanDays = Math.max(1, (lastTs - firstTs) / (1000 * 60 * 60 * 24));
  const txCount = txList.length;
  const txPerDay = txCount / spanDays;

  const perDay = new Map();
  for (const tx of txList) {
    const d = Math.floor((tx.timeStamp || nowMs) / (1000 * 60 * 60 * 24));
    perDay.set(d, (perDay.get(d) || 0) + 1);
  }
  const maxPerDay = Math.max(...perDay.values());
  const burstScore = txPerDay > 0 ? clamp(maxPerDay / txPerDay, 0, 10) / 10 : 0;

  const cpCounts = new Map();
  for (const tx of txList) {
    const from = tx.from?.toLowerCase();
    const to = tx.to?.toLowerCase();
    let other = null;
    if (from === addr && to && to !== addr) other = to;
    else if (to === addr && from && from !== addr) other = from;
    if (other) cpCounts.set(other, (cpCounts.get(other) || 0) + 1);
  }

  const uniqueCounterparties = cpCounts.size;
  const totalCpTx = [...cpCounts.values()].reduce((a, b) => a + b, 0) || 1;
  const topCounterpartyShare = totalCpTx
    ? Math.max(...cpCounts.values(), 0) / totalCpTx
    : 0;

  const daysSinceLast =
    (nowMs - (lastTs || nowMs)) / (1000 * 60 * 60 * 24);
  const isDormant = ageDays > 180 && daysSinceLast > 90;

  const neighborCount = uniqueCounterparties;
  const local = {
    riskyNeighborRatio: 0,
    neighborAvgTx: uniqueCounterparties ? totalCpTx / uniqueCounterparties : 0,
    neighborAvgAgeDays: 0,
    neighborCount,
  };

  return {
    ageDays,
    firstSeenMs: firstTs,
    txCount,
    activeDays: Math.round(spanDays),
    txPerDay,
    burstScore,
    uniqueCounterparties,
    topCounterpartyShare,
    isDormant,
    dormantDays: daysSinceLast,
    resurrectedRecently: !isDormant && daysSinceLast < 14 && ageDays > 60,
    neighborCount,
    sanctionedNeighborRatio: 0,
    highRiskNeighborRatio: 0,
    dormantNeighborRatio: 0,
    mixerProximity: 0,
    custodianExposure: 0,
    scamPlatformExposure: 0,
    local,
  };
}

export function scoreWithLists(address, network, feats, lists) {
  const addr = address.toLowerCase();
  const ofacSet = lists.ofacSet || new Set();
  const scamSet = lists.scamSet || new Set();
  const tornadoSet = lists.tornadoSet || new Set();

  const parts = {};
  const notes = [];
  const baseScore = 15;

  // Age
  const d = feats.ageDays;
  let ageImpact = 0;
  let ageBucket = "unknown";
  if (d <= 7) {
    ageImpact = 25;
    ageBucket = "< 1 week";
  } else if (d <= 180) {
    ageImpact = 10;
    ageBucket = "1w–6m";
  } else if (d <= 730) {
    ageImpact = 2;
    ageBucket = "6m–2y";
  } else if (d > 730) {
    ageImpact = -10;
    ageBucket = "> 2y";
  }
  parts.age = {
    id: "age",
    label: "Wallet age",
    impact: ageImpact,
    details: { ageDays: d, bucket: ageBucket },
  };

  // Velocity
  const { txPerDay, burstScore } = feats;
  let velImpact = 0;
  let velBucket = "normal";
  if (txPerDay > 50 || burstScore > 0.8) {
    velImpact = 22;
    velBucket = "extreme";
  } else if (txPerDay > 10 || burstScore > 0.6) {
    velImpact = 14;
    velBucket = "high";
  } else if (txPerDay >= 1 || burstScore > 0.4) {
    velImpact = 4;
    velBucket = "mild";
  }
  parts.velocity = {
    id: "velocity",
    label: "Transaction velocity & bursts",
    impact: velImpact,
    details: { txPerDay, burstScore, bucket: velBucket },
  };

  // Mix
  const { uniqueCounterparties, topCounterpartyShare } = feats;
  let mixImpact = 0;
  let mixBucket = "balanced";
  if (uniqueCounterparties <= 2 && topCounterpartyShare > 0.8) {
    mixImpact = 14;
    mixBucket = "concentrated";
  } else if (uniqueCounterparties >= 8 && topCounterpartyShare < 0.3) {
    mixImpact = -2;
    mixBucket = "diversified";
  }
  parts.mix = {
    id: "mix",
    label: "Counterparty mix & concentration",
    impact: mixImpact,
    details: {
      uniqueCounterparties,
      topCounterpartyShare,
      bucket: mixBucket,
    },
  };

  // Neighbor risk (placeholder)
  let neighborImpact = 0;
  const neighborCount = feats.neighborCount || 0;
  if (neighborCount >= 30) neighborImpact = 6;
  else if (neighborCount >= 10) neighborImpact = 3;

  parts.neighbor = {
    id: "neighbor",
    label: "Neighbor & cluster risk",
    impact: neighborImpact,
    details: {
      neighborCount,
      sanctionedNeighborRatio: feats.sanctionedNeighborRatio,
      highRiskNeighborRatio: feats.highRiskNeighborRatio,
      mixedCluster: false,
    },
  };

  // Dormancy
  let dormantImpact = 0;
  if (feats.isDormant && feats.ageDays > 365) dormantImpact = 4;
  parts.dormant = {
    id: "dormant",
    label: "Dormancy & resurrection patterns",
    impact: dormantImpact,
    details: {
      isDormant: feats.isDormant,
      dormantDays: feats.dormantDays,
      resurrectedRecently: feats.resurrectedRecently,
    },
  };

  // Lists
  let listsImpact = 0;
  const listDetails = {};

  const ofacHit = ofacSet.has(addr);
  if (ofacHit) {
    listsImpact += 70;
    listDetails.ofac = true;
    notes.push("OFAC / sanctions list match");
  }

  if (scamSet.has(addr)) {
    listsImpact += 55;
    listDetails.scamCluster = true;
  }

  if (tornadoSet.has(addr)) {
    listsImpact += 30;
    listDetails.tornado = true;
  }

  if (listDetails.tornado && listDetails.scamCluster) {
    listsImpact += 35;
  }

  parts.lists = {
    id: "lists",
    label: "External fraud & platform signals",
    impact: listsImpact,
    details: listDetails,
  };

  // Concentration placeholder
  parts.concentration = {
    id: "concentration",
    label: "Flow concentration (fan-in/out)",
    impact: 0,
    details: {},
  };

  const governanceImpact = 0;
  parts.governance = {
    id: "governance",
    label: "Governance / override",
    impact: governanceImpact,
    details: {},
  };

  const rawContribution =
    ageImpact +
    velImpact +
    mixImpact +
    neighborImpact +
    dormantImpact +
    listsImpact +
    governanceImpact;

  let score = clamp(baseScore + rawContribution, 0, 100);

  const signals = {
    ofacHit,
    chainabuse: false,
    caFraud: false,
    scamPlatform: !!listDetails.scamCluster,
    mixer: !!listDetails.tornado,
    custodian: false,
    unifiedSanctions: null,
    chainalysis: null,
    scorechain: null,
  };

  const explain = {
    version: VERSION,
    address: addr,
    network,
    baseScore,
    rawContribution,
    score,
    confidence: 1,
    parts,
    feats,
    signals,
    notes,
  };

  explain.ofacHit = ofacHit;
  explain.mixerLink = !!listDetails.tornado;
  explain.scamHit = !!listDetails.scamCluster;
  explain.sketchyCluster = !!listDetails.scamCluster;

  explain.factorImpacts = [
    { id: "age", label: "Wallet age", delta: ageImpact },
    {
      id: "velocity",
      label: "Transaction velocity & bursts",
      delta: velImpact,
    },
    {
      id: "mix",
      label: "Counterparty mix & concentration",
      delta: mixImpact,
    },
    {
      id: "neighbor",
      label: "Neighbor & cluster risk",
      delta: neighborImpact,
    },
    {
      id: "dormant",
      label: "Dormancy & resurrection patterns",
      delta: dormantImpact,
    },
    {
      id: "lists",
      label: "External fraud & platform signals",
      delta: listsImpact,
    },
  ];

  const reasons = [];
  if (ageImpact > 0) reasons.push("Wallet age");
  if (velImpact > 0) reasons.push("Transaction velocity & bursts");
  if (mixImpact > 0) reasons.push("Counterparty mix & concentration");
  if (neighborImpact > 0) reasons.push("Neighbor & cluster risk");
  if (listsImpact > 0 && ofacHit) reasons.push("OFAC / sanctions list match");
  if (listsImpact > 0 && listDetails.scamCluster && !ofacHit)
    reasons.push("Sketchy / scam cluster pattern");
  if (listsImpact > 0 && listDetails.tornado && !ofacHit)
    reasons.push("Mixer proximity pattern");

  const block = !!(ofacHit || score >= 95);
  const sanctionHits = ofacHit ? 1 : 0;

  return {
    address: addr,
    network,
    risk_score: score,
    reasons,
    risk_factors: reasons,
    block,
    sanctionHits,
    feats,
    explain,
    score,
  };
}

// Convenience entrypoint
export function evaluateAddress({ address, network = "eth", txs, lists }) {
  const feats = buildFeatures(address, txs, Date.now());
  return scoreWithLists(address, network, feats, lists);
}
