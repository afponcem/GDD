(function () {
  "use strict";

  const {
    loadCombinedData,
    walkTree,
    computeEntityFilterOptions,
    entityMatchesFilters,
    levelLabel,
    formatUpdatedAt,
    formatPercent,
    valueCellMarkup,
    escapeHtml,
    initThemeToggle,
    createChecklistDropdown,
  } = window.GDD;

  // Dimensiones "de entidad" (filtran filas, en cascada Territorio ->
  // Subgerencia -> Agencia -> Jefatura). "foco" filtra columnas de
  // indicador, no filas — es independiente de la cascada, pero comparte el
  // mismo componente de dropdown (checklist con buscador) por consistencia
  // visual, así que vive en el mismo FILTER_DIMS para construirse/limpiarse/
  // mostrar sus chips igual que las demás; donde SÍ importa la distinción
  // (hasActiveFilter/nodeMatchesFilters, que deciden qué FILAS se ven) se
  // usa ENTITY_FILTER_DIMS a propósito, sin "foco".
  const ENTITY_FILTER_DIMS = ["territorio", "subgerencia", "agencia", "jefatura"];
  const FILTER_DIMS = [...ENTITY_FILTER_DIMS, "foco"];
  const FILTER_LABELS = {
    territorio: "Territorio",
    subgerencia: "Subgerencia",
    agencia: "Agencia",
    jefatura: "Jefatura",
    foco: "Foco",
  };

  const state = {
    data: null,
    // Árbol e indicadores fusionados (YTD + MTD en una sola estructura),
    // armados una vez al cargar los datos por buildCombinedData().
    combined: null,
    indicatorsByKey: new Map(), // key -> indicador (para mirar su .foco al filtrar columnas)
    indicatorFilter: "",
    collapsed: null, // Set inicializado al cargar datos (colapsa territorios por defecto)
    // Cada dimensión es un array de códigos seleccionados (multi-select).
    // Los filtros de entidad son concatenados: Territorio acota las
    // opciones de Subgerencia/Agencia/Jefatura, Subgerencia acota
    // Agencia/Jefatura, etc. "foco" no tiene cascada (lista fija).
    filters: { territorio: [], subgerencia: [], agencia: [], jefatura: [], foco: [] },
  };

  // Última lista de nodos disponibles (ya podada por la cascada) por dimensión,
  // para que los botones "Todos"/"Ninguno" y el buscador del panel no tengan
  // que recalcular el árbol.
  const dropdownNodesCache = { territorio: [], subgerencia: [], agencia: [], jefatura: [], foco: [] };
  const dropdowns = {}; // dim -> instancia de createChecklistDropdown

  const tableWrap = document.getElementById("table-wrap");
  const updatedAtEl = document.getElementById("updated-at");

  init();

  async function init() {
    buildFilterDropdowns();
    bindControls();
    initThemeToggle();
    document.addEventListener("gdd:tab-shown", (e) => {
      // Si esta pestaña se dibujó mientras estaba oculta (display:none), el
      // offset sticky del 2o header quedó con el valor de respaldo del CSS
      // — al mostrarse recién se puede medir la altura real.
      if (e.detail.tab !== "tabla") return;
      const table = tableWrap.querySelector("table.matrix");
      if (table) syncSubHeaderStickyOffset(table);
    });
    try {
      const loaded = await loadCombinedData();
      state.data = loaded.data;
      state.combined = loaded.combined;
      state.indicatorsByKey = new Map(state.combined.indicators.map((ind) => [ind.key, ind]));
      updatedAtEl.textContent = formatUpdatedAt(state.data.generated_at);
      resetCollapsedDefault();
      populateFilterOptions();
      render();
    } catch (err) {
      tableWrap.innerHTML = `<p class="muted">No se pudieron cargar los datos (${escapeHtml(
        String(err)
      )}). Si esto persiste fuera de una corrida de prueba, revisa el workflow de actualización.</p>`;
    }
  }

  function resetCollapsedDefault() {
    // Vista inicial limpia: solo TOTAL + Territorios visibles.
    state.collapsed = new Set();
    if (!state.combined) return;
    state.combined.hierarchy.children.forEach((territorio) => {
      state.collapsed.add(territorio.code);
    });
  }

  function bindControls() {
    document.getElementById("indicator-search").addEventListener("input", (e) => {
      state.indicatorFilter = e.target.value.trim().toLowerCase();
      applyIndicatorFilter();
    });

    document.getElementById("clear-filters").addEventListener("click", () => {
      // Muta cada array in-place (nunca reasignar state.filters[dim] = []):
      // createChecklistDropdown guarda la referencia al array que le pasamos
      // y solo la muta; reemplazarla la desincroniza silenciosamente del
      // estado que lee el resto del código (el checkbox sigue viéndose
      // marcado pero el filtro deja de aplicarse).
      FILTER_DIMS.forEach((dim) => {
        state.filters[dim].length = 0;
      });
      populateFilterOptions();
      render();
    });
  }

  function populateFilterOptions() {
    if (!state.combined) return;

    // Territorio/Subgerencia/Agencia/Jefatura: cascada compartida con Mi
    // vista (ver computeEntityFilterOptions en shared.js).
    const options = computeEntityFilterOptions(state.combined.hierarchy, state.filters);
    ENTITY_FILTER_DIMS.forEach((dim) => refreshFilterDropdown(dim, options[dim]));

    // "Foco" no cuelga del árbol de entidades ni tiene cascada: es la lista
    // fija de focos distintos entre los indicadores cargados.
    const focos = [...new Set(state.combined.indicators.map((ind) => ind.foco).filter(Boolean))].map(
      (foco) => ({ code: foco, name: foco })
    );
    refreshFilterDropdown("foco", focos);
  }

  // --- Dropdowns de filtro (checklist compartido, ver shared.js) ---------

  function buildFilterDropdowns() {
    const container = document.getElementById("filters-container");
    const clearBtn = document.getElementById("clear-filters");

    FILTER_DIMS.forEach((dim) => {
      const dropdown = createChecklistDropdown({
        dim,
        label: FILTER_LABELS[dim],
        selected: state.filters[dim],
        // "foco" solo esconde/muestra columnas — no hace falta recalcular
        // la cascada de entidades ni reconstruir toda la tabla, basta con
        // re-aplicar el filtro de columnas (igual que el buscador de texto).
        onSelectionChange:
          dim === "foco"
            ? () => {
                applyIndicatorFilter();
                renderActiveFilterChips();
              }
            : () => {
                populateFilterOptions();
                render();
              },
      });
      dropdowns[dim] = dropdown;
      container.insertBefore(dropdown.element, clearBtn);
    });
  }

  function refreshFilterDropdown(dim, nodes) {
    dropdownNodesCache[dim] = nodes;
    dropdowns[dim].refresh(nodes);
  }

  function hasActiveFilter() {
    // "foco" filtra columnas, no filas — no debe forzar la expansión total
    // del árbol ni el mensaje de "sin resultados" que usan las 4 de entidad.
    return ENTITY_FILTER_DIMS.some((dim) => state.filters[dim].length > 0);
  }

  function nodeMatchesFilters(node, path) {
    return entityMatchesFilters(path, node.level, node.code, state.filters);
  }

  function renderActiveFilterChips() {
    const container = document.getElementById("active-filters");
    container.innerHTML = "";
    FILTER_DIMS.forEach((dim) => {
      state.filters[dim].forEach((code) => {
        const node = (dropdownNodesCache[dim] || []).find((n) => n.code === code);
        const label = node ? node.name : code;
        const chip = document.createElement("span");
        chip.className = "filter-chip";
        const text = document.createElement("span");
        text.textContent = `${FILTER_LABELS[dim]}: ${label}`;
        chip.appendChild(text);
        const removeBtn = document.createElement("button");
        removeBtn.textContent = "✕";
        removeBtn.setAttribute("aria-label", `Quitar filtro ${FILTER_LABELS[dim]}: ${label}`);
        removeBtn.addEventListener("click", () => {
          // In-place: ver comentario en el handler de "Limpiar todo".
          const idx = state.filters[dim].indexOf(code);
          if (idx !== -1) state.filters[dim].splice(idx, 1);
          populateFilterOptions();
          render();
        });
        chip.appendChild(removeBtn);
        container.appendChild(chip);
      });
    });
  }

  function render() {
    if (!state.combined) {
      tableWrap.innerHTML = `<p class="muted">No hay datos.</p>`;
      return;
    }
    const indicators = state.combined.indicators;
    const rows = buildVisibleRows(state.combined.hierarchy);

    const table = document.createElement("table");
    table.className = "matrix";
    table.appendChild(buildHead(indicators));
    table.appendChild(buildBody(rows, indicators));

    tableWrap.innerHTML = "";
    if (hasActiveFilter() && rows.length === 0) {
      const msg = document.createElement("p");
      msg.className = "muted";
      msg.textContent = "Ningún resultado calza con los filtros seleccionados.";
      tableWrap.appendChild(msg);
    }
    tableWrap.appendChild(table);
    applyIndicatorFilter();
    renderActiveFilterChips();
    syncSubHeaderStickyOffset(table);
  }

  function syncSubHeaderStickyOffset(table) {
    // La 2a fila del header (YTD/MTD) queda sticky justo debajo de la 1a
    // (nombres de indicador) — el offset depende de la altura real
    // renderizada de esa 1a fila (fuente, tema, zoom), así que se mide en
    // vez de asumir un valor fijo (el CSS trae un valor de respaldo).
    const row1 = table.querySelector("thead tr:first-child");
    if (!row1) return;
    const height = row1.getBoundingClientRect().height;
    if (!height) return;
    table.querySelectorAll("thead tr:last-child th:not(.entity-col)").forEach((th) => {
      th.style.top = `${height}px`;
    });
  }

  function buildVisibleRows(root) {
    const filtering = hasActiveFilter();

    if (!filtering) {
      // Sin filtros: respeta el estado de colapsado (drill-down manual).
      const out = [];
      const step = (node, depth) => {
        out.push({ node, depth });
        if (node.children && node.children.length && !state.collapsed.has(node.code)) {
          node.children.forEach((child) => step(child, depth + 1));
        }
      };
      step(root, 0);
      return out;
    }

    // Con filtros activos: se ignora el colapso, se muestran los nodos que
    // calzan más toda la cadena de ancestros para dar contexto.
    const all = [];
    const parentOf = new Map();
    walkTree(root, (node, depth, path, parent) => {
      all.push({ node, depth, path });
      if (parent) parentOf.set(node, parent);
    });

    const visible = new Set();
    all.forEach(({ node, path }) => {
      if (nodeMatchesFilters(node, path)) {
        visible.add(node);
        let cursor = parentOf.get(node);
        while (cursor) {
          visible.add(cursor);
          cursor = parentOf.get(cursor);
        }
      }
    });

    return all.filter((r) => visible.has(r.node));
  }

  function levelClass(node) {
    return `level-${node.level}`;
  }


  function buildHead(indicators) {
    const thead = document.createElement("thead");
    const row1 = document.createElement("tr");
    const row2 = document.createElement("tr");

    const entityTh = document.createElement("th");
    entityTh.className = "entity-col";
    entityTh.rowSpan = 2;
    entityTh.textContent = "Territorio / Subgerencia / Agencia / Jefatura";
    row1.appendChild(entityTh);

    indicators.forEach((ind) => {
      const groupTh = document.createElement("th");
      groupTh.className = "indicator-group-th";
      groupTh.colSpan = 2;
      groupTh.dataset.indicatorKey = ind.key;
      groupTh.textContent = ind.label;
      row1.appendChild(groupTh);

      const ytdTh = document.createElement("th");
      ytdTh.className = "sub-col ytd";
      ytdTh.dataset.indicatorKey = ind.key;
      ytdTh.title = buildIndicatorTitle(ind.metaYtd, ind.fechaYtd);
      ytdTh.textContent = "YTD";
      row2.appendChild(ytdTh);

      const mtdTh = document.createElement("th");
      mtdTh.className = "sub-col mtd";
      mtdTh.dataset.indicatorKey = ind.key;
      mtdTh.title = buildIndicatorTitle(ind.metaMtd, ind.fechaMtd);
      mtdTh.textContent = "MTD";
      row2.appendChild(mtdTh);
    });

    thead.appendChild(row1);
    thead.appendChild(row2);
    return thead;
  }

  function buildIndicatorTitle(meta, fechaCorte) {
    const parts = [];
    if (meta !== null && meta !== undefined) parts.push(`Meta: ${formatMeta(meta)}`);
    if (fechaCorte) parts.push(`Corte: ${fechaCorte}`);
    return parts.join(" · ");
  }

  function formatMeta(meta) {
    if (typeof meta === "number") return formatPercent(meta);
    return String(meta);
  }

  function buildBody(rows, indicators) {
    const tbody = document.createElement("tbody");

    rows.forEach(({ node, depth }) => {
      const tr = document.createElement("tr");
      tr.className = levelClass(node);

      const entityTd = document.createElement("td");
      entityTd.className = "entity-col";
      entityTd.title = `${levelLabel(node)}: ${node.name}`;

      if (node.children && node.children.length) {
        const toggle = document.createElement("button");
        toggle.className = "entity-toggle";
        toggle.setAttribute("aria-label", "Expandir/colapsar");
        toggle.textContent = state.collapsed.has(node.code) ? "▸" : "▾";
        toggle.addEventListener("click", () => {
          if (state.collapsed.has(node.code)) state.collapsed.delete(node.code);
          else state.collapsed.add(node.code);
          render();
        });
        entityTd.appendChild(toggle);
      } else if (depth > 0) {
        const spacer = document.createElement("span");
        spacer.className = "entity-toggle";
        spacer.textContent = "";
        entityTd.appendChild(spacer);
      }

      const nameSpan = document.createElement("span");
      nameSpan.textContent = node.name;
      entityTd.appendChild(nameSpan);
      tr.appendChild(entityTd);

      indicators.forEach((ind) => {
        const ytdTd = document.createElement("td");
        ytdTd.className = "value-cell sub-col ytd";
        ytdTd.dataset.indicatorKey = ind.key;
        const ytdValue = node.valuesYtd ? node.valuesYtd[ind.key] : undefined;
        ytdTd.appendChild(buildCell(ytdValue, ind.metaYtd));
        tr.appendChild(ytdTd);

        const mtdTd = document.createElement("td");
        mtdTd.className = "value-cell sub-col mtd";
        mtdTd.dataset.indicatorKey = ind.key;
        const mtdValue = node.valuesMtd ? node.valuesMtd[ind.key] : undefined;
        mtdTd.appendChild(buildCell(mtdValue, ind.metaMtd));
        tr.appendChild(mtdTd);
      });

      tbody.appendChild(tr);
    });

    return tbody;
  }

  function buildCell(value, meta) {
    const wrap = document.createElement("span");
    wrap.className = "cell-inner";
    wrap.innerHTML = valueCellMarkup(value, meta);
    return wrap;
  }

  function applyIndicatorFilter() {
    const table = tableWrap.querySelector("table.matrix");
    if (!table) return;

    const groupHeaders = table.querySelectorAll("thead th.indicator-group-th");
    groupHeaders.forEach((th) => {
      const key = th.dataset.indicatorKey;
      const label = th.textContent.toLowerCase();
      const ind = state.indicatorsByKey.get(key);
      const matchesText = !state.indicatorFilter || label.includes(state.indicatorFilter);
      const matchesFoco = state.filters.foco.length === 0 || (ind && state.filters.foco.includes(ind.foco));
      const matches = matchesText && matchesFoco;
      // Un mismo data-indicator-key marca el th de grupo (fila 1), los 2 th
      // de subcolumna YTD/MTD (fila 2) y las 2 td por fila del cuerpo — se
      // ocultan todos juntos.
      table
        .querySelectorAll(`[data-indicator-key="${cssEscape(key)}"]`)
        .forEach((el) => el.classList.toggle("hidden-col", !matches));
    });
  }

  function cssEscape(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
  }

})();
