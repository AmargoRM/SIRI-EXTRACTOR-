#!/usr/bin/env python3
"""Version 1 SIRI EXTRACTOR CLI.

Herramienta de consola para extraer predios por cantón mediante WMS
GetFeatureInfo del SIRI/SNIT. No usa QGIS, PyQt, WFS ni autenticación.
"""

from __future__ import annotations

import hashlib
import json
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

import geopandas as gpd
import requests
from pyproj import CRS
from shapely.geometry import box, shape
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union
from tqdm import tqdm

WMS_VERSION = "1.1.1"
WMS_SRS = "EPSG:3857"
OUTPUT_DIR = Path("outputs")
CHECKPOINT_DIR = Path("checkpoints")
INPUT_DIR = Path("inputs")
LOG_DIR = Path("logs")
WIDTH = 256
HEIGHT = 256

FeatureMap = dict[str, dict[str, Any]]
BBox = tuple[float, float, float, float]


def ensure_project_dirs() -> None:
    """Crea la estructura de carpetas de trabajo si no existe."""
    for folder in (OUTPUT_DIR, CHECKPOINT_DIR, INPUT_DIR, LOG_DIR):
        folder.mkdir(parents=True, exist_ok=True)


def load_config(path: str | Path = "config.json") -> dict[str, Any]:
    """Lee config.json y devuelve su contenido como diccionario."""
    config_path = Path(path)
    if not config_path.exists():
        raise FileNotFoundError("No existe config.json en la raíz del proyecto.")
    with config_path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def validate_config(config: dict[str, Any]) -> None:
    """Valida parámetros críticos antes de iniciar una extracción larga."""
    if config.get("mode") != "canton":
        raise ValueError("Por ahora solo se soporta mode='canton'.")

    input_file = Path(config["area"]["input_file"])
    if not input_file.exists():
        raise FileNotFoundError(f"No existe el archivo de límite cantonal: {input_file}")

    CRS.from_user_input(config["output"]["output_crs"])
    missing_crs = config["area"].get("input_crs_if_missing")
    if missing_crs:
        CRS.from_user_input(missing_crs)

    sampling = config["sampling"]
    if sampling["tile_size_m"] <= 0:
        raise ValueError("tile_size_m debe ser mayor que 0.")
    if sampling["grid_size"] < 2:
        raise ValueError("grid_size debe ser mayor o igual que 2.")
    if sampling["passes"] < 1:
        raise ValueError("passes debe ser mayor o igual que 1.")
    if sampling["sleep_seconds"] < 0:
        raise ValueError("sleep_seconds debe ser mayor o igual que 0.")
    max_queries = sampling.get("max_queries")
    if max_queries is not None and (not isinstance(max_queries, int) or max_queries <= 0):
        raise ValueError("max_queries debe ser null o un entero positivo.")
    if sampling.get("checkpoint_every", 0) <= 0:
        raise ValueError("checkpoint_every debe ser un entero positivo.")

    resume = config.get("resume_from_checkpoint")
    if resume is not None and not Path(resume).exists():
        raise FileNotFoundError(f"No existe resume_from_checkpoint: {resume}")


def load_canton_geometry(config: dict[str, Any]) -> tuple[BaseGeometry, str]:
    """Carga, filtra y une el límite cantonal indicado por el usuario."""
    area = config["area"]
    input_path = Path(area["input_file"])
    path_for_gpd = f"zip://{input_path}" if input_path.suffix.lower() == ".zip" else str(input_path)
    gdf = gpd.read_file(path_for_gpd)
    if gdf.empty:
        raise ValueError("El archivo de límite cantonal no contiene geometrías.")

    if gdf.crs is None:
        if not area.get("input_crs_if_missing"):
            raise ValueError("El límite no tiene CRS y input_crs_if_missing está vacío.")
        gdf = gdf.set_crs(area["input_crs_if_missing"])
    input_crs = str(gdf.crs)

    name_field = area.get("name_field")
    name_value = area.get("name_value")
    if name_field is not None and name_value is not None:
        if name_field not in gdf.columns:
            raise ValueError(f"El campo '{name_field}' no existe en el límite cantonal.")
        gdf = gdf[gdf[name_field].astype(str) == str(name_value)]
        if gdf.empty:
            raise ValueError("El filtro name_field/name_value no dejó geometrías.")

    gdf = gdf[gdf.geometry.notna()].copy()
    gdf["geometry"] = gdf.geometry.apply(lambda geom: geom if geom.is_valid else geom.buffer(0))
    return unary_union(gdf.geometry), input_crs


