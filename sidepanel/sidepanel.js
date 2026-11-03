import * as api from "../src/api.js";
import { enviar, iniciarFila, limparFila, novaSessao, registrar } from "../src/eventos.js";
import {
  alertaParaEvento, chatSelecionado, clienteFalouDeNovo, maisBarataQue, respostaDoAtendente, resumo, situacao, textoDaOferta,
  textoDoAlerta, ultimaDoCliente, usoDaSugestao, valorDoCliente,
} from "../src/regras.js";

const INTERVALO_MS = 3000;
const IGNORADA_MS = 10 * 60 * 1000;
const ERRO_REPETIDO_MS = 5 * 60 * 1000; // numa queda, um evento "erro" por código a cada 5 min
const INTERACT = "https://rdc.digitro.cloud/*";

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const s = {
  ligado: false, estado: null, escolhido: null, naTela: null, cpfNaTela: null, timer: null, erro: "", aviso: "",
  cpfsInformados: new Set(),
  alertasVistos: new Set(), // call_id#seq: um evento por alerta
  errosRegistrados: new Map(), // código -> quando registrou
  reativou: false, // presença expirada: volta à escuta uma vez sozinho
  feito: {},  // sugestao_id -> "Inserida" | "Copiada" (retorno visual)
  vistas: new Map(), // sugestao_id -> {callId, seq, sugestoes, exibidaEm, usada, fim}
  avaliacoes: {}, // sugestao_id -> {nota, comentario, enviada}
  verLista: false, // "← Chats": mostra só a lista até escolher outro chat
  // "Cliente achou caro?": o hotel em datas vizinhas no valor do assinante (motor do Reservas)
  precos: { aberto: false, form: { hotel: "", checkin: "", noites: "2", adultos: "2", cafe: false, reembolsavel: false }, escolhas: null, buscando: false, erro: "", resultado: null },
};

// ---------- telas ----------
function mostrar(tela) {
  for (const id of ["tela-config", "tela-login", "tela-desligado", "tela-ligado"]) $(id).hidden = id !== tela;
  $("desligar").hidden = tela !== "tela-ligado";
}

async function iniciar() {
  await iniciarFila();
  const { urlView, sessao } = await api.config();
  $("usuario").textContent = sessao ? sessao.usuario?.nome || sessao.usuario?.email || "" : "";
  $("sair").hidden = !sessao;
  if (!urlView) return mostrar("tela-config");
  if (!sessao) return mostrar("tela-login");
  const { ligado } = await chrome.storage.local.get("ligado");
  if (ligado) return ligar(); // painel reaberto com o copiloto ligado: retoma
  mostrar("tela-desligado");
}

function voltarAoLogin() {
  pararConsulta();
  s.ligado = false;
  chrome.storage.local.set({ ligado: false });
  $("usuario").textContent = "";
  $("sair").hidden = true;
  $("erro-login").textContent = "Sua sessão expirou. Entre de novo.";
  mostrar("tela-login");
}

async function tratar(erro, onde) {
  if (erro instanceof api.SessaoExpirada) return voltarAoLogin();
  const codigo = erro.status ? `http_${erro.status}` : onde;
  if (Date.now() - (s.errosRegistrados.get(codigo) || 0) > ERRO_REPETIDO_MS) {
    s.errosRegistrados.set(codigo, Date.now());
    registrar("erro", { dados: { codigo } });
  }
  s.erro = erro.message;
  desenhar();
}

// ---------- ligar / desligar ----------
async function ligar() {
  $("erro-ligar").textContent = "";
  $("ligar").disabled = true;
  try {
    s.estado = await api.ativar();
  } catch (erro) {
    $("ligar").disabled = false;
    if (erro instanceof api.SessaoExpirada) return voltarAoLogin();
    $("erro-ligar").textContent = erro.message;
    return mostrar("tela-desligado");
  }
  $("ligar").disabled = false;
  s.ligado = true;
  novaSessao();
  registrar("ativou");
  chrome.storage.local.set({ ligado: true });
  mostrar("tela-ligado");
  await perguntarTela();
  consultar();
}

async function desligar() {
  pararConsulta();
  encerrarVistas(null, "trocou_conversa");
  registrar("desativou", { dados: { motivo: "botao" } });
  s.ligado = false;
  chrome.storage.local.set({ ligado: false });
  mostrar("tela-desligado");
  try { await api.desativar(); } catch { /* o servidor tira o atendente sozinho em 2 min */ }
  enviar();
}

