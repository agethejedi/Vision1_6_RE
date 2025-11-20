// /lib/risk-model.js
// -----------------------------------------------------------------------------
// Vision 1_6_RE — Balanced Rule-Based + Governance Ensemble
//
// This module is *pure*: it does no network I/O. It takes normalized features
// and provider/list signals and produces:
//   - score: 0–100
//   - factors: [{ id, label, weight, impact, severity }]
//   - meta: { version, confidence, parts, feats, signals, notes[] }
//
// It is designed to be called from server.worker.js, which is responsible
// for fetching tx history, neighbor stats, sanctions data, etc.
// -----------------------------------------------------------------------------

const MODEL_VERSION = 'RXL-V1.6.0';

// Reasonable defaults if heuristics.json is missing or partial
const DEFAULT_HEURISTICS = {
  baseScore: 15, // neutral-ish baseline

  weights: {
    // Age (younger → higher risk)
    age_very_young: 18,   // < 7 days
    age_young: 12,        // 7–30 days
    age_mid: 5,           // 1–6 months
    age_mature: -4,       // 6–24 months
    age_very_old: -10,    // > 2 years

    // Velocity / activity
    velocity_none: 4,     // no tx at all
    velocity_low: 2,      // light or dormant
    velocity_normal: 0,   // baseline
    velocity_high: 8,     // elevated flow
    velocity_extreme: 16, // very high volume / velocity

    // Counterparty mix / concentration
    mix_high_concentration: 10,  // few counterparties, heavy flows
    mix_moderate_concentration: 5,
    mix_diversified: -2,         // many counterparties, lower risk

    // Dormant + resurrection patterns
    dormant_aged_wallet: 10,     // self is aged & mostly inactive
    dormant_neighbor_cluster: 8, // neighbors mostly dormant
    resurrection_spike: 10,      // long-dormant then sudden spike

    // Neighbor-derived risk
    neighbor_sanctioned_cluster: 18,
    neighbor_high_risk_cluster: 12,
    neighbor_mixed_cluster: 5,

    // Sanctions & lists (extra layer; primary OFAC handled elsewhere)
    chainabuse_flag: 8,
    ca_fraud_flag: 14,
    scam_platform_flag: 8,   // e.g., Tokenlon scam-heavy, etc.
    mixer_proximity: 12,
    custodian_wash: -6,      // trusted CEX can slightly reduce risk when consistent

    // Governance / override weight (optional)
    governance_adjust: 0
  },

  caps: {
    maxScore: 100,
    minScore: 0,
    maxPositiveContribution: 60,
    maxNegativeContribution: -25
  }
};

/**
 * Main entry point: run the RiskXLabs rule-based + governance ensemble.
 *
 * @param {Object} input
 * @param {string} input.address
 * @param {string} input.network
 * @param {Object} [input.feats]          // derived features
 * @param {Object} [input.signals]        // sanctions lists, provider flags, etc.
 * @param {Object} [input.heuristics]     // optional override of DEFAULT_HEURISTICS
 * @returns {{ score:number, factors:Array, meta:Object }}
 */
export function runRiskModel(input = {}) {
  const {
    address = '',
    network = 'eth',
    feats: rawFeats = {},
    signals: rawSignals = {},
    heuristics: hConfig = {}
  } = input;

  const heuristics = mergeHeuristics(hConfig);
  const feats      = normalizeFeats(rawFeats);
  const signals    = normalizeSignals(rawSignals);

  // --- scoring primitives ---------------------------------------------
  const parts = {};

  parts.age        = ageScore(feats, heuristics);
  parts.velocity   = velocityScore(feats, heuristics);
  parts.mix        = mixScore(feats, heuristics);
  parts.concentration = concentrationScore(feats, heuristics);
  parts.dormant    = dormantScore(feats, heuristics);
  parts.neighbor   = neighborScore(feats, signals, heuristics);
  parts.lists      = listSignalScore(signals, heuristics);
  parts.governance = governanceAdjust(feats, signals, heuristics);

  // Sum contributions (with caps)
  const contributions = Object.values(parts)
    .map(p => (p && typeof p.impact === 'number') ? p.impact : 0);

  const rawContribution = contributions.reduce((a, b) => a + b, 0);
  const boundedContribution = clamp(
    rawContribution,
    heuristics.caps.maxNegativeContribution,
    heuristics.caps.maxPositiveContribution
  );

  const base = heuristics.baseScore || 0;
  const rawScore = base + boundedContribution;
  const score = clamp(rawScore, heuristics.caps.minScore, heuristics.caps.maxScore);

  // Build factor list for UI
  const factors = buildFactors(parts);

  // Confidence: starts high, reduced by missing data
  const confidence = computeConfidence(feats, signals);

  const meta = {
    version: MODEL_VERSION,
    address,
    network,
    baseScore: base,
    rawContribution,
    score,
    confidence,
    parts,
    feats,
    signals,
    notes: buildMetaNotes(feats, signals)
  };

  return { score, factors, meta };
}

