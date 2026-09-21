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

Requiere un rol de administrador en Entra ID de ACHS (Application
Administrator o Global Administrator). Si no lo tienes, esta sección es lo
que le pasas a TI tal cual.

**a) Crear la app registration**
1. [entra.microsoft.com](https://entra.microsoft.com) → **Identity → Applications →
   App registrations → New registration**.
2. Nombre: `gdd-indicadores-sharepoint-reader` (o el que prefieran). Tipo de
   cuenta: *Accounts in this organizational directory only*. Sin Redirect URI
   (es una app de servidor, sin login interactivo).
3. Anota el **Application (client) ID** y el **Directory (tenant) ID** que
   quedan en la página de overview — son `SHAREPOINT_CLIENT_ID` y
   `SHAREPOINT_TENANT_ID`.

**b) Crear el client secret**
1. En la misma app → **Certificates & secrets → New client secret**.
2. Copia el **Value** apenas se genera (no se puede volver a ver después) —
   es `SHAREPOINT_CLIENT_SECRET`.

**c) Dar permiso de aplicación acotado al sitio (`Sites.Selected`)**
Se usa `Sites.Selected` en vez de `Sites.Read.All` para que la app solo pueda
leer este sitio de SharePoint, no todo el tenant.
1. En la app → **API permissions → Add a permission → Microsoft Graph →
   Application permissions** → buscar `Sites.Selected` → agregar.
2. **Grant admin consent for ACHS** (botón en la misma pantalla) — sin esto
   el permiso queda "not granted" y las llamadas fallan con 403.
3. Dar acceso específico al sitio (esto no se hace desde el portal, es una
   llamada Graph que debe ejecutar alguien con permiso sobre el sitio —
   puede hacerse desde [Graph Explorer](https://developer.microsoft.com/en-us/graph/graph-explorer)
   logueado como admin, o con `Invoke-RestMethod`/`curl`):
   ```http
   GET https://graph.microsoft.com/v1.0/sites/achs.sharepoint.com:/sites/PlanificacinyDesarrolloComercial
   ```
   (`PlanificacinyDesarrolloComercial`, sin tildes ni espacios, es el slug
   real que usa SharePoint en la URL del sitio — no es un error de tipeo,
   viene tal cual del link compartido. Si el sitio se renombra, el slug
   puede cambiar y hay que confirmarlo de nuevo).

   Copia el `id` de la respuesta (es `SHAREPOINT_SITE_ID`), luego:
   ```http
   POST https://graph.microsoft.com/v1.0/sites/{SHAREPOINT_SITE_ID}/permissions
   Content-Type: application/json

   {
     "roles": ["read"],
     "grantedToIdentities": [{
       "application": {
         "id": "{SHAREPOINT_CLIENT_ID}",
         "displayName": "gdd-indicadores-sharepoint-reader"
       }
     }]
   }
   ```
   Sin este paso, `Sites.Selected` no le da acceso a ningún sitio concreto.

**d) Confirmar la ruta del archivo**
`SHAREPOINT_FILE_PATH` es la ruta relativa a la raíz del drive del sitio —
normalmente empieza con `Documentos compartidos/` (o `Shared Documents/`).
Se puede confirmar listando la carpeta vía Graph Explorer:
```http
GET https://graph.microsoft.com/v1.0/sites/{SHAREPOINT_SITE_ID}/drive/root:/Documentos compartidos:/children
```

**Alternativa más simple, menos acotada:** si registrar `Sites.Selected` +
el paso (c) es mucho ida y vuelta con TI, se puede usar el permiso de
aplicación `Sites.Read.All` en su lugar (paso a/b iguales, en el paso c solo
se agrega y se otorga consentimiento de admin, sin la llamada POST) — la app
podría leer cualquier sitio de SharePoint del tenant, así que es un permiso
más amplio del que en principio se necesita.

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