function pararConsulta() {
  clearTimeout(s.timer);
  s.timer = null;
}

async function consultar() {
  pararConsulta();
  if (!s.ligado) return;
  try {
    s.estado = await api.estado();
    s.erro = "";
    // presença expirada (notebook dormiu, rede caiu): volta à escuta uma vez. Sem licença, só pelo botão.
    if (s.estado.ativo === false && s.estado.status !== "sem_licenca" && !s.reativou) {
      s.reativou = true;
      s.estado = await api.ativar();
    } else if (s.estado.ativo !== false) {
      s.reativou = false;
    }
    acompanharUso();
    registrarAlertas();
    informarCpf();
    desenhar();
  } catch (erro) {
    await tratar(erro, "estado");
  }
  if (s.ligado) s.timer = setTimeout(consultar, INTERVALO_MS);
}

// ---------- tela do Interact ----------
async function abaDoInteract() {
  const [ativa] = await chrome.tabs.query({ url: INTERACT, active: true, lastFocusedWindow: true });
  return ativa || (await chrome.tabs.query({ url: INTERACT }))[0] || null;
}

async function perguntarTela() {
  const aba = await abaDoInteract();
  if (!aba) return;
  try {
    aoMudarTela(await chrome.tabs.sendMessage(aba.id, { tipo: "tela?" }));
  } catch { /* Interact aberto antes da extensão: atualizar a página resolve */ }
}

function aoMudarTela(tela) {
  if (!tela) return;
  if (tela.callId !== s.naTela) {
    s.naTela = tela.callId;
    s.escolhido = null; // trocou de chat no Interact: o painel acompanha
    s.verLista = false;
  }
  s.cpfNaTela = tela.callId && tela.cpf ? { callId: tela.callId, cpf: tela.cpf } : null;
  informarCpf();
  desenhar();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.tipo === "tela") aoMudarTela(msg);
  else if (msg.tipo === "evento") registrar(msg.evento, { callId: msg.callId, dados: msg.dados }); // trava do Enviar
});

// o histórico que está na tela do Interact: a IA vê também o que veio antes do play
async function historicoDaTela(callId) {
  const aba = await abaDoInteract();
  try {
    return aba ? await chrome.tabs.sendMessage(aba.id, { tipo: "historico?", callId }) : null;
  } catch {
    return null; // sem content script na aba: gera só com o que veio pela API
  }
}

async function informarCpf() {
  const alvo = s.cpfNaTela;
  if (!s.ligado || !alvo || s.cpfsInformados.has(alvo.callId)) return;
  if (!(s.estado?.conversas || []).some((c) => c.call_id === alvo.callId)) return; // o chat ainda não chegou pela API
  s.cpfsInformados.add(alvo.callId);
  try {
    await api.informarCpf(alvo.callId, alvo.cpf);
  } catch (erro) {
    if (erro instanceof api.SessaoExpirada) return voltarAoLogin();
    if (!erro.status) s.cpfsInformados.delete(alvo.callId); // rede: tenta na próxima
  }
}

// ---------- uso das sugestões (eventos) ----------
function conversaAtual() {
  if (s.verLista) return null;
  const conversas = s.estado?.conversas || [];
  const id = chatSelecionado(conversas, { escolhido: s.escolhido, naTela: s.naTela });
  return conversas.find((c) => c.call_id === id) || null;
}

function encerrarVistas(callIdQueFica, motivo) {
  for (const [id, v] of s.vistas) {
    if (v.fim || v.callId === callIdQueFica) continue;
    v.fim = true;
    if (!v.usada) registrar("ignorou", { callId: v.callId, sugestaoId: id, dados: { motivo } });
  }
}

