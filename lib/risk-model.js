// lib/risk-model.js
// Risk model v1.6.3 — scores a wallet from behavior + list hits.

console.log('[RiskModel] v1.6.3 loaded');

function normalizeArgs(a, b, c, d) {
  // Support both object-style and positional calls
  if (a && typeof a === 'object' && !Array.isArray(a)) {
    const addr = (a.address || a.addr || a.id || '').toLowerCase();
    return {
      address: addr,
      network: a.network || 'eth',
      feats: a.feats || a.features || {},
      listHits: a.listHits || a.signals || a.hits || {}
    };
  }

  const address = String(a || '').toLowerCase();
  const network = typeof b === 'string' ? b : 'eth';
  const feats = (c && typeof c === 'object') ? c : {};
  const listHits = (d && typeof d === 'object') ? d : {};
  return { address, network, feats, listHits };
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function buildReasons(parts) {
  const arr = Object.values(parts || {});
  return arr
    .filter(p => typeof p.impact === 'number' && p.impact !== 0)
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
    .map(p => p.label);
}

/**
 * Core scoring function.
 * Accepts either:
 *   scoreAddressModelV1({ address, network, feats, listHits })
 * or:
 *   scoreAddressModelV1(address, network, feats, listHits)
 */
export function scoreAddressModelV1(a, b, c, d) {
  const { address, network, feats, listHits } = normalizeArgs(a, b, c, d);

  const ageDays = typeof feats.ageDays === 'number' ? Math.max(0, feats.ageDays) : null;
  const txPerDay = Number(feats.txPerDay || 0);
  const burstScore = Number(feats.burstScore || 0);
  const uniq = Number(feats.uniqueCounterparties || 0);
  const topShare = Number(feats.topCounterpartyShare || 0);
  const neighborCount = feats.neighborCount ??
                        feats.local?.neighborCount ??
                        0;
  const sancRatio = Number(feats.sanctionedNeighborRatio || 0);
  const highRiskRatio = Number(feats.highRiskNeighborRatio || 0);
  const riskyNeighborRatio = Number(
    feats.local?.riskyNeighborRatio ??
    highRiskRatio
  ) || 0;
  const mixerProx = Number(feats.mixerProximity || 0);
  const scamExpo = Number(feats.scamPlatformExposure || 0);

  // List hits coming from the worker
  const ofacHit =
    !!(listHits.ofacHit || listHits.ofac || listHits.sanctioned);
  const tornadoHit =
    !!(listHits.tornadoHit || listHits.tornado);
  const scamClusterHit =
    !!(listHits.scamClusterHit || listHits.scamCluster);

  /* ---------- AGE ---------- */

  let ageImpact = 0;
  let ageBucket = 'unknown';
  if (ageDays == null) {
    ageImpact = 0;
  } else if (ageDays < 7) {
    ageImpact = 25;
    ageBucket = '< 1 week';
  } else if (ageDays < 180) {
    ageImpact = 15;
    ageBucket = '1w–6m';
  } else if (ageDays < 730) {
    ageImpact = 2;
    ageBucket = '6m–2y';
  } else {
    ageImpact = -10;
    ageBucket = '> 2 years';
  }

  /* ---------- VELOCITY ---------- */

  const intensity = txPerDay + burstScore * 20;
  let velImpact = 0;
  let velBucket = 'normal';

  if (intensity >= 100) {
    velImpact = 22;
    velBucket = 'extreme';
  } else if (intensity >= 30) {
    velImpact = 10;
    velBucket = 'elevated';
  } else if (intensity > 0) {
    velImpact = 4;
    velBucket = 'mild';
  }

  /* ---------- MIX / CONCENTRATION ---------- */

  let mixImpact = 0;
  let mixBucket = 'diversified';

  if (uniq <= 1 && topShare >= 0.9) {
    mixImpact = 14;
    mixBucket = 'concentrated';
  } else if (uniq <= 3 && topShare >= 0.7) {
    mixImpact = 9;
    mixBucket = 'moderate';
  } else if (uniq >= 10 && topShare <= 0.2) {
    mixImpact = -2;
    mixBucket = 'diversified';
  }

  /* ---------- NEIGHBOR / CLUSTER ---------- */

  const mixedCluster =
    neighborCount > 0 &&
    (riskyNeighborRatio >= 0.3 || sancRatio > 0);

  let neighborImpact = 0;
  if (mixedCluster) {
    neighborImpact = 5;
  }

  /* ---------- LISTS / EXTERNAL SIGNALS ---------- */

  let listsImpact = 0;
  const listsDetails = {};

  if (ofacHit) {
    listsImpact += 70;
    listsDetails.ofac = true;
  }

  if (tornadoHit) {
    listsImpact += 35;
    listsDetails.tornado = true;
  }

  if (scamClusterHit) {
    listsImpact += 25;
    listsDetails.scamCluster = true;
  }

  const sketchyCluster =
    mixedCluster ||
    mixerProx >= 0.5 ||
    scamExpo >= 0.4;

  // Tornado + sketchy cluster synergy bump
  if (tornadoHit && sketchyCluster) {
    listsImpact += 10;
    listsDetails.tornadoSketchyCluster = true;
  }

  /* ---------- Assemble parts ---------- */

  const parts = {
    age: {
      id: 'age',
      label: 'Wallet age',
      impact: ageImpact,
      details: {
        ageDays,
        bucket: ageBucket
      }
    },
    velocity: {
      id: 'velocity',
      label: 'Transaction velocity & bursts',
      impact: velImpact,
      details: {
        txPerDay,
        burstScore,
        bucket: velBucket
      }
    },
    mix: {
      id: 'mix',
      label: 'Counterparty mix & concentration',
      impact: mixImpact,
      details: {
        uniqueCounterparties: uniq,
        topCounterpartyShare: topShare,
        bucket: mixBucket
      }
    },
    neighbor: {
      id: 'neighbor',
      label: 'Neighbor & cluster risk',
      impact: neighborImpact,
      details: {
        neighborCount,
        sanctionedNeighborRatio: sancRatio,
        highRiskNeighborRatio: highRiskRatio,
        mixedCluster
      }
    },
    dormant: {
      id: 'dormant',
      label: 'Dormancy & resurrection patterns',
      impact: 0,
      details: {
        isDormant: !!feats.isDormant,
        dormantDays: feats.dormantDays || 0,
        resurrectedRecently: !!feats.resurrectedRecently
      }
    },
    concentration: {
      id: 'concentration',
      label: 'Flow concentration (fan-in/out)',
      impact: 0,
      details: {}
    },
    lists: {
      id: 'lists',
      label: 'External fraud & platform signals',
      impact: listsImpact,
      details: listsDetails
    },
    governance: {
      id: 'governance',
      label: 'Governance / override',
      impact: 0,
      details: {}
    }
  };

  const baseScore = 15;
  const rawContribution =
    ageImpact +
    velImpact +
    mixImpact +
    neighborImpact +
    listsImpact;

  let finalScore = baseScore + rawContribution;

  // Hard clamp and OFAC override
  finalScore = clamp(finalScore, 0, 100);
  if (ofacHit && finalScore < 100) {
    finalScore = 100;
  }

  const signals = {
    ofacHit,
    tornadoHit,
    scamClusterHit,
    chainabuse: false,
    caFraud: false,
    scamPlatform: scamExpo > 0,
    mixer: mixerProx > 0,
    custodian: (feats.custodianExposure || 0) > 0,
    unifiedSanctions: null,
    chainalysis: null,
    scorechain: null
  };

  const explain = {
    version: 'RXL-V1.6.3',
    address,
    network,
    baseScore,
    rawContribution,
    score: finalScore,
    confidence: 1,
    parts,
    feats,
    signals,
    notes: []
  };

  const reasons = buildReasons(parts);

  return {
    address,
    network,
    risk_score: finalScore,
    score: finalScore,
    reasons,
    risk_factors: reasons.slice(),
    block: !!ofacHit,
    sanctionHits: ofacHit ? 1 : 0,
    feats,
    explain
  };
}

/* Export a few aliases so the worker can import this under different names
   without breaking. */
export { scoreAddressModelV1 as scoreAddress };
export { scoreAddressModelV1 as buildRiskFromTxHistory };
export { scoreAddressModelV1 as computeRiskEnvelope };

export default {
  scoreAddressModelV1,
  scoreAddress: scoreAddressModelV1
};
