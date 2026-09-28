(() => {
  const root = document.querySelector("[data-markdown-editor]");
  if (!root) return;
  const form = root.closest("form");
  const input = root.querySelector("textarea[name='body']");
  const preview = root.querySelector("[data-preview]");
  const status = root.querySelector("[data-preview-status]");
  const count = root.querySelector("[data-character-count]");
  const csrf = form?.querySelector("input[name='csrf']");
  if (!form || !input || !preview || !status || !count || !csrf) return;

  let timer = 0;
  let request = null;
  let dirty = false;
  const updateCount = () => { count.textContent = `${input.value.length.toLocaleString()} characters`; };
  const previewNow = async () => {
    request?.abort();
    request = new AbortController();
    status.textContent = "Updating…";
    try {
      const body = new URLSearchParams({ csrf: csrf.value, body: input.value });
      const response = await fetch("/preview", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body, signal: request.signal });
      if (!response.ok) throw new Error(`Preview failed (${response.status})`);
      const html = await response.text();
      preview.innerHTML = html || "<p><em>This page is empty.</em></p>";
      status.textContent = "Preview up to date";
    } catch (error) {
      if (error.name !== "AbortError") status.textContent = error.message;
    }
  };
  const schedule = () => {
    dirty = true;
    updateCount();
    clearTimeout(timer);
    timer = setTimeout(previewNow, 250);
  };
  const wrapSelection = (before, after, placeholder) => {
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const selected = input.value.slice(start, end) || placeholder;
    input.setRangeText(`${before}${selected}${after}`, start, end, "select");
    input.focus();
    schedule();
  };

  input.addEventListener("input", schedule);
  form.addEventListener("input", (event) => { if (event.target !== input) dirty = true; });
  root.querySelectorAll("[data-before]").forEach((button) => button.addEventListener("click", () => wrapSelection(button.dataset.before || "", button.dataset.after || "", button.dataset.placeholder || "text")));
  form.addEventListener("submit", () => { dirty = false; });
  form.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); dirty = false; form.requestSubmit(); }
  });
  window.addEventListener("beforeunload", (event) => { if (dirty) event.preventDefault(); });
  updateCount();
})();
