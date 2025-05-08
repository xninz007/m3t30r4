// update jam 12.56 29 April 2025
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { RPC } from "./config.js";
import { autoSwap } from "./autoswap.js";
import { autoAddLpSafe, isSafeBinRange } from "./lib/prompt.js";
import { getUserTokenBalanceNative, autoUnwrapWsol } from "./utils.js";
import dlmmPkg from "@meteora-ag/dlmm";
const createDlmmPool = dlmmPkg.create || dlmmPkg.DLMM?.create || dlmmPkg.default?.create;
import fetch from "node-fetch";
import BN from "bn.js";
import fs from "fs";
import inquirer from "inquirer";
import { monitorPnL } from "./mon.js";
import { getTokenScore } from "./scorer.js";
import bs58 from "bs58";
import * as util from 'util';
import { saveTrackedSwap, runSwapTracker } from "./swaptracker.js";
import { runHourlyCheck } from "./hourly.js";
import { calculateMeteorScore } from "./calculateMeteorScore.js";

const logFile = fs.createWriteStream('bot.log', { flags: 'a' });
const logStdout = process.stdout;

console.log = function () {
  logFile.write(util.format(...arguments) + '\n');
  logStdout.write(util.format(...arguments) + '\n');
};
console.warn = console.error = console.log;


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
const walletActivePoolMap = new Map();

function getTimestamp() {
  const now = new Date();
  const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000); // tambah 7 jam
  const date = wib.toISOString().split('T')[0]; // YYYY-MM-DD
  const time = wib.toISOString().split('T')[1].split('.')[0]; // HH:MM:SS
  return `[${time} WIB]`;
}


function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

