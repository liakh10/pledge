/* The activity feed: what happened on chain, read from event logs through the private endpoint (ROBINHOOD_RPC),
   because the public RPCs refuse archive ranges. GET /api/feed -> { events, head }. Cached in Redis for a minute. */
import { parseAbiItem, formatEther } from 'viem';
import { redis } from '../lib/store.js';
import { json } from '../lib/http.js';
import { pub } from '../lib/server.js';
import { siteConfig } from '../lib/siteconfig.js';

const CACHE_KEY = 'pl:feed:v1', CACHE_SECONDS = 60;
const WINDOW = 300_000n, CHUNK = 9_000n, MAX_EVENTS = 40;
const CREATED = parseAbiItem('event PledgeCreated(address indexed pledge, address indexed creator, string name, string symbol, uint256 goal, uint64 deadline, uint16 taxBps)');
const BACKED = parseAbiItem('event Backed(address indexed backer, uint256 amount, uint256 refunded, uint256 raised)');
const LAUNCHED = parseAbiItem('event Launched(address indexed token, address indexed curve, uint256 firstBuy, uint256 coins, uint256 chest)');
const DEFENDED = parseAbiItem('event Defended(uint256 spent, uint256 coinsBurned, uint256 reserveBefore, uint256 reserveAfter)');
const CLAIMED = parseAbiItem('event Claimed(address indexed backer, uint256 coins)');

async function scan(address, event, fromBlock, toBlock) {
  const out = [];
  for (let from = fromBlock; from <= toBlock; from += CHUNK + 1n) {
    const to = from + CHUNK > toBlock ? toBlock : from + CHUNK;
    out.push(...await pub.getLogs({ address, event, fromBlock: from, toBlock: to }).catch(() => []));
  }
  return out;
}

export default async function handler(req, res) {
  let R = null;
  try { R = redis(); } catch {}
  if (R) { const hit = await R.get(CACHE_KEY).catch(() => null); if (hit) { res.setHeader('x-cache', 'hit'); return json(res, 200, JSON.parse(hit)); } }
  const cfg = await siteConfig(req);
  if (!cfg.factory) return json(res, 200, { events: [], head: null, note: 'not deployed yet' });
  try {
    const head = await pub.getBlockNumber();
    const from = head > WINDOW ? head - WINDOW : 0n;
    const created = await scan(cfg.factory, CREATED, from, head);
    const pledges = [...new Set(created.map(l => l.args.pledge))];
    const nameOf = Object.fromEntries(created.map(l => [l.args.pledge.toLowerCase(), l.args.symbol]));
    const [backs, launches, defends, claims] = await Promise.all(['BACKED', 'LAUNCHED', 'DEFENDED', 'CLAIMED'].map(k => pledges.length ? scan(pledges, { BACKED, LAUNCHED, DEFENDED, CLAIMED }[k], from, head) : []));
    const sym = l => nameOf[l.address.toLowerCase()] || null;
    const events = [
      ...created.map(l => ({ kind: 'created', block: Number(l.blockNumber), pledge: l.args.pledge, symbol: l.args.symbol, goal: formatEther(l.args.goal) })),
      ...backs.map(l => ({ kind: 'backed', block: Number(l.blockNumber), pledge: l.address, symbol: sym(l), backer: l.args.backer, amount: formatEther(l.args.amount) })),
      ...launches.map(l => ({ kind: 'launched', block: Number(l.blockNumber), pledge: l.address, symbol: sym(l), token: l.args.token, firstBuy: formatEther(l.args.firstBuy), chest: formatEther(l.args.chest) })),
      ...defends.map(l => ({ kind: 'defended', block: Number(l.blockNumber), pledge: l.address, symbol: sym(l), spent: formatEther(l.args.spent), burned: formatEther(l.args.coinsBurned) })),
      ...claims.map(l => ({ kind: 'claimed', block: Number(l.blockNumber), pledge: l.address, symbol: sym(l), backer: l.args.backer, coins: formatEther(l.args.coins) }))
    ].sort((a, b) => b.block - a.block).slice(0, MAX_EVENTS);
    const blocks = [...new Set(events.map(e => e.block))].slice(0, 12);
    const stamps = Object.fromEntries(await Promise.all(blocks.map(async b => [b, Number((await pub.getBlock({ blockNumber: BigInt(b) }).catch(() => ({ timestamp: 0n }))).timestamp)])));
    for (const e of events) e.at = stamps[e.block] || null;
    const payload = { events, head: Number(head) };
    if (R) await R.set(CACHE_KEY, JSON.stringify(payload), { ex: CACHE_SECONDS }).catch(() => {});
    res.setHeader('x-cache', 'miss');
    return json(res, 200, payload);
  } catch (e) {
    return json(res, 200, { events: [], head: null, error: e.shortMessage || e.message });
  }
}
