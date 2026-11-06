// Núcleo del modelo: lectura de datos, ajuste Poisson (Dixon-Coles) ponderado por fecha, predicción y simulación
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DATA = path.join(ROOT, "data");
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);

export function parseCSV(txt) {
  const lines = txt.replace(/^\uFEFF/, "").split(NL).map(l => l.split(CR).join("")).filter(l => l.trim());
  const header = lines[0].split(",");
  return lines.slice(1).map(l => {
    const c = l.split(",");
    const o = {};
    header.forEach((h, i) => (o[h] = c[i]));
    return o;
  });
}

export function parseDate(s) {
  const [d, m, y] = s.split("/").map(Number);
  const yy = y < 100 ? 2000 + y : y;
  return Date.UTC(yy, m - 1, d);
}

const num = v => (v === undefined || v === "" ? NaN : Number(v));

function pickOdds(r) {
  const tries = [["AvgH", "AvgD", "AvgA"], ["B365H", "B365D", "B365A"], ["BWH", "BWD", "BWA"]];
  for (const [h, d, a] of tries) {
    const o = [num(r[h]), num(r[d]), num(r[a])];
    if (o.every(x => x > 1)) return o;
  }
  return null;
}

export function loadMatches() {
  const files = fs.readdirSync(DATA).filter(f => /^SP[12]_\d{4}\.csv$/.test(f));
  const all = [];
  for (const f of files) {
    const [div, season] = f.replace(".csv", "").split("_");
    const rows = parseCSV(fs.readFileSync(path.join(DATA, f), "utf8"));
    const ms = [];
    for (const r of rows) {
      if (!r.HomeTeam || r.FTHG === undefined || r.FTHG === "") continue;
      ms.push({
        div, season,
        date: parseDate(r.Date), time: r.Time || "",
        home: r.HomeTeam, away: r.AwayTeam,
        hg: num(r.FTHG), ag: num(r.FTAG),
        hxg: num(r.HxG), axg: num(r.AxG),
        hs: num(r.HS), as: num(r.AS), hst: num(r.HST), ast: num(r.AST),
        hc: num(r.HC), ac: num(r.AC), hy: num(r.HY), ay: num(r.AY), hr: num(r.HR), ar: num(r.AR),
        odds: pickOdds(r),
        o25: num(r["Avg>2.5"]) > 1 ? [num(r["Avg>2.5"]), num(r["Avg<2.5"])] : null,
        oddsC: [num(r.AvgCH), num(r.AvgCD), num(r.AvgCA)].every(x => x > 1) ? [num(r.AvgCH), num(r.AvgCD), num(r.AvgCA)] : null,
        o25C: num(r["AvgC>2.5"]) > 1 ? [num(r["AvgC>2.5"]), num(r["AvgC<2.5"])] : null,
      });
    }
    // goles esperados que "descuentan" las cuotas (1X2 y más/menos 2,5)
    for (const m of ms) {
      // para entrenar se usan las cuotas de cierre (las más informadas) si existen
      const useC = process.env.CIERRE !== "0" && m.oddsC;
      const imp = useC ? impliedLambdas(m.oddsC, m.o25C || m.o25) : impliedLambdas(m.odds, m.o25);
      m.mlh = imp ? imp[0] : NaN; m.mla = imp ? imp[1] : NaN;
    }
    // goles por tiro a puerta de esa liga-temporada (para el sustituto del xG cuando no hay xG)
    let g = 0, s = 0;
    for (const m of ms) if (m.hst >= 0 && m.ast >= 0) { g += m.hg + m.ag; s += m.hst + m.ast; }
    const conv = s > 0 ? g / s : 0.3;
    for (const m of ms) m.conv = conv;
    all.push(...ms);
  }
  all.sort((a, b) => a.date - b.date);
  return all;
}

export function loadFixtures() {
  const rows = parseCSV(fs.readFileSync(path.join(DATA, "fixtures.csv"), "utf8"));
  return rows.filter(r => r.Div === "SP1").map(r => ({
    date: parseDate(r.Date), time: r.Time || "", home: r.HomeTeam, away: r.AwayTeam,
    odds: pickOdds(r),
    o25: num(r["Avg>2.5"]) > 1 ? [num(r["Avg>2.5"]), num(r["Avg<2.5"])] : null,
  }));
}

