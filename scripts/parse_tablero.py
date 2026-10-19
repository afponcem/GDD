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
  marcador "AGENCIAS" en col B, luego filas de agencia: col A/C = código/nombre,
      col B = nombre corto de territorio (solo en la 1a fila del grupo)
  marcador "JEFATURA" en col B, luego filas de persona. A diferencia de las
      demás secciones, acá el código/nombre de Subgerencia o Territorio que
      vuelve a aparecer (mismo código+nombre ya vistos) **cierra** el grupo
      de personas que viene ANTES, no abre el que sigue (ver el branch
      `elif section == "JEFATURA"` en parse_summary_sheet). El vínculo
      Jefatura -> Agencia no está en estas hojas en absoluto; se obtiene de
      la hoja cruda "YTD" (ver `build_jefatura_agencia_tags`).
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
RAW_YTD_SHEET = "YTD"  # hoja cruda mensual, distinta de "Resumen Cump YTD"

# Col B en las filas de SUBGERENCIA/AGENCIAS solo trae el nombre corto del
# territorio (NORTE / METRO / SUR). Se mapea al código de territorio real.
TERRITORIO_SHORT_NAME_MAP = {
    "NORTE": "TERRITORIO NORTE",
    "METRO": "TERRITORIO METROPOLITANO",
    "SUR": "TERRITORIO SUR",
}

# La hoja "Definiciones Indicadores" agrupa estos indicadores bajo el foco
# "4. Fidelización", pero en la práctica pertenecen al sub-grupo "Modelo
# Cultura y Experiencia" (MCE) y así se quieren filtrar en el sitio. Se
# aplica como override manual sobre el resultado de build_indicator_focos
# (por slug de indicador) en vez de tocar el matching automático, porque acá
# no hay ambigüedad de texto que resolver: es una reclasificación editorial.
FOCO_OVERRIDES = {
    "dialogo_diario_equipo_al_dia": "MCE (Modelo Cultura y Experiencia)",
    "confirmacion_de_procesos": "MCE (Modelo Cultura y Experiencia)",
    "uso_aoa_fisico": "MCE (Modelo Cultura y Experiencia)",
    "uso_aoa_digital_integrado": "MCE (Modelo Cultura y Experiencia)",
}

HEADER_ROW_DIRTY = 3
HEADER_ROW_CANON = 4
FECHA_CORTE_ROW = 5
EXIGENCIA_ROW = 6
DATA_START_ROW = 8
FIRST_INDICATOR_COL = 4  # columna D

# Columnas de la hoja cruda "YTD" usadas para el vínculo Jefatura -> Agencia.
RAW_YTD_CODE_COL = 4    # columna D: código de persona (o de agencia, en sus filas de rollup)
RAW_YTD_AGENCIA_COL = 6  # columna F: nombre de agencia (solo presente en alguna de las 3 filas REAL/META/CUMP de la persona)
RAW_YTD_LABEL_COL = 8    # columna H: "REAL" / "META" / "CUMP"

# La misma hoja cruda "YTD" trae, para cada indicador, una matriz de una
# columna por mes (header fila 5 = "YYYYMM", fila 3 = "CIERRE") que termina
# en una columna "<Indicador>YTD" (fila 4 = nombre canónico, fila 5 = "YTD",
# con fórmula =SUM() de todo el bloque de meses) seguida de UNA columna más
# con el avance de la semana en curso (fila 3 = "s1"/"s2"/etc, mismo mes que
# la última columna del bloque). El mes todavía no cerrado SIEMPRE aparece
# en el bloque con valor 0 en la fila TOTAL RED ACHS (su avance real vive
# aparte, en esa columna de "semana en curso") — así que basta con tomar, de
# derecha a izquierda, la primera columna del bloque con REAL != 0 para
# TOTAL RED ACHS para encontrar el último mes cerrado, sin necesidad de
# saber la fecha de hoy ni de asumir qué mes es "el actual".
RAW_YTD_ROW_TYPE_COL = 8   # columna H: "REAL" / "META" / "CUMP" (igual a RAW_YTD_LABEL_COL)
RAW_YTD_FLAT_CODE_COL = 4  # columna D: código en las filas REAL/META (no coincide con RAW_YTD_CODE_COL en la fila CUMP, que lo trae en columna C)
RAW_YTD_HEADER_LABEL_ROW = 4
RAW_YTD_HEADER_PERIOD_ROW = 5
RAW_YTD_TOTAL_ROW = 6  # fila "REAL" de TOTAL RED ACHS, usada como referencia para detectar el mes cerrado

