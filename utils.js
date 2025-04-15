import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotent,
} from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { bs58PrivateKey, RPC } from "./config.js";
import bs58 from "bs58";
import { getPriorityInstructions } from "./lib/fee.js"; // pastikan path ini sesuai

const connection = new Connection(RPC);
const user = bs58.decode(bs58PrivateKey);
const wallet = new PublicKey(user.slice(32));

export async function getPriceUsdMap(mintList) {
  const url = `https://api.jup.ag/price/v2?ids=${mintList.join(",")}`;

  try {
    const res = await fetch(url);
    const json = await res.json();

    const map = {};
    for (const mint of mintList) {
      const price = parseFloat(json?.data?.[mint]?.price || "0");
      map[mint] = price;
    }

    console.log("💲 Prices:", map);
    return map;
  } catch (err) {
    console.error("❌ Failed to fetch price from Jupiter:", err);
    return {};
  }
}

export async function getTokenDecimals(connection, mintAddress) {
  try {
    const mint = await getMint(connection, new PublicKey(mintAddress));
    return mint.decimals;
  } catch (e) {
    console.warn(`⚠️ Gagal ambil decimals untuk ${mintAddress}:`, e.message);
    return 9; // fallback ke 9
  }
}

export async function ensureAtaTokenAccount(connection, mint, user) {
  // Skip ATA creation for native SOL
  if (mint === "So11111111111111111111111111111111111111112") {
    console.log("ℹ️ Native SOL tidak memerlukan ATA.");
    return null;
  }

  const ata = await getAssociatedTokenAddress(new PublicKey(mint), user.publicKey);
  try {
    await getAccount(connection, ata);
    return ata;
  } catch {
    console.log(`⚠️ ATA belum ada untuk ${mint}. Membuat...`);
    await createAssociatedTokenAccountIdempotent(
      connection,
      user,
      new PublicKey(mint),
      user.publicKey
    );
    return ata;
  }
}


export async function getUserTokenBalanceNative(connection, mintAddress, pubkey) {
  try {
    if (mintAddress === "So11111111111111111111111111111111111111112") {
      return await connection.getBalance(pubkey);
    }

    const ata = getAssociatedTokenAddressSync(
      new PublicKey(mintAddress),
      pubkey,
      false,
      TOKEN_PROGRAM_ID
    );

    const acc = await getAccount(connection, ata);
    return Number(acc.amount);
  } catch (err) {
    // Fallback untuk SPL v2022 atau jika ATA belum confirm
    const res = await connection.getTokenAccountsByOwner(pubkey, {
      mint: new PublicKey(mintAddress),
    });

    let maxBalance = 0;

    for (const acc of res.value) {
      const parsed = acc.account.data?.parsed;
      const balance = Number(parsed?.info?.tokenAmount?.amount || 0);
      const addr = acc.pubkey.toBase58();
      console.log(`🔍 Token Account: ${addr} — Balance: ${balance}`);
      if (balance > maxBalance) maxBalance = balance;
    }

    return maxBalance;
  }
}

