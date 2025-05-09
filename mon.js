import { Connection, PublicKey, sendAndConfirmTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { RPC } from "./config.js";
import { getPriceUsdMap, getUserTokenBalanceNative, autoUnwrapWsol } from "./utils.js";
import { getPriorityInstructions } from "./lib/fee.js";
import { autoSwap } from "./autoswap.js";
import dlmmPkg from "@meteora-ag/dlmm";
const createDlmmPool = dlmmPkg.create || dlmmPkg.DLMM?.create || dlmmPkg.default?.create;
import { saveTrackedSwap } from "./swaptracker.js";
import BN from "bn.js";
import fs from "fs";
import axios from "axios";
import * as util from 'util';

const logFile = fs.createWriteStream('bot.log', { flags: 'a' });
const logStdout = process.stdout;

console.log = function () {
  logFile.write(util.format(...arguments) + '\n');
  logStdout.write(util.format(...arguments) + '\n');
};
console.warn = console.error = console.log;


const connection = new Connection(RPC);
const pnlStorePath = "./pnl.json";
const pnlStore = fs.existsSync(pnlStorePath)
  ? JSON.parse(fs.readFileSync(pnlStorePath, "utf8"))
  : {};

const pendingRemove = new Set();
const pendingSwap = new Set();

function getTimestamp() {
  const now = new Date();
  const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000); // tambah 7 jam
  const date = wib.toISOString().split('T')[0]; // YYYY-MM-DD
  const time = wib.toISOString().split('T')[1].split('.')[0]; // HH:MM:SS
  return `[${time} WIB]`;
}

export function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

export async function getPoolName(poolAddress) {
  try {
    const { data } = await axios.get(`https://dlmm-api.meteora.ag/pair/${poolAddress}`);
    return data.name || `UnknownPair(${poolAddress.slice(0, 4)})`;
  } catch (e) {
    console.warn(`${getTimestamp()} ⚠️ Gagal fetch pool name untuk ${poolAddress}:`, e.code || e.message);
    return `UnknownPair(${poolAddress.slice(0, 4)})`;
  }
}

