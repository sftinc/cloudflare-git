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
