import { Connection, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import { RPC } from "./config.js";
import { getUserTokenBalanceNative } from "./utils.js";
import { getPriorityInstructions } from "./lib/fee.js";
import { autoSwap } from "./autoswap.js";
import dlmmPkg from "@meteora-ag/dlmm";
import BN from "bn.js";
import fs from "fs";

const connection = new Connection(RPC);
const createDlmmPool = dlmmPkg.create || dlmmPkg.DLMM?.create || dlmmPkg.default?.create;
const WSOL_MINT = "So11111111111111111111111111111111111111112";

function getTimestamp() {
  const now = new Date(Date.now() + 7 * 60 * 60 * 1000);
  return now.toISOString().split("T")[1].split(".")[0];
}

function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

export async function runHourlyCheck(walletQueue) {
  console.log(`${getTimestamp()} 🕐 [Hourly Check] Cek ulang posisi LP & token tersisa...`);

  const pnlPath = "./pnl.json";
  if (!fs.existsSync(pnlPath)) return;

  const data = JSON.parse(fs.readFileSync(pnlPath, "utf8"));

  for (const [posKey, entry] of Object.entries(data)) {
    if (!entry?.baseMint || !entry.owner || !entry.pool) continue;
    const pubkey = new PublicKey(entry.owner);
    const signer = walletQueue.find(w => w.keypair.publicKey.equals(pubkey))?.keypair;
    if (!signer) continue;
    const poolAddress = new PublicKey(entry.pool);
    const dlmmPool = await createDlmmPool(connection, poolAddress);

    const shouldTryRemove =
      !entry.isClosed &&
      (!entry.removedAt || entry.removeFailed); // ✅ support retry untuk removeFailed

    if (shouldTryRemove) {
      try {
        console.log(`${getTimestamp()} 🔁 Retry remove posisi ${posKey.slice(0, 6)}...`);
        const res = await dlmmPool.getPositionsByUserAndLbPair(pubkey);
        const found = res.userPositions.find(p => p.publicKey.toBase58() === posKey);
        if (!found) continue;

        const tx = await dlmmPool.removeLiquidity({
          position: found.publicKey,
          user: pubkey,
          fromBinId: found.positionData.lowerBinId,
          toBinId: found.positionData.upperBinId,
          bps: new BN(10_000),
          shouldClaimAndClose: true,
          extraComputeUnits: getPriorityInstructions("ultra"),
        });

        const sig = await sendAndConfirmTransaction(connection, tx, [signer], {
          commitment: "confirmed",
        });

        console.log(`${getTimestamp()} ✅ Remove ulang berhasil. TX:`, sig);
        entry.isClosed = true;
        entry.removedAt = Date.now();
        delete entry.removeFailed;
        fs.writeFileSync(pnlPath, JSON.stringify(data, null, 2));
        await delay(1500);
      } catch (e) {
        console.warn(`${getTimestamp()} ❌ Gagal remove ulang posisi:`, e.message || e);
        entry.removeFailed = true;
        fs.writeFileSync(pnlPath, JSON.stringify(data, null, 2));
      }
    }

    // ✅ Retry detect token X masuk sebelum swap
    let balX = 0;
    if (entry.isClosed) {
      for (let attempt = 1; attempt <= 10; attempt++) {
        balX = await getUserTokenBalanceNative(connection, entry.baseMint, pubkey);
        if (balX > 10_000) break;
        console.log(`${getTimestamp()} ⏳ Menunggu token ${entry.baseMint.slice(0, 6)} masuk... (#${attempt})`);
        await delay(1500);
      }

      if (balX > 10_000) {
        try {
          console.log(`${getTimestamp()} 🔄 Swap token tersisa: ${entry.baseMint.slice(0, 6)}...`);
          const sig = await autoSwap({
            inputMint: entry.baseMint,
            outputMint: WSOL_MINT,
            amountInLamports: balX,
            signer,
          });
          const txInfo = await connection.getTransaction(sig, { commitment: "confirmed" });
          if (!sig || txInfo?.meta?.err) {
            console.warn(`${getTimestamp()} ❌ Swap gagal:`, txInfo?.meta?.err || "invalid sig");
          } else {
            console.log(`${getTimestamp()} ✅ Swap sukses:`, sig);
          }
        } catch (e) {
          console.warn(`${getTimestamp()} ⚠️ Error swap token X:`, e.message || e);
        }
      } else {
        console.log(`${getTimestamp()} ⚠️ Token X belum masuk ke wallet setelah 5x cek. Skip swap.`);
      }
    }
  }
}