# Columnas de "Definiciones Indicadores" usadas para el vínculo Indicador -> Foco.
DEFINICIONES_SHEET = "Definiciones Indicadores"
DEFINICIONES_FOCO_COL = 2       # columna B
DEFINICIONES_INDICADOR_COL = 3  # columna C


def slugify(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    text = text.strip().lower()
    text = re.sub(r"[^a-z0-9]+", "_", text)
    return text.strip("_")


def normalize_name(text) -> str:
    """Normaliza un nombre de agencia/entidad para poder compararlo entre
    hojas que lo escriben con o sin tilde (ej. 'PARQUE LAS AMÉRICAS' en la
    hoja cruda "YTD" vs 'PARQUE LAS AMERICAS' en Resumen Semanal)."""
    text = unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"\s+", " ", text.strip().upper())


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


def build_jefatura_agencia_tags(wb):
    """Escanea la hoja cruda "YTD" (detalle mensual por persona, NO la hoja
    "Resumen Cump YTD") y devuelve {código_persona: nombre_agencia}.

    El nombre de agencia aparece en la columna F, pero no siempre en la
    misma de las 3 filas (REAL/META/CUMP) de esa persona — a veces en la
    primera, a veces en la tercera — así que se escanean las tres y se toma
    el primer valor no vacío encontrado.
    """
    if RAW_YTD_SHEET not in wb.sheetnames:
        return {}
    ws = wb[RAW_YTD_SHEET]
    tags = {}
    for r in range(1, ws.max_row + 1):
        label = ws.cell(row=r, column=RAW_YTD_LABEL_COL).value
        if label not in ("REAL", "META", "CUMP"):
            continue
        code = ws.cell(row=r, column=RAW_YTD_CODE_COL).value
        tag = ws.cell(row=r, column=RAW_YTD_AGENCIA_COL).value
        if not code or not tag:
            continue
        tags.setdefault(str(code).strip(), str(tag).strip())
    return tags


def _find_total_red_achs_row(ws):
    """Ubica la fila REAL de "TOTAL RED ACHS" en la hoja cruda "YTD" —
    buscada en vez de asumida en una fila fija, porque esta hoja se edita a
    mano semana a semana y una fila insertada/borrada la correría."""
    for r in range(1, ws.max_row + 1):
        if ws.cell(row=r, column=RAW_YTD_ROW_TYPE_COL).value != "REAL":
            continue
        code = ws.cell(row=r, column=RAW_YTD_FLAT_CODE_COL).value
        if code and str(code).strip().upper() == "TOTAL RED ACHS":
            return r
    return RAW_YTD_TOTAL_ROW  # respaldo si no se encuentra (no debería pasar)


def _find_closed_month_blocks(ws, valid_keys):
    """Ubica, para cada indicador de la hoja cruda "YTD", la columna de su
    último mes cerrado. Devuelve {indicador_key: columna} (columna 1-based
    de openpyxl), sin incluir indicadores para los que no se pudo determinar
    un mes cerrado (ej. el primer mes del bloque, cuando ni siquiera ese
    cerró todavía).

    El header de esta hoja (fila 4) trae el nombre del indicador pegado al
    sufijo "YTD" y en mayúsculas distintas a como aparece en "Resumen
    Semanal"/"Resumen Cump YTD" (ej. "DESAFILIACIÓNYTD" acá vs
    "Desafiliación" allá) — por eso el cruce se hace slugificando ambos
    lados (quitando antes el sufijo "YTD") en vez de comparar el texto tal
    cual, y se valida contra `valid_keys` para no colar una key inventada
    por un header que calce por casualidad."""
    total_row = _find_total_red_achs_row(ws)
    closed_col_by_key = {}
    for col in range(1, ws.max_column + 1):
        label = ws.cell(row=RAW_YTD_HEADER_LABEL_ROW, column=col).value
        period = ws.cell(row=RAW_YTD_HEADER_PERIOD_ROW, column=col).value
        if not label or period != "YTD":
            continue
        key = slugify(re.sub(r"ytd$", "", str(label).strip(), flags=re.IGNORECASE))
        if key not in valid_keys:
            continue

        # El bloque de meses son las columnas contiguas a la izquierda cuyo
        # header de fila 5 es un código "YYYYMM" (entero).
        block_cols = []
        c = col - 1
        while c >= 1:
            v = ws.cell(row=RAW_YTD_HEADER_PERIOD_ROW, column=c).value
            if isinstance(v, int) and 200001 <= v <= 299912:
                block_cols.insert(0, c)
                c -= 1
            else:
                break

        for month_col in reversed(block_cols):
            total_real = ws.cell(row=total_row, column=month_col).value
            if isinstance(total_real, (int, float)) and total_real != 0:
                closed_col_by_key[key] = month_col
                break

    return closed_col_by_key