function acompanharUso() {
  const atual = conversaAtual();
  const ultima = ultimaDoCliente(atual);
  if (ultima?.sugestao_id && ultima.sugestoes?.length && !s.vistas.has(ultima.sugestao_id)) {
    s.vistas.set(ultima.sugestao_id, { callId: atual.call_id, seq: ultima.seq, sugestoes: ultima.sugestoes, exibidaEm: Date.now() });
    registrar("exibiu", { callId: atual.call_id, sugestaoId: ultima.sugestao_id, dados: { sugestoes: ultima.sugestoes.length } });
  }
  const porId = new Map((s.estado?.conversas || []).map((c) => [c.call_id, c]));
  for (const [id, v] of s.vistas) {
    if (v.fim) continue;
    const conversa = porId.get(v.callId);
    const resposta = respostaDoAtendente(conversa, v.seq);
    if (resposta) {
      const uso = usoDaSugestao(v.sugestoes, resposta.texto);
      registrar("enviou", { callId: v.callId, sugestaoId: id,
        dados: { ...uso, segundos_ate_enviar: Math.round((Date.now() - v.exibidaEm) / 1000) } });
      v.fim = true;
    } else if (!conversa || clienteFalouDeNovo(conversa, v.seq) || Date.now() - v.exibidaEm > IGNORADA_MS) {
      v.fim = true;
      if (!v.usada) registrar("ignorou", { callId: v.callId, sugestaoId: id,
        dados: { motivo: conversa && clienteFalouDeNovo(conversa, v.seq) ? "nova_mensagem" : "tempo" } });
    }
  }
}

// ---------- desenho ----------
function hora(valor) {
  const m = String(valor ?? "").match(/(\d{2}):(\d{2})/);
  if (m) return m[0];
  const d = typeof valor === "number" ? new Date(valor < 1e12 ? valor * 1000 : valor) : null;
  return d && !isNaN(d) ? d.toTimeString().slice(0, 5) : "";
}

function cenarioDe(conversa) {
  return [...(conversa.mensagens || [])].reverse().find((m) => m.papel === "cliente" && m.cenario)?.cenario || null;
}

function selos(conversa) {
  const cenario = cenarioDe(conversa);
  if (!cenario) return "";
  const nome = cenario.cenario === "bravo" ? "Cliente bravo" : "Comparando preço";
  return `<span class="selo ${esc(cenario.cenario)}">${nome}</span>${cenario.critico ? '<span class="selo critico">Crítico</span>' : ""}`;
}

function desenharChats(conversas, selecionado) {
  const outros = conversas.filter((c) => c.call_id !== selecionado && !c.encerrada);
  if (!outros.length) return "";
  return `<h2 class="rotulo">${selecionado ? "Outros chats" : "Seus chats: escolha em qual quer ajuda"}</h2><ul class="chats">${outros.map((c) => {
    const ultima = (c.mensagens || []).filter((m) => m.papel !== "sistema").at(-1);
    const aguardando = ultima?.papel === "cliente" ? '<span class="selo aguardando">Aguardando você</span>' : "";
    return `<li><button class="chat" data-acao="escolher" data-chat="${esc(c.call_id)}">
      <span class="linha"><span class="nome">${esc(c.cliente || "Cliente")}</span>${c.call_id === s.naTela ? '<span class="selo tela">Na tela</span>' : ""}${aguardando}${selos(c)}<span class="hora">${esc(hora(ultima?.hora))}</span></span>
      <span class="ultima">${esc(ultima ? `${ultima.papel === "atendente" ? "Você: " : ""}${resumo(ultima.texto)}` : "Nenhuma mensagem desde que você ligou")}</span></button></li>`;
  }).join("")}</ul>`;
}

