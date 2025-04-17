import { Connection, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import { RPC } from "./config.js";
import { getPriceUsdMap, getUserTokenBalanceNative, autoUnwrapWsol } from "./utils.js";
import { getPriorityInstructions } from "./lib/fee.js";
import { autoSwap } from "./autoswap.js";
import dlmmPkg from "@meteora-ag/dlmm";
const createDlmmPool = dlmmPkg.create || dlmmPkg.DLMM?.create || dlmmPkg.default?.create;
import BN from "bn.js";
import fs from "fs";
import fetch from "node-fetch";

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

export async function getPoolName(poolAddress) {
  try {
    const res = await fetch(`https://dlmm-api.meteora.ag/pair/${poolAddress}`);
    const json = await res.json();
    return json.name || `UnknownPair(${poolAddress.slice(0, 4)})`;
  } catch (e) {
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
    let percent = startValue > 0 ? (profit / startValue) * 100 : 0;
    const inRange = currentBinId >= data.lowerBinId && currentBinId <= data.upperBinId;
    const now = Date.now();
    const feeUsd = feeX * priceX + feeY * priceY;
    const lpValue = amountX * priceX + amountY * priceY;
    const hodlValue = (amountX + feeX) * priceX + (amountY + feeY) * priceY;
    
    const IL = ((hodlValue - lpValue) / hodlValue) * 100;
    const IL_USD = hodlValue - lpValue;    

      console.log(
        `[${publicKey.toBase58().slice(0, 6)}] [${posKey.slice(0, 6)}] (${pairName})` +
        `💰 $${startValue.toFixed(2)} → $${currentValue.toFixed(2)} | ` +
        `${inRange ? "🟢 In-Range" : "🔴 Out-Range"} | ` +
        `${profit >= 0 ? "🟢" : "🔴"} ${profit >= 0 ? "+" : ""}$${profit.toFixed(2)} (${percent.toFixed(2)}%) | ` +
        `💸 Fee: $${feeUsd.toFixed(2)} | 📉 IL: $${IL_USD.toFixed(2)} (${IL.toFixed(2)}%)`
      );
      

      const TP = globalThis.RUNTIME_CONFIG?.TAKE_PROFIT ?? 10;
      const SL = globalThis.RUNTIME_CONFIG?.STOP_LOSS ?? -5;
      
      if (!inRange) {
        if (!pnlStore[posKey].outSince) {
          pnlStore[posKey].outSince = now;
        } else if (now - pnlStore[posKey].outSince > 5 * 60 * 1000 && !pnlStore[posKey].alreadyTriggered) {
          console.log(`⏱️ ${posKey.slice(0, 6)} out-of-range >5 menit, trigger auto-remove`);
          percent = SL - 0.1;
          pnlStore[posKey].alreadyTriggered = true;
        }
      } else {
        delete pnlStore[posKey].outSince;
        delete pnlStore[posKey].alreadyTriggered;
      }
      
      // ✅ Tambahkan support force remove dari Telegram
      if (pnlStore[posKey]?.manualTriggered && pnlStore[posKey]?.forceRemove) {
        console.log(`🧨 Force remove by Telegram: ${posKey.slice(0, 6)}`);
        percent = SL - 0.1;
        pnlStore[posKey].alreadyTriggered = true;
        delete pnlStore[posKey].forceRemove;
      }
      
      if (percent >= TP || percent <= SL) {
        pendingRemove.add(posKey);
        console.log(`🎯 Posisi ${posKey.slice(0, 6)} hit ${percent >= TP ? 'TP' : 'SL'} (${percent.toFixed(2)}%)`);
      
        let success = false;
      
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
            delete pnlStore[posKey].alreadyTriggered;
            delete pnlStore[posKey].manualTriggered; // ✅ hapus manual flag
            pnlStore[posKey].removedAt = Date.now();
      
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
      
        // ⏳ Tunggu token masuk
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
                outputMint: "So11111111111111111111111111111111111111112", // WSOL
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
                console.warn(`❌ TX Swap gagal secara on-chain (custom error):`, txInfo.meta.err);
                throw new Error("TX failed on-chain");
              }
        
              console.log(`🔁 Swapped to WSOL (attempt ${attempt}):`, sig);
              success = true;
              break;
            } catch (e) {
              console.warn(`❌ Swap gagal (attempt ${attempt}):`, e.message || e);
              await delay(2000);
            }
          }
        
          if (!success) {
            console.warn(`❌ Swap gagal total setelah 3 percobaan untuk ${mintXStr.slice(0, 6)}`);
          } else {
            // ✅ Cek saldo WSOL (output swap) lalu auto unwrap
            const WSOL_MINT = "So11111111111111111111111111111111111111112";
            const MAX_RETRY = 10;
            let wsolBal = 0;
        
            console.log(`🔍 Cek saldo WSOL sebelum unwrap...`);
            for (let i = 0; i < MAX_RETRY; i++) {
              await delay(1500);
              wsolBal = await getUserTokenBalanceNative(connection, WSOL_MINT, user.publicKey);
              console.log(`🔁 Cek saldo WSOL #${i + 1}: ${wsolBal}`);
              if (wsolBal > 0) break;
            }
        
            if (wsolBal > 0) {
              const unwrapped = await autoUnwrapWsol(user);
              if (unwrapped) {
                console.log(`💧 WSOL sebesar ${wsolBal} berhasil di-unwrapped ke SOL`);
              } else {
                console.warn(`⚠️ Gagal unwrap WSOL ke SOL (fungsi gagal dijalankan)`);
              }
            } else {
              console.warn(`⚠️ Tidak ada WSOL untuk di-unwrapped setelah ${MAX_RETRY}x cek`);
            }
          }
        
          pendingSwap.delete(posKey);
        } else {
          console.warn(`❌ Gagal swap: saldo token X (${mintXStr.slice(0, 6)}) belum masuk setelah remove.`);
        }
                             
        // Cooldown jika TP
        if (percent >= TP) {
          pnlStore[posKey].cooldownUntil = Date.now() + 30 * 60 * 1000;
          console.log(`⏸️ Token cooldown hingga ${new Date(pnlStore[posKey].cooldownUntil).toLocaleTimeString()}`);
        
          // ✅ Tambahkan ini untuk global cooldown per token
          const cooldownGlobalPath = "./cooldown.json";
          const cooldownGlobal = fs.existsSync(cooldownGlobalPath)
            ? JSON.parse(fs.readFileSync(cooldownGlobalPath, "utf8"))
            : {};
        
          cooldownGlobal[mintXStr] = pnlStore[posKey].cooldownUntil;
          fs.writeFileSync(cooldownGlobalPath, JSON.stringify(cooldownGlobal, null, 2));
        }
        
      
        // Cleanup & return
        pendingRemove.delete(posKey);
        console.log(`✅ Posisi ${posKey.slice(0, 6)} ditutup & token diswap ke SOL`);
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
