// Vision 1_5_RE configuration
// Point API_BASE at your deployed Cloudflare Worker (server.worker.js)

window.VisionConfig = {
  API_BASE: "https://riskxlabs-vision-api.agedotcom.workers.dev",

  FEATURES: {
    // Always ON for your solo testing; toggle in UI via #flagEngine
    riskEngineV15: true,

    // Optional visual features (UI toggles exist in the Control Panel)
    heatmap: false,
    nodeSizeByValue: false,

    // Signal flags (may affect narrative/badges only; scoring is server-side)
    tagCustodians: true,
    tagPlatforms: true,
    tagMixers: true
  },

  // Scoring ruleset version label (display/telemetry)
  RULESET: "safesend-2025.11.0",

  // Graph defaults
  GRAPH: {
    neighborLimit: 120,
    neighborBatchScoreSize: 25,
    neighborBatchDelayMs: 75,
    debounceViewportMs: 180
  }
};

// Expose a tiny helper for app.js to read/set flags from the Control Panel
export function applyFeatureTogglesFromUI() {
  try {
    const F = window.VisionConfig.FEATURES;
    const byId = (id, def=false) => {
      const el = document.getElementById(id);
      return el ? !!el.checked : def;
    };
    F.riskEngineV15  = byId('flagEngine', F.riskEngineV15);
    F.heatmap        = byId('flagHeatmap', F.heatmap);
    F.nodeSizeByValue= byId('flagSizeByValue', F.nodeSizeByValue);

    F.tagCustodians  = byId('flagCustodian', F.tagCustodians);
    F.tagPlatforms   = byId('flagPlatform',  F.tagPlatforms);
    F.tagMixers      = byId('flagMixer',     F.tagMixers);
  } catch {}
}

// Optional: allow app.js to listen for UI changes easily
document.addEventListener('change', (e) => {
  const id = (e.target && e.target.id) || '';
  if (id.startsWith('flag')) {
    applyFeatureTogglesFromUI();
    // app.js can subscribe to this event to adapt visuals immediately
    window.dispatchEvent(new CustomEvent('rxl:features:changed'));
  }
});
