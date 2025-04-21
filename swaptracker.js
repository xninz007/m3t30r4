// === swaptracker.js ===
import fs from "fs";
import { PublicKey } from "@solana/web3.js";
import { getUserTokenBalanceNative } from "./utils.js";
import { autoSwap } from "./autoswap.js";

const SWAP_TRACKER_PATH = "./swaptracker.json";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const MIN_SWAP_LAMPORTS = 30_000; // ~0.00003 token
const MAX_RETRY = 3;

function getTimestamp() {
  const now = new Date(Date.now() + 7 * 60 * 60 * 1000);
  return now.toISOString().split("T")[1].split(".")[0];
}

export function saveTrackedSwap(baseMint, owner) {
  const data = fs.existsSync(SWAP_TRACKER_PATH)
    ? JSON.parse(fs.readFileSync(SWAP_TRACKER_PATH, "utf8"))
    : {};

  const key = `${baseMint}_${owner}`;
  data[key] = { baseMint, owner, trackedAt: Date.now(), retryCount: 0 };
  fs.writeFileSync(SWAP_TRACKER_PATH, JSON.stringify(data, null, 2));
  console.log(`[${getTimestamp()}] 📦 Swap Tracked: ${baseMint} (${owner.slice(0, 6)})`);
}

export async function runSwapTracker(connection, walletQueue) {
  if (!fs.existsSync(SWAP_TRACKER_PATH)) return;

  const data = JSON.parse(fs.readFileSync(SWAP_TRACKER_PATH, "utf8"));

  for (const [key, entry] of Object.entries(data)) {
    const pubkey = new PublicKey(entry.owner);
    const signer = walletQueue.find(w => w.keypair.publicKey.equals(pubkey))?.keypair;
    if (!signer) continue;

    const balance = await getUserTokenBalanceNative(connection, entry.baseMint, pubkey);

    if (balance < MIN_SWAP_LAMPORTS) {
      entry.retryCount = (entry.retryCount || 0) + 1;
      if (entry.retryCount >= MAX_RETRY) {
        console.log(`[${getTimestamp()}] 🧹 Hapus ${entry.baseMint} (retry ${entry.retryCount}x, saldo terlalu kecil)`);
        delete data[key];
      } else {
        console.log(`[${getTimestamp()}] ⏳ Skip ${entry.baseMint} - saldo terlalu kecil (${balance}), retry ke-${entry.retryCount}`);
      }
      continue;
    }

    try {
      console.log(`[${getTimestamp()}] 🔄 Swap ulang ${entry.baseMint.slice(0, 6)} ke SOL...`);
      const sig = await autoSwap({
        inputMint: entry.baseMint,
        outputMint: WSOL_MINT,
        amountInLamports: balance,
        signer,
      });
      console.log(`[${getTimestamp()}] ✅ Swap sukses: ${sig}`);
      delete data[key];
    } catch (e) {
      entry.retryCount = (entry.retryCount || 0) + 1;
      console.warn(`[${getTimestamp()}] ❌ Swap gagal (${entry.baseMint}): ${e.message || e}`);
      if (entry.retryCount >= MAX_RETRY) {
        console.warn(`[${getTimestamp()}] 🧹 Hapus ${entry.baseMint} setelah ${entry.retryCount}x gagal swap`);
        delete data[key];
      }
    }
  }

  fs.writeFileSync(SWAP_TRACKER_PATH, JSON.stringify(data, null, 2));
}