// =====================================================================
// HEURISTICS & NORMALIZATION
// =====================================================================

function mergeHeuristics(override = {}) {
  const merged = {
    ...DEFAULT_HEURISTICS,
    ...override,
    weights: {
      ...DEFAULT_HEURISTICS.weights,
      ...(override.weights || {})
    },
    caps: {
      ...DEFAULT_HEURISTICS.caps,
      ...(override.caps || {})
    }
  };
  return merged;
}

/**
 * Normalize derived features into a stable shape.
 *
 * @param {Object} feats
 * @returns {Object}
 */
function normalizeFeats(feats = {}) {
  const days = num(feats.ageDays);
  const txCount = num(feats.txCount);
  const activeDays = num(feats.activeDays);
  const txPerDay = activeDays > 0 ? txCount / activeDays : 0;

  const neighborCount = num(feats.neighborCount);
  const sanctionedNeighborRatio = clamp(num(feats.sanctionedNeighborRatio), 0, 1);
  const highRiskNeighborRatio   = clamp(num(feats.highRiskNeighborRatio), 0, 1);
  const dormantNeighborRatio    = clamp(num(feats.dormantNeighborRatio), 0, 1);

  return {
    // age
    ageDays: days,       // 0 if unknown
    firstSeenMs: num(feats.firstSeenMs) || null,

    // tx / activity
    txCount,
    activeDays,
    txPerDay,
    burstScore: clamp(num(feats.burstScore), 0, 1),

    // mix / concentration
    uniqueCounterparties: num(feats.uniqueCounterparties),
    topCounterpartyShare: clamp(num(feats.topCounterpartyShare), 0, 1),

    // dormant / resurrection
    isDormant: !!feats.isDormant,
    dormantDays: num(feats.dormantDays),
    resurrectedRecently: !!feats.resurrectedRecently,

    // neighbor stats
    neighborCount,
    sanctionedNeighborRatio,
    highRiskNeighborRatio,
    dormantNeighborRatio,

    // misc
    mixerProximity: clamp(num(feats.mixerProximity), 0, 1),
    custodianExposure: clamp(num(feats.custodianExposure), 0, 1),
    scamPlatformExposure: clamp(num(feats.scamPlatformExposure), 0, 1)
  };
}

/**
 * Normalize signals (sanctions lists, providers, etc.).
 *
 * @param {Object} signals
 * @returns {Object}
 */
function normalizeSignals(signals = {}) {
  return {
    ofacHit: !!signals.ofacHit,
    chainabuse: !!signals.chainabuse,
    caFraud: !!signals.caFraud,
    scamPlatform: !!signals.scamPlatform, // e.g., Tokenlon/other scam-heavy
    mixer: !!signals.mixer,
    custodian: !!signals.custodian,
    unifiedSanctions: signals.unifiedSanctions || null, // { ofac_hit, confidence, sources }

    // provider-level
    chainalysis: signals.chainalysis || null,
    scorechain: signals.scorechain || null
  };
}

// =====================================================================
// SCORING PRIMITIVES
// Each returns: { id, label, impact, details }
// =====================================================================

function ageScore(feats, heuristics) {
  const w = heuristics.weights;
  const days = feats.ageDays;
  if (!(days > 0)) {
    return { id: 'age', label: 'Wallet age (unknown)', impact: 0, details: { ageDays: null } };
  }

  let impact = 0;
  let bucket = 'unknown';

  if (days < 7) {
    impact = w.age_very_young;
    bucket = '< 7 days';
  } else if (days < 30) {
    impact = w.age_young;
    bucket = '7–30 days';
  } else if (days < 180) {
    impact = w.age_mid;
    bucket = '1–6 months';
  } else if (days < 730) {
    impact = w.age_mature;
    bucket = '6–24 months';
  } else {
    impact = w.age_very_old;
    bucket = '> 2 years';
  }

  return {
    id: 'age',
    label: 'Wallet age',
    impact,
    details: { ageDays: days, bucket }
  };
}