def transform_bbox(geom: BaseGeometry, from_crs: str, to_crs: str = WMS_SRS) -> tuple[BBox, BaseGeometry]:
    """Reproyecta una geometría y devuelve su BBOX."""
    gdf = gpd.GeoDataFrame(geometry=[geom], crs=from_crs).to_crs(to_crs)
    projected = gdf.geometry.iloc[0]
    return projected.bounds, projected


def split_bbox(bbox: BBox, tile_size_m: float) -> list[BBox]:
    """Divide un BBOX en cuadros internos del tamaño indicado."""
    minx, miny, maxx, maxy = bbox
    bboxes: list[BBox] = []
    x = minx
    while x < maxx:
        y = miny
        x2 = min(x + tile_size_m, maxx)
        while y < maxy:
            y2 = min(y + tile_size_m, maxy)
            bboxes.append((x, y, x2, y2))
            y += tile_size_m
        x += tile_size_m
    return bboxes


def bbox_intersects_canton(bbox: BBox, canton_geom_3857: BaseGeometry) -> bool:
    """Indica si un cuadro de consulta intersecta el cantón."""
    return box(*bbox).intersects(canton_geom_3857)


def build_sample_points(grid_size: int, passes: int) -> list[tuple[int, int, int]]:
    """Genera puntos X/Y de píxel para GetFeatureInfo con pasadas desplazadas."""
    points: list[tuple[int, int, int]] = []
    cell_w = WIDTH / grid_size
    cell_h = HEIGHT / grid_size
    for pass_index in range(passes):
        # Pasadas posteriores se desplazan media celda para reducir vacíos.
        shift = (pass_index % 2) * 0.5
        for row in range(grid_size):
            for col in range(grid_size):
                x = int(min(max((col + 0.5 + shift) * cell_w, 0), WIDTH - 1))
                y = int(min(max((row + 0.5 + shift) * cell_h, 0), HEIGHT - 1))
                points.append((x, y, pass_index + 1))
    return points


def request_getfeatureinfo(
    session: requests.Session,
    config: dict[str, Any],
    bbox: BBox,
    xpix: int,
    ypix: int,
) -> tuple[list[dict[str, Any]], Optional[str]]:
    """Ejecuta una consulta WMS GetFeatureInfo y normaliza errores recuperables."""
    service = config["service"]
    safety = config["safety"]
    params = {
        "s": service["service_key"],
        "SERVICE": "WMS",
        "VERSION": WMS_VERSION,
        "REQUEST": "GetFeatureInfo",
        "LAYERS": service["layer_name"],
        "QUERY_LAYERS": service["layer_name"],
        "STYLES": "",
        "SRS": WMS_SRS,
        "BBOX": ",".join(f"{value:.8f}" for value in bbox),
        "WIDTH": WIDTH,
        "HEIGHT": HEIGHT,
        "X": xpix,
        "Y": ypix,
        "INFO_FORMAT": "application/json",
    }
    for attempt in range(safety["retry_attempts"] + 1):
        try:
            response = session.get(service["base_url"], params=params, timeout=safety["timeout_seconds"])
            response.raise_for_status()
            if not response.text.strip():
                return [], None
            try:
                payload = response.json()
            except ValueError:
                return [], "respuesta no JSON"
            return payload.get("features", []) or [], None
        except requests.RequestException as exc:
            if attempt >= safety["retry_attempts"]:
                return [], str(exc)
            time.sleep(safety["retry_sleep_seconds"])
    return [], "error desconocido"


