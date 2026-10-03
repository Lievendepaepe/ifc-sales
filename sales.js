/*
 * sales.js — stap 9: Salesmeetstaat (Excel) en Salesmonotek (PDF).
 * Geometrie in IFC-coördinaten (mm). Excel via ExcelJS, PDF via jsPDF (beide via CDN geladen door index.html).
 */
(function (root) {
  "use strict";

  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  const unit = (a) => { const l = len(a); return l > 0 ? scl(a, 1 / l) : [0, 0, 0]; };
  const ptp = (arr) => { let lo = Infinity, hi = -Infinity; for (const v of arr) { if (v < lo) lo = v; if (v > hi) hi = v; } return hi - lo; };
  const SCALES = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];

  /* ---------- Profiel ---------- */
  function splitProfile(p) {
    const m = /^\s*PL\s*([\d.]+)\s*\*\s*([\d.]+)\s*$/i.exec(p || "");
    if (m) { const t = parseFloat(m[1]), b = parseFloat(m[2]); return { grp: "PL" + t, t, b }; }
    return { grp: p || "(onbekend)", t: null, b: null };
  }
  function groupKey(g) { const m = /^PL([\d.]+)$/.exec(g); return m ? [0, parseFloat(m[1]), ""] : [1, 0, g]; }
  function cmpGroup(a, b) { const x = groupKey(a), y = groupKey(b); return x[0] - y[0] || x[1] - y[1] || String(x[2]).localeCompare(String(y[2])); }
  const natKey = (s) => String(s || "").split(/(\d+)/).map((t) => (/^\d+$/.test(t) ? t.padStart(8, "0") : t)).join("");

  /* ---------- Hulp: eigenvectoren (symmetrische 3×3, machtsmethode) ---------- */
  function pca(P) {
    const n = P.length, C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const p of P) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += p[i] * p[j] / n;
    const power = (ortho, v) => {
      for (let k = 0; k < 80; k++) {
        let w = [dot(C[0], v), dot(C[1], v), dot(C[2], v)];
        for (const o of ortho) w = sub(w, scl(o, dot(w, o)));
        const l = len(w); if (l < 1e-12) break; v = scl(w, 1 / l);
      }
      return v;
    };
    const a = power([], [0.9, 0.3, 0.2]), b = power([a], [0.2, 0.9, 0.3]);
    return [a, b, unit(cross(a, b))];
  }
  function hull2(Pts) {
    const p = Pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]); if (p.length < 3) return p;
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    lo.pop(); up.pop(); return lo.concat(up);
  }
  // hoek waarbij de omschreven rechthoek minimaal is, met de langste zijde horizontaal
  function minRectAngle(Pts) {
    const H = hull2(Pts); if (H.length < 3) return 0; let best = null;
    for (let i = 0; i < H.length; i++) {
      const d = sub([...H[(i + 1) % H.length], 0], [...H[i], 0]), ang = Math.atan2(d[1], d[0]), c = Math.cos(ang), s = Math.sin(ang);
      const X = H.map((q) => q[0] * c + q[1] * s), Y = H.map((q) => -q[0] * s + q[1] * c), ar = ptp(X) * ptp(Y);
      if (!best || ar < best.ar - 1e-9) best = { ar, ang, lx: ptp(X), ly: ptp(Y) };
    }
    return best.ly > best.lx ? best.ang + Math.PI / 2 : best.ang;
  }

  /* ---------- Gevormde plaat: oppervlakte van de naden tussen segmenten ---------- */
  // Vlakken van een segment die samenvallen met een vlak van een ander segment (tegengestelde normaal, ≤ 0,5 mm).
  // Die vlakken bestaan niet in de echte (gezette/gebogen) plaat en worden van de som afgetrokken.
  function jointArea(segs) {
    const CELL = 200, grid = new Map(), F = [];
    segs.forEach((tris, si) => tris.forEach((t) => {
      const c = cross(sub(t[1], t[0]), sub(t[2], t[0])), a = len(c) / 2; if (a < 1e-6) return;
      const f = { t, n: scl(c, 0.5 / a), a, si, ce: scl(add(add(t[0], t[1]), t[2]), 1 / 3) }; F.push(f);
      const lo = [0, 1, 2].map((q) => Math.floor(Math.min(t[0][q], t[1][q], t[2][q]) / CELL)), hi = [0, 1, 2].map((q) => Math.floor(Math.max(t[0][q], t[1][q], t[2][q]) / CELL));
      for (let i = lo[0]; i <= hi[0]; i++) for (let j = lo[1]; j <= hi[1]; j++) for (let k = lo[2]; k <= hi[2]; k++) { const key = i + "," + j + "," + k; const l = grid.get(key); if (l) l.push(f); else grid.set(key, [f]); }
    }));
    let area = 0;
    for (const f of F) {
      const key = f.ce.map((v) => Math.floor(v / CELL)).join(","), l = grid.get(key) || [];
      for (const g of l) {
        if (g.si === f.si || dot(g.n, f.n) > -0.99) continue;
        const h = dot(sub(f.ce, g.t[0]), g.n); if (Math.abs(h) > 0.5) continue;
        const q = sub(f.ce, scl(g.n, h)), e0 = sub(g.t[1], g.t[0]), e1 = sub(g.t[2], g.t[0]), e2 = sub(q, g.t[0]);
        const d00 = dot(e0, e0), d01 = dot(e0, e1), d11 = dot(e1, e1), d20 = dot(e2, e0), d21 = dot(e2, e1), den = d00 * d11 - d01 * d01; if (Math.abs(den) < 1e-12) continue;
        const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den;
        if (v >= -1e-3 && w >= -1e-3 && v + w <= 1.001) { area += f.a; break; }
      }
    }
    return area; // mm²
  }

  /* ---------- Analyse van één stuk ---------- */
  // tris: [[p,p,p], …] in mm; info: {t (plaatdikte of null), grp}
  function analyzePart(tris, info) {
    const T = [], N = [], A = [];
    for (const t of tris) {
      const c = cross(sub(t[1], t[0]), sub(t[2], t[0])), a = len(c) / 2; if (a < 1e-6) continue;
      T.push(t); N.push(scl(c, 0.5 / a)); A.push(a);
    }
    const V = []; const vk = new Set();
    for (const t of T) for (const p of t) { const k = p.map((x) => Math.round(x * 2)).join(","); if (!vk.has(k)) { vk.add(k); V.push(p); } }
    const c = scl(V.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / Math.max(V.length, 1));
    const P = V.map((p) => sub(p, c));
    let flat = false, views = [];
    if (info.t != null && !info.formed) {
      const canon = (n) => { const s = Math.abs(n[2]) > 1e-6 ? Math.sign(n[2]) : Math.abs(n[1]) > 1e-6 ? Math.sign(n[1]) : Math.sign(n[0]) || 1; return scl(n, s); };
      const acc = new Map();
      N.forEach((n, i) => { const cn = canon(n), k = cn.map((x) => Math.round(x * 100)).join(","); const e = acc.get(k); if (e) e.a += A[i]; else acc.set(k, { n: cn, a: A[i] }); });
      let N0 = [...acc.values()].sort((x, y) => y.a - x.a)[0].n;
      let s = [0, 0, 0]; N.forEach((n, i) => { const cn = canon(n); if (Math.abs(dot(cn, N0)) > 0.999) s = add(s, scl(cn, A[i])); });
      const Nn = unit(s);
      const th = ptp(P.map((p) => dot(p, Nn)));
      if (Math.abs(th - info.t) <= 1.5) {
        flat = true;
        const a0 = unit(cross(Nn, Math.abs(Nn[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), b0 = cross(Nn, a0);
        const ang = minRectAngle(P.map((p) => [dot(p, a0), dot(p, b0)]));
        const ax = unit(add(scl(a0, Math.cos(ang)), scl(b0, Math.sin(ang)))), ay = cross(Nn, ax);
        views.push({ label: `Aanzicht plaatvlak (dikte ${info.t})`, ax, ay, dv: Nn });
      }
    }
    if (!flat) {
      const [a, b, cc] = pca(P);
      if (info.t == null) {
        views.push({ label: "Zijaanzicht", ax: a, ay: b, dv: cc });
        views.push({ label: "Doorsnede (midden)", section: true, ax: a, ay: b });
      } else {
        views.push({ label: "Aanzicht - niet-vlakke plaat, omschreven maten (geen uitslag)", ax: a, ay: b, dv: cc });
        views.push({ label: "Kopaanzicht (knik/ronding)", ax: b, ay: cc, dv: a });
      }
    }
    // randen
    const key = (p) => p.map((x) => Math.round(x * 20)).join(",");
    const E = new Map();
    T.forEach((t, ti) => { for (let i = 0; i < 3; i++) { const p = t[i], q = t[(i + 1) % 3], kp = key(p), kq = key(q), k = kp < kq ? kp + "|" + kq : kq + "|" + kp; const e = E.get(k); if (e) e.t.push(ti); else E.set(k, { p, q, t: [ti] }); } });
    const COS = Math.cos(20 * Math.PI / 180);
    const out = [];
    for (const v of views) {
      if (v.section) { out.push({ label: v.label, segs: sectionSegs(T, P, c, v.ax, v.ay) }); continue; }
      const segs = [];
      for (const e of E.values()) {
        let sharp = e.t.length !== 2;
        if (!sharp) { const n1 = N[e.t[0]], n2 = N[e.t[1]]; sharp = Math.abs(dot(n1, n2)) < COS || dot(n1, v.dv) * dot(n2, v.dv) < 0; }
        if (sharp) { const p = sub(e.p, c), q = sub(e.q, c); segs.push([dot(p, v.ax), dot(p, v.ay), dot(q, v.ax), dot(q, v.ay)]); }
      }
      out.push({ label: v.label, segs });
    }
    if (info.formed) {
      const L = info.formed.L, b = info.formed.b;
      out.push({ label: "Uitslag volgens Tekla (ontvouwing)", segs: [[0, 0, L, 0], [L, 0, L, b], [L, b, 0, b], [0, b, 0, 0]] });
    }
    return { flat, views: out };
  }

  // Doorsnede loodrecht op de lokale lengteas in het midden, in eigen ligging (kleinste omschreven rechthoek)
  function sectionSegs(T, P, c, ax, ay) {
    const uu = P.map((p) => dot(p, ax)); const um = (Math.min(...uu) + Math.max(...uu)) / 2, w = Math.max(300, 0.02 * ptp(uu));
    let near = P.filter((p, i) => Math.abs(uu[i] - um) < w); if (near.length < 6) near = P;
    const m = scl(near.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / near.length);
    let tg = pca(near.map((p) => sub(p, m)))[0]; if (dot(tg, ax) < 0) tg = scl(tg, -1);
    const o = add(c, m);
    let y = sub([0, 0, 1], scl(tg, tg[2])); if (len(y) < 0.2) y = sub(ay, scl(tg, dot(ay, tg)));
    y = unit(y); const x = cross(y, tg);
    const segs = [];
    for (const t of T) {
      const d = t.map((p) => dot(sub(p, o), tg)), pts = [];
      for (let i = 0; i < 3; i++) {
        const j = (i + 1) % 3;
        if ((d[i] < 0) !== (d[j] < 0)) { const f = d[i] / (d[i] - d[j]); pts.push(add(t[i], scl(sub(t[j], t[i]), f))); }
      }
      if (pts.length === 2) { const a = sub(pts[0], o), b = sub(pts[1], o); segs.push([dot(a, x), dot(a, y), dot(b, x), dot(b, y)]); }
    }
    if (segs.length > 2) {
      const ang = minRectAngle(segs.flatMap((s) => [[s[0], s[1]], [s[2], s[3]]])), cs = Math.cos(ang), sn = Math.sin(ang);
      const R = (X, Y) => [X * cs + Y * sn, -X * sn + Y * cs];
      return segs.map((s) => [...R(s[0], s[1]), ...R(s[2], s[3])]);
    }
    return segs;
  }

  /* ---------- PDF (jsPDF, A3 liggend, 3 × 3 stukken per blad) ---------- */
  function buildMonoPdf(jsPDF, items, meta, nl) {
    const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a3", compress: true });
    const W = 420, H = 297, M = 10, cols = 3, rows = 3, per = cols * rows, pages = Math.max(1, Math.ceil(items.length / per));
    const top = M + 14, bot = H - M - 8, cw = (W - 2 * M) / cols, ch = (bot - top) / rows;
    const drawView = (segs, box, label, over) => {
      const [x0, y0, x1, y1] = box;
      doc.setFont("helvetica", "normal"); doc.setFontSize(6); doc.setTextColor(90);
      if (!segs.length) { doc.text(`${label}: geen geometrie`, x0 + 1, y0 + 3); return; }
      let xa = Infinity, xb = -Infinity, ya = Infinity, yb = -Infinity;
      for (const s of segs) { xa = Math.min(xa, s[0], s[2]); xb = Math.max(xb, s[0], s[2]); ya = Math.min(ya, s[1], s[3]); yb = Math.max(yb, s[1], s[3]); }
      const ex = Math.max(xb - xa, 1e-3), ey = Math.max(yb - ya, 1e-3), aw = (x1 - x0) - 16, ah = (y1 - y0) - 18;
      const need = Math.max(ex / aw, ey / ah), s = SCALES.find((v) => v >= need) || Math.ceil(need), k = 1 / s;
      const ox = x0 + 12 + (aw - ex * k) / 2 - xa * k, oy = y1 - 12 - (ah - ey * k) / 2 + ya * k; // y naar beneden
      doc.text(`${label} · 1:${s}`, x0 + 1, y0 + 3);
      doc.setDrawColor(25, 30, 38); doc.setLineWidth(0.12);
      for (const q of segs) doc.line(ox + q[0] * k, oy - q[1] * k, ox + q[2] * k, oy - q[3] * k);
      const X0 = ox + xa * k, X1 = ox + xb * k, Yt = oy - yb * k, Yb = oy - ya * k;
      doc.setDrawColor(100); doc.setLineWidth(0.07);
      const yl = Yb + 5, xl = X0 - 5;
      doc.line(X0, Yb + 1, X0, yl + 1); doc.line(X1, Yb + 1, X1, yl + 1); doc.line(X0, yl, X1, yl);
      doc.line(X0 - 0.8, yl + 0.8, X0 + 0.8, yl - 0.8); doc.line(X1 - 0.8, yl + 0.8, X1 + 0.8, yl - 0.8);
      doc.line(X0 - 1, Yt, xl - 1, Yt); doc.line(X0 - 1, Yb, xl - 1, Yb); doc.line(xl, Yt, xl, Yb);
      doc.line(xl - 0.8, Yt + 0.8, xl + 0.8, Yt - 0.8); doc.line(xl - 0.8, Yb + 0.8, xl + 0.8, Yb - 0.8);
      doc.setFont("helvetica", "bold"); doc.setFontSize(6.5); doc.setTextColor(0);
      const tx = (over && over[0]) || nl(ex, 0), ty = (over && over[1]) || nl(ey, 0);
      doc.text(tx, (X0 + X1) / 2, yl - 0.8, { align: "center" });
      const tw = doc.getTextWidth(ty); doc.text(ty, xl - 0.8, (Yt + Yb) / 2 + tw / 2, { angle: 90 });
    };
    for (let pg = 0; pg < pages; pg++) {
      if (pg) doc.addPage("a3", "landscape");
      doc.setDrawColor(25, 30, 38); doc.setLineWidth(0.3); doc.rect(M, M, W - 2 * M, H - 2 * M);
      doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(25, 30, 38); doc.text(`Salesmonotek - ${meta.title}`, M + 3, M + 8);
      doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.text(`Blad ${pg + 1}/${pages} · A3 · maten in mm · schaal per aanzicht`, W - M - 3, M + 8, { align: "right" });
      doc.setFontSize(6.5); doc.setTextColor(100);
      doc.text(`Automatisch gegenereerd uit ${meta.source} · gelijke stukken 1× getekend · hoofdafmetingen = omschreven maten per aanzicht · schets, geen werkplaatstekening`, M + 3, H - M - 3);
      items.slice(pg * per, (pg + 1) * per).forEach((it, i) => {
        const u = it.row, cx = M + (i % cols) * cw, cy = top + Math.floor(i / cols) * ch;
        doc.setDrawColor(190, 198, 208); doc.setLineWidth(0.1); doc.rect(cx + 1, cy + 1, cw - 2, ch - 2);
        doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(25, 30, 38); doc.text(`${u.pos}   ${u.name || ""}${u.segments ? `   (gevormde plaat, ${u.segments} segmenten in het model)` : ""}`, cx + 3, cy + 6);
        const prof = u.t != null ? `PL${u.t} × ${nl(u.b, 0)}` : u.grp;
        doc.setFont("helvetica", "normal"); doc.setFontSize(7);
        doc.text(`${prof} · ${u.mat || "-"} · ${u.n} st · L ${nl(u.L, 0)} · ${nl(u.W, 1)} kg/st · ${nl(u.A, 2)} m²/st`, cx + 3, cy + 10);
        const area = [cx + 2, cy + 12, cx + cw - 2, cy + ch - 2], v = it.geo.views;
        if (v.length === 1) drawView(v[0].segs, area, v[0].label);
        else if (v.length === 3) {
          // gevormde plaat: vorm, kopaanzicht, uitslag
          const w = area[2] - area[0], s1 = area[0] + w * 0.42, s2 = area[0] + w * 0.62;
          drawView(v[0].segs, [area[0], area[1], s1, area[3]], "Vorm (omschreven)");
          drawView(v[1].segs, [s1, area[1], s2, area[3]], "Kop (knik)");
          drawView(v[2].segs, [s2, area[1], area[2], area[3]], v[2].label, [nl(u.L, 0), nl(u.b, 0)]);
        } else {
          const split = area[0] + (area[2] - area[0]) * 0.68;
          const md = /^Ø([\d.]+)/.exec(u.grp || ""), dn = md ? "Ø" + nl(parseFloat(md[1]), 0) : null; // buis: nominale diameter
          drawView(v[0].segs, [area[0], area[1], split, area[3]], v[0].label, md ? [nl(u.L, 0), dn] : null);
          drawView(v[1].segs, [split, area[1], area[2], area[3]], v[1].label, md ? [dn, dn] : null);
        }
      });
    }
    return doc.output("arraybuffer");
  }

  /* ---------- Excel (ExcelJS) ---------- */
  async function buildMeetstaat(ExcelJS, rows, meta) {
    const wb = new ExcelJS.Workbook(); wb.creator = "locale-as";
    // Excel moet bij openen herrekenen; daarnaast krijgt elke formule haar resultaat mee,
    // zodat ook viewers die niet rekenen (voorbeeldweergave, beveiligde weergave) de waarden tonen.
    wb.calcProperties.fullCalcOnLoad = true;
    const F = { name: "Arial", size: 10 }, FB = { name: "Arial", size: 10, bold: true }, FH = { name: "Arial", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    const HF = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3A5F" } }, TF = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EDF3" } };
    const head = (ws, r, cols, widths) => {
      cols.forEach((c, i) => { const cell = ws.getCell(r, i + 1); cell.value = c; cell.font = FH; cell.fill = HF; cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true }; if (widths) ws.getColumn(i + 1).width = widths[i]; });
      ws.getRow(r).height = 30;
    };
    const ws = wb.addWorksheet("Meetstaat", { views: [{ state: "frozen", ySplit: 1 }] });
    head(ws, 1, ["Positie", "Benaming", "Type", "Profielgroep", "Dikte (mm)", "Breedte (mm)", "Materiaal", "Aantal", "Lengte/st (mm)", "Netto gewicht/st (kg)", "Netto opp./st (m²)", "Netto totaal gewicht (kg)", "Netto totaal opp. (m²)", "Opmerking"],
      [12, 22, 8, 26, 10, 12, 18, 8, 14, 14, 15, 16, 17, 40]);
    const fm = { 5: "#,##0.#", 6: "#,##0.#", 8: "#,##0", 9: "#,##0", 10: "#,##0.0", 11: "#,##0.000", 12: "#,##0.0", 13: "#,##0.00" };
    rows.forEach((u, i) => {
      const r = i + 2, vals = [u.pos, u.name, u.typ, u.grp, u.t, u.b, u.mat, u.n, u.L, u.W, u.A,
        { formula: `H${r}*J${r}`, result: u.n * u.W }, { formula: `H${r}*K${r}`, result: u.n * u.A }, u.note || null];
      vals.forEach((v, j) => { const c = ws.getCell(r, j + 1); c.value = v; c.font = F; if (fm[j + 1]) c.numFmt = fm[j + 1]; });
    });
    const last = rows.length + 1, tr = last + 1;
    ws.getCell(tr, 1).value = "Totaal"; ws.getCell(tr, 1).font = FB;
    const tot = { 8: rows.reduce((s, u) => s + u.n, 0), 12: rows.reduce((s, u) => s + u.n * u.W, 0), 13: rows.reduce((s, u) => s + u.n * u.A, 0) };
    [8, 12, 13].forEach((col) => { const L = String.fromCharCode(64 + col), c = ws.getCell(tr, col); c.value = { formula: `SUM(${L}2:${L}${last})`, result: tot[col] }; c.font = FB; c.numFmt = fm[col]; });
    for (let j = 1; j <= 14; j++) ws.getCell(tr, j).fill = TF;
    ws.autoFilter = `A1:N${last}`;

    const ss = wb.addWorksheet("Samenvatting");
    ss.getCell("A1").value = `${meta.title} - samenvatting`; ss.getCell("A1").font = { name: "Arial", size: 12, bold: true };
    const rng = (c) => "Meetstaat!$" + c + "$2:$" + c + "$" + last;
    const keyOf = { D: (u) => u.grp, G: (u) => u.mat || "", B: (u) => u.name || "" };
    const block = (title, start, label, items, col) => {
      const sums = (it) => { const l = rows.filter((u) => keyOf[col](u) === it); return [l.reduce((s, u) => s + u.n, 0), l.reduce((s, u) => s + u.n * u.W, 0), l.reduce((s, u) => s + u.n * u.A, 0)]; };
      const bt = [0, 0, 0];
      ss.getCell(start, 1).value = title; ss.getCell(start, 1).font = FB;
      head(ss, start + 1, [label, "Aantal stuks", "Netto totaal gewicht (kg)", "Netto totaal opp. (m²)"], [30, 14, 18, 18]);
      items.forEach((it, i) => {
        const r = start + 2 + i; ss.getCell(r, 1).value = it; ss.getCell(r, 1).font = F;
        const sv = sums(it); sv.forEach((v, k) => { bt[k] += v; });
        [["H", "#,##0"], ["L", "#,##0.0"], ["M", "#,##0.00"]].forEach(([src, f], k) => { const c = ss.getCell(r, 2 + k); c.value = { formula: `SUMIFS(${rng(src)},${rng(col)},$A${r})`, result: sv[k] }; c.font = F; c.numFmt = f; });
      });
      const rt = start + 2 + items.length; ss.getCell(rt, 1).value = "Totaal"; ss.getCell(rt, 1).font = FB;
      [["B", "#,##0"], ["C", "#,##0.0"], ["D", "#,##0.00"]].forEach(([L, f], k) => { const c = ss.getCell(rt, 2 + k); c.value = { formula: `SUM(${L}${start + 2}:${L}${rt - 1})`, result: bt[k] }; c.font = FB; c.numFmt = f; });
      for (let j = 1; j <= 4; j++) ss.getCell(rt, j).fill = TF;
      return rt;
    };
    let end = block("Per profiel (platen per dikte, daarna andere profielen)", 3, "Profiel", [...new Set(rows.map((u) => u.grp))].sort(cmpGroup), "D");
    end = block("Per materiaal", end + 3, "Materiaal", [...new Set(rows.map((u) => u.mat || ""))].sort(), "G");
    end = block("Per benaming", end + 3, "Benaming", [...new Set(rows.map((u) => u.name || ""))].sort(), "B");
    const r = end + 3; ss.getCell(r, 1).value = "Unieke posities"; ss.getCell(r, 1).font = FB;
    ss.getCell(r + 1, 1).value = "Unieke plaatposities (PL)"; ss.getCell(r + 1, 2).value = rows.filter((u) => u.t != null).length;
    ss.getCell(r + 2, 1).value = "Unieke posities totaal"; ss.getCell(r + 2, 2).value = rows.length;

    const inf = wb.addWorksheet("Info"); inf.getColumn(1).width = 16; inf.getColumn(2).width = 110;
    meta.info.forEach(([a, b], i) => { inf.getCell(i + 1, 1).value = a; inf.getCell(i + 1, 1).font = FB; const c = inf.getCell(i + 1, 2); c.value = b; c.font = F; c.alignment = { wrapText: true, vertical: "top" }; });
    return wb.xlsx.writeBuffer();
  }

  root.Sales = { splitProfile, cmpGroup, natKey, analyzePart, jointArea, buildMonoPdf, buildMeetstaat };
})(typeof window !== "undefined" ? window : globalThis);
