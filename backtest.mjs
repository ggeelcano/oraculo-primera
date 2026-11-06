// Backtest semana a semana sobre Primera 2024-25 y 2025-26: elige parámetros y mide acierto real
import fs from "node:fs";
import path from "node:path";
import { ROOT, loadMatches, fit, lambdas, scoreMatrix, outcome, marketProbs, logLoss, brier, resIdx } from "./lib.mjs";

const matches = loadMatches();
const TEST_SEASONS = (process.env.SEASONS || "2425,2526").split(",");
const weekStart = t => { const d = new Date(t); const wd = (d.getUTCDay() + 6) % 7; return t - wd * 864e5; };

function runBacktest(cfg, seasons) {
  const test = matches.filter(m => m.div === "SP1" && seasons.includes(m.season));
  const byWeek = new Map();
  for (const m of test) { const w = weekStart(m.date); if (!byWeek.has(w)) byWeek.set(w, []); byWeek.get(w).push(m); }
  const out = [];
  let prev = null;
  for (const [w, ms] of [...byWeek.entries()].sort((a, b) => a[0] - b[0])) {
    const model = fit(matches, { ...cfg, asOf: w }, prev);
    prev = model;
    for (const m of ms) {
      const [lh, la] = lambdas(model, m.home, m.away);
      out.push({ m, lh, la, mk: marketProbs(m.odds), r: resIdx(m) });
    }
  }
  return out;
}

function evalPreds(preds, rho, beta = 0) {
  let ll = 0, br = 0, hit = 0, n = 0;
  for (const p of preds) {
    if (beta > 0 && !p.mk) continue;
    const o = outcome(scoreMatrix(p.lh, p.la, rho));
    let q = [o.p1, o.px, o.p2];
    if (beta > 0) q = q.map((x, i) => (1 - beta) * x + beta * p.mk[i]);
    ll += logLoss(q, p.r); br += brier(q, p.r);
    const best = q.indexOf(Math.max(...q));
    if (best === p.r) hit++;
    n++;
  }
  return { ll: ll / n, brier: br / n, acc: hit / n, n };
}

const t0 = Date.now();
// Rejilla explorada en 4 rondas (6-nov-2026): vida media 35-1000 días, xG/tiros 0-0,8, cuotas 0-1, suavizado 0,05-16.
// Ganó memoria corta + peso alto de cuotas; diferencias por debajo de 0,001 son ruido, así que se fija esta:
const grid = process.env.GRID === "1"
  ? [35, 55, 90].flatMap(halfLife => [0, 0.05].flatMap(k => [0.9, 0.95, 1].flatMap(m => [0.05, 0.15].map(ridge => ({ halfLife, k, m, ridge }))))).filter(c => c.k + c.m <= 1)
  : [{ halfLife: 35, k: 0.05, m: 0.9, ridge: 0.05 }];
const results = [];
for (const cfg of grid) {
  const preds = runBacktest(cfg, TEST_SEASONS);
  const e = evalPreds(preds, -0.06);
  results.push({ cfg, ...e, preds });
  console.log(JSON.stringify(cfg), "ll", e.ll.toFixed(4), "acc", (e.acc * 100).toFixed(1), "n", e.n, ((Date.now() - t0) / 1000).toFixed(0) + "s");
}
results.sort((a, b) => a.ll - b.ll);
const best = results[0];
// ajuste fino de rho y mezcla con mercado
let bestRho = -0.06, bestRhoLL = Infinity;
for (let rho = -0.2; rho <= 0.051; rho += 0.01) { const e = evalPreds(best.preds, rho); if (e.ll < bestRhoLL) { bestRhoLL = e.ll; bestRho = +rho.toFixed(2); } }
const blend = [];
for (let b = 0; b <= 1.0001; b += 0.1) blend.push({ beta: +b.toFixed(1), ...evalPreds(best.preds, bestRho, b) });
blend.sort((a, b) => a.ll - b.ll);
const bestBeta = blend[0].beta;

// métricas finales en partidos con cuotas (misma muestra para comparar)
const withMk = best.preds.filter(p => p.mk);
const model = evalPreds(withMk, bestRho);
let mll = 0, mbr = 0, mhit = 0;
for (const p of withMk) { mll += logLoss(p.mk, p.r); mbr += brier(p.mk, p.r); if (p.mk.indexOf(Math.max(...p.mk)) === p.r) mhit++; }
const market = { ll: mll / withMk.length, brier: mbr / withMk.length, acc: mhit / withMk.length, n: withMk.length };
const blended = evalPreds(withMk, bestRho, bestBeta);
// referencias tontas: frecuencias históricas fijas y "siempre gana el local"
const freq = [0, 0, 0]; for (const p of withMk) freq[p.r]++;
const fq = freq.map(x => x / withMk.length);
let fll = 0; for (const p of withMk) fll += logLoss(fq, p.r);
const naive = { ll: fll / withMk.length, acc: fq[0], n: withMk.length };

// calibración del mezclado: probabilidad de victoria local agrupada en tramos
const bins = Array.from({ length: 8 }, (_, i) => ({ lo: i / 8, hi: (i + 1) / 8, n: 0, sumP: 0, hits: 0 }));
for (const p of withMk) {
  const o = outcome(scoreMatrix(p.lh, p.la, bestRho));
  const q = [o.p1, o.px, o.p2].map((x, i) => (1 - bestBeta) * x + bestBeta * p.mk[i]);
  for (const c of [0, 2]) {
    const b = bins[Math.min(7, Math.floor(q[c] * 8))];
    b.n++; b.sumP += q[c]; if (p.r === c) b.hits++;
  }
}

const config = { ...best.cfg, rho: bestRho, beta: bestBeta };
const summary = {
  seasons: TEST_SEASONS, config, model, market, blended, naive,
  calibration: bins.filter(b => b.n >= 10).map(b => ({ p: b.sumP / b.n, f: b.hits / b.n, n: b.n })),
  grid: results.slice(0, 10).map(r => ({ ...r.cfg, ll: r.ll, acc: r.acc })),
  blendCurve: [...blend].sort((a, b) => a.beta - b.beta).map(b => ({ beta: b.beta, ll: b.ll, acc: b.acc })),
};
fs.writeFileSync(path.join(ROOT, "config.json"), JSON.stringify(config, null, 2));
fs.writeFileSync(path.join(ROOT, "backtest.json"), JSON.stringify(summary, null, 2));
console.log("MEJOR", JSON.stringify(config));
console.log("modelo", JSON.stringify(model));
console.log("mercado", JSON.stringify(market));
console.log("mezcla", JSON.stringify(blended));
console.log("ingenuo", JSON.stringify(naive));
console.log("tiempo", ((Date.now() - t0) / 1000).toFixed(0), "s");
