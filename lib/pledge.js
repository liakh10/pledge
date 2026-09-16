/* Browser-side reads of the Pledge contracts through the public RPCs. Everything here is a view; writes go through wallet.js. */
import { parseAbi, formatEther } from 'https://cdn.jsdelivr.net/npm/viem@2.21.55/+esm';
import { pubs } from './wallet.js';

export const CHAIN = 4663;
export const pub = pubs[CHAIN];
export const FACTORY = /^0x[0-9a-fA-F]{40}$/.test(window.PLEDGE_FACTORY || '') ? window.PLEDGE_FACTORY : null;
export const BURNER = /^0x[0-9a-fA-F]{40}$/.test(window.PLEDGE_BURNER || '') ? window.PLEDGE_BURNER : null;
export const PONS = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';

export const FACTORY_ABI = parseAbi([
  'function count() view returns (uint256)',
  'function list(uint256 from, uint256 n) view returns (address[])',
  'function create(string name, string symbol, string logo, string description, uint256 goal, uint256 window, uint16 taxBps) returns (address)',
  'function burner() view returns (address)',
  'function guardian() view returns (address)',
  'function MIN_GOAL() view returns (uint256)',
  'event PledgeCreated(address indexed pledge, address indexed creator, string name, string symbol, uint256 goal, uint64 deadline, uint16 taxBps)'
]);
export const PLEDGE_ABI = parseAbi([
  'function state() view returns (uint8 ph, uint256 raised, uint256 goal, uint64 deadline, uint256 nBackers, address token, address curve, uint256 chest, uint256 reserveNow, uint256 reserveLaunch, uint256 escrowed)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function logo() view returns (string)',
  'function description() view returns (string)',
  'function creator() view returns (address)',
  'function taxBps() view returns (uint16)',
  'function backed(address) view returns (uint256)',
  'function claimed(address) view returns (bool)',
  'function coinsForBackers() view returns (uint256)',
  'function launchedAt() view returns (uint256)',
  'function totalDefended() view returns (uint256)',
  'function totalBurnedCoins() view returns (uint256)',
  'function totalCollected() view returns (uint256)',
  'function backers(uint256 from, uint256 n) view returns (address[], uint256[])',
  'function back() payable',
  'function launch()',
  'function claimCoins()',
  'function refund()',
  'function sweep()',
  'function collect()',
  'function defend()',
  'function run()',
  'event Backed(address indexed backer, uint256 amount, uint256 refunded, uint256 raised)',
  'event Launched(address indexed token, address indexed curve, uint256 firstBuy, uint256 coins, uint256 chest)',
  'event Defended(uint256 spent, uint256 coinsBurned, uint256 reserveBefore, uint256 reserveAfter)'
]);
export const PONS_ABI = parseAbi(['function launchFee() view returns (uint256)']);
export const LAUNCH_FEE = 500000000000000n; /* 0.0005 ETH, re-read from Pons on the page */

export const PHASES = ['funding', 'launched', 'missed'];

/* the list page: every pledge with its state, in one multicall */
export async function loadAll() {
  if (!FACTORY) return [];
  const count = await pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'count' });
  if (count === 0n) return [];
  const addrs = await pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'list', args: [0n, count] });
  const calls = [];
  for (const a of addrs) for (const fn of ['state', 'name', 'symbol', 'taxBps', 'creator']) calls.push({ address: a, abi: PLEDGE_ABI, functionName: fn });
  const rs = await pub.multicall({ contracts: calls, allowFailure: true });
  return addrs.map((address, i) => {
    const [st, name, symbol, taxBps, creator] = rs.slice(i * 5, i * 5 + 5).map(r => r.result);
    return st ? shape(address, st, { name, symbol, taxBps, creator }) : null;
  }).filter(Boolean).reverse();
}

export async function loadOne(address) {
  const fns = ['state', 'name', 'symbol', 'logo', 'description', 'taxBps', 'creator', 'coinsForBackers', 'launchedAt', 'totalDefended', 'totalBurnedCoins', 'totalCollected'];
  const rs = await pub.multicall({ contracts: fns.map(fn => ({ address, abi: PLEDGE_ABI, functionName: fn })), allowFailure: true });
  const o = Object.fromEntries(fns.map((f, i) => [f, rs[i].result]));
  if (!o.state) return null;
  return shape(address, o.state, o);
}

function shape(address, st, o) {
  const [ph, raised, goal, deadline, nBackers, token, curve, chest, reserveNow, reserveLaunch, escrowed] = st;
  return {
    address, phase: Number(ph), phaseName: PHASES[Number(ph)] || '?', raised, goal, deadline: Number(deadline), nBackers: Number(nBackers),
    token: token === '0x0000000000000000000000000000000000000000' ? null : token, curve: curve === '0x0000000000000000000000000000000000000000' ? null : curve,
    chest, reserveNow, reserveLaunch, escrowed,
    name: o.name || '', symbol: o.symbol || '', logo: o.logo || '', description: o.description || '', taxBps: Number(o.taxBps || 0), creator: o.creator || null,
    coinsForBackers: o.coinsForBackers || 0n, launchedAt: Number(o.launchedAt || 0), totalDefended: o.totalDefended || 0n, totalBurnedCoins: o.totalBurnedCoins || 0n, totalCollected: o.totalCollected || 0n,
    pct: goal > 0n ? Number(raised * 10000n / goal) / 100 : 0
  };
}

export const eth = (v, d = 4) => { const n = Number(formatEther(v || 0n)); return n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : n.toFixed(d).replace(/\.?0+$/, '') || '0'; };
export const coins = v => { const n = Number(formatEther(v || 0n)); return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(0); };
export function left(deadline) {
  const s = deadline - Math.floor(Date.now() / 1000);
  if (s <= 0) return 'ended';
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d > 0 ? `${d}d ${h}h left` : h > 0 ? `${h}h ${m}m left` : `${m}m left`;
}
export const ago = ts => { const s = Math.floor(Date.now() / 1000) - ts; return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + 'm ago' : s < 86400 ? Math.floor(s / 3600) + 'h ago' : Math.floor(s / 86400) + 'd ago'; };