export async function monitorPnL(poolAddressStr, user) {
  const publicKey = user.publicKey;
  const poolAddress = new PublicKey(poolAddressStr);
  const dlmmPool = await createDlmmPool(connection, poolAddress);

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
  const pairName = await getPoolName(poolAddressStr);

  const prices = await getPriceUsdMap([mintXStr, mintYStr]);
  const priceX = prices[mintXStr] || 0;
  const priceY = prices[mintYStr] || 0;
  const currentBinId = activeBin?.binId;

  const currentPosKeys = [];
  let forceRemoveList = {};
  const forceRemovePath = "./forceRemove.json";
  
  if (fs.existsSync(forceRemovePath)) {
    try {
      forceRemoveList = JSON.parse(fs.readFileSync(forceRemovePath, "utf8"));
    } catch (e) {
      console.warn("⚠️ forceRemove.json rusak:", e.message);
    }
  }
  
  for (const pos of userPositions) {
    const posKey = pos.publicKey.toBase58();
    const data = pos.positionData;
    currentPosKeys.push(posKey);

    if (pnlStore[posKey]?.isClosed || pnlStore[posKey]?.removedAt) continue;
    if (pendingRemove.has(posKey)) {
      console.log(`${getTimestamp()} ⏸️ ${posKey.slice(0, 6)} sedang dalam proses remove...`);
      continue;
    }

    // ⏳ Skip kalau masih dalam cooldown
    if (pnlStore[posKey]?.cooldownUntil && pnlStore[posKey].cooldownUntil > Date.now()) {
      const remaining = Math.ceil((pnlStore[posKey].cooldownUntil - Date.now()) / 1000);
      console.log(`${getTimestamp()} ⏸️ Posisi ${posKey.slice(0, 6)} masih cooldown ${remaining}s`);
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
    let percent = startValue > 0 ? (profit / startValue) * 100 : 0;
    const inRange = currentBinId >= data.lowerBinId && currentBinId <= data.upperBinId;
    const now = Date.now();
    const feeUsd = feeX * priceX + feeY * priceY;
    const lpValue = amountX * priceX + amountY * priceY;
    const hodlValue = (amountX + feeX) * priceX + (amountY + feeY) * priceY;
    
    const IL = ((hodlValue - lpValue) / hodlValue) * 100;
    const IL_USD = hodlValue - lpValue;    

      console.log(
        `${getTimestamp()} [${publicKey.toBase58().slice(0, 6)}] [${poolAddressStr.slice(0, 6)}] [${posKey.slice(0, 6)}] (${pairName})` +
        `💰 $${startValue.toFixed(2)} → $${currentValue.toFixed(2)} | ` +
        `${inRange ? "🟢 In-Range" : "🔴 Out-Range"} | ` +
        `${profit >= 0 ? "🟢" : "🔴"} ${profit >= 0 ? "+" : ""}$${profit.toFixed(2)} (${percent.toFixed(2)}%) | ` +
        `💸 Fee: $${feeUsd.toFixed(2)} | 📉 IL: $${IL_USD.toFixed(2)} (${IL.toFixed(2)}%)`
      );
      

      const TP = globalThis.RUNTIME_CONFIG?.TAKE_PROFIT ?? 10;
      const SL = globalThis.RUNTIME_CONFIG?.STOP_LOSS ?? -5;
      const TRAIL = globalThis.RUNTIME_CONFIG?.TRAILING_OFFSET ?? 2;
      const useTrailing = globalThis.RUNTIME_CONFIG?.TRAILING_MODE ?? false;
      let triggerTP = false;
      let triggerSL = false;
      
      if (useTrailing) {
        if (percent >= TP || pnlStore[posKey]?.peakPercent !== undefined) {
          const oldPeak = pnlStore[posKey].peakPercent || percent;
          pnlStore[posKey].peakPercent = Math.max(oldPeak, percent);
      
          // 🟢 Tambahkan log saat peak naik
          if (pnlStore[posKey].peakPercent !== oldPeak) {
            console.log(`${getTimestamp()} 📈 Peak profit diperbarui: ${oldPeak.toFixed(2)}% → ${pnlStore[posKey].peakPercent.toFixed(2)}%`);
          }
      
          const trailingStop = pnlStore[posKey].peakPercent - TRAIL;
          if (percent <= trailingStop) {
            console.log(`${getTimestamp()} 🪂 Trigger TP (Trailing): turun dari peak ${pnlStore[posKey].peakPercent.toFixed(2)}% → ${percent.toFixed(2)}%`);
            triggerTP = true;
          }
        }
        if (percent <= SL) triggerSL = true;
      } else {
        triggerTP = percent >= TP;
        triggerSL = percent <= SL;
      }
                  
      let forceRemove = false;
      
      if (!inRange) {
        if (!pnlStore[posKey].outSince) {
          pnlStore[posKey].outSince = now;
        } else if (now - pnlStore[posKey].outSince > 5 * 60 * 1000 && !pnlStore[posKey].manualRemoveOutOfRange) {
          console.log(`${getTimestamp()} ⏱️ ${posKey.slice(0, 6)} out-of-range >5 menit, langsung trigger auto-remove`);
          pnlStore[posKey].manualRemoveOutOfRange = true;
          forceRemove = true;
        }
      } else {
        delete pnlStore[posKey].outSince;
        delete pnlStore[posKey].manualRemoveOutOfRange;
        delete pnlStore[posKey].alreadyTriggered;
      }
      
      // ✅ Tambahkan support force remove dari Telegram
      if (forceRemoveList[posKey]) {
        console.log(`${getTimestamp()} 🧨 Semua Posisi Aktif ditutup paksa!`);
        forceRemove = true;
        delete forceRemoveList[posKey];
        fs.writeFileSync(forceRemovePath, JSON.stringify(forceRemoveList, null, 2));
      }
      
      
      
      if (triggerTP || triggerSL || forceRemove) {
        pendingRemove.add(posKey);
        let reason = forceRemove ? 'FORCE' : triggerTP ? 'TP' : triggerSL  ? 'SL' : 'OUT-OF-RANGE';
        console.log(`${getTimestamp()} 🎯 Posisi ${posKey.slice(0, 6)} hit ${reason} (${percent.toFixed(2)}%)`);

      
        // 💥 Jika SL, tambahkan lossCount
        if (triggerSL) {
          pnlStore[posKey].lossCount = (pnlStore[posKey].lossCount || 0) + 1;
          console.log(`${getTimestamp()} 📉 Posisi ${posKey.slice(0, 6)} mengalami kerugian ke-${pnlStore[posKey].lossCount}`);
      
          if (pnlStore[posKey].lossCount >= 1) {
            const skipUntil = Date.now() + 24 * 60 * 60 * 1000; // 1 hari
            const cooldownGlobalPath = "./cooldown.json";
            const cooldownGlobal = fs.existsSync(cooldownGlobalPath)
              ? JSON.parse(fs.readFileSync(cooldownGlobalPath, "utf8"))
              : {};
      
            cooldownGlobal[mintXStr] = skipUntil;
            fs.writeFileSync(cooldownGlobalPath, JSON.stringify(cooldownGlobal, null, 2));
      
            console.log(`${getTimestamp()} 🚫 Token ${mintXStr.slice(0, 6)} rugi 2x, skip selama 1 hari sampai ${new Date(skipUntil).toLocaleTimeString()}`);
          }
        }
      
        // 🟢 Reset lossCount & set cooldown jika TP
        if (triggerTP) {
          pnlStore[posKey].lossCount = 0;
          pnlStore[posKey].cooldownUntil = Date.now() + 6 * 60 * 60 * 1000;
          console.log(`${getTimestamp()} ⏸️ Token cooldown hingga ${new Date(pnlStore[posKey].cooldownUntil).toLocaleTimeString()}`);
      
          const cooldownGlobalPath = "./cooldown.json";
          const cooldownGlobal = fs.existsSync(cooldownGlobalPath)
            ? JSON.parse(fs.readFileSync(cooldownGlobalPath, "utf8"))
            : {};
      
          cooldownGlobal[mintXStr] = pnlStore[posKey].cooldownUntil;
          fs.writeFileSync(cooldownGlobalPath, JSON.stringify(cooldownGlobal, null, 2));
        }
      
        pendingRemove.add(posKey);
      
        let success = false;

        for (let attempt = 1; attempt <= 5; attempt++) {
          try {
            const tx = await dlmmPool.removeLiquidity({
              position: pos.publicKey,
              user: publicKey,
              fromBinId: data.lowerBinId,
              toBinId: data.upperBinId,
              bps: new BN(10_000),
              shouldClaimAndClose: true,
            });
        
            // ⛔ Hapus ComputeBudget bawaan
            tx.instructions = tx.instructions.filter(
              (ix) => ix.programId.toBase58() !== ComputeBudgetProgram.programId.toBase58()
            );
        
            // ✅ Tambahkan priority fee dengan jelas
            const [computeIx, feeIx] = getPriorityInstructions("ultra");
            tx.instructions = [computeIx, feeIx, ...tx.instructions];
        
            // 🔁 Dapatkan blockhash fresh per attempt
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
            tx.recentBlockhash = blockhash;
            tx.feePayer = publicKey;
        
            const sig = await connection.sendTransaction(tx, [user], {
              preflightCommitment: "confirmed",
              maxRetries: 2,
            });
        
            await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
        
            console.log(`${getTimestamp()} ✅ TX Remove (attempt ${attempt}):`, sig);
        
            pnlStore[posKey].isClosed = true;
            delete pnlStore[posKey].alreadyTriggered;
            delete pnlStore[posKey].manualTriggered;
            pnlStore[posKey].removedAt = Date.now();
        
            success = true;
            break;
        
          } catch (e) {
            console.warn(`${getTimestamp()} ⚠️ Gagal remove (attempt ${attempt}):`, e.message || e);
            await delay(1000);
          }
        }
        
        if (!success) {
          console.warn(`${getTimestamp()} ❌ Gagal remove posisi ${posKey.slice(0, 6)} setelah 5 percobaan`);
          pnlStore[posKey].removeFailed = true;
          pendingRemove.delete(posKey);
          return;
        }
      
        // ⏳ Tunggu token masuk
        let balX = 0;
        const MIN_SWAP = 1_000;
        const MAX_TRY = 10;
        
        console.log(`${getTimestamp()} 🔍 Menunggu token ${mintXStr.slice(0, 6)} masuk ke wallet...`);
        for (let i = 0; i < MAX_TRY; i++) {
          await delay(2000);
          balX = await getUserTokenBalanceNative(connection, mintXStr, publicKey);
          console.log(`${getTimestamp()} 🔁 Cek saldo token X [${i + 1}/${MAX_TRY}]: ${balX}`);
          if (balX > MIN_SWAP) break;
        }
        
        if (balX > MIN_SWAP && !pendingSwap.has(posKey)) {
          pendingSwap.add(posKey);
        
          let success = false;
          for (let attempt = 1; attempt <= 5; attempt++) {
            try {
              const sig = await autoSwap({
                inputMint: mintXStr,
                outputMint: "So11111111111111111111111111111111111111112", // ✅ SOL
                amountInLamports: balX,
                signer: user,
              });
        
              if (!sig || typeof sig !== "string" || !sig.match(/^.{10,}$/)) {
                throw new Error("Swap gagal: signature tidak valid.");
              }
        
              const txInfo = await connection.getTransaction(sig, {
                commitment: "confirmed",
                maxSupportedTransactionVersion: 0,
              });
              if (txInfo?.meta?.err) {
                console.warn(`${getTimestamp()} ❌ TX Swap gagal secara on-chain (custom error):`, txInfo.meta.err);
                throw new Error("TX failed on-chain");
              }
        
              console.log(`${getTimestamp()} 🔁 Swapped to SOL (attempt ${attempt}):`, sig);
              success = true;
              break;
            } catch (e) {
              console.warn(`${getTimestamp()} ❌ Swap gagal (attempt ${attempt}):`, e.message || e);
              await delay(2000);
            }
          }
        
          if (!success) {
            console.warn(`${getTimestamp()} ❌ Swap gagal total setelah 5 percobaan untuk ${mintXStr.slice(0, 6)}`);
            saveTrackedSwap(mintXStr, user.publicKey.toBase58());
          }
        
          pendingSwap.delete(posKey);
        } else {
          console.warn(`${getTimestamp()} ❌ Gagal swap: saldo token X (${mintXStr.slice(0, 6)}) belum masuk setelah remove.`);
        }
        
        // Cleanup & return
        pendingRemove.delete(posKey);
        console.log(`${getTimestamp()} ✅ Posisi ${posKey.slice(0, 6)} ditutup & token diswap ke SOL`);
        return {
          closed: true,
          baseMint: mintXStr,
          pool: poolAddressStr,
        };
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
