// Regras puras da extensão (sem DOM nem chrome.*): testadas com `node --test`.

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const RE_LISTA = new RegExp(`^topPanel(${UUID})$`);
const RE_CONTAINER = new RegExp(`^tabChat(${UUID})$`);
const RE_ABA = new RegExp(`^tabPanel(${UUID})__tabChat${UUID}$`);

/** uuid da conversa a partir do id de um elemento do Interact (lista à esquerda, painel do chat ou aba). */
export function uuidDoId(id) {
  const texto = String(id || "");
  for (const re of [RE_LISTA, RE_CONTAINER, RE_ABA]) {
    const m = texto.match(re);
    if (m) return m[1];
  }
  return null;
}

/**
 * Qual conversa está na tela. Em ordem de confiança: o item ativo da lista de conversas
 * (`topPanel<uuid>` com a classe de ativo), o painel de chat visível (`tabChat<uuid>`) e a aba
 * "Chat" ativa (`tabPanel<uuid>__tabChat<uuid>`, que fica ativa em toda conversa aberta).
 */
export function chatAtivo({ itensAtivos = [], paineisVisiveis = [], abasAtivas = [] } = {}) {
  for (const grupo of [itensAtivos, paineisVisiveis, abasAtivas]) {
    const uuids = [...new Set(grupo.map(uuidDoId).filter(Boolean))];
    if (uuids.length === 1) return uuids[0];
  }
  return null;
}

export function cpfValido(cpf) {
  const d = String(cpf || "").replace(/\D/g, "");
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  for (const tamanho of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < tamanho; i++) soma += Number(d[i]) * (tamanho + 1 - i);
    const digito = ((soma * 10) % 11) % 10;
    if (digito !== Number(d[tamanho])) return false;
  }
  return true;
}

/** Primeiro CPF válido num texto (com ou sem pontuação; dados associados vêm como "nome;tipo;CPF;..."). */
export function extrairCpf(texto) {
  for (const m of String(texto || "").matchAll(/(?<!\d)(\d{3}\.?\d{3}\.?\d{3}-?\d{2})(?!\d)/g)) {
    const d = m[1].replace(/\D/g, "");
    if (cpfValido(d)) return d;
  }
  return null;
}

