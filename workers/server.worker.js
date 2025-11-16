// workers/server.worker.js
// Cloudflare Worker — Vision 1_5_RE Risk Engine API

import { fetchTxs, fetchNeighbors } from '../lib/api-client.js';
import { buildContext, scoreAddress } from '../lib/risk-model.js';
import { jsonResponse, parseQuery } from '../lib/utils.js';

let DATA_CACHE = null;

async function loadData(env) {
  if (DATA_CACHE) return DATA_CACHE;

  const base = env.RXL_DATA_BASE || 'https://YOUR_STATIC_HOST/vision_1_5_RE/data';
  const [ofac, mixers, custodians, heuristics] = await Promise.all([
    fetch(`${base}/ofac_list.json`).then(r => r.json()),
    fetch(`${base}/mixers.json`).then(r => r.json()),
    fetch(`${base}/custodians.json`).then(r => r.json()),
    fetch(`${base}/heuristics.json`).then(r => r.json())
  ]);

  DATA_CACHE = { ofac, mixers, custodians, heuristics };
  return DATA_CACHE;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/,'') || '/';

    try {
      if (path === '/' || path === '/health') {
        return jsonResponse({ ok: true, service: 'riskxlabs-vision-1_5_RE' });
      }

      if (path === '/check') {
        const q = parseQuery(url.searchParams);
        const address = (q.address || '').toLowerCase();
        const network = (q.network || 'eth').toLowerCase();
        if (!address) return jsonResponse({ error: 'missing address' }, 400);

        const data = await loadData(env);

        // Get minimal txs for age calc
        const txs = await fetchTxs({ address, network, env, limit: 20 }).catch(() => []);
        const ctx = buildContext({ address, network, txs, data });

        const result = scoreAddress({ ctx });
        return jsonResponse(result);
      }

      if (path === '/txs') {
        const q = parseQuery(url.searchParams);
        const address = (q.address || '').toLowerCase();
        const network = (q.network || 'eth').toLowerCase();
        const limit = q.limit ? Number(q.limit) : 10;
        const sort = q.sort || 'desc';

        const txs = await fetchTxs({ address, network, env, limit }).catch(() => []);
        // Shape for ageDays fetcher: { result: [ { metadata.blockTimestamp, timestamp } ] }
        return jsonResponse({
          result: (sort === 'asc') ? txs.slice().reverse() : txs
        });
      }

      if (path === '/neighbors') {
        const q = parseQuery(url.searchParams);
        const address = (q.address || '').toLowerCase();
        const network = (q.network || 'eth').toLowerCase();
        const hop = q.hop ? Number(q.hop) : 1;
        const limit = q.limit ? Number(q.limit) : 250;

        const neighbors = await fetchNeighbors({ address, network, env, hop, limit }).catch(() => ({
          nodes: [{ id: address, address, network }],
          links: []
        }));

        return jsonResponse(neighbors);
      }

      return jsonResponse({ error: 'not_found' }, 404);
    } catch (err) {
      console.error('[server.worker] error:', err);
      return jsonResponse({ error: String(err?.message || err) }, 500);
    }
  }
};