def feature_unique_id(feature: dict[str, Any]) -> Optional[str]:
    """Deduplica por identifica, finca, plano, id y finalmente hash geométrico."""
    props = feature.get("properties") or {}
    for key in ("identifica", "finca", "plano"):
        value = props.get(key)
        if value not in (None, ""):
            return f"{key}:{value}"
    if feature.get("id") not in (None, ""):
        return f"id:{feature['id']}"
    geometry = feature.get("geometry")
    if geometry:
        payload = json.dumps(geometry, sort_keys=True, ensure_ascii=False)
        return "geom:" + hashlib.sha1(payload.encode("utf-8")).hexdigest()
    return None


def _features_to_gdf(features_by_id: FeatureMap, crs: str = WMS_SRS) -> gpd.GeoDataFrame:
    """Convierte el acumulado GeoJSON-like a GeoDataFrame, omitiendo geometrías malas."""
    records: list[dict[str, Any]] = []
    geometries: list[BaseGeometry] = []
    for unique_id, feature in features_by_id.items():
        try:
            geom = shape(feature.get("geometry"))
            if geom.is_empty:
                continue
            if not geom.is_valid:
                geom = geom.buffer(0)
            properties = dict(feature.get("properties") or {})
            properties["_siri_uid"] = unique_id
            records.append(properties)
            geometries.append(geom)
        except Exception:
            continue
    return gpd.GeoDataFrame(records, geometry=geometries, crs=crs)


def save_features(
    features_by_id: FeatureMap,
    output_path: Path,
    output_crs: str,
    canton_geom: Optional[BaseGeometry] = None,
    export_gpkg: bool = False,
) -> int:
    """Guarda features a GeoJSON y opcionalmente GeoPackage. Devuelve cantidad final."""
    gdf = _features_to_gdf(features_by_id)
    if gdf.empty:
        empty = gpd.GeoDataFrame(geometry=[], crs=output_crs)
        empty.to_file(output_path, driver="GeoJSON")
        return 0
    gdf = gdf.to_crs(output_crs)
    if canton_geom is not None:
        canton_gdf = gpd.GeoDataFrame(geometry=[canton_geom], crs=output_crs)
        gdf = gpd.clip(gdf, canton_gdf)
    gdf.to_file(output_path, driver="GeoJSON")
    if export_gpkg:
        gpkg_path = output_path.with_suffix(".gpkg")
        gdf.to_file(gpkg_path, driver="GPKG", layer="predios")
    return len(gdf)


def save_checkpoint(
    features_by_id: FeatureMap,
    path: str | Path,
    output_crs: str,
    canton_geom: Optional[BaseGeometry] = None,
) -> None:
    """Guarda lo acumulado como GeoJSON parcial utilizable."""
    save_features(features_by_id, Path(path), output_crs, canton_geom=canton_geom, export_gpkg=False)


def load_checkpoint(path: str | Path) -> FeatureMap:
    """Carga un GeoJSON de checkpoint para continuar deduplicando."""
    gdf = gpd.read_file(path)
    if gdf.empty:
        return {}
    gdf = gdf.to_crs(WMS_SRS)
    features: FeatureMap = {}
    for feature in json.loads(gdf.to_json()).get("features", []):
        uid = feature.get("properties", {}).get("_siri_uid") or feature_unique_id(feature)
        if uid:
            features[uid] = feature
    return features


