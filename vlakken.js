/*
 * vlakken.js — telling van zichten, dwarsschotten en langsschotten (IFC sales berekening).
 * Invoer: elementen met driehoeken in IFC-coördinaten (mm). Geen afhankelijkheden buiten Transport en IfcGeom.
 *
 *  1. Gevormde platen (VBSC "ontvouwing nummer" + samenbouw) worden één eenheid.
 *  2. Lengteas = langste as van de kleinste omschreven box.
 *  3. Huid: 15 dwarse doorsneden; per snede binnen/buiten bepalen. Huidplaat = buiten aan de ene kant, binnen aan de andere.
 *     Onbesliste stukken: stralen naar buiten als terugval. Opzetplaten (vlak op een andere plaat) zijn geen huid.
 *  4. Zichten: huidstukken die elkaar raken; knik langs de lengte < 5°, knik dwars (volle breedte) < 30°.
 *     Kleine stukken (< 10 % van de lengte) hangen aan één zicht en verbinden geen vlakken met een echte knik.
 *     Een zicht korter dan 25 % van de lengte telt niet (goot, lokale uitsparing).
 *  5. Dwarsschot: platen loodrecht op de lengteas, gegroepeerd per positie, die samen ≥ 3 zichten raken of tussen 2
 *     tegenoverliggende zichten zitten. Types: exact gelijk (±2 mm, ±0,5 % gewicht).
 *  4b. Open zicht: enkelwandige huidplaat (aan beide kanten buitenlucht), ≥ 50 % van de lengte en ≥ 1 000 mm breed.
 *  6. Langsschot: platen evenwijdig aan de lengteas, geen huid, raken ≥ 2 zichten, samen ≥ 50 % van de lengte.
 *  7. Verstijvers en details krijgen een 'ouder': het zicht, schot of langsschot waaraan ze (rechtstreeks of via andere details) vastzitten.
 */
