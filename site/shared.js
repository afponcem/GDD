// Funciones compartidas entre index.html (tabla completa) y mi-vista.html
// (vista individual de una sola pantalla). Se carga antes que el script de
// cada página (<script src="shared.js">), que las usa vía `window.GDD`.
window.GDD = (function () {
  "use strict";

  // --- Fusión de las vistas Semanal (MTD) y Acumulado (YTD) en un solo árbol ---
  // Cada nodo fusionado guarda valuesYtd/valuesMtd por separado en vez de
  // un único `values`, y los hijos se unen por código (unión, no intersección
  // — si una entidad solo existe en una de las dos hojas, igual aparece,
  // con la otra columna en blanco). Ver .claude/skills/indicadores-sharepoint/
  // SKILL.md § "Vista combinada YTD/MTD" para el caso borde de personal que
  // solo aparece en una de las dos hojas.
  function buildCombinedData(weekly, ytd) {
    const indicatorsMap = new Map();
    [weekly.indicators, ytd.indicators].forEach((catalog) => {
      Object.entries(catalog || {}).forEach(([key, meta]) => {
        if (!indicatorsMap.has(key)) indicatorsMap.set(key, meta.label);
      });
    });
    const indicators = [...indicatorsMap.keys()].map((key) => {
      const w = weekly.indicators[key];
      const y = ytd.indicators[key];
      return {
        key,
        label: indicatorsMap.get(key),
        foco: (w && w.foco) || (y && y.foco) || null,
        metaYtd: y ? y.meta : undefined,
        metaMtd: w ? w.meta : undefined,
        fechaYtd: y ? y.fecha_corte : undefined,
        fechaMtd: w ? w.fecha_corte : undefined,
      };
    });

    return { hierarchy: mergeHierarchyNode(weekly.hierarchy, ytd.hierarchy), indicators };
  }

  function mergeHierarchyNode(weeklyNode, ytdNode) {
    const base = weeklyNode || ytdNode;
    const node = {
      code: base.code,
      name: base.name,
      level: base.level,
      valuesYtd: (ytdNode && ytdNode.values) || {},
      valuesMtd: (weeklyNode && weeklyNode.values) || {},
      children: [],
    };

    const wChildren = (weeklyNode && weeklyNode.children) || [];
    const yChildren = (ytdNode && ytdNode.children) || [];
    const yByCode = new Map(yChildren.map((c) => [c.code, c]));
    const usedYtdCodes = new Set();
    const pairs = wChildren.map((wc) => {
      const yc = yByCode.get(wc.code) || null;
      if (yc) usedYtdCodes.add(wc.code);
      return [wc, yc];
    });
    yChildren.forEach((yc) => {
      if (!usedYtdCodes.has(yc.code)) pairs.push([null, yc]);
    });

    node.children = pairs.map(([wc, yc]) => mergeHierarchyNode(wc, yc));
    return node;
  }

  // Recorrido del árbol con "path" jerárquico por nodo: path.territorio /
  // .subgerencia / .agencia / .jefatura llevan el código del ancestro de ese
  // nivel, cuando existe. Agencia solo hereda territorio (la planilla no
  // liga Agencia -> Subgerencia en la sección AGENCIAS); Jefatura hereda
  // Subgerencia cuando cuelga de una, o solo Territorio si es un cargo a
  // nivel territorial.
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

  // --- Filtros en cascada Territorio -> Subgerencia -> Agencia -> Jefatura
  // (usado tanto por la Tabla completa, para acotar filas, como por Mi
  // vista, para acotar el buscador de entidad) -------------------------------

  function matchesSelection(value, selected) {
    return selected.length === 0 || (value !== undefined && selected.includes(value));
  }

  // Recalcula, en 4 pasadas secuenciales, las opciones disponibles de cada
  // dimensión dado el estado (ya podado) de las anteriores: si se hicieran
  // en una sola pasada, un filtro hijo obsoleto (ej. una Subgerencia que dejó
  // de pertenecer al Territorio recién elegido) seguiría filtrando de más
  // durante ese mismo cálculo, dejando Agencia/Jefatura vacíos por error.
  function computeEntityFilterOptions(hierarchy, filters) {
    const out = { territorio: [], subgerencia: [], agencia: [], jefatura: [] };

    walkTree(hierarchy, (node) => {
      if (node.level === "territorio") out.territorio.push(node);
    });

    walkTree(hierarchy, (node, depth, path) => {
      if (node.level === "subgerencia" && matchesSelection(path.territorio, filters.territorio)) {
        out.subgerencia.push(node);
      }
    });

    walkTree(hierarchy, (node, depth, path) => {
      if (
        node.level === "agencia" &&
        matchesSelection(path.territorio, filters.territorio) &&
        matchesSelection(path.subgerencia, filters.subgerencia)
      ) {
        out.agencia.push(node);
      }
    });

    walkTree(hierarchy, (node, depth, path) => {
      if (
        node.level === "jefatura" &&
        matchesSelection(path.territorio, filters.territorio) &&
        matchesSelection(path.subgerencia, filters.subgerencia) &&
        matchesSelection(path.agencia, filters.agencia)
      ) {
        out.jefatura.push(node);
      }
    });

    return out;
  }

  // `path` es el path de ancestros (ver walkTree); `level`/`code` son los del
  // nodo/entrada evaluado. Jefatura es un caso especial (a diferencia de
  // Territorio/Subgerencia/Agencia, que acotan por ascendencia): al ser el
  // nivel más específico, seleccionar una Jefatura debe mostrar solo esa
  // persona puntual, no "todo lo que cuelgue de ella" (no tiene hijos).
  function entityMatchesFilters(path, level, code, filters) {
    if (!matchesSelection(path.territorio, filters.territorio)) return false;
    if (!matchesSelection(path.subgerencia, filters.subgerencia)) return false;
    if (!matchesSelection(path.agencia, filters.agencia)) return false;
    if (filters.jefatura.length) {
      if (level !== "jefatura" || !filters.jefatura.includes(code)) return false;
    }
    return true;
  }

  // --- Color por Foco (identidad categórica, orden fijo — ver skill dataviz:
  // "Assign categorical hues in fixed order, never cycled"). Los 6 focos de
  // negocio son una taxonomía conocida y estable (no una serie abierta que
  // crece con cada filtro), así que el mapeo va harcodeado por nombre en vez
  // de asignarse dinámicamente. Un foco fuera de esta lista (o sin foco)
  // usa gris neutro — nunca un 7mo tono categórico sin validar. Se usa tanto
  // en la Tabla completa (encabezado de columna) como en Mi vista (tarjetas
  // agrupadas), para que el mismo Foco se vea siempre del mismo color en
  // toda la app.
  const FOCO_ORDER = [
    "Captación",
    "Fidelización",
    "Gestión Preventiva",
    "MCE (Modelo Cultura y Experiencia)",
    "Procesos Regulatorios",
    "Productos y Servicios",
  ];
  const FOCO_COLOR_VARS = {
    "Captación": "--series-1",
    "Fidelización": "--series-2",
    "Gestión Preventiva": "--series-3",
    "MCE (Modelo Cultura y Experiencia)": "--series-4",
    "Procesos Regulatorios": "--series-5",
    "Productos y Servicios": "--series-6",
  };

  function focoColorVar(foco) {
    return FOCO_COLOR_VARS[foco] || "--text-muted";
  }

  // Ordena una lista de focos presentes en los datos según FOCO_ORDER (los
  // focos conocidos primero, en su orden fijo; cualquier otro nombre —o
  // "Sin foco"— al final, en orden alfabético).
  function sortFocos(focos) {
    return [...focos].sort((a, b) => {
      const ia = FOCO_ORDER.indexOf(a);
      const ib = FOCO_ORDER.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.localeCompare(b, "es");
    });
  }

  function levelLabel(node) {
    return (
      {
        total: "Total",
        territorio: "Territorio",
        subgerencia: "Subgerencia",
        agencia: "Agencia",
        jefatura: "Jefatura",
      }[node.level] || node.level
    );
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

  function formatPercent(value) {
    return `${Math.round(value * 100)}%`;
  }

  // Semáforo de cumplimiento: mismo criterio en la tabla completa y en "Mi
  // vista" (>=100% meta = cumple, >=80% = alerta, si no bajo meta). Sin
  // meta numérica (indicador de valor absoluto) o sin dato, queda neutro.
  function computeStatus(value, meta) {
    if (value === undefined || value === null) return { status: "neutral", icon: "·" };
    const hasNumericMeta = typeof meta === "number" && meta > 0;
    if (!hasNumericMeta || typeof value !== "number") return { status: "neutral", icon: "·" };
    const ratio = value / meta;
    if (ratio >= 1) return { status: "good", icon: "✓" };
    if (ratio >= 0.8) return { status: "warning", icon: "!" };
    return { status: "critical", icon: "✕" };
  }

  // Markup compartido de una celda de valor (ícono de semáforo + texto) —
  // usado por la tabla completa (celdas YTD/MTD) y por "Mi vista" (tarjetas
  // de indicador), para que ambas vistas queden idénticas por construcción.
  function valueCellMarkup(value, meta) {
    const { status, icon } = computeStatus(value, meta);
    if (value === undefined || value === null) {
      return `<span class="status-icon neutral">${icon}</span><span>—</span>`;
    }
    if (status === "neutral") {
      return `<span class="status-icon neutral">${icon}</span><span>${escapeHtml(formatRaw(value))}</span>`;
    }
    return `<span class="status-icon ${status}">${icon}</span><span>${formatPercent(value)}</span>`;
  }

  function formatRaw(value) {
    if (typeof value === "number") {
      return Number.isInteger(value) ? String(value) : value.toFixed(2);
    }
    return String(value);
  }

  function escapeHtml(str) {
    return str.replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[c])
    );
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

  // Datos del JSON, cacheados en una sola promesa: si la página tiene varias
  // pestañas/módulos (tabla completa + Mi vista) que necesitan los mismos
  // datos, solo se hace un fetch, no uno por módulo. window.__EMBEDDED_DATA__,
  // cuando está presente, reemplaza el fetch — lo usa el .html standalone
  // (datos incrustados, sin servidor).
  let dataPromise = null;
  function loadIndicadoresData() {
    if (window.__EMBEDDED_DATA__) return Promise.resolve(window.__EMBEDDED_DATA__);
    if (!dataPromise) {
      dataPromise = fetch("data/indicadores.json", { cache: "no-store" })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .catch((err) => {
          // No dejar una promesa rechazada cacheada para siempre — un fallo
          // transitorio (red, GitHub Pages) no debe bloquear reintentos del
          // otro módulo de pestaña, o de una futura acción "reintentar".
          dataPromise = null;
          throw err;
        });
    }
    return dataPromise;
  }

  // Árbol+indicadores fusionados (YTD/MTD), cacheados igual que los datos
  // crudos: tabla completa y Mi vista corren a la vez en la misma página y
  // piden lo mismo — sin este caché, buildCombinedData() (que recorre todo
  // el árbol) se ejecutaría dos veces por carga en vez de una.
  let combinedDataPromise = null;
  function loadCombinedData() {
    if (!combinedDataPromise) {
      combinedDataPromise = loadIndicadoresData().then((data) => ({
        data,
        combined: buildCombinedData(data.weekly, data.ytd),
      }));
      combinedDataPromise.catch(() => {
        combinedDataPromise = null;
      });
    }
    return combinedDataPromise;
  }

  // --- Dropdown de filtro reutilizable (checklist con buscador, "Todos"/
  // "Ninguno") --------------------------------------------------------------
  // Usado tanto por la tabla completa (Territorio/Subgerencia/Agencia/
  // Jefatura/Foco) como por Mi vista (Foco): antes vivía duplicado en
  // app.js y mi-vista.js.
  //
  // La lista de opciones y el estado de selección son responsabilidad del
  // que llama: `selected` es un array que este componente muta in-place
  // (push/splice), nunca lo reemplaza, para que quien lo posea (ej.
  // `state.filters.foco`) siga viendo los cambios sin tener que releerlo.
  const openChecklistDropdowns = new Set();
  let checklistGlobalListenersBound = false;

  function closeAllChecklistDropdowns() {
    openChecklistDropdowns.forEach((close) => close());
    openChecklistDropdowns.clear();
  }

  function bindChecklistGlobalListenersOnce() {
    if (checklistGlobalListenersBound) return;
    checklistGlobalListenersBound = true;
    document.addEventListener("click", () => closeAllChecklistDropdowns());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeAllChecklistDropdowns();
    });
  }

  function createChecklistDropdown({ dim, label, selected, onSelectionChange }) {
    bindChecklistGlobalListenersOnce();
    let nodesCache = [];
    let searchText = "";

    const wrap = document.createElement("div");
    wrap.className = "filter-dropdown";
    wrap.dataset.dim = dim;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "filter-dropdown-toggle";
    toggle.setAttribute("aria-haspopup", "true");
    toggle.setAttribute("aria-expanded", "false");
    toggle.innerHTML = `<span class="label">${label}</span><span class="caret">▾</span>`;
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      if (wrap.classList.contains("open")) close();
      else open();
    });

    const panel = document.createElement("div");
    panel.className = "filter-dropdown-panel";
    panel.setAttribute("role", "group");
    panel.setAttribute("aria-label", `Opciones de ${label}`);
    panel.hidden = true;
    panel.addEventListener("click", (e) => e.stopPropagation());

    const search = document.createElement("input");
    search.type = "search";
    search.className = "filter-dropdown-search";
    search.placeholder = `Buscar ${label.toLowerCase()}…`;
    search.addEventListener("input", (e) => {
      searchText = e.target.value.trim().toLowerCase();
      renderOptions();
    });

    const actions = document.createElement("div");
    actions.className = "filter-dropdown-actions";
    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.textContent = "Seleccionar todos";
    allBtn.addEventListener("click", () => {
      // Solo selecciona lo que el buscador del panel está mostrando en ese
      // momento, no todo el universo de la dimensión.
      const visible = visibleNodes();
      selected.length = 0;
      selected.push(...visible.map((n) => n.code));
      refresh(nodesCache);
      onSelectionChange();
    });
    const noneBtn = document.createElement("button");
    noneBtn.type = "button";
    noneBtn.textContent = "Deseleccionar";
    noneBtn.addEventListener("click", () => {
      selected.length = 0;
      refresh(nodesCache);
      onSelectionChange();
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

    function open() {
      closeAllChecklistDropdowns();
      wrap.classList.add("open");
      panel.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
      openChecklistDropdowns.add(close);
    }

    function close() {
      wrap.classList.remove("open");
      panel.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      openChecklistDropdowns.delete(close);
    }

    function visibleNodes() {
      return nodesCache
        .filter((n) => !searchText || n.name.toLowerCase().includes(searchText))
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, "es"));
    }

    function renderOptions() {
      const nodes = visibleNodes();
      options.innerHTML = "";
      if (!nodes.length) {
        const empty = document.createElement("div");
        empty.className = "filter-dropdown-empty";
        empty.textContent = "Sin opciones disponibles.";
        options.appendChild(empty);
        return;
      }
      nodes.forEach((n) => {
        const optionLabel = document.createElement("label");
        optionLabel.className = "filter-dropdown-option";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = selected.includes(n.code);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) {
            if (!selected.includes(n.code)) selected.push(n.code);
          } else {
            const idx = selected.indexOf(n.code);
            if (idx !== -1) selected.splice(idx, 1);
          }
          onSelectionChange();
        });
        const text = document.createElement("span");
        text.textContent = n.name;
        optionLabel.appendChild(checkbox);
        optionLabel.appendChild(text);
        options.appendChild(optionLabel);
      });
    }

    function refresh(nodes) {
      nodesCache = nodes;
      // Poda in-place: una selección que ya no está entre las opciones
      // disponibles (ej. cambió el Territorio y esa Subgerencia dejó de
      // pertenecer) se descarta, sin reemplazar el array (el que llama
      // sigue con la misma referencia).
      const validCodes = new Set(nodes.map((n) => n.code));
      const kept = selected.filter((v) => validCodes.has(v));
      selected.length = 0;
      selected.push(...kept);

      const count = selected.length;
      const badge = count > 0 ? `<span class="count-badge">${count}</span>` : "";
      toggle.querySelector(".label").outerHTML = `<span class="label">${label}</span>${badge}`;

      renderOptions();
    }

    return { element: wrap, refresh };
  }

  // Toggle de tema claro/oscuro — un solo botón #theme-toggle compartido por
  // todas las pestañas/páginas de la app, así que se inicializa una sola vez
  // (si cada módulo de pestaña le agregara su propio listener, un clic
  // alternaría el tema dos veces y no se vería ningún cambio).
  function initThemeToggle() {
    const themeToggle = document.getElementById("theme-toggle");
    if (!themeToggle || themeToggle.dataset.themeBound) return;
    themeToggle.dataset.themeBound = "true";
    const saved = safeGet("gdd-theme");
    if (saved) document.documentElement.setAttribute("data-theme", saved);
    themeToggle.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme");
      const next = current === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      safeSet("gdd-theme", next);
    });
  }

  return {
    buildCombinedData,
    mergeHierarchyNode,
    walkTree,
    matchesSelection,
    computeEntityFilterOptions,
    entityMatchesFilters,
    focoColorVar,
    sortFocos,
    levelLabel,
    formatUpdatedAt,
    formatPercent,
    formatRaw,
    computeStatus,
    valueCellMarkup,
    escapeHtml,
    safeGet,
    safeSet,
    loadIndicadoresData,
    loadCombinedData,
    initThemeToggle,
    createChecklistDropdown,
    closeAllChecklistDropdowns,
  };
})();
