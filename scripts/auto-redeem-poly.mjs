/**
 * Auto-redeem resolved Polymarket positions via Gnosis Safe proxy.
 * Checks every 60s for resolved markets and redeems winning shares.
 */
import 'dotenv/config';
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';
import { Contract } from '@ethersproject/contracts';
import { Interface } from '@ethersproject/abi';
import { parseUnits } from '@ethersproject/units';
import { arrayify, hexlify, hexZeroPad } from '@ethersproject/bytes';
import { keccak256 } from '@ethersproject/keccak256';
import { defaultAbiCoder } from '@ethersproject/abi';

const POLYGON_RPC = `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY || '8kruQGYamUT6J4Ib0aMfw'}`;
const CONDITIONAL_TOKENS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const WCOL = '0x3A3BD7bb9528E159577F7C2e685CC81A765002E2'; // Wrapped collateral for negRisk
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000';
const MULTISEND = '0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761';

const MULTISEND_IFACE = new Interface([
  'function multiSend(bytes transactions)',
]);

const CTF_IFACE = new Interface([
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint[] indexSets)',
]);

const WCOL_IFACE = new Interface([
  'function unwrap(address to, uint256 amount)',
  'function balanceOf(address) view returns (uint256)',
]);

const SAFE_ABI = [
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool)',
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
];

const provider = new JsonRpcProvider(POLYGON_RPC);
const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
const FUNDER = process.env.FUNDER_ADDRESS;
const safe = new Contract(FUNDER, SAFE_ABI, wallet);

/**
 * Encode a single call for MultiSend: operation(1) + to(20) + value(32) + dataLen(32) + data
 */
function encodeMultiSendCall(to, data) {
  const op = '00'; // CALL
  const addr = to.replace('0x', '').toLowerCase().padStart(40, '0');
  const value = '0'.repeat(64); // 0 value
  const dataBytes = data.replace('0x', '');
  const dataLen = (dataBytes.length / 2).toString(16).padStart(64, '0');
  return op + addr + value + dataLen + dataBytes;
}

/**
 * Execute multiple calls in one Safe tx via MultiSend (saves gas)
 */
async function execBatchViaSafe(calls) {
  // calls = [{ to, data }, ...]
  if (calls.length === 0) return null;
  if (calls.length === 1) return execViaSafe(calls[0].to, calls[0].data);

  // Encode all calls for MultiSend
  const packed = '0x' + calls.map(c => encodeMultiSendCall(c.to, c.data)).join('');
  const multiSendData = MULTISEND_IFACE.encodeFunctionData('multiSend', [packed]);

  // Execute via Safe with operation=1 (DELEGATECALL to MultiSend)
  const nonce = await safe.nonce();
  const txHash = await safe.getTransactionHash(
    MULTISEND, 0, multiSendData, 1, // operation=1 = DELEGATECALL
    0, 0, 0, ZERO_ADDR, ZERO_ADDR, nonce,
  );
  const sig = await wallet.signMessage(arrayify(txHash));
  const sigBytes = arrayify(sig);
  sigBytes[64] += 4;
  const gasPrice = await provider.getGasPrice();

  const tx = await safe.execTransaction(
    MULTISEND, 0, multiSendData, 1, // DELEGATECALL
    0, 0, 0, ZERO_ADDR, ZERO_ADDR, hexlify(sigBytes),
    { gasLimit: 500000 + calls.length * 100000, gasPrice: (await provider.getGasPrice()).mul(110).div(100) }
  );
  return tx;
}

/**
 * Execute a transaction through the Gnosis Safe proxy
 */
async function execViaSafe(to, data) {
  const nonce = await safe.nonce();

  // Get the transaction hash the safe expects
  const txHash = await safe.getTransactionHash(
    to,           // to
    0,            // value
    data,         // data
    0,            // operation (CALL)
    0,            // safeTxGas
    0,            // baseGas
    0,            // gasPrice
    ZERO_ADDR,    // gasToken
    ZERO_ADDR,    // refundReceiver
    nonce,        // nonce
  );

  // Sign with the owner wallet
  const sig = await wallet.signMessage(arrayify(txHash));
  // Adjust v for eth_sign (add 4)
  const sigBytes = arrayify(sig);
  sigBytes[64] += 4;

  // Fixed 30 gwei gas price (cheap, Polygon always confirms)

  const tx = await safe.execTransaction(
    to, 0, data, 0, 0, 0, 0, ZERO_ADDR, ZERO_ADDR, hexlify(sigBytes),
    {
      gasLimit: 500000,
      gasPrice: (await provider.getGasPrice()).mul(110).div(100),
    }
  );
  return tx;
}

/**
 * Check and redeem resolved positions
 */
const redeemedSet = new Set(); // track already-redeemed conditionIds

