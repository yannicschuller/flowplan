const form = document.getElementById("form"),
  input = document.getElementById("server"),
  error = document.getElementById("error"),
  submit = document.getElementById("submit");
const preset = new URLSearchParams(location.search).get("server");
window.flowplanDesktop.getServer().then((value) => {
  input.value = preset || value || "";
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.textContent = "";
  submit.disabled = true;
  submit.textContent = "Verbinde …";
  try {
    await window.flowplanDesktop.setServer(input.value);
  } catch (e) {
    error.textContent = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
    submit.disabled = false;
    submit.textContent = "Verbinden";
  }
});
