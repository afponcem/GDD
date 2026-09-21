---
name: indicadores-sharepoint
description: >
  Mantiene el pipeline que lee el Tablero de Indicadores GDD (Excel en SharePoint
  de ACHS) y lo convierte en el JSON que consume el sitio de indicadores. Úsala
  cuando: (1) el layout del archivo fuente cambió y `scripts/parse_tablero.py`
  empezó a fallar o a producir datos incorrectos/incompletos, (2) hay que agregar
  una nueva hoja/vista al dashboard (ej. incorporar `YTD` a nivel persona, o
  `Resumen Cumplimientos`), o (3) hay que revisar/ajustar cómo se descarga el
  archivo desde SharePoint vía Microsoft Graph.
---

# Skill: lectura del Tablero de Indicadores GDD

## Qué resuelve

El equipo de Planificación y Desarrollo Comercial de ACHS mantiene un Excel en
SharePoint ("Tablero_Indicadores_GDD_-_RED.xlsx") que se edita manualmente cada
semana. Este skill es la referencia para mantener el código que:

1. Descarga la última versión del archivo desde SharePoint (`scripts/fetch_sharepoint.py`).
2. Lo parsea a un JSON estable (`scripts/parse_tablero.py`).
3. Alimenta el sitio estático en `site/` que muestra el dashboard al equipo.

No mantiene el sitio web en sí (eso es código normal del repo) — se enfoca en la
parte frágil: la lectura del Excel, cuyo layout puede cambiar sin aviso.

## Estructura del archivo fuente (23 hojas)

El workbook tiene muchas hojas; **solo dos alimentan el dashboard hoy**:

| Hoja | Contenido | Uso |
|---|---|---|
| `Resumen Semanal` | Snapshot de la semana actual, jerárquico | fuente de `weekly` |
| `Resumen Cump YTD` | Snapshot acumulado del año, jerárquico | fuente de `ytd` |

Otras hojas relevantes que **no se parsean aún** (candidatas para v2, ver abajo):

| Hoja | Contenido |
|---|---|
| `Resumen Cumplimientos` | Igual a `Resumen Semanal` pero con mezcla de periodos de corte distintos por indicador (algunos indicadores no son semanales) |
| `YTD` | Detalle mensual **por persona** (REAL/META/CUMP por mes), muy ancho (~394 columnas). Contiene nombres individuales — evaluar privacidad antes de exponerlo en el dashboard de equipo |
| `Definiciones Indicadores` | Definición, meta, semáforo, fuente y responsable de cada indicador — buena fuente para tooltips |
| `Actualizaciones` | Changelog de cambios hechos al tablero semana a semana |
| `202509`...`202609` | Datos crudos mensuales de trabajo (hasta 252 columnas) — no pensadas para consumo directo |
| `Alertas - v0`, `Resumen Desv Sur`, `Resumen Cump Semanal` | Vistas auxiliares/borrador |

Hojas ignoradas por completo: `Hoja1` (notas sueltas sin estructura).

## Formato de las hojas "Resumen ..." (jerárquicas)

`Resumen Semanal` y `Resumen Cump YTD` comparten el mismo layout:

- **Filas de encabezado (fijas):**
  - Fila 3: nombre de columna "sucio", con sufijo de periodo (ej. `CAPTACIÓN TOTALS2`, o a veces el periodo tipo `202608`).
  - Fila 4: nombre canónico del indicador (ej. `CAPTACIÓN TOTAL`) — **esta es la que se usa** para generar la `key` (slug) del indicador. Si el nombre cambia acá, cambia la key en el JSON — hay que decidir si mantener retrocompatibilidad.
  - Fila 5: `Fecha Corte ->` + fecha de corte por indicador (algunos indicadores se actualizan con distinto rezago).
  - Fila 6: `Exigencia ->` + meta/target por indicador. Puede ser numérico (ej. `1` = 100%) o el string `(Valor Real)` cuando el indicador no tiene meta de cumplimiento, es un valor absoluto.
