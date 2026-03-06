#!/usr/bin/env python3
"""
Split USDC into Up + Down outcome tokens via the CTF contract.

Calls CTF.splitPosition(collateralToken, parentCollectionId, conditionId, [1,2], amount)
through the Safe wallet's execTransaction.

Usage:
    python3 split-position.py <private_key> <safe_address> <condition_id> <amount_usdc>

Returns JSON:
    {"success": true, "tx_hash": "0x...", "amount": 5.0}
"""
import sys
import os
import json
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import cloudflare_bypass  # noqa: F401
except ImportError:
    pass

from web3 import Web3
from eth_account import Account
from eth_abi import encode as abi_encode
from eth_utils import keccak

# -- Constants ----------------------------------------------------------------
POLYGON_RPC = os.getenv("POLYGON_RPC_URL", "https://polygon-bor-rpc.publicnode.com")

CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"

ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
ZERO_BYTES32 = b'\x00' * 32
MAX_UINT256 = 2**256 - 1

SAFE_TX_TYPEHASH = keccak(
    text="SafeTx(address to,uint256 value,bytes data,uint8 operation,"
         "uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,"
         "address gasToken,address refundReceiver,uint256 nonce)"
)

# -- Minimal ABIs -------------------------------------------------------------
SAFE_ABI = json.loads("""[
  {"inputs":[],"name":"nonce","outputs":[{"type":"uint256"}],
   "stateMutability":"view","type":"function"},
  {"inputs":[],"name":"domainSeparator","outputs":[{"type":"bytes32"}],
   "stateMutability":"view","type":"function"},
  {"inputs":[
    {"name":"to","type":"address"},
    {"name":"value","type":"uint256"},
    {"name":"data","type":"bytes"},
    {"name":"operation","type":"uint8"},
    {"name":"safeTxGas","type":"uint256"},
    {"name":"baseGas","type":"uint256"},
    {"name":"gasPrice","type":"uint256"},
    {"name":"gasToken","type":"address"},
    {"name":"refundReceiver","type":"address"},
    {"name":"signatures","type":"bytes"}
  ],"name":"execTransaction","outputs":[{"type":"bool"}],
   "stateMutability":"payable","type":"function"}
]""")

CTF_SPLIT_ABI = json.loads("""[
  {"inputs":[
    {"name":"collateralToken","type":"address"},
    {"name":"parentCollectionId","type":"bytes32"},
    {"name":"conditionId","type":"bytes32"},
    {"name":"partition","type":"uint256[]"},
    {"name":"amount","type":"uint256"}
  ],"name":"splitPosition","outputs":[],
   "stateMutability":"nonpayable","type":"function"}
]""")

USDC_ABI = json.loads("""[
  {"inputs":[
    {"name":"spender","type":"address"},
    {"name":"amount","type":"uint256"}
  ],"name":"approve","outputs":[{"type":"bool"}],
   "stateMutability":"nonpayable","type":"function"},
  {"inputs":[
    {"name":"owner","type":"address"},
    {"name":"spender","type":"address"}
  ],"name":"allowance","outputs":[{"type":"uint256"}],
   "stateMutability":"view","type":"function"}
]""")


def rpc_call_with_retry(fn, max_retries=3, base_delay=12):
    for attempt in range(max_retries):
        try:
            return fn()
        except Exception as e:
            err_str = str(e).lower()
            if "too many requests" in err_str or "rate limit" in err_str or "-32090" in err_str:
                delay = base_delay * (attempt + 1)
                time.sleep(delay)
                continue
            raise
    return fn()


def sign_safe_tx(w3, account, safe_contract, to, data_bytes):
    nonce = safe_contract.functions.nonce().call()
    domain_sep = bytes(safe_contract.functions.domainSeparator().call())
    data_hash = keccak(data_bytes) if data_bytes else keccak(b'')

    encoded_struct = abi_encode(
        ['bytes32', 'address', 'uint256', 'bytes32', 'uint8',
         'uint256', 'uint256', 'uint256', 'address', 'address', 'uint256'],
        [SAFE_TX_TYPEHASH, w3.to_checksum_address(to), 0, data_hash,
         0, 0, 0, 0, ZERO_ADDRESS, ZERO_ADDRESS, nonce],
    )

    safe_tx_hash = keccak(b'\x19\x01' + domain_sep + keccak(encoded_struct))
    signed = Account.unsafe_sign_hash(safe_tx_hash, account.key)

    return (
        signed.r.to_bytes(32, 'big')
        + signed.s.to_bytes(32, 'big')
        + bytes([signed.v])
    )


