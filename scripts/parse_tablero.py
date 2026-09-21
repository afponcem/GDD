#!/usr/bin/env python3
"""Parsea el Tablero de Indicadores GDD (xlsx) a un JSON consumido por el sitio.

Lee dos hojas con formato "jerárquico" idéntico:
  - "Resumen Semanal"   -> snapshot de la semana actual, por Territorio/Subgerencia
  - "Resumen Cump YTD"  -> snapshot acumulado del año, por Territorio/Subgerencia

Estructura de esas hojas (fija, ver .claude/skills/indicadores-sharepoint/SKILL.md
si esto cambia en el archivo fuente):
  fila 3: nombre de columna "sucio" (con sufijo de periodo, ej. "CAPTACIÓN TOTALS2")
  fila 4: nombre de columna canónico (ej. "CAPTACIÓN TOTAL")  <- se usa para la key
  fila 5: "Fecha Corte ->" + fecha por indicador
  fila 6: "Exigencia ->"   + meta por indicador
  fila 8: fila TOTAL RED ACHS (col A/B = código/nombre, resto = valores)
  marcador "TERRITORIO" en col B, luego filas de territorio (col A=código, col B=nombre)
  marcador "SUBGERENCIA" en col B, luego filas de subgerencia:
      col A = código, col B = nombre corto de territorio (solo en la 1a fila del grupo),
      col C = nombre de la subgerencia
  marcador "AGENCIAS" en col B -> fin de lo que parseamos (nivel persona en adelante)
"""
import json
import re
import sys
import unicodedata
from datetime import date, datetime, time, timezone
from pathlib import Path

import openpyxl

SHEET_CONFIGS = {
    "weekly": "Resumen Semanal",
    "ytd": "Resumen Cump YTD",
}

# Col B en las filas de SUBGERENCIA solo trae el nombre corto del territorio
# (NORTE / METRO / SUR). Se mapea al código de territorio real de la hoja.
TERRITORIO_SHORT_NAME_MAP = {
    "NORTE": "TERRITORIO NORTE",
    "METRO": "TERRITORIO METROPOLITANO",
    "SUR": "TERRITORIO SUR",
}

HEADER_ROW_DIRTY = 3
HEADER_ROW_CANON = 4
FECHA_CORTE_ROW = 5
EXIGENCIA_ROW = 6
DATA_START_ROW = 8
FIRST_INDICATOR_COL = 4  # columna D


def slugify(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    text = text.strip().lower()
    text = re.sub(r"[^a-z0-9]+", "_", text)
    return text.strip("_")


def cell_to_jsonable(value):
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, (date, time)):
        return value.isoformat()
    return value


def read_indicators(ws):
    """Devuelve {col_index: {"key":..., "label":..., "meta":..., "fecha_corte":...}}."""
    indicators = {}
    for col in range(FIRST_INDICATOR_COL, ws.max_column + 1):
        canon = ws.cell(row=HEADER_ROW_CANON, column=col).value
        if not canon:
            continue
        key = slugify(str(canon))
        if not key:
            continue
        indicators[col] = {
            "key": key,
            "label": str(canon).strip(),
            "meta": cell_to_jsonable(ws.cell(row=EXIGENCIA_ROW, column=col).value),
            "fecha_corte": cell_to_jsonable(ws.cell(row=FECHA_CORTE_ROW, column=col).value),
        }
    return indicators


def read_values(ws, row, indicators):
    values = {}
    for col, meta in indicators.items():
        v = ws.cell(row=row, column=col).value
        if v == "-" or v is None:
            continue
        values[meta["key"]] = cell_to_jsonable(v)
    return values


