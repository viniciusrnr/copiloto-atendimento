// Sidebar STATELESS: o copiloto lê o chat aberto na tela do Interact (content.js) e pede sugestão ao worker por
// requisição curta (/sugerir-direto). Nada de estado no servidor (sem monitor). O que o atendente vê é sempre o
// chat que está na tela. Modo contínuo: a cada nova mensagem do cliente, pede sozinho (1 por vez).
import * as api from "../src/api.js";
import { enviar, iniciarFila, limparFila, novaSessao, registrar } from "../src/eventos.js";
import { usoDaSugestao } from "../src/regras.js";

const INTERACT = "https://rdc.digitro.cloud/*";
const $ = (id) => document.getElementById(id);
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const s = {
  ligado: false, features: {}, callId: null, cpf: null, cliente: null, ficha: null, fichaAberta: false,
  historico: [], sugestoes: null, sugestaoId: null, aviso: null, cenario: null, gerando: false, erro: "",
  continuo: false, chaveUltimaSug: null, feito: {}, avaliacao: {}, usada: false,
  cardapio: null, cardapioErro: "", msg: "",
  precos: { aberto: false, form: { hotel: "", checkin: "", noites: "2", adultos: "2", cafe: false, reembolsavel: false }, buscando: false, erro: "", resultado: null, escolhas: null },
};

function mostrar(tela) {
  for (const id of ["tela-config", "tela-login", "tela-supervisao", "tela-desligado", "tela-ligado"]) $(id).hidden = id !== tela;
  $("desligar").hidden = tela !== "tela-ligado";
}

async function iniciar() {
  await iniciarFila();
  const { urlView, sessao } = await api.config();
  $("usuario").textContent = sessao ? sessao.usuario?.nome || sessao.usuario?.email || "" : "";
  $("sair").hidden = !sessao;
  $("modo-supervisao").hidden = true;  // supervisão central dependia do monitor: fora do modelo stateless
  if (!urlView) return mostrar("tela-config");
  if (!sessao) return mostrar("tela-login");
  s.features = sessao.features || {};
  const { ligado } = await chrome.storage.local.get("ligado");
  if (ligado) return ligar();
  mostrar("tela-desligado");
}

function voltarAoLogin() {
  s.ligado = false;
  chrome.storage.local.set({ ligado: false });
  $("usuario").textContent = "";
  $("sair").hidden = true;
  $("erro-login").textContent = "Sua sessão expirou. Entre de novo.";
  mostrar("tela-login");
}

// ---------- ligar / desligar ----------
async function ligar() {
  s.ligado = true;
  novaSessao();
  registrar("ativou");
  chrome.storage.local.set({ ligado: true });
  mostrar("tela-ligado");
  await perguntarTela();
  desenhar();
}

async function desligar() {
  s.ligado = false;
  s.continuo = false;
  registrar("desativou", { dados: { motivo: "botao" } });
  chrome.storage.local.set({ ligado: false });
  mostrar("tela-desligado");
  enviar();
}

// ---------- tela do Interact ----------
async function abaDoInteract() {
  const [ativa] = await chrome.tabs.query({ url: INTERACT, active: true, lastFocusedWindow: true });
  return ativa || (await chrome.tabs.query({ url: INTERACT }))[0] || null;
}

async function pedir(mensagem) {
  const aba = await abaDoInteract();
  if (!aba) return null;
  try { return await chrome.tabs.sendMessage(aba.id, mensagem); } catch { return null; }
}

async function perguntarTela() {
  aoMudarTela(await pedir({ tipo: "tela?" }));
}

