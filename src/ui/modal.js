let returnFocus = null;

export function openModal(content, variant = "", label = "Diálogo", escapeLabel = (value) => value) {
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.classList.add("modal-open");
  document.body.insertAdjacentHTML("beforeend", `<div class="modal-backdrop ${variant ? `${variant}-backdrop` : ""}" data-action="close-modal"><section class="modal ${variant}" role="dialog" aria-modal="true" aria-label="${escapeLabel(label)}">${content}</section></div>`);
  requestAnimationFrame(() => document.querySelector(".modal-backdrop .modal [autofocus], .modal-backdrop .modal button, .modal-backdrop .modal input")?.focus());
}

export function closeModal() {
  document.querySelector(".modal-backdrop")?.remove();
  document.body.classList.remove("modal-open");
  returnFocus?.focus?.();
  returnFocus = null;
}
