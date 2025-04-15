import { Keypair, ComputeBudgetProgram } from "@solana/web3.js";
import { getPriorityInstructions } from "./fee.js";

export async function sendTx(connection, dlmmPool, user, totalXAmount, totalYAmount, minBinId, maxBinId, strategyType) {
  const newPosition = Keypair.generate();

  const tx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: newPosition.publicKey,
    user: user.publicKey,
    totalXAmount,
    totalYAmount,
    strategy: {
      maxBinId,
      minBinId,
      strategyType,
    },
  });

  try {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = user.publicKey;

    // 💣 Hapus semua ComputeBudget instruksi default (jika ada)
    tx.instructions = tx.instructions.filter(
      (ix) => ix.programId.toBase58() !== ComputeBudgetProgram.programId.toBase58()
    );

    // 💥 Tambahkan priority fee dengan jelas
    const [computeLimitIx, priorityFeeIx] = getPriorityInstructions("turbo");

    tx.instructions = [computeLimitIx, priorityFeeIx, ...tx.instructions];

    tx.partialSign(user, newPosition);

    const rawTx = tx.serialize();
    const signature = await connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
    });

    console.log("📨 Signature:", signature);
    console.log("⏳ Menunggu konfirmasi transaksi...");

    // 🧾 Tampilkan estimasi fee dari chain

    await connection.confirmTransaction(
      {
        signature,
        blockhash,
        lastValidBlockHeight,
      },
      "confirmed"
    );

    console.log("✅ Add liquidity sukses");
    console.log("🔗 Tx hash:", signature);
    console.log("📘 Position pubkey:", newPosition.publicKey.toBase58());

    //aktifin kalau mau manual
// await inquirer.prompt([
//   { type: "input", name: "back", message: "🔁 Tekan ENTER untuk kembali..." }
// ]);

  } catch (error) {
    console.error("❌ Gagal add liquidity:", error);
    if (error.signature) {
      console.log(`🔗 Cek explorer: https://solscan.io/tx/${error.signature}`);
    }
    throw error;
  }
}