def build_closed_month_values(wb, indicator_keys):
    """Devuelve {código_entidad: {indicador_key: valor}} con el resultado
    del ÚLTIMO MES CERRADO (no el acumulado YTD, ni el avance de la semana
    en curso) para cada indicador presente en la hoja cruda "YTD".
    `indicator_keys` es el conjunto de keys ya conocidas (de "Resumen
    Semanal"/"Resumen Cump YTD"), usado para validar el cruce de nombres.

    El valor se toma de la fila CUMP (no se recalcula REAL/META a mano):
    para la mayoría de los indicadores CUMP == REAL/META, pero para otros
    —ej. Desafiliación— la planilla usa una fórmula propia del negocio
    (ahí, 2 - REAL/META, para que un REAL más bajo que la meta puntúe
    "mejor"); confiar en CUMP evita reinventar esa fórmula indicador por
    indicador y queda consistente con cómo "Resumen Semanal"/"Resumen Cump
    YTD" ya entregan la razón pre-calculada en vez de REAL/META crudos."""
    if RAW_YTD_SHEET not in wb.sheetnames:
        return {}
    ws = wb[RAW_YTD_SHEET]
    closed_col_by_key = _find_closed_month_blocks(ws, indicator_keys)
    if not closed_col_by_key:
        return {}

    results = {}
    for r in range(1, ws.max_row + 1):
        if ws.cell(row=r, column=RAW_YTD_ROW_TYPE_COL).value != "REAL":
            continue
        # META y CUMP se asumen siempre en las 2 filas siguientes a REAL —
        # se confirma leyendo sus propias etiquetas en vez de asumirlo a
        # ciegas, para no leer silenciosamente la fila de la entidad
        # siguiente si algún bloque llegara a faltarle una fila (la
        # planilla se edita a mano semana a semana).
        if ws.cell(row=r + 1, column=RAW_YTD_ROW_TYPE_COL).value != "META":
            continue
        has_cump_row = ws.cell(row=r + 2, column=RAW_YTD_ROW_TYPE_COL).value == "CUMP"
        code = ws.cell(row=r, column=RAW_YTD_FLAT_CODE_COL).value
        if not code:
            continue
        code = str(code).strip()
        entity_values = results.setdefault(code, {})
        for key, month_col in closed_col_by_key.items():
            real = ws.cell(row=r, column=month_col).value
            if not isinstance(real, (int, float)):
                continue
            meta = ws.cell(row=r + 1, column=month_col).value  # fila META, justo debajo de REAL
            if not (isinstance(meta, (int, float)) and meta != 0):
                # Indicador "(Valor Real)" sin meta numérica (ej. un conteo
                # como Accidentes CTP) — igual que en "Resumen Semanal"/
                # "Resumen Cump YTD", se guarda el valor crudo tal cual, sin
                # dividir.
                entity_values[key] = real
                continue
            if has_cump_row:
                # Hay fila CUMP para esta entidad: es la única fuente
                # confiable de la razón (puede traer una fórmula propia del
                # indicador, ver docstring). Si para este mes puntual viniera
                # vacía o no numérica, se omite en vez de recalcular
                # REAL/META a ciegas — para un indicador con fórmula
                # invertida eso daría un número con el signo de negocio al
                # revés, silenciosamente.
                cump = ws.cell(row=r + 2, column=month_col).value
                if isinstance(cump, (int, float)):
                    entity_values[key] = cump
            else:
                # Esta entidad no tiene fila CUMP en absoluto (estructura
                # distinta a REAL/META/CUMP) — no hay fórmula de negocio que
                # preferir, así que REAL/META es la mejor aproximación
                # disponible.
                entity_values[key] = real / meta

    return results


def apply_closed_month_values(tree, closed_month_by_code):
    """Agrega `values_closed_month` a cada nodo del árbol (por código), con
    lo que devuelve build_closed_month_values. Nodos sin match quedan con
    diccionario vacío — no inventa un valor para una entidad sin dato."""
    def walk(node):
        node["values_closed_month"] = closed_month_by_code.get(node["code"], {})
        for child in node.get("children", []):
            walk(child)

    walk(tree)


