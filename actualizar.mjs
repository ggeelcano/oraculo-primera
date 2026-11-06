// Actualiza todo: descarga datos, ajusta el modelo, predice la jornada, simula la temporada y genera index.html
// Uso: node actualizar.mjs            (descarga y recalcula)
//      node actualizar.mjs --sin-descarga
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, loadMatches, loadFixtures, fit, lambdas, scoreMatrix, outcome, marketProbs, impliedLambdas, logLoss, resIdx } from "./lib.mjs";

if (!process.argv.includes("--sin-descarga")) {
  execFileSync(process.execPath, [path.join(ROOT, "descargar.mjs")], { stdio: "inherit" });
}

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const bt = JSON.parse(fs.readFileSync(path.join(ROOT, "backtest.json"), "utf8"));
const matches = loadMatches();
const fixtures = loadFixtures();
// temporada = la más reciente de Primera con algún partido jugado
const SEASON = [...new Set(matches.filter(m => m.div === "SP1").map(m => m.season))].sort().pop();
const SEASON_LABEL = "20" + SEASON.slice(0, 2) + "-" + SEASON.slice(2);
const season = matches.filter(m => m.div === "SP1" && m.season === SEASON);
const lastDate = Math.max(...season.map(m => m.date));
const asOf = lastDate + 864e5;

const TEAMS = {
  "Alaves": ["Alavés", "ALA", "#1f4e9e"], "Ath Bilbao": ["Athletic Club", "ATH", "#d4202c"],
  "Ath Madrid": ["Atlético de Madrid", "ATM", "#c8312a"], "Barcelona": ["Barcelona", "BAR", "#a50044"],
  "Betis": ["Real Betis", "BET", "#00954c"], "Celta": ["Celta", "CEL", "#5fa8dc"],
  "Elche": ["Elche", "ELC", "#0a6b34"], "Espanol": ["Espanyol", "ESP", "#0076c0"],
  "Getafe": ["Getafe", "GET", "#00529b"], "La Coruna": ["Deportivo", "DEP", "#1b4f9c"],
  "Levante": ["Levante", "LEV", "#a6093d"], "Malaga": ["Málaga", "MAL", "#2b7ac4"],
  "Osasuna": ["Osasuna", "OSA", "#c4161c"], "Real Madrid": ["Real Madrid", "RMA", "#c9a227"],
  "Santander": ["Racing de Santander", "RAC", "#0b7a3b"], "Sevilla": ["Sevilla", "SEV", "#d0021b"],
  "Sociedad": ["Real Sociedad", "RSO", "#0067b1"], "Valencia": ["Valencia", "VAL", "#e07b00"],
  "Vallecano": ["Rayo Vallecano", "RAY", "#d92b2b"], "Villarreal": ["Villarreal", "VIL", "#e8c800"],
  "Girona": ["Girona", "GIR", "#c8102e"], "Mallorca": ["Mallorca", "MLL", "#b5121b"], "Oviedo": ["Real Oviedo", "OVI", "#0057a8"],
};
const SHORT = { "Ath Bilbao": "Athletic", "Ath Madrid": "Atlético", "Santander": "Racing", "Vallecano": "Rayo", "Betis": "Betis", "Oviedo": "Oviedo" };
// un ascendido que no esté en la lista sale con su nombre de la fuente y en gris, sin romper la actualización
const nameOf = t => TEAMS[t] || [t, t.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase(), "#6b7280"];
const teams = [...new Set(season.flatMap(m => [m.home, m.away]))].sort((a, b) => nameOf(a)[0].localeCompare(nameOf(b)[0], "es"));
const missing = teams.filter(t => !TEAMS[t]);
if (missing.length) console.log("AVISO equipos sin nombre bonito:", missing.join(", "));

// ---------- modelo actual ----------
const model = fit(matches, { ...cfg, asOf });
const rho = cfg.rho, beta = cfg.beta;
const r3 = x => Math.round(x * 1000) / 1000;