function velocityScore(feats, heuristics) {
  const w = heuristics.weights;
  const tpd = feats.txPerDay;
  const burst = feats.burstScore;

  // If we have no tx data at all, treat as neutral/slight risk due to opacity
  if (!Number.isFinite(tpd) && !Number.isFinite(burst)) {
    return { id: 'velocity', label: 'Velocity (unknown)', impact: 0, details: {} };
  }

  let impact = 0;
  let bucket = 'normal';

  if (tpd === 0) {
    impact += w.velocity_none;
    bucket = 'no activity';
  } else if (tpd < 0.1) {
    impact += w.velocity_low;
    bucket = 'low';
  } else if (tpd < 3) {
    impact += w.velocity_normal;
    bucket = 'normal';
  } else if (tpd < 20) {
    impact += w.velocity_high;
    bucket = 'high';
  } else {
    impact += w.velocity_extreme;
    bucket = 'extreme';
  }

  // Burstiness: sustained bursts can increase risk
  if (burst >= 0.7) {
    impact += Math.round(w.velocity_extreme / 2);
  } else if (burst >= 0.4) {
    impact += Math.round(w.velocity_high / 2);
  }

  return {
    id: 'velocity',
    label: 'Transaction velocity & bursts',
    impact,
    details: { txPerDay: tpd, burstScore: burst, bucket }
  };
}

function mixScore(feats, heuristics) {
  const w = heuristics.weights;
  const unique = feats.uniqueCounterparties;
  const topShare = feats.topCounterpartyShare; // 0–1

  if (!(unique > 0)) {
    return {
      id: 'mix',
      label: 'Counterparty mix (unknown)',
      impact: 0,
      details: {}
    };
  }

  let impact = 0;
  let bucket = 'diversified';

  if (topShare > 0.8) {
    impact += w.mix_high_concentration;
    bucket = 'highly concentrated';
  } else if (topShare > 0.5) {
    impact += w.mix_moderate_concentration;
    bucket = 'moderately concentrated';
  } else {
    impact += w.mix_diversified;
    bucket = 'diversified';
  }

  return {
    id: 'mix',
    label: 'Counterparty mix & concentration',
    impact,
    details: { uniqueCounterparties: unique, topCounterpartyShare: topShare, bucket }
  };
}

function concentrationScore(feats, heuristics) {
  // Optional separate knob for fan-in / fan-out if you model it explicitly
  // For now, treat this as neutral / reserved for future use.
  return {
    id: 'concentration',
    label: 'Flow concentration (fan-in/out)',
    impact: 0,
    details: {}
  };
}

function dormantScore(feats, heuristics) {
  const w = heuristics.weights;
  let impact = 0;
  const details = {};

  if (feats.isDormant && feats.ageDays > 180) {
    impact += w.dormant_aged_wallet;
    details.selfDormant = true;
  }

  if (feats.dormantNeighborRatio >= 0.6 && feats.neighborCount >= 5) {
    impact += w.dormant_neighbor_cluster;
    details.dormantNeighborRatio = feats.dormantNeighborRatio;
  }

  if (feats.resurrectedRecently && feats.dormantDays > 30) {
    impact += w.resurrection_spike;
    details.resurrectedRecently = true;
  }

  return {
    id: 'dormant',
    label: 'Dormancy & resurrection patterns',
    impact,
    details
  };
}