- **Filas de datos**, empezando en la fila 8:
  - Fila 8: fila `TOTAL RED ACHS` (col A = código, col B = nombre, resto = valores). Es la raíz del árbol.
  - Marcador `TERRITORIO` en columna B (col A vacía) → siguen filas de territorio: col A = código (`GRTR10xx`), col B = nombre.
  - Marcador `SUBGERENCIA` en columna B → siguen filas de subgerencia: col A = código (`SGRGxxxx`), col B = nombre corto del territorio padre (**solo en la primera fila de cada grupo** — hay que hacer forward-fill), col C = nombre de la subgerencia.
  - Marcador `AGENCIAS` en columna B → siguen filas de agencia: col A = código/nombre, col B = nombre corto del territorio padre (forward-fill, igual que en `SUBGERENCIA`), col C = nombre de la agencia. **Ojo:** esta sección solo liga Agencia → Territorio. La planilla **no da el código de Subgerencia intermedio**, así que el parser cuelga la agencia directo del territorio (nivel `"agencia"`), no de la subgerencia — anidarla ahí sería inventar un vínculo que el archivo no tiene.
  - Marcador `JEFATURA` en columna B → siguen filas de persona (nivel `"jefatura"`). A diferencia de Agencia, acá sí hay vínculo con Subgerencia: dentro de esta sección aparecen filas que **repiten el código y nombre exactos de una fila de `SUBGERENCIA`** (mismo `SGRGxxxx`, mismo nombre en col C, mismo valor agregado) — son encabezados de grupo, no personas. El parser las detecta comparando código+nombre contra las subgerencias ya vistas (`subgerencias_by_code`) y usa esa fila como "subgerencia actual" para las personas que siguen, hasta el próximo encabezado. Las primeras filas de la sección (antes de cualquier encabezado de subgerencia) son cargos a nivel territorial y cuelgan directo del territorio.
  - Valor `-` en una celda de indicador significa "sin dato" (se omite en el JSON, no se guarda como 0).

El nombre corto de territorio en las filas de subgerencia/agencia (`NORTE`/`METRO`/`SUR`)
no calza textualmente con el nombre completo del territorio (`TERRITORIO NORTE`,
`TERRITORIO METROPOLITANO`, `TERRITORIO SUR`). El mapeo está hardcodeado en
`TERRITORIO_SHORT_NAME_MAP` dentro de `scripts/parse_tablero.py` — **si ACHS
renombra un territorio, hay que actualizar ese diccionario**.

El árbol resultante queda asimétrico a propósito: `Territorio → Subgerencia →
Jefatura` por un lado, y `Territorio → Agencia` por otro (Agencia y
Subgerencia son ramas paralelas bajo el mismo Territorio, no una anidada en
la otra). Si en algún momento ACHS agrega una columna o fila que sí ligue
Agencia con Subgerencia, vale la pena revisar si conviene re-anidar.

## Cómo regenerar/extender el parser

1. Descarga (o pide al usuario) la última versión del `.xlsx`.
2. Inspecciona con `openpyxl` (no uses `pandas.read_excel` para las hojas
   jerárquicas — el layout con celdas "vacías por diseño" para forward-fill
   rompe la inferencia de columnas de pandas):
   ```python
   import openpyxl
   wb = openpyxl.load_workbook("archivo.xlsx", data_only=True)
   ws = wb["Resumen Semanal"]
   for r in range(1, 40):
       print(r, [ws.cell(r, c).value for c in range(1, 12)])
   ```
3. Compara contra la sección "Formato de las hojas" de este documento — si algo
   no calza (nueva fila de encabezado, nuevo marcador de sección, columnas
   corridas), actualiza `scripts/parse_tablero.py` y **esta tabla también**.
4. Corre el parser contra el archivo real y valida el JSON de salida:
   ```bash
   python3 scripts/parse_tablero.py archivo.xlsx /tmp/salida.json
   python3 -c "import json; d=json.load(open('/tmp/salida.json')); print(d['weekly']['hierarchy']['children'][0])"
   ```
5. Verifica que el número de subgerencias por territorio y el total general
   tengan sentido comparando manualmente unas pocas filas contra el Excel
   abierto (ojo con filas que no tienen territorio asignado, como
   `JGCE0000 FORESTAL`, que puede caer mal si se mueve de posición).

## Descarga desde SharePoint (Microsoft Graph)

El archivo vive en el sitio SharePoint "Planificación y Desarrollo Comercial"
de ACHS. La app registrada en Entra ID necesita, como mínimo, permiso de
aplicación `Sites.Selected` (preferido, acota el acceso a este sitio) o
`Sites.Read.All` sobre Microsoft Graph, con consentimiento de administrador.

`scripts/fetch_sharepoint.py` usa client credentials (client id + secret +
tenant id, vía variables de entorno `SHAREPOINT_TENANT_ID`,
`SHAREPOINT_CLIENT_ID`, `SHAREPOINT_CLIENT_SECRET`, `SHAREPOINT_SITE_ID`,
`SHAREPOINT_FILE_PATH`) para:
1. Obtener un token de aplicación (`/oauth2/v2.0/token`, `grant_type=client_credentials`).
2. Descargar el archivo vía `GET /sites/{site-id}/drive/root:/{file-path}:/content`.

Si el `site-id` o el path cambian (ej. reorganización de SharePoint), hay que
volver a resolverlos con Graph Explorer o `GET /sites/achs.sharepoint.com:/sites/PlanificacinyDesarrolloComercial`.

## Automatización semanal

El parser **no invoca un LLM** — es determinístico y corre solo en
`.github/workflows/update-indicadores.yml` (cron lunes 13:00 hora Chile). Este
skill se usa solo cuando alguien (persona o Claude) necesita *mantener* el
código de lectura, no en cada ejecución automática.
