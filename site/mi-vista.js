(function () {
  "use strict";

  const {
    loadCombinedData,
    levelLabel,
    formatUpdatedAt,
    computeStatus,
    valueCellMarkup,
    escapeHtml,
    safeGet,
    safeSet,
    initThemeToggle,
  } = window.GDD;

  const STORAGE_KEY = "gdd-my-entity-code";

  const state = {
    data: null,
    combined: null,
    entityIndex: [], // lista plana {code, name, level, breadcrumb, node}
    selected: null, // entrada de entityIndex actualmente elegida
  };

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
  // node}. `breadcrumb` es la cadena de nombres de ancestros (sin incluir el
  // nodo TOTAL, que es implícito, ni el nodo mismo).
  function flattenEntities(root) {
    const out = [];
    const step = (node, trail) => {
      out.push({ code: node.code, name: node.name, level: node.level, node, breadcrumb: trail.join(" › ") });
      const childTrail = node.level === "total" ? trail : [...trail, node.name];
      (node.children || []).forEach((child) => step(child, childTrail));
    };
    step(root, []);
    return out;
  }

  function bindControls() {
    searchInput.addEventListener("input", () => renderResults(searchInput.value.trim().toLowerCase()));
    searchInput.addEventListener("focus", () => renderResults(searchInput.value.trim().toLowerCase()));
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".entity-picker")) resultsEl.hidden = true;
    });

    document.getElementById("entity-change").addEventListener("click", showPicker);
  }

  function showPicker() {
    selectedBar.hidden = true;
    myView.innerHTML = `<p class="muted">Busca tu territorio, subgerencia, agencia o nombre arriba para ver tus indicadores.</p>`;
    summaryEl.hidden = true;
    searchInput.value = "";
    searchInput.focus();
    renderResults("");
  }

  function renderResults(query) {
    if (!state.entityIndex.length) return;
    const matches = state.entityIndex
      .filter((e) => e.level !== "total")
      .filter((e) => !query || e.name.toLowerCase().includes(query) || e.breadcrumb.toLowerCase().includes(query))
      .slice(0, 25);

    resultsEl.innerHTML = "";
    if (!matches.length) {
      resultsEl.hidden = !query;
      if (query) {
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

    selectedBar.hidden = false;
    // Un Territorio no tiene ancestros que mostrar (breadcrumb vacío) — eso
    // no significa "toda la red", solo que ya es el nivel más alto que se
    // puede elegir (el nodo TOTAL en sí nunca aparece en el buscador).
    breadcrumbEl.textContent = entry.breadcrumb;
    titleEl.textContent = `${entry.name} · ${levelLabel(entry)}`;

    renderMyView(entry.node);
  }

  function renderMyView(node) {
    const indicators = state.combined.indicators;
    myView.innerHTML = "";
    renderSummary(node, indicators);

    const grid = document.createElement("div");
    grid.className = "stat-grid";

    indicators.forEach((ind) => {
      grid.appendChild(buildStatTile(ind, node));
    });

    myView.appendChild(grid);
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

  function buildStatTile(ind, node) {
    const tile = document.createElement("div");
    tile.className = "stat-tile";

    const label = document.createElement("div");
    label.className = "stat-label";
    label.textContent = ind.label;
    label.title = ind.label;
    tile.appendChild(label);

    tile.appendChild(buildStatRow("YTD", node.valuesYtd ? node.valuesYtd[ind.key] : undefined, ind.metaYtd));
    tile.appendChild(buildStatRow("MTD", node.valuesMtd ? node.valuesMtd[ind.key] : undefined, ind.metaMtd));

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
