import assert from "node:assert/strict";
import { test } from "node:test";

import {
  alertaParaEvento, chatAtivo, chatSelecionado, clienteFalouDeNovo, cpfValido, evento, extrairCpf, respostaDoAtendente,
  situacao, textoDaOferta, textoDoAlerta, usoDaSugestao, uuidDoId,
} from "../src/regras.js";

const A = "11111111-aaaa-4bbb-8ccc-000000000001";
const B = "22222222-aaaa-4bbb-8ccc-000000000002";

test("uuid sai dos ids estáveis do Interact, nunca dos ext-gen", () => {
  assert.equal(uuidDoId(`topPanel${A}`), A);
  assert.equal(uuidDoId(`tabChat${A}`), A);
  assert.equal(uuidDoId(`tabPanel${A}__tabChat${A}`), A);
  assert.equal(uuidDoId(`topPanel${A}-badgeMensagens`), null);
  assert.equal(uuidDoId(`tabPanel${A}__pnl_hist_${A}`), null);
  assert.equal(uuidDoId("ext-gen2305"), null);
});

test("chat ativo: lista de conversas manda; ambiguidade cai para o próximo sinal", () => {
  assert.equal(chatAtivo({ itensAtivos: [`topPanel${B}`], abasAtivas: [`tabPanel${A}__tabChat${A}`] }), B);
  // as duas conversas têm a aba "Chat" ativa: só o painel visível desempata
  assert.equal(chatAtivo({ paineisVisiveis: [`tabChat${A}`], abasAtivas: [`tabPanel${A}__tabChat${A}`, `tabPanel${B}__tabChat${B}`] }), A);
  assert.equal(chatAtivo({ abasAtivas: [`tabPanel${A}__tabChat${A}`, `tabPanel${B}__tabChat${B}`] }), null);
  assert.equal(chatAtivo({ abasAtivas: [`tabPanel${A}__tabChat${A}`] }), A);
});

test("CPF: só com dígitos verificadores certos, com ou sem pontuação", () => {
  assert.ok(cpfValido("529.982.247-25"));
  assert.ok(!cpfValido("529.982.247-24"));
  assert.ok(!cpfValido("111.111.111-11"));
  assert.equal(extrairCpf("Maria;associado;adimplente;529.982.247-25;12345"), "52998224725");
  assert.equal(extrairCpf("telefone 11999990000 e cpf 52998224725"), "52998224725");
  assert.equal(extrairCpf("codigo 123456789012 sem cpf"), null);
});

test("enviou: igual, editada ou outra pela similaridade com a melhor sugestão", () => {
  const sugestoes = [{ texto: "Segue o Pix para pagamento hoje." }, { texto: "Posso dividir em duas vezes no cartão, Maria." }];
  assert.deepEqual(usoDaSugestao(sugestoes, "Segue o pix para pagamento hoje"), { indice: 1, uso: "igual", similaridade: 1 });
  assert.equal(usoDaSugestao(sugestoes, "Maria, posso dividir em duas vezes no cartão sem juros").uso, "editada");
  assert.deepEqual(usoDaSugestao(sugestoes, "Bom dia, tudo bem?"), { indice: null, uso: "outra", similaridade: 0 });
});

test("seleção: o que o atendente escolheu vale enquanto o chat existir; senão o da tela", () => {
  const conversas = [{ call_id: A }, { call_id: B }];
  assert.equal(chatSelecionado(conversas, { escolhido: B, naTela: A }), B);
  assert.equal(chatSelecionado(conversas, { escolhido: "encerrado", naTela: A }), A);
  assert.equal(chatSelecionado(conversas, { naTela: "outro" }), null);
});

test("resposta do atendente e cliente que falou de novo depois da sugestão", () => {
  const conversa = { mensagens: [
    { seq: 1, papel: "cliente" }, { seq: 2, papel: "sistema" }, { seq: 3, papel: "atendente", texto: "ok" }, { seq: 4, papel: "cliente" },
  ] };
  assert.equal(respostaDoAtendente(conversa, 1).seq, 3);
  assert.equal(clienteFalouDeNovo(conversa, 1), false);
  assert.equal(clienteFalouDeNovo(conversa, 3), true);
  assert.equal(respostaDoAtendente(conversa, 4), null);
});

