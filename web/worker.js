/*
 * Motor de extracción SIRI (corre dentro de un Web Worker).
 *
 * Este archivo define una sola función, siriWorkerMain. La página la convierte
 * en un Worker usando un Blob. Así funciona igual abierta con doble clic
 * (file://) o publicada en GitHub Pages.
 *
 * Cómo extrae:
 *   Pide al WMS del SIRI el mapa de cada cuadro en formato KML vectorial
 *   (GetMap + kmscore:100). GeoServer devuelve TODAS las fincas que tocan el
 *   cuadro, con geometría completa en WGS84 y todos los atributos. Si un cuadro
 *   tarda demasiado (el servidor corta la respuesta) o trae demasiadas fincas,
 *   se divide en 4 y se vuelve a pedir (árbol cuaternario adaptativo).
 *   Al final se verifica con puntos al azar usando GetFeatureInfo (método
 *   independiente) y se informa el porcentaje encontrado.
 */
function siriWorkerMain() {
  'use strict';

  const BASE = 'https://geop8.siri.snitcr.go.cr/GeoP/geoprox2';
  const KEY = '390c80aJivoGEOSIRI';
  const LAYER = 'catastro_detallado';
  const R = 6378137;

  // ---------- Proyecciones (WGS84 <-> Web Mercator) ----------
  const toMerc = (lon, lat) => [
    (lon * Math.PI / 180) * R,
    Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R,
  ];
  const toLonLat = (x, y) => [
    (x / R) * 180 / Math.PI,
    (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI,
  ];
  const mapCoords = (c, fn) => (typeof c[0] === 'number' ? fn(c[0], c[1]) : c.map((k) => mapCoords(k, fn)));

  // ---------- Geometría mínima (sin librerías), en EPSG:3857 ----------
  function geomToPolys(geom) {
    if (geom.type === 'Polygon') return [geom.coordinates];
    if (geom.type === 'MultiPolygon') return geom.coordinates;
    return [];
  }
  function ringContains(ring, x, y) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function polysContain(polys, x, y) {
    for (const poly of polys) {
      if (!ringContains(poly[0], x, y)) continue;
      let hole = false;
      for (let h = 1; h < poly.length; h++) if (ringContains(poly[h], x, y)) { hole = true; break; }
      if (!hole) return true;
    }
    return false;
  }
  function segDist2(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    let t = dx || dy ? ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy) : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx - px, qy = ay + t * dy - py;
    return qx * qx + qy * qy;
  }
  // ¿El cuadro [x0,y0,x1,y1] toca el área ampliada en `buf` metros?
  function boxNearArea(area, b, buf) {
    if (b[2] < area.bbox[0] - buf || b[0] > area.bbox[2] + buf || b[3] < area.bbox[1] - buf || b[1] > area.bbox[3] + buf) return false;
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    if (polysContain(area.polys, cx, cy)) return true;
    const half = Math.hypot(b[2] - b[0], b[3] - b[1]) / 2;
    const lim = (half + buf) * (half + buf);
    for (const poly of area.polys) for (const ring of poly) {
      for (let i = 1; i < ring.length; i++) {
        if (segDist2(cx, cy, ring[i - 1][0], ring[i - 1][1], ring[i][0], ring[i][1]) <= lim) return true;
      }
    }
    return false;
  }
  // Centroide y área (m² reales, corrigiendo la escala de Mercator) de una geometría 3857.
  function centroidArea(geom) {
    let A = 0, Cx = 0, Cy = 0, vx = 0, vy = 0, nv = 0;
    for (const poly of geomToPolys(geom)) {
      poly.forEach((ring, idx) => {
        let a = 0, cx = 0, cy = 0;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
          a += f; cx += (ring[j][0] + ring[i][0]) * f; cy += (ring[j][1] + ring[i][1]) * f;
          vx += ring[i][0]; vy += ring[i][1]; nv++;
        }
        a /= 2;
        const aa = Math.abs(a) * (idx === 0 ? 1 : -1);
        if (a !== 0) { Cx += (cx / (6 * a)) * aa; Cy += (cy / (6 * a)) * aa; }
        A += aa;
      });
    }
    let x, y;
    if (A > 0) { x = Cx / A; y = Cy / A; } else if (nv) { x = vx / nv; y = vy / nv; } else return null;
    const lat = toLonLat(x, y)[1];
    const k = Math.cos(lat * Math.PI / 180);
    return { x, y, area_m2: A * k * k };
  }
  // Punto garantizado dentro: si el centroide cae fuera (forma de "L"), usa el centro del mayor tramo horizontal.
  function interiorPoint(geom, c) {
    const polys = geomToPolys(geom);
    if (polysContain(polys, c.x, c.y)) return c;
    const xs = [];
    for (const poly of polys) for (const ring of poly) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[j], [x2, y2] = ring[i];
      if ((y1 > c.y) !== (y2 > c.y)) xs.push(x1 + ((c.y - y1) * (x2 - x1)) / (y2 - y1));
    }
    xs.sort((a, b) => a - b);
    let best = null, w = -1;
    for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > w) { w = xs[i + 1] - xs[i]; best = (xs[i] + xs[i + 1]) / 2; }
    return best === null ? c : { x: best, y: c.y, area_m2: c.area_m2 };
  }

  // ---------- Lectura de KML (sin DOMParser: no existe en Workers) ----------
  const NUMERIC = new Set(['shape_area', 'shape_leng']);
  const INTEGER = new Set(['id_origen', 'certificad', 'uso', 'transitori']);
  const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
  const unesc = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENT[m]).replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d));
  // "3/22/25, 12:00 AM" -> "2025-03-22"; deja igual lo que no reconoce.
  function normDate(v) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s/.exec(v);
    if (!m) return v.replace(/Z$/, '');
    let y = +m[3]; if (y < 100) y += 2000;
    return y + '-' + String(m[1]).padStart(2, '0') + '-' + String(m[2]).padStart(2, '0');
  }
  function parseCoords(txt) {
    const out = [];
    for (const tok of txt.trim().split(/\s+/)) {
      const p = tok.split(',');
      if (p.length >= 2) out.push([+(+p[0]).toFixed(9), +(+p[1]).toFixed(9)]);
    }
    return out;
  }
  function parseKml(text) {
    const feats = [];
    const reP = /<Placemark\b([^>]*)>([\s\S]*?)<\/Placemark>/g;
    let m;
    while ((m = reP.exec(text))) {
      const idm = /\bid="([^"]*)"/.exec(m[1]);
      const id = idm ? idm[1] : null, body = m[2];
      const props = {};
      const reD = /<SimpleData name="([^"]+)"\s*(?:\/>|>([\s\S]*?)<\/SimpleData>)/g;
      let d;
      while ((d = reD.exec(body))) {
        const k = d[1] === 'id' ? 'id_origen' : d[1];
        let v = d[2] === undefined ? null : unesc(d[2]);
        if (v !== null) {
          if (NUMERIC.has(k)) v = v === '' ? null : Number(v);
          else if (INTEGER.has(k)) v = v === '' ? null : parseInt(v, 10);
          else if (/_da$|_edi_1$/.test(k)) v = normDate(v);
        }
        props[k] = v;
      }
      const polys = [];
      const rePoly = /<Polygon\b[^>]*>([\s\S]*?)<\/Polygon>/g;
      let pg;
      while ((pg = rePoly.exec(body))) {
        const rings = [];
        const ob = /<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/.exec(pg[1]);
        if (!ob) continue;
        rings.push(parseCoords(ob[1]));
        const reIn = /<innerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/g;
        let ib;
        while ((ib = reIn.exec(pg[1]))) rings.push(parseCoords(ib[1]));
        if (rings[0].length >= 4) polys.push(rings);
      }
      if (!polys.length) continue;
      const geometry = polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
      feats.push({ type: 'Feature', id: id || props.identifica, properties: props, geometry });
    }
    return feats;
  }

  // ---------- Estado ----------
  let st = null;
  let paused = false;
  let cancelled = false;
  let running = 0;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const post = (type, data) => self.postMessage(Object.assign({ type }, data));

  function kmlUrl(b) {
    return BASE + '?s=' + KEY + '&SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap' +
      '&LAYERS=' + LAYER + '&STYLES=&SRS=EPSG:3857' +
      '&BBOX=' + b.map((v) => v.toFixed(2)).join(',') +
      '&WIDTH=512&HEIGHT=512&FORMAT=application%2Fvnd.google-earth.kml%2Bxml' +
      '&format_options=kmscore:100;kmattr:false;kmplacemark:false;extendeddata:true';
  }
  function gfiUrl(b, w, px, fc) {
    return BASE + '?s=' + KEY + '&SERVICE=WMS&VERSION=1.1.1&REQUEST=GetFeatureInfo' +
      '&LAYERS=' + LAYER + '&QUERY_LAYERS=' + LAYER + '&STYLES=&SRS=EPSG:3857' +
      '&BBOX=' + b.map((v) => v.toFixed(2)).join(',') +
      '&WIDTH=' + w + '&HEIGHT=' + w + '&X=' + px + '&Y=' + px +
      '&INFO_FORMAT=application/json&FEATURE_COUNT=' + fc;
  }

  async function fetchText(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), st.opts.timeoutMs);
    try {
      const r = await fetch(url, { signal: ctrl.signal, credentials: 'omit', cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('tiempo de espera agotado');
      throw e;
    } finally { clearTimeout(t); }
  }

  function addFeatures(list) {
    let nuevos = 0;
    for (const f of list) {
      if (!f.id) continue;
      if (!st.features.has(f.id)) { st.features.set(f.id, f); nuevos++; }
    }
    return nuevos;
  }

  function progress(extra) {
    const s = st.stats;
    const elapsed = (Date.now() - st.startedAt) / 1000 + st.prevElapsed;
    // El avance se mide por superficie cubierta: es estable aunque los cuadros se dividan.
    const frac = st.areaTotal > 0 ? s.areaDone / st.areaTotal : 0;
    const rate = frac / Math.max(1, elapsed - st.prevElapsedAtStart);
    post('progress', Object.assign({
      phase: st.phase, frac,
      tilesDone: s.tilesDone, tilesPending: st.queue.length + running, splits: s.splits, errors: s.errors, failed: st.failed.length,
      features: st.features.size, queries: s.queries, elapsed,
      etaSec: rate > 0 && frac > 0.02 ? (1 - frac) / rate : null, paused,
    }, extra || {}));
  }

  // ---------- Fase 1: cuadros KML adaptativos ----------
  // Memoria de densidad: celda de 2 km -> menor tamaño de cuadro que falló por denso.
  // Los vecinos de ese tamaño o mayor se dividen sin pedirlos (ahorra esperas inútiles).
  const DENS = 2000;
  const densKey = (t) => Math.floor((t.x + t.size / 2) / DENS) + ':' + Math.floor((t.y + t.size / 2) / DENS);
  function markDense(tile) {
    const k = densKey(tile);
    const prev = st.dense[k];
    if (prev === undefined || tile.size < prev) st.dense[k] = tile.size;
  }
  function split(tile) {
    st.stats.splits++;
    const h = tile.size / 2;
    for (const [dx, dy] of [[0, 0], [h, 0], [0, h], [h, h]]) {
      const c = { x: tile.x + dx, y: tile.y + dy, size: h, tries: 0 };
      if (boxNearArea(st.area, [c.x, c.y, c.x + h, c.y + h], st.opts.bufferM)) st.queue.unshift(c);
      else st.stats.areaDone += h * h; // fuera del área: cuenta como cubierto
    }
  }

  async function processTile(tile) {
    const b = [tile.x, tile.y, tile.x + tile.size, tile.y + tile.size];
    let text;
    try {
      text = await fetchText(kmlUrl(b));
      st.stats.queries++;
    } catch (e) {
      st.stats.queries++;
      throw e;
    }
    const complete = text.indexOf('<kml') >= 0 && text.lastIndexOf('</kml>') > 0;
    if (!complete) {
      // Respuesta vacía o cortada: el servidor no alcanzó a dibujar el cuadro.
      const err = new Error(text.trim() ? 'respuesta incompleta' : 'respuesta vacía (cuadro muy denso)');
      err.tooBig = true;
      throw err;
    }
    const feats = parseKml(text);
    addFeatures(feats);
    if (feats.length >= st.opts.maxPerTile && tile.size > st.opts.minTile) {
      split(tile); // posible tope del servidor: se pide más fino
    } else {
      st.stats.areaDone += tile.size * tile.size;
    }
    st.stats.tilesDone++;
  }

  // Cortacircuito: si 6 de las últimas 8 respuestas fallaron, el servidor está caído o saturado.
  function recordResult(ok) {
    st.recent = (st.recent || []).concat([ok]).slice(-8);
  }
  function serverDown() {
    const r = st.recent || [];
    return r.length >= 6 && r.filter((v) => !v).length >= 6;
  }
  async function coolDown() {
    if (st.coolingUntil && Date.now() < st.coolingUntil) { await sleep(st.coolingUntil - Date.now()); return; }
    st.cooldowns = (st.cooldowns || 0) + 1;
    const secs = Math.min(300, 60 * st.cooldowns);
    st.coolingUntil = Date.now() + secs * 1000;
    st.recent = [];
    post('warn', { message: 'El servidor del SIRI no está respondiendo (' + st.lastError + '). Reintento automático en ' + Math.round(secs / 60) + ' min. No hace falta hacer nada.' });
    if (st.cooldowns >= 8) {
      paused = true;
      post('warn', { message: 'El servidor del SIRI lleva mucho tiempo sin responder. Extracción en pausa; presioná Reanudar más tarde. El avance está guardado.' });
    }
    await sleep(secs * 1000);
  }

  async function sweep() {
    st.phase = 'descarga';
    let lastPost = 0;
    const loop = async () => {
      while (!cancelled) {
        if (paused) { await sleep(300); continue; }
        if (st.coolingUntil && Date.now() < st.coolingUntil) { await sleep(Math.min(2000, st.coolingUntil - Date.now())); continue; }
        const tile = st.queue.shift();
        if (!tile) { if (running === 0) return; await sleep(200); continue; }
        const known = st.dense[densKey(tile)];
        if (known !== undefined && tile.size >= known && tile.size > st.opts.noSplitBelow) {
          split(tile); st.stats.tilesDone++; st.stats.preSplits = (st.stats.preSplits || 0) + 1;
          continue;
        }
        running++;
        try {
          await processTile(tile);
          recordResult(true);
          if (st.cooldowns) post('recovered', {});
          st.cooldowns = 0;
        } catch (e) {
          st.stats.errors++;
          st.lastError = String((e && e.message) || e);
          recordResult(false);
          if (serverDown()) {
            // Casi todo falla, sin importar el tamaño: el problema es el servidor, no la densidad.
            st.queue.unshift(tile);
            await coolDown();
          } else if (tile.size > st.opts.noSplitBelow && (e.tooBig || /tiempo de espera|HTTP 5/.test(st.lastError))) {
            markDense(tile);
            split(tile);
            st.stats.tilesDone++;
          } else {
            tile.tries = (tile.tries || 0) + 1;
            if (tile.tries < st.opts.maxTries) st.queue.push(tile);
            else { st.failed.push(tile); st.stats.areaDone += tile.size * tile.size; }
            await sleep(Math.min(30000, 2000 * Math.pow(2, tile.tries)));
          }
        } finally { running--; }
        if (Date.now() - lastPost > 700) { lastPost = Date.now(); progress({ lastError: st.lastError, inFlight: running }); }
        maybeCheckpoint();
      }
    };
    const beat = setInterval(() => progress({ lastError: st.lastError, inFlight: running }), 1000);
    const ws = [];
    for (let i = 0; i < st.opts.concurrency; i++) ws.push(loop());
    try { await Promise.all(ws); } finally { clearInterval(beat); }
  }

  // ---------- Fase 2: verificación por puntos al azar (método independiente) ----------
  async function verify() {
    st.phase = 'verificación';
    const n = st.opts.verifyPoints;
    const pts = [];
    const [x0, y0, x1, y1] = st.area.bbox;
    let guard = 0;
    while (pts.length < n && guard++ < n * 500) {
      const x = x0 + Math.random() * (x1 - x0), y = y0 + Math.random() * (y1 - y0);
      if (polysContain(st.area.polys, x, y)) pts.push([x, y]);
    }
    let checked = 0, withParcel = 0, found = 0, i = 0, failedPts = 0;
    const missing = [];
    const loop = async () => {
      while (!cancelled && i < pts.length) {
        if (paused) { await sleep(300); continue; }
        const [x, y] = pts[i++];
        let feats = null;
        for (let t = 0; t < 3 && feats === null && !cancelled; t++) {
          try {
            const txt = await fetchText(gfiUrl([x - 2, y - 2, x + 2, y + 2], 5, 2, 10));
            feats = txt.trim() ? (JSON.parse(txt).features || []) : [];
          } catch (e) { st.stats.errors++; await sleep(3000 * (t + 1)); }
        }
        if (feats === null) { failedPts++; continue; }
        st.stats.queries++;
        checked++;
        if (feats.length) {
          withParcel++;
          const miss = feats.filter((f) => !st.features.has(f.id));
          if (!miss.length) found++;
          else for (const f of miss) missing.push(f.id);
        }
        progress({ verify: { checked, total: pts.length, withParcel, found } });
      }
    };
    const ws = [];
    for (let k = 0; k < Math.min(3, st.opts.concurrency); k++) ws.push(loop());
    await Promise.all(ws);
    st.verify = { puntos: checked, sin_respuesta: failedPts, con_finca: withParcel, encontradas: found, faltantes: missing.length, ids_faltantes: missing.slice(0, 50) };
  }

  // ---------- Fase 3: preparar resultado ----------
  function finalize() {
    st.phase = 'preparando';
    progress();
    const rows = [];
    const inside = [];
    for (const [id, f] of st.features) {
      const g3857 = { type: f.geometry.type, coordinates: mapCoords(f.geometry.coordinates, toMerc) };
      const c0 = centroidArea(g3857);
      if (!c0) continue;
      const c = interiorPoint(g3857, c0);
      const dentro = polysContain(st.area.polys, c.x, c.y);
      const p = f.properties || {};
      const code = [p.provincia, p.canton, st.mode === 'distrito' ? p.distrito : null].filter((v) => v != null && v !== '').join('-');
      rows.push({ id, f, c, c0, dentro, code });
      if (dentro && code) inside.push(code);
    }
    // Código catastral dominante entre las fincas cuyo punto interior cae en el polígono.
    const counts = {};
    for (const k of inside) counts[k] = (counts[k] || 0) + 1;
    const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const dominant = ranked.length ? ranked[0][0] : null;

    const out = [];
    let nCodigo = 0, nGeom = 0;
    for (const r of rows) {
      const porCodigo = dominant !== null && r.code === dominant;
      if (porCodigo) nCodigo++;
      if (r.dentro) nGeom++;
      let keep;
      if (st.opts.filter === 'codigo') keep = porCodigo || (!r.code && r.dentro);
      else if (st.opts.filter === 'geometria') keep = r.dentro;
      else keep = true;
      if (!keep) continue;
      const [lon, lat] = toLonLat(r.c.x, r.c.y);
      out.push({
        type: 'Feature',
        id: r.id,
        properties: Object.assign({}, r.f.properties, {
          _siri_id: r.id,
          _area_calc_m2: Math.round(r.c0.area_m2 * 100) / 100,
          _punto_lon: +lon.toFixed(7),
          _punto_lat: +lat.toFixed(7),
          _codigo_coincide: porCodigo,
          _punto_en_poligono: r.dentro,
        }),
        geometry: r.f.geometry,
      });
    }
    return {
      features: out,
      summary: {
        codigo_dominante: dominant,
        otros_codigos: ranked.slice(1, 6),
        fincas_descargadas: st.features.size,
        fincas_por_codigo: nCodigo,
        fincas_por_geometria: nGeom,
        fincas_exportadas: out.length,
      },
    };
  }

  // ---------- Guardado parcial (IndexedDB) para reanudar ----------
  let lastCk = 0;
  function idb() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open('siri-extractor', 2);
      rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains('runs')) rq.result.createObjectStore('runs'); };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  }
  async function saveCheckpoint(force) {
    if (!st || (!force && Date.now() - lastCk < 60000)) return;
    lastCk = Date.now();
    try {
      const db = await idb();
      const snap = {
        version: 2, key: st.key, label: st.label, mode: st.mode, opts: st.opts, areaGeo: st.areaGeo,
        queue: st.queue.slice(), failed: st.failed.slice(), stats: st.stats, areaTotal: st.areaTotal, dense: st.dense,
        prevElapsed: (Date.now() - st.startedAt) / 1000 + st.prevElapsed,
        features: Array.from(st.features.entries()), savedAt: new Date().toISOString(),
      };
      await new Promise((res, rej) => {
        const tx = db.transaction('runs', 'readwrite');
        tx.objectStore('runs').put(snap, 'ultimo');
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
      post('checkpoint', { savedAt: snap.savedAt, features: st.features.size });
    } catch (e) { /* sin IndexedDB (modo privado): se sigue sin guardado parcial */ }
  }
  function maybeCheckpoint() { saveCheckpoint(false); }
  async function loadCheckpoint() {
    try {
      const db = await idb();
      const c = await new Promise((res) => {
        const rq = db.transaction('runs').objectStore('runs').get('ultimo');
        rq.onsuccess = () => res(rq.result || null);
        rq.onerror = () => res(null);
      });
      return c && c.version === 2 ? c : null;
    } catch (e) { return null; }
  }
  async function clearCheckpoint() {
    try {
      const db = await idb();
      db.transaction('runs', 'readwrite').objectStore('runs').delete('ultimo');
    } catch (e) { /* nada */ }
  }

  // ---------- Inicio ----------
  function buildArea(areaGeo) {
    const geom3857 = { type: areaGeo.geometry.type, coordinates: mapCoords(areaGeo.geometry.coordinates, toMerc) };
    const polys = geomToPolys(geom3857);
    const bbox = [Infinity, Infinity, -Infinity, -Infinity];
    for (const poly of polys) for (const [x, y] of poly[0]) {
      if (x < bbox[0]) bbox[0] = x; if (y < bbox[1]) bbox[1] = y;
      if (x > bbox[2]) bbox[2] = x; if (y > bbox[3]) bbox[3] = y;
    }
    return { polys, bbox };
  }

  async function run(msg, resume) {
    cancelled = false; paused = false;
    if (resume) {
      st = {
        key: resume.key, label: resume.label, mode: resume.mode, opts: resume.opts, areaGeo: resume.areaGeo,
        area: buildArea(resume.areaGeo), queue: resume.queue.concat(resume.failed.map((n) => Object.assign(n, { tries: 0 }))),
        failed: [], stats: resume.stats, features: new Map(resume.features), areaTotal: resume.areaTotal,
        startedAt: Date.now(), prevElapsed: resume.prevElapsed || 0, consecErrors: 0, phase: 'descarga', dense: resume.dense || {},
      };
      // Lo que estaba como fallido vuelve a la cola: se descuenta de lo cubierto.
      for (const n of resume.failed) st.stats.areaDone -= n.size * n.size;
    } else {
      const opts = msg.opts;
      st = {
        key: msg.key, label: msg.label, mode: msg.mode, opts, areaGeo: msg.area, area: buildArea(msg.area),
        queue: [], failed: [], features: new Map(), consecErrors: 0, phase: 'descarga', dense: {},
        stats: { tilesDone: 0, splits: 0, errors: 0, queries: 0, areaDone: 0 },
        startedAt: Date.now(), prevElapsed: 0,
      };
      const G = opts.rootTile, buf = opts.bufferM;
      const [x0, y0, x1, y1] = st.area.bbox;
      for (let x = x0 - buf; x < x1 + buf; x += G) for (let y = y0 - buf; y < y1 + buf; y += G) {
        if (boxNearArea(st.area, [x, y, x + G, y + G], buf)) st.queue.push({ x, y, size: G, tries: 0 });
      }
      st.areaTotal = st.queue.length * G * G;
      // Centro primero: los resultados parciales son útiles antes.
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      st.queue.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
    }
    st.prevElapsedAtStart = st.prevElapsed;
    post('started', { label: st.label, tiles: st.queue.length, resumed: !!resume, features: st.features.size });
    await sweep();
    await saveCheckpoint(true);
    if (cancelled) { post('cancelled', {}); return; }
    if (st.opts.verifyPoints > 0) await verify();
    if (cancelled) { post('cancelled', {}); return; }
    const res = finalize();
    const elapsed = (Date.now() - st.startedAt) / 1000 + st.prevElapsed;
    post('done', {
      label: st.label, mode: st.mode, features: res.features,
      summary: Object.assign(res.summary, {
        consultas: st.stats.queries, cuadros: st.stats.tilesDone, divisiones: st.stats.splits, errores: st.stats.errors,
        cuadros_fallidos: st.failed.length, segundos: Math.round(elapsed),
        verificacion: st.verify || null, opciones: st.opts,
      }),
    });
    if (!st.failed.length) await clearCheckpoint();
  }

  self.onmessage = async (ev) => {
    const m = ev.data;
    try {
      if (m.cmd === 'start') await run(m, null);
      else if (m.cmd === 'pause') { paused = true; if (st) { progress(); saveCheckpoint(true); } }
      else if (m.cmd === 'resume') { paused = false; if (st) { st.cooldowns = 0; st.coolingUntil = 0; st.recent = []; progress(); } }
      else if (m.cmd === 'cancel') { cancelled = true; }
      else if (m.cmd === 'snapshot') {
        const out = [];
        if (st) for (const [id, f] of st.features) out.push({ type: 'Feature', id, properties: Object.assign({}, f.properties, { _siri_id: id }), geometry: f.geometry });
        post('snapshot', { features: out });
      } else if (m.cmd === 'checkpoint-info') {
        const c = await loadCheckpoint();
        post('checkpoint-info', c ? { exists: true, label: c.label, features: c.features.length, savedAt: c.savedAt } : { exists: false });
      } else if (m.cmd === 'resume-checkpoint') {
        const c = await loadCheckpoint();
        if (c) await run(null, c); else post('warn', { message: 'No hay extracción guardada.' });
      } else if (m.cmd === 'discard-checkpoint') { await clearCheckpoint(); post('checkpoint-info', { exists: false }); }
    } catch (e) {
      post('error', { message: String((e && e.message) || e) });
    }
  };
}
