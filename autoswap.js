import axios from "axios";
import {
  Connection,
  Keypair,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { bs58PrivateKey, RPC } from "./config.js";
import { ensureAtaTokenAccount } from "./utils.js";

const user = Keypair.fromSecretKey(bs58.decode(bs58PrivateKey));
const connection = new Connection(RPC);

export async function autoSwap({
  inputMint,
  outputMint,
  amountInLamports,
  slippageBps = 100,
  tryLegacy = false, // fallback legacy TX
}) {
  try {
    const outputAta = await ensureAtaTokenAccount(connection, outputMint, user);

    const quoteUrl = `https://ultra-api.jup.ag/proxy/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountInLamports}&slippageBps=${slippageBps}&swapMode=ExactIn&taker=${user.publicKey.toBase58()}&excludeDexes=Whirlpool`;
    const { data: quote } = await axios.get(quoteUrl);
    if (!quote?.outAmount) throw new Error("Quote tidak ditemukan");

    const { data: swapRes } = await axios.post(
      "https://ultra-api.jup.ag/proxy/swap?swapType=aggregator",
      {
        quoteResponse: quote,
        userPublicKey: user.publicKey.toBase58(),
        wrapAndUnwrapSol: inputMint === "So11111111111111111111111111111111111111112",
        dynamicComputeUnitLimit: true,
        correctLastValidBlockHeight: true,
        asLegacyTransaction: tryLegacy,
        allowOptimizedWrappedSolTokenAccount: true,
        addConsensusAccount: true,
        computeUnitPriceMicroLamports: 1_000_000,
      }
    );

    if (!swapRes?.swapTransaction) throw new Error("Swap transaction tidak tersedia");

    const txBuffer = Buffer.from(swapRes.swapTransaction, "base64");
    const tx = VersionedTransaction.deserialize(txBuffer);
    tx.sign([user]);

    const sig = await connection.sendTransaction(tx, { skipPreflight: false });
    await connection.confirmTransaction(
      {
        signature: sig,
        blockhash: swapRes.blockhash,
        lastValidBlockHeight: swapRes.lastValidBlockHeight,
      },
      "confirmed"
    );

    console.log("✅ Swap success:", sig);
    return sig;

  } catch (err) {
    const logs = err?.response?.data || err?.message || err;
    console.error("❌ Gagal swap:", logs);
    if (err.logs) console.warn("🪵 Logs:", err.logs);

    // Fallback legacy tx if not already tried
    if (!tryLegacy) {
      console.warn("🔁 Coba ulang pakai legacy transaction...");
      return autoSwap({ inputMint, outputMint, amountInLamports, slippageBps, tryLegacy: true });
    }
  }
}

