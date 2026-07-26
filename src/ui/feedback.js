export function showToast(region, message, tone = "success") {
  const node = document.createElement("div");
  node.className = `toast ${tone}`;
  node.setAttribute("role", tone === "error" ? "alert" : "status");
  node.setAttribute("aria-live", tone === "error" ? "assertive" : "polite");
  node.textContent = message;
  region.append(node);
  setTimeout(() => node.remove(), 3200);
}
