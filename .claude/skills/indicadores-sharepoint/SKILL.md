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
  - Marcador `AGENCIAS` en columna B → siguen filas de agencia: col A = código/nombre, col B = nombre corto del territorio padre (forward-fill, igual que en `SUBGERENCIA`), col C = nombre de la agencia. Esta sección por sí sola solo liga Agencia → Territorio (no da el código de Subgerencia intermedio) — el vínculo real con Subgerencia se obtiene cruzando con la hoja cruda `YTD` (ver más abajo).
  - Marcador `JEFATURA` en columna B → siguen filas de persona (nivel `"jefatura"`). **Ojo con la semántica**: dentro de esta sección aparecen filas que repiten el código+nombre exactos de una fila ya vista de `SUBGERENCIA` o de `TERRITORIO` (mismo `SGRGxxxx`/`GRTRxxxx`, mismo nombre, mismo valor agregado) — **estas filas CIERRAN el grupo de personas que viene ANTES, no abren el que sigue después**. Es decir, es un patrón de "subtotal al final del grupo", no de encabezado. El parser acumula personas en un buffer y lo vacía (asignándolo a esa Subgerencia o Territorio) recién al toparse con la fila de cierre. **Este fue un bug real en una versión anterior del parser** — se verificó contra un caso real del usuario (Subgerencia "Metro Centro", agencia "Santiago" con 3 personas) que solo se explica con esta dirección.
  - Valor `-` en una celda de indicador significa "sin dato" (se omite en el JSON, no se guarda como 0).

El nombre corto de territorio en las filas de subgerencia/agencia (`NORTE`/`METRO`/`SUR`)
no calza textualmente con el nombre completo del territorio (`TERRITORIO NORTE`,
`TERRITORIO METROPOLITANO`, `TERRITORIO SUR`). El mapeo está hardcodeado en
`TERRITORIO_SHORT_NAME_MAP` dentro de `scripts/parse_tablero.py` — **si ACHS
renombra un territorio, hay que actualizar ese diccionario**.

## El vínculo Jefatura -> Agencia (hoja cruda "YTD")

Ninguna hoja "Resumen ..." liga una persona con su agencia. Ese vínculo solo
existe en la hoja cruda **`YTD`** (el detalle mensual por persona, distinta
de `Resumen Cump YTD`), en un patrón de 3 filas por persona (REAL/META/CUMP):

- Columna D: código de la persona (ej. `JECP4101`), igual en las 3 filas.
- Columna F: nombre de la agencia — pero **no siempre en la misma de las 3
  filas** (a veces en la fila REAL, a veces en la CUMP). Hay que escanear
  las 3 y quedarse con la primera no vacía (`build_jefatura_agencia_tags`
  hace esto).
- Columna H: la etiqueta `REAL` / `META` / `CUMP`.

Con ese mapeo (`código_persona -> nombre_agencia`), `nest_agencias` reordena
el árbol ya parseado: agrupa las jefaturas de cada Subgerencia por nombre de
agencia, y si ese nombre calza (normalizado, sin tildes) con un nodo ya
parseado en la sección `AGENCIAS` de la propia hoja Resumen, lo reutiliza
(con sus valores reales de cumplimiento) como nodo intermedio
`Subgerencia -> Agencia -> Jefatura`. El árbol final queda así **sí**
anidado en 4 niveles.

Dos casos no calzan y quedan documentados, no son bugs:
- **Zonas combinadas**: una persona puede estar a cargo de una zona que
  junta 2 agencias (ej. tag `"ARICA-IQUIQUE"`) que en la sección `AGENCIAS`
  existen por separado (`ARICA`, `IQUIQUE`). Ahí se crea un nodo Agencia
  liviano con ese nombre combinado pero **sin valores propios** (no hay un
  % de cumplimiento agregado para esa combinación en el archivo) — la fila
  igual sirve para filtrar/drill-down, solo sin número al lado.
- **Agencias sin jefatura asociada** (o cuyo tag no calzó con ninguna): se
  dejan como respaldo colgando directo del Territorio, como en la versión
  anterior del parser.

Si en algún momento la hoja cruda `YTD` cambia de layout (columnas
corridas, patrón de 3 filas distinto), `build_jefatura_agencia_tags` es lo
primero que hay que revisar — sin este cruce, el árbol sigue funcionando
pero Agencia vuelve a quedar como rama plana bajo Territorio en vez de
anidada bajo Subgerencia.

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

## Vista combinada YTD/MTD en el sitio

`site/app.js` (`buildCombinedData`/`mergeHierarchyNode`) fusiona los árboles
`weekly` y `ytd` en uno solo (una columna YTD y otra MTD por indicador, en
vez del toggle de vistas separadas que tenía la v1). La unión de hijos entre
ambos árboles es **por código**, no por posición: si una jefatura/agencia
existe en una hoja pero no en la otra (ej. alguien que dejó el cargo esta
semana y aún aparece en el acumulado YTD, o un ingreso nuevo que todavía no
tiene histórico YTD), el nodo igual aparece en la tabla combinada, pero
puede quedar al final de la lista de hermanos en vez de en su posición
habitual del organigrama — es un efecto cosmético (orden de filas), no
pérdida de datos. Si el fallback de territorio de `parse_tablero.py` (cuando
el nombre corto de territorio no resuelve, ver `resolve_territorio`) se
disparara de forma distinta entre las dos hojas para el mismo código —no
debería pasar en la práctica, ambas hojas comparten el mismo organigrama—
esa entidad quedaría duplicada como dos filas (una con solo YTD, otra con
solo MTD) en vez de fusionada en una. No se ha visto en los archivos reales
probados hasta ahora, pero si aparece una fila "duplicada" con datos a
medias, es la primera hipótesis a revisar.

## Automatización semanal

El parser **no invoca un LLM** — es determinístico y corre solo en
`.github/workflows/update-indicadores.yml` (cron lunes 13:00 hora Chile). Este
skill se usa solo cuando alguien (persona o Claude) necesita *mantener* el
código de lectura, no en cada ejecución automática.
