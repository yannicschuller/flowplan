const params = new URLSearchParams(location.search);
const server = params.get("server");
if (server)
  document.getElementById("detail").textContent =
    `${server} ist gerade nicht erreichbar (${params.get("error") || "unbekannter Fehler"}). Prüfe deine Internetverbindung oder die Adresse der Instanz.`;
document.getElementById("retry").addEventListener("click", () => window.flowplanDesktop.retry());
document.getElementById("change").addEventListener("click", () => window.flowplanDesktop.changeServer());
// Try again by itself when the connection comes back.
window.addEventListener("online", () => window.flowplanDesktop.retry());
