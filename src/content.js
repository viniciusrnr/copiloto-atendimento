// Roda na tela do Interact. LÊ qual conversa está aberta, o CPF dos dados associados e, quando o atendente pede
// ajuda, o histórico do chat (o da API só vem depois do play); INSERE texto na caixa de resposta quando ele pede; e
// SEGURA o envio (Enter ou botão Enviar) para conferir datas e valores: com alerta, ele corrige ou envia mesmo assim.
// Só clica em Enviar para soltar o envio que segurou. Seletores por ids com uuid, classes e títulos (os ext-gen
// mudam a cada carga).
(async () => {
  const { alertaParaEvento, chatAtivo, extrairCpf, textoDoAlerta, uuidDoId } = await import(chrome.runtime.getURL("src/regras.js"));
  const ENVIAR = 'table.x-btn[title="Enviar mensagem de chat"]';
  const MAX_HISTORICO = 200;

  const visivel = (el) => el.getClientRects().length > 0;
  const ids = (seletor, filtro = () => true) => [...document.querySelectorAll(seletor)].filter(filtro).map((el) => el.id);
  const container = (callId) => document.getElementById(`tabChat${callId}`);

  function conversaNaTela() {
    return chatAtivo({
      itensAtivos: ids('[id^="topPanel"].x-pnl-dispositivo-ativo-chat'),
      paineisVisiveis: ids('[id^="tabChat"]', visivel),
      abasAtivas: ids('li.x-tab-strip-active[id^="tabPanel"]'),
    });
  }

  // Onde o CPF aparece: ajustar aqui se o Interact mostrar em outro lugar.
  function cpfNaTela(callId) {
    const dentro = container(callId);
    const campos = [
      ...(dentro ? dentro.querySelectorAll('textarea[id^="text_area_dados_associados"], .limiteCaracteresDadosAssociados') : []),
      ...[...document.querySelectorAll('textarea[id^="text_area_dados_associados"]')].filter(visivel),
    ];
    for (const campo of campos) {
      const cpf = extrairCpf(campo.value ?? campo.textContent);
      if (cpf) return cpf;
    }
    return null;
  }

  // cada mensagem do chat traz o id, a direção (in = cliente) e quem mandou; a hora fica no rodapé do balão
  function historico(callId) {
    return [...(container(callId)?.querySelectorAll("[message_direction]") || [])].slice(-MAX_HISTORICO).map((el) => ({
      id: el.getAttribute("name"), direcao: el.getAttribute("message_direction"), autor: el.getAttribute("message_actor"),
      hora: el.closest(".msgChatMainBox")?.querySelector(".x-td-hora-chat")?.textContent.trim() || null,
      texto: el.innerText.trim(),
    }));
  }

  // ---------- trava do envio ----------
  const caixa = (callId) => container(callId)?.querySelector('iframe[id$="_richtextarea"]');
  const textoDaCaixa = (callId) => caixa(callId)?.contentDocument?.body?.innerText.trim() || "";
  let liberado = false; // o clique que a extensão dá em Enviar passa sem conferir
  let passeLivre = null; // {callId, ate}: esse clique não enviou, então o próximo envio (em 10 s) passa direto
  let segurando = false; // Enter segurado: o keypress/keyup do mesmo Enter também não chega ao Interact
  const conferindo = new Set(); // callIds
  const bloqueados = new Map(); // callId -> alertas mostrados (para saber se o atendente corrigiu)

  function segurar(evento) {
    evento.preventDefault();
    evento.stopImmediatePropagation();
  }

  function registrar(evento, callId, dados) {
    chrome.runtime.sendMessage({ tipo: "evento", evento, callId, dados }).catch(() => {}); // painel fechado: perde
  }

  async function conferir(evento, callId) {
    if (liberado) return;
    if (passeLivre?.callId === callId && Date.now() < passeLivre.ate) return void (passeLivre = null);
    const texto = textoDaCaixa(callId);
    if (!texto) return;
    segurar(evento); // antes do await: o Interact não pode ver o evento
    if (conferindo.has(callId)) return;
    conferindo.add(callId);
    let resposta = null;
    try {
      resposta = await chrome.runtime.sendMessage({ tipo: "verificar", callId, texto });
    } catch { /* sem resposta: não trava o atendimento */ } finally {
      conferindo.delete(callId);
    }
    const alertas = resposta?.alertas || [];
    if (!resposta || resposta.livre) { // não conferiu: libera sem contar como correção
      bloqueados.delete(callId);
      return enviar(callId);
    }
    // cada alerta conta uma vez (outro Enter com o mesmo erro não infla a conta) e cada um que sumiu é uma correção,
    // mesmo que outro continue na mensagem (indicador "erros evitados")
    const anteriores = bloqueados.get(callId) || [];
    const chave = (a) => { const { alerta, subtipo } = alertaParaEvento(a); return `${alerta}|${subtipo}`; };
    const atuais = new Set(alertas.map(chave));
    const vistos = new Set(anteriores.map(chave));
    for (const a of anteriores.filter((x) => !atuais.has(chave(x)))) {
      const { alerta, subtipo } = alertaParaEvento(a);
      registrar("corrigiu_alerta", callId, { alerta, subtipo });
    }
    for (const a of alertas.filter((x) => !vistos.has(chave(x)))) registrar("alerta", callId, { ...alertaParaEvento(a), momento: "antes_de_enviar" });
    if (!alertas.length) {
      bloqueados.delete(callId);
      return enviar(callId);
    }
    bloqueados.set(callId, alertas);
    mostrarTrava(callId, alertas);
  }

  function enviar(callId) {
    document.getElementById("copiloto-trava")?.remove(); // aviso velho não pode soltar outro texto depois
    const antes = textoDaCaixa(callId);
    liberado = true;
    try { container(callId)?.querySelector(`${ENVIAR} button`)?.click(); } finally { liberado = false; }
    setTimeout(() => { if (antes && textoDaCaixa(callId) === antes) passeLivre = { callId, ate: Date.now() + 10_000 }; }, 1500);
  }

  function aoTeclar(evento, callId) {
    if (evento.key !== "Enter" || evento.shiftKey || evento.isComposing) return;
    if (evento.type === "keydown") {
      conferir(evento, callId);
      segurando = evento.defaultPrevented;
    } else if (segurando) {
      segurar(evento);
      if (evento.type === "keyup") segurando = false;
    }
  }

  const preparadas = new WeakSet();
  function prepararCaixas() {
    for (const painel of document.querySelectorAll('[id^="tabChat"]')) {
      const callId = uuidDoId(painel.id);
      const janela = callId && caixa(callId)?.contentWindow;
      if (!janela || preparadas.has(janela.document)) continue;
      preparadas.add(janela.document);
      for (const tipo of ["keydown", "keypress", "keyup"]) janela.addEventListener(tipo, (e) => aoTeclar(e, callId), true);
    }
  }

  document.addEventListener("click", (evento) => {
    const botao = evento.target.closest?.(ENVIAR);
    const callId = botao && uuidDoId(botao.closest('[id^="tabChat"]')?.id);
    if (callId && !botao.classList.contains("x-item-disabled")) conferir(evento, callId);
  }, true);

  // aviso por cima do Interact (o painel lateral pode estar fechado); shadow DOM para o CSS de um não pegar no outro
  function mostrarTrava(callId, alertas) {
    document.getElementById("copiloto-trava")?.remove();
    const host = Object.assign(document.createElement("div"), { id: "copiloto-trava" });
    const raiz = host.attachShadow({ mode: "open" });
    raiz.innerHTML = `<style>
      .caixa { position: fixed; z-index: 2147483647; right: 24px; bottom: 24px; width: 380px; max-width: calc(100vw - 48px);
        background: #fff; color: #1f2933; border: 2px solid #d97706; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.25);
        font: 14px/1.4 system-ui, sans-serif; padding: 14px 16px; }
      h2 { font-size: 15px; margin: 0 0 8px; color: #b45309; } ul { margin: 0 0 12px; padding-left: 18px; } li { margin-bottom: 6px; }
      .correcao { display: block; color: #52606d; font-size: 13px; }
      .acoes { display: flex; gap: 8px; justify-content: flex-end; }
      button { font: inherit; border-radius: 6px; padding: 6px 12px; cursor: pointer; border: 1px solid #9aa5b1; background: #fff; }
      button.corrigir { background: #d97706; border-color: #d97706; color: #fff; font-weight: 600; }
    </style><div class="caixa" role="alertdialog" aria-labelledby="t"><h2 id="t">⚠ Confira antes de enviar</h2><ul></ul>
      <div class="acoes"><button class="mesmo-assim">Enviar mesmo assim</button><button class="corrigir">Corrigir</button></div></div>`;
    for (const a of alertas) {
      const li = document.createElement("li");
      li.textContent = textoDoAlerta(a);
      if (a.correcao) li.append(Object.assign(document.createElement("span"), { className: "correcao", textContent: `Sugestão: ${a.correcao}` }));
      raiz.querySelector("ul").append(li);
    }
    raiz.querySelector(".corrigir").addEventListener("click", () => {
      host.remove();
      caixa(callId)?.contentDocument?.body?.focus();
    });
    raiz.querySelector(".mesmo-assim").addEventListener("click", () => {
      host.remove();
      bloqueados.delete(callId);
      enviar(callId);
    });
    document.body.append(host);
    raiz.querySelector(".corrigir").focus();
  }

  function inserir(callId, texto) {
    // só na caixa do chat pedido: inserir no chat de outro cliente é o pior erro possível
    const iframe = caixa(callId);
    const doc = iframe && iframe.contentDocument;
    if (!doc || !doc.body) return { ok: false, motivo: "Abra este chat no Interact para inserir a sugestão." };
    const corpo = doc.body;
    if (corpo.textContent.trim()) corpo.appendChild(doc.createElement("br")); // não apaga o que o atendente já escreveu
    String(texto).split("\n").forEach((linha, i) => {
      if (i) corpo.appendChild(doc.createElement("br"));
      corpo.appendChild(doc.createTextNode(linha));
    });
    iframe.focus();
    corpo.focus();
    for (const tipo of ["input", "keyup"]) corpo.dispatchEvent(new Event(tipo, { bubbles: true }));
    return { ok: true };
  }

  let ultimo = "";
  function avisarTela() {
    const callId = conversaNaTela();
    const tela = { callId, cpf: callId ? cpfNaTela(callId) : null };
    const chave = JSON.stringify(tela);
    if (chave === ultimo) return;
    ultimo = chave;
    chrome.runtime.sendMessage({ tipo: "tela", ...tela }).catch(() => {}); // painel fechado: ninguém ouvindo
  }

  let espera;
  new MutationObserver(() => {
    clearTimeout(espera);
    espera = setTimeout(() => { avisarTela(); prepararCaixas(); }, 300);
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style"] });

  chrome.runtime.onMessage.addListener((pedido, _remetente, responder) => {
    if (pedido.tipo === "tela?") {
      ultimo = "";
      const callId = conversaNaTela();
      responder({ callId, cpf: callId ? cpfNaTela(callId) : null });
    } else if (pedido.tipo === "inserir") {
      responder(inserir(pedido.callId, pedido.texto));
    } else if (pedido.tipo === "historico?") {
      responder(historico(pedido.callId));
    }
  });
  avisarTela();
  prepararCaixas();
})();
