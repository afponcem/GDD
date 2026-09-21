# Indicadores de Gestión GDD

Dashboard interno para el equipo de Planificación y Desarrollo Comercial de
ACHS. Lee semanalmente el Tablero de Indicadores desde SharePoint y publica
una vista web con el estado de cumplimiento por Territorio/Subgerencia.

## Cómo funciona

```
SharePoint (Excel, se edita semanalmente)
   -> scripts/fetch_sharepoint.py   (descarga vía Microsoft Graph)
   -> scripts/parse_tablero.py      (Excel -> site/data/indicadores.json)
   -> site/                         (HTML/CSS/JS estático que lee ese JSON)
   -> GitHub Pages                  (publicado por .github/workflows/update-indicadores.yml)
```

El workflow corre cada lunes ~13:00 hora Chile (o manualmente vía
"Run workflow" en la pestaña Actions). El JSON de datos **no se versiona**:
se genera y publica en cada corrida.

Ver `.claude/skills/indicadores-sharepoint/SKILL.md` para el detalle de cómo
está estructurado el Excel fuente y cómo mantener el parser si cambia.

## Configuración pendiente (una sola vez)

### 1. Registrar la app en Azure AD / Entra ID de ACHS

Se necesita una app registration con permisos de **aplicación** de Microsoft
Graph (con consentimiento de administrador):
- `Sites.Selected` (recomendado, acota el acceso solo al sitio
  "Planificación y Desarrollo Comercial") — requiere además darle acceso al
  sitio específico vía la API de Graph (`POST /sites/{site-id}/permissions`).
- o `Sites.Read.All` si se prefiere no acotar por sitio.

Con eso se obtienen: `tenant id`, `client id` y un `client secret`.

### 2. Cargar los secrets del repositorio

En GitHub → Settings → Secrets and variables → Actions, crear:

| Secret | Valor |
|---|---|
| `SHAREPOINT_TENANT_ID` | Tenant id de ACHS en Entra ID |
| `SHAREPOINT_CLIENT_ID` | Client id de la app registrada |
| `SHAREPOINT_CLIENT_SECRET` | Client secret de la app registrada |
| `SHAREPOINT_SITE_ID` | Id del sitio SharePoint (ver Graph Explorer: `GET /sites/achs.sharepoint.com:/sites/PlanificacinyDesarrolloComercial`) |
| `SHAREPOINT_FILE_PATH` | Ruta del archivo dentro del drive, ej. `Documentos compartidos/Tablero_Indicadores_GDD_-_RED.xlsx` |

### 3. Activar GitHub Pages

En Settings → Pages, fuente = "GitHub Actions" (no "Deploy from a branch").

### 4. Restringir el acceso a @achs.cl

GitHub Pages no soporta autenticación nativa. Pendiente de definir con el
usuario: la opción recomendada es poner **Cloudflare Access** delante del
dominio de Pages, con una política que exija correo `@achs.cl` (vía Google
Workspace/Entra ID SSO o verificación por código). Requiere que ACHS controle
el DNS del dominio que se use para publicar el sitio.

## Desarrollo local

```bash
pip install -r scripts/requirements.txt
python3 scripts/parse_tablero.py /ruta/al/Tablero.xlsx site/data/indicadores.json
python3 -m http.server 8000 --directory site
# abrir http://localhost:8000
```
