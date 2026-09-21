(function () {
  "use strict";

  const {
    loadCombinedData,
    walkTree,
    formatUpdatedAt,
    valueCellMarkup,
    escapeHtml,
    initThemeToggle,
  } = window.GDD;

  // Los 4 indicadores del Ranking, 25% cada uno. Los 4 comparten el mismo
  // significado en los datos del Tablero GDD: son una razón valor/meta con
  // meta=1 (100%), así que un valor más alto siempre es mejor para los 4 —
  // no hace falta invertir ninguno al promediar (a diferencia de una tasa
  // de accidentabilidad o fuga "cruda", que sería al revés).
  const RANKING_METRICS = [
    { key: "captacion_total", label: "Captación" },
    { key: "nps", label: "NPS" },
    { key: "desafiliacion", label: "Fuga (Desafiliación)" },
    { key: "accidentes_vista_de_gestion", label: "Accidentabilidad Total" },
  ];

  const LEVEL_LABELS = { territorio: "Territorio", subgerencia: "Subgerencia", agencia: "Agencia" };

  const state = {
    data: null,
    combined: null,
    level: "territorio",
    period: "mtd", // "mtd" = Mes cerrado, "ytd" = YTD
    scopeTerritorio: "", // código de Territorio, "" = todos (solo aplica si level != territorio)
    territorios: [], // [{code, name}] para el filtro de alcance
  };

  const updatedAtEl = document.getElementById("updated-at");
  const rankingWrap = document.getElementById("ranking-wrap");
  const levelSwitch = document.getElementById("ranking-level-switch");
  const periodSwitch = document.getElementById("ranking-period-switch");
  const scopeContainer = document.getElementById("ranking-scope-container");

  init();

  async function init() {
    bindControls();
    initThemeToggle();
    try {
      const loaded = await loadCombinedData();
      state.data = loaded.data;
      state.combined = loaded.combined;
      updatedAtEl.textContent = formatUpdatedAt(state.data.generated_at);
      state.territorios = (state.combined.hierarchy.children || [])
        .filter((n) => n.level === "territorio")
        .map((n) => ({ code: n.code, name: n.name }));
      buildScopeSelect();
      render();
    } catch (err) {
      rankingWrap.innerHTML = `<p class="muted">No se pudieron cargar los datos (${escapeHtml(
        String(err)
      )}). Si esto persiste fuera de una corrida de prueba, revisa el workflow de actualización.</p>`;
    }
  }

  function bindControls() {
    levelSwitch.querySelectorAll(".segmented-btn").forEach((btn) => {
      if (btn.dataset.level === state.level) btn.classList.add("active");
      btn.addEventListener("click", () => {
        state.level = btn.dataset.level;
        levelSwitch.querySelectorAll(".segmented-btn").forEach((b) => b.classList.toggle("active", b === btn));
        scopeContainer.hidden = state.level === "territorio";
        render();
      });
    });
    scopeContainer.hidden = state.level === "territorio";

    periodSwitch.querySelectorAll(".segmented-btn").forEach((btn) => {
      if (btn.dataset.period === state.period) btn.classList.add("active");
      btn.addEventListener("click", () => {
        state.period = btn.dataset.period;
        periodSwitch.querySelectorAll(".segmented-btn").forEach((b) => b.classList.toggle("active", b === btn));
        render();
      });
    });
  }

  function buildScopeSelect() {
    const select = document.createElement("select");
    select.id = "ranking-scope-select";
    select.setAttribute("aria-label", "Acotar por Territorio");
    const allOpt = document.createElement("option");
    allOpt.value = "";
    allOpt.textContent = "Todos los territorios";
    select.appendChild(allOpt);
    state.territorios.forEach((t) => {
      const opt = document.createElement("option");
      opt.value = t.code;
      opt.textContent = t.name;
      select.appendChild(opt);
    });
    select.addEventListener("change", () => {
      state.scopeTerritorio = select.value;
      render();
    });
    scopeContainer.appendChild(select);
  }

  // Promedio simple de los 4 valores (cada uno ya pesa 25% al promediarse
  // entre 4) — null si falta alguno, para no premiar/castigar con un
  // promedio parcial a una entidad con cobertura de datos incompleta.
  function computeScore(values) {
    if (!values) return null;
    const parts = RANKING_METRICS.map((m) => values[m.key]);
    if (parts.some((v) => typeof v !== "number")) return null;
    return parts.reduce((sum, v) => sum + v, 0) / parts.length;
  }

  function collectEntities() {
    const out = [];
    walkTree(state.combined.hierarchy, (node, depth, path) => {
      if (node.level !== state.level) return;
      if (state.level !== "territorio" && state.scopeTerritorio && path.territorio !== state.scopeTerritorio) {
        return;
      }
      const values = state.period === "ytd" ? node.valuesYtd : node.valuesMtd;
      out.push({
        code: node.code,
        name: node.name,
        territorioCode: path.territorio,
        values,
        score: computeScore(values),
      });
    });
    return out;
  }

  function territorioName(code) {
    const t = state.territorios.find((x) => x.code === code);
    return t ? t.name : code || "—";
  }

  function render() {
    if (!state.combined) {
      rankingWrap.innerHTML = `<p class="muted">No hay datos.</p>`;
      return;
    }

    const entities = collectEntities();
    const ranked = entities.filter((e) => e.score !== null).sort((a, b) => b.score - a.score);
    const missing = entities.filter((e) => e.score === null).sort((a, b) => a.name.localeCompare(b.name, "es"));

    rankingWrap.innerHTML = "";

    if (!entities.length) {
      const msg = document.createElement("p");
      msg.className = "muted";
      msg.textContent = "Ningún resultado calza con el filtro seleccionado.";
      rankingWrap.appendChild(msg);
      return;
    }

    const showTerritorioCol = state.level !== "territorio";

    const table = document.createElement("table");
    table.className = "ranking";
    table.appendChild(buildHead(showTerritorioCol));
    table.appendChild(buildBody(ranked, showTerritorioCol));
    rankingWrap.appendChild(table);

    if (missing.length) {
      rankingWrap.appendChild(buildMissingSection(missing, showTerritorioCol));
    }
  }

  function buildHead(showTerritorioCol) {
    const thead = document.createElement("thead");
    const tr = document.createElement("tr");

    const rankTh = document.createElement("th");
    rankTh.className = "rank-col";
    rankTh.textContent = "N°";
    tr.appendChild(rankTh);

    const entityTh = document.createElement("th");
    entityTh.className = "entity-col";
    entityTh.textContent = LEVEL_LABELS[state.level];
    tr.appendChild(entityTh);

    if (showTerritorioCol) {
      const territorioTh = document.createElement("th");
      territorioTh.className = "entity-col";
      territorioTh.textContent = "Territorio";
      tr.appendChild(territorioTh);
    }

    RANKING_METRICS.forEach((m) => {
      const th = document.createElement("th");
      th.textContent = m.label;
      tr.appendChild(th);
    });

    const scoreTh = document.createElement("th");
    scoreTh.textContent = "Puntaje";
    tr.appendChild(scoreTh);

    thead.appendChild(tr);
    return thead;
  }

  function buildBody(ranked, showTerritorioCol) {
    const tbody = document.createElement("tbody");
    ranked.forEach((entity, idx) => {
      const rank = idx + 1;
      const tr = document.createElement("tr");
      if (rank <= 3) tr.classList.add("rank-top3");

      const rankTd = document.createElement("td");
      rankTd.className = "rank-col";
      rankTd.textContent = String(rank);
      tr.appendChild(rankTd);

      const nameTd = document.createElement("td");
      nameTd.className = "entity-col entity-name";
      nameTd.textContent = entity.name;
      tr.appendChild(nameTd);

      if (showTerritorioCol) {
        const territorioTd = document.createElement("td");
        territorioTd.className = "entity-col entity-territorio";
        territorioTd.textContent = territorioName(entity.territorioCode);
        tr.appendChild(territorioTd);
      }

      RANKING_METRICS.forEach((m) => {
        const td = document.createElement("td");
        td.className = "value-cell";
        const span = document.createElement("span");
        span.className = "cell-inner";
        span.innerHTML = valueCellMarkup(entity.values[m.key], 1);
        td.appendChild(span);
        tr.appendChild(td);
      });

      const scoreTd = document.createElement("td");
      scoreTd.className = "value-cell score-cell";
      const scoreSpan = document.createElement("span");
      scoreSpan.className = "cell-inner";
      scoreSpan.innerHTML = valueCellMarkup(entity.score, 1);
      scoreTd.appendChild(scoreSpan);
      tr.appendChild(scoreTd);

      tbody.appendChild(tr);
    });
    return tbody;
  }

  function buildMissingSection(missing, showTerritorioCol) {
    const details = document.createElement("details");
    details.className = "ranking-missing";
    const summary = document.createElement("summary");
    summary.textContent = `${missing.length} ${
      missing.length === 1 ? "entidad" : "entidades"
    } sin datos suficientes para calcular el puntaje (falta al menos uno de los 4 indicadores) — no se incluyen en el ranking`;
    details.appendChild(summary);

    const list = document.createElement("ul");
    missing.forEach((entity) => {
      const li = document.createElement("li");
      li.textContent = showTerritorioCol
        ? `${entity.name} · ${territorioName(entity.territorioCode)}`
        : entity.name;
      list.appendChild(li);
    });
    details.appendChild(list);
    return details;
  }
})();