async function aoMudarTela(tela) {
  if (!s.ligado) return;
  const callId = tela?.callId || null;
  if (callId !== s.callId) {  // trocou de chat na tela: zera o que era do chat anterior
    s.callId = callId;
    s.sugestoes = null; s.sugestaoId = null; s.aviso = null; s.cenario = null;
    s.cardapio = null; s.cardapioErro = ""; s.chaveUltimaSug = null; s.usada = false;
  }
  const cpfNovo = tela?.cpf || null;
  if (cpfNovo !== s.cpf) { s.cpf = cpfNovo; s.ficha = null; carregarFicha(); }  // CPF mudou: recarrega a ficha
  s.historico = callId ? (await pedir({ tipo: "historico?", callId })) || [] : [];
  // acompanha o uso: atendente respondeu depois da sugestão?
  registrarEnvioSeRespondeu();
  // mensagem nova do cliente desde a última sugestão: some a sugestão antiga e reaparece "Gerar mensagem";
  // no modo contínuo, pede sozinho. (Sem msg nova, NÃO oferece "tentar de novo".)
  if (s.features.suggest && callId && !s.gerando) {
    const ultima = [...s.historico].reverse().find((m) => m.direcao === "in");
    const chave = ultima ? (ultima.id || `t:${ultima.texto}`) : null;  // id estável: evita reset por re-render do DOM
    if (chave && chave !== s.chaveUltimaSug) {
      if (s.sugestoes !== null) { s.sugestoes = null; s.sugestaoId = null; s.aviso = null; }
      if (s.continuo) sugerir(true);
    }
  }
  desenhar();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.tipo === "tela") aoMudarTela(msg);
  else if (msg.tipo === "evento") registrar(msg.evento, { callId: msg.callId, dados: msg.dados });  // trava do Enviar
});

// ---------- sugestão ----------
async function sugerir(automatico = false) {
  if (!s.callId || s.gerando || !s.features.suggest) return;
  const ultima = [...s.historico].reverse().find((m) => m.direcao === "in");
  if (!ultima) { s.msg = "Sem mensagem do cliente na tela para sugerir."; return desenhar(); }
  s.chaveUltimaSug = ultima.id || `t:${ultima.texto}`;  // mesma chave estável do aoMudarTela
  s.gerando = true; s.erro = ""; s.usada = false;
  registrar("pediu_sugestao", { callId: s.callId, dados: { gatilho: automatico ? "automatico" : "botao" } });
  desenhar();
  try {
    const d = await api.sugerirDireto({ call_id: s.callId, historico: s.historico, cpf: s.cpf || undefined, automatico });
    s.sugestoes = d.sugestoes || [];
    s.sugestaoId = d.sugestao_id || null;
    s.aviso = d.aviso || null;
    s.cenario = d.cenario || null;
    s.feito = {}; s.avaliacao = {};
    if (s.sugestaoId && s.sugestoes.length) registrar("exibiu", { callId: s.callId, sugestaoId: s.sugestaoId, dados: { sugestoes: s.sugestoes.length } });
  } catch (erro) {
    if (erro instanceof api.SessaoExpirada) return voltarAoLogin();
    s.erro = erro.message;
  } finally {
    s.gerando = false;
  }
  desenhar();
}

function registrarEnvioSeRespondeu() {
  if (!s.sugestaoId || s.usada) return;
  const ultima = s.historico[s.historico.length - 1];
  if (ultima && ultima.direcao === "out") {  // atendente mandou algo depois da sugestão
    const uso = usoDaSugestao((s.sugestoes || []).map((x) => x.texto ? x : { texto: x.texto }), ultima.texto);
    registrar("enviou", { callId: s.callId, sugestaoId: s.sugestaoId, dados: uso });
    s.usada = true;
  }
}

// ---------- ficha do cliente ----------
async function carregarFicha() {
  if (!s.cpf) { s.ficha = null; return desenhar(); }
  try {
    const d = await api.fichaDireto(s.cpf);
    s.ficha = d && d.encontrado ? d : null;
  } catch (erro) {
    if (erro instanceof api.SessaoExpirada) return voltarAoLogin();
    s.ficha = null;
  }
  desenhar();
}