# NPS se calcula como un acumulado móvil de los últimos 4 meses (no como
# suma del año corrido), así que su "YTD" correcto —mientras no se rehaga el
# cálculo real del indicador— es, por definición de negocio, el mismo
# resultado del último mes cerrado: septiembre también cuenta como YTD en
# ese sentido. Son las únicas keys que se pisan así; cualquier otro
# indicador nuevo con la misma semántica (ventana móvil, no acumulado real)
# debería agregarse acá explícitamente, no asumirse.
YTD_USES_CLOSED_MONTH = {"nps"}


def apply_rolling_window_ytd_override(ytd_tree, closed_month_by_code):
    """Sobrescribe, en el árbol YTD, las keys de YTD_USES_CLOSED_MONTH con
    el valor del último mes cerrado (ver comentario arriba), por código de
    entidad. Si esa entidad no tiene valor de mes cerrado para la key,
    conserva lo que ya traía "Resumen Cump YTD" — nunca lo deja vacío por
    aplicar este override."""
    def walk(node):
        closed = closed_month_by_code.get(node["code"], {})
        for key in YTD_USES_CLOSED_MONTH:
            if key in closed:
                node["values"][key] = closed[key]
        for child in node.get("children", []):
            walk(child)

    walk(ytd_tree)


def _normalize_for_match(text) -> str:
    """Normaliza un nombre de indicador para cruzarlo entre hojas: saca el
    prefijo numérico ("05. "), tildes, y reemplaza toda la puntuación por
    espacios (a diferencia de normalize_name, que no toca la puntuación —
    acá hace falta para poder comparar substrings/palabras sueltas)."""
    text = re.sub(r"^\s*\d+\.\s*", "", str(text))
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^A-Za-z0-9]+", " ", text).upper().strip()
    return re.sub(r"\s+", " ", text)


def _singularize_tokens(norm: str) -> set:
    return {t[:-1] if len(t) > 3 and t.endswith("S") else t for t in norm.split()}


def _match_score(a_norm: str, b_norm: str):
    """Nivel de confianza del cruce entre dos nombres de indicador ya
    normalizados, de más a menos confiable: (0) igualdad exacta, (1) uno es
    substring contiguo del otro, (2) solapan casi todas las palabras (sin
    ser substring — cubre diferencias de plural/singular o puntuación
    distinta). None si no calzan de ninguna forma. El substring contiguo
    (tier 1) es clave para desambiguar casos como "Accidentes CTP" vs
    "Accidentes (vista de gestión)" que por solapamiento de palabras
    (tier 2) calzarían con cualquiera de las dos filas de Definiciones."""
    if a_norm == b_norm:
        return (0, len(b_norm))
    if a_norm in b_norm or b_norm in a_norm:
        return (1, len(b_norm))
    ta, tb = _singularize_tokens(a_norm), _singularize_tokens(b_norm)
    small, big = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
    if small and len(small & big) / len(small) >= 0.8:
        return (2, len(b_norm))
    return None


def build_indicator_focos(wb, indicator_labels):
    """Cruza la hoja "Definiciones Indicadores" (columnas Foco/Indicador) con
    los nombres canónicos de indicador de las hojas Resumen, para poder
    filtrar por Foco en el sitio.

    El texto de esa hoja no calza carácter a carácter con los nombres
    canónicos (numeración de indicador propia, singular/plural distinto,
    puntuación distinta: "Vigilancia ambiental - Agente Foco" en
    Definiciones vs "Vigilancia Ambiental (Agentes Foco)" en Resumen), así
    que el cruce usa niveles de confianza decrecientes (ver `_match_score`)
    y, entre varios candidatos del mismo nivel, se queda con el texto de
    Definiciones más largo (más específico). Un indicador que no calza con
    ninguna fila queda sin foco — no se inventa la categoría.
    """
    if DEFINICIONES_SHEET not in wb.sheetnames:
        return {}
    ws = wb[DEFINICIONES_SHEET]

    rows = []
    for r in range(1, ws.max_row + 1):
        foco = ws.cell(row=r, column=DEFINICIONES_FOCO_COL).value
        indicador = ws.cell(row=r, column=DEFINICIONES_INDICADOR_COL).value
        if not foco or not indicador:
            continue
        if str(foco).strip() == "Foco" and str(indicador).strip() == "Indicador":
            continue  # fila de encabezado, no de datos
        foco_clean = re.sub(r"^\s*\d+\.\s*", "", str(foco)).strip()
        rows.append((foco_clean, _normalize_for_match(indicador)))

    focos = {}
    for label in indicator_labels:
        label_norm = _normalize_for_match(label)
        best = None  # (tier, -largo, foco) — el mínimo gana: tier más chico,
        # y a igual tier, el texto de Definiciones más largo (más específico)
        for foco_clean, ind_norm in rows:
            score = _match_score(label_norm, ind_norm)
            if score is None:
                continue
            candidate = (score[0], -score[1], foco_clean)
            if best is None or candidate < best:
                best = candidate
        if best is not None:
            focos[slugify(label)] = best[2]
    return focos


