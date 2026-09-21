#!/usr/bin/env python3
"""Descarga el Tablero de Indicadores desde SharePoint vía Microsoft Graph.

Usa client credentials (app registration en Entra ID de ACHS). Variables de
entorno requeridas:

  SHAREPOINT_TENANT_ID     - tenant id (o dominio) de ACHS en Entra ID
  SHAREPOINT_CLIENT_ID     - client id de la app registrada
  SHAREPOINT_CLIENT_SECRET - client secret de la app registrada
  SHAREPOINT_SITE_ID       - id del sitio SharePoint (ver README para cómo obtenerlo)
  SHAREPOINT_FILE_PATH     - path del archivo dentro del drive del sitio,
                              ej. "Documentos compartidos/Tablero_Indicadores_GDD_-_RED.xlsx"

Permisos de aplicación necesarios en Graph (con consentimiento de admin):
  Sites.Selected (preferido, acotado al sitio) o Sites.Read.All / Files.Read.All
"""
import os
import sys
from pathlib import Path

import requests

GRAPH_BASE = "https://graph.microsoft.com/v1.0"


def get_app_token(tenant_id: str, client_id: str, client_secret: str) -> str:
    url = f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"
    resp = requests.post(
        url,
        data={
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
            "scope": "https://graph.microsoft.com/.default",
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


def download_file(token: str, site_id: str, file_path: str, out_path: Path) -> None:
    url = f"{GRAPH_BASE}/sites/{site_id}/drive/root:/{file_path}:/content"
    resp = requests.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=120)
    resp.raise_for_status()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(resp.content)


def main():
    required = [
        "SHAREPOINT_TENANT_ID",
        "SHAREPOINT_CLIENT_ID",
        "SHAREPOINT_CLIENT_SECRET",
        "SHAREPOINT_SITE_ID",
        "SHAREPOINT_FILE_PATH",
    ]
    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        print(f"Faltan variables de entorno: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)

    if len(sys.argv) != 2:
        print(f"Uso: {sys.argv[0]} <ruta_salida.xlsx>", file=sys.stderr)
        sys.exit(1)

    out_path = Path(sys.argv[1])

    token = get_app_token(
        os.environ["SHAREPOINT_TENANT_ID"],
        os.environ["SHAREPOINT_CLIENT_ID"],
        os.environ["SHAREPOINT_CLIENT_SECRET"],
    )
    download_file(token, os.environ["SHAREPOINT_SITE_ID"], os.environ["SHAREPOINT_FILE_PATH"], out_path)
    print(f"OK: descargado en {out_path} ({out_path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