function renderFicha() {
  if (!s.ficha) return "";
  const f = s.ficha, c = f.cliente || {}, sit = f.situacao || {}, di = f.diarias || {};
  if (!s.fichaAberta) return `<button class="link" data-acao="ficha-toggle">👤 Dados do cliente de ${esc(c.nome || "—")} ▸</button>`;
  const money = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const titulos = (f.titulos || []).map((t) => `<li>Título ${esc(String(t.numero ?? ""))} — ${esc(t.status || "")}</li>`).join("");
  const reservas = (f.reservas || []).map((r) => `<li>${esc(r.hotel || "—")} · ${esc(r.entrada || "?")}→${esc(r.saida || "?")} (${esc(r.status || "")})</li>`).join("");
  const contato = [c.celular, c.email].filter(Boolean).map(esc).join(" · ");
  return `<div class="ficha">
    <div class="detalhe-topo"><h3>👤 Dados do cliente</h3><button class="link" data-acao="ficha-toggle">▾ recolher</button></div>
    <p><b>${esc(c.nome || "—")}</b>${c.codigo ? ` · cód ${esc(String(c.codigo))}` : ""}</p>
    ${c.cpf || contato ? `<p class="nota">${esc(c.cpf || "")}${contato ? " · " + contato : ""}</p>` : ""}
    <p>${sit.adimplente ? "✅ Adimplente" : `⚠️ ${esc(String(sit.parcelas_atraso))} parcela(s) em atraso · ${money(sit.valor_atraso)}`}</p>
    <p>Diárias: saldo <b>${esc(String(di.saldo ?? "—"))}</b> (adquiridas ${esc(String(di.adquiridas ?? "—"))} / usadas ${esc(String(di.utilizadas ?? "—"))})</p>
    ${titulos ? `<div class="ficha-sec"><b>Títulos</b><ul class="ex-lista">${titulos}</ul></div>` : ""}
    ${reservas ? `<div class="ficha-sec"><b>Reservas</b><ul class="ex-lista">${reservas}</ul></div>` : ""}
  </div>`;
}

// ---------- cardápio (inadimplente) ----------
async function carregarCardapio() {
  if (!s.cpf || !s.features.rules) return;
  s.cardapioErro = ""; s.cardapio = null; desenhar();
  try {
    s.cardapio = await api.cardapio(s.cpf);
  } catch (erro) {
    if (erro instanceof api.SessaoExpirada) return voltarAoLogin();
    s.cardapioErro = erro.message;
  }
  desenhar();
}

// ---------- preços ----------
async function buscarPrecos(idHotel) {
  const p = s.precos;
  if (p.buscando) return;
  p.erro = ""; p.escolhas = null;
  const termo = p.form.hotel.trim();
  // aceita o ID (número) ou o NOME: o worker resolve o nome pelo melhor match do Reservas
  if (!idHotel && !/^\d+$/.test(termo) && termo.length < 3) {
    p.erro = "Digite o nome (3+ letras) ou o ID do hotel."; return desenhar();
  }
  if (!p.form.checkin) { p.erro = "Informe o check-in."; return desenhar(); }
  p.buscando = true; desenhar();
  try {
    p.resultado = await api.precosDireto({ hotel: idHotel || termo, checkin: p.form.checkin, noites: Number(p.form.noites),
      adultos: Number(p.form.adultos), cpf: s.cpf || undefined, cafe: p.form.cafe, reembolsavel: p.form.reembolsavel });
  } catch (erro) {
    if (erro instanceof api.SessaoExpirada) return voltarAoLogin();
    p.erro = erro.message;
  } finally {
    p.buscando = false;
  }
  desenhar();
}

// ---------- desenho ----------
function renderSugestoes() {
  if (s.gerando) return '<div class="gerando">Gerando sugestões… (até 20 s)</div>';
  if (s.aviso) return '<div class="aviso-caixa">Você está cotando, então a IA fica em pausa. Quando tiver os valores, peça de novo.</div>'
    + '<button class="primario largo ajuda" data-acao="gerar">✨ Gerar mensagem</button>';
  if (!s.sugestoes) return `<button class="primario largo ajuda" data-acao="gerar">✨ Gerar mensagem</button>
    <p class="nota centro">Gera respostas para a última mensagem do cliente no chat aberto.</p>`;
  if (!s.sugestoes.length) return `<p class="nota">A IA não sugeriu aqui (sem confiança ou fora de gatilho). Responda do seu jeito — quando o cliente mandar outra mensagem, eu tento de novo.</p>`;
  return '<h4 class="rotulo-sugestoes">Sugestões para a última mensagem do cliente</h4>' + s.sugestoes.map((sug, i) => {
    const feito = s.feito[i];
    return `<div class="sugestao"><div class="texto">${esc(sug.texto)}</div>
      <div class="acoes"><button class="primario" data-acao="inserir" data-indice="${i}">Inserir na resposta</button>
      <button class="secundario" data-acao="copiar" data-indice="${i}">Copiar</button></div>
      ${feito ? `<div class="feito">${esc(feito)}</div>` : ""}</div>`;
  }).join("") + '<p class="nota">Inserir só escreve no fim da caixa. Não envia nem apaga.</p>'
    + renderAvaliacao() + '<button class="link" data-acao="gerar">↻ Gerar outras</button>';
}

