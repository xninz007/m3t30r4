import axios from "axios";
import {
  Connection,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import { RPC } from "./config.js";
import { ensureAtaTokenAccount } from "./utils.js";

const connection = new Connection(RPC);

export async function autoSwap({
  inputMint,
  outputMint,
  amountInLamports,
  signer, // ⬅️ Harus dikirim dari luar (Keypair)
  slippageBps = 100,
  tryLegacy = false,
}) {
  if (!signer || !signer.publicKey) {
    throw new Error("Parameter 'signer' (Keypair) harus disediakan");
  }

  try {
    await ensureAtaTokenAccount(connection, outputMint, signer);

    const quoteUrl = `https://ultra-api.jup.ag/proxy/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountInLamports}&slippageBps=${slippageBps}&swapMode=ExactIn&taker=${signer.publicKey.toBase58()}&excludeDexes=Whirlpool`;
    const { data: quote } = await axios.get(quoteUrl);
    if (!quote?.outAmount) throw new Error("Quote tidak ditemukan");

    const { data: swapRes } = await axios.post(
      "https://ultra-api.jup.ag/proxy/swap?swapType=aggregator",
      {
        quoteResponse: quote,
        userPublicKey: signer.publicKey.toBase58(),
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
    tx.sign([signer]);

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

    if (!tryLegacy) {
      console.warn("🔁 Coba ulang pakai legacy transaction...");
      return autoSwap({ inputMint, outputMint, amountInLamports, signer, slippageBps, tryLegacy: true });
    }
  }
}
