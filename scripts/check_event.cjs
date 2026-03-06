const {createClient}=require("@supabase/supabase-js");
require("dotenv").config();
const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_KEY);

const slug = process.argv[2] || "btc-updown-5m-1772699100";

(async()=>{
  const {data,error}=await sb.from("k9_observed_trades").select("*").eq("slug",slug).order("trade_timestamp",{ascending:true});
  if(error){console.log("Error:",error.message);return;}
  if(!data || data.length===0){console.log("No trades found for",slug);return;}

  const buys=data.filter(t=>parseFloat(t.shares)>0);
  const sells=data.filter(t=>parseFloat(t.shares)<0);
  const upBuys=buys.filter(t=>t.outcome==="Up");
  const downBuys=buys.filter(t=>t.outcome==="Down");
  const upSells=sells.filter(t=>t.outcome==="Up");
  const downSells=sells.filter(t=>t.outcome==="Down");

  const sum=(arr,f)=>arr.reduce((s,t)=>s+Math.abs(parseFloat(t[f])),0);

  console.log("=== k9 Trades: "+slug+" ===");
  console.log("Total:",data.length,"trades (buys="+buys.length+", sells="+sells.length+")");
  console.log("Unique txs:",new Set(data.map(t=>t.tx_hash)).size);
  console.log("");
  console.log("Up:  buy="+sum(upBuys,"shares").toFixed(1)+" shares ("+upBuys.length+" fills) $"+sum(upBuys,"usdc_size").toFixed(2));
  console.log("     sell="+sum(upSells,"shares").toFixed(1)+" shares ("+upSells.length+" fills) $"+sum(upSells,"usdc_size").toFixed(2));
  console.log("Down: buy="+sum(downBuys,"shares").toFixed(1)+" shares ("+downBuys.length+" fills) $"+sum(downBuys,"usdc_size").toFixed(2));
  console.log("      sell="+sum(downSells,"shares").toFixed(1)+" shares ("+downSells.length+" fills) $"+sum(downSells,"usdc_size").toFixed(2));

  let lags=[];
  for(const t of data){
    const ts=parseInt(t.trade_timestamp);
    const created=Math.floor(new Date(t.created_at).getTime()/1000);
    lags.push(created-ts);
  }
  console.log("");
  console.log("Lag: min="+Math.min(...lags)+"s max="+Math.max(...lags)+"s avg="+(lags.reduce((a,b)=>a+b,0)/lags.length).toFixed(1)+"s");
  console.log("First trade:",new Date(parseInt(data[0].trade_timestamp)*1000).toISOString());
  console.log("Last trade:",new Date(parseInt(data[data.length-1].trade_timestamp)*1000).toISOString());

  // Net position
  const upNet = sum(upBuys,"shares") - sum(upSells,"shares");
  const downNet = sum(downBuys,"shares") - sum(downSells,"shares");
  const upCost = sum(upBuys,"usdc_size") - sum(upSells,"usdc_size");
  const downCost = sum(downBuys,"usdc_size") - sum(downSells,"usdc_size");
  console.log("");
  console.log("Net position: Up="+upNet.toFixed(1)+" shares ($"+upCost.toFixed(2)+"), Down="+downNet.toFixed(1)+" shares ($"+downCost.toFixed(2)+")");
  console.log("Total spent: $"+(upCost+downCost).toFixed(2));
})();