function renderAvaliacao() {
  if (!s.sugestaoId) return "";
  const a = s.avaliacao;
  if (a.enviada) return '<div class="avaliar"><span class="feito">✓ Avaliação registrada. Obrigado!</span></div>';
  const botao = (nota, icone, rotulo) => `<button class="nota-btn${a.nota === nota ? " marcada" : ""}" data-acao="nota" data-nota="${nota}" aria-label="${rotulo}" title="${rotulo}">${icone}</button>`;
  return `<div class="avaliar"><div class="avaliar-topo"><span>Essas sugestões ajudaram?</span>${botao("positivo", "👍", "Ajudaram")}${botao("negativo", "👎", "Não ajudaram")}</div>
    ${a.nota ? `<textarea data-campo="comentario" maxlength="500" rows="2" placeholder="Comentário (opcional, sem dados do cliente)"></textarea>
      <button class="primario largo" data-acao="avaliar">Enviar avaliação</button>` : ""}</div>`;
}

function renderCardapio() {
  if (!s.features.rules || !s.cpf) return "";
  if (!s.cardapio) return `<button class="link" data-acao="cardapio">📋 Cliente inadimplente? Ver regras/ofertas</button>${s.cardapioErro ? `<p class="aviso-caixa">${esc(s.cardapioErro)}</p>` : ""}`;
  const ofertas = (s.cardapio.cardapio || []).map((o) => `<div class="oferta"><div class="oferta-txt"><b>${esc(o.titulo || o.id || "Oferta")}</b> · ${esc(o.texto || "")}</div>
    <button class="link" data-acao="copiar-texto" data-texto="${esc(o.texto || "")}">Copiar</button></div>`).join("");
  const regras = (s.cardapio.regras || []).map((r) => `<li>${esc(r.regra)} <button class="link" data-acao="copiar-texto" data-texto="${esc(r.regra)}">Copiar</button></li>`).join("");
  return `<div class="ofertas"><div class="ofertas-tit">${s.cardapio.inadimplente ? "Cliente inadimplente · ofertas" : "Regras disponíveis"}</div>
    ${ofertas || ""}${regras ? `<ul class="ex-lista">${regras}</ul>` : ""}
    <button class="link" data-acao="cardapio-fechar">Fechar</button></div>`;
}

function renderPrecos() {
  if (!s.features.prices) return "";
  const p = s.precos;
  if (!p.aberto) return '<button class="link precos-abrir" data-acao="precos-abrir">💰 Datas mais baratas do hotel</button>';
  const r = p.resultado;
  const linhas = r && r.cotacoes ? r.cotacoes.map((c) => `<li>${esc(c.checkin)} — ${c.disponivel ? esc(valorTexto(c)) : "não confirmado"}${c.checkin === r.mais_barata ? ' <span class="selo barata">mais barata</span>' : ""}</li>`).join("") : "";
  return `<div class="precos"><div class="detalhe-topo"><h3>💰 Datas mais baratas</h3><button class="link" data-acao="precos-fechar">✕</button></div>
    <label class="campo-preco"><span>Hotel (nome ou ID)</span><input type="text" data-campo="preco-hotel" placeholder="ex.: Boreas ou 93933"></label>
    <label class="campo-preco"><span>Check-in</span><input type="date" data-campo="preco-checkin"></label>
    <label class="campo-preco"><span>Noites</span><input type="number" min="1" max="14" data-campo="preco-noites"></label>
    <label class="campo-preco"><span>Adultos</span><input type="number" min="1" max="6" data-campo="preco-adultos"></label>
    <button class="primario largo" data-acao="precos-buscar" ${p.buscando ? "disabled" : ""}>${p.buscando ? "Consultando…" : "Buscar"}</button>
    ${p.erro ? `<p class="aviso-caixa">${esc(p.erro)}</p>` : ""}
    ${r && r.hotel_nome ? `<p class="nota">Hotel: <b>${esc(r.hotel_nome)}</b></p>` : ""}
    ${r && r.disponivel === false ? `<p class="aviso-caixa">${esc(r.aviso || "Preço no plano do cliente indisponível.")}</p>` : ""}
    ${linhas ? `<ul class="cotacoes">${linhas}</ul>` : ""}</div>`;
}

