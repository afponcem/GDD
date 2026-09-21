(function () {
  "use strict";

  const state = {
    data: null,
    view: "weekly",
    entityFilter: "",
    indicatorFilter: "",
    collapsed: new Set(), // codes of collapsed territorio nodes
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
      render();
    } catch (err) {
      tableWrap.innerHTML = `<p class="muted">No se pudieron cargar los datos (${escapeHtml(
        String(err)
      )}). Si esto persiste fuera de una corrida de prueba, revisa el workflow de actualización.</p>`;
    }
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
        render();
      });
    });

    document.getElementById("entity-search").addEventListener("input", (e) => {
      state.entityFilter = e.target.value.trim().toLowerCase();
      applyFilters();
    });
    document.getElementById("indicator-search").addEventListener("input", (e) => {
      state.indicatorFilter = e.target.value.trim().toLowerCase();
      applyFilters();
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

    const rows = [];
    flattenTree(viewData.hierarchy, rows, 0);

    const table = document.createElement("table");
    table.className = "matrix";
    table.appendChild(buildHead(indicators));
    table.appendChild(buildBody(rows, indicators));

    tableWrap.innerHTML = "";
    tableWrap.appendChild(table);
    applyFilters();
  }

  function flattenTree(node, out, depth) {
    out.push({ node, depth });
    if (node.children && node.children.length && !state.collapsed.has(node.code)) {
      node.children.forEach((child) => flattenTree(child, out, depth + 1));
    }
  }

  function levelClass(node) {
    if (node.level === "total") return "level-total";
    if (node.level === "territorio") return "level-territorio";
    return "level-subgerencia";
  }

  function buildHead(indicators) {
    const thead = document.createElement("thead");
    const tr = document.createElement("tr");
    const entityTh = document.createElement("th");
    entityTh.className = "entity-col";
    entityTh.textContent = "Territorio / Subgerencia";
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
      tr.dataset.entityCode = node.code;
      tr.dataset.entityName = node.name.toLowerCase();

      const entityTd = document.createElement("td");
      entityTd.className = "entity-col";

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

  function applyFilters() {
    const table = tableWrap.querySelector("table.matrix");
    if (!table) return;

    const rows = table.querySelectorAll("tbody tr");
    rows.forEach((tr) => {
      const matches =
        !state.entityFilter || tr.dataset.entityName.includes(state.entityFilter);
      tr.classList.toggle("hidden-row", !matches);
    });

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
