const {createClient}=require("@supabase/supabase-js");
require("dotenv").config();
const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_KEY);

const slug = process.argv[2] || "btc-updown-5m-1772702400";

(async()=>{
  const {data, error} = await sb.from("k9_observed_trades")
    .select("id,tx_hash,outcome,shares,price,usdc_size,trade_timestamp")
    .eq("slug", slug)
    .order("id", {ascending: true});

  if (error) { console.log("Error:", error.message); return; }
  console.log(`${slug}: ${data.length} rows\n`);

  // Group by tx_hash + outcome + shares (old dedup key)
  const groups = {};
  for (const t of data) {
    const key = `${t.tx_hash}:${t.outcome}:${t.shares}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  }

  const dupeGroups = Object.entries(groups).filter(([,arr]) => arr.length > 1);
  let totalDupeRows = 0;
  let idsToDelete = [];

  for (const [key, arr] of dupeGroups) {
    const extra = arr.length - 1;
    totalDupeRows += extra;
    // Keep the first (lowest id), mark rest for deletion
    for (const t of arr.slice(1)) {
      idsToDelete.push(t.id);
    }
  }

  console.log(`Unique fill keys: ${Object.keys(groups).length}`);
  console.log(`Duplicate groups: ${dupeGroups.length}`);
  console.log(`Extra duplicate rows: ${totalDupeRows}`);
  console.log(`Rows to delete: ${idsToDelete.length}`);

  if (dupeGroups.length > 0) {
    console.log(`\nSample dupes:`);
    for (const [key, arr] of dupeGroups.slice(0, 5)) {
      console.log(`  ${key.slice(0,50)}... x${arr.length} (ids: ${arr.map(t=>t.id).join(",")})`);
    }
  }

  if (idsToDelete.length > 0) {
    console.log(`\nDeleting ${idsToDelete.length} duplicate rows...`);
    // Delete in batches of 100
    for (let i = 0; i < idsToDelete.length; i += 100) {
      const batch = idsToDelete.slice(i, i + 100);
      const {error: delErr} = await sb.from("k9_observed_trades").delete().in("id", batch);
      if (delErr) console.log("  Delete error:", delErr.message);
      else console.log(`  Deleted batch ${Math.floor(i/100)+1}: ${batch.length} rows`);
    }

    const {data: after} = await sb.from("k9_observed_trades").select("id").eq("slug", slug);
    console.log(`\nDB after cleanup: ${after.length} rows`);
  }
})();
