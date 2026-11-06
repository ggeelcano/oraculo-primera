// Descarga los CSV de football-data.co.uk (Primera y Segunda, varias temporadas) + próximos partidos
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
fs.mkdirSync(DIR, { recursive: true });

// temporada en curso: desde julio cuenta la nueva (si aún no hay fichero, se salta y sigue la anterior)
const now = new Date();
const startYear = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
const code = y => String(y % 100).padStart(2, "0") + String((y + 1) % 100).padStart(2, "0");
const SEASONS = [4, 3, 2, 1, 0].map(k => code(startYear - k));
const DIVS = ["SP1", "SP2"];
const jobs = [];
for (const s of SEASONS) for (const d of DIVS)
  jobs.push({ url: `https://www.football-data.co.uk/mmz4281/${s}/${d}.csv`, file: `${d}_${s}.csv` });
jobs.push({ url: "https://www.football-data.co.uk/fixtures.csv", file: "fixtures.csv" });

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) liga-predictor" };
let ok = 0;
for (const j of jobs) {
  try {
    const r = await fetch(j.url + "?t=" + Date.now(), { headers: UA });
    if (!r.ok) { console.log("FALLO", r.status, j.file); continue; }
    const txt = await r.text();
    fs.writeFileSync(path.join(DIR, j.file), txt);
    console.log("ok", j.file, txt.split(String.fromCharCode(10)).length - 1, "líneas");
    ok++;
  } catch (e) { console.log("ERROR", j.file, e.message); }
}
console.log("Descargados", ok, "de", jobs.length);
