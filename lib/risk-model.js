// lib/risk-model.js — Risk engine core v1.6.2

/**
 * Main entry point.
 * @param {Object} feats  derived behavioral features
 * @param {Object} signals list-based booleans (ofacHit, scamPlatform, mixer, ...)
 */
export function scoreAddress(feats = {}, signals = {}) {
  const {
    ageDays = null,
    txPerDay = 0,
    burstScore = 0,
    uniqueCounterparties = 0,
    topCounterpartyShare = 0,
    isDormant = false,
    dormantDays = 0,
    resurrectedRecently = false,
    neighborCount = 0,
    sanctionedNeighborRatio = 0,
    highRiskNeighborRatio = 0,
    dormantNeighborRatio = 0,
    mixerProximity = 0,
    custodianExposure = 0,
    scamPlatformExposure = 0
  } = feats;

  const parts = {};

  /* === Age factor ============================================= */
  let ageImpact = 0;
  let ageBucket = 'unknown';
  if (ageDays == null) {
    ageImpact = 0;
    ageBucket = 'unknown';
  } else if (ageDays < 30) {
    ageImpact = 18;
    ageBucket = '< 1 month';
  } else if (ageDays < 180) {
    ageImpact = 10;
    ageBucket = '1–6 months';
  } else if (ageDays < 365) {
    ageImpact = 4;
    ageBucket = '6–12 months';
  } else if (ageDays < 730) {
    ageImpact = 0;
    ageBucket = '1–2 years';
  } else {
    ageImpact = -10;
    ageBucket = '> 2 years';
  }

  parts.age = {
    id: 'age',
    label: 'Wallet age',
    impact: ageImpact,
    details: { ageDays, bucket: ageBucket }
  };

  /* === Velocity / bursts ====================================== */
  const vScore = (txPerDay || 0) * 0.6 + (burstScore || 0) * 40;
  let velImpact = 0;
  let velBucket = 'baseline';
  if (vScore >= 60) {
    velImpact = 25;
    velBucket = 'extreme';
  } else if (vScore >= 30) {
    velImpact = 18;
    velBucket = 'elevated';
  } else if (vScore >= 10) {
    velImpact = 8;
    velBucket = 'mild';
  }

  parts.velocity = {
    id: 'velocity',
    label: 'Transaction velocity & bursts',
    impact: velImpact,
    details: { txPerDay, burstScore, bucket: velBucket }
  };

  /* === Counterparty mix ======================================= */
  let mixImpact = 0;
  let mixBucket = 'unknown';
  if (uniqueCounterparties === 0) {
    mixImpact = 0;
    mixBucket = 'no counterparties';
  } else if (uniqueCounterparties <= 3 && topCounterpartyShare > 0.75) {
    mixImpact = 14;
    mixBucket = 'very concentrated';
  } else if (uniqueCounterparties <= 6 && topCounterpartyShare > 0.5) {
    mixImpact = 9;
    mixBucket = 'concentrated';
  } else if (uniqueCounterparties > 30 && topCounterpartyShare < 0.2) {
    mixImpact = -4;
    mixBucket = 'highly diversified';
  } else {
    mixImpact = -2;
    mixBucket = 'diversified';
  }

  parts.mix = {
    id: 'mix',
    label: 'Counterparty mix & concentration',
    impact: mixImpact,
    details: {
      uniqueCounterparties,
      topCounterpartyShare,
      bucket: mixBucket
    }
  };

  /* === Flow concentration (fan-in / fan-out) ================== */
  // For now this is just a placeholder derived from mix stats
  let concImpact = 0;
  if (uniqueCounterparties <= 2 && topCounterpartyShare > 0.8) {
    concImpact = 6;
  }
  parts.concentration = {
    id: 'concentration',
    label: 'Flow concentration (fan-in/out)',
    impact: concImpact,
    details: {}
  };

  /* === Dormancy / resurrection ================================ */
  let dormImpact = 0;
  let dormBucket = 'active';
  if (isDormant && dormantDays >= 365) {
    dormImpact = -6;
    dormBucket = 'dormant > 1 year';
  }
  if (resurrectedRecently && dormantDays >= 180) {
    dormImpact += 10;
    dormBucket = 'resurrected after dormancy';
  }

  parts.dormant = {
    id: 'dormant',
    label: 'Dormancy & resurrection patterns',
    impact: dormImpact,
    details: { isDormant, dormantDays, resurrectedRecently }
  };

  /* === Neighbor & cluster risk ================================ */
  let neighborImpact = 0;
  let neighborBucket = 'neutral cluster';

  if (neighborCount > 0) {
    const hi = highRiskNeighborRatio || 0;
    const sanc = sanctionedNeighborRatio || 0;
    const dorm = dormantNeighborRatio || 0;

    if (hi >= 0.4 || sanc >= 0.2) {
      neighborImpact = 12;
      neighborBucket = 'elevated / mixed cluster';
    } else if (dorm >= 0.5) {
      neighborImpact = 6;
      neighborBucket = 'dormant-heavy cluster';
    } else if (hi <= 0.05 && sanc === 0 && dorm < 0.3) {
      neighborImpact = -4;
      neighborBucket = 'benign-leaning cluster';
    }
  }

  parts.neighbor = {
    id: 'neighbor',
    label: 'Neighbor & cluster risk',
    impact: neighborImpact,
    details: {
      neighborCount,
      sanctionedNeighborRatio,
      highRiskNeighborRatio,
      dormantNeighborRatio,
      mixedCluster:
        neighborImpact > 0 && (highRiskNeighborRatio || sanctionedNeighborRatio)
          ? true
          : false
    }
  };

  /* === External lists / platform signals ====================== */
  const {
    ofacHit = false,
    scamPlatform = false,
    mixer = false
  } = signals || {};

  let listsImpact = 0;
  const listDetails = {};

  if (ofacHit) {
    listsImpact += 40; // will be overridden to 100 in server.worker, but we keep part.
    listDetails.ofac = true;
  }
  if (scamPlatform || scamPlatformExposure > 0.3) {
    listsImpact += 12;
    listDetails.scamPlatform = true;
  }
  if (mixer || mixerProximity > 0.3) {
    listsImpact += 10;
    listDetails.mixer = true;
  }

  parts.lists = {
    id: 'lists',
    label: 'External fraud & platform signals',
    impact: listsImpact,
    details: listDetails
  };

  /* === Governance override (placeholder) ====================== */
  const governanceImpact = 0;
  parts.governance = {
    id: 'governance',
    label: 'Governance / override',
    impact: governanceImpact,
    details: {}
  };

  /* === Aggregate score ======================================== */
  const baseScore = 15; // baseline
  const rawContribution = Object.values(parts).reduce(
    (acc, p) => acc + (p.impact || 0),
    0
  );
  let score = clamp(baseScore + rawContribution, 0, 100);

  // Confidence: more signals → higher confidence
  let confidence = 0.5;
  let signalCount = 0;
  if (ageDays != null) signalCount++;
  if (txPerDay != null) signalCount++;
  if (uniqueCounterparties != null) signalCount++;
  if (neighborCount != null) signalCount++;
  if (ofacHit || scamPlatform || mixer) signalCount++;

  if (signalCount >= 4) confidence = 1;
  else if (signalCount === 3) confidence = 0.85;
  else if (signalCount === 2) confidence = 0.7;

  const explain = {
    version: 'RXL-V1.6.2',
    baseScore,
    rawContribution,
    score,
    confidence,
    parts,
    feats,
    signals,
    notes: []
  };

  const reasons = buildReasonsFromParts(parts, signals);

  return {
    score,
    reasons,
    explain
  };
}

/* ===================== HELPERS ================================= */

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function buildReasonsFromParts(parts, signals) {
  const out = [];

  if ((parts.velocity?.impact || 0) > 0) {
    out.push('Transaction velocity & bursts');
  }
  if ((parts.age?.impact || 0) !== 0) {
    out.push('Wallet age');
  }
  if ((parts.neighbor?.impact || 0) > 0) {
    out.push('Neighbor & cluster risk');
  }
  if ((parts.mix?.impact || 0) !== 0 || (parts.concentration?.impact || 0) !== 0) {
    out.push('Counterparty mix & concentration');
  }

  if (signals?.ofacHit) {
    out.push('OFAC / sanctions list match');
  }
  if (signals?.scamPlatform) {
    out.push('Known scam / fraud platform cluster');
  }
  if (signals?.mixer) {
    out.push('Known mixer / Tornado Cash cluster');
  }

  return Array.from(new Set(out));
}
