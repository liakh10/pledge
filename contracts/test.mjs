/* Pledge against a fork of Robinhood Chain mainnet (ethereumjs VM + RPCStateManager): the real Pons V2 factory,
   curve and fee escrow. Backers fund a goal, the coin launches on Pons with the first buy in the same transaction,
   the chest defends the opening level. No real keys are involved. */
import fs from 'node:fs';
import path from 'node:path';
import { VM } from '@ethereumjs/vm';
import { RPCStateManager } from '@ethereumjs/statemanager';
import { Common, Hardfork } from '@ethereumjs/common';
import { Block } from '@ethereumjs/block';
import { Address, Account, bytesToHex, hexToBytes } from '@ethereumjs/util';
import { encodeFunctionData, decodeFunctionResult, decodeErrorResult, decodeEventLog, encodeDeployData, parseAbi, formatEther, getAddress } from 'viem';

const RPC = 'https://robinhood-rpc.publicnode.com';
const realFetch = globalThis.fetch;
let rpcRetries = 0, rpcCalls = 0;
globalThis.fetch = async (url, opts) => {
  if (!String(url).startsWith(RPC)) return realFetch(url, opts);
  rpcCalls++;
  let last;
  for (let i = 0; i < 8; i++) {
    try { const text = await (await realFetch(url, opts)).text(); const j = JSON.parse(text); if (j.result !== undefined) return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } }); last = JSON.stringify(j.error || j); } catch (e) { last = e.message; }
    rpcRetries++;
    await new Promise(r => setTimeout(r, 250 * 2 ** i));
  }
  throw Error('RPC failed: ' + last);
};

const dir = path.dirname(new URL(import.meta.url).pathname);
const art = n => JSON.parse(fs.readFileSync(path.join(dir, 'artifacts', n + '.json'), 'utf8'));
const PL = art('Pledge'), PF = art('PledgeFactory');
const ALL = [...PL.abi, ...PF.abi].filter((x, i, a) => x.type !== 'event' || a.findIndex(y => y.type === 'event' && y.name === x.name) === i);
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const ESC = parseAbi(['function balanceOf(address) view returns (uint256)']);
const PONSF = parseAbi(['function launchFee() view returns (uint256)', 'function getLaunchedToken(address) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))']);
const CURVE = parseAbi(['function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256)', 'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256)', 'function realQuoteReserve() view returns (uint256)', 'function creatorTaxBalance() view returns (uint256)', 'function quoteFeeBalance() view returns (uint256)', 'function deployer() view returns (address)']);
const APPROVE = parseAbi(['function approve(address,uint256) returns (bool)']);
const PONS = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e', ESCROW = '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e', DEAD = '0x000000000000000000000000000000000000dEaD', ZERO = '0x0000000000000000000000000000000000000000';
const E = n => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const addr = n => getAddress('0x' + n.toString(16).padStart(40, '0'));
let pass = 0, fail = 0;
const ok = (c, label, extra = '') => { if (c) pass++; else { fail++; console.log('  FAIL', label, extra); } };

class ForkState extends RPCStateManager {
  constructor(o) { super(o); this._codeStack = []; }
  async checkpoint() { await super.checkpoint(); this._codeStack.push(new Map(this._contractCache)); }
  async commit() { this._accountCache.commit(); this._storageCache.commit(); this._codeStack.pop(); }
  async revert() { this._accountCache.revert(); this._storageCache.revert(); const snap = this._codeStack.pop(); if (snap) this._contractCache = snap; }
}
const head = (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] }) })).json()).result;
const common = Common.custom({ chainId: 4663, networkId: 4663 }, { hardfork: Hardfork.Cancun });
const stateManager = new ForkState({ provider: RPC, blockTag: BigInt(head.number) });
stateManager._blockTag = 'latest';
const vm = await VM.create({ common, stateManager });
let now = BigInt(head.timestamp) + 12n;
const block = () => Block.fromBlockData({ header: { number: BigInt(head.number) + 1n, timestamp: now, gasLimit: 30_000_000n, baseFeePerGas: 0n } }, { common });

