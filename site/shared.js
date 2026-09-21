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
    return `${(value * 100).toFixed(1)}%`;
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

  return {
    buildCombinedData,
    mergeHierarchyNode,
    walkTree,
    levelLabel,
    formatUpdatedAt,
    formatPercent,
    formatRaw,
    computeStatus,
    valueCellMarkup,
    escapeHtml,
    safeGet,
    safeSet,
  };
})();
