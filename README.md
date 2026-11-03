# Copiloto de Atendimento (extensão Chrome)

Painel lateral no Chrome que mostra **sugestões de resposta da IA** para os chats do atendente no Interact (Dígitro). O atendente liga o copiloto (▶) e vê os seus chats com o nome do cliente; escolhe um (o que está aberto no Interact já vem selecionado), vê as últimas mensagens com a do cliente destacada e clica em **Quero ajuda do copiloto**: saem 2 respostas para aquela mensagem. A IA só gera quando o atendente pede. O botão ⇥ minimiza (fecha o painel lateral; o ícone traz de volta).

**"Inserir na resposta"** só escreve na caixa de resposta do Interact.

**Trava do Enviar:** quando o atendente dá Enter (ou clica em Enviar) no Interact, a extensão segura o envio e confere o texto no copiloto: data ou valor diferente da ficha e datas impossíveis (31/02, saída antes da entrada, boleto no fim de semana…). Sem alerta, a mensagem sai na hora. Com alerta, aparece um aviso por cima do Interact com **Corrigir** ou **Enviar mesmo assim**. Sem login, sem rede ou com o copiloto demorando mais de 4 s, a mensagem sai sem conferir: a trava nunca para o atendimento. Shift+Enter não envia nem confere.

## Como funciona

- **Mensagens:** chegam pela **API de espelhamento do Interact**, no servidor, a partir do play. O histórico de antes (e o de outro atendente, num chat transferido) a API não entrega sem uma licença que não temos: por isso, no clique em **Quero ajuda do copiloto**, a extensão manda junto as mensagens que estão na tela daquele chat. O servidor junta só as que ele ainda não tem.
- **O que a extensão lê da tela do Interact** (`src/content.js`):
  - qual conversa está aberta;
  - o CPF dos dados associados, que vai uma vez por chat ao servidor para carregar a ficha;
  - o histórico do chat, só no clique em Quero ajuda;
  - o texto da caixa de resposta, só no Enter/Enviar, para a trava.
- **O que ela escreve na tela:** o texto na caixa de resposta, só quando o atendente pede; o aviso da trava; e o clique em Enviar que solta a mensagem que ela segurou.
- **Com quem ela fala:** só com o **painel da RDC** (assistente-view, rotas `/api/copiloto/extensao/*`), que repassa ao worker. O contrato está em `assistente-docs/contrato-copiloto-eventos.md` §8.
- **Cliente achou caro?** (painel lateral): o atendente informa o hotel (nome ou ID), o check-in, as noites e os adultos e vê o mesmo hotel em 3 dias antes e 3 depois, no valor do plano (pontos + R$), com o quarto, o regime e se o cancelamento é grátis; dá para filtrar por café da manhã e cancelamento grátis e copiar a oferta da data mais barata. Rotas `/hoteis` e `/precos-hotel` do painel.
- **Login:** com a conta do painel. O token (12 h) fica no `chrome.storage`; **a senha nunca é guardada**.
- **Eventos de uso:** ativou, gerou, inseriu, enviou etc. vão em lotes para os indicadores. **Sem texto de mensagem, nome ou CPF** (contrato §2–4). Se o atendente mandou a sugestão igual ou editada, a extensão calcula isso no navegador, comparando a sugestão com o que ele enviou.

## Instalar (MVP)

1. No Chrome, abra `chrome://extensions` e ligue o **Modo do desenvolvedor**.
2. Clique em **Carregar sem compactação** e escolha esta pasta.
3. Nas **Opções** da extensão, informe o endereço do painel (ex.: `https://painel...`; para teste local, `http://localhost:5077`) e aceite a permissão.
4. Clique no ícone da extensão para abrir o painel lateral e entre com o e-mail e a senha do painel.
5. Recarregue a aba do Interact, que precisa estar aberta em `https://rdc.digitro.cloud`.

**Pré-requisitos no painel (admin):**
- o usuário tem a permissão **`attendance.copilot_self`**;
- o usuário tem o campo **Login no Interact** preenchido. É ele que define quais chats o atendente vê.

## Desenvolvimento

```
npm test        # node --test: regras puras em src/regras.js
```

Não tem build nem dependências: é JavaScript puro, em módulos ES.

| Arquivo | Papel |
|---|---|
| `manifest.json` | MV3: painel lateral, content script no Interact, permissão do painel pedida nas opções |
| `src/regras.js` | regras puras (testadas): conversa na tela, CPF, similaridade, envelope de evento, situação da conexão |
| `src/api.js` | chamadas ao painel e token; 401 volta para o login |
| `src/eventos.js` | fila de eventos (storage), lotes de até 50 a cada 10 s |
| `src/content.js` | tela do Interact: conversa aberta, CPF, histórico, inserir texto e trava do Enviar |
| `src/background.js` | o ícone abre o painel lateral; confere o texto da trava no painel |
| `sidepanel/` | interface do atendente |
| `options/` | endereço do painel |

## Limitações conhecidas

- **Licença do Interact:** cada atendente acompanhado usa uma licença de sincronismo de tela; a Dígitro informou (30/10/2026) que não há limite de licenças. Se a Interact recusar por licença, o painel lateral avisa.
- **Seletores da tela** (conferidos na captura do Henrique, 29/10):
  - a conversa aberta é identificada por `topPanel<uuid>.x-pnl-dispositivo-ativo-chat`, `tabChat<uuid>` visível e a aba `tabPanel<uuid>__tabChat<uuid>`;
  - a caixa de resposta é o `iframe[id$="_richtextarea"]` dentro do `tabChat<uuid>`, e o botão Enviar é o `table.x-btn[title="Enviar mensagem de chat"]`;
  - cada mensagem é um elemento com `name` (id da mensagem), `message_direction` (`in` = cliente), `message_actor`, e a hora em `.x-td-hora-chat`;
  - o CPF é lido em `textarea[id^="text_area_dados_associados"]`. Na captura atual esse campo veio vazio; se o CPF aparecer em outro lugar, ajuste só a função `cpfNaTela` em `src/content.js`.
- **Trava do Enviar, a confirmar no Interact de verdade:** que o Enter do Interact não dispara antes da extensão (testado só na tela capturada) e que o clique da extensão em Enviar manda a mensagem. Se o clique não enviar, o próximo Enter do atendente (em até 10 s) passa direto.
- **Eventos da trava** (`alerta` antes de enviar, `corrigiu_alerta`) só são gravados com o painel lateral aberto.
- **Preços:** com a conta de serviço interna do Reservas no worker, o valor sai no plano do cliente da ficha do chat aberto (a tela diz de quem); com conta de assinante, sai no plano dela e a tela avisa que é demonstração. O valor mostra as diárias do plano, os pontos e o dinheiro. O prazo do cancelamento grátis só aparece no site.
- **Painel lateral fechado:** as consultas param. O servidor tira o atendente da assinatura depois de 2 min sem consulta.
