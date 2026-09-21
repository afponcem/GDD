(function () {
  "use strict";

  const state = {
    data: null,
    view: "weekly",
    indicatorFilter: "",
    collapsed: null, // Set inicializado al cargar datos (colapsa territorios por defecto)
    filters: { territorio: "", subgerencia: "", agencia: "", jefatura: "" },
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

    document.getElementById("filter-territorio").addEventListener("change", (e) => {
      state.filters.territorio = e.target.value;
      // Subgerencia/Agencia son hijos de Territorio: al cambiarlo, sus
      // opciones se recalculan y una selección que ya no pertenezca al
      // territorio elegido se limpia (si no, quedan dos filtros que nunca
      // pueden calzar a la vez y la tabla muestra "sin resultados" sin
      // explicación).
      populateFilterOptions();
      state.filters.subgerencia = document.getElementById("filter-subgerencia").value;
      state.filters.agencia = document.getElementById("filter-agencia").value;
      render();
    });
    ["subgerencia", "agencia"].forEach((dim) => {
      document.getElementById(`filter-${dim}`).addEventListener("change", (e) => {
        state.filters[dim] = e.target.value;
        render();
      });
    });
    document.getElementById("filter-jefatura").addEventListener("input", (e) => {
      state.filters.jefatura = e.target.value.trim().toLowerCase();
      render();
    });
    document.getElementById("clear-filters").addEventListener("click", () => {
      state.filters = { territorio: "", subgerencia: "", agencia: "", jefatura: "" };
      document.getElementById("filter-territorio").value = "";
      document.getElementById("filter-subgerencia").value = "";
      document.getElementById("filter-agencia").value = "";
      document.getElementById("filter-jefatura").value = "";
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

  function populateFilterOptions() {
    const viewData = state.data[state.view];
    if (!viewData) return;

    const territorioFilter = state.filters.territorio;
    const territorios = [];
    const subgerencias = [];
    const agencias = [];
    const jefaturas = [];

    // Subgerencia y Agencia se acotan al territorio elegido (cascada), para
    // que no queden dos selects que nunca puedan calzar a la vez.
    walkTree(viewData.hierarchy, (node, depth, path) => {
      if (node.level === "territorio") territorios.push(node);
      if (node.level === "subgerencia" && (!territorioFilter || path.territorio === territorioFilter)) {
        subgerencias.push(node);
      }
      if (node.level === "agencia" && (!territorioFilter || path.territorio === territorioFilter)) {
        agencias.push(node);
      }
      if (node.level === "jefatura") jefaturas.push(node);
    });

    fillSelect("filter-territorio", territorios, "Todos");
    fillSelect("filter-subgerencia", subgerencias, "Todas");
    fillSelect("filter-agencia", agencias, "Todas");

    const datalist = document.getElementById("jefatura-options");
    datalist.innerHTML = "";
    jefaturas
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, "es"))
      .forEach((j) => {
        const opt = document.createElement("option");
        opt.value = j.name;
        datalist.appendChild(opt);
      });
  }

  function fillSelect(id, nodes, placeholderLabel) {
    const select = document.getElementById(id);
    const current = select.value;
    select.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = placeholderLabel;
    select.appendChild(placeholder);
    nodes
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, "es"))
      .forEach((n) => {
        const opt = document.createElement("option");
        opt.value = n.code;
        opt.textContent = n.name;
        select.appendChild(opt);
      });
    select.value = current && [...select.options].some((o) => o.value === current) ? current : "";
  }

  function hasActiveFilter() {
    return Boolean(
      state.filters.territorio ||
        state.filters.subgerencia ||
        state.filters.agencia ||
        state.filters.jefatura
    );
  }

  function nodeMatchesFilters(node, path) {
    const f = state.filters;
    if (f.territorio && path.territorio !== f.territorio) return false;
    if (f.subgerencia && path.subgerencia !== f.subgerencia) return false;
    if (f.agencia && path.agencia !== f.agencia) return false;
    if (f.jefatura) {
      if (node.level !== "jefatura") return false;
      if (!node.name.toLowerCase().includes(f.jefatura)) return false;
    }
    return true;
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