// ---------- clasificación y estadísticas ----------
const st = {};
for (const t of teams) st[t] = { t, pj: 0, g: 0, e: 0, p: 0, gf: 0, gc: 0, pts: 0, xgf: 0, xgc: 0, nxg: 0, sh: 0, sot: 0, shc: 0, sotc: 0, cor: 0, yel: 0, red: 0, form: [], home: { pj: 0, pts: 0 }, away: { pj: 0, pts: 0 } };
for (const m of season) {
  for (const side of ["h", "a"]) {
    const t = side === "h" ? m.home : m.away, s = st[t];
    const gf = side === "h" ? m.hg : m.ag, gc = side === "h" ? m.ag : m.hg;
    const pts = gf > gc ? 3 : gf === gc ? 1 : 0;
    s.pj++; s.gf += gf; s.gc += gc; s.pts += pts;
    if (pts === 3) s.g++; else if (pts === 1) s.e++; else s.p++;
    const loc = side === "h" ? s.home : s.away; loc.pj++; loc.pts += pts;
    const xf = side === "h" ? m.hxg : m.axg, xc = side === "h" ? m.axg : m.hxg;
    if (xf >= 0 && xc >= 0) { s.xgf += xf; s.xgc += xc; s.nxg++; }
    s.sh += side === "h" ? m.hs : m.as; s.sot += side === "h" ? m.hst : m.ast;
    s.shc += side === "h" ? m.as : m.hs; s.sotc += side === "h" ? m.ast : m.hst;
    s.cor += side === "h" ? m.hc : m.ac; s.yel += side === "h" ? m.hy : m.ay; s.red += side === "h" ? m.hr : m.ar;
    s.form.push({ r: pts === 3 ? "G" : pts === 1 ? "E" : "P", gf, gc, rival: side === "h" ? m.away : m.home, local: side === "h", date: m.date });
  }
}
const sortTable = arr => arr.sort((a, b) => b.pts - a.pts || (b.gf - b.gc) - (a.gf - a.gc) || b.gf - a.gf || nameOf(a.t)[0].localeCompare(nameOf(b.t)[0], "es"));
const table = sortTable(Object.values(st)).map((s, i) => ({
  pos: i + 1, t: s.t, pj: s.pj, g: s.g, e: s.e, p: s.p, gf: s.gf, gc: s.gc, pts: s.pts,
  xgf: r3(s.xgf), xgc: r3(s.xgc), nxg: s.nxg,
  shpg: r3(s.sh / s.pj), sotpg: r3(s.sot / s.pj), shcpg: r3(s.shc / s.pj), sotcpg: r3(s.sotc / s.pj),
  corpg: r3(s.cor / s.pj), yelpg: r3(s.yel / s.pj), red: s.red,
  homePts: s.home.pts, homePj: s.home.pj, awayPts: s.away.pts, awayPj: s.away.pj,
  form: s.form.slice(-5).map(f => ({ r: f.r, gf: f.gf, gc: f.gc, rival: f.rival, local: f.local })),
}));

// ---------- predicción de un partido ----------
function predict(home, away, odds, o25) {
  const [mlh, mla] = lambdas(model, home, away);
  const om = outcome(scoreMatrix(mlh, mla, rho, 10));
  const modelP = [om.p1, om.px, om.p2];
  const mk = marketProbs(odds);
  const fin = mk ? modelP.map((x, i) => (1 - beta) * x + beta * mk[i]) : modelP;
  // goles esperados finales: misma mezcla entre modelo y lo que descuentan las cuotas
  const imp = mk ? impliedLambdas(odds, o25) : null;
  const lh = imp ? (1 - beta) * mlh + beta * imp[0] : mlh;
  const la = imp ? (1 - beta) * mla + beta * imp[1] : mla;
  const M = scoreMatrix(lh, la, rho, 10);
  const o = outcome(M);
  const scores = [];
  for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) scores.push([i, j, M[i][j]]);
  scores.sort((a, b) => b[2] - a[2]);
  let mkOver = null;
  if (o25) { const a = 1 / o25[0], b = 1 / o25[1]; mkOver = a / (a + b); }
  return {
    lh: r3(lh), la: r3(la), mlh: r3(mlh), mla: r3(mla), model: modelP.map(r3), market: mk ? mk.map(r3) : null, final: fin.map(r3),
    over: r3(o.over), mkOver: mkOver === null ? null : r3(mkOver), btts: r3(o.btts),
    top: scores.slice(0, 5).map(([i, j, p]) => [i, j, r3(p)]),
    grid: M.slice(0, 6).map(row => row.slice(0, 6).map(r3)),
  };
}
const h2h = (a, b) => matches.filter(m => m.div === "SP1" && ((m.home === a && m.away === b) || (m.home === b && m.away === a)))
  .slice(-5).reverse().map(m => ({ d: m.date, h: m.home, a: m.away, hg: m.hg, ag: m.ag }));

