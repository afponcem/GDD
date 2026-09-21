"""Test del parser contra un workbook sintético que reproduce el layout real
de las hojas "Resumen Semanal" / "Resumen Cump YTD" + la hoja cruda "YTD"
(ver .claude/skills/indicadores-sharepoint/SKILL.md para el detalle del
formato, en particular la semántica de "marcador de cierre" en JEFATURA).

No depende del archivo real de ACHS ni de credenciales de SharePoint —
corre en CI en cada push.
"""
import sys
from pathlib import Path

import openpyxl

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from parse_tablero import (  # noqa: E402
    build_jefatura_agencia_tags,
    nest_agencias,
    parse_summary_sheet,
    slugify,
)


def build_fixture_sheet(wb, name):
    ws = wb.create_sheet(name)

    # fila 3/4: nombre sucio / nombre canónico
    ws.cell(row=3, column=4, value="CAPTACIÓN TOTALS2")
    ws.cell(row=4, column=4, value="CAPTACIÓN TOTAL")
    ws.cell(row=3, column=5, value="Accidentes (vista de gestión)S2")
    ws.cell(row=4, column=5, value="Accidentes (vista de gestión)")

    # fila 5/6: fecha de corte / exigencia
    ws.cell(row=5, column=4, value="2026-01-05")
    ws.cell(row=6, column=4, value=1)
    ws.cell(row=5, column=5, value="2026-01-05")
    ws.cell(row=6, column=5, value="(Valor Real)")

    # fila 8: TOTAL
    ws.cell(row=8, column=1, value="TOTAL RED ACHS")
    ws.cell(row=8, column=2, value="TOTAL RED ACHS")
    ws.cell(row=8, column=4, value=0.95)
    ws.cell(row=8, column=5, value=10)

    # marcador TERRITORIO + 2 territorios
    ws.cell(row=10, column=2, value="TERRITORIO")
    ws.cell(row=11, column=1, value="GRTR1020")
    ws.cell(row=11, column=2, value="TERRITORIO NORTE")
    ws.cell(row=11, column=4, value=1.1)
    ws.cell(row=11, column=5, value=4)

    ws.cell(row=12, column=1, value="GRTR1010")
    ws.cell(row=12, column=2, value="TERRITORIO METROPOLITANO")
    ws.cell(row=12, column=4, value=1.2)
    ws.cell(row=12, column=5, value=5)

    # marcador SUBGERENCIA + 2 subgerencias bajo NORTE, 1 bajo METRO
    ws.cell(row=14, column=2, value="SUBGERENCIA")
    ws.cell(row=15, column=1, value="SGRG0003")
    ws.cell(row=15, column=2, value="NORTE")
    ws.cell(row=15, column=3, value="ARICA Y TARAPACA")
    ws.cell(row=15, column=4, value=0.8)
    ws.cell(row=15, column=5, value=2)

    ws.cell(row=16, column=1, value="SGRG0001")
    ws.cell(row=16, column=3, value="ANTOFAGASTA")
    ws.cell(row=16, column=4, value="-")  # sin dato -> se omite
    ws.cell(row=16, column=5, value=0)

    ws.cell(row=17, column=1, value="SGRG0011")
    ws.cell(row=17, column=2, value="METRO")
    ws.cell(row=17, column=3, value="METRO NORTE")
    ws.cell(row=17, column=4, value=0.9)
    ws.cell(row=17, column=5, value=1)

    # marcador AGENCIAS: 2 agencias, ambas bajo NORTE (Territorio, no Subgerencia)
    ws.cell(row=19, column=2, value="AGENCIAS")
    ws.cell(row=20, column=1, value="IQUIQUE")
    ws.cell(row=20, column=2, value="NORTE")
    ws.cell(row=20, column=3, value="IQUIQUE")
    ws.cell(row=20, column=4, value=0.99)

    ws.cell(row=21, column=1, value="ARICA")
    ws.cell(row=21, column=3, value="ARICA")
    ws.cell(row=21, column=4, value=0.5)

    # marcador JEFATURA. Semántica de CIERRE: la fila que repite
    # código+nombre de una Subgerencia/Territorio ya visto cierra (no abre)
    # el grupo de personas acumulado desde el marcador anterior.
    #   - JECPX001, JECPX002 quedan cerrados por SGRG0003 -> ARICA Y TARAPACA
    #   - JECPX003 queda cerrado por GRTR1010 -> directo bajo TERRITORIO
    #     METROPOLITANO (regresión: no debe heredar la subgerencia de NORTE)
    ws.cell(row=23, column=2, value="JEFATURA")
    ws.cell(row=24, column=1, value="JECPX001")
    ws.cell(row=24, column=2, value="NORTE")
    ws.cell(row=24, column=3, value="PERSONA UNO")
    ws.cell(row=24, column=4, value=0.6)

    ws.cell(row=25, column=1, value="JECPX002")
    ws.cell(row=25, column=3, value="PERSONA DOS")
    ws.cell(row=25, column=4, value=0.7)

    ws.cell(row=26, column=1, value="SGRG0003")
    ws.cell(row=26, column=3, value="ARICA Y TARAPACA")  # cierra {JECPX001, JECPX002}
    ws.cell(row=26, column=4, value=0.8)  # repite el valor de la subgerencia

    ws.cell(row=27, column=1, value="GRTR1020")
    ws.cell(row=27, column=3, value="TERRITORIO NORTE")  # cierra el resto de NORTE (nada pendiente)

    ws.cell(row=28, column=1, value="JECPX003")
    ws.cell(row=28, column=2, value="METRO")
    ws.cell(row=28, column=3, value="PERSONA TRES")
    ws.cell(row=28, column=4, value=0.65)

    ws.cell(row=29, column=1, value="GRTR1010")
    ws.cell(row=29, column=3, value="TERRITORIO METROPOLITANO")  # cierra {JECPX003} directo bajo el territorio

    return ws


