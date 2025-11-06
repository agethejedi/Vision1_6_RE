// app.js — Vision 1_4.2 (neighbors + stats + controls, syntax-safe)
import './ui/ScoreMeter.js?v=2025-11-02';
import './graph.js?v=2025-11-05';

/* ================= Flags ================= */
const RXL_FLAGS = Object.freeze({
  enableNarrative: true,
  debounceMs: 220,
  labelThreshold: 150,
});

/* ================= Worker ================= */
const worker = new Worker('./workers/visionRisk.worker.js', { type: 'module' });
const pending = new Map();
function post(type, payload) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload });
  });
}
worker.onmessage = (e) => {
  const { id, type, data, error } = e.data || {};
  const req = pending.get(id);
  const looksLikeGraph = data && typeof data === 'object' && Array.isArray(data.nodes) && Array.isArray(data.links);

  switch (type) {
    case 'INIT_OK':
      if (req) { req.resolve(true); pending.delete(id); }
      return;

    case 'RESULT_STREAM': {
      const r = normalizeResult(data);
      afterScore(r);
      updateBatchStatus(`Scored: ${r.id.slice(0,8)}… → ${r.score}`);
      return;
    }

    case 'RESULT':
      if (looksLikeGraph) { if (req) { req.resolve(data); pending.delete(id); } return; }
      {
        const r = normalizeResult(data || {});
        if (req) { req.resolve(r); pending.delete(id); }
        afterScore(r);
      }
      return;

    case 'DONE':
      if (req) { req.resolve(true); pending.delete(id); }
      updateBatchStatus('Batch: complete');
      return;

    case 'ERROR':
      console.error('[worker ERROR]', error);
      if (req) { req.reject(new Error(error)); pending.delete(id); }
      updateBatchStatus('Batch: error');
      return;

    default:
      console.warn('[worker] unknown type:', type, e.data);
      if (req) { req.resolve(data); pending.delete(id); }
  }
};

/* ================= State / helpers ================= */
function getNetwork(){ return document.getElementById('networkSelect')?.value || 'eth'; }
function normId(x){ return String(x||'').toLowerCase(); }
function clamp(x,a=0,b=1){ return Math.max(a, Math.min(b, x)); }
function fmtAgeDays(days){
  if(!(days > 0)) return '—';
  const totalMonths = Math.round(days / 30.44);
  const y = Math.floor(totalMonths/12), m = totalMonths % 12;
  if (y>0 && m>0) return `${y}y ${m}m`;
  if (y>0) return `${y}y`;
  return `${m}m`;
}
function hasReason(res, kw){
  const arr = res.reasons || res.risk_factors || [];
  const txt = Array.isArray(arr) ? JSON.stringify(arr).toLowerCase() : String(arr).toLowerCase();
  return txt.includes(kw);
}
function coerceOfacFlag(explain, res){
  const hit = !!(res.sanctionHits || res.sanctioned || res.ofac || hasReason(res, 'ofac') || hasReason(res, 'sanction'));
  explain.ofacHit = hit;
  return hit;
}
function updateBatchStatus(t){ const el = document.getElementById('batchStatus'); if (el) el.textContent = t; }

let selectedNodeId = null;
function setSelected(id){ selectedNodeId = normId(id); }

/* nav history */
const backStack = []; const fwdStack = [];
function pushHistory(id){ if (backStack.at(-1) !== id) backStack.push(id); fwdStack.length = 0; updateNavButtons(); }
function navBack(){ if (backStack.length <= 1) return; const cur = backStack.pop(); fwdStack.push(cur); focusAddress(backStack.at(-1), { fromHistory:true }); }
function navForward(){ if (!fwdStack.length) return; const next = fwdStack.pop(); backStack.push(next); focusAddress(next, { fromHistory:true }); }
function updateNavButtons(){
  document.getElementById('btnBack')?.toggleAttribute('disabled', backStack.length <= 1);
  document.getElementById('btnFwd')?.toggleAttribute('disabled', fwdStack.length === 0);
}

/* cache + debounce */
const scoreCache = new Map(); // key `${network}:${addr}` -> result
function keyFor(addr){ return `${getNetwork()}:${normId(addr)}`; }
function putScore(res){ scoreCache.set(keyFor(res.id), res); }
function getScore(addr){ return scoreCache.get(keyFor(addr)); }
let selTimer = null;
function debounced(fn){ clearTimeout(selTimer); selTimer = setTimeout(fn, RXL_FLAGS.debounceMs); }

/* narrative */
let lastRenderResult = null;

