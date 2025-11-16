// lib/api-client.js
// Upstream adapters (Alchemy/Etherscan/Blockscout) — stubbed for now.

import { toUnixSeconds, randomHex } from './utils.js';

// Fetch txs — currently stubbed with fake txs based on address hash
export async function fetchTxs({ address, network, env, limit = 20 }) {
  if (!address) return [];

  const now = Date.now();
  const baseTs = now - 1000 * 60 * 60 * 24 * 90; // ~90 days ago
  const n = Math.max(3, Math.min(limit, 20));

  const out = [];
  for (let i = 0; i < n; i++) {
    const t = baseTs + (i * (1000 * 60 * 60 * 24)); // spread over days
    out.push({
      hash: randomHex(64),
      from: address,
      to: randomHex(40),
      value: String(1e15),
      metadata: { blockTimestamp: new Date(t).toISOString() },
      timestamp: toUnixSeconds(t)
    });
  }
  return out;
}

// Fetch neighbors — currently a star graph stub around the center address
export async function fetchNeighbors({ address, network, env, hop = 1, limit = 250 }) {
  const count = Math.min(limit, 40);
  const nodes = [{ id: address, address, network }];
  const links = [];

  for (let i = 0; i < count; i++) {
    const id = '0x' + randomHex(40);
    nodes.push({ id, address: id, network });
    links.push({ a: address, b: id, weight: 1 });
  }

  return { nodes, links };
}
