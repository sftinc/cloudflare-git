// Copy buttons: <button data-copy="text">, or data-copy-url="url" to copy what the URL returns. No inline scripts (CSP).
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-copy], [data-copy-url]");
  if (!button) return;
  const url = button.getAttribute("data-copy-url");
  // A ClipboardItem built from a promise keeps Safari's user-gesture permission across the fetch.
  const copied = url
    ? navigator.clipboard.write([new ClipboardItem({ "text/plain": fetch(url).then((r) => r.text()).then((t) => new Blob([t], { type: "text/plain" })) })])
    : navigator.clipboard.writeText(button.getAttribute("data-copy"));
  copied.then(() => {
    const label = button.innerHTML; // may be an icon
    button.textContent = "Copied";
    setTimeout(() => (button.innerHTML = label), 1500);
  });
});

// Stop double submits (a second "Accept invite" would hit an already-used invite).
// Disable after the submit event, so a clicked button's name/value is still sent.
document.addEventListener("submit", (event) => {
  if (event.defaultPrevented) return;
  const buttons = event.target.querySelectorAll("button, input[type=submit]");
  setTimeout(() => buttons.forEach((b) => (b.disabled = true)));
});
// Back/forward cache restores the page as it was: re-enable, then re-check confirm dialogs.
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  document.querySelectorAll("button:disabled, input[type=submit]:disabled").forEach((b) => (b.disabled = false));
  document.querySelectorAll("form[data-confirm]").forEach(updateConfirm);
});

// Characters-remaining hints: <input maxlength data-remaining="hint-id">.
document.addEventListener("input", (event) => {
  const input = event.target;
  const hint = input.dataset?.remaining && document.getElementById(input.dataset.remaining);
  if (hint) hint.textContent = `${input.maxLength - input.value.length} characters remaining`;
});

// Dropdowns (<details class="menu|branches">): close on an outside click or Escape.
const openDropdowns = () => document.querySelectorAll("details.menu[open], details.branches[open]");
document.addEventListener("click", (event) => openDropdowns().forEach((d) => { if (!d.contains(event.target)) d.open = false; }));
document.addEventListener("keydown", (event) => { if (event.key === "Escape") openDropdowns().forEach((d) => (d.open = false)); });

// Confirm dialogs: <button data-dialog="id"> opens <dialog id>, [data-close] closes it. In <form data-confirm>
// the submit button enables once every checkbox is ticked and each [data-must] field holds exactly its value.
function updateConfirm(form) {
  const ready =
    [...form.querySelectorAll("input[type=checkbox]")].every((b) => b.checked) &&
    [...form.querySelectorAll("[data-must]")].every((i) => i.value === i.dataset.must);
  form.querySelector("button[type=submit]").disabled = !ready;
}
document.addEventListener("click", (event) => {
  const opener = event.target.closest("[data-dialog]");
  if (opener) document.getElementById(opener.dataset.dialog)?.showModal();
  if (event.target.closest("[data-close]")) event.target.closest("dialog")?.close();
});
document.addEventListener("input", (event) => {
  const form = event.target.closest?.("form[data-confirm]");
  if (form) updateConfirm(form);
});