def build_raw_ytd_sheet(wb):
    """Hoja cruda "YTD": liga cada persona a su agencia vía columnas D/F/H.
    Solo se necesitan filas con label "CUMP" (u otra) que traigan el tag en
    col F; el resto del layout real no se reproduce."""
    ws = wb.create_sheet("YTD")
    ws.cell(row=1, column=4, value="JECPX001")
    ws.cell(row=1, column=6, value="IQUIQUE")
    ws.cell(row=1, column=8, value="CUMP")

    ws.cell(row=2, column=4, value="JECPX002")
    ws.cell(row=2, column=6, value="ARICA")
    ws.cell(row=2, column=8, value="CUMP")

    # JECPX003 no tiene tag de agencia -> debe quedar sin agrupar (passthrough)
    return ws


def test_parses_hierarchy_with_closing_markers_and_agencias():
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    ws = build_fixture_sheet(wb, "Resumen Semanal")
    build_raw_ytd_sheet(wb)

    tree, indicators, agencias_by_name = parse_summary_sheet(ws)

    assert indicators["captacion_total"]["label"] == "CAPTACIÓN TOTAL"
    assert indicators["accidentes_vista_de_gestion"]["meta"] == "(Valor Real)"

    assert tree["values"]["captacion_total"] == 0.95
    assert len(tree["children"]) == 2
    territorio_norte, territorio_metro = tree["children"]
    assert territorio_norte["code"] == "GRTR1020"
    assert territorio_metro["code"] == "GRTR1010"

    subgerencias = [c for c in territorio_norte["children"] if c["level"] == "subgerencia"]
    sub_arica = next(s for s in subgerencias if s["code"] == "SGRG0003")

    # Antes de anidar agencias: las jefaturas cierran bajo su subgerencia,
    # no bajo la que dejó el territorio anterior.
    jefaturas_arica = [c for c in sub_arica["children"] if c["level"] == "jefatura"]
    assert {j["code"] for j in jefaturas_arica} == {"JECPX001", "JECPX002"}

    jefaturas_metro = [c for c in territorio_metro["children"] if c["level"] == "jefatura"]
    assert [j["code"] for j in jefaturas_metro] == ["JECPX003"]

    assert set(agencias_by_name) == {"IQUIQUE", "ARICA"}

    # --- nest_agencias: inserta Agencia entre Subgerencia y Jefatura ---
    tags = build_jefatura_agencia_tags(wb)
    assert tags == {"JECPX001": "IQUIQUE", "JECPX002": "ARICA"}

    nest_agencias(tree, tags, agencias_by_name)

    sub_arica_children_levels = {c["level"] for c in sub_arica["children"]}
    assert sub_arica_children_levels == {"agencia"}

    ag_iquique = next(a for a in sub_arica["children"] if a["name"] == "IQUIQUE")
    assert ag_iquique["values"]["captacion_total"] == 0.99  # valores reales de la sección AGENCIAS
    assert [j["code"] for j in ag_iquique["children"]] == ["JECPX001"]

    ag_arica = next(a for a in sub_arica["children"] if a["name"] == "ARICA")
    assert ag_arica["values"]["captacion_total"] == 0.5
    assert [j["code"] for j in ag_arica["children"]] == ["JECPX002"]

    # JECPX003 no tenía tag de agencia -> sigue colgando directo del territorio
    jefaturas_metro_post = [c for c in territorio_metro["children"] if c["level"] == "jefatura"]
    assert [j["code"] for j in jefaturas_metro_post] == ["JECPX003"]


def test_slugify_handles_accents_and_punctuation():
    assert slugify("CAPTACIÓN TOTAL") == "captacion_total"
    assert slugify("Accidentes (vista de gestión)") == "accidentes_vista_de_gestion"
    assert slugify("  Cobertura RC (M+)  ") == "cobertura_rc_m"


if __name__ == "__main__":
    test_parses_hierarchy_with_closing_markers_and_agencias()
    test_slugify_handles_accents_and_punctuation()
    print("OK: todos los tests pasaron")
