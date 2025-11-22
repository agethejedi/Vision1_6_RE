// lib/risk-model.js
// RiskXLabs Vision — Risk engine v1.6.2
// Pure scoring module (no fetch, no env) — safe for reuse.

const VERSION = 'RXL-V1.6.2';

function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

function safeNum(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// --- Scoring primitives --------------------------------------------

function scoreAge(feats) {
  const ageDays = safeNum(feats.ageDays, null);
  if (ageDays == null) {
    return {
      id: 'age',
      label: 'Wallet age',
      impact: 0,
      details: {},
      coverage: 0,
    };
  }

  let impact = 0;
  let bucket = 'unknown';

  if (ageDays < 30) {
    impact = 15;
    bucket = '< 30 days';
  } else if (ageDays < 180) {
    impact = 10;
    bucket = '30–180 days';
  } else if (ageDays < 365) {
    impact = 5;
    bucket = '6–12 months';
  } else if (ageDays < 730) {
    impact = 0;
    bucket = '1–2 years';
  } else if (ageDays < 1460) {
    impact = -5;
    bucket = '2–4 years';
  } else {
    impact = -10;
    bucket = '> 4 years';
  }

  return {
    id: 'age',
    label: 'Wallet age',
    impact,
    details: { ageDays, bucket },
    coverage: 1,
  };
}

function scoreVelocity(feats) {
  const txPerDay = safeNum(feats.txPerDay, null);
  const burstScore = safeNum(feats.burstScore, null);

  if (txPerDay == null && burstScore == null) {
    return {
      id: 'velocity',
      label: 'Transaction velocity & bursts',
      impact: 0,
      details: {},
      coverage: 0,
    };
  }

  let impact = 0;
  let bucket = 'normal';

  if (txPerDay != null) {
    if (txPerDay > 100) {
      impact += 20;
      bucket = 'extreme';
    } else if (txPerDay > 25) {
      impact += 15;
      bucket = 'very high';
    } else if (txPerDay > 5) {
      impact += 8;
      bucket = 'elevated';
    } else if (txPerDay > 1) {
      impact += 3;
      bucket = 'moderate';
    } else {
      bucket = 'low';
    }
  }

  if (burstScore != null && burstScore > 0.7) {
    impact += 5;
  } else if (burstScore != null && burstScore > 0.4) {
    impact += 2;
  }

  return {
    id: 'velocity',
    label: 'Transaction velocity & bursts',
    impact,
    details: { txPerDay, burstScore, bucket },
    coverage: 1,
  };
}

function scoreMix(feats) {
  const uniqueCounterparties = safeNum(feats.uniqueCounterparties, null);
  const topShare = safeNum(feats.topCounterpartyShare, null);

  if (uniqueCounterparties == null && topShare == null) {
    return {
      id: 'mix',
      label: 'Counterparty mix & concentration',
      impact: 0,
      details: {},
      coverage: 0,
    };
  }

  let impact = 0;
  let bucket = 'balanced';

  if (uniqueCounterparties != null) {
    if (uniqueCounterparties <= 3) {
      impact += 5;
      bucket = 'very concentrated';
    } else if (uniqueCounterparties <= 10) {
      impact += 2;
      bucket = 'concentrated';
    } else {
      bucket = 'diversified';
    }
  }

  if (topShare != null) {
    if (topShare > 0.8) {
      impact += 7;
    } else if (topShare > 0.5) {
      impact += 4;
    } else if (topShare < 0.2) {
      impact -= 2;
    }
  }

  return {
    id: 'mix',
    label: 'Counterparty mix & concentration',
    impact,
    details: { uniqueCounterparties, topCounterpartyShare: topShare, bucket },
    coverage: 1,
  };
}

function scoreConcentration(feats) {
  // Placeholder for fan-in/out when we wire graph-level stats.
  // For now, neutral unless we later pass extra fields.
  return {
    id: 'concentration',
    label: 'Flow concentration (fan-in/out)',
    impact: 0,
    details: {},
    coverage: 0,
  };
}

function scoreDormant(feats) {
  const isDormant = !!feats.isDormant;
  const dormantDays = safeNum(feats.dormantDays, null);
  const resurrectedRecently = !!feats.resurrectedRecently;

  let impact = 0;

  if (isDormant && dormantDays != null) {
    if (dormantDays > 365) {
      impact += 10;
    } else if (dormantDays > 180) {
      impact += 7;
    } else if (dormantDays > 90) {
      impact += 4;
    }
  }

  if (resurrectedRecently) {
    impact += 5;
  }

  return {
    id: 'dormant',
    label: 'Dormancy & resurrection patterns',
    impact,
    details: { isDormant, dormantDays, resurrectedRecently },
    coverage: dormantDays != null ? 1 : 0,
  };
}

function scoreNeighbor(feats) {
  const neighborCount = safeNum(feats.neighborCount, null);
  const sanctionedRatio = safeNum(feats.sanctionedNeighborRatio, null);
  const highRiskRatio = safeNum(feats.highRiskNeighborRatio, null);
  const dormantNeighborRatio = safeNum(feats.dormantNeighborRatio, null);

  if (neighborCount == null && sanctionedRatio == null && highRiskRatio == null) {
    return {
      id: 'neighbor',
      label: 'Neighbor & cluster risk',
      impact: 0,
      details: {},
      coverage: 0,
    };
  }

  let impact = 0;
  let mixedCluster = false;

  if (neighborCount != null) {
    if (neighborCount >= 50) {
      impact += 3; // large cluster, but not automatically bad
    }
  }

  if (sanctionedRatio != null) {
    if (sanctionedRatio > 0.3) {
      impact += 20;
      mixedCluster = true;
    } else if (sanctionedRatio > 0.1) {
      impact += 10;
      mixedCluster = true;
    } else if (sanctionedRatio > 0) {
      impact += 5;
      mixedCluster = true;
    }
  }

  if (highRiskRatio != null) {
    if (highRiskRatio > 0.4) {
      impact += 10;
      mixedCluster = true;
    } else if (highRiskRatio > 0.2) {
      impact += 5;
      mixedCluster = true;
    }
  }

  if (dormantNeighborRatio != null && dormantNeighborRatio > 0.5) {
    impact += 5;
  }

  return {
    id: 'neighbor',
    label: 'Neighbor & cluster risk',
    impact,
    details: {
      neighborCount,
      sanctionedNeighborRatio: sanctionedRatio,
      highRiskNeighborRatio: highRiskRatio,
      dormantNeighborRatio,
      mixedCluster,
    },
    coverage: neighborCount != null ? 1 : 0.5,
  };
}

function scoreLists(feats, lists) {
  const { ofacHit, mixerHit, scamPlatformHit } = lists || {};
  let impact = 0;
  const details = {};

  if (mixerHit) {
    impact += 20;
    details.mixer = true;
  }
  if (scamPlatformHit) {
    impact += 15;
    details.scamPlatform = true;
  }

  // We do NOT enforce the OFAC=100 policy here — that lives in the worker overlay.
  if (ofacHit) {
    impact += 30;
    details.ofac = true;
  }

  return {
    id: 'lists',
    label: 'External fraud & platform signals',
    impact,
    details,
    coverage: (ofacHit || mixerHit || scamPlatformHit) ? 1 : 0.3,
  };
}

function scoreGovernance() {
  // Placeholder for future override logic; neutral for now.
  return {
    id: 'governance',
    label: 'Governance / override',
    impact: 0,
    details: {},
    coverage: 0,
  };
}

// --- Confidence & fusion ------------------------------------------

function computeConfidence(parts) {
  let coverageSum = 0;
  let count = 0;
  for (const p of Object.values(parts)) {
    coverageSum += p.coverage || 0;
    count++;
  }
  if (!count) return 0.5;
  const avg = coverageSum / count;
  // Keep floor at 0.4 so we never completely suppress signal.
  return clamp(0.4 + 0.6 * avg, 0.4, 1.0);
}

function buildReasons(parts) {
  // Prioritize highest positive impacts, but also include key negative signals.
  const arr = Object.values(parts);
  arr.sort((a, b) => Math.abs(b.impact || 0) - Math.abs(a.impact || 0));

  const top = arr.slice(0, 6).filter(p => p.impact !== 0);
  return top.map(p => p.label);
}

// --- Public API ----------------------------------------------------

export function scoreAddress({ address, network, feats, lists }) {
  const addr = String(address || '').toLowerCase();
  const net = String(network || 'eth').toLowerCase();
  const f = feats || {};

  const age = scoreAge(f);
  const velocity = scoreVelocity(f);
  const mix = scoreMix(f);
  const concentration = scoreConcentration(f);
  const dormant = scoreDormant(f);
  const neighbor = scoreNeighbor(f);
  const listsPart = scoreLists(f, lists || {});
  const governance = scoreGovernance(f, lists || {});

  const parts = {
    age,
    velocity,
    mix,
    concentration,
    dormant,
    neighbor,
    lists: listsPart,
    governance,
  };

  const baseScore = 15;
  let rawContribution = 0;
  for (const p of Object.values(parts)) {
    rawContribution += p.impact || 0;
  }

  const rawScore = baseScore + rawContribution;
  const confidence = computeConfidence(parts);

  // Confidence dampens extreme values when data is sparse.
  let score = rawScore * confidence;
  score = clamp(Math.round(score), 0, 100);

  const reasons = buildReasons(parts);

  const explain = {
    version: VERSION,
    address: addr,
    network: net,
    baseScore,
    rawContribution,
    score,
    confidence,
    parts,
    feats: f,
    signals: {
      ofacHit: !!(lists && lists.ofacHit),
      chainabuse: false,
      caFraud: false,
      scamPlatform: !!(lists && lists.scamPlatformHit),
      mixer: !!(lists && lists.mixerHit),
      custodian: false,
      unifiedSanctions: null,
      chainalysis: null,
      scorechain: null,
    },
    notes: [],
  };

  return {
    risk_score: score,
    reasons,
    block: false,           // the worker can override for OFAC or governance
    sanctionHits: null,     // the worker increments this on OFAC match
    feats: f,
    explain,
  };
}
