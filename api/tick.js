/* The keeper: for every launched pledge, sweep the curve, collect the escrow into the chest and defend if the curve
   sits below its opening reserve. Anyone may call these on chain; this only saves backers the gas.
   Runs from GitHub Actions with CRON_SECRET, pays gas from PLEDGE_OPERATOR_KEY. No schedule until the factory is deployed. */
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { json } from '../lib/http.js';
import { pub, chain, RPCS } from '../lib/server.js';
import { siteConfig } from '../lib/siteconfig.js';
import { parseAbi } from 'viem';

const FACTORY_ABI = parseAbi(['function count() view returns (uint256)', 'function list(uint256,uint256) view returns (address[])']);
const PLEDGE_ABI = parseAbi([
  'function state() view returns (uint8,uint256,uint256,uint64,uint256,address,address,uint256,uint256,uint256,uint256)',
  'function run()'
]);
const CURVE_ABI = parseAbi(['function creatorTaxBalance() view returns (uint256)']);
const MIN_WORTH = 2_000_000_000_000_000n; /* 0.002 ETH owed before spending gas on a run */

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const given = (req.headers.authorization || '').replace(/^Bearer /, '') || (req.query || {}).secret;
  if (!secret || given !== secret) return json(res, 401, { error: 'unauthorized' });
  const key = process.env.PLEDGE_OPERATOR_KEY;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key || '')) return json(res, 200, { skipped: 'no operator key' });
  const cfg = await siteConfig(req);
  if (!cfg.factory) return json(res, 200, { skipped: 'not deployed' });
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain, transport: http(RPCS[0]) });
  const count = await pub.readContract({ address: cfg.factory, abi: FACTORY_ABI, functionName: 'count' });
  if (count === 0n) return json(res, 200, { pledges: 0, ran: [] });
  const addrs = await pub.readContract({ address: cfg.factory, abi: FACTORY_ABI, functionName: 'list', args: [0n, count] });
  const states = await pub.multicall({ contracts: addrs.map(a => ({ address: a, abi: PLEDGE_ABI, functionName: 'state' })), allowFailure: true });
  const ran = [];
  for (let i = 0; i < addrs.length; i++) {
    const s = states[i].result; if (!s || Number(s[0]) !== 1) continue;
    const [, , , , , , curve, , reserveNow, reserveLaunch, escrowed] = s;
    const tax = await pub.readContract({ address: curve, abi: CURVE_ABI, functionName: 'creatorTaxBalance' }).catch(() => 0n);
    const worth = tax + escrowed >= MIN_WORTH || reserveNow < reserveLaunch;
    if (!worth) continue;
    try {
      const hash = await wallet.writeContract({ address: addrs[i], abi: PLEDGE_ABI, functionName: 'run' });
      ran.push({ pledge: addrs[i], hash });
    } catch (e) { ran.push({ pledge: addrs[i], error: e.shortMessage || e.message }); }
  }
  return json(res, 200, { pledges: addrs.length, ran });
}