def parse_summary_sheet(ws):
    indicators = read_indicators(ws)

    total_code = str(ws.cell(row=DATA_START_ROW, column=1).value or "TOTAL_RED_ACHS").strip()
    total_name = str(ws.cell(row=DATA_START_ROW, column=2).value or "TOTAL RED ACHS").strip()

    tree = {
        "code": total_code,
        "name": total_name,
        "level": "total",
        "values": read_values(ws, DATA_START_ROW, indicators),
        "children": [],
    }
    territorios_by_short_name = {}
    subgerencias_by_code = {}

    def resolve_territorio(short_name):
        full_name = TERRITORIO_SHORT_NAME_MAP.get(short_name, short_name)
        return territorios_by_short_name.get(full_name)

    section = None
    current_territorio_short = None
    current_subgerencia = None  # solo usado dentro de la sección JEFATURA
    row = DATA_START_ROW + 1
    while row <= ws.max_row:
        col_a = ws.cell(row=row, column=1).value
        col_b = ws.cell(row=row, column=2).value
        col_c = ws.cell(row=row, column=3).value

        if col_a is None and col_b in ("TERRITORIO", "SUBGERENCIA", "AGENCIAS", "JEFATURA"):
            section = col_b
            current_territorio_short = None
            current_subgerencia = None
            row += 1
            continue

        if section == "TERRITORIO" and col_a:
            node = {
                "code": str(col_a).strip(),
                "name": str(col_b).strip() if col_b else str(col_a).strip(),
                "level": "territorio",
                "values": read_values(ws, row, indicators),
                "children": [],
            }
            tree["children"].append(node)
            territorios_by_short_name[node["name"]] = node

        elif section == "SUBGERENCIA" and col_a:
            if col_b:
                current_territorio_short = str(col_b).strip()
            parent = resolve_territorio(current_territorio_short)
            node = {
                "code": str(col_a).strip(),
                "name": str(col_c).strip() if col_c else str(col_a).strip(),
                "level": "subgerencia",
                "values": read_values(ws, row, indicators),
                "children": [],
            }
            subgerencias_by_code[node["code"]] = node
            if parent is not None:
                parent["children"].append(node)
            else:
                tree["children"].append(node)  # fallback si no calzó el territorio

        elif section == "AGENCIAS" and col_a:
            # La hoja solo liga Agencia -> Territorio, no da el código de
            # Subgerencia intermedio, así que la agencia cuelga directo del
            # territorio (no se puede anidar bajo Subgerencia sin inventar
            # el vínculo).
            if col_b:
                current_territorio_short = str(col_b).strip()
            parent = resolve_territorio(current_territorio_short)
            node = {
                "code": str(col_a).strip(),
                "name": str(col_c).strip() if col_c else str(col_a).strip(),
                "level": "agencia",
                "values": read_values(ws, row, indicators),
                "children": [],
            }
            if parent is not None:
                parent["children"].append(node)
            else:
                tree["children"].append(node)

        elif section == "JEFATURA" and col_a:
            if col_b:
                new_territorio_short = str(col_b).strip()
                if new_territorio_short != current_territorio_short:
                    # Arranca un nuevo grupo de territorio: la subgerencia
                    # "actual" heredada del territorio anterior ya no aplica.
                    current_subgerencia = None
                current_territorio_short = new_territorio_short
            code = str(col_a).strip()
            name = str(col_c).strip() if col_c else code
            candidate_subgerencia = subgerencias_by_code.get(code)
            if candidate_subgerencia is not None and candidate_subgerencia["name"] == name:
                # Esta fila repite el código/nombre/valor de Subgerencia como
                # encabezado de grupo dentro de JEFATURA (no es una persona);
                # marca el contexto para las filas de jefatura que siguen.
                current_subgerencia = candidate_subgerencia
            else:
                parent = current_subgerencia or resolve_territorio(current_territorio_short)
                node = {
                    "code": code,
                    "name": name,
                    "level": "jefatura",
                    "values": read_values(ws, row, indicators),
                    "children": [],
                }
                if parent is not None:
                    parent["children"].append(node)
                else:
                    tree["children"].append(node)

        row += 1

    indicator_catalog = {
        meta["key"]: {"label": meta["label"], "meta": meta["meta"], "fecha_corte": meta["fecha_corte"]}
        for meta in indicators.values()
    }
    return tree, indicator_catalog


def parse_workbook(xlsx_path: Path) -> dict:
    wb = openpyxl.load_workbook(xlsx_path, data_only=True)

    result = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_file": xlsx_path.name,
    }
    for out_key, sheet_name in SHEET_CONFIGS.items():
        if sheet_name not in wb.sheetnames:
            raise KeyError(f"No se encontró la hoja '{sheet_name}' en {xlsx_path}")
        tree, indicators = parse_summary_sheet(wb[sheet_name])
        result[out_key] = {"hierarchy": tree, "indicators": indicators}

    return result


def main():
    if len(sys.argv) != 3:
        print(f"Uso: {sys.argv[0]} <archivo.xlsx> <salida.json>", file=sys.stderr)
        sys.exit(1)

    xlsx_path = Path(sys.argv[1])
    out_path = Path(sys.argv[2])

    data = parse_workbook(xlsx_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"OK: {out_path} ({out_path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