async function exec(from, to, data, value = 0n) {
  const r = await vm.evm.runCall({ caller: Address.fromString(from), to: to ? Address.fromString(to) : undefined, data: hexToBytes(data), gasLimit: 30_000_000n, value, block: block() });
  const e = r.execResult; let reason = null;
  if (e.exceptionError) { try { const d = decodeErrorResult({ abi: ALL, data: bytesToHex(e.returnValue) }); reason = d.args ? String(d.args[0]) : d.errorName; } catch { reason = e.exceptionError.error + ' ' + bytesToHex(e.returnValue).slice(0, 80); } }
  const logs = (e.logs || []).map(([a, topics, d]) => { try { return { address: getAddress(bytesToHex(a)), ...decodeEventLog({ abi: ALL, topics: topics.map(bytesToHex), data: bytesToHex(d) }) }; } catch { return null; } }).filter(Boolean);
  return { reverted: !!e.exceptionError, reason, logs, ret: bytesToHex(e.returnValue), gas: e.executionGasUsed, created: r.createdAddress ? getAddress(r.createdAddress.toString()) : null };
}
async function tx(from, to, abi, functionName, args = [], value = 0n) {
  const r = await exec(from, to, encodeFunctionData({ abi, functionName, args }), value);
  if (!r.reverted) try { r.result = decodeFunctionResult({ abi, functionName, data: r.ret }); } catch {}
  return r;
}
async function must(from, to, abi, fn, args, label, value = 0n) { const r = await tx(from, to, abi, fn, args, value); ok(!r.reverted, label, r.reason || ''); return r; }
async function reverts(from, to, abi, fn, args, expect, label, value = 0n) { const r = await tx(from, to, abi, fn, args, value); ok(r.reverted && (!expect || String(r.reason).includes(expect)), label, `reverted=${r.reverted} reason=${r.reason}`); }
const view = async (to, abi, fn, args = []) => { const r = await tx(addr(1), to, abi, fn, args); if (r.reverted) throw Error(fn + ' reverted: ' + r.reason); return r.result; };
const giveEth = async (who, wei) => { const a = Address.fromString(who), acct = (await vm.stateManager.getAccount(a)) ?? new Account(); acct.balance = wei; await vm.stateManager.putAccount(a, acct); };
const ethBal = async who => (await vm.stateManager.getAccount(Address.fromString(who)))?.balance ?? 0n;
const bal = (token, who) => view(token, ERC20, 'balanceOf', [who]);
async function deploy(from, a, args = []) {
  const r = await exec(from, null, args.length ? encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args }) : a.bytecode);
  if (r.reverted) throw Error('deploy failed ' + a.contractName + ' ' + r.reason);
  const who = Address.fromString(from), acct = (await vm.stateManager.getAccount(who)) ?? new Account();
  acct.nonce += 1n; await vm.stateManager.putAccount(who, acct);
  return r.created;
}

const guardian = addr(0xd0), alice = addr(0xa1), bob = addr(0xb0), carol = addr(0xc0), dave = addr(0xda), eve = addr(0xee), burner = addr(0xb1);
for (const w of [guardian, alice, bob, carol, dave, eve]) await giveEth(w, E(20));
console.log('fork block', Number(head.number), `· sizes factory ${PF.deployedSize}, pledge ${PL.deployedSize}`);

const impl = await deploy(guardian, PL);
const F = await deploy(guardian, PF, [impl, burner]);
ok((await view(F, PF.abi, 'guardian')) === guardian && (await view(F, PF.abi, 'burner')) === burner, 'factory wired');
await reverts(eve, impl, PL.abi, 'initialize', [eve, 'x', 'X', '', '', E(1), 1n, 300, burner], 'init', 'the implementation is locked');