function neighborScore(feats, signals, heuristics) {
  const w = heuristics.weights;
  let impact = 0;
  const details = {};

  if (feats.neighborCount <= 0) {
    return {
      id: 'neighbor',
      label: 'Neighbor risk (insufficient data)',
      impact: 0,
      details: { sparseNeighborhood: true }
    };
  }

  const sanc = feats.sanctionedNeighborRatio;
  const highR = feats.highRiskNeighborRatio;

  if (sanc >= 0.3) {
    impact += w.neighbor_sanctioned_cluster;
    details.sanctionedNeighborRatio = sanc;
  } else if (highR >= 0.4) {
    impact += w.neighbor_high_risk_cluster;
    details.highRiskNeighborRatio = highR;
  } else if (highR >= 0.2 || sanc >= 0.1) {
    impact += w.neighbor_mixed_cluster;
    details.mixedCluster = true;
  }

  if (signals.mixer) {
    // If a known mixer, this factor may be overshadowed by direct mixer_proximity,
    // but we still capture some contribution.
    impact += Math.round(w.neighbor_high_risk_cluster / 2);
    details.mixerCluster = true;
  }

  return {
    id: 'neighbor',
    label: 'Neighbor & cluster risk',
    impact,
    details
  };
}

function listSignalScore(signals, heuristics) {
  const w = heuristics.weights;
  let impact = 0;
  const details = {};

  if (signals.chainabuse) {
    impact += w.chainabuse_flag;
    details.chainabuse = true;
  }

  if (signals.caFraud) {
    impact += w.ca_fraud_flag;
    details.caFraud = true;
  }

  if (signals.scamPlatform) {
    impact += w.scam_platform_flag;
    details.scamPlatform = true;
  }

  if (signals.mixer) {
    impact += w.mixer_proximity;
    details.mixer = true;
  }

  if (signals.custodian) {
    impact += w.custodian_wash;
    details.custodian = true;
  }

  return {
    id: 'lists',
    label: 'External fraud & platform signals',
    impact,
    details
  };
}

function governanceAdjust(feats, signals, heuristics) {
  const w = heuristics.weights;
  const impact = w.governance_adjust || 0;
  return {
    id: 'governance',
    label: 'Governance / override',
    impact,
    details: {}
  };
}

// =====================================================================
// FACTOR & CONFIDENCE BUILDERS
// =====================================================================

function buildFactors(parts) {
  const factors = [];
  Object.keys(parts).forEach(key => {
    const part = parts[key];
    if (!part) return;
    const impact = Number(part.impact) || 0;
    if (impact === 0) return;

    factors.push({
      id: part.id || key,
      label: part.label || key,
      impact,
      severity: impactToSeverity(impact),
      details: part.details || {}
    });
  });

  // Sort by absolute impact descending
  factors.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  return factors;
}

function impactToSeverity(impact) {
  const v = Math.abs(impact);
  if (v >= 15) return 'high';
  if (v >= 8) return 'moderate';
  if (v >= 3) return 'low';
  return 'minimal';
}

function computeConfidence(feats, signals) {
  let c = 1.0;

  // Penalize missing essential features
  const essentialMissing = [];
  if (!(feats.ageDays > 0)) essentialMissing.push('age');
  if (!(feats.txCount > 0)) essentialMissing.push('txCount');
  if (!(feats.neighborCount >= 0)) essentialMissing.push('neighbors');

  if (essentialMissing.length === 1) c -= 0.1;
  else if (essentialMissing.length === 2) c -= 0.25;
  else if (essentialMissing.length >= 3) c -= 0.4;

  // Boost if unified sanctions has strong confidence (but not too high)
  const unified = signals.unifiedSanctions;
  if (unified && typeof unified.confidence === 'number') {
    c = Math.min(c + unified.confidence * 0.1, 1.0);
  }

  return clamp(c, 0.2, 1.0); // never below 0.2, to avoid "false precision"
}

function buildMetaNotes(feats, signals) {
  const notes = [];

  if (!(feats.ageDays > 0)) {
    notes.push('Wallet age is unknown; age-based risk is neutral.');
  }
  if (!(feats.txCount > 0)) {
    notes.push('Transaction history is thin or missing; velocity metrics may be conservative.');
  }
  if (feats.neighborCount <= 0) {
    notes.push('Neighbor data is sparse; cluster metrics may be conservative.');
  }
  if (signals.unifiedSanctions && signals.unifiedSanctions.confidence < 0.6) {
    notes.push('Sanctions confidence is below 0.6; treat sanctions inference with caution.');
  }

  return notes;
}

// =====================================================================
// UTILS
// =====================================================================

function clamp(x, min, max) {
  x = Number(x) || 0;
  if (min != null && x < min) return min;
  if (max != null && x > max) return max;
  return x;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
