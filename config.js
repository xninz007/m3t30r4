// config.js
import { PublicKey } from "@solana/web3.js";

// Ganti dengan key asli
export const RPC = "https://mainnet.helius-rpc.com/?api-key=45d8a2f1-3394-4ca3-944a-582cd93d2c1e";

// Jangan hardcode pool lagi
export const getPoolAddress = async () => {
  const inquirer = await import("inquirer");
  const { poolAddress } = await inquirer.default.prompt([
    {
      type: "input",
      name: "poolAddress",
      message: "Masukkan Pool Address (DLMM):",
      validate: (val) => {
        try {
          new PublicKey(val);
          return true;
        } catch {
          return "❌ Pool address tidak valid.";
        }
      },
    },
  ]);
  return new PublicKey(poolAddress);
};