// ------------------------------------------------------------------ creating
const DAY = 86400n;
await reverts(alice, F, PF.abi, 'create', ['Tiny', 'TINY', '', '', E(0.1), DAY, 300], 'goal', 'a goal under 0.25 ETH is refused');
await reverts(alice, F, PF.abi, 'create', ['Long', 'LONG', '', '', E(1), 30n * DAY, 300], 'window', 'a window over 7 days is refused');
await reverts(alice, F, PF.abi, 'create', ['Tax', 'TAX', '', '', E(1), DAY, 900], 'tax', 'a tax over 5% is refused');
const cr = await must(alice, F, PF.abi, 'create', ['Pledge One', 'PONE', 'https://pledge.example/logo.png', 'a coin that launches when funded', E(0.5), DAY, 300], 'alice creates a pledge with a 0.5 ETH goal');
const P = cr.logs.find(l => l.eventName === 'PledgeCreated').args.pledge;
ok((await view(F, PF.abi, 'count')) === 1n && (await view(F, PF.abi, 'isPledge', [P])), 'the factory lists it');
ok((await view(P, PL.abi, 'creator')) === alice && (await view(P, PL.abi, 'goal')) === E(0.5) && (await view(P, PL.abi, 'phase')) === 0, 'the pledge knows its creator and goal');

// ------------------------------------------------------------------ backing
await reverts(eve, P, PL.abi, 'launch', [], 'goal not met', 'cannot launch before the goal');
await reverts(alice, P, PL.abi, 'refund', [], 'still open', 'cannot refund while the window is open');
const b1 = await must(alice, P, PL.abi, 'back', [], 'alice backs 0.2', E(0.2));
ok(b1.logs.some(l => l.eventName === 'Backed' && l.args.amount === E(0.2) && l.args.refunded === 0n), 'alice is recorded');
await must(bob, P, PL.abi, 'back', [], 'bob backs 0.2', E(0.2));
const c0 = await ethBal(carol);
const b3 = await must(carol, P, PL.abi, 'back', [], 'carol sends 0.3 with only 0.1 left of the goal', E(0.3));
const ev3 = b3.logs.find(l => l.eventName === 'Backed');
ok(ev3 && ev3.args.amount === E(0.1) && ev3.args.refunded === E(0.2) && (c0 - await ethBal(carol)) === E(0.1), 'carol is charged 0.1 and refunded 0.2 in the same transaction');
ok(b3.logs.some(l => l.eventName === 'GoalReached') && (await view(P, PL.abi, 'raised')) === E(0.5), 'goal reached at exactly 0.5 ETH');
ok((await view(P, PL.abi, 'backerCount')) === 3n, 'three backers');
await reverts(dave, P, PL.abi, 'back', [], 'funded', 'nobody can back a fully funded pledge', E(0.1));

// ------------------------------------------------------------------ launching
now += 60n;
const fee = await view(PONS, PONSF, 'launchFee');
const la = await must(eve, P, PL.abi, 'launch', [], 'anyone launches the funded pledge');
const lev = la.logs.find(l => l.eventName === 'Launched');
const T = lev && lev.args.token, C = lev && lev.args.curve;
console.log(`  launched ${T} · first buy ${lev && formatEther(lev.args.firstBuy)} ETH · coins ${lev && formatEther(lev.args.coins)} · chest ${lev && formatEther(lev.args.chest)} · gas ${la.gas}`);
ok(lev && lev.args.firstBuy === (E(0.5) - fee) / 2n, 'half of the raise after the Pons fee went into the first buy');
ok(lev && lev.args.chest === E(0.5) - fee - lev.args.firstBuy, 'the other half is the chest');
const lt = await view(PONS, PONSF, 'getLaunchedToken', [T]);
ok(lt.exists && lt.creatorFeeRecipient === P && lt.creatorTaxBps === 300 && lt.pairToken === ZERO, 'Pons pays the creator fee to the pledge itself');
ok((await view(C, CURVE, 'deployer')) === P, 'Pons treats the pledge as the curve deployer, so it may sweep');
ok((await view(P, PL.abi, 'phase')) === 1 && (await view(P, PL.abi, 'reserveAtLaunch')) > 0n, 'launched, opening reserve recorded');
await reverts(eve, P, PL.abi, 'launch', [], 'not funding', 'cannot launch twice');
await reverts(dave, P, PL.abi, 'back', [], 'closed', 'cannot back after launch', E(0.1));