/* ================= Normalize + post-score ================= */
function normalizeResult(res = {}) {
  const id = normId(res.id || res.address);
  const serverScore = (typeof res.risk_score === 'number') ? res.risk_score : null;
  const score = (serverScore != null) ? serverScore : (typeof res.score === 'number' ? res.score : 0);
  const blocked = !!(res.block || serverScore === 100 || res.sanctionHits);

  const explain = res.explain && typeof res.explain === 'object'
    ? { ...res.explain }
    : { reasons: res.reasons || res.risk_factors || [] };

  coerceOfacFlag(explain, res);

  if (typeof explain.walletAgeRisk !== 'number') {
    const days = Number(res.feats?.ageDays ?? NaN);
    if (!Number.isNaN(days) && days >= 0) explain.walletAgeRisk = clamp(1 - Math.min(1, days / (365 * 2)));
  }

  if (!explain.neighborsDormant && res.feats?.local?.riskyNeighborRatio != null) {
    explain.neighborsDormant = { inactiveRatio: clamp(res.feats.local.riskyNeighborRatio || 0) };
  }

  return { ...res, id, address:id, score, explain, block: blocked, blocked };
}

function afterScore(r){
  putScore(r);
  if (r.id === selectedNodeId) {
    updateScorePanel(r);
    applyVisualCohesion(r);
    renderNarrativePanelIfEnabled(r);
    lastRenderResult = r;
  }
}

/* ================= Init & UI ================= */
async function init(){
  await post('INIT', {
    apiBase: (window.VisionConfig && window.VisionConfig.API_BASE) || "",
    network: getNetwork(), concurrency: 8,
    flags: { graphSignals:true, streamBatch:true, neighborStats:true }
  });

  bindUI();
  buildGraphControls();
  seedDemo();
}
init();

function bindUI(){
  document.getElementById('refreshBtn')?.addEventListener('click', scoreVisible);
  document.getElementById('clearBtn')?.addEventListener('click', () => {
    window.graph?.setData({ nodes:[], links:[] });
    setSelected(null); hideNarrativePanel(); updateBatchStatus('Idle');
  });
  document.getElementById('networkSelect')?.addEventListener('change', async () => {
    await post('INIT', { network:getNetwork() });
    scoreCache.clear();
    scoreVisible();
  });
  document.getElementById('loadSeedBtn')?.addEventListener('click', () => {
    const seed = normId(document.getElementById('seedInput').value.trim());
    if (!seed) return;
    focusAddress(seed);
  });

  const g = window.graph;
  if (g && typeof g.on === 'function') {
    g.on('selectNode', (n) => { if (!n) return; const id = normId(n.id); debounced(() => focusAddress(id)); });
    g.on('hoverNode', (n) => { if (!n) { hideTooltip(); return; } showTooltip(n); });
    g.on('dataChanged', () => toggleLabelsByCount());
  }
}

/* ================= Graph controls & tooltip ================= */
function buildGraphControls(){
  const host = document.getElementById('graph'); if (!host) return;
  const box = document.createElement('div');
  box.className = 'graph-controls';
  box.innerHTML = `
    <button id="btnBack" class="btn btn-ghost" disabled>◀</button>
    <button id="btnFwd"  class="btn btn-ghost" disabled>▶</button>
    <span style="flex:1"></span>
    <button id="btnReset" class="btn btn-ghost">Reset</button>
    <button id="btnFit"   class="btn">Zoom Fit</button>`;
  host.appendChild(box);
  box.querySelector('#btnBack').addEventListener('click', navBack);
  box.querySelector('#btnFwd').addEventListener('click', navForward);
  box.querySelector('#btnReset').addEventListener('click', () => window.graph?.resetView());
  box.querySelector('#btnFit').addEventListener('click', () => window.graph?.zoomFit());

  const tip = document.createElement('div');
  tip.id = 'rxlTooltip';
  tip.style.cssText = 'position:absolute;pointer-events:none;padding:6px 8px;border-radius:8px;font-size:12px;background:#0c1820;border:1px solid #1a2a33;color:#e7f7f2;box-shadow:0 8px 24px rgba(0,0,0,.35);display:none;';
  host.appendChild(tip);

  const st = document.createElement('style');
  st.textContent = `
    #graph{ position:relative }
    .graph-controls{ position:absolute; top:8px; right:8px; left:8px; display:flex; gap:6px; align-items:center; z-index:3; }
    #rxlTooltip.badge-safe{ border-color:#14532d } #rxlTooltip.badge-risk{ border-color:#5c1e1e }
  `;
  document.head.appendChild(st);
}

/* ================= Focus / navigate ================= */
async function focusAddress(addr, opts = {}){
  const id = normId(addr);
  setSelected(id);
  if (!opts.fromHistory) pushHistory(id);

  window.graph?.flashHalo(id);

  const cached = getScore(id);
  if (cached) { afterScore(cached); }
  else {
    post('SCORE_ONE', { item:{ type:'address', id, network:getNetwork() } })
      .then(r => { const rr = normalizeResult(r); afterScore(rr); })
      .catch(()=>{});
  }

  setGraphData({ nodes:[{ id, address:id, network:getNetwork() }], links:[] });
  if (typeof window.refreshGraphFromLive === 'function') {
    await window.refreshGraphFromLive(id);
  } else {
    await refreshGraphFromLive(id); // will run because it's declared below and exported
  }
  window.graph?.centerOn(id, { animate:true });
  window.graph?.zoomFit();
}

