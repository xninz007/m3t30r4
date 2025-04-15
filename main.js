import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { RPC } from "./config.js";
import { autoSwap } from "./autoswap.js";
import { autoAddLpSafe } from "./lib/prompt.js";
import { getUserTokenBalanceNative } from "./utils.js";
import DLMM from "@meteora-ag/dlmm";
import fetch from "node-fetch";
import BN from "bn.js";
import fs from "fs";
import inquirer from "inquirer";
import { monitorPnL } from "./mon.js";
import { getTokenScore } from "./scorer.js";
import bs58 from "bs58";

const connection = new Connection(RPC, "confirmed");
const BIN_STEPS = [80, 100, 125, 250];
const pnlStorePath = "./pnl.json";

const walletPrivates = JSON.parse(fs.readFileSync("wallets.json", "utf8"));
const walletQueue = walletPrivates.map(pk => ({
  keypair: Keypair.fromSecretKey(Buffer.from(bs58.decode(pk))),
  usedTokens: new Set(),
}));

const monitoredPools = new Map();

function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

function loadCooldownMap() {
  if (!fs.existsSync(pnlStorePath)) return {};
  const store = JSON.parse(fs.readFileSync(pnlStorePath, "utf8"));
  const cooldownMap = {};
  const now = Date.now();
  for (const key in store) {
    const entry = store[key];
    const mint = entry.mintX || entry.baseMint;
    if (entry.cooldownUntil && entry.cooldownUntil > now && mint) {
      cooldownMap[mint] = entry.cooldownUntil;
    }
  }
  return cooldownMap;
}

async function getTopTokens(timeframe = "5m") {
  const url = `https://datapi.jup.ag/v1/pools/toporganicscore/${timeframe}`;
  await delay(1000);
  const res = await fetch(url);
  const json = await res.json();
  return json.pools
    .filter(p => {
      const isSOL = p.quoteAsset === "So11111111111111111111111111111111111111112";
      const isNew = Date.now() - new Date(p.baseAsset.firstPool?.createdAt || 0).getTime() < 24 * 60 * 60 * 1000;
      const mcap = p.baseAsset.mcap || 0;
      return p.volume24h >= 1_000_000 && isSOL && isNew && mcap >= 1_000_000;
    })
    .map(p => ({ ...p, score: getTokenScore(p) }))
    .sort((a, b) => b.score - a.score);
}

async function getMatchingPool(baseMint) {
  const url = `https://app.meteora.ag/clmm-api/pair/all_by_groups?search_term=${baseMint}&limit=100`;
  await delay(1000);
  const res = await fetch(url);
  const json = await res.json();

  let bestPool = null;
  let highestVolume = 0;

  for (const group of json.groups) {
    for (const pair of group.pairs) {
      const isValidBin = BIN_STEPS.includes(pair.bin_step);
      const isSOL = pair.mint_y === "So11111111111111111111111111111111111111112";
      const volume = pair.trade_volume_24h || 0;

      if (isValidBin && isSOL && volume > highestVolume) {
        highestVolume = volume;
        bestPool = pair.address;
      }
    }
  }

  return bestPool;
}

