/**
 * Auto-redeem resolved Polymarket positions — GASLESS via Builder Relayer.
 * Polymarket pays all gas fees. No MATIC needed.
 * Checks every 3 hours, redeems all resolved positions + unwraps WCOL → USDC.
 */
import 'dotenv/config';
import { createWalletClient, createPublicClient, http, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { RelayClient } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';

const RPC = `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY || '8kruQGYamUT6J4Ib0aMfw'}`;
const FUNDER = process.env.FUNDER_ADDRESS;
const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const WCOL = '0x3A3BD7bb9528E159577F7C2e685CC81A765002E2';
const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

const account = privateKeyToAccount(process.env.PRIVATE_KEY);
const wallet = createWalletClient({ account, chain: polygon, transport: http(RPC) });
const publicClient = createPublicClient({ chain: polygon, transport: http(RPC) });
const builderConfig = new BuilderConfig({
  localBuilderCreds: {
    key: process.env.BUILDER_API_KEY,
    secret: process.env.BUILDER_SECRET,
    passphrase: process.env.BUILDER_PASSPHRASE,
  },
});
const relayClient = new RelayClient('https://relayer-v2.polymarket.com/', 137, wallet, builderConfig);

const redeemedSet = new Set();

const REDEEM_ABI = [{
  name: 'redeemPositions', type: 'function',
  inputs: [
    { name: 'collateralToken', type: 'address' },
    { name: 'parentCollectionId', type: 'bytes32' },
    { name: 'conditionId', type: 'bytes32' },
    { name: 'indexSets', type: 'uint256[]' },
  ],
  outputs: [],
}];

const UNWRAP_ABI = [{
  name: 'unwrap', type: 'function',
  inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
  outputs: [],
}];

const BALANCE_ABI = [{
  name: 'balanceOf', type: 'function', stateMutability: 'view',
  inputs: [{ name: '', type: 'address' }],
  outputs: [{ type: 'uint256' }],
}];

async function checkAndRedeem() {
  try {
    const addr = FUNDER.toLowerCase();
    const posRes = await fetch(`https://data-api.polymarket.com/positions?user=${addr}&sizeThreshold=0.01&limit=200`);
    if (!posRes.ok) return;
    const positions = await posRes.json();
    const redeemable = (positions || []).filter(p => p.redeemable && !redeemedSet.has(p.conditionId));

    // Dedupe by conditionId
    const seen = new Set();
    const unique = redeemable.filter(p => {
      if (seen.has(p.conditionId)) return false;
      seen.add(p.conditionId);
      return true;
    });

    if (!unique.length) {
      console.log('[gasless-redeem] No redeemable positions');
      return;
    }

    const totalValue = unique.reduce((sum, p) => sum + parseFloat(p.size || 0), 0);
    console.log(`[gasless-redeem] ${unique.length} positions to redeem ($${totalValue.toFixed(2)} value)`);

    // Build redeem transactions
    // Sort by size descending — redeem highest value first
    unique.sort((a, b) => parseFloat(b.size || 0) - parseFloat(a.size || 0));
    const p = unique[0];
    console.log(`[gasless-redeem] Redeeming 1/${unique.length} — highest: "${p.title?.slice(0, 40)}" ${parseFloat(p.size).toFixed(1)}sh`);
    {
      try {
        const collateral = p.negativeRisk ? WCOL : USDC;
        const tx = {
          to: CTF,
          data: encodeFunctionData({
            abi: REDEEM_ABI,
            functionName: 'redeemPositions',
            args: [collateral, ZERO_BYTES32, p.conditionId, [1n, 2n]],
          }),
          value: '0',
        };
        const res = await relayClient.execute([tx], `Redeem ${p.title?.slice(0, 30)}`);
        console.log(`[gasless-redeem] TX: ${res.hash}`);
        redeemedSet.add(p.conditionId);
        await new Promise(r => setTimeout(r, 20000));
      } catch (e2) {
        const errMsg = String(e2.message || e2 || '');
        console.error(`[gasless-redeem] Error "${p.title?.slice(0, 30)}":`, errMsg.slice(0, 100));
        if (errMsg.includes('429') || errMsg.includes('Too Many') || errMsg.includes('quota')) {
          console.log('[gasless-redeem] Rate limited — stopping until next cycle. Will NOT retry.');
          return; // exit entirely, don't burn more quota
        }
        if (errMsg.includes('reverted') || errMsg.includes('already')) {
          redeemedSet.add(p.conditionId);
        }
      }
    }

    // Unwrap any WCOL → USDC (wait 15s for all redeems to confirm, then try twice)
    for (let attempt = 0; attempt < 2; attempt++) {
      await new Promise(r => setTimeout(r, attempt === 0 ? 15000 : 10000));
      try {
        const wcolBal = await publicClient.readContract({
          address: WCOL, abi: BALANCE_ABI, functionName: 'balanceOf', args: [FUNDER],
        });
        if (wcolBal > 0n) {
          console.log(`[gasless-redeem] Unwrapping ${(Number(wcolBal) / 1e6).toFixed(2)} WCOL → USDC (attempt ${attempt + 1})...`);
          const unwrapTx = {
            to: WCOL,
            data: encodeFunctionData({ abi: UNWRAP_ABI, functionName: 'unwrap', args: [FUNDER, wcolBal] }),
            value: '0',
          };
          const unwrapRes = await relayClient.execute([unwrapTx], 'Unwrap WCOL to USDC');
          console.log(`[gasless-redeem] Unwrap TX: ${unwrapRes.hash}`);
        } else {
          break; // no WCOL, done
        }
      } catch (ue) {
        console.error('[gasless-redeem] Unwrap error:', ue.message?.slice(0, 100));
      }
    }

    console.log(`[gasless-redeem] Done! $0 gas paid.`);
  } catch (e) {
    console.error('[gasless-redeem] Error:', e.message?.slice(0, 150));
  }
}

let interval = null;

export function startGaslessRedeem(intervalMs = 10800000) { // 3 hours
  console.log(`[gasless-redeem] Starting (every ${intervalMs / 3600000}h, $0 gas via Builder Relayer)`);
  setTimeout(() => checkAndRedeem(), 5000);
  interval = setInterval(checkAndRedeem, intervalMs);
  return interval;
}

export function stopGaslessRedeem() {
  if (interval) clearInterval(interval);
}

export { checkAndRedeem as gaslessRedeem, relayClient };

// Run standalone
if (process.argv[1]?.includes('auto-redeem-gasless')) {
  console.log('[gasless-redeem] Running standalone...');
  await checkAndRedeem();
  startGaslessRedeem(3600000); // Check every hour when standalone
}