/* ================= Tooltip ================= */
function showTooltip(n){
  const el = document.getElementById('rxlTooltip'); if (!el) return;
  const addr = normId(n.id);
  const cached = getScore(addr);
  const ofac = !!cached?.explain?.ofacHit;
  const ageDays = cached?.feats?.ageDays ?? null;
  const niceAge = ageDays ? fmtAgeDays(ageDays) : '—';
  const neighCount = (window.graph?.getData()?.nodes?.length || 1) - 1;

  el.classList.remove('badge-safe','badge-risk');
  el.classList.add(ofac ? 'badge-risk' : 'badge-safe');
  el.innerHTML = `
    <div style="opacity:.8;">${addr.slice(0,10)}…${addr.slice(-6)}</div>
    <div>Age: <b>${niceAge}</b></div>
    <div>Neighbors: <b>${neighCount}</b></div>
    <div>Badges: ${ofac ? '<span class="badge badge-risk">OFAC</span>' : '<span class="badge badge-safe">No OFAC</span>'}${cached?.explain?.mixerLink ? ' <span class="badge">Mixer</span>' : ''}${cached?.explain?.custodian ? ' <span class="badge">Custodian</span>' : ''}</div>`;
  el.style.display = 'block';
  el.style.left = (n.__px + 12) + 'px';
  el.style.top  = (n.__py + 12) + 'px';
}
function hideTooltip(){ const el = document.getElementById('rxlTooltip'); if (el) el.style.display = 'none'; }

/* ================= Batch scoring ================= */
function scoreVisible(){
  const vs = (graphGetData().nodes || []).map(n => ({ type:'address', id:normId(n.id), network:getNetwork() }));
  if (!vs.length) return updateBatchStatus('No nodes in view');
  updateBatchStatus(`Batch: ${vs.length} nodes`);
  const items = vs.filter(v => !getScore(v.id));
  if (items.length) post('SCORE_BATCH', { items }).catch(()=>{});
}

/* ================= Graph helpers ================= */
function graphGetData(){
  const g = window.graph;
  if (g && typeof g.getData === 'function') return g.getData();
  return { nodes: window.__VISION_NODES__||[], links: window.__VISION_LINKS__||[] };
}
function setGraphData({nodes, links}){
  window.__VISION_NODES__ = nodes || [];
  window.__VISION_LINKS__ = links || [];
  window.__SHOW_LABELS_BELOW__ = RXL_FLAGS.labelThreshold;
  window.graph?.setData({ nodes: window.__VISION_NODES__, links: window.__VISION_LINKS__ });
}
function toggleLabelsByCount(){
  const count = (graphGetData().nodes || []).length;
  window.graph?.setLabelVisibility(count <= RXL_FLAGS.labelThreshold);
}

/* ================= Demo seed ================= */
function seedDemo(){
  const seed = '0xdemoseed00000000000000000000000000000001';
  setGraphData({ nodes:[{ id:seed, address:seed, network:getNetwork() }], links:[] });
  setSelected(seed);
}

/* ================= Neighbors ================= */
async function getNeighborsLive(centerId){
  try {
    const res = await post('NEIGHBORS', { id: centerId, network: getNetwork(), hop: 1, limit: 250 });
    if (res && Array.isArray(res.nodes) && Array.isArray(res.links)) return res;
  } catch {}
  return { nodes: [], links: [] };
}
async function refreshGraphFromLive(centerId){
  const { nodes, links } = await getNeighborsLive(centerId);
  if (!nodes.length && !links.length) return;

  const center = { id: normId(centerId), address: normId(centerId), network: getNetwork() };
  const nn = nodes.map(n => ({ ...n, id: normId(n.id || n.address) }));
  const ll = links.map(L => ({ a: normId(L.a || L.source || L.idA), b: normId(L.b || L.target || L.idB), weight: L.weight || 1 }));

  let haveCenter = nn.some(n => n.id === center.id);
  const finalNodes = haveCenter ? nn : [center, ...nn];

  const knownNeighbors = new Set();
  for (const L of ll) { if (L.a === center.id) knownNeighbors.add(L.b); if (L.b === center.id) knownNeighbors.add(L.a); }
  for (const n of nn) { if (!knownNeighbors.has(n.id)) ll.push({ a: center.id, b: n.id, weight: 1 }); }

  setGraphData({ nodes: finalNodes, links: ll });

  for (const n of finalNodes) { if (n.id !== center.id) window.graph?.setHalo({ id: n.id, color:'#22d37b', intensity:.5 }); }
  window.graph?.setHalo({ id: center.id, intensity:.9 });
}
// expose for handlers/console
window.refreshGraphFromLive = refreshGraphFromLive;
window.getNeighborsLive     = getNeighborsLive;