test("evento segue o envelope e descarta o que o tipo não prevê (nunca texto do chat)", () => {
  const e = evento("inseriu", { callId: A, sessaoId: "s1", sugestaoId: "g1", versao: "0.1.0", uuid: () => "id-1",
    dados: { indice: 2, texto: "Segue o Pix", cpf: "52998224725" }, data: new Date(2026, 9, 27, 14, 3, 11, 250) });
  assert.deepEqual(Object.keys(e).sort(), ["call_id", "dados", "em", "evento_id", "origem", "sessao_id", "sugestao_id", "tipo", "versao_extensao"]);
  assert.deepEqual(e.dados, { indice: 2 });
  assert.equal(e.origem, "extensao");
  assert.match(e.em, /^2026-10-27T14:03:11\.250[+-]\d{2}:\d{2}$/);
  assert.throws(() => evento("gerou", {}), /desconhecido/); // "gerou" é do worker
  assert.deepEqual(evento("avaliou", { dados: { nota: "negativo", comentario: "faltou o valor", extra: 1 } }).dados,
    { nota: "negativo", comentario: "faltou o valor" });
});

test("situação da conexão: licença esgotada aparece como erro claro", () => {
  const sem = situacao({ status: "sem_licenca", detalhe: "Sem licença no Interact" });
  assert.equal(sem.nivel, "erro");
  assert.match(sem.texto, /Outro atendente está usando/);
  // o detalhe do "parado" fala de licença: não pode virar aviso de falta de licença
  assert.equal(situacao({ status: "parado", detalhe: "Acompanhamento encerrado; a licença é liberada em instantes." }).nivel, "parado");
  assert.match(situacao({ status: "erro", detalhe: "" }).texto, /Tentar de novo/);
  assert.equal(situacao({ status: "conectado" }).nivel, "ok");
  assert.equal(situacao(null).nivel, "parado");
});

test("alerta do atendente: frase curta para a tela e evento sem o texto da mensagem", () => {
  const data = { tipo: "data", encontrado: "06/09", esperado: "05/09/2026", correcao: "Corrigindo: ..." };
  assert.equal(textoDoAlerta(data), "Data diferente da ficha: você escreveu 06/09, o certo é 05/09/2026.");
  assert.deepEqual(alertaParaEvento(data), { alerta: "data_ficha", subtipo: null, momento: "depois" });
  const aviso = { tipo: "aviso", encontrado: "31/11", esperado: "31/11 não existe no calendário: confira o dia e o mês.", correcao: "" };
  assert.equal(textoDoAlerta(aviso), aviso.esperado);
  assert.deepEqual(alertaParaEvento(aviso), { alerta: "data_invalida", subtipo: "inexistente", momento: "depois" });
  assert.equal(alertaParaEvento({ tipo: "picadas", esperado: "Junte as informações" }).alerta, "picadas");
  // a trava do Enviar manda o alerta (momento antes_de_enviar) e, se ele corrigir, o corrigiu_alerta
  assert.deepEqual(evento("corrigiu_alerta", { dados: { alerta: "data_invalida", subtipo: "inexistente", momento: "x" } }).dados,
    { alerta: "data_invalida", subtipo: "inexistente" });
});

test("oferta da data mais barata: valor do cliente nas duas datas, sem preço do fornecedor", () => {
  const pedida = { checkin: "2027-01-27", noites: 2, disponivel: true, pontos: 10800, dinheiro: 1267.65 };
  const barata = { checkin: "2027-01-28", noites: 2, disponivel: true, pontos: 8000, dinheiro: 900, quartos: [{ quarto: "STANDARD", regime: "Pensão Completa" }] };
  const texto = textoDaOferta(barata, pedida).replace(/\s/g, " ");
  assert.match(texto, /entrando em 28\/01, com 2 noites no quarto STANDARD \(Pensão Completa\), fica 8\.000 pontos \+ R\$ 900,00\./);
  assert.match(texto, /Entrando em 27\/01 ficaria 10\.800 pontos \+ R\$ 1\.267,65\./);
  assert.doesNotMatch(textoDaOferta(barata, { ...pedida, disponivel: false }), /ficaria/); // data pedida sem quarto: não compara
});
