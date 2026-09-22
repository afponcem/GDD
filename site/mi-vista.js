(function () {
  "use strict";

  const {
    loadCombinedData,
    computeEntityFilterOptions,
    entityMatchesFilters,
    focoColorVar,
    sortFocos,
    levelLabel,
    formatUpdatedAt,
    computeStatus,
    valueCellMarkup,
    escapeHtml,
    safeGet,
    safeSet,
    initThemeToggle,
    createChecklistDropdown,
  } = window.GDD;

  const SIN_FOCO_LABEL = "Sin foco asignado";

  const STORAGE_KEY = "gdd-my-entity-code";

  // Mismas 4 dimensiones en cascada que la Tabla completa (ver app.js), acá
  // usadas para acotar la LISTA DE RESULTADOS del buscador de entidad, no
  // filas de tabla. "foco" es aparte: filtra las tarjetas de indicador de la
  // entidad ya elegida, no la búsqueda de entidad.
  const ENTITY_FILTER_DIMS = ["territorio", "subgerencia", "agencia", "jefatura"];
  const ENTITY_FILTER_LABELS = {
    territorio: "Territorio",
    subgerencia: "Subgerencia",
    agencia: "Agencia",
    jefatura: "Jefatura",
  };

  const state = {
    data: null,
    combined: null,
    entityIndex: [], // lista plana {code, name, level, breadcrumb, node, path}
    selected: null, // entrada de entityIndex actualmente elegida
    focoFilter: [], // focos elegidos (vacío = todos) — filtra las tarjetas, no la entidad
    entityFilters: { territorio: [], subgerencia: [], agencia: [], jefatura: [] },
  };

  const entityDropdowns = {};
  let focoDropdown = null;
  let focoOptionsCache = [];

  const myView = document.getElementById("my-view");
  const updatedAtEl = document.getElementById("updated-at");
  const searchInput = document.getElementById("entity-search");
  const resultsEl = document.getElementById("entity-results");
  const selectedBar = document.getElementById("entity-selected");
  const breadcrumbEl = document.getElementById("entity-breadcrumb");
  const titleEl = document.getElementById("entity-title");
  const summaryEl = document.getElementById("status-summary");

  init();

  async function init() {
    bindControls();
    initThemeToggle();
    try {
      const loaded = await loadCombinedData();
      state.data = loaded.data;
      state.combined = loaded.combined;
      state.entityIndex = flattenEntities(state.combined.hierarchy);
      updatedAtEl.textContent = formatUpdatedAt(state.data.generated_at);
      buildEntityFilterDropdowns();
      populateEntityFilterOptions();
      buildFocoDropdown();

      const savedCode = safeGet(STORAGE_KEY);
      const saved = savedCode && state.entityIndex.find((e) => e.code === savedCode);
      if (saved) {
        selectEntity(saved);
      } else {
        showPicker();
      }
    } catch (err) {
      myView.innerHTML = `<p class="muted">No se pudieron cargar los datos (${escapeHtml(
        String(err)
      )}). Si esto persiste fuera de una corrida de prueba, revisa el workflow de actualización.</p>`;
    }
  }

  // Aplana el árbol combinado a una lista de {code, name, level, breadcrumb,
  // node, path}. `breadcrumb` es la cadena de nombres de ancestros (sin
  // incluir el nodo TOTAL, que es implícito, ni el nodo mismo). `path` lleva
  // el código de ancestro por dimensión (territorio/subgerencia/agencia/
  // jefatura), igual que window.GDD.walkTree, para poder acotar la búsqueda
  // de entidad con los mismos filtros en cascada de la Tabla completa.
  function flattenEntities(root) {
    const out = [];
    const step = (node, trail, path) => {
      const nextPath = { ...path };
      if (node.level === "territorio") nextPath.territorio = node.code;
      else if (node.level === "subgerencia") nextPath.subgerencia = node.code;
      else if (node.level === "agencia") nextPath.agencia = node.code;
      else if (node.level === "jefatura") nextPath.jefatura = node.code;

      out.push({
        code: node.code,
        name: node.name,
        level: node.level,
        node,
        breadcrumb: trail.join(" › "),
        path: nextPath,
      });
      const childTrail = node.level === "total" ? trail : [...trail, node.name];
      (node.children || []).forEach((child) => step(child, childTrail, nextPath));
    };
    step(root, [], {});
    return out;
  }

  function matchesEntityFilters(entry) {
    return entityMatchesFilters(entry.path, entry.level, entry.code, state.entityFilters);
  }

  // Dropdowns de Territorio/Subgerencia/Agencia/Jefatura, en cascada igual
  // que app.js: cada dimensión se recalcula usando ya el estado podado de la
  // anterior (ver el comentario en populateFilterOptions de app.js para el
  // porqué de las 4 pasadas secuenciales en vez de una).
  function buildEntityFilterDropdowns() {
    const container = document.getElementById("mivista-filters-container");
    const clearBtn = document.getElementById("mivista-clear-filters");
    if (!container) return;

    ENTITY_FILTER_DIMS.forEach((dim) => {
      const dropdown = createChecklistDropdown({
        dim,
        label: ENTITY_FILTER_LABELS[dim],
        selected: state.entityFilters[dim],
        onSelectionChange: () => {
          populateEntityFilterOptions();
          refreshEntityResults();
        },
      });
      entityDropdowns[dim] = dropdown;
      container.insertBefore(dropdown.element, clearBtn);
    });

    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        // El botón dice "Limpiar filtros" sin distinguir tipos — debe
        // limpiar también Foco (filtra las tarjetas), no solo la cascada de
        // entidad, o quedaría una selección de Foco invisible escondiendo
        // tarjetas sin que el botón lo haya dejado claro.
        ENTITY_FILTER_DIMS.forEach((dim) => {
          state.entityFilters[dim].length = 0;
        });
        state.focoFilter.length = 0;
        populateEntityFilterOptions();
        refreshEntityResults();
        if (focoDropdown) focoDropdown.refresh(focoOptionsCache);
        if (state.selected) renderMyView(state.selected.node);
      });
    }
  }

  function populateEntityFilterOptions() {
    if (!state.combined) return;
    const options = computeEntityFilterOptions(state.combined.hierarchy, state.entityFilters);
    ENTITY_FILTER_DIMS.forEach((dim) => entityDropdowns[dim].refresh(options[dim]));
  }

  // Reaplica el filtro de entidad a la lista de resultados con el texto de
  // búsqueda actual — igual que el buscador de texto (bindControls, más
  // abajo): un filtro de Territorio/Subgerencia/Agencia/Jefatura es otra
  // forma de acotar la MISMA lista, así que debe reaccionar igual de
  // inmediato, haya o no una entidad ya elegida (si no, tocar el filtro
  // para buscar una entidad distinta a la actual no hace nada visible, y
  // parece que el filtro "no funciona").
  function refreshEntityResults() {
    renderResults(searchInput.value.trim().toLowerCase());
  }

  function bindControls() {
    searchInput.addEventListener("input", refreshEntityResults);
    searchInput.addEventListener("focus", refreshEntityResults);
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".entity-picker")) resultsEl.hidden = true;
    });

    document.getElementById("entity-change").addEventListener("click", showPicker);
  }

  function buildFocoDropdown() {
    const container = document.getElementById("mivista-filters-container");
    if (!container) return;
    focoOptionsCache = [...new Set(state.combined.indicators.map((ind) => ind.foco).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, "es"))
      .map((foco) => ({ code: foco, name: foco }));

    focoDropdown = createChecklistDropdown({
      dim: "foco",
      label: "Foco",
      selected: state.focoFilter,
      onSelectionChange: () => {
        if (state.selected) renderMyView(state.selected.node);
      },
    });
    container.appendChild(focoDropdown.element);
    focoDropdown.refresh(focoOptionsCache);
  }

  function showPicker() {
    selectedBar.hidden = true;
    myView.innerHTML = `<p class="muted">Busca tu territorio, subgerencia, agencia o nombre arriba para ver tus indicadores.</p>`;
    summaryEl.hidden = true;
    searchInput.value = "";
    searchInput.focus();
    renderResults("");
  }

  function hasActiveEntityFilter() {
    return ENTITY_FILTER_DIMS.some((dim) => state.entityFilters[dim].length > 0);
  }

  function renderResults(query) {
    if (!state.entityIndex.length) return;
    const filtering = hasActiveEntityFilter();
    const matches = state.entityIndex
      .filter((e) => e.level !== "total")
      .filter((e) => !filtering || matchesEntityFilters(e))
      .filter((e) => !query || e.name.toLowerCase().includes(query) || e.breadcrumb.toLowerCase().includes(query))
      .slice(0, 25);

    resultsEl.innerHTML = "";
    if (!matches.length) {
      resultsEl.hidden = !query && !filtering;
      if (query || filtering) {
        const empty = document.createElement("div");
        empty.className = "entity-result-empty";
        empty.textContent = "Sin resultados.";
        resultsEl.appendChild(empty);
      }
      return;
    }

    matches.forEach((entry) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "entity-result";
      item.innerHTML = `
        <span class="entity-result-name">${escapeHtml(entry.name)}</span>
        <span class="entity-result-meta">${levelLabel(entry)}${
        entry.breadcrumb ? " · " + escapeHtml(entry.breadcrumb) : ""
      }</span>
      `;
      item.addEventListener("click", () => selectEntity(entry));
      resultsEl.appendChild(item);
    });
    resultsEl.hidden = false;
  }

  function selectEntity(entry) {
    state.selected = entry;
    safeSet(STORAGE_KEY, entry.code);
    resultsEl.hidden = true;
    // Si el texto de búsqueda quedara puesto, un filtro tocado más tarde
    // (sin volver a escribir nada) se combinaría con ese texto viejo y
    // devolvería "sin resultados" incluso con el filtro bien aplicado.
    searchInput.value = "";

    selectedBar.hidden = false;
    // Un Territorio no tiene ancestros que mostrar (breadcrumb vacío) — eso
    // no significa "toda la red", solo que ya es el nivel más alto que se
    // puede elegir (el nodo TOTAL en sí nunca aparece en el buscador).
    breadcrumbEl.textContent = entry.breadcrumb;
    titleEl.textContent = `${entry.name} · ${levelLabel(entry)}`;

    renderMyView(entry.node);
  }

  function renderMyView(node) {
    const indicators = state.focoFilter.length
      ? state.combined.indicators.filter((ind) => state.focoFilter.includes(ind.foco))
      : state.combined.indicators;
    myView.innerHTML = "";
    renderSummary(node, indicators);

    if (!indicators.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "Ningún indicador calza con el foco seleccionado.";
      myView.appendChild(empty);
      return;
    }

    // Agrupadas por Foco (orden fijo, ver sortFocos en shared.js) en vez de
    // una sola grilla plana: así se lee cada panel de negocio por separado
    // y el color+borde de severidad de cada tarjeta salta a la vista dentro
    // de su propio grupo, en lugar de perderse entre indicadores de temas
    // distintos.
    const byFoco = new Map();
    indicators.forEach((ind) => {
      const foco = ind.foco || SIN_FOCO_LABEL;
      if (!byFoco.has(foco)) byFoco.set(foco, []);
      byFoco.get(foco).push(ind);
    });

    sortFocos([...byFoco.keys()]).forEach((foco) => {
      const group = document.createElement("section");
      group.className = "foco-group";

      const header = document.createElement("div");
      header.className = "foco-group-header";
      const dot = document.createElement("span");
      dot.className = "foco-group-dot";
      dot.style.background = `var(${focoColorVar(foco === SIN_FOCO_LABEL ? null : foco)})`;
      const title = document.createElement("h3");
      title.className = "foco-group-title";
      title.textContent = foco;
      const focoIndicators = byFoco.get(foco);
      const count = document.createElement("span");
      count.className = "foco-group-count";
      count.textContent = `${focoIndicators.length} indicador${focoIndicators.length === 1 ? "" : "es"}`;
      header.appendChild(dot);
      header.appendChild(title);
      header.appendChild(count);
      group.appendChild(header);

      const grid = document.createElement("div");
      grid.className = "stat-grid";
      focoIndicators.forEach((ind) => {
        grid.appendChild(buildStatTile(ind, node));
      });
      group.appendChild(grid);

      myView.appendChild(group);
    });
  }

  function renderSummary(node, indicators) {
    const counts = { good: 0, warning: 0, critical: 0 };
    indicators.forEach((ind) => {
      const value = node.valuesMtd ? node.valuesMtd[ind.key] : undefined;
      const { status } = computeStatus(value, ind.metaMtd);
      if (status === "good" || status === "warning" || status === "critical") counts[status] += 1;
    });

    summaryEl.innerHTML = `
      <span class="summary-item good">✓ ${counts.good} cumple</span>
      <span class="summary-item warning">! ${counts.warning} en alerta</span>
      <span class="summary-item critical">✕ ${counts.critical} bajo meta</span>
      <span class="muted summary-note">(sobre el avance del mes en curso — MTD)</span>
    `;
    summaryEl.hidden = false;
  }

  // Prioridad para quedarse con el peor de los dos estados (YTD/MTD) como
  // "severidad" de la tarjeta completa — así una tarjeta con un solo valor
  // en rojo salta a la vista aunque el otro esté en verde.
  const SEVERITY_RANK = { critical: 0, warning: 1, good: 2, neutral: 3 };

  function buildStatTile(ind, node) {
    const tile = document.createElement("div");
    tile.className = "stat-tile";

    const ytdValue = node.valuesYtd ? node.valuesYtd[ind.key] : undefined;
    const mtdValue = node.valuesMtd ? node.valuesMtd[ind.key] : undefined;
    const ytdStatus = computeStatus(ytdValue, ind.metaYtd).status;
    const mtdStatus = computeStatus(mtdValue, ind.metaMtd).status;
    const severity = SEVERITY_RANK[ytdStatus] <= SEVERITY_RANK[mtdStatus] ? ytdStatus : mtdStatus;
    tile.dataset.severity = severity;

    const label = document.createElement("div");
    label.className = "stat-label";
    label.textContent = ind.label;
    label.title = ind.label;
    tile.appendChild(label);

    tile.appendChild(buildStatRow("YTD", ytdValue, ind.metaYtd));
    tile.appendChild(buildStatRow("MTD", mtdValue, ind.metaMtd));

    return tile;
  }

  function buildStatRow(tag, value, meta) {
    const row = document.createElement("div");
    row.className = "stat-row";

    const tagEl = document.createElement("span");
    tagEl.className = "stat-tag";
    tagEl.textContent = tag;
    row.appendChild(tagEl);

    const valueWrap = document.createElement("span");
    valueWrap.className = "stat-value";
    valueWrap.innerHTML = valueCellMarkup(value, meta);
    row.appendChild(valueWrap);

    return row;
  }
})();
