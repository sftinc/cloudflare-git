// Copy buttons: <button data-copy="text">. No inline scripts (CSP).
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) return;
  navigator.clipboard.writeText(button.getAttribute("data-copy")).then(() => {
    const label = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = label), 1500);
  });
});

// Stop double submits (a second "Accept invite" would hit an already-used invite).
// Disable after the submit event, so a clicked button's name/value is still sent.
document.addEventListener("submit", (event) => {
  if (event.defaultPrevented) return;
  const buttons = event.target.querySelectorAll("button, input[type=submit]");
  setTimeout(() => buttons.forEach((b) => (b.disabled = true)));
});
// Back/forward cache restores the page as it was: re-enable.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) document.querySelectorAll("button:disabled, input[type=submit]:disabled").forEach((b) => (b.disabled = false));
});