// a ajuda é sempre para a última mensagem do cliente, destacada na conversa: o atendente vê para qual momento é
function desenharSugestoes(conversa, ultima) {
  const quando = hora(ultima.hora) ? ` das ${hora(ultima.hora)}` : "";
  if (ultima.sugerindo) return `<div class="gerando">Gerando 2 respostas para a mensagem${esc(quando)}… (até 20 s)</div>`;
  const sugestoes = ultima.sugestoes || [];
  if (!sugestoes.length) {
    const motivo = ultima.aviso
      ? '<div class="aviso-caixa">Você está cotando, então a IA fica em pausa. Quando tiver os valores, peça de novo.</div>'
      : ultima.baixa_confianca ? '<p class="nota">A IA não teve confiança suficiente para sugerir aqui. Responda do seu jeito ou tente de novo.</p>'
      : ultima.sugestao_id ? '<p class="nota">A IA não conseguiu sugerir agora. Tente de novo.</p>' : "";
    return `${motivo}<button class="primario largo ajuda" data-acao="gerar">✨ Quero ajuda do copiloto</button>
      <p class="nota centro">Gera 2 respostas para a mensagem${esc(quando)} do cliente, destacada acima.</p>`;
  }
  // inserir só no chat que está aberto no Interact: nunca no chat de outro cliente
  const naTela = conversa.call_id === s.naTela;
  const respondida = respostaDoAtendente(conversa, ultima.seq)
    ? '<p class="aviso-caixa">Você já respondeu depois desta mensagem. Se o cliente escrever de novo, peça novas sugestões.</p>' : "";
  return `<h4 class="rotulo-sugestoes">Respostas para a mensagem${esc(quando)}</h4>${respondida}` + sugestoes.map((sug, i) => {
    const feito = s.feito[`${ultima.sugestao_id}#${i}`];
    const inserir = naTela ? `<button class="primario" data-acao="inserir" data-indice="${i}">Inserir na resposta</button>`
      : '<button class="primario" disabled title="A sugestão só entra no chat aberto no Interact">Abra este chat no Interact</button>';
    return `<div class="sugestao"><div class="texto">${esc(sug.texto)}</div>
    <div class="acoes">${inserir}<button class="secundario" data-acao="copiar" data-indice="${i}">Copiar</button></div>
    ${feito ? `<div class="feito">${esc(feito)}</div>` : ""}</div>`;
  }).join("") + '<p class="nota">Inserir só escreve no fim da caixa. Não envia nem apaga.</p>'
    + desenharAvaliacao(ultima.sugestao_id) + '<button class="link" data-acao="gerar">↻ Gerar outras sugestões</button>';
}

const reais = (v) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const diaSemana = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" });