def write_summary_log(summary: dict[str, Any], path: Path = LOG_DIR / "resumen_extraccion.txt") -> None:
    """Escribe un resumen legible de la corrida."""
    lines = ["Version 1 SIRI EXTRACTOR CLI", "=" * 32]
    for key, value in summary.items():
        lines.append(f"{key}: {value}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    ensure_project_dirs()
    config = load_config()
    validate_config(config)

    canton_geom, input_crs = load_canton_geometry(config)
    bbox_3857, canton_3857 = transform_bbox(canton_geom, input_crs, WMS_SRS)
    output_crs = config["output"]["output_crs"]
    canton_output = gpd.GeoDataFrame(geometry=[canton_geom], crs=input_crs).to_crs(output_crs).geometry.iloc[0]

    all_bboxes = split_bbox(bbox_3857, config["sampling"]["tile_size_m"])
    valid_bboxes = [candidate for candidate in all_bboxes if bbox_intersects_canton(candidate, canton_3857)]
    sample_points = build_sample_points(config["sampling"]["grid_size"], config["sampling"]["passes"])
    total_possible = len(valid_bboxes) * len(sample_points)
    max_queries = config["sampling"].get("max_queries")
    progress_total = min(total_possible, max_queries) if max_queries else total_possible

    features_by_id: FeatureMap = {}
    if config.get("resume_from_checkpoint"):
        features_by_id.update(load_checkpoint(config["resume_from_checkpoint"]))

    executed = 0
    errors = 0
    consecutive_errors = 0
    stop = False
    session = requests.Session()
    output_name = config["output"]["output_name"]
    checkpoint_path = CHECKPOINT_DIR / f"checkpoint_{Path(output_name).stem}.geojson"

    try:
        with tqdm(total=progress_total, unit="consulta", desc="Extrayendo") as bar:
            for bbox_index, bbox in enumerate(valid_bboxes, start=1):
                for xpix, ypix, pass_number in sample_points:
                    if max_queries is not None and executed >= max_queries:
                        stop = True
                        break
                    results, error = request_getfeatureinfo(session, config, bbox, xpix, ypix)
                    executed += 1
                    if error:
                        errors += 1
                        consecutive_errors += 1
                    else:
                        consecutive_errors = 0
                        for feature in results:
                            uid = feature_unique_id(feature)
                            if uid:
                                features_by_id.setdefault(uid, feature)

                    if executed % config["sampling"]["checkpoint_every"] == 0:
                        save_checkpoint(features_by_id, checkpoint_path, output_crs, canton_geom=None)

                    bar.update(1)
                    bar.set_postfix({
                        "predios": len(features_by_id),
                        "errores": errors,
                        "bbox": f"{bbox_index}/{len(valid_bboxes)}",
                        "pasada": pass_number,
                    })
                    if consecutive_errors >= config["safety"]["max_consecutive_errors"]:
                        raise RuntimeError("Se alcanzó max_consecutive_errors; se detiene por seguridad.")
                    time.sleep(config["sampling"]["sleep_seconds"])
                if stop:
                    break
    except KeyboardInterrupt:
        print("\nInterrumpido por el usuario. Guardando checkpoint utilizable...", file=sys.stderr)
    finally:
        save_checkpoint(features_by_id, checkpoint_path, output_crs, canton_geom=None)

    before_clip = len(_features_to_gdf(features_by_id))
    final_path = OUTPUT_DIR / output_name
    clip_geom = canton_output if config["output"].get("clip_to_canton", True) else None
    final_count = save_features(
        features_by_id,
        final_path,
        output_crs,
        canton_geom=clip_geom,
        export_gpkg=config["output"].get("also_export_gpkg", False),
    )

    summary = {
        "fecha_hora": datetime.now().isoformat(timespec="seconds"),
        "archivo_entrada": config["area"]["input_file"],
        "crs_entrada": input_crs,
        "crs_salida": output_crs,
        "bbox_consultados": len(valid_bboxes),
        "consultas_totales": total_possible,
        "consultas_ejecutadas": executed,
        "predios_unicos_antes_recorte": before_clip,
        "predios_finales_despues_recorte": final_count,
        "errores": errors,
        "parametros_usados": json.dumps(config, ensure_ascii=False),
        "ruta_salida": str(final_path),
        "ruta_checkpoint": str(checkpoint_path),
    }
    write_summary_log(summary)

    print("\nResumen final")
    print("-------------")
    for key, value in summary.items():
        print(f"{key}: {value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
