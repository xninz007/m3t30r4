import { ComputeBudgetProgram } from "@solana/web3.js";

export function getPriorityInstructions(mode = "turbo") {
  const levels = {
    fast: 500_000,     // 0.0007 SOL
    turbo: 1_000_000,  // 0.0014 SOL
    ultra: 2_000_000,  // 0.0028 SOL
  };

  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: levels[mode] || levels.turbo }),
  ];
}
