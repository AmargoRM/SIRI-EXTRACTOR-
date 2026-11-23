# SIRI EXTRACTOR

Este repositorio tiene dos herramientas:

1. **Página web** (`web/`, recomendada): se elige un cantón o distrito en un mapa y se descargan sus predios en GeoJSON y Excel. Corre completa en el navegador, sin instalar nada.
2. **CLI en Python** (`main.py`, versión original): extracción por muestreo de puntos. Se documenta más abajo.

## Página web (`web/`)

### Cómo abrirla

- **Publicada en GitHub Pages**: el flujo `.github/workflows/pages.yml` publica la carpeta `web/` cada vez que cambia en `main`. Hay que activarlo una sola vez en GitHub: *Settings → Pages → Build and deployment → Source: GitHub Actions*. La dirección queda como `https://<usuario>.github.io/SIRI-EXTRACTOR-/`.
- **Sin publicar**: descargar el repositorio y abrir `web/index.html` con doble clic (Chrome, Edge o Firefox).

### Uso

1. Elegir **Cantón** o **Distrito**, y luego la zona en las listas o con clic en el mapa.
2. Presionar **Iniciar extracción**. Se puede cambiar de pestaña, pero no hay que cerrarla. El avance se guarda cada minuto en el navegador; si se cierra, al volver aparece la opción **Reanudar**.
3. Al terminar, elegir el sistema de coordenadas (Lambert Norte, CRTM05 o WGS84) y descargar el **GeoJSON** o el **Excel**. Durante la extracción, **Parcial** descarga lo que lleve hasta ese momento.

### Cómo extrae

- Pide al WMS público del SIRI el mapa de cada cuadro en formato **KML vectorial** (`GetMap`, capa `catastro_detallado`, `kmscore:100`). GeoServer devuelve **todas** las fincas que tocan el cuadro, con su geometría completa y todos sus atributos.
- Empieza con cuadros de 1 km. Si el servidor no alcanza a responder un cuadro (zona urbana densa, más de 75 s) o devuelve ~1000 fincas (posible tope), ese cuadro se divide en 4 y se vuelve a pedir. Los cuadros vecinos del mismo tamaño se dividen directamente, sin volver a esperar.
- Si casi todas las respuestas recientes fallan, el problema es el servidor y no la densidad. En ese caso la página espera (1, 2 y hasta 5 minutos), reintenta sola y lo avisa en pantalla. Los cuadros que fallan 4 veces quedan anotados, y al final aparece el botón **Reintentar cuadros fallidos**.
- Al final hace una **verificación independiente**: consulta puntos al azar con `GetFeatureInfo` (el método de la CLI) y cuenta cuántas de esas fincas ya estaban descargadas.
- **Filtro de salida** (por defecto): se conservan las fincas cuyo código catastral (`provincia`-`canton`[-`distrito`]) coincide con el código predominante de la zona elegida. Los límites dibujados (geoBoundaries: cantones 2020, distritos 2017 de OpenStreetMap) son aproximados y solo sirven para elegir la zona y buscar con un margen de 300 m. No aparece el cantón de Monteverde (creado en 2021): queda dentro de Puntarenas.

### Pruebas realizadas (noviembre 2026)

En un cuadro de 200 × 200 m en Heredia centro, la "verdad" se construyó con 121 consultas `GetFeatureInfo` a 1 m/píxel: 154 fincas. El KML devolvió las 154, más 1 adicional, y con más vértices: el JSON de `GetFeatureInfo` viene simplificado. El truco de consultar un solo píxel grande se descartó: perdía entre 1 % y 40 % de las fincas, de forma impredecible.

### Tiempos

El cuello de botella es el servidor del SIRI, y su velocidad varía mucho según la hora y la carga. Como referencia, en las pruebas un cuadro urbano de 500 m (~400 fincas) tardó entre 7 s y más de 75 s. Un distrito urbano pequeño (0,6 km², 1.225 fincas) tomó unos 30 minutos en un momento de servidor lento. Un cantón grande puede tomar varias horas: conviene dejar la pestaña abierta, porque el avance se guarda solo.

### Exactitud de coordenadas

- CRTM05 (`EPSG:5367`): diferencia menor a 0,2 m respecto de PROJ/pyproj.
- Lambert Norte (`EPSG:5456`, datum Ocotepeque 1935): usa la transformación EPSG de 3 parámetros (exactitud nominal ~8 m). Difiere ~1 m de la transformación de 7 parámetros que usa QGIS por defecto. Para trabajo de precisión, conviene descargar en CRTM05 o WGS84 y reproyectar en QGIS.