function desenharPrecos() {
  const p = s.precos;
  if (!p.aberto) return '<button class="link precos-abrir" data-acao="precos-abrir">💰 Cliente achou caro? Ver datas mais baratas</button>';
  const campo = (nome, rotulo, tipo, extra = "") =>
    `<label class="campo-preco"><span>${rotulo}</span><input type="${tipo}" data-campo="preco-${nome}" ${extra}></label>`;
  const escolhas = p.escolhas ? `<p class="nota">Qual destes?</p><ul class="escolhas">${p.escolhas.map((h) =>
    `<li><button class="secundario" data-acao="precos-hotel" data-id="${h.id}">${esc(h.nome)} <span class="nota">#${h.id}</span></button></li>`).join("")}</ul>` : "";
  const r = p.resultado;
  const pedida = r?.cotacoes.find((c) => c.checkin === r.pedida);  // "Copiar oferta" só em data mais barata que a pedida
  const linhas = r ? r.cotacoes.map((c) => {
    const selo = (c.checkin === r.mais_barata ? '<span class="selo barata">Mais barata</span>' : "")
      + (c.checkin === r.pedida ? '<span class="selo">Pedida</span>' : "");
    return `<li class="${c.checkin === r.mais_barata ? "barata" : ""}"><span class="data">${esc(diaSemana(c.checkin))}</span>${selo}
      <span class="valor">${c.disponivel ? esc(valorDoCliente(c))
        : c.erro ? "não consegui consultar" : c.filtro === "sem_quarto" ? "sem quarto com esse filtro"
        : c.filtro === "valor_no_site" ? "tem quarto, valor só no site" : "não confirmado: veja no site"}</span>
      ${c.quartos?.length ? `<span class="quarto">${esc(c.quartos[0].quarto)} · ${esc(c.quartos[0].regime)} · ${c.quartos[0].reembolsavel ? "cancelamento grátis" : "não reembolsável"}${c.quartos.length > 1 ? ` <span class="nota">(+${c.quartos.length - 1} tipo${c.quartos.length > 2 ? "s" : ""})</span>` : ""}</span>` : ""}
      ${c.disponivel && c.checkin !== r.pedida && !(pedida?.disponivel && !maisBarataQue(c, pedida)) ? `<button class="link" data-acao="precos-copiar" data-checkin="${c.checkin}">Copiar oferta</button>` : ""}</li>`;
  }).join("") : "";
  const barata = r?.cotacoes.find((c) => c.checkin === r.mais_barata);
  const resumoTexto = !r ? "" : !barata ? '<p class="aviso-caixa">Nenhuma data confirmada nesses dias. Pode ser falta de quarto ou o fornecedor fora do ar: confira no site antes de dizer ao cliente que não há vaga.</p>'
    : r.mais_barata === r.pedida ? '<p class="aviso-caixa">A data pedida já é a mais barata desses dias.</p>'
    : r.economia ? `<p class="aviso-caixa">Entrando em ${esc(diaSemana(r.mais_barata))} o cliente economiza o equivalente a ${esc(reais(r.economia))}.</p>`
    : r.diarias_a_menos > 0 ? `<p class="aviso-caixa">Entrando em ${esc(diaSemana(r.mais_barata))} o cliente usa ${r.diarias_a_menos} ${r.diarias_a_menos === 1 ? "diária" : "diárias"} a menos do plano.</p>` : "";
  const quartos = barata?.quartos?.length > 1 ? `<p class="nota">Outros quartos na mais barata: ${esc(barata.quartos.slice(1).map((q) => `${q.quarto} (${q.regime})`).join(", "))}</p>` : "";
  return `<div class="precos">
    <div class="detalhe-topo"><h3>💰 Datas mais baratas</h3><button class="link" data-acao="precos-fechar" aria-label="Fechar">✕</button></div>
    <div class="form-precos">${campo("hotel", "Hotel (nome ou ID)", "text", 'placeholder="ex.: Águas de Palmas ou 3525"')}
      ${campo("checkin", "Check-in", "date")}${campo("noites", "Noites", "number", 'min="1" max="14"')}${campo("adultos", "Adultos", "number", 'min="1" max="6"')}
      <label class="filtro-preco"><input type="checkbox" data-campo="preco-cafe"> Com café da manhã</label>
      <label class="filtro-preco"><input type="checkbox" data-campo="preco-reembolsavel"> Cancelamento grátis</label>
      <button class="primario largo" data-acao="precos-buscar" ${p.buscando ? "disabled" : ""}>${p.buscando ? "Consultando 7 datas…" : "Buscar"}</button></div>
    ${p.erro ? `<p class="aviso-caixa">${esc(p.erro)}</p>` : ""}${escolhas}
    ${r ? `<h4 class="rotulo-sugestoes">${esc(r.hotel || `Hotel #${r.id_hotel}`)}</h4><ul class="cotacoes">${linhas}</ul>${resumoTexto}${quartos}
      <p class="nota">${r.plano === "cliente" ? `Valores no plano de <b>${esc(r.cliente || "cliente do chat")}</b> (cliente da ficha).`
        : "Demonstração: valores do plano da conta configurada no copiloto, não do cliente do chat."} "Não confirmado" pode ser falta de quarto ou o fornecedor fora do ar. O prazo do cancelamento grátis está no detalhe do hotel, no site.</p>` : ""}
  </div>`;
}

async function buscarPrecos(idHotel) {
  const p = s.precos;
  if (p.buscando) return;  // Enter durante a consulta
  const termo = p.form.hotel.trim();
  p.erro = "";
  p.escolhas = null;
  if (!idHotel && !/^\d+$/.test(termo)) {
    if (termo.length < 3) { p.erro = "Digite o nome (3 letras ou mais) ou o ID do hotel."; return desenhar(); }
    try {
      const { hoteis } = await api.hoteis(termo);
      if (hoteis.length !== 1) {
        p.erro = hoteis.length ? "" : "Nenhum hotel com esse nome.";
        p.escolhas = hoteis.length ? hoteis : null;
        return desenhar();
      }
      idHotel = hoteis[0].id;
    } catch (erro) {
      if (erro instanceof api.SessaoExpirada) return voltarAoLogin();
      p.erro = erro.message;
      return desenhar();
    }
  }
  if (!p.form.checkin) { p.erro = "Informe o check-in."; return desenhar(); }
  p.buscando = true;
  desenhar();
  try {
    p.resultado = await api.precosHotel({ hotel: idHotel || termo, checkin: p.form.checkin, noites: p.form.noites, adultos: p.form.adultos,
      cafe: p.form.cafe ? 1 : 0, reembolsavel: p.form.reembolsavel ? 1 : 0, call: conversaAtual()?.call_id || "" });
  } catch (erro) {
    if (erro instanceof api.SessaoExpirada) return voltarAoLogin();
    p.erro = erro.message;
  } finally {
    p.buscando = false;
  }
  desenhar();
}