async function checkAndRedeem() {
  try {
    const addr = FUNDER.toLowerCase();
    const posRes = await fetch(`https://data-api.polymarket.com/positions?user=${addr}&sizeThreshold=0.1&limit=100`);
    if (!posRes.ok) return;
    const positions = await posRes.json();

    const redeemable = (positions || []).filter(p => p.redeemable);
    if (!redeemable.length) return;

    // Group by conditionId (avoid duplicate redeems)
    const seen = new Set();
    const unique = redeemable.filter(p => {
      if (seen.has(p.conditionId) || redeemedSet.has(p.conditionId)) return false;
      seen.add(p.conditionId);
      return true;
    });

    // Calculate total redeemable value
    const totalValue = unique.reduce((sum, p) => sum + parseFloat(p.size || 0), 0);
    console.log(`[auto-redeem] ${unique.length} positions to redeem ($${totalValue.toFixed(2)} value)`);
    if (!unique.length) return;

    // Wait until $400+ in redeemable value to batch efficiently
    if (totalValue < 50) {
      console.log(`[auto-redeem] Waiting for $400 threshold ($${totalValue.toFixed(2)}/$400)`);
      return;
    }

    // Build batch of redeem calls + WCOL unwrap
    const calls = [];
    let negRiskTotal = 0;
    for (const pos of unique) {
      const collateral = pos.negativeRisk ? WCOL : USDC;
      const data = CTF_IFACE.encodeFunctionData('redeemPositions', [
        collateral, ZERO_BYTES32, pos.conditionId, [1, 2],
      ]);
      calls.push({ to: CONDITIONAL_TOKENS, data });
      if (pos.negativeRisk) negRiskTotal += parseFloat(pos.size || 0);
      console.log(`[auto-redeem] Batch: "${pos.title?.slice(0, 45)}" (${pos.outcome} ${pos.size?.toFixed(1)}sh, negRisk: ${!!pos.negativeRisk})`);
    }

    // Add WCOL unwrap to the batch if any negRisk positions
    if (negRiskTotal > 0) {
      // Use a large amount to unwrap everything (actual balance after redeems)
      const wcolAmount = Math.ceil(negRiskTotal * 1e6).toString();
      const unwrapData = WCOL_IFACE.encodeFunctionData('unwrap', [FUNDER, wcolAmount]);
      calls.push({ to: WCOL, data: unwrapData });
      console.log(`[auto-redeem] Batch: unwrap ~${negRiskTotal.toFixed(1)} WCOL → USDC`);
    }

    // Execute all redeems in one Safe transaction via MultiSend
    try {
      console.log(`[auto-redeem] Sending batch of ${calls.length} redeems...`);
      const tx = await execBatchViaSafe(calls);
      console.log(`[auto-redeem] Batch TX: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`[auto-redeem] Batch redeemed! Block ${receipt.blockNumber} (${calls.length} positions, gas: ${receipt.gasUsed.toString()})`);
      unique.forEach(p => redeemedSet.add(p.conditionId));
    } catch (e) {
      const msg = e.message?.slice(0, 250) || String(e);
      console.error(`[auto-redeem] Batch failed:`, msg.slice(0, 150));
      // Fall back to one-by-one if batch fails
      console.log(`[auto-redeem] Falling back to individual redeems...`);
      for (const pos of unique) {
        try {
          const collateral = pos.negativeRisk ? WCOL : USDC;
          const data = CTF_IFACE.encodeFunctionData('redeemPositions', [
            collateral, ZERO_BYTES32, pos.conditionId, [1, 2],
          ]);
          const tx = await execViaSafe(CONDITIONAL_TOKENS, data);
          console.log(`[auto-redeem] TX: ${tx.hash}`);
          const receipt = await tx.wait();
          console.log(`[auto-redeem] Redeemed! Block ${receipt.blockNumber}`);
          redeemedSet.add(pos.conditionId);
        } catch (e2) {
          const msg2 = e2.message?.slice(0, 150) || '';
          if (msg2.includes('reverted') || msg2.includes('already')) {
            redeemedSet.add(pos.conditionId);
          }
          console.error(`[auto-redeem] Error "${pos.title?.slice(0, 30)}":`, msg2);
        }
      }
    }

    // Unwrap any WCOL to USDC (from negRisk redeems)
    try {
      const wcolContract = new Contract(WCOL, ['function balanceOf(address) view returns (uint256)'], provider);
      const wcolBal = await wcolContract.balanceOf(FUNDER);
      if (wcolBal.gt(0)) {
        console.log(`[auto-redeem] Unwrapping ${(wcolBal / 1e6).toFixed(2)} WCOL → USDC`);
        const unwrapData = WCOL_IFACE.encodeFunctionData('unwrap', [FUNDER, wcolBal]);
        const unwrapTx = await execViaSafe(WCOL, unwrapData);
        console.log(`[auto-redeem] Unwrap TX: ${unwrapTx.hash}`);
        await unwrapTx.wait();
        console.log(`[auto-redeem] WCOL unwrapped to USDC`);
      }
    } catch (ue) {
      console.error('[auto-redeem] Unwrap error:', ue.message?.slice(0, 100));
    }
  } catch (e) {
    console.error('[auto-redeem] Error:', e.message?.slice(0, 100));
  }
}

let interval = null;

export function startAutoRedeem(intervalMs = 60000) {
  console.log(`[auto-redeem] Starting (check every ${intervalMs / 1000}s, via Gnosis Safe proxy)`);
  setTimeout(() => checkAndRedeem(), 5000); // First check after 5s
  interval = setInterval(checkAndRedeem, intervalMs);
  return interval;
}

export function stopAutoRedeem() {
  if (interval) clearInterval(interval);
}

// Run standalone
if (process.argv[1]?.includes('auto-redeem')) {
  console.log('[auto-redeem] Running standalone...');
  await checkAndRedeem();
  startAutoRedeem(60000);
}