// football-data da la hora británica; en España siempre es una hora más (los dos cambian de horario el mismo día)
const toSpain = (date, time) => {
  if (!/^\d{1,2}:\d{2}$/.test(time)) return { date, time: "" };
  let [h, mi] = time.split(":").map(Number);
  h += 1;
  if (h >= 24) { h -= 24; date += 864e5; }
  return { date, time: String(h).padStart(2, "0") + ":" + String(mi).padStart(2, "0") };
};
const playedKeys = new Set(season.map(m => m.home + "|" + m.away));
const upcoming = fixtures.filter(f => f.date >= lastDate && teams.includes(f.home) && teams.includes(f.away) && !playedKeys.has(f.home + "|" + f.away))
  .map(f => ({ ...f, ...toSpain(f.date, f.time) }))
  .sort((a, b) => a.date - b.date || a.time.localeCompare(b.time))
  .map(f => ({ date: f.date, time: f.time, home: f.home, away: f.away, ...predict(f.home, f.away, f.odds, f.o25), h2h: h2h(f.home, f.away) }));

// ---------- simulación del resto de temporada ----------
const played = new Set(season.map(m => m.home + "|" + m.away));
const remaining = [];
for (const h of teams) for (const a of teams) if (h !== a && !played.has(h + "|" + a)) remaining.push([h, a]);
let seed = 20261106;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const cdfs = remaining.map(([h, a]) => {
  const [lh, la] = lambdas(model, h, a);
  const M = scoreMatrix(lh, la, rho, 9);
  const cells = []; let c = 0;
  for (let i = 0; i <= 9; i++) for (let j = 0; j <= 9; j++) { c += M[i][j]; cells.push([c, i, j]); }
  return cells;
});
const N = 20000;
const idx = Object.fromEntries(teams.map((t, i) => [t, i]));
const posCount = teams.map(() => new Array(teams.length).fill(0));
const ptsSum = new Array(teams.length).fill(0);
const basePts = teams.map(t => st[t].pts), baseGD = teams.map(t => st[t].gf - st[t].gc), baseGF = teams.map(t => st[t].gf);
for (let s = 0; s < N; s++) {
  const pts = basePts.slice(), gd = baseGD.slice(), gf = baseGF.slice();
  for (let k = 0; k < remaining.length; k++) {
    const u = rnd(), cells = cdfs[k];
    let lo = 0, hi = cells.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cells[mid][0] < u) lo = mid + 1; else hi = mid; }
    const [, x, y] = cells[lo];
    const hi_ = idx[remaining[k][0]], ai = idx[remaining[k][1]];
    gf[hi_] += x; gf[ai] += y; gd[hi_] += x - y; gd[ai] += y - x;
    if (x > y) pts[hi_] += 3; else if (x === y) { pts[hi_]++; pts[ai]++; } else pts[ai] += 3;
  }
  const order = teams.map((_, i) => i).sort((a, b) => pts[b] - pts[a] || gd[b] - gd[a] || gf[b] - gf[a] || rnd() - 0.5);
  order.forEach((ti, p) => { posCount[ti][p]++; });
  for (let i = 0; i < teams.length; i++) ptsSum[i] += pts[i];
}
const sim = teams.map((t, i) => {
  const pc = posCount[i].map(c => c / N);
  const sum = (a, b) => pc.slice(a, b).reduce((x, y) => x + y, 0);
  return { t, xpts: r3(ptsSum[i] / N), champ: r3(pc[0]), top4: r3(sum(0, 4)), top6: r3(sum(0, 6)), releg: r3(sum(17, 20)), pos: pc.map(r3) };
}).sort((a, b) => b.xpts - a.xpts);

