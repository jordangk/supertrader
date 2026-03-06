require("dotenv").config();
const ALCHEMY = `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY || '8kruQGYamUT6J4Ib0aMfw'}`;
const txHash = process.argv[2];
if (!txHash) { console.log("Usage: node decode_tx.cjs <txHash>"); process.exit(1); }

const WALLET = "0x53d395d95538d7b0a6346770378c79001e2360ee";
const REBATE = "0xe3f18acc55091e2c48d883fc8c8413319d4ab7b0";
const CTF = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
const CTF_EXCHANGE = "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e";
const USDC = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
const TRANSFER_SINGLE = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";
const ERC20_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

(async () => {
  const resp = await fetch(ALCHEMY, {
    method: "POST", headers: {"Content-Type":"application/json"},
    body: JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_getTransactionReceipt",params:[txHash]}),
  });
  const r = (await resp.json()).result;
  if (!r) { console.log("Tx not found"); return; }

  console.log("Status:", r.status === "0x1" ? "SUCCESS" : "FAILED");
  console.log("From:", r.from);
  console.log("To:", r.to);
  console.log("Gas used:", parseInt(r.gasUsed, 16));
  console.log("Logs:", r.logs.length);
  console.log("");

  let usdcIn = 0, usdcOut = 0;
  let tokensIn = 0, tokensOut = 0;
  let rebateTokens = 0;
  let exchangeTokens = 0;

  for (const log of r.logs) {
    const addr = log.address.toLowerCase();
    if (addr === USDC && log.topics[0] === ERC20_TRANSFER) {
      const from = "0x" + log.topics[1].slice(-40).toLowerCase();
      const to = "0x" + log.topics[2].slice(-40).toLowerCase();
      const amount = Number(BigInt(log.data)) / 1e6;
      if (from === WALLET) { usdcOut += amount; console.log("USDC OUT:", amount.toFixed(2), "->", to.slice(0,10)); }
      if (to === WALLET) { usdcIn += amount; console.log("USDC IN:", amount.toFixed(2), "<-", from.slice(0,10)); }
    }
    if (log.topics[0] === TRANSFER_SINGLE && addr === CTF) {
      const from = "0x" + log.topics[2].slice(-40).toLowerCase();
      const to = "0x" + log.topics[3].slice(-40).toLowerCase();
      const data = log.data.slice(2);
      const tokenId = BigInt("0x" + data.slice(0, 64)).toString();
      const amount = Number(BigInt("0x" + data.slice(64, 128))) / 1e6;
      if (to === WALLET) {
        tokensIn += amount;
        if (from === REBATE) {
          rebateTokens += amount;
          console.log("REBATE TOKEN IN:", amount.toFixed(2), "shares");
        } else if (from === CTF_EXCHANGE) {
          exchangeTokens += amount;
          console.log("EXCHANGE TOKEN IN:", amount.toFixed(2), "shares");
        } else {
          console.log("TOKEN IN:", amount.toFixed(2), "shares from", from.slice(0,10));
        }
      }
      if (from === WALLET) {
        tokensOut += amount;
        console.log("TOKEN OUT:", amount.toFixed(2), "shares to", to.slice(0,10));
      }
    }
  }
  console.log("");
  console.log("=== SUMMARY ===");
  console.log("USDC spent:", usdcOut.toFixed(2));
  console.log("USDC received:", usdcIn.toFixed(2));
  console.log("Tokens from exchange:", exchangeTokens.toFixed(2));
  console.log("Tokens from rebate:", rebateTokens.toFixed(2));
  console.log("Total tokens in:", tokensIn.toFixed(2));
  console.log("Tokens sent out:", tokensOut.toFixed(2));
  if (exchangeTokens > 0) {
    console.log("Rebate rate:", ((rebateTokens / exchangeTokens) * 100).toFixed(2) + "%");
  }
  console.log("Net tokens:", (tokensIn - tokensOut).toFixed(2));
})();
