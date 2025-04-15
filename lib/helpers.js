import axios from "axios";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { unpackAccount, unpackMint } from "@solana/spl-token";

const WSOL_MINT = "So11111111111111111111111111111111111111112";

export async function getTokenInfo(poolAddress) {
  try {
    const { data } = await axios.get(`https://dlmm-api.meteora.ag/pair/${poolAddress}`);
    const [tokenXSymbol, tokenYSymbol] = data.name.split("-");
    const mintX = data.mint_x;
    const mintY = data.mint_y;
    return { tokenXSymbol, tokenYSymbol, mintX, mintY };
  } catch (e) {
    console.warn("⚠️ Gagal mengambil data token dari API Meteora. Gunakan default.");
    return {
      tokenXSymbol: "Token X",
      tokenYSymbol: "Token Y",
      mintX: null,
      mintY: null,
    };
  }
}


export async function getTokenDecimals(connection, mintAddress) {
  try {
    const mint = new PublicKey(mintAddress);
    if (mint.toBase58() === WSOL_MINT) {
      return 9; // Native SOL (wrapped)
    }

    const info = await connection.getAccountInfo(mint);
    if (!info) throw new Error("Mint tidak ditemukan");
    const mintData = unpackMint(info.data);
    return mintData.decimals;
  } catch (err) {
    console.warn(`⚠️ Gagal ambil decimals untuk ${mintAddress}:`, err.message);
    return 6; // fallback default
  }
}

export async function getUserTokenBalanceNative(connection, mintAddress, ownerPubkey) {
  try {
    const ata = await getAssociatedTokenAddress(new PublicKey(mintAddress), ownerPubkey);
    const info = await connection.getAccountInfo(ata);
    if (!info) {
      console.warn(`⚠️ Tidak menemukan ATA untuk mint ${mintAddress}`);
      return 0;
    }

    const accInfo = await connection.getTokenAccountBalance(ata);
    return parseFloat(accInfo.value.uiAmountString || "0");
  } catch (err) {
    console.warn("⚠️ Gagal ambil balance:", err.message);
    return 0;
  }
}
