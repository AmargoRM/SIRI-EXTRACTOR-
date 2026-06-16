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


## Archivos grandes y .gitignore

No se recomienda subir límites cantonales grandes al repositorio. Los archivos `.geojson`, `.gpkg`, `.zip` y shapefiles deben colocarse localmente dentro de `inputs/`. La carpeta `inputs/` se mantiene en Git gracias a `inputs/.gitkeep`.

Los resultados se generan localmente en `outputs/`, los checkpoints se generan localmente en `checkpoints/` y los logs se generan localmente en `logs/`. Estos archivos están ignorados para evitar problemas con el límite de tamaño de GitHub.

Si se usa GitHub Codespaces, se puede arrastrar el archivo grande directamente a `inputs/`, ejecutarlo ahí y no hacer commit de ese archivo.

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
