/* SIRI Extractor Web: interfaz (mapa, selección, progreso, descargas). */
(function () {
  'use strict';

  // ---------- Proyecciones ----------
  proj4.defs('EPSG:5367', '+proj=tmerc +lat_0=0 +lon_0=-84 +k=0.9999 +x_0=500000 +y_0=0 +ellps=WGS84 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');
  // Ocotepeque 1935 / Costa Rica Norte. Transformación de datum: EPSG "(1)", exactitud ~8 m.
  proj4.defs('EPSG:5456', '+proj=lcc +lat_1=10.46666666666667 +lat_0=10.46666666666667 +lon_0=-84.33333333333333 +k_0=0.99995696 +x_0=500000 +y_0=271820.522 +ellps=clrk66 +towgs84=213.11,9.37,-74.95,0,0,0,0 +units=m +no_defs');
  const CRS_LABEL = { 'EPSG:5456': 'Lambert Norte', 'EPSG:5367': 'CRTM05', 'EPSG:4326': 'WGS84' };

  const $ = (id) => document.getElementById(id);
  const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('es-CR'));
  const fmtTime = (s) => {
    if (s == null || !isFinite(s)) return '—';
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return h ? h + ' h ' + String(m).padStart(2, '0') + ' min' : m + ':' + String(x).padStart(2, '0');
  };
  const slug = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase();

  // ---------- Datos de límites ----------
  const CANT = window.SIRI_CANTONES.features;
  const DIST = window.SIRI_DISTRITOS.features;
  const provincias = Array.from(new Set(CANT.map((f) => f.properties.provincia))).sort((a, b) => a.localeCompare(b, 'es'));

  let mode = 'canton';
  let selected = null;      // Feature elegido
  let result = null;        // { features, summary, label, mode }
  let runningNow = false;

  // ---------- Mapa ----------
  const map = L.map('map', { preferCanvas: true }).setView([9.93, -84.1], 8);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap',
  }).addTo(map);
  const siriWms = L.tileLayer.wms('https://geop8.siri.snitcr.go.cr/GeoP/geoprox2?s=390c80aJivoGEOSIRI', {
    layers: 'catastro', format: 'image/png', transparent: true, version: '1.1.1', minZoom: 15, maxZoom: 21, attribution: 'Catastro: SIRI/SNIT',
  });
  L.control.layers(null, { 'Catastro SIRI (zoom ≥ 15)': siriWms }, { collapsed: true }).addTo(map);
  siriWms.addTo(map);

  const css = getComputedStyle(document.documentElement);
  const colArea = () => css.getPropertyValue('--area').trim() || '#1864ab';
  const colSel = () => css.getPropertyValue('--sel').trim() || '#d9480f';

  let boundsLayer = null;
  let selLayer = null;
  let parcelsLayer = null;

  function drawBoundaries() {
    if (boundsLayer) map.removeLayer(boundsLayer);
    const feats = mode === 'canton' ? CANT : DIST;
    boundsLayer = L.geoJSON({ type: 'FeatureCollection', features: feats }, {
      style: () => ({ color: colArea(), weight: mode === 'canton' ? 1.2 : 0.8, fillOpacity: 0.04, fillColor: colArea() }),
      onEachFeature: (f, layer) => {
        const p = f.properties;
        layer.bindTooltip(mode === 'canton' ? p.canton + ' (' + p.provincia + ')' : p.distrito + ' · ' + p.canton, { sticky: true });
        layer.on('click', () => { if (!runningNow) selectFeature(f, true); });
      },
    }).addTo(map);
    if (selLayer) selLayer.bringToFront();
  }

  // ---------- Selectores ----------
  function fillSelect(sel, values, placeholder) {
    sel.innerHTML = '';
    const o = document.createElement('option');
    o.value = ''; o.textContent = placeholder; sel.appendChild(o);
    for (const v of values) { const x = document.createElement('option'); x.value = v; x.textContent = v; sel.appendChild(x); }
  }
  fillSelect($('selProv'), provincias, '— Provincia —');
  fillSelect($('selCant'), [], '— Cantón —');
  fillSelect($('selDist'), [], '— Distrito —');

  $('selProv').onchange = () => {
    const p = $('selProv').value;
    fillSelect($('selCant'), CANT.filter((f) => f.properties.provincia === p).map((f) => f.properties.canton), '— Cantón —');
    fillSelect($('selDist'), [], '— Distrito —');
    clearSelection();
  };
  $('selCant').onchange = () => {
    const p = $('selProv').value, c = $('selCant').value;
    if (mode === 'canton') {
      const f = CANT.find((x) => x.properties.provincia === p && x.properties.canton === c);
      if (f) selectFeature(f, false); else clearSelection();
    } else {
      fillSelect($('selDist'), DIST.filter((f) => f.properties.provincia === p && f.properties.canton === c).map((f) => f.properties.distrito), '— Distrito —');
      clearSelection();
      const f = CANT.find((x) => x.properties.provincia === p && x.properties.canton === c);
      if (f) map.fitBounds(L.geoJSON(f).getBounds());
    }
  };
  $('selDist').onchange = () => {
    const p = $('selProv').value, c = $('selCant').value, d = $('selDist').value;
    const f = DIST.find((x) => x.properties.provincia === p && x.properties.canton === c && x.properties.distrito === d);
    if (f) selectFeature(f, false); else clearSelection();
  };

  document.querySelectorAll('#modeSeg button').forEach((b) => {
    b.onclick = () => {
      if (runningNow) return;
      mode = b.dataset.mode;
      document.querySelectorAll('#modeSeg button').forEach((x) => x.classList.toggle('on', x === b));
      $('distWrap').classList.toggle('hidden', mode !== 'distrito');
      clearSelection();
      $('selCant').onchange();
      drawBoundaries();
    };
  });

  function areaKm2(feature) {
    const polys = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    let a = 0;
    for (const poly of polys) poly.forEach((ring, i) => {
      const pts = ring.map((c) => proj4('EPSG:4326', 'EPSG:5367', c));
      let s = 0;
      for (let k = 0, j = pts.length - 1; k < pts.length; j = k++) s += pts[j][0] * pts[k][1] - pts[k][0] * pts[j][1];
      a += (i === 0 ? 1 : -1) * Math.abs(s / 2);
    });
    return a / 1e6;
  }

  function clearSelection() {
    selected = null;
    if (selLayer) { map.removeLayer(selLayer); selLayer = null; }
    $('selCard').classList.add('hidden');
    $('btnStart').disabled = true;
  }

  function selectFeature(f, fromMap) {
    selected = f;
    const p = f.properties;
    if (fromMap) {
      $('selProv').value = p.provincia;
      fillSelect($('selCant'), CANT.filter((x) => x.properties.provincia === p.provincia).map((x) => x.properties.canton), '— Cantón —');
      $('selCant').value = p.canton;
      if (mode === 'distrito') {
        fillSelect($('selDist'), DIST.filter((x) => x.properties.provincia === p.provincia && x.properties.canton === p.canton).map((x) => x.properties.distrito), '— Distrito —');
        $('selDist').value = p.distrito;
      }
    }
    if (selLayer) map.removeLayer(selLayer);
    selLayer = L.geoJSON(f, { style: { color: colSel(), weight: 3, fillOpacity: 0.08, fillColor: colSel() }, interactive: false }).addTo(map);
    map.fitBounds(selLayer.getBounds(), { padding: [20, 20] });
    const km2 = areaKm2(f);
    $('selName').textContent = mode === 'canton' ? 'Cantón ' + p.canton : 'Distrito ' + p.distrito;
    $('selInfo').textContent = (mode === 'canton' ? p.provincia : p.canton + ', ' + p.provincia) + ' · ' + km2.toLocaleString('es-CR', { maximumFractionDigits: 1 }) + ' km² · ' + guessTime(km2);
    $('selCard').classList.remove('hidden');
    $('btnStart').disabled = runningNow;
  }

  // Estimación grosera, solo orientativa.
  function guessTime(km2) {
    if (km2 < 5) return 'estimado: minutos';
    if (km2 < 50) return 'estimado: 10 min a 1 h';
    if (km2 < 300) return 'estimado: 1 a 3 h';
    return 'estimado: varias horas (zona grande)';
  }

  // ---------- Worker ----------
  const workerUrl = URL.createObjectURL(new Blob(['(' + siriWorkerMain.toString() + ')();'], { type: 'application/javascript' }));
  const worker = new Worker(workerUrl);
  let partialCb = null;

  worker.onmessage = (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'started':
        showMsg(m.resumed ? 'ok' : null, m.resumed ? 'Reanudando "' + m.label + '" con ' + fmt(m.features) + ' fincas ya descargadas.' : '');
        break;
      case 'progress': onProgress(m); break;
      case 'checkpoint': $('progBox').dataset.ck = m.savedAt; break;
      case 'recovered': showMsg('ok', 'El servidor volvió a responder; la extracción continúa.'); break;
      case 'warn': showMsg('warn', m.message); if (/en pausa/.test(m.message)) $('btnPause').textContent = 'Reanudar'; break;
      case 'error': showMsg('err', 'Error: ' + m.message); setRunning(false); break;
      case 'cancelled':
        setRunning(false);
        showMsg('warn', 'Extracción detenida. El avance quedó guardado: podés reanudarla luego o descargar lo parcial.');
        checkResume();
        break;
      case 'done': onDone(m); break;
      case 'checkpoint-info': onCheckpointInfo(m); break;
      case 'snapshot': if (partialCb) { partialCb(m.features); partialCb = null; } break;
    }
  };

  function readOpts() {
    const num = (id, d) => { const v = parseFloat($(id).value); return isFinite(v) ? v : d; };
    return {
      concurrency: Math.max(1, Math.min(6, Math.round(num('optConc', 3)))),
      rootTile: 1000, minTile: 60, noSplitBelow: 250, maxPerTile: 990,
      bufferM: Math.max(0, num('optBuffer', 300)),
      timeoutMs: 75000, maxTries: 4,
      verifyPoints: Math.max(0, Math.round(num('optVerify', 100))),
      filter: $('optFilter').value,
    };
  }

  function currentLabel() {
    const p = selected.properties;
    return mode === 'canton' ? 'Cantón ' + p.canton + ' (' + p.provincia + ')' : 'Distrito ' + p.distrito + ', ' + p.canton + ' (' + p.provincia + ')';
  }

  $('btnStart').onclick = () => {
    if (!selected) return;
    result = null;
    if (parcelsLayer) { map.removeLayer(parcelsLayer); parcelsLayer = null; }
    $('sumBox').classList.add('hidden');
    $('resumeBox').classList.add('hidden');
    setRunning(true);
    const label = currentLabel();
    worker.postMessage({
      cmd: 'start', key: slug(label), label, mode,
      area: { type: 'Feature', properties: selected.properties, geometry: selected.geometry },
      opts: readOpts(),
    });
    runMeta = { label, mode, props: selected.properties, startedAt: new Date() };
  };
  let runMeta = null;

  $('btnPause').onclick = () => {
    const pausing = $('btnPause').textContent === 'Pausar';
    worker.postMessage({ cmd: pausing ? 'pause' : 'resume' });
    $('btnPause').textContent = pausing ? 'Reanudar' : 'Pausar';
  };
  $('btnCancel').onclick = () => {
    if (confirm('¿Detener la extracción? El avance queda guardado en este navegador para reanudar después.')) worker.postMessage({ cmd: 'cancel' });
  };

  function setRunning(on) {
    runningNow = on;
    $('btnStart').disabled = on || !selected;
    $('btnPause').disabled = !on;
    $('btnCancel').disabled = !on;
    $('btnPartial').disabled = !on;
    $('btnPause').textContent = 'Pausar';
    ['selProv', 'selCant', 'selDist', 'optFilter', 'optConc', 'optBuffer', 'optVerify'].forEach((id) => { $(id).disabled = on; });
    if (on) { $('progBox').classList.remove('hidden'); showMsg(null, ''); }
    document.title = on ? 'Extrayendo… · SIRI Extractor Web' : 'SIRI Extractor Web';
  }

  const PHASE = { descarga: 'Descargando fincas', 'verificación': 'Verificando', preparando: 'Preparando resultado' };
  function onProgress(m) {
    $('pPhase').textContent = (PHASE[m.phase] || m.phase) + (m.paused ? ' (en pausa)' : '');
    let frac = 0;
    if (m.phase === 'descarga') {
      frac = m.frac || 0;
      $('pPhaseSub').textContent = fmt(m.tilesDone) + ' cuadros listos, ' + fmt(m.tilesPending) + ' pendientes' +
        (m.inFlight ? ' · esperando al servidor (' + m.inFlight + ' en curso)' : '');
      $('pEta').textContent = fmtTime(m.etaSec);
    } else if (m.phase === 'verificación' && m.verify) {
      frac = m.verify.checked / Math.max(1, m.verify.total);
      $('pPhaseSub').textContent = fmt(m.verify.checked) + ' de ' + fmt(m.verify.total) + ' puntos';
      $('pEta').textContent = '—';
    } else { frac = 1; $('pPhaseSub').textContent = ''; }
    $('pBar').style.width = (100 * frac).toFixed(1) + '%';
    $('pFeat').textContent = fmt(m.features);
    $('pQ').textContent = fmt(m.queries);
    $('pErr').textContent = fmt(m.errors) + (m.failed ? ' (' + m.failed + ' cuadros fallidos)' : '');
    $('pSplit').textContent = fmt(m.splits);
    $('pTime').textContent = fmtTime(m.elapsed);
    document.title = Math.round(100 * frac) + '% ' + (PHASE[m.phase] || '') + ' · SIRI';
  }

  function onDone(m) {
    setRunning(false);
    result = { features: m.features, summary: m.summary, label: m.label, mode: m.mode, finishedAt: new Date() };
    $('pBar').style.width = '100%';
    $('pPhase').textContent = 'Listo';
    $('pPhaseSub').textContent = '';
    $('btnGeo').disabled = false;
    $('btnXls').disabled = false;
    renderSummary();
    drawParcels(m.features);
    const v = m.summary.verificacion;
    if (m.summary.cuadros_fallidos > 0) showMsg('warn', m.summary.cuadros_fallidos + ' cuadros no respondieron tras varios intentos (servidor saturado): puede faltar alguna finca ahí. Usá "Reintentar cuadros fallidos" arriba; se agregan a lo ya descargado.');
    else if (v && v.con_finca && v.encontradas < v.con_finca) showMsg('warn', 'La verificación encontró ' + (v.con_finca - v.encontradas) + ' punto(s) con fincas que no se descargaron. Revisá el resumen del Excel.');
    else showMsg('ok', 'Extracción terminada: ' + fmt(m.features.length) + ' fincas listas para descargar.');
    checkResume();
  }

  function renderSummary() {
    const s = result.summary, v = s.verificacion;
    const rows = [
      ['Zona', result.label],
      ['Fincas exportadas', fmt(s.fincas_exportadas)],
      ['Fincas descargadas (con vecinas)', fmt(s.fincas_descargadas)],
      ['Código catastral de la zona', s.codigo_dominante || '—'],
      ['Consultas al servidor', fmt(s.consultas)],
      ['Tiempo', fmtTime(s.segundos)],
    ];
    if (v) rows.push(['Verificación', v.con_finca ? v.encontradas + ' de ' + v.con_finca + ' puntos ya estaban (' + (100 * v.encontradas / v.con_finca).toFixed(1) + '%)' : (v.sin_respuesta ? 'el servidor no respondió' : 'sin datos')]);
    const box = $('sumBox');
    box.innerHTML = '<table class="kv">' + rows.map((r) => '<tr><td>' + r[0] + '</td><td>' + escapeHtml(String(r[1])) + '</td></tr>').join('') + '</table>';
    box.classList.remove('hidden');
  }
  const escapeHtml = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function drawParcels(features) {
    if (parcelsLayer) map.removeLayer(parcelsLayer);
    if (features.length > 150000) return; // demasiadas para dibujar con fluidez
    const renderer = L.canvas({ padding: 0.3 });
    parcelsLayer = L.geoJSON({ type: 'FeatureCollection', features }, {
      renderer,
      style: () => ({ color: colSel(), weight: 0.6, fillOpacity: 0.12, fillColor: colSel() }),
      onEachFeature: (f, layer) => {
        const p = f.properties;
        layer.bindPopup('<b>Finca ' + escapeHtml(String(p.finca || '—')) + '</b><br>Identificador: ' + escapeHtml(String(p.identifica || '—')) +
          '<br>Plano: ' + escapeHtml(String(p.plano || '—')) + '<br>Área: ' + fmt(Math.round(p._area_calc_m2)) + ' m²');
      },
    }).addTo(map);
  }

  // ---------- Descargas ----------
  function reproject(features, crs) {
    if (crs === 'EPSG:4326') return features;
    const tr = proj4('EPSG:4326', crs);
    const mapC = (c) => (typeof c[0] === 'number' ? tr.forward(c).map((v) => Math.round(v * 1000) / 1000) : c.map(mapC));
    return features.map((f) => ({ type: 'Feature', id: f.id, properties: f.properties, geometry: { type: f.geometry.type, coordinates: mapC(f.geometry.coordinates) } }));
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})/, '$1_');

  function geojsonBlob(features, crs, extra) {
    const fc = { type: 'FeatureCollection', name: 'predios_siri' };
    if (crs !== 'EPSG:4326') fc.crs = { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::' + crs.split(':')[1] } };
    Object.assign(fc, extra || {});
    fc.features = reproject(features, crs);
    return new Blob([JSON.stringify(fc)], { type: 'application/geo+json' });
  }

  $('btnGeo').onclick = () => {
    if (!result) return;
    const crs = $('optCrs').value;
    download(geojsonBlob(result.features, crs), 'siri_' + slug(result.label) + '_' + CRS_LABEL[crs].replace(/ /g, '_') + '_' + stamp() + '.geojson');
  };

  $('btnPartial').onclick = () => {
    partialCb = (features) => {
      const crs = $('optCrs').value;
      download(geojsonBlob(features, crs), 'siri_parcial_' + slug(runMeta ? runMeta.label : 'zona') + '_' + stamp() + '.geojson');
    };
    worker.postMessage({ cmd: 'snapshot' });
  };

  const PRIORITY = ['identifica', 'finca', 'plano', 'provincia', 'canton', 'distrito', 'di_zona', 'predio', 'bloque', 'parcela',
    'horizontal', 'duplicado', 'compatible', 'relacion', 'shape_area', '_area_calc_m2', 'created_us', 'created_da', 'last_edite', 'last_edi_1'];

  $('btnXls').onclick = () => {
    if (!result) return;
    const btn = $('btnXls');
    btn.disabled = true; btn.textContent = 'Generando…';
    setTimeout(() => {
      try { buildExcel(); } catch (e) { showMsg('err', 'No se pudo generar el Excel: ' + e.message); }
      btn.disabled = false; btn.textContent = 'Excel';
    }, 30);
  };

  function buildExcel() {
    const crs = $('optCrs').value;
    const tr = crs === 'EPSG:4326' ? null : proj4('EPSG:4326', crs);
    const keys = [];
    const seen = new Set();
    for (const k of PRIORITY) { seen.add(k); keys.push(k); }
    for (const f of result.features) for (const k of Object.keys(f.properties)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
    const xName = crs === 'EPSG:4326' ? 'punto_lon' : 'punto_x_' + crs.split(':')[1];
    const yName = crs === 'EPSG:4326' ? 'punto_lat' : 'punto_y_' + crs.split(':')[1];
    const rows = result.features.map((f) => {
      const p = f.properties;
      const o = {};
      for (const k of keys) { if (k in p) o[k] = p[k]; }
      const lonlat = [p._punto_lon, p._punto_lat];
      const xy = tr ? tr.forward(lonlat) : lonlat;
      o[xName] = tr ? Math.round(xy[0] * 100) / 100 : xy[0];
      o[yName] = tr ? Math.round(xy[1] * 100) / 100 : xy[1];
      return o;
    });
    const header = keys.filter((k) => rows.some((r) => k in r)).concat([xName, yName]);
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows, { header });
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: header.length - 1 } }) };
    ws['!cols'] = header.map((h) => ({ wch: Math.max(10, Math.min(22, h.length + 2)) }));
    XLSX.utils.book_append_sheet(wb, ws, 'predios');

    const s = result.summary, v = s.verificacion || {};
    const meta = [
      ['Zona', result.label],
      ['Fecha de extracción', result.finishedAt.toLocaleString('es-CR')],
      ['Fuente', 'SIRI/SNIT · WMS GetMap en KML vectorial · capa catastro_detallado'],
      ['Fincas exportadas', s.fincas_exportadas],
      ['Fincas descargadas (con vecinas)', s.fincas_descargadas],
      ['Filtro aplicado', { codigo: 'Código catastral dominante de la zona', geometria: 'Punto interior dentro del límite', todo: 'Sin filtro' }[s.opciones.filter]],
      ['Código catastral dominante (prov-cantón[-distrito])', s.codigo_dominante || ''],
      ['Fincas con el código dominante', s.fincas_por_codigo],
      ['Fincas con punto dentro del límite dibujado', s.fincas_por_geometria],
      ['Consultas al servidor', s.consultas],
      ['Cuadros descargados', s.cuadros],
      ['Divisiones de cuadros', s.divisiones],
      ['Errores (reintentados o divididos)', s.errores],
      ['Cuadros fallidos', s.cuadros_fallidos],
      ['Verificación: puntos con finca', v.con_finca != null ? v.con_finca : ''],
      ['Verificación: ya encontradas', v.encontradas != null ? v.encontradas : ''],
      ['Verificación: ids no encontrados', (v.ids_faltantes || []).join(', ')],
      ['Duración (s)', s.segundos],
      ['Sistema de coordenadas de punto_x/punto_y', crs],
      ['Nota', 'Columnas que empiezan con "_" las calcula esta herramienta; el resto vienen tal cual del SIRI.'],
      ['Nota', 'Límites de cantón/distrito del mapa: geoBoundaries (aproximados). La pertenencia oficial es el código catastral de cada finca.'],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Campo', 'Valor']].concat(meta)), 'resumen');

    const dict = [
      ['Campo', 'Descripción'],
      ['identifica', 'Identificador catastral del predio (provincia+cantón+distrito+finca+derecho)'],
      ['finca', 'Número de finca en el Registro Inmobiliario'],
      ['plano', 'Número de plano catastrado asociado'],
      ['provincia / canton / distrito', 'Códigos de la división territorial administrativa'],
      ['di_zona', 'Código de distrito completo (provincia+cantón+distrito)'],
      ['bloque / predio / parcela', 'Ubicación dentro del mapa catastral'],
      ['horizontal', 'Indicador de propiedad horizontal (condominio)'],
      ['duplicado', 'Indicador de duplicidad registral'],
      ['incons_XX / modifica_X', 'Indicadores de inconsistencias y modificaciones del levantamiento catastral (0/1)'],
      ['shape_area / shape_leng', 'Área y perímetro según el SIRI'],
      ['created_us / created_da / last_edite / last_edi_1', 'Usuario y fecha de creación / última edición del polígono'],
      ['_siri_id', 'Identificador interno del objeto en el servicio'],
      ['id_origen', 'Campo "id" original del SIRI (renombrado para que QGIS no lo confunda con el identificador)'],
      ['_area_calc_m2', 'Área calculada por esta herramienta (m²)'],
      ['_punto_lon / _punto_lat', 'Punto interior del predio en WGS84'],
      ['_codigo_coincide', 'VERDADERO si el código catastral coincide con la zona elegida'],
      ['_punto_en_poligono', 'VERDADERO si el punto interior cae dentro del límite dibujado'],
      [xName + ' / ' + yName, 'Punto interior en ' + crs],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dict), 'diccionario');
    XLSX.writeFile(wb, 'siri_' + slug(result.label) + '_' + stamp() + '.xlsx', { compression: true });
  }

  // ---------- Reanudar ----------
  function checkResume() { worker.postMessage({ cmd: 'checkpoint-info' }); }
  function onCheckpointInfo(m) {
    const box = $('resumeBox');
    if (!m.exists || runningNow) { box.classList.add('hidden'); return; }
    box.innerHTML = (result && result.summary.cuadros_fallidos ? 'Quedaron cuadros sin descargar en ' : 'Hay una extracción sin terminar: ') + '<b>' + escapeHtml(m.label) + '</b> (' + fmt(m.features) + ' fincas, guardada ' +
      new Date(m.savedAt).toLocaleString('es-CR') + ').<div class="btns"><button class="b primary" id="btnResumeCk">' + (result && result.summary.cuadros_fallidos ? 'Reintentar cuadros fallidos' : 'Reanudar') + '</button>' +
      '<button class="b" id="btnDiscardCk">Descartar</button></div>';
    box.classList.remove('hidden');
    $('btnResumeCk').onclick = () => {
      box.classList.add('hidden');
      runMeta = { label: m.label };
      setRunning(true);
      worker.postMessage({ cmd: 'resume-checkpoint' });
    };
    $('btnDiscardCk').onclick = () => {
      if (confirm('¿Borrar la extracción guardada? No se puede deshacer.')) worker.postMessage({ cmd: 'discard-checkpoint' });
    };
  }

  function showMsg(kind, text) {
    const b = $('msgBox');
    b.innerHTML = '';
    if (!kind || !text) return;
    const d = document.createElement('div');
    d.className = 'msg ' + kind; d.textContent = text;
    b.appendChild(d);
  }

  window.addEventListener('beforeunload', (e) => { if (runningNow) { e.preventDefault(); e.returnValue = ''; } });

  drawBoundaries();
  checkResume();
})();