### Archivos

- `web/index.html`, `web/app.js`: interfaz.
- `web/worker.js`: motor de extracción, que corre en segundo plano (Web Worker).
- `web/data/`: límites de cantones y distritos (geoBoundaries, licencias CC0 y ODbL).
- `web/lib/`: Leaflet 1.9.4, proj4 2.11.0, SheetJS 0.18.5 (copias locales).

---

# Version 1 SIRI EXTRACTOR CLI

Herramienta Python de consola para extraer predios por cantón mediante **WMS GetFeatureInfo** del SIRI/SNIT, usando un límite cantonal provisto por el usuario. La salida principal se exporta a GeoJSON en **Lambert Norte (`EPSG:5456`)** y, opcionalmente, a GeoPackage.

> Nota técnica: el repositorio esperado debía incluir `version_1_siri_extractor_v1_1.zip` como referencia del complemento QGIS. En esta copia de trabajo no se encontró ese ZIP; aun así, esta CLI implementa los parámetros del servicio confirmados en la solicitud y no depende de QGIS.

## Qué es

- Una herramienta CLI ejecutable con `python main.py`.
- Un extractor por muestreo de alta densidad sobre BBOX internos del cantón.
- Usa checkpoints periódicos para conservar salidas parciales.
- Deduplica predios por `identifica`, `finca`, `plano`, `feature.id` y, por último, hash de geometría.
- Reproyecta y exporta el resultado final al CRS configurado, por defecto `EPSG:5456`.

## Qué NO es

- No es WFS.
- No evade autenticación.
- No intenta usar servicios privados.
- No descarga tiles PNG.
- No garantiza 100% de completitud si la malla de muestreo no captura alguna finca.
- Es extracción por muestreo `GetFeatureInfo`, por lo que los parámetros de densidad importan.

## Servicio usado

La herramienta usa únicamente WMS `GetFeatureInfo` con estos parámetros base:

```text
BASE_URL = https://geop8.siri.snitcr.go.cr/GeoP/geoprox2
s = 390c80aJivoGEOSIRI
LAYERS = catastro
SERVICE = WMS
VERSION = 1.1.1
REQUEST = GetFeatureInfo
INFO_FORMAT = application/json
SRS = EPSG:3857
WIDTH = 256
HEIGHT = 256
```

## Instalación

```bash
python -m venv .venv
```

En Windows:

```bat
.venv\Scripts\activate
```

En Linux/macOS:

```bash
source .venv/bin/activate
```

Instale dependencias:

```bash
pip install -r requirements.txt
```


## Archivos grandes en `inputs/`

GitHub no permite subir archivos mayores a 25 MB desde la página web de carga. Ese límite es de GitHub y no se puede cambiar desde el código del repositorio.

Para admitir límites cantonales pesados en `inputs/`, el repositorio está preparado para usar **Git LFS** con archivos geoespaciales (`.geojson`, `.json`, `.gpkg`, `.zip` y shapefiles). Súbalos desde Git en la terminal, no desde el botón web de GitHub:

```bash
git lfs install
git add inputs/mi_limite_cantonal.zip
git commit -m "Add canton input file"
git push
```

Si el archivo ya estaba en `inputs/`, también puede verificar que Git LFS lo reconoce con:

```bash
git check-attr filter -- inputs/mi_limite_cantonal.zip
```

Debe responder `filter: lfs`. Si no tiene Git LFS instalado, instálelo antes de agregar archivos pesados. En GitHub Codespaces normalmente está disponible; en una computadora local puede requerir instalarlo desde <https://git-lfs.com/>.

Los resultados se generan localmente en `outputs/`, los checkpoints se generan localmente en `checkpoints/` y los logs se generan localmente en `logs/`. Estos archivos siguen ignorados para evitar subir salidas generadas.

## Preparar inputs

1. Coloque el límite cantonal en `inputs/`.
2. Puede ser:
   - GeoJSON (`.geojson` / `.json`)
   - GeoPackage (`.gpkg`)
   - Shapefile (`.shp` con sus archivos auxiliares)
   - ZIP de Shapefile (`.zip`)
3. Si el archivo trae varios cantones, use `name_field` y `name_value` en `config.json` para filtrar.
4. Si el archivo no trae CRS, la herramienta asigna `area.input_crs_if_missing`.

## Configuración

