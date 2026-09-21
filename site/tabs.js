(function () {
  "use strict";

  const { safeGet, safeSet } = window.GDD;
  const STORAGE_KEY = "gdd-active-tab";

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    const buttons = document.querySelectorAll(".tab-btn");
    const panels = document.querySelectorAll(".tab-panel");
    if (!buttons.length) return;

    buttons.forEach((btn) => {
      btn.addEventListener("click", () => activateTab(btn.dataset.tab, buttons, panels));
    });

    const saved = safeGet(STORAGE_KEY);
    const initial = saved && [...buttons].some((b) => b.dataset.tab === saved) ? saved : buttons[0].dataset.tab;
    activateTab(initial, buttons, panels);
  }

  function activateTab(tab, buttons, panels) {
    buttons.forEach((btn) => {
      const active = btn.dataset.tab === tab;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", String(active));
    });
    panels.forEach((panel) => {
      panel.hidden = panel.dataset.tabPanel !== tab;
    });
    safeSet(STORAGE_KEY, tab);

    // Un panel con display:none mide 0px de alto — cualquier cosa que un
    // módulo de pestaña haya calculado mientras estaba oculto (ej. el
    // offset sticky del header de la tabla) queda mal. Avisa que la
    // pestaña recién se hizo visible para que el módulo la recalcule.
    document.dispatchEvent(new CustomEvent("gdd:tab-shown", { detail: { tab } }));
  }
})();
