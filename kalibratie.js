/*
 * kalibratie.js — nacalculatie bewaren en er de schatting mee bijsturen.
 * Opslag: localStorage van deze browser (één gebruiker) + export/import als JSON-bestand.
 *
 * Project = één meetpunt. Kenmerken van alle IFC's/moten van het project worden opgeteld:
 *   Z = zichten, T = schottypes, L = langsschotten, M = monotekeningen (geschat), t = ton, R = regeltelling (Z+T+L).
 * Samensteltekeningen (werkelijk S):
 *   1–7 projecten: S ≈ f × R, f = mediaan(S/R)
 *   ≥ 8 projecten: S ≈ a·Z + b·T + c·L (a, b, c ≥ 0)
 * Uren (werkelijk U), met S = werkelijk of geschat, M = werkelijk of geschat:
 *   1–3: U ≈ k·(S + M), k = mediaan
 *   4–7: U ≈ p·S + q·M
 *   ≥ 8: U ≈ p·S + q·M + r·t + v
 * Bandbreedte = mediaan van de relatieve fout op de gebruikte projecten (leave-one-out vanaf 4 projecten).
 */
(function (root) {
  "use strict";
  const KEY = "ifcSales.kalibratie.v1";
  const med = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y), m = s.length >> 1; return !s.length ? NaN : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  function load() { try { const j = JSON.parse(localStorage.getItem(KEY) || "null"); return j && Array.isArray(j.projects) ? j : { version: 1, projects: [] }; } catch (e) { return { version: 1, projects: [] }; } }
  function save(db) { localStorage.setItem(KEY, JSON.stringify(db)); }
  function exportJson() { return JSON.stringify(load(), null, 1); }
  function importJson(text, mode) {
    const j = JSON.parse(text); if (!j || !Array.isArray(j.projects)) throw new Error("Geen kalibratiebestand.");
    const db = mode === "replace" ? { version: 1, projects: [] } : load();
    let n = 0; j.projects.forEach((p) => { if (!p || !p.id) return; const i = db.projects.findIndex((q) => q.id === p.id); if (i >= 0) db.projects[i] = p; else db.projects.push(p); n++; });
    save(db); return n;
  }
  function addProject(p) { const db = load(); p.id = p.id || ("p" + Date.now().toString(36)); p.saved = new Date().toISOString(); const i = db.projects.findIndex((q) => q.id === p.id); if (i >= 0) db.projects[i] = p; else db.projects.push(p); save(db); return p; }
  function removeProject(id) { const db = load(); db.projects = db.projects.filter((p) => p.id !== id); save(db); }
  function setExcluded(id, v) { const db = load(); const p = db.projects.find((q) => q.id === id); if (p) { p.excluded = !!v; save(db); } }

  // som van de kenmerken van een project (of van de huidige berekening)
  function totals(parts) { const s = { Z: 0, T: 0, L: 0, M: 0, t: 0, n: 0 }; (parts || []).forEach((x) => { s.Z += x.Z || 0; s.T += x.T || 0; s.L += x.L || 0; s.M += x.M || 0; s.t += x.t || 0; s.n++; }); s.R = s.Z + s.T + s.L; return s; }

  // kleinste kwadraten met alle coëfficiënten ≥ 0: alle deelverzamelingen van de kolommen proberen (≤ 4 kolommen)
  function nnls(X, y) {
    const k = X[0].length; let best = null;
    for (let mask = 1; mask < (1 << k); mask++) {
      const cols = [...Array(k).keys()].filter((j) => mask & (1 << j)), m = cols.length;
      const A = cols.map((a) => cols.map((b) => X.reduce((s, r) => s + r[a] * r[b], 0))), bv = cols.map((a) => X.reduce((s, r, i) => s + r[a] * y[i], 0));
      const sol = solve(A, bv); if (!sol || sol.some((v) => !(v >= 0))) continue;
      const c = new Array(k).fill(0); cols.forEach((j, i) => { c[j] = sol[i]; });
      const sse = X.reduce((s, r, i) => { const e = r.reduce((a, v, j) => a + v * c[j], 0) - y[i]; return s + e * e; }, 0);
      if (!best || sse < best.sse) best = { c, sse };
    }
    return best ? best.c : null;
  }
  function solve(A, b) { const n = b.length, M = A.map((r, i) => r.concat([b[i]]));
    for (let i = 0; i < n; i++) { let p = i; for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r; if (Math.abs(M[p][i]) < 1e-9) return null; [M[i], M[p]] = [M[p], M[i]];
      for (let r = 0; r < n; r++) { if (r === i) continue; const f = M[r][i] / M[i][i]; for (let c = i; c <= n; c++) M[r][c] -= f * M[i][c]; } }
    return M.map((r, i) => r[n] / r[i]); }

  // model voor samensteltekeningen
  function fitSamenstel(ps) {
    const d = ps.filter((p) => Number.isFinite(p.samenstel) && p.samenstel > 0 && p.tot.R > 0);
    if (!d.length) return { n: 0, kind: "regels", predict: (s) => s.R, text: "Nog geen nacalculatie: enkel de regeltelling." };
    if (d.length < 8) { const f = med(d.map((p) => p.samenstel / p.tot.R)); return { n: d.length, kind: "factor", f, predict: (s) => f * s.R, text: `Factor ${f.toFixed(2)} × regeltelling (mediaan van ${d.length} project(en)).` }; }
    const c = nnls(d.map((p) => [p.tot.Z, p.tot.T, p.tot.L]), d.map((p) => p.samenstel));
    if (!c) { const f = med(d.map((p) => p.samenstel / p.tot.R)); return { n: d.length, kind: "factor", f, predict: (s) => f * s.R, text: `Factor ${f.toFixed(2)} (geen stabiele verdeling gevonden).` }; }
    return { n: d.length, kind: "gewichten", c, predict: (s) => c[0] * s.Z + c[1] * s.T + c[2] * s.L, text: `${c[0].toFixed(2)} × zichten + ${c[1].toFixed(2)} × schottypes + ${c[2].toFixed(2)} × langsschotten (${d.length} projecten).` };
  }
  // model voor uren
  function fitUren(ps, sm) {
    const d = ps.filter((p) => Number.isFinite(p.uren) && p.uren > 0).map((p) => ({ p, S: Number.isFinite(p.samenstel) && p.samenstel > 0 ? p.samenstel : sm.predict(p.tot), M: Number.isFinite(p.mono) && p.mono > 0 ? p.mono : p.tot.M, t: p.tot.t, U: p.uren }));
    if (!d.length) return { n: 0, predict: () => NaN, text: "Nog geen uren ingevuld." };
    let fit;
    const mk = (rows, cols) => { const c = nnls(rows.map(cols), rows.map((r) => r.U)); return c ? (r) => cols(r).reduce((a, v, j) => a + v * c[j], 0) : null; };
    if (d.length < 4) { const k = med(d.map((r) => r.U / (r.S + r.M))); fit = { kind: "per tekening", k, f: (r) => k * (r.S + r.M), text: `${k.toFixed(1)} u per tekening (samenstel + mono), mediaan van ${d.length} project(en).` }; }
    else {
      const cols = d.length < 8 ? (r) => [r.S, r.M] : (r) => [r.S, r.M, r.t, 1];
      const c = nnls(d.map(cols), d.map((r) => r.U));
      if (c) fit = { kind: d.length < 8 ? "samenstel + mono" : "volledig", c, f: (r) => cols(r).reduce((a, v, j) => a + v * c[j], 0),
        text: d.length < 8 ? `${c[0].toFixed(1)} u/samensteltekening + ${c[1].toFixed(1)} u/monotekening (${d.length} projecten).` : `${c[0].toFixed(1)} u/samenstel + ${c[1].toFixed(1)} u/mono + ${c[2].toFixed(2)} u/ton + ${c[3].toFixed(0)} u vast (${d.length} projecten).` };
      else { const k = med(d.map((r) => r.U / (r.S + r.M))); fit = { kind: "per tekening", k, f: (r) => k * (r.S + r.M), text: `${k.toFixed(1)} u per tekening (${d.length} projecten).` }; }
    }
    // bandbreedte: relatieve fout, leave-one-out vanaf 4 projecten
    let errs = [];
    if (d.length >= 4) d.forEach((r, i) => { const rest = d.filter((_, j) => j !== i); const k = med(rest.map((x) => x.U / (x.S + x.M))); const g = fit.c ? mk(rest, fit.c.length === 2 ? (x) => [x.S, x.M] : (x) => [x.S, x.M, x.t, 1]) : null; const pr = g ? g(r) : k * (r.S + r.M); errs.push(Math.abs(pr - r.U) / r.U); });
    else errs = d.map((r) => Math.abs(fit.f(r) - r.U) / r.U);
    const spread = d.length >= 4 ? med(errs) : NaN;
    return { n: d.length, kind: fit.kind, spread, text: fit.text, predict: (S, M, t) => fit.f({ S, M, t }) };
  }

  function model() {
    const db = load(), ps = db.projects.filter((p) => !p.excluded).map((p) => Object.assign({}, p, { tot: totals(p.parts) }));
    const sm = fitSamenstel(ps), um = fitUren(ps, sm);
    return { sm, um, nProjects: db.projects.length, nUsed: ps.length };
  }
  // voorspelling voor een huidige berekening (lijst van delen met Z, T, L, M, t)
  function predict(parts) {
    const m = model(), s = totals(parts), S = m.sm.predict(s), U = m.um.n ? m.um.predict(S, s.M, s.t) : NaN;
    return { tot: s, samenstelRegels: s.R, samenstel: S, uren: U, spread: m.um.spread, m };
  }

  const Kalibratie = { load, save, exportJson, importJson, addProject, removeProject, setExcluded, totals, model, predict, _nnls: nnls };
  if (typeof module !== "undefined" && module.exports) module.exports = Kalibratie; else root.Kalibratie = Kalibratie;
})(typeof window !== "undefined" ? window : globalThis);