// Goles esperados implícitos en las cuotas: busca (lh, la) cuyo Poisson reproduce 1X2 y más/menos 2,5
export function impliedLambdas(odds, o25) {
  const p = marketProbs(odds);
  if (!p) return null;
  let po = null;
  if (o25) { const a = 1 / o25[0], b = 1 / o25[1]; po = a / (a + b); }
  const res = (lh, la) => {
    const o = outcome(scoreMatrix(lh, la, 0, 10));
    const r = [o.p1 - p[0], o.p2 - p[2]];
    if (po !== null) r.push(o.over - po);
    return r;
  };
  let x = [Math.log(1.4), Math.log(1.1)];
  for (let it = 0; it < 25; it++) {
    const r0 = res(Math.exp(x[0]), Math.exp(x[1]));
    const e = 1e-4;
    const r1 = res(Math.exp(x[0] + e), Math.exp(x[1]));
    const r2 = res(Math.exp(x[0]), Math.exp(x[1] + e));
    const J = r0.map((_, i) => [(r1[i] - r0[i]) / e, (r2[i] - r0[i]) / e]);
    // Gauss-Newton: (J'J) dx = -J'r
    let a = 0, b = 0, c = 0, g0 = 0, g1 = 0;
    for (let i = 0; i < r0.length; i++) { a += J[i][0] ** 2; b += J[i][0] * J[i][1]; c += J[i][1] ** 2; g0 += J[i][0] * r0[i]; g1 += J[i][1] * r0[i]; }
    const det = a * c - b * b;
    if (Math.abs(det) < 1e-12) break;
    const d0 = -(c * g0 - b * g1) / det, d1 = -(a * g1 - b * g0) / det;
    x = [x[0] + Math.max(-0.5, Math.min(0.5, d0)), x[1] + Math.max(-0.5, Math.min(0.5, d1))];
    if (Math.abs(d0) + Math.abs(d1) < 1e-6) break;
  }
  const lh = Math.exp(x[0]), la = Math.exp(x[1]);
  if (!(lh > 0.05 && lh < 8 && la > 0.05 && la < 8)) return null;
  return [lh, la];
}

// Goles "ajustados": mezcla de goles reales, xG (o tiros a puerta x conversión media si no hay xG)
// y goles esperados según las cuotas previas del partido
function adjGoals(g, xg, sot, conv, mkl, k, mw) {
  let proxy = g;
  if (xg >= 0) proxy = xg;
  else if (sot >= 0) proxy = sot * conv;
  if (!(mkl > 0)) { // sin cuotas: reparte el peso entre goles y xG
    const kk = mw < 1 ? Math.min(1, k / (1 - mw)) : 0;
    return (1 - kk) * g + kk * proxy;
  }
  return (1 - k - mw) * g + k * proxy + mw * mkl;
}