Edite `config.json`. Ejemplo incluido:

```json
{
  "project_name": "Version 1 SIRI EXTRACTOR CLI",
  "mode": "canton",
  "resume_from_checkpoint": null,
  "service": {
    "base_url": "https://geop8.siri.snitcr.go.cr/GeoP/geoprox2",
    "service_key": "390c80aJivoGEOSIRI",
    "layer_name": "catastro"
  },
  "area": {
    "input_file": "inputs/limite_canton.geojson",
    "name_field": null,
    "name_value": null,
    "input_crs_if_missing": "EPSG:5367"
  },
  "output": {
    "output_name": "canton_lambert_norte.geojson",
    "output_crs": "EPSG:5456",
    "also_export_gpkg": true,
    "clip_to_canton": true
  },
  "sampling": {
    "tile_size_m": 250,
    "grid_size": 8,
    "passes": 2,
    "sleep_seconds": 0.45,
    "max_queries": 1000,
    "checkpoint_every": 500
  },
  "safety": {
    "max_consecutive_errors": 50,
    "timeout_seconds": 30,
    "retry_attempts": 2,
    "retry_sleep_seconds": 2
  }
}
```

### Significado de parámetros principales

- `tile_size_m`: tamaño, en metros Web Mercator, de cada BBOX interno. Valores menores hacen más consultas y aumentan detalle.
- `grid_size`: cantidad de puntos por eje dentro del BBOX. `8` significa `8 x 8 = 64` consultas por BBOX y por pasada.
- `passes`: repite la malla con desplazamiento para reducir vacíos.
- `sleep_seconds`: pausa entre consultas para no golpear el servidor.
- `max_queries`: límite de consultas. Use `1000` para prueba y `null` para corrida completa.
- `checkpoint_every`: guarda un GeoJSON parcial cada X consultas.
- `resume_from_checkpoint`: si es `null`, inicia desde cero. Si se indica una ruta de checkpoint, carga sus predios existentes y continúa deduplicando con ellos.

## Ejecutar

```bash
python main.py
```

## Modo de prueba recomendado

Primero pruebe con:

```json
"max_queries": 1000
```

Revise el resultado en QGIS. Si se ve bien, ejecute completo con:

```json
"max_queries": null
```

## Parámetros recomendados

### Prueba rápida

```json
"tile_size_m": 500,
"grid_size": 5,
"passes": 1,
"sleep_seconds": 0.35,
"max_queries": 1000
```

### Recomendado

```json
"tile_size_m": 350,
"grid_size": 7,
"passes": 1,
"sleep_seconds": 0.40
```

### Alto detalle por cantón

```json
"tile_size_m": 250,
"grid_size": 8,
"passes": 2,
"sleep_seconds": 0.45
```

El modo de alto detalle puede tardar bastante porque multiplica BBOX, puntos de malla y pasadas.

## Checkpoints

Los checkpoints se guardan en `checkpoints/` como GeoJSON parcial en el CRS de salida. Si el proceso se interrumpe, el último checkpoint queda utilizable en QGIS y puede servir como base de reanudación mediante `resume_from_checkpoint`.

## Salidas

- `outputs/<output_name>`: GeoJSON final.
- `outputs/<output_name>.gpkg`: GeoPackage opcional si `also_export_gpkg` es `true`.
- `checkpoints/checkpoint_<output_name>.geojson`: salida parcial.
- `logs/resumen_extraccion.txt`: resumen de ejecución.

## Revisar resultados en QGIS

1. Abra QGIS.
2. Agregue el GeoJSON de `outputs/`.
3. Verifique que el CRS sea `EPSG:5456` u otro CRS configurado.
4. Compare visualmente contra el WMS de catastro.
5. Revise atributos como `identifica`, `finca` o `plano` si vienen en la respuesta del servicio.

## Si quedan vacíos

- Repita solo el sector problemático con `tile_size_m = 250`, `grid_size = 8`, `passes = 2`.
- Use un BBOX o límite menor para concentrar consultas.
- Compare contra el WMS original para verificar si el vacío corresponde a falta de captura por muestreo.
- Aumente `passes` o reduzca `tile_size_m`, sabiendo que tardará más.

## Robustez implementada

La CLI tolera respuestas vacías, `text/plain`, HTML, timeouts, errores HTTP temporales, geometrías inválidas individuales, predios sin `identifica`, archivos con varias geometrías y archivos sin CRS cuando `input_crs_if_missing` está definido.
