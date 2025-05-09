import fetch from "node-fetch";
import fs from "fs";

async function fetchMeteoraPools() {
  const url = "https://dlmm-api.meteora.ag/pair/all_with_pagination?limit=500";
  const response = await fetch(url);
  const data = await response.json();
  return data.pairs || [];
}

async function fetchJupiterPools() {
  const url = "https://datapi.jup.ag/v1/pools/toptraded/1h";
  const response = await fetch(url);
  const data = await response.json();
  return data.pools || [];
}

function normalize(value, min, max) {
  if (max === min) return 0;
  return ((value - min) / (max - min)) * 100;
}

export async function calculateMeteorScore() {
  const meteoraPools = await fetchMeteoraPools();
  const jupiterPools = await fetchJupiterPools();

  const jupiterMap = new Map();
  for (const jp of jupiterPools) {
    jupiterMap.set(jp.baseAsset.id, jp);
  }

  const combined = [];
  const debugLogs = [];

  // Ambil dari globalThis
  const minAgeMs = (globalThis.RUNTIME_CONFIG?.MIN_AGE_HOUR || 1) * 60 * 60 * 1000;
  const maxAgeMs = (globalThis.RUNTIME_CONFIG?.MAX_AGE_HOUR || 7) * 60 * 60 * 1000;
  const minMcap = globalThis.RUNTIME_CONFIG?.MIN_MCAP || 1_000_000;
  const maxMcap = globalThis.RUNTIME_CONFIG?.MAX_MCAP || 10_000_000;

  for (const pool of meteoraPools) {
    if (pool.mint_y !== "So11111111111111111111111111111111111111112") continue;
    if (pool.mint_x === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") continue;
    if (pool.mint_x === "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB") continue;

    const jupiterData = jupiterMap.get(pool.mint_x);
    if (!jupiterData) continue;
    const stats1h = jupiterData.baseAsset.stats1h || {};
    const numBuys = stats1h.numBuys || 1;
    const numOrganicBuyers = stats1h.numOrganicBuyers || 0;
    const organicRatio = numOrganicBuyers / numBuys;
    
    if (organicRatio < 0.03) continue;

    const createdAtStr = jupiterData.createdAt;
    if (!createdAtStr) continue;
    const createdAt = new Date(createdAtStr).getTime();
    const now = Date.now();
    const ageMs = now - createdAt;

    if (ageMs < minAgeMs) continue; // ❌ terlalu muda
    if (ageMs > maxAgeMs) continue; // ❌ terlalu tua

    const mcap = Number(jupiterData.baseAsset?.mcap) || 0;
    if (mcap < minMcap || mcap > maxMcap) continue;

    const symbol = jupiterData.baseAsset.symbol;
    const baseMint = jupiterData.baseAsset.id;
    const stats5m = jupiterData.baseAsset.stats5m || {};
    const stats6h = jupiterData.baseAsset.stats6h || {};
    const stats24h = jupiterData.baseAsset.stats24h || {};

    const trades5m = ((stats5m.numBuys || 0) + (stats5m.numSells || 0)) / 5;
    const trades1h = ((stats1h.numBuys || 0) + (stats1h.numSells || 0)) / 60;
    const trades6h = ((stats6h.numBuys || 0) + (stats6h.numSells || 0)) / 360;
    const trades24h = ((stats24h.numBuys || 0) + (stats24h.numSells || 0)) / 1440;
    const avgTradesPerMinute = (trades5m + trades1h + trades6h + trades24h) / 4;

    const mintX = pool.mint_x;
    const fees5m = (pool.fees?.min_30 || 0) * (5 / 30) / 5;
    const fees1h = (pool.fees?.hour_1 || 0) / 60;
    const fees6h = (pool.fees?.hour_6 || 0) / 360;
    const fees24h = (pool.fees?.hour_24 || 0) / 1440;
    const avgFeesPerMinute = (fees5m + fees1h + fees6h + fees24h) / 4;

    const liquidity = parseFloat(pool.liquidity) || 0;

    combined.push({
      address: pool.address,
      symbol: jupiterData.baseAsset.symbol,
      mintX: jupiterData.baseAsset.id,
      avgTradesPerMinute,
      avgFeesPerMinute,
      liquidity,
    });
  }

  if (combined.length === 0) {
    console.error("❌ Tidak ada pool SOL yang lolos filter!");
    fs.writeFileSync("meteor_score_v2.json", JSON.stringify([], null, 2)); // Kosongkan file
    return;
  }

  const tradesMin = Math.min(...combined.map(p => p.avgTradesPerMinute));
  const tradesMax = Math.max(...combined.map(p => p.avgTradesPerMinute));
  const feesMin = Math.min(...combined.map(p => p.avgFeesPerMinute));
  const feesMax = Math.max(...combined.map(p => p.avgFeesPerMinute));
  const liquidityMin = Math.min(...combined.map(p => p.liquidity));
  const liquidityMax = Math.max(...combined.map(p => p.liquidity));

  for (const pool of combined) {
    const normTrades = normalize(pool.avgTradesPerMinute, tradesMin, tradesMax);
    const normFees = normalize(pool.avgFeesPerMinute, feesMin, feesMax);
    const normLiquidity = normalize(pool.liquidity, liquidityMin, liquidityMax);

    pool.meteorScore = (0.4 * normTrades) + (0.4 * normFees) + (0.2 * normLiquidity);
  }

  combined.sort((a, b) => b.meteorScore - a.meteorScore);
  const MIN_SCORE = 30;
  const uniqueByMintX = new Map();
  for (const pool of combined) {
    const existing = uniqueByMintX.get(pool.mintX);
    if (!existing || pool.meteorScore > existing.meteorScore) {
      uniqueByMintX.set(pool.mintX, pool);
    }
  }

  const finalPools = Array.from(uniqueByMintX.values())
    .filter(p => p.meteorScore >= MIN_SCORE);

  fs.writeFileSync("meteor_score_v2.json", JSON.stringify(finalPools, null, 2));
}
