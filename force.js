import fs from "fs";
import inquirer from "inquirer";

const pnlPath = "./pnl.json";
const forcePath = "./forceRemove.json";
const cooldownPath = "./cooldown.json";

function loadJson(path) {
  try {
    return fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
  } catch (e) {
    console.warn(`⚠️ Gagal baca file ${path}:`, e.message);
    return {};
  }
}

function saveJson(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
}

async function main() {
  const { mode } = await inquirer.prompt([
    {
      type: "list",
      name: "mode",
      message: "Pilih mode:",
      choices: [
        { name: "1. Remove Only (tidak inject cooldown)", value: "removeOnly" },
        { name: "2. Remove + Inject Cooldown 7 jam", value: "removeAndCooldown" },
      ],
    },
  ]);

  const pnl = loadJson(pnlPath);
  const forceList = loadJson(forcePath);
  const cooldownList = loadJson(cooldownPath);

  const now = Date.now();
  const cooldownMs = 7 * 60 * 60 * 1000; // 7 jam
  let count = 0;

  for (const [posKey, entry] of Object.entries(pnl)) {
    if (!entry.isClosed && !entry.removedAt && entry.mintX) {
      forceList[posKey] = true;
      if (mode === "removeAndCooldown") {
        cooldownList[entry.mintX] = now + cooldownMs;
      }
      count++;
    }
  }

  if (count > 0) {
    saveJson(forcePath, forceList);
    if (mode === "removeAndCooldown") {
      saveJson(cooldownPath, cooldownList);
    }
    console.log(`✅ ${count} posisi aktif ditandai untuk force remove${mode === "removeAndCooldown" ? " + cooldown token 7 jam" : ""}.`);
  } else {
    console.log("⚠️ Tidak ada posisi aktif yang cocok untuk diproses.");
  }
}

main();