// as últimas mensagens desde o play; a que a ajuda responde fica destacada
function desenharConversa(conversa, ultima) {
  const msgs = (conversa.mensagens || []).filter((m) => m.papel !== "sistema").slice(-6);
  if (!msgs.length) return '<p class="nota">As mensagens aparecem a partir de agora: o copiloto não vê o que foi conversado antes de ser ligado.</p>';
  return `<div class="conversa">${msgs.map((m) => `<div class="msg ${m.papel}${m === ultima || m.seq === ultima?.seq ? " alvo" : ""}">
    <span class="quem">${m.papel === "cliente" ? esc(conversa.cliente || "Cliente") : "Você"} ${esc(hora(m.hora))}</span>
    <div class="txt">${esc(m.texto)}</div></div>`).join("")}</div>`;
}

// 👍/👎 e comentário livre do atendente sobre as sugestões; o texto do campo é posto depois do desenho (desenhar)
function desenharAvaliacao(sugestaoId) {
  const a = s.avaliacoes[sugestaoId] || {};
  if (a.enviada) return '<div class="avaliar"><span class="feito">✓ Avaliação registrada. Obrigado!</span></div>';
  const botao = (nota, icone, rotulo) => `<button class="nota-btn${a.nota === nota ? " marcada" : ""}" data-acao="nota"
    data-nota="${nota}" aria-pressed="${a.nota === nota}" aria-label="${rotulo}" title="${rotulo}">${icone}</button>`;
  return `<div class="avaliar"><div class="avaliar-topo"><span>Essas sugestões ajudaram?</span>${botao("positivo", "👍", "Ajudaram")}${botao("negativo", "👎", "Não ajudaram")}</div>
    ${a.nota ? `<textarea data-campo="comentario" data-sugestao="${esc(sugestaoId)}" maxlength="500" rows="2" aria-label="Comentário"
      placeholder="${a.nota === "negativo" ? "O que estava errado ou faltou?" : "Comentário"} (opcional, sem CPF ou dados do cliente)"></textarea>
      <button class="primario largo" data-acao="avaliar">Enviar avaliação</button>` : ""}</div>`;
}

function alertaAtual(conversa) {
  const ultima = (conversa.mensagens || []).filter((m) => m.papel === "atendente").at(-1);
  return ultima?.alertas?.length ? { mensagem: ultima, alerta: ultima.alertas[0] } : null;
}

function desenharDetalhe(conversa) {
  if (!conversa) {
    return (s.estado?.conversas || []).length ? ""
      : '<div class="vazio">Nenhum chat seu aberto agora. Quando um cliente falar com você, ele aparece aqui.</div>';
  }
  const ultima = ultimaDoCliente(conversa);
  const alerta = alertaAtual(conversa);
  const critico = cenarioDe(conversa)?.critico
    ? '<p class="risco">Risco de reclamação formal: responda com calma e chame a coordenação se precisar.</p>' : "";
  const corpo = conversa.encerrada ? '<p class="nota">Este atendimento foi encerrado.</p>'
    : !ultima ? `<button class="primario largo ajuda" data-acao="gerar">✨ Quero ajuda do copiloto</button>
      <p class="nota centro">A IA lê a conversa que está aberta no Interact e gera 2 respostas para a última mensagem do cliente.</p>`
    : desenharSugestoes(conversa, ultima);
  return `<div class="detalhe">
    <div class="detalhe-topo"><button class="link voltar" data-acao="voltar" aria-label="Voltar para a lista de chats">←</button><h3>${esc(conversa.cliente || "Cliente")}</h3>${conversa.call_id === s.naTela ? '<span class="selo tela">Na tela</span>' : ""}${selos(conversa)}</div>
    ${critico}${desenharConversa(conversa, ultima)}
    ${alerta ? `<div class="alerta-atendente">⚠ ${esc(textoDoAlerta(alerta.alerta))}</div>` : ""}
    ${corpo}
  </div>`;
}

function registrarAlertas() {
  const atual = conversaAtual();
  const alerta = atual && alertaAtual(atual);
  if (!alerta) return;
  const chave = `${atual.call_id}#${alerta.mensagem.seq}`;
  if (s.alertasVistos.has(chave)) return;
  s.alertasVistos.add(chave);
  for (const a of alerta.mensagem.alertas) registrar("alerta", { callId: atual.call_id, dados: alertaParaEvento(a) });
}