function loadCooldownMap() {
  const path = "./cooldown.json";
  if (!fs.existsSync(path)) return {};
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

async function getTopTokens(timeframe = "5m") {
  if (globalThis.MODE_TYPE === "mode1") {
    // Mode 1 - pakai data dari Jupiter
    const url = `https://datapi.jup.ag/v1/pools/toporganicscore/${timeframe}`;
    await delay(1000);
    const res = await fetch(url);
    const json = await res.json();

    const MAX_AGE_MS = (globalThis.RUNTIME_CONFIG?.MAX_AGE_HOUR || 12) * 60 * 60 * 1000;
    const MIN_AGE_MS = (globalThis.RUNTIME_CONFIG?.MIN_AGE_HOUR || 1) * 60 * 60 * 1000;
    const MIN_VOLUME = globalThis.RUNTIME_CONFIG?.MIN_VOLUME || 1_000_000;
    const MIN_MCAP = globalThis.RUNTIME_CONFIG?.MIN_MCAP || 1_000_000;
    const MAX_MCAP = globalThis.RUNTIME_CONFIG?.MAX_MCAP || Infinity;

    const filtered = json.pools
      .filter(p => {
        const isSOL = p.quoteAsset === "So11111111111111111111111111111111111111112";
        const age = Date.now() - new Date(p.createdAt || 0).getTime();
        const isAgeOk = age >= MIN_AGE_MS && age <= MAX_AGE_MS;
        const mcap = p.baseAsset.mcap || 0;
        const score = p.baseAsset.organicScore ?? 0;
        const scoreLabel = (p.baseAsset.organicScoreLabel || "").toLowerCase();
        const isScoreOk = (scoreLabel === "medium" || scoreLabel === "high") && score >= 75;

        return (
          p.volume24h >= MIN_VOLUME &&
          isSOL &&
          isAgeOk &&
          mcap >= MIN_MCAP &&
          mcap <= MAX_MCAP &&
          isScoreOk
        );
      })
      .map(p => ({ ...p, score: p.baseAsset.organicScore ?? 0 }))
      .sort((a, b) => b.score - a.score);

    globalThis.topTokens = filtered;
    console.log(`✅ [Top Organic] ${globalThis.topTokens.length} tokens di-load`);
  } else if (globalThis.MODE_TYPE === "mode2") {
    // Mode 2 - pakai calculateMeteorScore
    await calculateMeteorScore();

    const data = JSON.parse(fs.readFileSync("meteor_score_v2.json", "utf-8"));
    globalThis.topTokens = data.map(d => ({
      mintX: d.mintX,
      address: d.address,
      symbol: d.symbol,
      score: d.meteorScore,
    }));
    console.log(`✅ [MeteoraScore] ${globalThis.topTokens.length} tokens di-load`);
  }
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

const { mode } = await inquirer.prompt([
  {
    type: "list",
    name: "mode",
    message: "Pilih Mode Auto Volume:",
    choices: [
      { name: "Mode 1 - Top Organic Jupiter", value: "mode1" },
      { name: "Mode 2 - Meteora Score Filtering", value: "mode2" },
    ],
  },
]);
globalThis.MODE_TYPE = mode;

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
    console.log(`🔹 Max Mcap    : ${cached.maxMcap}`);
    console.log(`🔹 Min Age     : ${cached.minAgeHour} jam`);
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
      console.log(`${getTimestamp()} ✅ Menggunakan konfigurasi sebelumnya.`);
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
      name: "maxMcap",
      message: "🔺 Maksimum Marketcap (misal: 100000000):",
      default: "100000000",
      validate: (val) => (!isNaN(val) && val > 0 ? true : "Harus angka positif"),
    },
    {
      type: "input",
      name: "minAgeHour",
      message: "⏳ Minimal umur token (jam):",
      default: "1",
      validate: (val) => (!isNaN(val) && val >= 0 ? true : "Harus angka >= 0"),
    },        
    {
      type: "input",
      name: "maxAgeHour",
      message: "⏳ Maksimal umur token (jam):",
      default: "12",
      validate: (val) => (!isNaN(val) && val > 0 ? true : "Harus angka positif"),
    },
    {
      type: "confirm",
      name: "onlyOnePositionPerWallet",
      message: "🚧 Batasi 1 posisi aktif per wallet?",
      default: true,
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
    maxMcap,
    minAgeHour,
    maxAgeHour,
    onlyOnePositionPerWallet,
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
    MIN_AGE_HOUR: parseFloat(minAgeHour),
    MAX_AGE_HOUR: parseFloat(maxAgeHour),
    MAX_MCAP: parseFloat(maxMcap),
    onlyOnePositionPerWallet,
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
  console.log(`🔹 Max Mcap    : ${maxMcap}`);
  console.log(`🔹 Min Age     : ${minAgeHour} jam`);
  console.log(`🔹 Max Age     : ${maxAgeHour} jam`);
  console.log("–––––––––––––––––––––––––––––––––––––––––––");
  console.log("🚀 Memulai Auto Volume Mode (Multi-Wallet)...\n");
  console.log("💰 Cek saldo SOL semua wallet:");
for (const w of walletQueue) {
  const pub = w.keypair.publicKey;
  const bal = await connection.getBalance(pub);
  console.log(`${getTimestamp()} 🔹 [${pub.toBase58().slice(0, 6)}] ${bal / 1e9} SOL`);
}

  // 🔍 Deteksi dan unwrap WSOL jika ada di semua wallet
console.log(`${getTimestamp()} 💧 Cek dan auto-unwrap WSOL yang tertinggal...`);
const WSOL_MINT = "So11111111111111111111111111111111111111112";

for (const w of walletQueue) {
  const pubkey = w.keypair.publicKey;
  const short = pubkey.toBase58().slice(0, 6);
  try {
    const bal = await getUserTokenBalanceNative(connection, WSOL_MINT, pubkey);
    if (bal > 0) {
      const unwrapped = await autoUnwrapWsol(w.keypair);
      if (unwrapped) {
        console.log(`${getTimestamp()} 💧 [${short}] Unwrapped ${bal} WSOL ke SOL`);
      } else {
       // console.warn(`⚠️ [${short}] Gagal unwrap WSOL (balance ada, tapi gagal proses)`);
      }
    }
    // else: tidak ada WSOL, tidak perlu log apapun
  } catch (e) {
    if (e.message?.includes("Associated Token Account does not exist")) {
      // diam, ini bukan error kritis
    } else {
      console.warn(`${getTimestamp()} ⚠️ [${short}] Error cek WSOL:`, e.message || e);
    }
  }
}

  
  const REUSE_DELAY = 20 * 60 * 1000;

  while (true) {
    try {
      const cooldownMap = loadCooldownMap();
      await getTopTokens("5m");
      const tokens = globalThis.topTokens || [];

      for (const token of tokens) {
        let baseMint, symbol;
      
        if (globalThis.MODE_TYPE === "mode1") {
          baseMint = token.baseAsset.id;
          symbol = token.baseAsset.symbol;
        } else {
          baseMint = token.mintX;
          symbol = token.symbol;
        }

        let poolAddress;

        if (globalThis.MODE_TYPE === "mode2") {
          poolAddress = token.address; // langsung pakai dari hasil meteorScore
        } else {
          poolAddress = await getMatchingPool(baseMint); // cari kalau mode1
        }
        if (!poolAddress || monitoredPools.has(poolAddress)) continue;

        let walletSlot;
        const now = Date.now();

        for (const w of walletQueue) {
          const alreadyUsed = w.usedTokens.has(baseMint);
          const isCooldown = cooldownMap[baseMint] && cooldownMap[baseMint] > now;
          const lastUsed = w.lastUsedMap[baseMint] || 0;
          const reuseTooSoon = walletQueue.length === 1 && (now - lastUsed < REUSE_DELAY);
          const walletShort = w.keypair.publicKey.toBase58().slice(0, 6);
        
          let maxDelayMsg = "";
          let maxDelayMinutes = 0;
        
          if (isCooldown) {
            const cd = Math.ceil((cooldownMap[baseMint] - now) / 60000);
            if (cd > maxDelayMinutes) {
              maxDelayMinutes = cd;
              maxDelayMsg = `${getTimestamp()} [${walletShort}] ⏳ Cooldown token ${symbol} selama ${cd} menit lagi`;
            }
          }
        
          if (reuseTooSoon) {
            const rd = Math.ceil((REUSE_DELAY - (now - lastUsed)) / 60000);
            if (rd > maxDelayMinutes) {
              maxDelayMinutes = rd;
              maxDelayMsg = `${getTimestamp()} [${walletShort}] ⏳ Reuse delay token ${symbol} selama ${rd} menit lagi`;
            }
          }
        
          if (maxDelayMsg) console.log(maxDelayMsg);
        
          const usedPools = w.usedBaseMintMap[baseMint] || new Set();
          if (usedPools.size >= 1) {
            console.log(`${getTimestamp()} 🚫 [${walletShort}] Sudah LP 1 pool untuk token ${symbol}, skip`);
            continue;
          }
        
          if (!alreadyUsed && !isCooldown && !reuseTooSoon) {
            walletSlot = w;
            if (globalThis.RUNTIME_CONFIG.ANCHOR === "X") {
              w.lastUsedMap[baseMint] = now; // hanya set reuse awal jika anchor X
            }
            break;
          }
          
        
          if (alreadyUsed && walletQueue.length === 1 && !isCooldown && !reuseTooSoon) {
            walletSlot = w;
            w.lastUsedMap[baseMint] = now;
            console.log(`${getTimestamp()} ♻️ Wallet tunggal reuse token: ${symbol}`);
            break;
          }
        }
        
        
        if (!walletSlot) {
          console.log(`${getTimestamp()} ⚠️ Semua wallet cooldown atau sudah pakai token ${symbol}`);
          continue;
        }

        if (globalThis.RUNTIME_CONFIG.onlyOnePositionPerWallet) {
          const activePool = walletActivePoolMap.get(walletSlot.keypair.publicKey.toBase58());
          if (activePool) {
            console.log(`${getTimestamp()} ⛔ Wallet ${walletSlot.keypair.publicKey.toBase58().slice(0, 6)} masih punya posisi aktif di pool ${activePool}, skip`);
            continue;
          }
        }
        
        

        const { keypair, usedTokens } = walletSlot;
        const pubkey = keypair.publicKey;
        const walletName = `${pubkey.toBase58().slice(0, 6)}...`;

        console.log(`${getTimestamp()} 🚨 Token HOT: ${symbol} | Wallet: ${walletName} | (Score: ${token.score.toFixed(2)})`);
        console.log(`${getTimestamp()} 🔍 Pool:`, poolAddress);

        const dlmmPool = await createDlmmPool(connection, new PublicKey(poolAddress));
        // Hitung minBin dan maxBin sesuai mode dan anchor
        const activeBin = await dlmmPool.getActiveBin();
        let minBinId = 0;
        let maxBinId = 0;
        
        if (mode === "50:50") {
          minBinId = activeBin.binId - 34;
          maxBinId = activeBin.binId + 34;
        } else if (mode === "One Side Tokens") {
          if (anchorToken === "X") {
            minBinId = activeBin.binId;
            maxBinId = activeBin.binId + 68;
          } else {
            minBinId = activeBin.binId - 68;
            maxBinId = activeBin.binId;
          }
        }
        
        const isSafe = await isSafeBinRange(dlmmPool, minBinId, maxBinId);
        if (!isSafe) {
          console.log(`${getTimestamp()} ⚠️ Bin range belum aktif → SKIP token ${symbol} karena biaya rent non-refundable`);
          continue;
        }

        let balX = 0;
        let shouldSkipSwap = mode === "One Side Tokens" && anchorToken === "Y";

        if (!shouldSkipSwap) {
          for (let attempt = 1; attempt <= 3; attempt++) {
            console.log(`${getTimestamp()} 🔁 Swap attempt #${attempt}`);
            try {
              const sig = await autoSwap({
                inputMint: "So11111111111111111111111111111111111111112",
                outputMint: baseMint,
                amountInLamports: globalThis.RUNTIME_CONFIG.MODAL_LAMPORTS,
                signer: keypair,
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
        
              console.log(`${getTimestamp()} ✅ Swap sukses. TX:`, sig);
        
              // ✅ Cek apakah token sudah masuk ke wallet
              for (let i = 0; i < 10; i++) {
                await delay(1500);
                balX = await getUserTokenBalanceNative(connection, baseMint, pubkey);
                if (balX > 0) {
                  saveTrackedSwap(baseMint, pubkey.toBase58());
                  break;
                }
              }
              
        
              break; // keluar dari loop swap jika tidak throw error
            } catch (e) {
              console.warn(`${getTimestamp()} ❌ Swap gagal attempt #${attempt}:`, e.message || e);
              await delay(2000);
            }
          }
        
          if (balX === 0) {
            console.warn(`${getTimestamp()} ❌ Token tidak masuk setelah 3 kali swap. Batalkan.`);
            if (globalThis.RUNTIME_CONFIG.ANCHOR === "X") {
              walletSlot.lastUsedMap[baseMint] = Date.now();
            } else {
              walletSlot.lastUsedMap[baseMint] = 0;
            }            
            continue;
          
          }

          if (balX < 16000) {
            console.log(`${getTimestamp()} ⚠️ Jumlah token X terlalu kecil untuk add LP, skip.`);
            walletSlot.lastUsedMap[baseMint] = 0;
            continue;
          }
        } else {
          console.log(`${getTimestamp()} ⏭️ Swap dilewati: One Side Token Y (SOL)`);
        }
        

        let addLpSuccess = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            console.log(`${getTimestamp()} ➕ Add LP attempt #${attempt}`);
            const result = await autoAddLpSafe({
              connection,
              dlmmPool,
              user: keypair,
              poolAddress,
              mode: globalThis.RUNTIME_CONFIG.MODE,
              strategyType: globalThis.RUNTIME_CONFIG.STRATEGY,
              anchorAmountLamports: new BN(balX),
              slippageBps: 300
            });
        
            // ✅ Validasi: pastikan posisi benar-benar terbuka
            let positionDetected = false;
            for (let retry = 1; retry <= 5; retry++) {
              const userPositions = await dlmmPool.getPositionsByUserAndLbPair(keypair.publicKey);
              if (userPositions?.userPositions?.length) {
                positionDetected = true;
                break;
              }
              console.log(`${getTimestamp()} ⏳ Cek posisi retry #${retry} belum terdeteksi...`);
              await delay(2000);
            }
        
            if (!positionDetected) {
              console.warn(`${getTimestamp()} ❌ Tidak ada posisi terbuka setelah Add LP (setelah 5x cek), kemungkinan gagal parsial. Skip token.`);
        
              walletSlot.usedTokens.delete(baseMint);
              walletSlot.usedBaseMintMap?.[baseMint]?.delete(poolAddress);
              if (walletSlot.usedBaseMintMap?.[baseMint]?.size === 0) {
                delete walletSlot.usedBaseMintMap[baseMint];
              }
        
              walletActivePoolMap.delete(pubkey.toBase58()); // Tambahan pembersih pool aktif
        
              // ✅ Tambah reuse delay sesuai anchor
              if (globalThis.RUNTIME_CONFIG.ANCHOR === "X" || globalThis.RUNTIME_CONFIG.ANCHOR === "Y") {
                walletSlot.lastUsedMap[baseMint] = Date.now();
              }
        
              addLpSuccess = false;
              break;
            }
        
            addLpSuccess = true;
            break;
        
          } catch (e) {
            console.warn(`${getTimestamp()} ❌ Add LP gagal (attempt ${attempt}):`, e.message || e);
            await delay(2000);
          }
        }
        
        
        if (!addLpSuccess) {
          console.warn(`${getTimestamp()} ❌ Gagal add LP setelah 3 percobaan. Skip token.`);
        
          try {
            const balTokenX = await getUserTokenBalanceNative(connection, baseMint, keypair.publicKey);
            if (balTokenX > 0) {
              console.log(`${getTimestamp()} 🔄 Swap kembali ${symbol} ke SOL karena gagal add LP...`);
              await delay(2000);
        
              let swapSuccess = false;
              for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                  console.log(`🔁 Swap ke SOL attempt #${attempt}`);
                  const sig = await autoSwap({
                    inputMint: baseMint,
                    outputMint: "So11111111111111111111111111111111111111112", // SOL
                    amountInLamports: balTokenX,
                    signer: keypair,
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
        
                  console.log(`${getTimestamp()} ✅ Swap ke SOL sukses. TX:`, sig);
                  swapSuccess = true;
                  break;
                } catch (e) {
                  console.warn(`${getTimestamp()} ⚠️ Swap ke SOL gagal attempt #${attempt}:`, e.message || e);
                  await delay(2000);
                }
              }
        
              if (!swapSuccess) {
                console.warn(`${getTimestamp()} ❌ Gagal swap ${symbol} ke SOL setelah 3 percobaan.`);
              }
            } else {
              console.log(`${getTimestamp()} ℹ️ Tidak ada sisa token ${symbol} untuk di-swap ke SOL.`);
            }
          } catch (e) {
            console.warn(`${getTimestamp()} ⚠️ Gagal cek balance token X (${symbol}):`, e.message || e);
          }
        
          continue;
        }
        
        
        
        if (!walletSlot.usedBaseMintMap[baseMint]) {
          walletSlot.usedBaseMintMap[baseMint] = new Set();
        }
        walletSlot.usedBaseMintMap[baseMint].add(poolAddress);
        walletActivePoolMap.set(pubkey.toBase58(), poolAddress); // 🧠 Tandai posisi aktif
        

        console.log(`${getTimestamp()} 📡 Monitor PnL dimulai:`, poolAddress);
        const intervalId = setInterval(async () => {
          const result = await monitorPnL(poolAddress, keypair);

          if (result?.closed) {
            clearInterval(monitoredPools.get(poolAddress));
            monitoredPools.delete(poolAddress);
            walletActivePoolMap.delete(pubkey.toBase58()); // 🧹 Hapus posisi aktif
          
            walletSlot.usedTokens.delete(result.baseMint);
            walletSlot.usedBaseMintMap?.[result.baseMint]?.delete(result.pool);
            if (walletSlot.usedBaseMintMap?.[result.baseMint]?.size === 0) {
              delete walletSlot.usedBaseMintMap[result.baseMint];
            }
          
            console.log(`${getTimestamp()} 🧹 Pool & token dibersihkan dari slot wallet:`, result.baseMint);
          }
          
        }, 10_000);
        

        if (addLpSuccess) {
          monitoredPools.set(poolAddress, intervalId);
          usedTokens.add(baseMint);
        }
      }
      console.log(`${getTimestamp()} ⏳ Tunggu 1 menit sebelum scan token baru...`);
      await delay(60_000);
    } catch (err) {
      console.error("❌ Error:", err.message || err);
      await delay(10_000);
    }
  }
}

// 🌊 WSOL Monitor: auto unwrap setiap 60 detik
setInterval(async () => {
  for (const w of walletQueue) {
    const pubkey = w.keypair.publicKey;
    const short = pubkey.toBase58().slice(0, 6);
    try {
      const bal = await getUserTokenBalanceNative(connection, "So11111111111111111111111111111111111111112", pubkey);
      if (bal <= 0) continue;

      const unwrapped = await autoUnwrapWsol(w.keypair);
      if (unwrapped) {
        console.log(`${getTimestamp()} 💧 [${short}] WSOL ${bal} berhasil di-unwrapped ke SOL`);
      } else {
        // console.warn(`⚠️ [${short}] Gagal unwrap WSOL (balance ada, tapi gagal proses)`);
      }
    } catch (e) {
      if (!e.message?.includes("Associated Token Account does not exist")) {
        console.warn(`${getTimestamp()} ⚠️ [${short}] Error saat cek WSOL:`, e.message || e);
      }
    }
  }
}, 60_000);

runSwapTracker(connection, walletQueue);
setInterval(() => runSwapTracker(connection, walletQueue), 5 * 60 * 1000);
setInterval(() => runHourlyCheck(walletQueue), 60 * 60 * 1000);

autoVolumeLoop();
