import BN from "bn.js";
import { StrategyType, autoFillYByStrategy } from "@meteora-ag/dlmm";
import { getTokenInfo, getUserTokenBalanceNative, getTokenDecimals } from "./helpers.js";
import { sendTx } from "./tx.js";

export async function autoAddLpSafe({
  connection,
  dlmmPool,
  user,
  poolAddress,
  mode,
  strategyType,
  anchorAmountLamports,
  slippageBps // optional
}) {
  const publicKey = user.publicKey;
  const activeBin = await dlmmPool.getActiveBin();

  // Ambil info token dan symbol dari API Meteora
  const { tokenXSymbol, tokenYSymbol, mintX, mintY } = await getTokenInfo(poolAddress);

  // Ambil decimals langsung dari dlmmPool
  const decimalsX = dlmmPool.tokenX?.mint?.decimals ?? 6;
  const decimalsY = dlmmPool.tokenY?.mint?.decimals ?? 6;

  const strategyEnum = {
    Spot: StrategyType.Spot,
    BidAsk: StrategyType.BidAsk,
    Curve: StrategyType.Curve,
  }[strategyType];

  const anchorSide = globalThis.RUNTIME_CONFIG.ANCHOR || "X";
  let modalLamports = anchorAmountLamports;

  if (!modalLamports || modalLamports.toString() === "0") {
    modalLamports = new BN(String(Math.floor(globalThis.RUNTIME_CONFIG.MODAL_LAMPORTS)));
    if (modalLamports.isZero()) {
      console.warn("❌ Nilai modal 0 lamports. Kemungkinan salah input atau konversi. Batalkan.");
      return { skipSwap: false };
    }
  }


  let totalXAmount = new BN(0);
  let totalYAmount = new BN(0);
  let minBinId = 0;
  let maxBinId = 0;

  if (mode === "50:50") {
    const anchorAmount = modalLamports;
    const price = parseFloat(dlmmPool.fromPricePerLamport(Number(activeBin.price)));

    const counterAmount = new BN(
      Math.round((anchorAmount.toNumber() / 10 ** decimalsX) * price * 10 ** decimalsY)
    );

    totalXAmount = anchorAmount;
    totalYAmount = autoFillYByStrategy(
      activeBin.binId,
      dlmmPool.lbPair.binStep,
      totalXAmount,
      new BN(activeBin.xAmount.toString()),
      new BN(activeBin.yAmount.toString()),
      activeBin.binId - 34,
      activeBin.binId + 34,
      strategyEnum
    );
    minBinId = activeBin.binId - 34;
    maxBinId = activeBin.binId + 34;
  } else if (mode === "One Side Tokens") {
    const isX = anchorSide === "X";
    const anchorAmount = modalLamports;

    if (isX) {
      totalXAmount = anchorAmount;
      totalYAmount = autoFillYByStrategy(
        activeBin.binId,
        dlmmPool.lbPair.binStep,
        totalXAmount,
        new BN(activeBin.xAmount.toString()),
        new BN(activeBin.yAmount.toString()),
        activeBin.binId,
        activeBin.binId + 68,
        strategyEnum
      );
      minBinId = activeBin.binId;
      maxBinId = activeBin.binId + 68;
    } else {
      totalYAmount = anchorAmount;
      totalXAmount = autoFillYByStrategy(
        activeBin.binId,
        dlmmPool.lbPair.binStep,
        totalYAmount,
        new BN(activeBin.yAmount.toString()),
        new BN(activeBin.xAmount.toString()),
        activeBin.binId - 68,
        activeBin.binId,
        strategyEnum
      );
      minBinId = activeBin.binId - 68;
      maxBinId = activeBin.binId;
    }
  }

  if (totalXAmount.isZero() && totalYAmount.isZero()) {
    console.log("❌ Jumlah liquidity 0. Batalkan.");
    return { skipSwap: false };
  }

  console.log("🧾 Eksekusi Auto LP:");
  console.log(`📍 Strategi: ${strategyType}`);

  let sig;
  try {
    sig = await sendTx(
      connection,
      dlmmPool,
      user,
      totalXAmount,
      totalYAmount,
      minBinId,
      maxBinId,
      strategyEnum,
      slippageBps
    );
  
    if (!sig || typeof sig !== "string" || sig.length < 10) {
      throw new Error("Signature dari Add LP tidak valid.");
    }
    
    
  } catch (e) {
    console.warn("❌ Gagal kirim transaksi AddLiquidity:", e.message || e);
    throw e;
  }

  const txInfo = await connection.getTransaction(sig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });

  if (txInfo?.meta?.err) {
    throw new Error(`TX AddLiquidity gagal on-chain: ${JSON.stringify(txInfo.meta.err)}`);
  }

  console.log(`📨 Signature: ${sig}`);
  console.log("⏳ Menunggu konfirmasi transaksi...");
  console.log("✅ Add liquidity sukses"); 

  return {
    skipSwap: mode === "One Side Tokens" && anchorSide === "Y",
  };
}