(function (root) {
  "use strict";
  const T = root.Transport, G = root.IfcGeom;
  const VERSION = 2;
  const DEF = { TOL: 3, UNION_TOL: 10, MAJOR_FRAC: 0.1, EDGE_FRAC: 0.5, ANG_PERP: 0.17, ANG_PAR: 0.98, MIN_W: 150, DW_MIN_W: 300,
    MIN_LFRAC: 0.25, SAMPLES: 15, ESC_MIN: 0.4, ESC_DIFF: 0.3, PAD_CON: 0.2, ZICHT_COS: Math.cos(15 * Math.PI / 180),
    ZICHT_TOUCH_COS: Math.cos(30 * Math.PI / 180), SEAM_COS: Math.cos(5 * Math.PI / 180), ZICHT_OFF: 50, SCHOT_POS: 25,
    LANGS_FRAC: 0.5, SLICES: 15, CLOSE2D: 3, CELL: 10, OPEN_MIN_W: 1000, OPEN_LFRAC: 0.5 };

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = (a) => Math.hypot(a[0], a[1], a[2]), unit = (a) => { const l = len(a); return l ? a.map((v) => v / l) : a; };
  function aabbOf(tris) { const mn = [1e18, 1e18, 1e18], mx = [-1e18, -1e18, -1e18]; for (const t of tris) for (const p of t) for (let i = 0; i < 3; i++) { if (p[i] < mn[i]) mn[i] = p[i]; if (p[i] > mx[i]) mx[i] = p[i]; } return { mn, mx }; }
  const ovl = (a, b, t) => a.mn[0] - t <= b.mx[0] && b.mn[0] - t <= a.mx[0] && a.mn[1] - t <= b.mx[1] && b.mn[1] - t <= a.mx[1] && a.mn[2] - t <= b.mx[2] && b.mn[2] - t <= a.mx[2];
  function pcaOf(tris) {
    const ps = []; tris.forEach((t) => t.forEach((p) => ps.push(p)));
    const c = [0, 1, 2].map((i) => ps.reduce((s, p) => s + p[i], 0) / ps.length), C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const p of ps) { const d = sub(p, c); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += d[i] * d[j]; }
    const eg = G.eig3(C);
    const ext = eg.map((x) => { let lo = 1e18, hi = -1e18; for (const p of ps) { const v = dot(p, x.vec); if (v < lo) lo = v; if (v > hi) hi = v; } return hi - lo; });
    return { ps, c, n: eg[2].vec, dims: ext };
  }
  function rayTri(o, d, a, b, c) { const e1 = sub(b, a), e2 = sub(c, a), p = cross(d, e2), det = dot(e1, p); if (Math.abs(det) < 1e-12) return false; const inv = 1 / det, t0 = sub(o, a), u = dot(t0, p) * inv; if (u < 0 || u > 1) return false; const q = cross(t0, e1), v = dot(d, q) * inv; if (v < 0 || u + v > 1) return false; return dot(e2, q) * inv > 1e-3; }
  function rayBox(o, d, bb) { let t0 = 0, t1 = Infinity; for (let i = 0; i < 3; i++) { if (Math.abs(d[i]) < 1e-12) { if (o[i] < bb.mn[i] || o[i] > bb.mx[i]) return false; continue; } let a = (bb.mn[i] - o[i]) / d[i], b = (bb.mx[i] - o[i]) / d[i]; if (a > b) [a, b] = [b, a]; t0 = Math.max(t0, a); t1 = Math.min(t1, b); if (t0 > t1) return false; } return true; }

  /* ---------- 2D-doorsneden: binnen/buiten per plaatzijde ---------- */
  function sliceSides(U, box, o) {
    const iL = [0, 1, 2].reduce((m, i) => (box.dims[i] > box.dims[m] ? i : m), 0), [iu, iv] = [0, 1, 2].filter((i) => i !== iL), A = box.axes;
    const res = new Map(); U.forEach((u) => res.set(u, { ext: [0, 0], int: [0, 0] })); let valid = 0;
    for (let s = 0; s < o.SLICES; s++) {
      const s0 = box.min[iL] + box.dims[iL] * (0.04 + 0.92 * s / Math.max(1, o.SLICES - 1)), segs = [];
      U.forEach((u) => {
        if (u.lL2[0] > s0 || u.lL2[1] < s0) return;
        u.tris.forEach((t) => { const d = t.map((p) => dot(p, A[iL]) - s0), q = []; for (let i = 0; i < 3; i++) { const a = t[i], b = t[(i + 1) % 3], da = d[i], db = d[(i + 1) % 3]; if (da * db < 0) { const r = da / (da - db), p = a.map((v, k) => v + (b[k] - v) * r); q.push([dot(p, A[iu]), dot(p, A[iv])]); } } if (q.length === 2) segs.push({ u, a: q[0], b: q[1] }); });
      });
      if (!segs.length) continue;
      const mn = [1e18, 1e18], mx = [-1e18, -1e18]; segs.forEach((g) => [g.a, g.b].forEach((p) => { for (let i = 0; i < 2; i++) { mn[i] = Math.min(mn[i], p[i]); mx[i] = Math.max(mx[i], p[i]); } }));
      const C = o.CELL, pad = 200, W = Math.ceil((mx[0] - mn[0] + 2 * pad) / C), H = Math.ceil((mx[1] - mn[1] + 2 * pad) / C);
      if (W * H > 4e7) continue;
      const g = new Uint8Array(W * H), cx = (x) => Math.floor((x - mn[0] + pad) / C), cy = (y) => Math.floor((y - mn[1] + pad) / C);
      segs.forEach((sg) => { const n = Math.ceil(Math.hypot(sg.b[0] - sg.a[0], sg.b[1] - sg.a[1]) / (C / 2)) + 1; for (let k = 0; k <= n; k++) { const x = sg.a[0] + (sg.b[0] - sg.a[0]) * k / n, y = sg.a[1] + (sg.b[1] - sg.a[1]) * k / n; g[cy(y) * W + cx(x)] = 1; } });
      const dil = (src) => { const out = new Uint8Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; out[i] = src[i] || (x > 0 && src[i - 1]) || (x < W - 1 && src[i + 1]) || (y > 0 && src[i - W]) || (y < H - 1 && src[i + W]) ? 1 : 0; } return out; };
      const ero = (src) => { const out = new Uint8Array(W * H); for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; out[i] = src[i] && src[i - 1] && src[i + 1] && src[i - W] && src[i + W] ? 1 : 0; } return out; };
      let c = g; for (let r = 0; r < o.CLOSE2D; r++) c = dil(c); for (let r = 0; r < o.CLOSE2D; r++) c = ero(c); for (let i = 0; i < W * H; i++) if (c[i]) g[i] = 1;
      const st = []; for (let x = 0; x < W; x++) st.push(x, (H - 1) * W + x); for (let y = 0; y < H; y++) st.push(y * W, y * W + W - 1);
      while (st.length) { const i = st.pop(); if (g[i]) continue; g[i] = 2; const x = i % W, y = (i / W) | 0; if (x > 0) st.push(i - 1); if (x < W - 1) st.push(i + 1); if (y > 0) st.push(i - W); if (y < H - 1) st.push(i + W); }
      let air = 0; for (let i = 0; i < W * H; i++) if (!g[i]) air++;
      if (air * C * C < 0.02 * (mx[0] - mn[0]) * (mx[1] - mn[1])) continue; // lek: geen binnenruimte in deze snede
      valid++;
      const at = (x, y) => { const X = cx(x), Y = cy(y); if (X < 0 || Y < 0 || X >= W || Y >= H) return 2; return g[Y * W + X]; };
      segs.forEach((sg) => {
        const u = sg.u, n2 = [dot(u.n, A[iu]), dot(u.n, A[iv])], l = Math.hypot(n2[0], n2[1]); if (l < 0.5) return; const nn = [n2[0] / l, n2[1] / l];
        const d = [sg.b[0] - sg.a[0], sg.b[1] - sg.a[1]], dl = Math.hypot(d[0], d[1]); if (dl < C || Math.abs((d[0] * nn[0] + d[1] * nn[1]) / dl) > 0.3) return;
        const m = [(sg.a[0] + sg.b[0]) / 2, (sg.a[1] + sg.b[1]) / 2], r = res.get(u);
        [1, -1].forEach((sgn, k) => { for (const pr of [15, 30, 50, 80, 120]) { const v = at(m[0] + nn[0] * sgn * pr, m[1] + nn[1] * sgn * pr); if (v === 1) continue; if (v === 2) r.ext[k]++; else r.int[k]++; break; } });
      });
    }
    return { res, valid };
  }

  /* ---------- hoofdanalyse ---------- */
  // els: [{id, type, name, tag, profile, ps, asm, tris}] zonder bouten/deuvels. progress(msg) optioneel.
  function analyse(els, params) {
    const P = Object.assign({}, DEF, params || {});
    const steel = els.filter((e) => e.tris && e.tris.length && !/Fastener/i.test(e.type));
    if (!steel.length) throw new Error("Geen staal met geometrie in de omvang.");
    const pts = []; steel.forEach((e) => e.tris.forEach((t) => t.forEach((p) => pts.push(p))));
    const box = T.boxMin(T.uniquePoints(pts, 5), T.weightedNormals(steel.flatMap((e) => e.tris)).slice(0, 60));
    const iL = [0, 1, 2].reduce((m, i) => (box.dims[i] > box.dims[m] ? i : m), 0), L = box.axes[iL], Llen = box.dims[iL];

    // 1. eenheden
    const groups = new Map();
    steel.forEach((e) => { const o = e.ps && e.ps.VBSC && e.ps.VBSC["ontvouwing nummer"]; const k = o ? "F|" + String(o).trim() + "|" + e.asm : "E|" + e.id; (groups.get(k) || groups.set(k, []).get(k)).push(e); });
    const U = [...groups.values()].map((list) => {
      if (list.length > 1) { // een gevormde plaat met één segment is geen gevormde plaat
      }
      const segs = list.map((e) => { const g = pcaOf(e.tris); return { e, tris: e.tris, n: g.n, a: g.dims[0] * g.dims[1], dims: g.dims }; });
      const formed = list.length > 1; let n = segs[0].n;
      if (formed) { const r = segs.reduce((acc, s) => { const sg = dot(s.n, segs[0].n) < 0 ? -1 : 1; s.n = s.n.map((v) => v * sg); return acc.map((v, i) => v + s.n[i] * s.a); }, [0, 0, 0]); n = unit(r); }
      const tris = list.flatMap((e) => e.tris), g = pcaOf(tris);
      let lo = 1e18, hi = -1e18; for (const p of g.ps) { const v = dot(p, L); if (v < lo) lo = v; if (v > hi) hi = v; }
      let lo2 = 1e18, hi2 = -1e18; for (const p of g.ps) { const v = dot(p, box.axes[iL]); if (v < lo2) lo2 = v; if (v > hi2) hi2 = v; }
      const e0 = list[0], vb = (e0.ps && e0.ps.VBSC) || {};
      const w = list.reduce((s, e) => s + (Number(((e.ps || {}).VBSC || {}).WEIGHT) || 0), 0);
      const width = formed ? Math.min(g.dims[0], g.dims[1]) : segs[0].dims[1];
      const plate = formed || segs[0].dims[2] < 0.25 * segs[0].dims[1];
      return { ids: list.map((e) => e.id), els: list, name: e0.name, prof: formed ? ("PL" + String(vb["ontvouwing dikte"] || "").replace(/^PL/i, "")) : e0.profile, formed, nSeg: list.length, segs, tris,
        c: g.c, n, dims: g.dims, width, plate, lL: [lo, hi], lL2: [lo2, hi2], bb: aabbOf(tris), uniq: T.uniquePoints(g.ps, 1), w, T: tris.map((t) => ({ t, bb: aabbOf([t]) })) };
    });
    U.forEach((u, i) => { u.i = i; });

    // hulpfuncties op eenheden
    function touchT(u, TT, bb, tol) { tol = tol || P.TOL; if (!ovl(u.bb, bb, tol)) return false; const t2 = tol * tol; for (const p of u.uniq) { const pb = { mn: p, mx: p }; if (!ovl(pb, bb, tol)) continue; for (const x of TT) { if (!ovl(pb, x.bb, tol)) continue; if (T.pointTriDist2(p, x.t[0], x.t[1], x.t[2]) <= t2) return true; } } return false; }
    const touchU = (a, b, tol) => touchT(a, b.T, b.bb, tol) || touchT(b, a.T, a.bb, tol);
    let seed = 7; const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
    function faceSamples(u, sign, n) { const f = []; let A = 0; for (const s of u.segs) for (const t of s.tris) { const cr = cross(sub(t[1], t[0]), sub(t[2], t[0])), a = len(cr) / 2; if (a < 1) continue; const nn = cr.map((v) => v / (2 * a)); if (sign * dot(nn, s.n) > 0.99) { f.push({ t, a, d: s.n.map((v) => v * sign) }); A += a; } }
      const out = []; for (let k = 0; k < n && f.length; k++) { let r = rnd() * A, j = 0; while (r > f[j].a && j < f.length - 1) { r -= f[j].a; j++; } const t = f[j].t; let a = rnd(), b = rnd(); if (a + b > 1) { a = 1 - a; b = 1 - b; } out.push({ p: [0, 1, 2].map((i) => t[0][i] + (t[1][i] - t[0][i]) * a + (t[2][i] - t[0][i]) * b), d: f[j].d }); } return out; }
    function escapes(o, d, self) { for (const u of U) { if (u.i === self || !rayBox(o, d, u.bb)) continue; for (const x of u.T) if (rayTri(o, d, x.t[0], x.t[1], x.t[2])) return false; } return true; }
    // opzetplaat: aandeel van de vlakke zijden dat plat tegen een andere plaat ligt (≤ 2 mm, evenwijdig)
    function padContact(u) {
      const S = faceSamples(u, 1, 10).concat(faceSamples(u, -1, 10)); if (!S.length) return 0;
      const near = U.filter((o) => o !== u && ovl(u.bb, o.bb, 3)); let hit = 0;
      for (const q of S) { let ok = false; const pb = { mn: q.p, mx: q.p };
        for (const o of near) { if (!ovl(pb, o.bb, 3)) continue; for (const x of o.T) { if (!ovl(pb, x.bb, 3)) continue; const nn = unit(cross(sub(x.t[1], x.t[0]), sub(x.t[2], x.t[0]))); if (Math.abs(dot(nn, q.d)) < 0.9) continue; if (T.pointTriDist2(q.p, x.t[0], x.t[1], x.t[2]) <= 4) { ok = true; break; } } if (ok) break; }
        if (ok) hit++; }
      return hit / S.length;
    }

    // 2. huid
    const SL = sliceSides(U, box, P);
    U.forEach((u) => {
      u.cand = u.plate && Math.abs(dot(u.n, L)) < P.ANG_PERP && u.width >= P.MIN_W; if (!u.cand) return;
      u.con = padContact(u); if (u.con > P.PAD_CON) { u.cand = false; u.pad = true; return; }
      const r = SL.res.get(u), tot = [r.ext[0] + r.int[0], r.ext[1] + r.int[1]];
      if (SL.valid && tot[0] + tot[1] > 0) {
        const e = [r.ext[0] / (tot[0] || 1), r.ext[1] / (tot[1] || 1)]; u.esc = e; u.via = "snede";
        if (Math.max(e[0], e[1]) >= 0.6 && Math.min(e[0], e[1]) <= 0.4 && tot[0] && tot[1]) { u.huid = true; u.out = e[0] > e[1] ? u.n : u.n.map((v) => -v); return; }
        if ((e[0] >= 0.9 && e[1] >= 0.9) || (e[0] <= 0.1 && e[1] <= 0.1) || !tot[0] || !tot[1]) return;
      }
      u.via = "straal";
      u.esc = [1, -1].map((s) => { const S = faceSamples(u, s, P.SAMPLES); return S.length ? S.filter((q) => escapes(q.p.map((v, k) => v + q.d[k] * 0.5), q.d, u.i)).length / S.length : 0; });
      const [a, b] = u.esc; if (Math.max(a, b) >= P.ESC_MIN && Math.abs(a - b) >= P.ESC_DIFF) { u.huid = true; u.out = a > b ? u.n : u.n.map((v) => -v); }
    });

    // 2b. open zichten: enkelwandige huid, aan beide kanten buitenlucht
    const C0 = [0, 1, 2].map((i) => U.reduce((a, u) => a + u.c[i], 0) / U.length);
    U.forEach((u) => {
      if (u.huid || !u.cand || !u.esc || u.esc[0] < 0.9 || u.esc[1] < 0.9) return;
      if ((u.lL[1] - u.lL[0]) < P.OPEN_LFRAC * Llen || u.width < P.OPEN_MIN_W) return;
      const sg = Math.sign(dot(sub(u.c, C0), u.n)) || 1; u.huid = true; u.openHuid = true; u.out = u.n.map((v) => v * sg);
    });
    // 3. zichten
    const H = U.filter((u) => u.huid), par = H.map((_, i) => i), f = (i) => (par[i] === i ? i : (par[i] = f(par[i])));
    const ovL = (a, b) => { const o = Math.min(a.lL[1], b.lL[1]) - Math.max(a.lL[0], b.lL[0]); return o / Math.max(1, Math.min(a.lL[1] - a.lL[0], b.lL[1] - b.lL[0])); };
    const sameFace = (a, na, b, nb) => dot(na, nb) >= (ovL(a, b) > 0.3 ? P.SEAM_COS : P.ZICHT_TOUCH_COS);
    function contactLen(a, b, tol) { const t2 = tol * tol, ps = []; const scan = (x, y) => { if (!ovl(x.bb, y.bb, tol)) return; for (const p of x.uniq) { const pb = { mn: p, mx: p }; if (!ovl(pb, y.bb, tol)) continue; for (const q of y.T) { if (!ovl(pb, q.bb, tol)) continue; if (T.pointTriDist2(p, q.t[0], q.t[1], q.t[2]) <= t2) { ps.push(p); break; } } } }; scan(a, b); scan(b, a);
      if (ps.length < 2) return 0; const bb = aabbOf([ps]); return Math.hypot(bb.mx[0] - bb.mn[0], bb.mx[1] - bb.mn[1], bb.mx[2] - bb.mn[2]); }
    const joins = (a, b) => { if (!sameFace(a, a.out, b, b.out) || !touchU(a, b, P.UNION_TOL)) return false; if (dot(a.out, b.out) >= P.SEAM_COS) return true; return contactLen(a, b, P.UNION_TOL) >= P.EDGE_FRAC * Math.min(a.width, b.width); };
    const major = (u) => (u.lL[1] - u.lL[0]) >= P.MAJOR_FRAC * Llen;
    for (let i = 0; i < H.length; i++) for (let j = i + 1; j < H.length; j++) { const a = H[i], b = H[j]; if (!major(a) || !major(b)) continue; if (joins(a, b)) par[f(i)] = f(j); }
    H.forEach((a, i) => { if (major(a)) return; const cand = []; H.forEach((b, j) => { if (i !== j && major(b) && joins(a, b)) cand.push(j); }); if (!cand.length) return;
      cand.sort((x, y) => dot(a.out, H[y].out) - dot(a.out, H[x].out)); const keep = [cand[0]];
      cand.slice(1).forEach((j) => { if (keep.every((k) => sameFace(H[k], H[k].out, H[j], H[j].out))) keep.push(j); });
      keep.forEach((j) => { par[f(i)] = f(j); }); });
    const zm = new Map(); H.forEach((u, i) => { const r = f(i); (zm.get(r) || zm.set(r, []).get(r)).push(u); });
    let Z = [...zm.values()].map((list) => ({ els: list }));
    Z.forEach((z) => { let lo = 1e18, hi = -1e18; z.els.forEach((u) => { lo = Math.min(lo, u.lL[0]); hi = Math.max(hi, u.lL[1]); }); z.span = hi - lo;
      z.n = unit(z.els.reduce((a, u) => a.map((v, i) => v + u.out[i] * u.width * (u.lL[1] - u.lL[0])), [0, 0, 0])); });
    Z.filter((z) => z.span < P.MIN_LFRAC * Llen).forEach((z) => z.els.forEach((u) => { u.huid = false; u.demoted = true; }));
    Z = Z.filter((z) => z.span >= P.MIN_LFRAC * Llen);
    U.forEach((u) => { if (u.huid || u.via === "snede" || u.pad || !u.plate || Math.abs(dot(u.n, L)) >= P.ANG_PERP || u.width < P.MIN_W) return;
      const z = Z.find((z) => z.els.some((h) => Math.abs(dot(h.out, u.n)) >= (ovL(h, u) > 0.3 ? P.SEAM_COS : P.ZICHT_TOUCH_COS) && touchU(u, h, P.UNION_TOL)));
      if (z) { u.huid = true; u.added = true; u.out = dot(z.n, u.n) > 0 ? u.n : u.n.map((v) => -v); z.els.push(u); } });
    Z.forEach((z, k) => { z.k = k + 1; z.els.forEach((u) => { u.zicht = z; }); z.bb = aabbOf(z.els.flatMap((u) => u.tris)); z.T = z.els.flatMap((u) => u.T);
      z.orient = Math.abs(z.n[2]) > 0.98 ? "horizontaal" : Math.abs(z.n[2]) < 0.17 ? "verticaal" : "schuin";
      z.open = z.els.every((u) => u.openHuid); z.deelsOpen = !z.open && z.els.some((u) => u.openHuid);
      z.label = "Z" + z.k + (z.open ? " open" : z.deelsOpen ? " deels open" : "");
      z.names = [...new Set(z.els.map((u) => u.name))].join(" / "); });

    // 4. dwars / langs
    U.forEach((u) => { if (u.huid) return; u.tz = Z.filter((z) => touchT(u, z.T, z.bb)).map((z) => z.k); const pa = Math.abs(dot(u.n, L));
      if (u.plate && pa > P.ANG_PAR && u.width >= P.DW_MIN_W && u.tz.length >= 1) u.cls = "dwars?"; else if (u.plate && pa < P.ANG_PERP && u.width >= P.DW_MIN_W && u.tz.length >= 2) u.cls = "langs?"; else u.cls = "overig"; });
    const DSall = []; U.filter((u) => u.cls === "dwars?").sort((a, b) => dot(a.c, L) - dot(b.c, L)).forEach((u) => { const s = dot(u.c, L), d = DSall[DSall.length - 1]; if (d && s - d.last <= P.SCHOT_POS) { d.els.push(u); d.last = s; } else DSall.push({ s, last: s, els: [u] }); });
    DSall.forEach((d) => { d.tz = [...new Set(d.els.flatMap((u) => u.tz))].sort((a, b) => a - b); const opp = d.tz.some((a) => d.tz.some((b) => dot(Z[a - 1].n, Z[b - 1].n) < -P.ZICHT_COS));
      d.ok = d.tz.length >= 3 || opp; d.why = d.tz.length >= 3 ? "≥ 3 zichten" : opp ? "tussen 2 tegenoverliggende zichten" : ""; d.els.forEach((u) => { u.cls = d.ok ? "dwarsschot" : "overig"; }); });
    const DS = DSall.filter((d) => d.ok); DS.forEach((d, i) => { d.k = i + 1; d.els.forEach((u) => { u.schot = d; }); });
    // schottypes: exact gelijk
    const pieces = (d) => d.els.map((u) => ({ p: u.prof, d: u.dims.slice().sort((a, b) => b - a), w: u.w })).sort((a, b) => b.w - a.w || String(a.p).localeCompare(String(b.p)));
    const same = (a, b) => a.length === b.length && a.every((x, i) => { const y = b[i]; return x.p === y.p && x.d.every((v, k) => Math.abs(v - y.d[k]) <= Math.max(2, 0.005 * v)) && Math.abs(x.w - y.w) <= Math.max(0.2, 0.005 * x.w); });
    const TY = []; DS.forEach((d) => { const pc = pieces(d); let t = TY.find((t) => same(t.P, pc)); if (!t) { t = { P: pc, ds: [], k: TY.length + 1 }; TY.push(t); } t.ds.push(d); d.type = t.k; });
    const LS = []; U.filter((u) => u.cls === "langs?").forEach((u) => { const off = dot(u.c, u.n); let g = LS.find((g) => Math.abs(dot(g.n, u.n)) >= P.ZICHT_COS && Math.abs(Math.sign(dot(g.n, u.n)) * off - g.off) <= P.ZICHT_OFF); if (!g) { g = { n: u.n, off, els: [] }; LS.push(g); } g.els.push(u); });
    LS.forEach((g) => { const lo = Math.min(...g.els.map((u) => u.lL[0])), hi = Math.max(...g.els.map((u) => u.lL[1])); g.span = hi - lo; g.ok = g.span >= P.LANGS_FRAC * Llen; g.els.forEach((u) => { u.cls = g.ok ? "langsschot" : "overig"; }); });
    const LSok = LS.filter((g) => g.ok); LSok.forEach((g, i) => { g.k = i + 1; g.els.forEach((u) => { u.langs = g; }); });
    U.forEach((u) => { u.klasse = u.huid ? "huid" : u.cls === "dwarsschot" ? "dwarsschot" : u.cls === "langsschot" ? "langsschot" : "overig"; });

    // 5. ouder per detail: rechtstreeks contact met zicht > dwarsschot > langsschot, anders via andere details
    const rank = (u) => (u.klasse === "huid" ? 0 : u.klasse === "dwarsschot" ? 1 : u.klasse === "langsschot" ? 2 : 9);
    const det = U.filter((u) => u.klasse === "overig"), main = U.filter((u) => rank(u) < 9);
    const nb = new Map(); det.forEach((u) => nb.set(u, U.filter((o) => o !== u && ovl(u.bb, o.bb, P.TOL))));
    det.forEach((u) => { let best = null; for (const o of nb.get(u)) { if (rank(o) === 9 || (best && rank(o) >= rank(best))) continue; if (touchU(u, o)) best = o; } if (best) u.parent = best; });
    for (let it = 0, changed = true; changed && it < 12; it++) { changed = false;
      det.forEach((u) => { if (u.parent) return; for (const o of nb.get(u)) { if (o.klasse !== "overig" || !o.parent) continue; if (touchU(u, o)) { u.parent = o.parent; changed = true; break; } } }); }
    void main;
    // waarschuwingen
    const warn = [];
    const dem = U.filter((u) => u.demoted); if (dem.length) warn.push(`${dem.length} stuk(ken) in de buitenhuid vormen een vlak korter dan 25 % van de lengte (goot, lokale uitsparing): niet als zicht geteld.`);
    const part = DS.filter((d) => d.tz.length <= 3 && d.els.length <= 2 && DS.some((o) => o !== d && Math.abs(o.s - d.s) <= 200)); if (part.length) warn.push(`${part.length} dwarsschot(ten) ligt/liggen op minder dan 200 mm van een ander schot en raakt maar een deel van de huid (${part.map((d) => "S" + d.k).join(", ")}): mogelijk een verspringend schot.`);
    if (!SL.valid) warn.push("Geen enkele doorsnede is gesloten: de huid is enkel met stralen bepaald. Controleer de zichten.");
    const openZ = Z.filter((z) => z.open || z.deelsOpen); if (openZ.length) warn.push(`${openZ.length} zicht(en) bevat(ten) een enkelwandige huidplaat (aan beide kanten buitenlucht, ≥ 1 000 mm breed): ${openZ.map((z) => z.label).join(", ")}. Controleer of dit echt huid is en geen platform of console.`);
    if (!Z.length) warn.push("Geen zichten gevonden: is dit een koker? Open profielen (I-liggers, U-troggen) hebben geen gesloten huid.");
    return { version: VERSION, P, U, Z, DS, TY, LS: LSok, box, L, Llen, slicesValid: SL.valid, slicesN: P.SLICES, warn };
  }

  const Vlakken = { analyse, DEF, VERSION };
  if (typeof module !== "undefined" && module.exports) module.exports = Vlakken; else root.Vlakken = Vlakken;
})(typeof window !== "undefined" ? window : globalThis);