// ------------------------------------------------------------------ claiming
const coins = await view(P, PL.abi, 'coinsForBackers');
await reverts(dave, P, PL.abi, 'claimCoins', [], 'nothing', 'a stranger has nothing to claim');
await must(alice, P, PL.abi, 'claimCoins', [], 'alice claims');
await must(bob, P, PL.abi, 'claimCoins', [], 'bob claims');
await must(carol, P, PL.abi, 'claimCoins', [], 'carol claims');
ok((await bal(T, alice)) === coins * 2n / 5n && (await bal(T, bob)) === coins * 2n / 5n && (await bal(T, carol)) === coins / 5n, 'coins split 40 / 40 / 20 by what each backed');
await reverts(alice, P, PL.abi, 'claimCoins', [], 'nothing', 'cannot claim twice');
ok((await bal(T, P)) <= 2n, 'nothing left in the pledge but rounding dust', (await bal(T, P)).toString());

// ------------------------------------------------------------------ the chest
now += 120n;
await reverts(eve, P, PL.abi, 'defend', [], 'at or above opening', 'the chest does nothing while the curve is at its opening level');
for (const [w, v] of [[dave, 0.3], [eve, 0.2]]) { const r = await tx(w, C, CURVE, 'buy', [E(v), 1n, w], E(v)); ok(!r.reverted, 'a trader buys', r.reason || ''); }
await reverts(eve, P, PL.abi, 'defend', [], 'at or above opening', 'still nothing after buys, the reserve is higher than at launch');
const taxBefore = await view(C, CURVE, 'creatorTaxBalance');
ok(taxBefore > 0n, 'creator tax accrued on the curve from the trades');
const sw = await must(eve, P, PL.abi, 'sweep', [], 'anyone sweeps the curve');
ok(sw.logs.some(l => l.eventName === 'Swept' && l.args.ok), 'sweep succeeded');
const owed = await view(ESCROW, ESC, 'balanceOf', [P]);
ok(owed > 0n, 'the pledge is owed fees in the escrow', formatEther(owed));
const chest0 = await ethBal(P), burner0 = await ethBal(burner);
const col = await must(eve, P, PL.abi, 'collect', [], 'anyone collects into the chest');
const cev = col.logs.find(l => l.eventName === 'Collected');
ok(cev && cev.args.eth === owed && cev.args.toBurner === owed / 10n && (await ethBal(burner)) - burner0 === owed / 10n, 'a tenth of the fees goes to the burner');
ok((await ethBal(P)) - chest0 === owed - owed / 10n, 'the rest refills the chest');