def parse_summary_sheet(ws):
    """Parsea una hoja "Resumen ..." a (tree, indicator_catalog, agencias_by_name).

    `tree` queda anidado Total -> Territorio -> Subgerencia -> Jefatura
    (Agencia se inserta después, en `nest_agencias`, porque requiere cruzar
    con la hoja cruda "YTD"). `agencias_by_name` son los nodos de la sección
    AGENCIAS, sin colgar todavía de ningún padre, indexados por
    `normalize_name(nombre)` -> (nodo, territorio_padre).
    """
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
    territorios_by_code = {}
    subgerencias_by_code = {}
    agencias_by_name = {}

    def resolve_territorio(short_name):
        full_name = TERRITORIO_SHORT_NAME_MAP.get(short_name, short_name)
        return territorios_by_short_name.get(full_name)

    section = None
    current_territorio_short = None
    jefatura_buffer = []  # personas acumuladas hasta el próximo marcador de cierre
    row = DATA_START_ROW + 1
    while row <= ws.max_row:
        col_a = ws.cell(row=row, column=1).value
        col_b = ws.cell(row=row, column=2).value
        col_c = ws.cell(row=row, column=3).value

        if col_a is None and col_b in ("TERRITORIO", "SUBGERENCIA", "AGENCIAS", "JEFATURA"):
            section = col_b
            current_territorio_short = None
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
            territorios_by_code[node["code"]] = node

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
            if col_b:
                current_territorio_short = str(col_b).strip()
            parent = resolve_territorio(current_territorio_short)
            name = str(col_c).strip() if col_c else str(col_a).strip()
            node = {
                "code": str(col_a).strip(),
                "name": name,
                "level": "agencia",
                "values": read_values(ws, row, indicators),
                "children": [],
            }
            # No se cuelga de inmediato: `nest_agencias` decide si va bajo la
            # Subgerencia (cruzando con la hoja cruda "YTD") o, si no matchea
            # con ninguna jefatura, cae aquí como respaldo bajo el territorio.
            agencias_by_name[normalize_name(name)] = (node, parent or tree)

        elif section == "JEFATURA" and col_a:
            code = str(col_a).strip()
            name = str(col_c).strip() if col_c else code
            candidate_subgerencia = subgerencias_by_code.get(code)
            candidate_territorio = territorios_by_code.get(code)
            if candidate_subgerencia is not None and candidate_subgerencia["name"] == name:
                # Esta fila repite el código/nombre de una Subgerencia: cierra
                # (no abre) el grupo de personas acumulado desde el último
                # marcador — son las jefaturas de esa subgerencia.
                candidate_subgerencia["children"].extend(jefatura_buffer)
                jefatura_buffer = []
            elif candidate_territorio is not None and candidate_territorio["name"] == name:
                # Mismo patrón pero a nivel Territorio: cargos que no caen
                # bajo ninguna Subgerencia específica (liderazgo territorial).
                candidate_territorio["children"].extend(jefatura_buffer)
                jefatura_buffer = []
            else:
                jefatura_buffer.append({
                    "code": code,
                    "name": name,
                    "level": "jefatura",
                    "values": read_values(ws, row, indicators),
                    "children": [],
                })

        row += 1

    if jefatura_buffer:
        # No debería quedar nada sin cerrar (la hoja siempre termina con un
        # marcador de Territorio) — si pasa, mejor no perder los datos.
        tree["children"].extend(jefatura_buffer)

    indicator_catalog = {
        meta["key"]: {"label": meta["label"], "meta": meta["meta"], "fecha_corte": meta["fecha_corte"]}
        for meta in indicators.values()
    }
    return tree, indicator_catalog, agencias_by_name


