import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { RPC } from "./config.js";
import { autoSwap } from "./autoswap.js";
import { autoAddLpSafe } from "./lib/prompt.js";
import { getUserTokenBalanceNative } from "./utils.js";
import dlmmPkg from "@meteora-ag/dlmm";
const createDlmmPool = dlmmPkg.create || dlmmPkg.DLMM?.create || dlmmPkg.default?.create;
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
const CONFIG_CACHE_PATH = "./config_cache.json";

const walletPrivates = JSON.parse(fs.readFileSync("wallets.json", "utf8"));
const walletQueue = walletPrivates.map(pk => ({
  keypair: Keypair.fromSecretKey(Buffer.from(bs58.decode(pk))),
  usedTokens: new Set(),
  lastUsedMap: {}, // ✅ untuk delay reuse 20 menit
  usedBaseMintMap: {} // ✅ track baseMint → Set of pool addresses
}));

const monitoredPools = new Map();

function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

function loadCooldownMap() {
  const path = "./cooldown.json";
  if (!fs.existsSync(path)) return {};
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

async function getTopTokens(timeframe = "5m") {
  const url = `https://datapi.jup.ag/v1/pools/toporganicscore/${timeframe}`;
  await delay(1000);
  const res = await fetch(url);
  const json = await res.json();

  const MAX_AGE_MS = (globalThis.RUNTIME_CONFIG?.MAX_AGE_HOUR || 12) * 60 * 60 * 1000;
  const MIN_VOLUME = globalThis.RUNTIME_CONFIG?.MIN_VOLUME || 1_000_000;
  const MIN_MCAP = globalThis.RUNTIME_CONFIG?.MIN_MCAP || 1_000_000;

  return json.pools
    .filter(p => {
      const isSOL = p.quoteAsset === "So11111111111111111111111111111111111111112";
      const isNew = Date.now() - new Date(p.baseAsset.firstPool?.createdAt || 0).getTime() < MAX_AGE_MS;
      const mcap = p.baseAsset.mcap || 0;
      return p.volume24h >= MIN_VOLUME && isSOL && isNew && mcap >= MIN_MCAP;
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

async function loadOrPromptConfig() {
  let cached = null;
  if (fs.existsSync(CONFIG_CACHE_PATH)) {
    cached = JSON.parse(fs.readFileSync(CONFIG_CACHE_PATH, "utf8"));
  }

  let config;

  if (cached) {
    console.log("📦 Konfigurasi Sebelumnya:");
    console.log(`🔹 Modal       : ${cached.solAmount} SOL`);
    console.log(`🔹 Take Profit : ${cached.takeProfit}%`);
    console.log(`🔹 Stop Loss   : ${cached.stopLoss}%`);
    console.log(`🔹 Mode        : ${cached.mode}`);
    if (cached.mode === "One Side Tokens") {
      console.log(`🔹 Anchor Token: ${cached.anchorToken}`);
    }
    console.log(`🔹 Strategi    : ${cached.strategyType}`);
    console.log(`🔹 Min Volume  : ${cached.minVolume}`);
    console.log(`🔹 Min Mcap    : ${cached.minMcap}`);
    console.log(`🔹 Max Age     : ${cached.maxAgeHour} jam`);
    console.log("–––––––––––––––––––––––––––––––––––––––––––");

    const { configAction } = await inquirer.prompt([
      {
        type: "list",
        name: "configAction",
        message: "🧠 Konfigurasi ditemukan, pilih aksi:",
        choices: ["Gunakan konfigurasi sebelumnya", "Ubah konfigurasi"],
      },
    ]);

    if (configAction === "Gunakan konfigurasi sebelumnya") {
      console.log("✅ Menggunakan konfigurasi sebelumnya.");
      return cached;
    }
  }

  config = await inquirer.prompt([
    {
      type: "input",
      name: "solAmount",
      message: "💰 Masukkan jumlah SOL untuk swap (misal: 0.01):",
      default: "0.01",
      validate: (val) => (!isNaN(val) && val > 0 ? true : "Harus angka positif"),
    },
    {
      type: "input",
      name: "takeProfit",
      message: "📈 Masukkan persentase Take Profit (%):",
      default: "10",
      validate: (val) => !isNaN(val),
    },
    {
      type: "input",
      name: "stopLoss",
      message: "📉 Masukkan persentase Stop Loss (%):",
      default: "5",
      validate: (val) => !isNaN(val),
      filter: (val) => -Math.abs(parseFloat(val)),
    },
    {
      type: "list",
      name: "mode",
      message: "📦 Pilih mode input liquidity:",
      choices: ["50:50", "One Side Tokens"],
    },
    {
      type: "list",
      name: "strategyType",
      message: "📊 Pilih strategi distribusi:",
      choices: ["Spot", "BidAsk", "Curve"],
    },
    {
      type: "list",
      name: "anchorToken",
      message: "🦙 Pilih token sebagai dasar input (X atau Y):",
      when: (answers) => answers.mode === "One Side Tokens",
      choices: ["X", "Y"],
    },
    {
      type: "input",
      name: "minVolume",
      message: "📊 Minimum Volume 24H (misal: 1000000):",
      default: "1000000",
      validate: (val) => (!isNaN(val) && val > 0 ? true : "Harus angka positif"),
    },
    {
      type: "input",
      name: "minMcap",
      message: "🏦 Minimum Marketcap (misal: 1000000):",
      default: "1000000",
      validate: (val) => (!isNaN(val) && val > 0 ? true : "Harus angka positif"),
    },
    {
      type: "input",
      name: "maxAgeHour",
      message: "⏳ Maksimal umur token (jam):",
      default: "12",
      validate: (val) => (!isNaN(val) && val > 0 ? true : "Harus angka positif"),
    },
  ]);

  fs.writeFileSync(CONFIG_CACHE_PATH, JSON.stringify(config, null, 2));
  return config;
}

export async function autoVolumeLoop() {
  const {
    solAmount,
    takeProfit,
    stopLoss,
    mode,
    strategyType,
    anchorToken,
    minVolume,
    minMcap,
    maxAgeHour,
  } = await loadOrPromptConfig();

  globalThis.RUNTIME_CONFIG = {
    MODAL_LAMPORTS: Math.floor(Number(solAmount) * 1e9),
    TAKE_PROFIT: parseFloat(takeProfit),
    STOP_LOSS: parseFloat(stopLoss),
    STRATEGY: strategyType,
    MODE: mode,
    ANCHOR: anchorToken || "X",
    MIN_VOLUME: parseFloat(minVolume),
    MIN_MCAP: parseFloat(minMcap),
    MAX_AGE_HOUR: parseFloat(maxAgeHour),
  };

  console.log("\n⚙️ Konfigurasi:");
  console.log(`🔹 Modal       : ${solAmount} SOL`);
  console.log(`🔹 Take Profit : ${takeProfit}%`);
  console.log(`🔹 Stop Loss   : ${stopLoss}%`);
  console.log(`🔹 Mode        : ${mode}`);
  if (mode === "One Side Tokens") {
    console.log(`🔹 Anchor Token: ${anchorToken}`);
  }
  console.log(`🔹 Strategi    : ${strategyType}`);
  console.log(`🔹 Min Volume  : ${minVolume}`);
  console.log(`🔹 Min Mcap    : ${minMcap}`);
  console.log(`🔹 Max Age     : ${maxAgeHour} jam`);
  console.log("–––––––––––––––––––––––––––––––––––––––––––");
  console.log("🚀 Memulai Auto Volume Mode (Multi-Wallet)...\n");
  

  const REUSE_DELAY = 20 * 60 * 1000;

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
        const now = Date.now();

        for (const w of walletQueue) {
          const alreadyUsed = w.usedTokens.has(baseMint);
          const isCooldown = cooldownMap[baseMint] && cooldownMap[baseMint] > now;
          const lastUsed = w.lastUsedMap[baseMint] || 0;
          const reuseTooSoon = walletQueue.length === 1 && (now - lastUsed < REUSE_DELAY);
          const walletShort = w.keypair.publicKey.toBase58().slice(0, 6);

          if (isCooldown) {
            const remaining = Math.ceil((cooldownMap[baseMint] - now) / 60000);
            console.log(`[${walletShort}] ⏳ Cooldown token ${symbol} selama ${remaining} menit lagi`);
          }
        
          if (reuseTooSoon) {
            const remaining = Math.ceil((REUSE_DELAY - (now - lastUsed)) / 60000);
            console.log(`[${walletShort}] ⏳ Cooldown token ${symbol} selama ${remaining} menit lagi`);
          }
        
          const usedPools = w.usedBaseMintMap[baseMint] || new Set();
          if (usedPools.size >= 2) {
            console.log(`🚫 [${walletShort}] Sudah LP 2 pool untuk token ${symbol}, skip`);
            continue;
          } // ✅ limit 2 pool/token/wallet
        
          if (!alreadyUsed && !isCooldown && !reuseTooSoon) {
            walletSlot = w;
            w.lastUsedMap[baseMint] = now;
            break;
          }
        
          if (alreadyUsed && walletQueue.length === 1 && !isCooldown && !reuseTooSoon) {
            walletSlot = w;
            w.lastUsedMap[baseMint] = now;
            console.log(`♻️ Wallet tunggal reuse token: ${symbol}`);
            break;
          }
        }
        
        if (!walletSlot) {
          console.log(`⚠️ Semua wallet cooldown atau sudah pakai token ${symbol}`);
          continue;
        }
        

        const { keypair, usedTokens } = walletSlot;
        const pubkey = keypair.publicKey;
        const walletName = `${pubkey.toBase58().slice(0, 6)}...`;

        console.log(`🚨 Token HOT: ${symbol} | Wallet: ${walletName} | (Score: ${token.score.toFixed(2)})`);
        console.log("🔍 Pool:", poolAddress);

        const dlmmPool = await createDlmmPool(connection, new PublicKey(poolAddress));

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
            walletSlot.lastUsedMap[baseMint] = 0;
            continue;
          }
        } else {
          console.log("⏭️ Swap dilewati: One Side Token Y (SOL)");
        }

        let addLpSuccess = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            console.log(`➕ Add LP attempt #${attempt}`);
            const result = await autoAddLpSafe({
              connection,
              dlmmPool,
              user: keypair,
              poolAddress,
              mode: globalThis.RUNTIME_CONFIG.MODE,
              strategyType: globalThis.RUNTIME_CONFIG.STRATEGY,
              anchorAmountLamports: new BN(balX),
            });
        
            addLpSuccess = true;
            break;
          } catch (e) {
            console.warn(`❌ Add LP gagal (attempt ${attempt}):`, e.message || e);
            await delay(2000);
          }
        }
        
        if (!addLpSuccess) {
          console.warn("❌ Gagal add LP setelah 3 percobaan. Skip token.");
          continue;
        }
        
        if (!walletSlot.usedBaseMintMap[baseMint]) {
          walletSlot.usedBaseMintMap[baseMint] = new Set();
        }
        walletSlot.usedBaseMintMap[baseMint].add(poolAddress);
        

        console.log("📡 Monitor PnL dimulai:", poolAddress);
        const intervalId = setInterval(async () => {
          const result = await monitorPnL(poolAddress, keypair);

          if (result?.closed) {
            clearInterval(monitoredPools.get(poolAddress));
            monitoredPools.delete(poolAddress);
          
            walletSlot.usedTokens.delete(result.baseMint);
            walletSlot.usedBaseMintMap?.[result.baseMint]?.delete(result.pool);
            if (walletSlot.usedBaseMintMap?.[result.baseMint]?.size === 0) {
              delete walletSlot.usedBaseMintMap[result.baseMint];
            }
          
            console.log("🧹 Pool & token dibersihkan dari slot wallet:", result.baseMint);
          }
          
        }, 10_000);
        

        monitoredPools.set(poolAddress, intervalId);
        usedTokens.add(baseMint);
      }
      console.log("⏳ Tunggu 1 menit sebelum scan token baru...");
      await delay(60_000);
    } catch (err) {
      console.error("❌ Error:", err.message || err);
      await delay(10_000);
    }
  }
}

autoVolumeLoop();