def exec_safe_tx(w3, account, safe_contract, target, data_hex):
    data_bytes = bytes.fromhex(data_hex[2:] if data_hex.startswith("0x") else data_hex)

    signature = rpc_call_with_retry(
        lambda: sign_safe_tx(w3, account, safe_contract, target, data_bytes)
    )

    gas_price = rpc_call_with_retry(lambda: w3.eth.gas_price)
    base_fee = int(gas_price * 1.5)
    max_fee = max(base_fee, w3.to_wei(80, 'gwei'))

    signer_balance = rpc_call_with_retry(lambda: w3.eth.get_balance(account.address))
    est_cost = 400_000 * max_fee
    if signer_balance < est_cost:
        matic_bal = signer_balance / 1e18
        matic_cost = est_cost / 1e18
        raise Exception(
            f"Not enough MATIC: have {matic_bal:.4f}, need ~{matic_cost:.4f}. "
            f"Send POL/MATIC to {account.address}"
        )

    # Use fixed nonce so replacement uses same nonce with higher gas
    nonce = rpc_call_with_retry(lambda: w3.eth.get_transaction_count(account.address))

    def build_and_send(use_max_fee):
        tx = safe_contract.functions.execTransaction(
            w3.to_checksum_address(target),
            0, data_bytes, 0, 0, 0, 0,
            ZERO_ADDRESS, ZERO_ADDRESS, signature,
        ).build_transaction({
            'from': account.address,
            'nonce': nonce,
            'gas': 400_000,
            'maxFeePerGas': use_max_fee,
            'maxPriorityFeePerGas': min(use_max_fee, use_max_fee),
        })
        signed_tx = account.sign_transaction(tx)
        return w3.eth.send_raw_transaction(signed_tx.raw_transaction)

    # Retry with escalating gas on replacement underpriced (stuck tx)
    tx_hash = None
    for attempt in range(6):
        try:
            fee_mult = 2 ** attempt
            fee = max(max_fee * fee_mult, w3.to_wei(50 * (attempt + 1), 'gwei'))
            tx_hash = rpc_call_with_retry(lambda f=fee: build_and_send(f))
            break
        except Exception as e:
            err_str = str(e).lower()
            if "replacement transaction underpriced" in err_str or "nonce too low" in err_str:
                if attempt < 5:
                    time.sleep(4 + attempt * 3)
                    continue
            raise
    if tx_hash is None:
        raise Exception("Failed to send transaction after retries")

    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
    return receipt


def ensure_usdc_approval(w3, account, safe_contract, safe_address, amount_wei):
    """Check USDC allowance to CTF and approve if needed."""
    usdc = w3.eth.contract(address=w3.to_checksum_address(USDC_ADDRESS), abi=USDC_ABI)

    allowance = rpc_call_with_retry(
        lambda: usdc.functions.allowance(
            w3.to_checksum_address(safe_address),
            w3.to_checksum_address(CTF_ADDRESS),
        ).call()
    )

    if allowance >= amount_wei:
        return  # Already approved

    # Approve max to CTF
    approve_calldata = usdc.encode_abi(
        abi_element_identifier="approve",
        args=[w3.to_checksum_address(CTF_ADDRESS), MAX_UINT256],
    )

    receipt = exec_safe_tx(w3, account, safe_contract, USDC_ADDRESS, approve_calldata)
    if receipt.status != 1:
        raise Exception(f"USDC approval reverted (tx: {receipt.transactionHash.hex()})")

    # Brief delay for state propagation
    time.sleep(3)


def main():
    try:
        private_key = sys.argv[1]
        safe_address = sys.argv[2]
        condition_id = sys.argv[3]
        amount_usdc = float(sys.argv[4])

        w3 = Web3(Web3.HTTPProvider(POLYGON_RPC))
        if not w3.is_connected():
            print(json.dumps({"success": False, "error": "Cannot connect to Polygon RPC"}))
            sys.exit(1)

        account = Account.from_key(private_key)
        safe_contract = w3.eth.contract(
            address=w3.to_checksum_address(safe_address),
            abi=SAFE_ABI,
        )

        amount_wei = int(amount_usdc * 1e6)

        # Ensure USDC is approved for CTF
        ensure_usdc_approval(w3, account, safe_contract, safe_address, amount_wei)

        # Build splitPosition calldata
        cid_hex = condition_id[2:] if condition_id.startswith("0x") else condition_id
        cid_bytes = bytes.fromhex(cid_hex)

        ctf = w3.eth.contract(address=w3.to_checksum_address(CTF_ADDRESS), abi=CTF_SPLIT_ABI)
        calldata = ctf.encode_abi(
            abi_element_identifier="splitPosition",
            args=[
                w3.to_checksum_address(USDC_ADDRESS),
                ZERO_BYTES32,
                cid_bytes,
                [1, 2],  # Binary partition: outcome 0 and outcome 1
                amount_wei,
            ],
        )

        # Execute through Safe
        receipt = exec_safe_tx(w3, account, safe_contract, CTF_ADDRESS, calldata)

        if receipt.status == 1:
            print(json.dumps({
                "success": True,
                "tx_hash": receipt.transactionHash.hex(),
                "amount": amount_usdc,
            }))
        else:
            print(json.dumps({
                "success": False,
                "error": f"splitPosition reverted (tx: {receipt.transactionHash.hex()})",
                "tx_hash": receipt.transactionHash.hex(),
            }))
            sys.exit(1)

    except Exception as e:
        print(json.dumps({
            "success": False,
            "error": str(e),
            "trace": traceback.format_exc(),
        }))
        sys.exit(1)


if __name__ == "__main__":
    main()
