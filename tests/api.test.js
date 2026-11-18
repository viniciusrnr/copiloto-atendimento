import test from "node:test";
import assert from "node:assert/strict";

import { ehProducao } from "../src/api.js";

test("ehProducao: só o painel de produção conta como produção (gate do CPF manual)", () => {
  // produção -> true (campo de CPF manual fica ESCONDIDO)
  assert.equal(ehProducao("https://painelassistente.rdcviagens.com.br"), true);
  assert.equal(ehProducao("https://painelassistente.rdcviagens.com.br/"), true);
  // fora de produção -> false (campo LIBERADO para teste)
  assert.equal(ehProducao("https://hmgpainelassistente.rdcviagens.com.br"), false);
  assert.equal(ehProducao("http://localhost:5077"), false);
  assert.equal(ehProducao(""), false);
  assert.equal(ehProducao(null), false);
});
