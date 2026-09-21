(function () {
  "use strict";

  const FILTER_DIMS = ["territorio", "subgerencia", "agencia", "jefatura"];
  const FILTER_LABELS = {
    territorio: "Territorio",
    subgerencia: "Subgerencia",
    agencia: "Agencia",
    jefatura: "Jefatura",
  };

  const state = {
    data: null,
    view: "weekly",
    indicatorFilter: "",
    collapsed: null, // Set inicializado al cargar datos (colapsa territorios por defecto)
    // Cada dimensión es un array de códigos seleccionados (multi-select).
    // Los filtros son concatenados: Territorio acota las opciones de
    // Subgerencia/Agencia/Jefatura, Subgerencia acota Agencia/Jefatura, etc.
    filters: { territorio: [], subgerencia: [], agencia: [], jefatura: [] },
  };

  const tableWrap = document.getElementById("table-wrap");
  const updatedAtEl = document.getElementById("updated-at");

  init();

  async function init() {
    bindControls();
    try {
      const res = await fetch("data/indicadores.json", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.data = await res.json();
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
    const viewData = state.data[state.view];
    if (!viewData) return;
    viewData.hierarchy.children.forEach((territorio) => {
      state.collapsed.add(territorio.code);
    });
  }

  function bindControls() {
    document.querySelectorAll(".view-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".view-btn").forEach((b) => {
          b.classList.remove("active");
          b.setAttribute("aria-selected", "false");
        });
        btn.classList.add("active");
        btn.setAttribute("aria-selected", "true");
        state.view = btn.dataset.view;
        resetCollapsedDefault();
        populateFilterOptions();
        render();
      });
    });

    document.getElementById("indicator-search").addEventListener("input", (e) => {
      state.indicatorFilter = e.target.value.trim().toLowerCase();
      applyIndicatorFilter();
    });

    FILTER_DIMS.forEach((dim) => {
      document.getElementById(`filter-${dim}`).addEventListener("change", (e) => {
        state.filters[dim] = [...e.target.selectedOptions].map((o) => o.value);
        // Cambiar un filtro más "arriba" en la jerarquía recalcula las
        // opciones de los de abajo (cascada) y descarta selecciones que ya
        // no pertenezcan a lo elegido, para que nunca queden dos filtros
        // que no puedan calzar a la vez.
        populateFilterOptions();
        render();
      });
    });
    document.getElementById("clear-filters").addEventListener("click", () => {
      FILTER_DIMS.forEach((dim) => {
        state.filters[dim] = [];
      });
      populateFilterOptions();
      render();
    });

    const themeToggle = document.getElementById("theme-toggle");
    const saved = safeGet("gdd-theme");
    if (saved) document.documentElement.setAttribute("data-theme", saved);
    themeToggle.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme");
      const next = current === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      safeSet("gdd-theme", next);
    });
  }

  function formatUpdatedAt(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      const fmt = new Intl.DateTimeFormat("es-CL", {
        dateStyle: "long",
        timeStyle: "short",
        timeZone: "America/Santiago",
      });
      return `Actualizado: ${fmt.format(d)} (hora Chile)`;
    } catch {
      return `Actualizado: ${iso}`;
    }
  }

  // --- Recorrido del árbol con "path" jerárquico por nodo -----------------
  // path.territorio / .subgerencia / .agencia / .jefatura llevan el código
  // del ancestro de ese nivel, cuando existe. Agencia solo hereda
  // territorio (la planilla no liga Agencia -> Subgerencia); Jefatura
  // hereda Subgerencia cuando cuelga de una, o solo Territorio si es un
  // cargo a nivel territorial.
  function walkTree(root, visit) {
    const step = (node, depth, path, parent) => {
      const nextPath = { ...path };
      if (node.level === "territorio") nextPath.territorio = node.code;
      else if (node.level === "subgerencia") nextPath.subgerencia = node.code;
      else if (node.level === "agencia") nextPath.agencia = node.code;
      else if (node.level === "jefatura") nextPath.jefatura = node.code;

      visit(node, depth, nextPath, parent);
      (node.children || []).forEach((child) => step(child, depth + 1, nextPath, node));
    };
    step(root, 0, {}, null);
  }

  function matchesSelection(value, selected) {
    return selected.length === 0 || (value !== undefined && selected.includes(value));
  }

  function populateFilterOptions() {
    const viewData = state.data[state.view];
    if (!viewData) return;

    const f = state.filters;

    // Filtros concatenados en cascada, en 4 pasadas secuenciales: cada
    // dimensión se calcula (y su selección se poda) usando ya el estado
    // PODADO de la dimensión anterior — si se calcularan las 4 en una sola
    // pasada, un filtro hijo que quedó obsoleto (ej. una Subgerencia que ya
    // no pertenece al Territorio recién elegido) seguiría filtrando de más
    // durante ese mismo render, dejando Agencia/Jefatura vacíos por error.
    const territorios = [];
    walkTree(viewData.hierarchy, (node) => {
      if (node.level === "territorio") territorios.push(node);
    });
    fillMultiSelect("filter-territorio", territorios, f.territorio);

    const subgerencias = [];
    walkTree(viewData.hierarchy, (node, depth, path) => {
      if (node.level === "subgerencia" && matchesSelection(path.territorio, f.territorio)) {
        subgerencias.push(node);
      }
    });
    fillMultiSelect("filter-subgerencia", subgerencias, f.subgerencia);

    const agencias = [];
    walkTree(viewData.hierarchy, (node, depth, path) => {
      if (
        node.level === "agencia" &&
        matchesSelection(path.territorio, f.territorio) &&
        matchesSelection(path.subgerencia, f.subgerencia)
      ) {
        agencias.push(node);
      }
    });
    fillMultiSelect("filter-agencia", agencias, f.agencia);

    const jefaturas = [];
    walkTree(viewData.hierarchy, (node, depth, path) => {
      if (
        node.level === "jefatura" &&
        matchesSelection(path.territorio, f.territorio) &&
        matchesSelection(path.subgerencia, f.subgerencia) &&
        matchesSelection(path.agencia, f.agencia)
      ) {
        jefaturas.push(node);
      }
    });
    fillMultiSelect("filter-jefatura", jefaturas, f.jefatura);
  }

  function fillMultiSelect(id, nodes, selectedValues) {
    const select = document.getElementById(id);
    const validCodes = new Set(nodes.map((n) => n.code));
    // Poda del propio state: una selección que la cascada dejó fuera (ej. se
    // cambió Territorio y esa Subgerencia ya no pertenece) se descarta.
    const kept = selectedValues.filter((v) => validCodes.has(v));
    selectedValues.length = 0;
    selectedValues.push(...kept);

    select.innerHTML = "";
    nodes
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, "es"))
      .forEach((n) => {
        const opt = document.createElement("option");
        opt.value = n.code;
        opt.textContent = n.name;
        opt.selected = selectedValues.includes(n.code);
        select.appendChild(opt);
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
      const select = document.getElementById(`filter-${dim}`);
      state.filters[dim].forEach((code) => {
        const option = [...select.options].find((o) => o.value === code);
        const label = option ? option.textContent : code;
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
    const viewData = state.data[state.view];
    if (!viewData) {
      tableWrap.innerHTML = `<p class="muted">No hay datos para esta vista.</p>`;
      return;
    }
    const indicators = Object.entries(viewData.indicators).map(([key, meta]) => ({
      key,
      ...meta,
    }));

    const rows = buildVisibleRows(viewData.hierarchy);

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

  function levelLabel(node) {
    return { total: "Total", territorio: "Territorio", subgerencia: "Subgerencia", agencia: "Agencia", jefatura: "Jefatura" }[
      node.level
    ] || node.level;
  }

  function buildHead(indicators) {
    const thead = document.createElement("thead");
    const tr = document.createElement("tr");
    const entityTh = document.createElement("th");
    entityTh.className = "entity-col";
    entityTh.textContent = "Territorio / Subgerencia / Agencia / Jefatura";
    tr.appendChild(entityTh);

    indicators.forEach((ind) => {
      const th = document.createElement("th");
      th.dataset.indicatorKey = ind.key;
      th.title = buildIndicatorTitle(ind);
      th.textContent = ind.label;
      tr.appendChild(th);
    });

    thead.appendChild(tr);
    return thead;
  }

  function buildIndicatorTitle(ind) {
    const parts = [];
    if (ind.meta !== null && ind.meta !== undefined) parts.push(`Meta: ${formatMeta(ind.meta)}`);
    if (ind.fecha_corte) parts.push(`Corte: ${ind.fecha_corte}`);
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
        const td = document.createElement("td");
        td.className = "value-cell";
        td.dataset.indicatorKey = ind.key;
        const value = node.values ? node.values[ind.key] : undefined;
        td.appendChild(buildCell(value, ind));
        tr.appendChild(td);
      });

      tbody.appendChild(tr);
    });

    return tbody;
  }

  function buildCell(value, indicator) {
    const wrap = document.createElement("span");
    wrap.className = "cell-inner";

    if (value === undefined || value === null) {
      wrap.innerHTML = `<span class="status-icon neutral">·</span><span>—</span>`;
      return wrap;
    }

    const hasNumericMeta = typeof indicator.meta === "number" && indicator.meta > 0;
    if (!hasNumericMeta || typeof value !== "number") {
      wrap.innerHTML = `<span class="status-icon neutral">·</span><span>${escapeHtml(
        formatRaw(value)
      )}</span>`;
      return wrap;
    }

    const ratio = value / indicator.meta;
    const status = ratio >= 1 ? "good" : ratio >= 0.8 ? "warning" : "critical";
    const icon = status === "good" ? "✓" : status === "warning" ? "!" : "✕";
    wrap.innerHTML = `<span class="status-icon ${status}">${icon}</span><span>${formatPercent(
      value
    )}</span>`;
    return wrap;
  }

  function formatRaw(value) {
    if (typeof value === "number") {
      return Number.isInteger(value) ? String(value) : value.toFixed(2);
    }
    return String(value);
  }

  function formatPercent(value) {
    return `${(value * 100).toFixed(1)}%`;
  }

  function applyIndicatorFilter() {
    const table = tableWrap.querySelector("table.matrix");
    if (!table) return;

    const headerCells = table.querySelectorAll("thead th[data-indicator-key]");
    headerCells.forEach((th) => {
      const key = th.dataset.indicatorKey;
      const label = th.textContent.toLowerCase();
      const matches = !state.indicatorFilter || label.includes(state.indicatorFilter);
      th.classList.toggle("hidden-col", !matches);
      table
        .querySelectorAll(`td[data-indicator-key="${cssEscape(key)}"]`)
        .forEach((td) => td.classList.toggle("hidden-col", !matches));
    });
  }

  function cssEscape(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  function safeGet(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  function safeSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  }
})();