let ultimoHtml = "";
function desenhar() {
  if (!s.ligado) return;
  const sit = s.erro ? { nivel: "erro", texto: s.erro } : s.aviso ? { nivel: "aviso", texto: s.aviso } : situacao(s.estado);
  $("situacao").className = `situacao ${sit.nivel}`;
  $("situacao").innerHTML = `<span>${esc(sit.texto)}</span>${sit.nivel === "erro" ? '<button class="secundario" data-acao="tentar">Tentar de novo</button>' : ""}`;
  // sem conexão com o Interact a lista estaria vazia ou velha: mostra só o aviso
  const conectado = s.estado?.status === "conectado" || (s.estado?.conversas || []).length;
  const atual = conversaAtual();
  const html = (conectado && !(sit.nivel === "erro" && !s.erro) ? desenharDetalhe(atual) + desenharChats(s.estado?.conversas || [], atual?.call_id) : "")
    + desenharPrecos();
  if (html === ultimoHtml) return; // não redesenha à toa (mantém foco e cliques)
  ultimoHtml = html;
  const ativo = document.activeElement;
  const foco = ativo?.dataset?.campo;
  const cursor = foco && (ativo.type === "text" || ativo.tagName === "TEXTAREA") ? [ativo.selectionStart, ativo.selectionEnd] : null;
  $("conteudo").innerHTML = html;
  const campo = $("conteudo").querySelector('[data-campo="comentario"]');
  if (campo) campo.value = s.avaliacoes[campo.dataset.sugestao]?.comentario || "";
  for (const [nome, valor] of Object.entries(s.precos.form)) {
    const entrada = $("conteudo").querySelector(`[data-campo="preco-${nome}"]`);
    if (entrada?.type === "checkbox") entrada.checked = valor;
    else if (entrada) entrada.value = valor;
  }
  const volta = foco && $("conteudo").querySelector(`[data-campo="${foco}"]`);
  if (volta) { volta.focus(); if (cursor) volta.setSelectionRange(...cursor); } // quem digitava continua no mesmo ponto
}

async function tentarDeNovo() {
  s.erro = "";
  try {
    s.estado = await api.ativar(); // entra de novo na assinatura do Interact
  } catch (erro) {
    return tratar(erro, "sessao");
  }
  consultar();
}

// ---------- ações ----------
async function acao(evento) {
  const alvo = evento.target.closest("[data-acao]");
  if (!alvo) return;
  const atual = conversaAtual();
  const ultima = ultimaDoCliente(atual);
  const tipo = alvo.dataset.acao;
  if (tipo === "tentar") {
    tentarDeNovo();
  } else if (tipo === "escolher") {
    if (atual && alvo.dataset.chat !== atual.call_id) encerrarVistas(alvo.dataset.chat, "trocou_conversa");
    s.escolhido = alvo.dataset.chat;
    s.verLista = false;
    registrar("escolheu_cliente", { callId: s.escolhido, dados: { conversas_abertas: (s.estado?.conversas || []).length } });
    desenhar();
  } else if (tipo === "gerar" && atual) {
    alvo.disabled = true;
    registrar("pediu_sugestao", { callId: atual.call_id, dados: { gatilho: "botao" } });
    try { await api.sugerir(atual.call_id, await historicoDaTela(atual.call_id)); } catch (erro) { await tratar(erro, "sugerir"); }
    consultar();
  } else if (tipo === "precos-abrir" || tipo === "precos-fechar") {
    s.precos.aberto = tipo === "precos-abrir";
    if (s.precos.aberto && !s.precos.form.checkin) s.precos.form.checkin = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    desenhar();
  } else if (tipo === "precos-buscar" || tipo === "precos-hotel") {
    buscarPrecos(alvo.dataset.id);
  } else if (tipo === "precos-copiar" && s.precos.resultado) {
    const r = s.precos.resultado;
    const cotacao = r.cotacoes.find((c) => c.checkin === alvo.dataset.checkin);
    if (await copiar(textoDaOferta(cotacao, r.cotacoes.find((c) => c.checkin === r.pedida)))) avisar("✓ Oferta copiada. Cole no Interact e revise antes de enviar.");
  } else if (tipo === "voltar") {
    s.verLista = true;
    desenhar();
  } else if ((tipo === "inserir" || tipo === "copiar") && ultima?.sugestoes) {
    const i = Number(alvo.dataset.indice);
    const texto = ultima.sugestoes[i]?.texto || "";
    const ok = tipo === "inserir" ? await inserir(atual.call_id, texto) : await copiar(texto);
    if (!ok) return;
    const vista = s.vistas.get(ultima.sugestao_id);
    if (vista) vista.usada = true;
    registrar(tipo === "inserir" ? "inseriu" : "copiou", { callId: atual.call_id, sugestaoId: ultima.sugestao_id, dados: { indice: i + 1 } });
    s.feito[`${ultima.sugestao_id}#${i}`] = tipo === "inserir" ? "✓ Inserida no fim da caixa. Revise e envie no Interact." : "✓ Copiada";
    desenhar();
  } else if (tipo === "nota" && ultima?.sugestao_id) {
    s.avaliacoes[ultima.sugestao_id] = { ...s.avaliacoes[ultima.sugestao_id], nota: alvo.dataset.nota };
    desenhar();
  } else if (tipo === "avaliar" && ultima?.sugestao_id) {
    const a = s.avaliacoes[ultima.sugestao_id];
    registrar("avaliou", { callId: atual.call_id, sugestaoId: ultima.sugestao_id,
      dados: { nota: a.nota, comentario: a.comentario?.trim() || undefined } });
    a.enviada = true;
    enviar(); // sem rede, fica na fila e vai depois
    desenhar();
  }
}

