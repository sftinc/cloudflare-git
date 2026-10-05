// Theme: auto (no attribute, follows the system), light or dark. Loaded in <head> so the saved choice applies before paint.
(() => {
  const root = document.documentElement;
  const read = () => { try { return localStorage.getItem("theme"); } catch { return null; } };
  const sync = () => {
    const t = root.dataset.theme || "auto";
    document.querySelectorAll("[data-theme-set]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themeSet === t)));
  };
  const apply = (t) => {
    if (t === "light" || t === "dark") root.dataset.theme = t;
    else delete root.dataset.theme;
    try { t === "light" || t === "dark" ? localStorage.setItem("theme", t) : localStorage.removeItem("theme"); } catch {}
    sync();
  };
  const saved = read();
  if (saved === "light" || saved === "dark") root.dataset.theme = saved;
  document.addEventListener("DOMContentLoaded", sync);
  document.addEventListener("click", (event) => {
    const set = event.target.closest("[data-theme-set]");
    if (set) return apply(set.dataset.themeSet);
    if (event.target.closest("[data-theme-cycle]")) {
      const order = ["auto", "light", "dark"];
      apply(order[(order.indexOf(root.dataset.theme || "auto") + 1) % 3]);
    }
  });
})();