/* ================= Score panel / visuals / narrative ================= */
const FACTOR_WEIGHTS = {
  'OFAC': 40, 'OFAC/sanctions list match': 40, 'sanctioned Counterparty': 40,
  'fan In High': 9, 'shortest Path To Sanctioned': 6, 'burst Anomaly': 0, 'known Mixer Proximity': 0,
};
const scorePanel = (window.ScoreMeter && window.ScoreMeter('#scorePanel')) || {
  setSummary(){}, setScore(){}, setBlocked(){}, setReasons(){}, getScore(){ return 0; }
};
function computeBreakdownFrom(res){
  if (Array.isArray(res.breakdown) && res.breakdown.length) return res.breakdown;
  const src = res.reasons || res.risk_factors || [];
  if (!Array.isArray(src) || !src.length) return [];
  const list = src.map(label => ({ label: String(label), delta: FACTOR_WEIGHTS[label] ?? 0 }));
  const hasSanctionRef = list.some(x => /sanction|ofac/i.test(x.label));
  if ((res.block || res.blocked || res.risk_score === 100) && !hasSanctionRef) list.unshift({ label:'sanctioned Counterparty', delta:40 });
  return list.sort((a,b)=> (b.delta||0)-(a.delta||0));
}
function isBlockedVisual(res){ return !!(res.block || res.blocked || res.risk_score === 100 || res.sanctionHits || res.explain?.ofacHit || res.ofac === true); }
function colorForScore(score, blocked){
  if (blocked) return '#ef4444';
  if (score >= 80) return '#ff3b3b';
  if (score >= 60) return '#ffb020';
  if (score >= 40) return '#ffc857';
  if (score >= 20) return '#22d37b';
  return '#00eec3';
}
function updateScorePanel(res){
  res.parity = (typeof res.parity === 'string' || res.parity === true) ? res.parity : 'SafeSend parity';
  const feats = res.feats || {};
  const ageDays = Number(feats.ageDays ?? 0);
  const ageDisplay = (ageDays > 0) ? fmtAgeDays(ageDays) : '—';
  res.breakdown = computeBreakdownFrom(res);
  res.blocked = isBlockedVisual(res);
  scorePanel.setSummary(res);

  const inactiveRatio = (res.explain?.neighborsDormant?.inactiveRatio ?? res.feats?.local?.riskyNeighborRatio ?? 0);
  const mixerPct = Math.round((feats.mixerTaint ?? 0) * 100) + '%';
  const neighPct = Math.round(inactiveRatio * 100) + '%';
  const meta = document.getElementById('entityMeta');
  if (meta) {
    meta.innerHTML = `
      <div>Address: <b>${res.id}</b></div>
      <div>Network: <b>${res.network}</b></div>
      <div>Age: <b>${ageDisplay}</b></div>
      <div>Mixer taint: <b>${mixerPct}</b></div>
      <div>Neighbors flagged: <b>${neighPct}</b></div>`;
  }
}
function applyVisualCohesion(res){
  const blocked = isBlockedVisual(res);
  const color = colorForScore(res.score || 0, blocked);
  window.graph?.setHalo({ id:res.id, blocked, color, pulse: blocked ? 'red' : 'auto', intensity: Math.max(0.25, (res.score||0)/100), tooltip: res.label });
  const panel = document.getElementById('scorePanel');
  if (panel) panel.style.setProperty('--ring-color', color);
}

/* ================= Narrative stubs ================= */
function renderNarrativePanelIfEnabled(){ /* keep or replace with your v1 renderer */ }
function hideNarrativePanel(){ const panel = document.getElementById('narrativePanel'); if (panel) panel.hidden = true; }

/* ================= Exports / Diags ================= */
window.__RXL__ = Object.assign(window.__RXL__ || {}, {
  focusAddress,
  diags(){
    const cfg = (window.VisionConfig && window.VisionConfig.API_BASE) || '(none)';
    const g = window.graph && window.graph.getData ? window.graph.getData() : {nodes:[],links:[]};
    console.table([
      { key:'API_BASE', value: cfg },
      { key:'network',  value: (document.getElementById('networkSelect')?.value || 'eth') },
      { key:'selected', value: (typeof selectedNodeId === 'string' ? selectedNodeId : '(none)') },
      { key:'nodes',    value: (g.nodes||[]).length },
      { key:'links',    value: (g.links||[]).length },
      { key:'cache keys', value: [...(scoreCache?.keys?.()||[])].length }
    ]);
    return { cfg, g };
  }
});
