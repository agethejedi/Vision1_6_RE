// Live EVM adapter using your existing X-Wallet Worker as backend
const API = () => (window.VisionConfig?.API_BASE || "").replace(/\/$/, "");

export const RiskAdapters = {
  evm: {
    async getAddressSummary(addr, { network }={}){
      network = network || 'eth';
      const qs = new URLSearchParams({
        module: 'account', action: 'txlist', address: addr,
        startblock: '0', endblock: '99999999', page: '1', offset: '100', sort: 'asc', network
      });
      const res = await (await fetch(`${API()}/etherscan?${qs.toString()}`)).json();
      const txs = Array.isArray(res.result) ? res.result : [];
      let ageDays = null, fanInZ = 0, fanOutZ = 0, mixerTaint = 0, category = 'wallet';
      if (txs.length){
        const firstTs = Number(txs[0].timeStamp || txs[0].timestamp || 0) * 1000;
        if (firstTs) ageDays = Math.max(0, (Date.now() - firstTs) / (1000*60*60*24));
        const latest = txs.slice(-50);
        const senders = new Set(), receivers = new Set();
        for (const t of latest){
          if (t.from) senders.add(t.from.toLowerCase());
          if (t.to) receivers.add(String(t.to||'').toLowerCase());
        }
        fanInZ = (senders.size - 5) / 3;
        fanOutZ = (receivers.size - 5) / 3;
      }
      const s = await (await fetch(`${API()}/sanctions?address=${encodeURIComponent(addr)}&network=${network}`)).json();
      const sanctionHits = !!s?.hit;
      mixerTaint = 0;
      if (txs.length){
        const heuristic = txs.slice(-100).some(t => /binance|kraken|coinbase|exchange/i.test(`${t.toTag||''}${t.fromTag||''}${t.functionName||''}`));
        if (heuristic) category = 'exchange_unverified';
      }
      return { ageDays, category, sanctionHits, mixerTaint, fanInZ, fanOutZ };
    },

    async getLocalGraphStats(addr, { network }={}){
      network = network || 'eth';
      const qs = new URLSearchParams({
        module:'account', action:'txlist', address:addr,
        startblock:'0', endblock:'99999999', page:'1', offset:'100', sort:'desc', network
      });
      const res = await (await fetch(`${API()}/etherscan?${qs.toString()}`)).json();
      const txs = Array.isArray(res.result) ? res.result : [];
      const neigh = new Set();
      for (const t of txs){
        if (t.from) neigh.add(t.from.toLowerCase());
        if (t.to) neigh.add(String(t.to||'').toLowerCase());
      }
      neigh.delete(addr.toLowerCase());
      const neighbors = Array.from(neigh);
      let riskyCount = 0;
      for (const n of neighbors){
        const s = await (await fetch(`${API()}/sanctions?address=${encodeURIComponent(n)}&network=${network}`)).json();
        if (s?.hit) riskyCount++;
      }
      const riskyNeighborRatio = neighbors.length ? (riskyCount / neighbors.length) : 0;
      const degree = neighbors.length;
      const centralityZ = (degree - 8) / 4;
      const riskyFlowRatio = riskyNeighborRatio * 0.7;
      return { riskyNeighborRatio, shortestPathToSanctioned: 3, centralityZ, riskyFlowRatio };
    },

    async getAnomalySeries(addr, { network }={}){
      network = network || 'eth';
      const qs = new URLSearchParams({
        module:'account', action:'txlist', address:addr,
        startblock:'0', endblock:'99999999', page:'1', offset:'100', sort:'desc', network
      });
      const res = await (await fetch(`${API()}/etherscan?${qs.toString()}`)).json();
      const txs = Array.isArray(res.result) ? res.result : [];
      const byDay = new Map();
      for (const t of txs){
        const ts = new Date((Number(t.timeStamp||0))*1000);
        const day = ts.toISOString().slice(0,10);
        byDay.set(day, (byDay.get(day)||0) + 1);
      }
      const counts = Array.from(byDay.values());
      const mean = counts.reduce((a,b)=>a+b,0) / (counts.length||1);
      const last = counts[counts.length-1] || 0;
      const burstZ = (last - mean) / Math.max(1, Math.sqrt(mean||1));
      return { burstZ };
    },
  }
};
window.RiskAdapters = RiskAdapters;
