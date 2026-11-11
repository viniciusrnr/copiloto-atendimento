// Cliente do view (assistente-view, /api/copiloto/extensao). Contrato: assistente-docs/contrato-copiloto-eventos.md §8.
// Só o token vai para o chrome.storage; a senha nunca é guardada.

const PREFIXO = "/api/copiloto/extensao";

export class SessaoExpirada extends Error {}

export async function config() {
  const { urlView = "", sessao = null } = await chrome.storage.local.get(["urlView", "sessao"]);
  const valida = sessao && sessao.token && (!sessao.expira_em || Date.parse(sessao.expira_em) > Date.now());
  return { urlView: urlView.replace(/\/+$/, ""), sessao: valida ? sessao : null };
}

async function chamar(metodo, caminho, corpo) {
  const { urlView, sessao } = await config();
  if (!urlView) throw new Error("Configure o endereço do painel nas opções da extensão.");
  const headers = { "Content-Type": "application/json" };
  if (caminho !== "/login") {
    if (!sessao) throw new SessaoExpirada();
    headers.Authorization = `Bearer ${sessao.token}`;
  }
  let resposta;
  try {
    resposta = await fetch(urlView + PREFIXO + caminho, { method: metodo, headers, body: corpo ? JSON.stringify(corpo) : undefined });
  } catch {
    throw new Error("Sem conexão com o painel. Confira a rede ou a VPN.");
  }
  const payload = await resposta.json().catch(() => ({}));
  if (resposta.status === 401 && caminho !== "/login") {
    await chrome.storage.local.remove("sessao");
    throw new SessaoExpirada();
  }
  if (!resposta.ok) throw Object.assign(new Error(payload.message || "O painel não respondeu. Tente de novo em instantes."), { status: resposta.status });
  return payload.data ?? payload;
}

export async function entrar(email, senha) {
  const dados = await chamar("POST", "/login", { email, senha });
  await chrome.storage.local.set({ sessao: { token: dados.token, expira_em: dados.expira_em, usuario: dados.usuario, features: dados.features || {} } });
  return dados.usuario;
}

export async function sair() {
  await chrome.storage.local.remove("sessao");
}

const id = (callId) => encodeURIComponent(callId);
export const ativar = () => chamar("POST", "/sessao");
export const desativar = () => chamar("POST", "/sessao/encerrar");
export const estado = () => chamar("GET", "/estado");
export const sugerir = (callId, historico) => chamar("POST", `/sugerir/${id(callId)}`, historico?.length ? { historico } : undefined);
export const verificar = (callId, texto) => chamar("POST", `/verificar/${id(callId)}`, { texto });
export const hoteis = (termo) => chamar("GET", `/hoteis?${new URLSearchParams({ termo })}`);
export const precosHotel = (params) => chamar("GET", `/precos-hotel?${new URLSearchParams(params)}`);
export const informarCpf = (callId, cpf) => chamar("POST", `/cliente/${id(callId)}`, { cpf });
export const enviarEventos = (eventos) => chamar("POST", "/eventos-direto", { eventos });

// caminho stateless (sem o listener): a extensão manda o que leu da tela do Interact
export const sugerirDireto = (corpo) => chamar("POST", "/sugerir-direto", corpo);
export const cardapio = (cpf) => chamar("POST", "/cardapio", { cpf });
export const fichaDireto = (cpf) => chamar("POST", "/ficha-direto", { cpf });
export const precosDireto = (corpo) => chamar("POST", "/precos-direto", corpo);

// Modo supervisão: SÓ no ambiente local. Sem login, lê quem está atendendo e acompanha ao vivo (só leitura). As rotas
// /local/supervisao/* existem apenas no script de teste local do view; em produção não há, por isso o modo não aparece.
export function ehLocal(urlView) {
  try {
    const host = new URL(urlView).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

async function chamarLocal(metodo, caminho, corpo) {
  const { urlView } = await config();
  if (!urlView) throw new Error("Configure o endereço do painel nas opções da extensão.");
  let resposta;
  try {
    resposta = await fetch(`${urlView}/local/supervisao${caminho}`, { method: metodo,
      headers: { "Content-Type": "application/json" }, body: corpo ? JSON.stringify(corpo) : undefined });
  } catch {
    throw new Error("Sem conexão com o painel local.");
  }
  const payload = await resposta.json().catch(() => ({}));
  if (!resposta.ok) throw Object.assign(new Error(payload.message || "O painel local não respondeu."), { status: resposta.status });
  return payload.data ?? payload;
}
export const supAtendentes = () => chamarLocal("GET", "/atendentes");
export const supAcompanhar = (login, nome) => chamarLocal("POST", "/acompanhar", { login, nome });
export const supEstado = () => chamarLocal("GET", "/estado");
export const supAuto = () => chamarLocal("GET", "/auto");  // acompanha o 1º atendente em serviço com chat aberto
export const supSugerir = (callId) => chamarLocal("POST", `/sugerir/${encodeURIComponent(callId)}`);