// ---------- acierto esta temporada (semana a semana, sin mirar el futuro) ----------
const weekStart = t => { const d = new Date(t); const wd = (d.getUTCDay() + 6) % 7; return t - wd * 864e5; };
const cur = { n: 0, hitModel: 0, hitMarket: 0, hitFinal: 0, llModel: 0, llMarket: 0, llFinal: 0, nMk: 0, recent: [] };
{
  const evalFrom = Math.min(...season.map(m => m.date)) + 14 * 864e5; // las dos primeras semanas no cuentan
  const byWeek = new Map();
  for (const m of season) if (m.date >= evalFrom) { const w = weekStart(m.date); if (!byWeek.has(w)) byWeek.set(w, []); byWeek.get(w).push(m); }
  let prev = null;
  for (const [w, ms] of [...byWeek.entries()].sort((a, b) => a[0] - b[0])) {
    const mod = fit(matches, { ...cfg, asOf: w }, prev); prev = mod;
    for (const m of ms) {
      const [lh, la] = lambdas(mod, m.home, m.away);
      const o = outcome(scoreMatrix(lh, la, rho));
      const pm = [o.p1, o.px, o.p2], mk = marketProbs(m.odds), r = resIdx(m);
      const pf = mk ? pm.map((x, i) => (1 - beta) * x + beta * mk[i]) : pm;
      const arg = p => p.indexOf(Math.max(...p));
      cur.n++; cur.llModel += logLoss(pm, r); cur.llFinal += logLoss(pf, r);
      if (arg(pm) === r) cur.hitModel++;
      if (arg(pf) === r) cur.hitFinal++;
      if (mk) { cur.nMk++; cur.llMarket += logLoss(mk, r); if (arg(mk) === r) cur.hitMarket++; }
      cur.recent.push({ d: m.date, h: m.home, a: m.away, hg: m.hg, ag: m.ag, p: pf.map(r3), ok: arg(pf) === r });
    }
  }
  cur.recent = cur.recent.slice(-10).reverse();
  cur.from = evalFrom;
}

// ---------- salida ----------
const ratings = teams.map(t => {
  const p = model.teams[t];
  return { t, att: r3(Math.exp(model.mu + model.hfa1 / 2 + p.a)), def: r3(Math.exp(model.mu + model.hfa1 / 2 - p.d)), a: r3(p.a), d: r3(p.d) };
}).sort((a, b) => (b.att - b.def) - (a.att - a.def));

const out = {
  generated: Date.now(), lastMatch: lastDate, played: season.length, totalMatches: matches.length,
  season: SEASON_LABEL, cfg, names: Object.fromEntries(teams.map(t => [t, [...nameOf(t), SHORT[t] || nameOf(t)[0]]])),
  params: { mu: r3(model.mu), hfa: r3(model.hfa1), rho, beta, teams: Object.fromEntries(teams.map(t => [t, { a: r3(model.teams[t].a), d: r3(model.teams[t].d) }])) },
  table, upcoming, sim, ratings, current: cur, backtest: { seasons: bt.seasons, model: bt.model, market: bt.market, blended: bt.blended, naive: bt.naive, calibration: bt.calibration },
  nRemaining: remaining.length, nSims: N,
};
fs.writeFileSync(path.join(ROOT, "datos.json"), JSON.stringify(out));
const tpl = fs.readFileSync(path.join(ROOT, "plantilla.html"), "utf8");
const body = tpl.replace("/*__DATOS__*/null", JSON.stringify(out).replace(/</g, "\\u003c"));
// app.html = contenido para publicar como Artifact; index.html = documento completo para abrir en el PC
fs.writeFileSync(path.join(ROOT, "app.html"), body);
const cut = body.indexOf('<header class="top wrap">');
const desc = `Pronósticos de Primera ${SEASON_LABEL}: quiniela de la jornada, marcadores, simulación de la liga y fiabilidad medida.`;
fs.writeFileSync(path.join(ROOT, "index.html"),
  '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
  `<meta name="description" content="${desc}"><meta property="og:title" content="Oráculo de Primera"><meta property="og:description" content="${desc}"><meta property="og:type" content="website">` +
  "<style>body{margin:0}img{max-width:100%}</style>" + body.slice(0, cut) + "</head><body>" + body.slice(cut) + "</body></html>");
console.log("OK", "partidos temporada", season.length, "| próximos", upcoming.length, "| quedan", remaining.length, "| último", new Date(lastDate).toISOString().slice(0, 10));
console.log("Esta temporada: acierto final", cur.hitFinal + "/" + cur.n, "modelo", cur.hitModel, "mercado", cur.hitMarket + "/" + cur.nMk);
console.log(sim.slice(0, 5).map(s => nameOf(s.t)[1] +" " + s.xpts.toFixed(1) + "pts camp " + (s.champ * 100).toFixed(1) + "%").join(" | "));
