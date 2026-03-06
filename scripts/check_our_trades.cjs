const {createClient}=require("@supabase/supabase-js");
require("dotenv").config();
const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_KEY);

const slug = process.argv[2] || "";

(async()=>{
  // Check the trades table for our orders (paper or real)
  let query = sb.from("polymarket_trades").select("*").order("created_at",{ascending:false}).limit(30);
  if(slug) query = sb.from("polymarket_trades").select("*").like("polymarket_event_id","%"+slug+"%").order("created_at",{ascending:true});

  const {data,error}=await query;
  if(error){console.log("Error:",error.message);return;}
  if(!data||data.length===0){
    console.log("No trades found"+(slug?" for "+slug:""));
    // Also check other table names
    const tables = ["orders","paper_trades","sim_trades","k9_sim_trades"];
    for(const tbl of tables){
      const {data:d2,error:e2}=await sb.from(tbl).select("*").limit(1);
      if(!e2 && d2) console.log("Table '"+tbl+"' exists, "+d2.length+" sample rows");
      else console.log("Table '"+tbl+"': "+(e2?e2.message:"empty"));
    }
    return;
  }
  console.log("=== Our trades ===");
  console.log("Count:",data.length);
  for(const t of data){
    console.log(
      (t.side||t.order_side||"?"),
      (t.outcome||"?"),
      "shares="+(t.shares||t.size||"?"),
      "$"+(t.usdc_size||t.cost||"?"),
      "type="+(t.order_type||"?"),
      "slug="+(t.polymarket_event_id||t.market_slug||"?"),
      "ts="+t.created_at
    );
  }
})();
