// force.js
import fs from "fs";

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

function main() {
  const pnl = loadJson(pnlPath);
  const forceList = loadJson(forcePath);
  const cooldownList = loadJson(cooldownPath);

  const now = Date.now();
  const cooldownMs = 7 * 60 * 60 * 1000; // 7 jam
  let count = 0;

  for (const [posKey, entry] of Object.entries(pnl)) {
    if (!entry.isClosed && !entry.removedAt && entry.mintX) {
      forceList[posKey] = true;
      cooldownList[entry.mintX] = now + cooldownMs;
      count++;
    }
  }

  if (count > 0) {
    saveJson(forcePath, forceList);
    saveJson(cooldownPath, cooldownList);
    console.log(`✅ ${count} posisi aktif ditandai untuk force remove + cooldown token 7 jam.`);
  } else {
    console.log("⚠️ Tidak ada posisi aktif yang cocok untuk diproses.");
  }
}

main();
