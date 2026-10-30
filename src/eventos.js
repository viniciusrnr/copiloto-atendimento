// Fila de eventos de uso (contrato §2-4): guardada no chrome.storage para não perder ao fechar o painel,
// enviada em lotes de até 50 a cada 10 s. O evento_id é único: reenviar não duplica no servidor.
import { enviarEventos, SessaoExpirada } from "./api.js";
import { evento } from "./regras.js";

const LOTE = 50;
const INTERVALO_MS = 10_000;
const MAX_FILA = 1000; // painel offline por muito tempo: descarta os mais antigos
const VERSAO = chrome.runtime.getManifest().version;

let fila = [];
let sessaoId = null;
let enviando = false;

export async function iniciarFila() {
  ({ filaEventos: fila = [] } = await chrome.storage.local.get("filaEventos"));
  setInterval(enviar, INTERVALO_MS);
}

export function novaSessao() {
  sessaoId = crypto.randomUUID();
}

/** Logout: os eventos de um usuário não podem sair com o token de outro. */
export async function limparFila() {
  fila = [];
  await chrome.storage.local.remove("filaEventos");
}

export function registrar(tipo, { callId = null, sugestaoId = null, dados = {} } = {}) {
  fila.push(evento(tipo, { callId, sessaoId, sugestaoId, dados, versao: VERSAO }));
  fila = fila.slice(-MAX_FILA);
  chrome.storage.local.set({ filaEventos: fila });
}

export async function enviar() {
  if (enviando || !fila.length) return;
  enviando = true;
  try {
    while (fila.length) {
      const lote = fila.slice(0, LOTE);
      await enviarEventos(lote);
      const enviados = new Set(lote.map((e) => e.evento_id));
      fila = fila.filter((e) => !enviados.has(e.evento_id));
      await chrome.storage.local.set({ filaEventos: fila });
    }
  } catch (erro) {
    if (!(erro instanceof SessaoExpirada) && erro.status === 400) {
      fila = fila.slice(LOTE); // lote recusado pelo contrato: não trava a fila para sempre
      await chrome.storage.local.set({ filaEventos: fila });
    }
  } finally {
    enviando = false;
  }
}
