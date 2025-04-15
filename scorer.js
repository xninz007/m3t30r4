
// File: scorer.js

export function getTokenScore(token) {
  const stats = token.baseAsset.stats1h || {};
  const volume = token.volume24h || 0;
  const mcap = token.baseAsset.mcap || 0;
  const liquidity = token.baseAsset.liquidity || 0;
  const organicBuyers = stats.numOrganicBuyers || 0;
  const numBuyers = stats.numBuyers || 1;
  const priceChange = stats.priceChange || 0;
  const createdAt = new Date(token.baseAsset.firstPool?.createdAt || 0);
  const ageMinutes = (Date.now() - createdAt.getTime()) / 1000 / 60;

  // Scoring logic
  const volumeScore = Math.log10(volume + 1);
  const mcapScore = Math.log10(mcap + 1);
  const liquidityScore = liquidity < 200000 ? 2 : 1;
  const buyersScore = organicBuyers / numBuyers;
  const growthScore = priceChange > 0 ? priceChange / 10 : 0;
  const agePenalty = ageMinutes < 10 ? 3 : ageMinutes < 60 ? 1 : 0;

  const totalScore =
    volumeScore + mcapScore + liquidityScore + buyersScore + growthScore - agePenalty;

  return totalScore;
}