// Ajuste por bloques (Newton coordenado) de: mu, desfase de Segunda, ventaja local por división, ataque y defensa por equipo
export function fit(matches, cfg, init) {
  const { asOf, halfLife, k, ridge, maxDays = 1100 } = cfg;
  const mw = cfg.m || 0;
  const teamIdx = new Map();
  const tId = t => { if (!teamIdx.has(t)) teamIdx.set(t, teamIdx.size); return teamIdx.get(t); };
  const sel = matches.filter(m => m.date < asOf && asOf - m.date <= maxDays * 864e5);
  const n = sel.length * 2;
  const y = new Float64Array(n), w = new Float64Array(n);
  const att = new Int32Array(n), def = new Int32Array(n), div2 = new Uint8Array(n), home = new Uint8Array(n);
  sel.forEach((m, i) => {
    const days = (asOf - m.date) / 864e5;
    const wt = Math.pow(0.5, days / halfLife);
    const h = tId(m.home), a = tId(m.away), d2 = m.div === "SP2" ? 1 : 0;
    y[2 * i] = adjGoals(m.hg, m.hxg, m.hst, m.conv, m.mlh, k, mw);
    y[2 * i + 1] = adjGoals(m.ag, m.axg, m.ast, m.conv, m.mla, k, mw);
    w[2 * i] = w[2 * i + 1] = wt;
    att[2 * i] = h; def[2 * i] = a; home[2 * i] = 1;
    att[2 * i + 1] = a; def[2 * i + 1] = h; home[2 * i + 1] = 0;
    div2[2 * i] = div2[2 * i + 1] = d2;
  });
  const T = teamIdx.size;
  const A = new Float64Array(T), D = new Float64Array(T);
  let mu = 0.25, off2 = -0.05, hfa1 = 0.2, hfa2 = 0.2;
  if (init) {
    mu = init.mu; off2 = init.off2; hfa1 = init.hfa1; hfa2 = init.hfa2;
    for (const [t, i] of teamIdx) if (init.teams[t]) { A[i] = init.teams[t].a; D[i] = init.teams[t].d; }
  }
  const lam = new Float64Array(n);
  const recompute = () => {
    for (let o = 0; o < n; o++) {
      let e = mu + A[att[o]] - D[def[o]];
      if (div2[o]) e += off2;
      if (home[o]) e += div2[o] ? hfa2 : hfa1;
      lam[o] = Math.exp(e);
    }
  };
  const gA = new Float64Array(T), hA = new Float64Array(T);
  let prevLL = -Infinity;
  for (let it = 0; it < 200; it++) {
    // bloque escalar: mu, off2, hfa1, hfa2 (Newton exacto en 1D cada uno)
    for (const which of [0, 1, 2, 3]) {
      recompute();
      let g = 0, h = 0;
      for (let o = 0; o < n; o++) {
        if (which === 1 && !div2[o]) continue;
        if (which === 2 && !(home[o] && !div2[o])) continue;
        if (which === 3 && !(home[o] && div2[o])) continue;
        g += w[o] * (y[o] - lam[o]); h += w[o] * lam[o];
      }
      if (h <= 0) continue;
      const step = g / h;
      if (which === 0) mu += step; else if (which === 1) off2 += step; else if (which === 2) hfa1 += step; else hfa2 += step;
    }
    // bloque ataque
    recompute();
    gA.fill(0); hA.fill(0);
    for (let o = 0; o < n; o++) { gA[att[o]] += w[o] * (y[o] - lam[o]); hA[att[o]] += w[o] * lam[o]; }
    for (let t = 0; t < T; t++) A[t] += (gA[t] - ridge * A[t]) / (hA[t] + ridge);
    // bloque defensa
    recompute();
    gA.fill(0); hA.fill(0);
    for (let o = 0; o < n; o++) { gA[def[o]] -= w[o] * (y[o] - lam[o]); hA[def[o]] += w[o] * lam[o]; }
    for (let t = 0; t < T; t++) D[t] += (gA[t] - ridge * D[t]) / (hA[t] + ridge);
    // convergencia
    recompute();
    let ll = 0;
    for (let o = 0; o < n; o++) ll += w[o] * (y[o] * Math.log(lam[o]) - lam[o]);
    for (let t = 0; t < T; t++) ll -= 0.5 * ridge * (A[t] * A[t] + D[t] * D[t]);
    if (Math.abs(ll - prevLL) < 1e-7 * Math.abs(ll)) break;
    prevLL = ll;
  }
  const teams = {};
  for (const [t, i] of teamIdx) teams[t] = { a: A[i], d: D[i] };
  return { mu, off2, hfa1, hfa2, teams, nMatches: sel.length };
}

export function lambdas(model, home, away) {
  const h = model.teams[home] || { a: 0, d: 0 }, a = model.teams[away] || { a: 0, d: 0 };
  return [Math.exp(model.mu + model.hfa1 + h.a - a.d), Math.exp(model.mu + a.a - h.d)];
}

const fact = [1]; for (let i = 1; i <= 15; i++) fact[i] = fact[i - 1] * i;
const pois = (l, x) => Math.exp(-l) * Math.pow(l, x) / fact[x];

export function scoreMatrix(lh, la, rho, max = 10) {
  const M = [];
  let tot = 0;
  for (let i = 0; i <= max; i++) {
    M[i] = [];
    for (let j = 0; j <= max; j++) {
      let p = pois(lh, i) * pois(la, j);
      if (i === 0 && j === 0) p *= 1 - lh * la * rho;
      else if (i === 0 && j === 1) p *= 1 + lh * rho;
      else if (i === 1 && j === 0) p *= 1 + la * rho;
      else if (i === 1 && j === 1) p *= 1 - rho;
      p = Math.max(p, 0);
      M[i][j] = p; tot += p;
    }
  }
  for (let i = 0; i <= max; i++) for (let j = 0; j <= max; j++) M[i][j] /= tot;
  return M;
}

export function outcome(M) {
  let p1 = 0, px = 0, p2 = 0, over = 0, btts = 0;
  const n = M.length;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const p = M[i][j];
    if (i > j) p1 += p; else if (i === j) px += p; else p2 += p;
    if (i + j > 2.5) over += p;
    if (i > 0 && j > 0) btts += p;
  }
  return { p1, px, p2, over, btts };
}

export function marketProbs(odds) {
  if (!odds) return null;
  const inv = odds.map(o => 1 / o);
  const s = inv[0] + inv[1] + inv[2];
  return inv.map(x => x / s);
}

export const logLoss = (p, r) => -Math.log(Math.max(1e-9, p[r]));
export const brier = (p, r) => p.reduce((s, x, i) => s + (x - (i === r ? 1 : 0)) ** 2, 0);
export const resIdx = m => (m.hg > m.ag ? 0 : m.hg === m.ag ? 1 : 2);