// aviso de uma ação (inserir/copiar): some sozinho, sem botão de Tentar de novo
function avisar(texto) {
  s.aviso = texto;
  desenhar();
  setTimeout(() => { s.aviso = ""; desenhar(); }, 6000);
}

async function inserir(callId, texto) {
  const aba = await abaDoInteract();
  let resposta = null;
  try {
    resposta = aba && (await chrome.tabs.sendMessage(aba.id, { tipo: "inserir", callId, texto }));
  } catch { /* sem content script na aba */ }
  if (resposta?.ok) return true;
  avisar(resposta?.motivo || "Não consegui escrever no Interact. Use “Copiar” e cole na resposta.");
  return false;
}

async function copiar(texto) {
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch {
    avisar("Não consegui copiar. Selecione o texto e use Ctrl+C.");
    return false;
  }
}

// ---------- ligações ----------
$("form-login").addEventListener("submit", async (evento) => {
  evento.preventDefault();
  $("erro-login").textContent = "";
  const botao = evento.submitter;
  botao.disabled = true;
  try {
    const usuario = await api.entrar($("email").value.trim(), $("senha").value);
    $("senha").value = "";
    $("usuario").textContent = usuario?.nome || usuario?.email || "";
    $("sair").hidden = false;
    mostrar("tela-desligado");
  } catch (erro) {
    $("erro-login").textContent = erro.status === 401 ? "E-mail ou senha incorretos." : erro.message;
  } finally {
    botao.disabled = false;
  }
});
$("ligar").addEventListener("click", ligar);
$("desligar").addEventListener("click", desligar);
$("sair").addEventListener("click", async () => {
  if (s.ligado) await desligar();
  await api.sair();
  await limparFila();
  $("usuario").textContent = "";
  $("sair").hidden = true;
  mostrar("tela-login");
});
$("minimizar").addEventListener("click", () => window.close()); // fecha o painel; o ícone da extensão traz de volta
$("abrir-opcoes").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("tela-ligado").addEventListener("click", acao);
$("tela-ligado").addEventListener("input", (evento) => {
  const campo = evento.target;
  if (campo.dataset.campo === "comentario") s.avaliacoes[campo.dataset.sugestao].comentario = campo.value;
  else if (campo.dataset.campo?.startsWith("preco-")) s.precos.form[campo.dataset.campo.slice(6)] = campo.type === "checkbox" ? campo.checked : campo.value;
});
$("tela-ligado").addEventListener("keydown", (evento) => {
  if (evento.key === "Enter" && evento.target.dataset.campo?.startsWith("preco-")) buscarPrecos();
});
chrome.storage.onChanged.addListener((mudou) => { if (mudou.urlView) iniciar(); });

iniciar();
