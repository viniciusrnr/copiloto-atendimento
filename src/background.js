// O ícone da extensão abre o painel lateral do copiloto.
import { verificar } from "./api.js";

const ESPERA_VERIFICAR_MS = 4000;

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Trava do Enviar (content script): confere o texto no copiloto. Sem login, sem rede ou demorando, libera o envio:
// a trava nunca pode parar o atendimento.
chrome.runtime.onMessage.addListener((pedido, _remetente, responder) => {
  if (pedido.tipo !== "verificar") return false;
  const livre = { alertas: [], livre: true }; // não conferiu: o content não conta como correção
  Promise.race([
    verificar(pedido.texto, pedido.cpf).then((dados) => ({ alertas: dados?.alertas || [] }), () => livre),
    new Promise((ok) => setTimeout(() => ok(livre), ESPERA_VERIFICAR_MS)),
  ]).then(responder);
  return true;
});
