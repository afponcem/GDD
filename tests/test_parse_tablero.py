"""Test del parser contra un workbook sintético que reproduce el layout real
de las hojas "Resumen Semanal" / "Resumen Cump YTD" (ver
.claude/skills/indicadores-sharepoint/SKILL.md para el detalle del formato).

No depende del archivo real de ACHS ni de credenciales de SharePoint —
corre en CI en cada push.
"""
import sys
from pathlib import Path

import openpyxl

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from parse_tablero import parse_summary_sheet, slugify  # noqa: E402


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

    # marcador TERRITORIO + 1 territorio
    ws.cell(row=10, column=2, value="TERRITORIO")
    ws.cell(row=11, column=1, value="GRTR1020")
    ws.cell(row=11, column=2, value="TERRITORIO NORTE")
    ws.cell(row=11, column=4, value=1.1)
    ws.cell(row=11, column=5, value=4)

    # marcador SUBGERENCIA + 2 subgerencias bajo NORTE
    ws.cell(row=13, column=2, value="SUBGERENCIA")
    ws.cell(row=14, column=1, value="SGRG0003")
    ws.cell(row=14, column=2, value="NORTE")
    ws.cell(row=14, column=3, value="ARICA Y TARAPACA")
    ws.cell(row=14, column=4, value=0.8)
    ws.cell(row=14, column=5, value=2)

    ws.cell(row=15, column=1, value="SGRG0001")
    # col B vacía: forward-fill del territorio corto "NORTE"
    ws.cell(row=15, column=3, value="ANTOFAGASTA")
    ws.cell(row=15, column=4, value="-")  # sin dato -> se omite
    ws.cell(row=15, column=5, value=0)

    # marcador AGENCIAS: todo lo que sigue debe ignorarse
    ws.cell(row=17, column=2, value="AGENCIAS")
    ws.cell(row=18, column=1, value="IQUIQUE")
    ws.cell(row=18, column=4, value=99)

    return ws


def test_parses_hierarchy_and_values():
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    ws = build_fixture_sheet(wb, "Resumen Semanal")

    tree, indicators = parse_summary_sheet(ws)

    assert indicators["captacion_total"]["label"] == "CAPTACIÓN TOTAL"
    assert indicators["captacion_total"]["meta"] == 1
    assert indicators["accidentes_vista_de_gestion"]["meta"] == "(Valor Real)"

    assert tree["code"] == "TOTAL RED ACHS"
    assert tree["values"]["captacion_total"] == 0.95

    assert len(tree["children"]) == 1
    territorio = tree["children"][0]
    assert territorio["code"] == "GRTR1020"
    assert territorio["level"] == "territorio"

    assert len(territorio["children"]) == 2
    sub1, sub2 = territorio["children"]
    assert sub1["code"] == "SGRG0003"
    assert sub1["name"] == "ARICA Y TARAPACA"
    assert sub1["values"]["captacion_total"] == 0.8

    assert sub2["code"] == "SGRG0001"
    assert sub2["name"] == "ANTOFAGASTA"
    # "-" se omite del dict de valores (no se guarda como 0 ni como string)
    assert "captacion_total" not in sub2["values"]
    assert sub2["values"]["accidentes_vista_de_gestion"] == 0

    # nivel AGENCIAS y más allá no se parsea
    all_codes = [tree["code"]] + [
        c["code"] for t in tree["children"] for c in [t] + t["children"]
    ]
    assert "IQUIQUE" not in all_codes


def test_slugify_handles_accents_and_punctuation():
    assert slugify("CAPTACIÓN TOTAL") == "captacion_total"
    assert slugify("Accidentes (vista de gestión)") == "accidentes_vista_de_gestion"
    assert slugify("  Cobertura RC (M+)  ") == "cobertura_rc_m"


if __name__ == "__main__":
    test_parses_hierarchy_and_values()
    test_slugify_handles_accents_and_punctuation()
    print("OK: todos los tests pasaron")
