(function () {
  "use strict";

  const {
    loadCombinedData,
    walkTree,
    levelLabel,
    formatUpdatedAt,
    formatPercent,
    valueCellMarkup,
    escapeHtml,
    initThemeToggle,
  } = window.GDD;

  const FILTER_DIMS = ["territorio", "subgerencia", "agencia", "jefatura"];
  const FILTER_LABELS = {
    territorio: "Territorio",
    subgerencia: "Subgerencia",
    agencia: "Agencia",
    jefatura: "Jefatura",
  };

  const state = {
    data: null,
    // Árbol e indicadores fusionados (YTD + MTD en una sola estructura),
    // armados una vez al cargar los datos por buildCombinedData().
    combined: null,
    indicatorFilter: "",
    collapsed: null, // Set inicializado al cargar datos (colapsa territorios por defecto)
    // Cada dimensión es un array de códigos seleccionados (multi-select).
    // Los filtros son concatenados: Territorio acota las opciones de
    // Subgerencia/Agencia/Jefatura, Subgerencia acota Agencia/Jefatura, etc.
    filters: { territorio: [], subgerencia: [], agencia: [], jefatura: [] },
  };

  // Estado de los dropdowns de filtro (independiente de qué esté seleccionado):
  // qué panel está abierto y el texto de búsqueda escrito en cada uno.
  const dropdownState = {
    open: null,
    search: { territorio: "", subgerencia: "", agencia: "", jefatura: "" },
  };
  // Última lista de nodos disponibles (ya podada por la cascada) por dimensión,
  // para que los botones "Todos"/"Ninguno" y el buscador del panel no tengan
  // que recalcular el árbol.
  const dropdownNodesCache = { territorio: [], subgerencia: [], agencia: [], jefatura: [] };

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
      FILTER_DIMS.forEach((dim) => {
        state.filters[dim] = [];
      });
      populateFilterOptions();
      render();
    });
  }

  function matchesSelection(value, selected) {
    return selected.length === 0 || (value !== undefined && selected.includes(value));
  }

  function populateFilterOptions() {
    if (!state.combined) return;

    const f = state.filters;

    // Filtros concatenados en cascada, en 4 pasadas secuenciales: cada
    // dimensión se calcula (y su selección se poda) usando ya el estado
    // PODADO de la dimensión anterior — si se calcularan las 4 en una sola
    // pasada, un filtro hijo que quedó obsoleto (ej. una Subgerencia que ya
    // no pertenece al Territorio recién elegido) seguiría filtrando de más
    // durante ese mismo render, dejando Agencia/Jefatura vacíos por error.
    const territorios = [];
    walkTree(state.combined.hierarchy, (node) => {
      if (node.level === "territorio") territorios.push(node);
    });
    refreshFilterDropdown("territorio", territorios);

    const subgerencias = [];
    walkTree(state.combined.hierarchy, (node, depth, path) => {
      if (node.level === "subgerencia" && matchesSelection(path.territorio, f.territorio)) {
        subgerencias.push(node);
      }
    });
    refreshFilterDropdown("subgerencia", subgerencias);

    const agencias = [];
    walkTree(state.combined.hierarchy, (node, depth, path) => {
      if (
        node.level === "agencia" &&
        matchesSelection(path.territorio, f.territorio) &&
        matchesSelection(path.subgerencia, f.subgerencia)
      ) {
        agencias.push(node);
      }
    });
    refreshFilterDropdown("agencia", agencias);

    const jefaturas = [];
    walkTree(state.combined.hierarchy, (node, depth, path) => {
      if (
        node.level === "jefatura" &&
        matchesSelection(path.territorio, f.territorio) &&
        matchesSelection(path.subgerencia, f.subgerencia) &&
        matchesSelection(path.agencia, f.agencia)
      ) {
        jefaturas.push(node);
      }
    });
    refreshFilterDropdown("jefatura", jefaturas);
  }

  // --- Dropdown de filtro (checklist con buscador, "Todos"/"Ninguno") -----

  function buildFilterDropdowns() {
    const container = document.getElementById("filters-container");
    const clearBtn = document.getElementById("clear-filters");

    FILTER_DIMS.forEach((dim) => {
      const wrap = document.createElement("div");
      wrap.className = "filter-dropdown";
      wrap.dataset.dim = dim;

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "filter-dropdown-toggle";
      toggle.setAttribute("aria-haspopup", "true");
      toggle.setAttribute("aria-expanded", "false");
      toggle.innerHTML = `<span class="label">${FILTER_LABELS[dim]}</span><span class="caret">▾</span>`;
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleDropdown(dim);
      });

      const panel = document.createElement("div");
      panel.className = "filter-dropdown-panel";
      panel.setAttribute("role", "group");
      panel.setAttribute("aria-label", `Opciones de ${FILTER_LABELS[dim]}`);
      panel.hidden = true;
      panel.addEventListener("click", (e) => e.stopPropagation());

      const search = document.createElement("input");
      search.type = "search";
      search.className = "filter-dropdown-search";
      search.placeholder = `Buscar ${FILTER_LABELS[dim].toLowerCase()}…`;
      search.addEventListener("input", (e) => {
        dropdownState.search[dim] = e.target.value.trim().toLowerCase();
        renderDropdownOptions(dim);
      });

      const actions = document.createElement("div");
      actions.className = "filter-dropdown-actions";
      const allBtn = document.createElement("button");
      allBtn.type = "button";
      allBtn.textContent = "Seleccionar todos";
      allBtn.addEventListener("click", () => {
        // Solo selecciona lo que el buscador del panel está mostrando en
        // ese momento, no todo el universo de la dimensión — si el usuario
        // filtró por texto antes de apretar "Seleccionar todos", esperaría
        // que solo se marque lo que ve.
        state.filters[dim] = visibleDropdownNodes(dim).map((n) => n.code);
        populateFilterOptions();
        render();
      });
      const noneBtn = document.createElement("button");
      noneBtn.type = "button";
      noneBtn.textContent = "Deseleccionar";
      noneBtn.addEventListener("click", () => {
        state.filters[dim] = [];
        populateFilterOptions();
        render();
      });
      actions.appendChild(allBtn);
      actions.appendChild(noneBtn);

      const options = document.createElement("div");
      options.className = "filter-dropdown-options";

      panel.appendChild(search);
      panel.appendChild(actions);
      panel.appendChild(options);
      wrap.appendChild(toggle);
      wrap.appendChild(panel);
      container.insertBefore(wrap, clearBtn);
    });

    document.addEventListener("click", () => closeAllDropdowns());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeAllDropdowns();
    });
  }

  function toggleDropdown(dim) {
    const isOpen = dropdownState.open === dim;
    closeAllDropdowns();
    if (!isOpen) {
      dropdownState.open = dim;
      const wrap = document.querySelector(`.filter-dropdown[data-dim="${dim}"]`);
      wrap.classList.add("open");
      wrap.querySelector(".filter-dropdown-panel").hidden = false;
      wrap.querySelector(".filter-dropdown-toggle").setAttribute("aria-expanded", "true");
    }
  }

  function closeAllDropdowns() {
    dropdownState.open = null;
    document.querySelectorAll(".filter-dropdown").forEach((wrap) => {
      wrap.classList.remove("open");
      wrap.querySelector(".filter-dropdown-panel").hidden = true;
      wrap.querySelector(".filter-dropdown-toggle").setAttribute("aria-expanded", "false");
    });
  }

  function visibleDropdownNodes(dim) {
    const search = dropdownState.search[dim];
    return (dropdownNodesCache[dim] || [])
      .filter((n) => !search || n.name.toLowerCase().includes(search))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, "es"));
  }

  function refreshFilterDropdown(dim, nodes) {
    dropdownNodesCache[dim] = nodes;

    // Poda del propio state: una selección que la cascada dejó fuera (ej. se
    // cambió Territorio y esa Subgerencia ya no pertenece) se descarta.
    const validCodes = new Set(nodes.map((n) => n.code));
    const kept = state.filters[dim].filter((v) => validCodes.has(v));
    state.filters[dim].length = 0;
    state.filters[dim].push(...kept);

    const wrap = document.querySelector(`.filter-dropdown[data-dim="${dim}"]`);
    const toggle = wrap.querySelector(".filter-dropdown-toggle");
    const count = state.filters[dim].length;
    const badge = count > 0 ? `<span class="count-badge">${count}</span>` : "";
    toggle.querySelector(".label").outerHTML = `<span class="label">${FILTER_LABELS[dim]}</span>${badge}`;

    renderDropdownOptions(dim);
  }

  function renderDropdownOptions(dim) {
    const wrap = document.querySelector(`.filter-dropdown[data-dim="${dim}"]`);
    const optionsEl = wrap.querySelector(".filter-dropdown-options");
    const nodes = visibleDropdownNodes(dim);

    optionsEl.innerHTML = "";
    if (!nodes.length) {
      const empty = document.createElement("div");
      empty.className = "filter-dropdown-empty";
      empty.textContent = "Sin opciones disponibles.";
      optionsEl.appendChild(empty);
      return;
    }

    nodes.forEach((n) => {
      const optionLabel = document.createElement("label");
      optionLabel.className = "filter-dropdown-option";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = state.filters[dim].includes(n.code);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          if (!state.filters[dim].includes(n.code)) state.filters[dim].push(n.code);
        } else {
          state.filters[dim] = state.filters[dim].filter((c) => c !== n.code);
        }
        populateFilterOptions();
        render();
      });
      const text = document.createElement("span");
      text.textContent = n.name;
      optionLabel.appendChild(checkbox);
      optionLabel.appendChild(text);
      optionsEl.appendChild(optionLabel);
    });
  }

  function hasActiveFilter() {
    return FILTER_DIMS.some((dim) => state.filters[dim].length > 0);
  }

  function nodeMatchesFilters(node, path) {
    const f = state.filters;
    if (!matchesSelection(path.territorio, f.territorio)) return false;
    if (!matchesSelection(path.subgerencia, f.subgerencia)) return false;
    if (!matchesSelection(path.agencia, f.agencia)) return false;
    if (f.jefatura.length) {
      if (node.level !== "jefatura" || !f.jefatura.includes(node.code)) return false;
    }
    return true;
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
          state.filters[dim] = state.filters[dim].filter((v) => v !== code);
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
      const matches = !state.indicatorFilter || label.includes(state.indicatorFilter);
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