function palavras(texto) {
  return new Set(
    String(texto || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

/** Jaccard de palavras sem acento (0–1). */
export function similaridade(a, b) {
  const pa = palavras(a), pb = palavras(b);
  if (!pa.size && !pb.size) return 1;
  let comum = 0;
  for (const p of pa) if (pb.has(p)) comum++;
  return comum / (pa.size + pb.size - comum);
}

/** O que o atendente fez com as sugestões: {indice (1|2|null), uso, similaridade}. */
export function usoDaSugestao(sugestoes, enviada) {
  let melhor = { indice: null, similaridade: 0 };
  (sugestoes || []).forEach((s, i) => {
    const valor = similaridade(s.texto, enviada);
    if (valor > melhor.similaridade) melhor = { indice: i + 1, similaridade: valor };
  });
  const uso = melhor.similaridade >= 0.9 ? "igual" : melhor.similaridade >= 0.5 ? "editada" : "outra";
  return { indice: uso === "outra" ? null : melhor.indice, uso, similaridade: Math.round(melhor.similaridade * 100) / 100 };
}

/** Chat a destacar: o escolhido pelo atendente (se ainda existe), senão o que está na tela, senão nenhum. */
export function chatSelecionado(conversas, { escolhido = null, naTela = null } = {}) {
  const ids = new Set((conversas || []).map((c) => c.call_id));
  if (escolhido && ids.has(escolhido)) return escolhido;
  if (naTela && ids.has(naTela)) return naTela;
  return null;
}

/** Última mensagem do cliente (onde a sugestão fica pendurada). */
export function ultimaDoCliente(conversa) {
  const msgs = (conversa && conversa.mensagens) || [];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].papel === "cliente") return msgs[i];
  return null;
}

/** Primeira mensagem do atendente depois da mensagem do cliente `seq`. */
export function respostaDoAtendente(conversa, seq) {
  return ((conversa && conversa.mensagens) || []).find((m) => m.papel === "atendente" && m.seq > seq) || null;
}

/** Cliente falou de novo depois de `seq` sem o atendente responder? */
export function clienteFalouDeNovo(conversa, seq) {
  for (const m of (conversa && conversa.mensagens) || []) {
    if (m.seq <= seq) continue;
    if (m.papel === "atendente") return false;
    if (m.papel === "cliente") return true;
  }
  return false;
}

export const TIPOS_EVENTO = {
  ativou: [],
  desativou: ["motivo"],
  escolheu_cliente: ["conversas_abertas"],
  pediu_sugestao: ["gatilho"],
  exibiu: ["sugestoes"],
  copiou: ["indice"],
  inseriu: ["indice"],
  enviou: ["indice", "uso", "similaridade", "segundos_ate_enviar"],
  ignorou: ["motivo"],
  alerta: ["alerta", "subtipo", "momento"],
  corrigiu_alerta: ["alerta", "subtipo"],
  erro: ["codigo"],
  avaliou: ["nota", "comentario"],
};

function agoraComOffset(data = new Date()) {
  const pad = (n, t = 2) => String(Math.abs(n)).padStart(t, "0");
  const off = -data.getTimezoneOffset();
  return `${data.getFullYear()}-${pad(data.getMonth() + 1)}-${pad(data.getDate())}T${pad(data.getHours())}:${pad(data.getMinutes())}:` +
    `${pad(data.getSeconds())}.${pad(data.getMilliseconds(), 3)}${off >= 0 ? "+" : "-"}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}

/**
 * Envelope do contrato (assistente-docs/contrato-copiloto-eventos.md §2). Só passa em `dados` o que o
 * tipo prevê: texto de mensagem, nome ou CPF nunca entram por engano. O atendente é o servidor que põe.
 */
export function evento(tipo, { callId = null, sessaoId, sugestaoId = null, dados = {}, versao, uuid, data } = {}) {
  if (!(tipo in TIPOS_EVENTO)) throw new Error(`tipo de evento desconhecido: ${tipo}`);
  const permitidos = Object.fromEntries(
    TIPOS_EVENTO[tipo].filter((k) => dados[k] !== undefined).map((k) => [k, dados[k]]),
  );
  return {
    evento_id: uuid ? uuid() : crypto.randomUUID(),
    tipo,
    em: agoraComOffset(data),
    call_id: callId,
    sessao_id: sessaoId || null,
    sugestao_id: sugestaoId,
    origem: "extensao",
    versao_extensao: versao || null,
    dados: permitidos,
  };
}

/** Texto curto para a lista de conversas. */
export function resumo(texto, max = 70) {
  const t = String(texto || "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Como mostrar o estado da conexão: {nivel: ok|aviso|erro|parado, texto}. */
export function situacao(estado) {
  const status = (estado && estado.status) || "parado";
  if (status === "sem_licenca") {
    return { nivel: "erro", texto: "Sem licença do Interact disponível agora. Outro atendente está usando; tente de novo mais tarde." };
  }
  if (status === "conectado") return { nivel: "ok", texto: "Conectado: ouvindo seus chats" };
  if (status === "reconectando") return { nivel: "aviso", texto: "Reconectando ao Interact… suas sugestões podem atrasar." };
  if (status === "erro") {
    return { nivel: "erro", texto: "O copiloto perdeu contato com o Interact. Seus chats seguem normais. Clique em Tentar de novo." };
  }
  return { nivel: "parado", texto: "Copiloto desligado" };
}

// Alertas que o servidor põe nas mensagens do atendente (verificador.py e alertas.py do worker):
// {tipo: data|valor|aviso|picadas, encontrado, esperado, correcao}. Em "aviso" e "picadas" o esperado é a explicação.
const SUBTIPOS_AVISO = [
  [/não existe no calendário/, "inexistente"], [/antes da entrada/, "checkout_antes"], [/já passou/, "passado"],
  [/cai num/, "fim_de_semana"], [/fim do período/, "fora_periodo"],
];

export function textoDoAlerta(alerta) {
  if (alerta.tipo === "data") return `Data diferente da ficha: você escreveu ${alerta.encontrado}, o certo é ${alerta.esperado}.`;
  if (alerta.tipo === "valor") return `Valor diferente da ficha: você escreveu ${alerta.encontrado}, o certo é ${alerta.esperado}.`;
  return String(alerta.esperado || alerta.encontrado || "");
}

const diaMes = (iso) => String(iso).split("-").reverse().slice(0, 2).join("/");
/** O que o cliente usa do plano e paga: "5 diárias", "2 diárias + R$ 120,00", "10.800 pontos + R$ 1.267,65". */
export function valorDoCliente(c) {
  const partes = [];
  if (c.diarias) partes.push(`${c.diarias} ${c.diarias === 1 ? "diária" : "diárias"}`);
  if (c.pontos) partes.push(`${c.pontos.toLocaleString("pt-BR")} pontos`);
  if (c.dinheiro || !partes.length) partes.push(c.dinheiro.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
  return partes.join(" + ");
}

/** A cotação sai mais barata que a outra: menos dinheiro + pontos; no empate, menos diárias do plano. */
export const maisBarataQue = (c, outra) => c.equivalente < outra.equivalente
  || (c.equivalente === outra.equivalente && (c.diarias || 0) < (outra.diarias || 0));

/** Frase para o atendente oferecer a data mais barata (cotação do motor do Reservas, no valor do assinante). */
export function textoDaOferta(cotacao, pedida) {
  const noites = `${cotacao.noites} ${cotacao.noites === 1 ? "noite" : "noites"}`;
  const antes = pedida?.disponivel && pedida.checkin !== cotacao.checkin
    ? ` Entrando em ${diaMes(pedida.checkin)} ficaria ${valorDoCliente(pedida)}.` : "";
  const quarto = cotacao.quartos?.[0] ? ` no quarto ${cotacao.quartos[0].quarto} (${cotacao.quartos[0].regime})` : "";
  return `Encontrei uma opção melhor para você: entrando em ${diaMes(cotacao.checkin)}, com ${noites}${quarto}, fica ${valorDoCliente(cotacao)}.${antes} Quer que eu veja essa data para você?`;
}

/** dados do evento `alerta` (contrato §3): sem o texto da mensagem, só o tipo e o subtipo. */
export function alertaParaEvento(alerta) {
  if (alerta.tipo === "aviso") {
    const subtipo = SUBTIPOS_AVISO.find(([re]) => re.test(alerta.esperado || ""));
    return { alerta: "data_invalida", subtipo: subtipo ? subtipo[1] : null, momento: "depois" };
  }
  return { alerta: alerta.tipo === "picadas" ? "picadas" : `${alerta.tipo}_ficha`, subtipo: null, momento: "depois" };
}