// selling pushes the reserve below the opening level, and the chest answers
let soldOk = false;
{
  const daveCoins = await bal(T, dave);
  const ap = await tx(dave, T, APPROVE, 'approve', [C, daveCoins]);
  const s1 = await tx(dave, C, CURVE, 'sell', [daveCoins, 1n, dave]);
  const ac = await bal(T, alice);
  await tx(alice, T, APPROVE, 'approve', [C, ac]);
  const s2 = await tx(alice, C, CURVE, 'sell', [ac, 1n, alice]);
  const bc = await bal(T, bob);
  await tx(bob, T, APPROVE, 'approve', [C, bc]);
  const s3 = await tx(bob, C, CURVE, 'sell', [bc, 1n, bob]);
  soldOk = !ap.reverted && !s1.reverted && !s2.reverted && !s3.reverted;
  console.log('  sells:', soldOk ? 'ok' : 'failed ' + (s1.reason || s2.reason || s3.reason));
}
if (soldOk) {
  const resNow = await view(C, CURVE, 'realQuoteReserve'), resLaunch = await view(P, PL.abi, 'reserveAtLaunch');
  ok(resNow < resLaunch, 'the reserve fell below the opening level after the sells', `${formatEther(resNow)} < ${formatEther(resLaunch)}`);
  const d0 = await bal(T, DEAD), chestBefore = await ethBal(P);
  const df = await must(eve, P, PL.abi, 'defend', [], 'anyone triggers the chest');
  const dev = df.logs.find(l => l.eventName === 'Defended');
  ok(dev && dev.args.spent <= E(0.05) && dev.args.spent > 0n && chestBefore - (await ethBal(P)) === dev.args.spent, 'the chest spent at most 0.05 ETH');
  ok(dev && (await bal(T, DEAD)) - d0 === dev.args.coinsBurned && dev.args.coinsBurned > 0n, 'what it bought went to the dead address');
  ok(dev && dev.args.reserveAfter > dev.args.reserveBefore, 'the reserve moved back up');
  console.log(`  defended ${formatEther(dev.args.spent)} ETH · burned ${formatEther(dev.args.coinsBurned)} coins`);
  const run = await must(eve, P, PL.abi, 'run', [], 'run does sweep, collect and defend in one call');
  ok(run.logs.some(l => l.eventName === 'Swept'), 'run swept');
}

// ------------------------------------------------------------------ a pledge that misses
const cr2 = await must(bob, F, PF.abi, 'create', ['Pledge Two', 'PTWO', '', '', E(1), 2n * 3600n, 200], 'bob creates a second pledge, 1 ETH in 2 hours');
const P2 = cr2.logs.find(l => l.eventName === 'PledgeCreated').args.pledge;
await must(carol, P2, PL.abi, 'back', [], 'carol backs 0.4', E(0.4));
await must(dave, P2, PL.abi, 'back', [], 'dave backs 0.3', E(0.3));
await reverts(carol, P2, PL.abi, 'refund', [], 'still open', 'no refund before the window closes');
now += 3n * 3600n;
await reverts(eve, P2, PL.abi, 'back', [], 'window over', 'no backing after the window', E(0.1));
await reverts(eve, P2, PL.abi, 'launch', [], 'goal not met', 'cannot launch a missed pledge');
const cB = await ethBal(carol);
const rf = await must(carol, P2, PL.abi, 'refund', [], 'carol pulls her refund');
ok(rf.logs.some(l => l.eventName === 'Missed') && (await ethBal(carol)) - cB === E(0.4), 'carol got her 0.4 back and the pledge is marked missed');
const dB = await ethBal(dave);
await must(dave, P2, PL.abi, 'refund', [], 'dave pulls his refund');
ok((await ethBal(dave)) - dB === E(0.3) && (await ethBal(P2)) === 0n, 'dave got his 0.3 back, the pledge is empty');
await reverts(carol, P2, PL.abi, 'refund', [], 'nothing', 'cannot refund twice');

// ------------------------------------------------------------------ guardian and the way out
await reverts(eve, F, PF.abi, 'proposeBurner', [eve], 'guardian', 'only the guardian proposes a burner');
await must(guardian, F, PF.abi, 'proposeBurner', [addr(0xb2)], 'guardian proposes a new burner');
await reverts(eve, F, PF.abi, 'activateBurner', [], 'wait', 'a new burner waits 48 hours');
now += 48n * 3600n + 1n;
await must(eve, F, PF.abi, 'activateBurner', [], 'anyone activates it after the notice');
ok((await view(F, PF.abi, 'burner')) === addr(0xb2), 'burner rotated');
ok(!ALL.some(x => x.type === 'function' && /withdraw|rescue|recover|sweepEth|setCreator|setGoal/i.test(x.name)), 'no function moves the raise or the chest anywhere else');

console.log(`\n${pass} passed, ${fail} failed · rpc retries ${rpcRetries} · rpc calls ${rpcCalls}`);
process.exit(fail ? 1 : 0);
