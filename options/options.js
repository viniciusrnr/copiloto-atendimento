const campo = document.getElementById("url");
const estado = document.getElementById("estado");

chrome.storage.local.get("urlView").then(({ urlView = "" }) => { campo.value = urlView; });

document.getElementById("salvar").addEventListener("click", async () => {
  let origem;
  try {
    const url = new URL(campo.value.trim());
    if (url.protocol !== "https:" && url.hostname !== "localhost") throw new Error();
    origem = url.origin;
  } catch {
    estado.textContent = "Endereço inválido: use https:// (ou http://localhost para teste).";
    return;
  }
  // a extensão só fala com o painel que o atendente autorizou aqui
  const permitido = await chrome.permissions.request({ origins: [`${origem}/*`] });
  if (!permitido) {
    estado.textContent = "Sem a permissão a extensão não consegue falar com o painel.";
    return;
  }
  await chrome.storage.local.set({ urlView: origem });
  await chrome.storage.local.remove("sessao"); // painel novo: entra de novo
  estado.textContent = "Salvo. Abra o copiloto pelo ícone da extensão.";
});
