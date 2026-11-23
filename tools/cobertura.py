"""Mide qué cantones tienen fincas en el catastro SIRI y genera web/data/cobertura.js.

Uso (necesita acceso a geop8.siri.snitcr.go.cr):
    python tools/cobertura.py            # 30 puntos por cantón
    python tools/cobertura.py --puntos 50

Para cada cantón toma puntos al azar dentro del límite y pregunta al SIRI (GetFeatureInfo,
una consulta a la vez, con pausa) si hay una finca en cada punto.
  - sin_datos: ningún punto con finca (y respondieron al menos 2/3 de los puntos)
  - parcial:   menos del 25 % de los puntos con finca
  - ok:        el resto
"""
import argparse, json, math, random, re, time
from pathlib import Path
import requests
from shapely.geometry import shape, Point

ROOT = Path(__file__).resolve().parents[1]
URL = ('https://geop8.siri.snitcr.go.cr/GeoP/geoprox2?s=390c80aJivoGEOSIRI&SERVICE=WMS&VERSION=1.1.1'
       '&REQUEST=GetFeatureInfo&LAYERS=catastro_detallado&QUERY_LAYERS=catastro_detallado&STYLES=&SRS=EPSG:3857'
       '&WIDTH=5&HEIGHT=5&X=2&Y=2&INFO_FORMAT=application/json&FEATURE_COUNT=1&BBOX={}')


def merc(lon, lat):
    r = 6378137
    return math.radians(lon) * r, math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * r


def hay_finca(lon, lat, s):
    x, y = merc(lon, lat)
    for intento in range(3):
        try:
            r = s.get(URL.format(f'{x-2:.2f},{y-2:.2f},{x+2:.2f},{y+2:.2f}'), timeout=30)
            r.raise_for_status()
            t = r.text.strip()
            return bool(t) and bool(json.loads(t).get('features'))
        except Exception:
            time.sleep(3 * (intento + 1))
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--puntos', type=int, default=30)
    ap.add_argument('--pausa', type=float, default=0.4)
    a = ap.parse_args()
    txt = (ROOT / 'web/data/cantones.js').read_text(encoding='utf-8')
    fc = json.loads(re.sub(r'^\s*window\.SIRI_CANTONES\s*=\s*', '', txt).rstrip().rstrip(';'))
    s = requests.Session()
    out, filas = {}, []
    for f in fc['features']:
        p = f['properties']
        g = shape(f['geometry'])
        x0, y0, x1, y1 = g.bounds
        pts = []
        while len(pts) < a.puntos:
            q = Point(random.uniform(x0, x1), random.uniform(y0, y1))
            if g.contains(q):
                pts.append(q)
        resp = con = 0
        for q in pts:
            r = hay_finca(q.x, q.y, s)
            time.sleep(a.pausa)
            if r is None:
                continue
            resp += 1
            con += r
        pct = 100 * con / resp if resp else None
        if resp < a.puntos * 2 / 3:
            estado = 'ok'  # sin respuesta suficiente: no se bloquea
        elif con == 0:
            estado = 'sin_datos'
        elif pct < 25:
            estado = 'parcial'
        else:
            estado = 'ok'
        out[f"{p['provincia']}|{p['canton']}"] = {'estado': estado, 'pct': None if pct is None else round(pct)}
        filas.append(f"{p['provincia']},{p['canton']},{a.puntos},{resp},{con},{estado}")
        print(filas[-1], flush=True)
    js = ('/* Cobertura del catastro SIRI por cantón. Generado con tools/cobertura.py; no editar a mano.\n'
          ' * estado: "ok", "parcial" (fincas solo en parte), "sin_datos" (no se puede elegir en la página). */\n'
          'window.SIRI_COBERTURA = ' + json.dumps({'generado': time.strftime('%Y-%m-%d'), 'cantones': out},
                                                  ensure_ascii=False, indent=1) + ';\n')
    (ROOT / 'web/data/cobertura.js').write_text(js, encoding='utf-8')
    (ROOT / 'tools/cobertura.csv').write_text('provincia,canton,puntos,respondieron,con_finca,estado\n' + '\n'.join(filas) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
