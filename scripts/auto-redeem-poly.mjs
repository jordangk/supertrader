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
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

const CTF_IFACE = new Interface([
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint[] indexSets)',
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

  // Use legacy gas pricing (more reliable on Polygon)
  const gasPrice = await provider.getGasPrice();

  const tx = await safe.execTransaction(
    to, 0, data, 0, 0, 0, 0, ZERO_ADDR, ZERO_ADDR, hexlify(sigBytes),
    {
      gasLimit: 500000,
      gasPrice: gasPrice.mul(2),
    }
  );
  return tx;
}

/**
 * Check and redeem resolved positions
 */
async function checkAndRedeem() {
  try {
    const addr = FUNDER.toLowerCase();
    const posRes = await fetch(`https://data-api.polymarket.com/positions?user=${addr}&sizeThreshold=0.1&limit=100`);
    if (!posRes.ok) return;
    const positions = await posRes.json();

    const redeemable = (positions || []).filter(p => p.redeemable && p.curPrice === 1);
    if (!redeemable.length) return;

    // Group by conditionId (avoid duplicate redeems)
    const seen = new Set();
    const unique = redeemable.filter(p => {
      if (seen.has(p.conditionId)) return false;
      seen.add(p.conditionId);
      return true;
    });

    console.log(`[auto-redeem] ${unique.length} positions to redeem`);

    for (const pos of unique) {
      try {
        // Encode redeemPositions call
        const data = CTF_IFACE.encodeFunctionData('redeemPositions', [
          USDC,
          ZERO_BYTES32,
          pos.conditionId,
          [1, 2], // indexSets for 2-outcome markets
        ]);

        console.log(`[auto-redeem] Redeeming "${pos.title?.slice(0, 50)}" (${pos.outcome} ${pos.size?.toFixed(1)} shares)`);

        const tx = await execViaSafe(CONDITIONAL_TOKENS, data);
        console.log(`[auto-redeem] TX: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`[auto-redeem] Redeemed! Block ${receipt.blockNumber}`);
      } catch (e) {
        const msg = e.message?.slice(0, 250) || String(e);
        if (msg.includes('reverted') || msg.includes('already')) {
          console.log(`[auto-redeem] Skip "${pos.title?.slice(0, 30)}": already redeemed`);
        } else if (msg.includes('insufficient funds')) {
          // Try with explicit nonce and higher gas
          try {
            const nonce2 = await provider.getTransactionCount(wallet.address, 'pending');
            const gp = await provider.getGasPrice();
            console.log(`[auto-redeem] Retrying with nonce=${nonce2} gasPrice=${gp.toString()}`);
            const data2 = CTF_IFACE.encodeFunctionData('redeemPositions', [USDC, ZERO_BYTES32, pos.conditionId, [1, 2]]);
            const nonce3 = await safe.nonce();
            const txHash2 = await safe.getTransactionHash(CONDITIONAL_TOKENS, 0, data2, 0, 0, 0, 0, ZERO_ADDR, ZERO_ADDR, nonce3);
            const sig2 = await wallet.signMessage(arrayify(txHash2));
            const sigBytes2 = arrayify(sig2);
            sigBytes2[64] += 4;
            const tx2 = await safe.execTransaction(
              CONDITIONAL_TOKENS, 0, data2, 0, 0, 0, 0, ZERO_ADDR, ZERO_ADDR, hexlify(sigBytes2),
              { gasLimit: 500000, gasPrice: gp.mul(2), nonce: nonce2 }
            );
            console.log(`[auto-redeem] Retry TX: ${tx2.hash}`);
            const receipt2 = await tx2.wait();
            console.log(`[auto-redeem] Retry redeemed! Block ${receipt2.blockNumber}`);
          } catch (e2) {
            console.error(`[auto-redeem] Retry also failed "${pos.title?.slice(0, 30)}":`, e2.message?.slice(0, 150));
          }
        } else {
          console.error(`[auto-redeem] Error "${pos.title?.slice(0, 30)}":`, msg);
        }
      }
    }

    // DISABLED — was killing snipe limit orders on Poly
    // Stale order cleanup moved to snipe manager instead
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