export async function autoVolumeLoop() {
  const {
    solAmount,
    takeProfit,
    stopLoss,
    mode,
    strategyType,
    anchorToken
  } = await inquirer.prompt([
    {
      type: "input",
      name: "solAmount",
      message: "\uD83D\uDCB0 Masukkan jumlah SOL untuk swap (misal: 0.01):",
      default: "0.01",
      validate: (val) => (!isNaN(val) && val > 0 ? true : "Harus angka positif"),
    },
    {
      type: "input",
      name: "takeProfit",
      message: "\uD83D\uDCC8 Masukkan persentase Take Profit (%):",
      default: "10",
      validate: (val) => !isNaN(val),
    },
    {
      type: "input",
      name: "stopLoss",
      message: "\uD83D\uDCC9 Masukkan persentase Stop Loss (%):",
      default: "5",
      validate: (val) => !isNaN(val),
      filter: (val) => -Math.abs(parseFloat(val)),
    },
    {
      type: "list",
      name: "mode",
      message: "\uD83D\uDCE6 Pilih mode input liquidity:",
      choices: ["50:50", "One Side Tokens"],
    },
    {
      type: "list",
      name: "strategyType",
      message: "\uD83D\uDCCA Pilih strategi distribusi:",
      choices: ["Spot", "BidAsk", "Curve"],
    },
    {
      type: "list",
      name: "anchorToken",
      message: "\uD83E\uDE99 Pilih token sebagai dasar input (X atau Y):",
      when: (answers) => answers.mode === "One Side Tokens",
      choices: ["X", "Y"],
    },
  ]);

  globalThis.RUNTIME_CONFIG = {
    MODAL_LAMPORTS: Math.floor(Number(solAmount) * 1e9),
    TAKE_PROFIT: parseFloat(takeProfit),
    STOP_LOSS: parseFloat(stopLoss),
    STRATEGY: strategyType,
    MODE: mode,
    ANCHOR: anchorToken || "X",
  };

  console.log("\n⚙️ Konfigurasi:");
  console.log(`Modal: ${solAmount} SOL | TP: ${takeProfit}% | SL: ${stopLoss}%`);
  console.log(`Mode: ${mode} | Strategi: ${strategyType}`);
  console.log("–––––––––––––––––––––––––––––––");
  console.log("🚀 Memulai Auto Volume Mode (Multi-Wallet)...");

  while (true) {
    try {
      const cooldownMap = loadCooldownMap();
      const tokens = await getTopTokens("5m");

      for (const token of tokens) {
        const baseMint = token.baseAsset.id;
        const symbol = token.baseAsset.symbol;

        const poolAddress = await getMatchingPool(baseMint);
        if (!poolAddress || monitoredPools.has(poolAddress)) continue;

        let walletSlot;
        for (const w of walletQueue) {
          const alreadyUsed = w.usedTokens.has(baseMint);
          const isCooldown = cooldownMap[baseMint] && cooldownMap[baseMint] > Date.now();

          if (!alreadyUsed || (walletQueue.length === 1 && !isCooldown)) {
            walletSlot = w;
            if (alreadyUsed && walletQueue.length === 1) {
              console.log(`♻️ Wallet tunggal reuse token: ${symbol}`);
            }
            break;
          }
        }

        if (!walletSlot) {
          console.log(`⚠️ Tidak ada wallet tersedia untuk token ${symbol}`);
          continue;
        }

        const { keypair, usedTokens } = walletSlot;
        const pubkey = keypair.publicKey;
        const walletName = `${pubkey.toBase58().slice(0, 6)}...`;

        console.log(`🚨 Token HOT: ${symbol} | Wallet: ${walletName} | (Score: ${token.score.toFixed(2)})`);
        console.log("🔍 Pool:", poolAddress);

        const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));

        let balX = 0;
        let shouldSkipSwap = mode === "One Side Tokens" && anchorToken === "Y";

        if (!shouldSkipSwap) {
          for (let attempt = 1; attempt <= 3; attempt++) {
            console.log(`🔁 Swap attempt #${attempt}`);
            try {
              const swapSig = await autoSwap({
                inputMint: "So11111111111111111111111111111111111111112",
                outputMint: baseMint,
                amountInLamports: globalThis.RUNTIME_CONFIG.MODAL_LAMPORTS,
                signer: keypair,
              });
              console.log("🔁 Swap TX:", swapSig);
            } catch (e) {
              console.warn(`❌ Swap gagal attempt #${attempt}:`, e.message || e);
              continue;
            }

            for (let i = 0; i < 5; i++) {
              await delay(1500);
              balX = await getUserTokenBalanceNative(connection, baseMint, pubkey);
              if (balX > 0) break;
            }

            if (balX > 0) break;
            console.warn("⏳ Token belum masuk. Retry swap...");
          }

          if (balX === 0) {
            console.warn("❌ Token tidak masuk setelah 3 kali swap. Batalkan.");
            continue;
          }
        } else {
          console.log("⏭️ Swap dilewati: One Side Token Y (SOL)");
        }

        const result = await autoAddLpSafe({
          connection,
          dlmmPool,
          user: keypair,
          poolAddress,
          mode: globalThis.RUNTIME_CONFIG.MODE,
          strategyType: globalThis.RUNTIME_CONFIG.STRATEGY,
          anchorAmountLamports: new BN(balX),
        });

        console.log("📡 Monitor PnL dimulai:", poolAddress);
        const intervalId = setInterval(async () => {
          const active = await monitorPnL(poolAddress, keypair);
          if (!active) {
            clearInterval(monitoredPools.get(poolAddress));
            monitoredPools.delete(poolAddress);
            console.log("🛑 Monitor PnL dihentikan:", poolAddress);
          }
        }, 10_000);

        monitoredPools.set(poolAddress, intervalId);
        usedTokens.add(baseMint);
      }

      await delay(60_000);
    } catch (err) {
      console.error("❌ Error:", err.message || err);
      await delay(10_000);
    }
  }
}

autoVolumeLoop();