def nest_agencias(tree, jefatura_tags, agencias_by_name):
    """Inserta el nivel Agencia entre Subgerencia y Jefatura, agrupando las
    jefaturas de cada subgerencia según `jefatura_tags` (código -> nombre de
    agencia, desde la hoja cruda "YTD"). Cuando el nombre de agencia calza
    con uno ya visto en la sección AGENCIAS de esta misma hoja, reusa ese
    nodo (con sus valores reales); si no calza (ej. una jefatura a cargo de
    una zona combinada tipo "ARICA-IQUIQUE" que no es una agencia individual
    de la sección AGENCIAS), crea un nodo liviano sin valores propios — la
    fila queda igual disponible para filtrar/drill-down, solo sin % de
    cumplimiento agregado a ese nivel.

    Las agencias que no calzan con ninguna jefatura (o cuyo territorio no
    tiene jefaturas parseadas) quedan como respaldo colgando directo del
    territorio, igual que antes de tener este cruce.
    """
    consumed = set()

    def group_jefaturas_by_agencia(container_node):
        """Agrupa los hijos nivel 'jefatura' de `container_node` por su tag
        de agencia; deja cualquier otro hijo (subgerencias, jefaturas sin
        tag) tal cual. Se usa tanto para los hijos de una Subgerencia como
        para los hijos directos de un Territorio (cargos que no cuelgan de
        ninguna subgerencia pero sí tienen agencia asignada en la hoja
        cruda "YTD")."""
        groups = {}
        passthrough = []
        for child in container_node["children"]:
            tag = jefatura_tags.get(child["code"]) if child["level"] == "jefatura" else None
            if not tag:
                passthrough.append(child)
                continue
            groups.setdefault(tag, []).append(child)

        new_children = passthrough
        for tag, members in groups.items():
            norm = normalize_name(tag)
            existing = agencias_by_name.get(norm)
            if existing:
                agencia_node, _parent = existing
                agencia_node["children"] = members
                new_children.append(agencia_node)
                consumed.add(norm)
            else:
                new_children.append({
                    "code": tag,
                    "name": tag,
                    "level": "agencia",
                    "values": {},
                    "children": members,
                })
        container_node["children"] = new_children

    for territorio_node in tree["children"]:
        if territorio_node["level"] != "territorio":
            continue
        for child in territorio_node["children"]:
            if child["level"] == "subgerencia":
                group_jefaturas_by_agencia(child)
        # Cargos que cuelgan directo del territorio (sin subgerencia) también
        # pueden tener agencia asignada en la hoja cruda "YTD".
        group_jefaturas_by_agencia(territorio_node)

    for norm, (agencia_node, parent_node) in agencias_by_name.items():
        if norm not in consumed:
            parent_node["children"].append(agencia_node)


def parse_workbook(xlsx_path: Path) -> dict:
    wb = openpyxl.load_workbook(xlsx_path, data_only=True)
    jefatura_tags = build_jefatura_agencia_tags(wb)

    result = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_file": xlsx_path.name,
    }
    sheets = {}
    all_labels = {}
    for out_key, sheet_name in SHEET_CONFIGS.items():
        if sheet_name not in wb.sheetnames:
            raise KeyError(f"No se encontró la hoja '{sheet_name}' en {xlsx_path}")
        tree, indicators, agencias_by_name = parse_summary_sheet(wb[sheet_name])
        nest_agencias(tree, jefatura_tags, agencias_by_name)
        sheets[out_key] = (tree, indicators)
        for key, meta in indicators.items():
            all_labels[key] = meta["label"]

    focos = build_indicator_focos(wb, all_labels.values())
    for out_key, (tree, indicators) in sheets.items():
        for key, meta in indicators.items():
            meta["foco"] = FOCO_OVERRIDES.get(key, focos.get(key))
        result[out_key] = {"hierarchy": tree, "indicators": indicators}

    # "Mes cerrado" (resultado del último mes calendario ya cerrado, ej.
    # septiembre cuando octubre recién está en curso) es DISTINTO tanto del
    # acumulado YTD como del avance de la semana en curso ("Resumen
    # Semanal"/MTD) — se calcula aparte desde la hoja cruda "YTD" y se
    # cuelga como values_closed_month en el árbol semanal (que ya trae la
    # jerarquía completa armada).
    closed_month_by_code = build_closed_month_values(wb, set(all_labels.keys()))
    apply_closed_month_values(result["weekly"]["hierarchy"], closed_month_by_code)
    apply_rolling_window_ytd_override(result["ytd"]["hierarchy"], closed_month_by_code)

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
