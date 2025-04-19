// config.js
import { PublicKey } from "@solana/web3.js";

// Ganti dengan key asli
export const RPC = "GANTI RPC";

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
