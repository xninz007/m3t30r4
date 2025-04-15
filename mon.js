import { Connection, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import { RPC } from "./config.js";
import { getPriceUsdMap, getUserTokenBalanceNative } from "./utils.js";
import { getPriorityInstructions } from "./lib/fee.js";
import { autoSwap } from "./autoswap.js";
import DLMM from "@meteora-ag/dlmm";
import BN from "bn.js";
import fs from "fs";

const connection = new Connection(RPC);
const pnlStorePath = "./pnl.json";
const pnlStore = fs.existsSync(pnlStorePath)
  ? JSON.parse(fs.readFileSync(pnlStorePath, "utf8"))
  : {};

const pendingRemove = new Set();
const pendingSwap = new Set();

export function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

export async function monitorPnL(poolAddressStr, user) {
  const publicKey = user.publicKey;
  const poolAddress = new PublicKey(poolAddressStr);
  const dlmmPool = await DLMM.create(connection, poolAddress);

  let userPositions = [];
  let activeBin = null;

  for (let i = 0; i < 5; i++) {
    const res = await dlmmPool.getPositionsByUserAndLbPair(publicKey);
    userPositions = res.userPositions;
    activeBin = res.activeBin;
    if (userPositions?.length > 0) break;
    await delay(2000);
  }

  if (!userPositions || userPositions.length === 0) return false;

  const tokenX = dlmmPool.tokenX;
  const mintXStr = tokenX?.mint?.address?.toBase58();
  const decimalsX = tokenX?.mint?.decimals ?? 6;
  const mintYStr = dlmmPool.tokenY?.mint?.address?.toBase58();
  const decimalsY = dlmmPool.tokenY?.mint?.decimals ?? 6;

  const prices = await getPriceUsdMap([mintXStr, mintYStr]);
  const priceX = prices[mintXStr] || 0;
  const priceY = prices[mintYStr] || 0;
  const currentBinId = activeBin?.binId;

  const currentPosKeys = [];

  for (const pos of userPositions) {
    const posKey = pos.publicKey.toBase58();
    const data = pos.positionData;
    currentPosKeys.push(posKey);

    if (pnlStore[posKey]?.isClosed || pnlStore[posKey]?.removedAt) continue;
    if (pendingRemove.has(posKey)) {
      console.log(`⏸️ ${posKey.slice(0, 6)} sedang dalam proses remove...`);
      continue;
    }

    // ⏳ Skip kalau masih dalam cooldown
    if (pnlStore[posKey]?.cooldownUntil && pnlStore[posKey].cooldownUntil > Date.now()) {
      const remaining = Math.ceil((pnlStore[posKey].cooldownUntil - Date.now()) / 1000);
      console.log(`⏸️ Posisi ${posKey.slice(0, 6)} masih cooldown ${remaining}s`);
      continue;
    }

    const toDecimal = (val, dec) => {
      if (!val) return 0;
      const bn = BN.isBN(val) ? val : new BN(val.toString());
      return Number(bn.toString()) / 10 ** dec;
    };

    const amountX = toDecimal(data.totalXAmount ?? data.amount_x, decimalsX);
    const amountY = toDecimal(data.totalYAmount ?? data.amount_y, decimalsY);
    const feeX = toDecimal(data.feeX ?? data.fees_x ?? 0, decimalsX);
    const feeY = toDecimal(data.feeY ?? data.fees_y ?? 0, decimalsY);
    const valueX = amountX * priceX;
    const valueY = amountY * priceY;
    const currentValue = valueX + valueY + feeX * priceX + feeY * priceY;

    if (!pnlStore[posKey]) {
      pnlStore[posKey] = {
        startUsd: currentValue,
        pool: poolAddressStr,
        owner: publicKey.toBase58(),
        createdAt: Date.now(),
        mintX: mintXStr,
      };
    }

    pnlStore[posKey].lastSeen = Date.now();
    pnlStore[posKey].isClosed = false;

    const startValue = pnlStore[posKey].startUsd;
    const profit = currentValue - startValue;
    const percent = startValue > 0 ? (profit / startValue) * 100 : 0;
    const inRange = currentBinId >= data.lowerBinId && currentBinId <= data.upperBinId;
    const now = new Date().toLocaleString();
    const feeUsd = feeX * priceX + feeY * priceY;

    const IL = ((amountX + feeX) * priceX + (amountY + feeY) * priceY - currentValue) /
      ((amountX + feeX) * priceX + (amountY + feeY) * priceY) * 100;

    console.log(`📘 Wallet: ${publicKey.toBase58().slice(0, 6)} | Pool: ${poolAddressStr.slice(0, 6)}...`);
    console.log(`📦 amountX: ${amountX.toFixed(6)}`);
    console.log(`📦 amountY: ${amountY.toFixed(6)}`);
    console.log(`📈 valueX: $${valueX.toFixed(2)}`);
    console.log(`📈 valueY: $${valueY.toFixed(2)}`);
    console.log(`💸 feeX: ${feeX.toFixed(6)}`);
    console.log(`💸 feeY: ${feeY.toFixed(6)}`);
    console.log(`💸 Unclaimed Fee USD: ${feeUsd.toFixed(2)}`);
    console.log(`📘 Position: ${posKey.slice(0, 6)}...`);
    console.log(`📊 Status: ${inRange ? "🟢 In-Range" : "🔴 Out-of-Range"}`);
    console.log(`💰 Start USD: $${startValue.toFixed(2)}`);
    console.log(`💰 Current USD: $${currentValue.toFixed(2)}`);
    console.log(
      profit >= 0
        ? `🟢 Profit: $${profit.toFixed(2)} (+${percent.toFixed(2)}%)`
        : `🔴 Loss: $${profit.toFixed(2)} (${percent.toFixed(2)}%)`
    );
    console.log(`📉 Est. Impermanent Loss: ${IL.toFixed(2)}%`);
    console.log("–––––––––––––––––––––––––––––––");

    const TP = globalThis.RUNTIME_CONFIG?.TAKE_PROFIT ?? 10;
    const SL = globalThis.RUNTIME_CONFIG?.STOP_LOSS ?? -5;

    if (!inRange) {
      if (!pnlStore[posKey].outSince) {
        pnlStore[posKey].outSince = now;
      } else if (now - pnlStore[posKey].outSince > 10 * 60 * 1000) {
        console.log(`⏱️ ${posKey.slice(0, 6)} out-of-range >10 menit, trigger auto-remove`);
        percent = SL - 0.1; // Paksa trigger SL logic
      }
    } else {
      delete pnlStore[posKey].outSince;
    }

    if (percent >= TP || percent <= SL) {
      pendingRemove.add(posKey);
      console.log(`🚨 PnL ${percent.toFixed(2)}% – Remove & Swap`);
    
      let success = false;
    
      // 🔁 Retry removeLiquidity max 3x
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const tx = await dlmmPool.removeLiquidity({
            position: pos.publicKey,
            user: publicKey,
            fromBinId: data.lowerBinId,
            toBinId: data.upperBinId,
            bps: new BN(10_000),
            shouldClaimAndClose: true,
            extraComputeUnits: getPriorityInstructions("ultra"),
          });
    
          const sig = await sendAndConfirmTransaction(connection, tx, [user], {
            commitment: "confirmed",
          });
    
          console.log(`✅ TX Remove (attempt ${attempt}):`, sig);
          await delay(1000);
    
          pnlStore[posKey].isClosed = true;
          pnlStore[posKey].removedAt = Date.now();
    
          if (percent >= TP) {
            pnlStore[posKey].cooldownUntil = Date.now() + 30 * 60 * 1000;
            console.log(`⏸️ Token cooldown hingga ${new Date(pnlStore[posKey].cooldownUntil).toLocaleTimeString()}`);
          }
    
          success = true;
          break;
        } catch (e) {
          console.warn(`⚠️ Gagal remove (attempt ${attempt}): ${e.message || e}`);
          await delay(2000);
        }
      }
    
      if (!success) {
        console.warn(`❌ Gagal remove posisi ${posKey.slice(0, 6)} setelah 3 percobaan`);
        pnlStore[posKey].removedAt = Date.now();
        pendingRemove.delete(posKey);
        return;
      }
    
      // 🔁 Jalankan auto-swap setelah remove
      let balX = 0;
      const MIN_SWAP = 1_000;
      const MAX_TRY = 10;
    
      console.log(`🔍 Menunggu token ${mintXStr.slice(0, 6)} masuk ke wallet...`);
      for (let i = 0; i < MAX_TRY; i++) {
        await delay(2000);
        balX = await getUserTokenBalanceNative(connection, mintXStr, publicKey);
        console.log(`🔁 Cek saldo token X [${i + 1}/${MAX_TRY}]: ${balX}`);
        if (balX > MIN_SWAP) break;
      }
    
      if (balX > MIN_SWAP && !pendingSwap.has(posKey)) {
        pendingSwap.add(posKey);
      
        let success = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const sig = await autoSwap({
              inputMint: mintXStr,
              outputMint: "So11111111111111111111111111111111111111112",
              amountInLamports: balX,
              signer: user,
            });
            console.log(`🔁 Swapped to SOL (attempt ${attempt}):`, sig);
            success = true;
            break;
          } catch (e) {
            console.warn(`❌ Swap gagal (attempt ${attempt}):`, e.message || e);
            await delay(2000); // Delay antar percobaan
          }
        }
      
        if (!success) {
          console.warn(`❌ Swap gagal total setelah 3 percobaan untuk ${mintXStr.slice(0, 6)}`);
        }
      
        pendingSwap.delete(posKey);
      } else {
        console.warn(`❌ Gagal swap: saldo token X (${mintXStr.slice(0, 6)}) belum masuk setelah remove.`);
      }
      
    
      // 🧹 Cleanup pendingRemove
      pendingRemove.delete(posKey);
    }
    
  }

  const now = Date.now();
  for (const key in pnlStore) {
    const entry = pnlStore[key];
    if (entry.pool === poolAddressStr && !currentPosKeys.includes(key)) {
      pnlStore[key].isClosed = true;
    }
    if (entry.isClosed && now - (entry.lastSeen || entry.createdAt) > 24 * 60 * 60 * 1000) {
      delete pnlStore[key];
    }
  }

  fs.writeFileSync(pnlStorePath, JSON.stringify(pnlStore, null, 2));
  return true;
}
