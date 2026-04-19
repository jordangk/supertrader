/**
 * Auto-redeem resolved Polymarket positions.
 * Tries gasless (Builder Relayer) first. Falls back to gas (POL) if rate limited.
 */
import 'dotenv/config';
import { createWalletClient, createPublicClient, http, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { RelayClient } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';
import { Contract } from '@ethersproject/contracts';
import { Interface } from '@ethersproject/abi';
import { hexlify, arrayify } from '@ethersproject/bytes';

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
let rateLimitedUntil = 0;

// Gas fallback setup
const gasProvider = new JsonRpcProvider(RPC);
const gasWallet = new Wallet(process.env.PRIVATE_KEY, gasProvider);
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const SAFE_ABI = [
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool)',
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
];
const safe = new Contract(FUNDER, SAFE_ABI, gasWallet);
const CTF_IFACE = new Interface(['function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint[] indexSets)']);
const WCOL_IFACE_GAS = new Interface(['function unwrap(address to, uint256 amount)']);

async function redeemWithGas(conditionId, negativeRisk, title) {
  const collateral = negativeRisk ? WCOL : USDC;
  const data = CTF_IFACE.encodeFunctionData('redeemPositions', [collateral, '0x' + '0'.repeat(64), conditionId, [1, 2]]);
  const nonce = await safe.nonce();
  const txHash = await safe.getTransactionHash(CTF, 0, data, 0, 0, 0, 0, ZERO_ADDR, ZERO_ADDR, nonce);
  const sig = await gasWallet.signMessage(arrayify(txHash));
  const sigBytes = arrayify(sig);
  sigBytes[64] += 4;
  const gasPrice = await gasProvider.getGasPrice();
  const tx = await safe.execTransaction(CTF, 0, data, 0, 0, 0, 0, ZERO_ADDR, ZERO_ADDR, hexlify(sigBytes), { gasLimit: 200000, gasPrice: gasPrice.mul(110).div(100) });
  const receipt = await tx.wait();
  return receipt.status === 1;
}