function valorTexto(c) {
  const partes = [];
  if (c.dinheiro != null) partes.push(Number(c.dinheiro).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
  if (c.pontos != null) partes.push(`${c.pontos} pts`);
  return partes.join(" + ") || "disponível";
}

function renderConversa() {
  const msgs = (s.historico || []).slice(-6);
  if (!msgs.length) return '<p class="nota">Abra um chat no Interact para o copiloto ler a conversa.</p>';
  return `<div class="conversa">${msgs.map((m) => `<div class="msg ${m.direcao === "in" ? "cliente" : "atendente"}">
    <span class="quem">${m.direcao === "in" ? esc(m.autor || "Cliente") : "Você"} ${esc(m.hora || "")}</span>
    <div class="txt">${esc(m.texto)}</div></div>`).join("")}</div>`;
}

let ultimoHtml = "";
function desenhar() {
  if (!s.ligado) return;
  const sit = s.erro ? { nivel: "erro", t: s.erro } : s.msg ? { nivel: "aviso", t: s.msg } : { nivel: "ok", t: s.callId ? "Lendo o chat aberto no Interact." : "Abra um chat no Interact." };
  $("situacao").className = `situacao ${sit.nivel}`;
  const contInput = s.features.suggest ? `<label class="continuo"><input type="checkbox" data-campo="continuo" ${s.continuo ? "checked" : ""}> Sugerir a cada nova mensagem do cliente</label>` : "";
  $("situacao").innerHTML = `<span>${esc(sit.t)}</span>`;
  const html = `<div class="detalhe">
    ${renderConversa()}
    ${renderFicha()}
    ${s.features.suggest ? renderSugestoes() : '<p class="nota">Seu usuário não tem a sugestão de IA habilitada.</p>'}
    ${contInput}
    ${renderCardapio()}
    ${renderPrecos()}
  </div>`;
  if (html === ultimoHtml) return;
  ultimoHtml = html;
  const ativo = document.activeElement;
  const foco = ativo?.dataset?.campo;
  $("conteudo").innerHTML = html;
  const coment = $("conteudo").querySelector('[data-campo="comentario"]');
  if (coment) coment.value = s.avaliacao.comentario || "";
  for (const [nome, valor] of Object.entries(s.precos.form)) {
    const el = $("conteudo").querySelector(`[data-campo="preco-${nome}"]`);
    if (el?.type === "checkbox") el.checked = valor; else if (el) el.value = valor;
  }
  const volta = foco && $("conteudo").querySelector(`[data-campo="${foco}"]`);
  if (volta) volta.focus();
}

function avisar(texto) { s.msg = texto; desenhar(); setTimeout(() => { s.msg = ""; desenhar(); }, 6000); }

async function inserir(texto) {
  const r = await pedir({ tipo: "inserir", callId: s.callId, texto });
  if (r?.ok) return true;
  avisar(r?.motivo || "Não consegui escrever no Interact. Use Copiar.");
  return false;
}

async function copiar(texto) {
  try { await navigator.clipboard.writeText(texto); return true; } catch { avisar("Não consegui copiar. Use Ctrl+C."); return false; }
}

// ---------- ações ----------
async function acao(evento) {
  const alvo = evento.target.closest("[data-acao]");
  if (!alvo) return;
  const tipo = alvo.dataset.acao;
  if (tipo === "gerar") { alvo.disabled = true; sugerir(false); }
  else if ((tipo === "inserir" || tipo === "copiar") && s.sugestoes) {
    const i = Number(alvo.dataset.indice);
    const texto = s.sugestoes[i]?.texto || "";
    const ok = tipo === "inserir" ? await inserir(texto) : await copiar(texto);
    if (!ok) return;
    s.usada = true;
    registrar(tipo === "inserir" ? "inseriu" : "copiou", { callId: s.callId, sugestaoId: s.sugestaoId, dados: { indice: i + 1 } });
    s.feito[i] = tipo === "inserir" ? "✓ Inserida. Revise e envie no Interact." : "✓ Copiada";
    desenhar();
  } else if (tipo === "nota" && s.sugestaoId) {
    s.avaliacao = { ...s.avaliacao, nota: alvo.dataset.nota }; desenhar();
  } else if (tipo === "avaliar" && s.sugestaoId) {
    registrar("avaliou", { callId: s.callId, sugestaoId: s.sugestaoId, dados: { nota: s.avaliacao.nota, comentario: s.avaliacao.comentario?.trim() || undefined } });
    s.avaliacao.enviada = true; enviar(); desenhar();
  } else if (tipo === "cardapio") { carregarCardapio(); }
  else if (tipo === "cardapio-fechar") { s.cardapio = null; desenhar(); }
  else if (tipo === "ficha-toggle") { s.fichaAberta = !s.fichaAberta; desenhar(); }
  else if (tipo === "copiar-texto") { if (await copiar(alvo.dataset.texto)) { registrar("copiou", { callId: s.callId, dados: {} }); avisar("✓ Copiado. Revise e envie no Interact."); } }
  else if (tipo === "precos-abrir" || tipo === "precos-fechar") {
    s.precos.aberto = tipo === "precos-abrir";
    if (s.precos.aberto && !s.precos.form.checkin) s.precos.form.checkin = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    desenhar();
  } else if (tipo === "precos-buscar") { buscarPrecos(); }
}

// ---------- ligações ----------
$("form-login").addEventListener("submit", async (evento) => {
  evento.preventDefault();
  $("erro-login").textContent = "";
  const botao = evento.submitter; botao.disabled = true;
  try {
    const usuario = await api.entrar($("email").value.trim(), $("senha").value);
    $("senha").value = "";
    s.features = (await api.config()).sessao?.features || {};
    $("usuario").textContent = usuario?.nome || usuario?.email || "";
    $("sair").hidden = false;
    mostrar("tela-desligado");
  } catch (erro) {
    $("erro-login").textContent = erro.status === 401 ? "E-mail ou senha incorretos." : erro.message;
  } finally { botao.disabled = false; }
});
$("ligar").addEventListener("click", ligar);
$("desligar").addEventListener("click", desligar);
$("sair").addEventListener("click", async () => {
  if (s.ligado) await desligar();
  await api.sair(); await limparFila();
  $("usuario").textContent = ""; $("sair").hidden = true;
  mostrar("tela-login");
});
$("minimizar").addEventListener("click", () => {
  if (window.parent !== window) window.parent.postMessage("copiloto-minimizar", "*");  // embutido na página: recolhe pra bolha
  else window.close();  // painel lateral do Chrome
});
$("abrir-opcoes").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("tela-ligado").addEventListener("click", acao);
$("tela-ligado").addEventListener("input", (evento) => {
  const campo = evento.target.dataset.campo;
  if (campo === "comentario") s.avaliacao.comentario = evento.target.value;
  else if (campo === "continuo") { s.continuo = evento.target.checked; if (s.continuo) perguntarTela(); }
  else if (campo?.startsWith("preco-")) s.precos.form[campo.slice(6)] = evento.target.type === "checkbox" ? evento.target.checked : evento.target.value;
});
chrome.storage.onChanged.addListener((mudou) => { if (mudou.urlView) iniciar(); });

iniciar();
