import axios from "axios";
import {
  Connection,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import { RPC } from "./config.js";

const connection = new Connection(RPC);

export async function autoSwap({
  inputMint,
  outputMint,
  amountInLamports,
  signer,
}) {
  if (!signer || !signer.publicKey) {
    throw new Error("Parameter 'signer' (Keypair) harus disediakan");
  }

  try {
    // Step 1: GET /order
    const taker = signer.publicKey.toBase58();
    const orderUrl = `https://ultra-api.jup.ag/order?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountInLamports}&taker=${taker}&swapMode=ExactIn`;
    const { data: order } = await axios.get(orderUrl);

    if (!order?.transaction || !order?.requestId) throw new Error("Order response tidak valid");

    // Step 2: Sign the transaction
    const txBuffer = Buffer.from(order.transaction, "base64");
    const tx = VersionedTransaction.deserialize(txBuffer);
    tx.sign([signer]);

    // Step 3: POST /execute
    const { data: result } = await axios.post("https://ultra-api.jup.ag/execute", {
      signedTransaction: Buffer.from(tx.serialize()).toString("base64"),
      requestId: order.requestId,
    });

    if (result.status !== "Success") {
      throw new Error(`Swap gagal: ${JSON.stringify(result)}`);
    }

    console.log("✅ Swap success:", result.signature);
    return result.signature;

  } catch (err) {
    console.error("❌ Gagal swap:", err?.response?.data || err?.message || err);
  }
}