async function unwrapWithGas() {
  const wcolC = new Contract(WCOL, ['function balanceOf(address) view returns (uint256)'], gasProvider);
  const wcolBal = await wcolC.balanceOf(FUNDER);
  if (wcolBal.gt(0)) {
    const unwrapData = WCOL_IFACE_GAS.encodeFunctionData('unwrap', [FUNDER, wcolBal]);
    const nonce = await safe.nonce();
    const txHash = await safe.getTransactionHash(WCOL, 0, unwrapData, 0, 0, 0, 0, ZERO_ADDR, ZERO_ADDR, nonce);
    const sig = await gasWallet.signMessage(arrayify(txHash));
    const sigBytes = arrayify(sig);
    sigBytes[64] += 4;
    const gasPrice = await gasProvider.getGasPrice();
    const tx = await safe.execTransaction(WCOL, 0, unwrapData, 0, 0, 0, 0, ZERO_ADDR, ZERO_ADDR, hexlify(sigBytes), { gasLimit: 200000, gasPrice: gasPrice.mul(110).div(100) });
    await tx.wait();
    console.log(`[auto-redeem] Unwrapped $${(wcolBal / 1e6).toFixed(2)} WCOL (gas)`);
  }
}

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
    // If rate limited, use gas fallback instead of waiting
    const useGasFallback = Date.now() < rateLimitedUntil;

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

    // Always check for stuck WCOL, even if nothing to redeem
    if (!unique.length) {
      try { await unwrapWithGas(); } catch {}
      return;
    }

    const totalValue = unique.reduce((sum, p) => sum + parseFloat(p.size || 0), 0);

    // If >$200 redeemable AND we have enough POL for gas, bulk redeem with gas
    let polBal = 0n;
    try { polBal = await gasProvider.getBalance(gasWallet.address); } catch {}
    const hasGasFunds = polBal > 5n * 10n ** 16n; // >0.05 POL (~50 txs headroom)
    if (totalValue > 200 && hasGasFunds) {
      console.log(`[auto-redeem] $${totalValue.toFixed(0)} pending > $200 — bulk gas redeem ALL ${unique.length} positions`);
      for (const p of unique) {
        try {
          const ok = await redeemWithGas(p.conditionId, p.negativeRisk, p.title);
          if (ok) {
            console.log(`[auto-redeem] OK (gas bulk) ${p.title?.slice(0, 40)} | ${parseFloat(p.size).toFixed(1)}sh`);
            redeemedSet.add(p.conditionId);
          }
          await new Promise(r => setTimeout(r, 3000)); // 3s between to avoid nonce issues
        } catch (e) {
          console.error(`[auto-redeem] Gas bulk err: ${String(e.message || '').slice(0, 50)}`);
        }
      }
      try { await unwrapWithGas(); } catch {}
      console.log(`[auto-redeem] Bulk done`);
      return;
    }

    console.log(`[gasless-redeem] ${unique.length} positions to redeem ($${totalValue.toFixed(2)} value)`);

    // Build redeem transactions
    // Sort by size descending — redeem highest value first
    unique.sort((a, b) => parseFloat(b.size || 0) - parseFloat(a.size || 0));
    const p = unique[0];
    const useGas = useGasFallback;
    const method = useGas ? 'gas' : 'gasless';
    console.log(`[auto-redeem] Redeeming 1/${unique.length} via ${method} — "${p.title?.slice(0, 40)}" ${parseFloat(p.size).toFixed(1)}sh`);

    if (useGas) {
      // Gas fallback
      try {
        const ok = await redeemWithGas(p.conditionId, p.negativeRisk, p.title);
        console.log(`[auto-redeem] ${ok ? 'OK' : 'FAIL'} (gas) ${p.title?.slice(0, 40)}`);
        if (ok) redeemedSet.add(p.conditionId);
      } catch (e) {
        const msg = String(e.message || '');
        if (msg.includes('insufficient funds')) {
          console.log('[auto-redeem] Out of POL — waiting for gasless quota reset');
        } else {
          console.error('[auto-redeem] Gas error:', msg.slice(0, 80));
        }
      }
    } else {
      // Gasless (relayer)
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
        console.log(`[auto-redeem] OK (gasless) TX: ${res.hash?.slice(0, 14)}`);
        redeemedSet.add(p.conditionId);
      } catch (e2) {
        const errMsg = String(e2.message || e2 || '');
        if (errMsg.includes('429') || errMsg.includes('Too Many') || errMsg.includes('quota')) {
          const resetMatch = errMsg.match(/resets in (\d+)/);
          const resetSecs = resetMatch ? parseInt(resetMatch[1]) : 3600;
          rateLimitedUntil = Date.now() + resetSecs * 1000;
          console.log(`[auto-redeem] Rate limited — switching to gas for ${Math.round(resetSecs / 60)}min`);
          // Immediately try gas for this one
          try {
            const ok = await redeemWithGas(p.conditionId, p.negativeRisk, p.title);
            console.log(`[auto-redeem] ${ok ? 'OK' : 'FAIL'} (gas fallback) ${p.title?.slice(0, 40)}`);
            if (ok) redeemedSet.add(p.conditionId);
          } catch (ge) {
            console.error('[auto-redeem] Gas fallback error:', String(ge.message || '').slice(0, 60));
          }
          return;
        }
        if (errMsg.includes('reverted') || errMsg.includes('already')) {
          redeemedSet.add(p.conditionId);
        }
      }
    }

    // Unwrap any WCOL → USDC
    await new Promise(r => setTimeout(r, 15000));
    try {
      if (Date.now() < rateLimitedUntil) {
        await unwrapWithGas();
      } else {
        const wcolBal = await publicClient.readContract({
          address: WCOL, abi: BALANCE_ABI, functionName: 'balanceOf', args: [FUNDER],
        });
        if (wcolBal > 0n) {
          console.log(`[auto-redeem] Unwrapping ${(Number(wcolBal) / 1e6).toFixed(2)} WCOL (gasless)...`);
          const unwrapTx = { to: WCOL, data: encodeFunctionData({ abi: UNWRAP_ABI, functionName: 'unwrap', args: [FUNDER, wcolBal] }), value: '0' };
          await relayClient.execute([unwrapTx], 'Unwrap WCOL');
          console.log(`[auto-redeem] Unwrapped (gasless)`);
        }
      }
    } catch (ue) {
      try { await unwrapWithGas(); } catch {}
    }

    console.log(`[auto-redeem] Done`);
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
