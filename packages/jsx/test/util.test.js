/**
 * Testes do util.jsx do ExtendScript, rodados no Node.
 *
 * O arquivo é ES3 puro e não toca no DOM do After Effects, então dá para avaliá-lo
 * aqui e exercitar de verdade — o que importa, porque a falha que motivou este teste
 * só aparecia dentro do AE e custou uma noite de diagnóstico para localizar.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UTIL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "util.jsx");

/** Avalia o util.jsx num escopo isolado e devolve o objeto `vec` que ele monta. */
function loadVec() {
  const source = fs.readFileSync(UTIL, "utf8");
  // `File` só é usado por vec.readFile, que não está sob teste aqui.
  return new Function("File", `${source}; return vec;`)(function File() {});
}

test("quote escapa o que o JSON exige", () => {
  const vec = loadVec();

  assert.equal(vec.quote("simples"), '"simples"');
  assert.equal(vec.quote('com "aspas"'), '"com \\"aspas\\""');
  assert.equal(vec.quote("barra\\invertida"), '"barra\\\\invertida"');
  assert.equal(vec.quote("linha\nnova\ttab"), '"linha\\nnova\\ttab"');
  assert.equal(vec.quote("controle\u0001"), '"controle\\u0001"');
  assert.equal(vec.quote("acentuação ✓"), '"acentuação ✓"');
});

test("o que quote produz sobrevive a JSON.parse", () => {
  const vec = loadVec();
  const original = 'tudo junto: "aspas" \\ barra\n\tquebra  e acento é';

  assert.equal(JSON.parse(vec.quote(original)), original);
});

/**
 * A regressão que derrubou a ponte.
 *
 * Um objeto comum usado como mapa consulta a cadeia de protótipo. Basta um script
 * instalado no After Effects ter estendido `Object.prototype` — coisa que scripts
 * antigos de AE fazem — para `ESCAPES[ch]` devolver um método herdado em vez de
 * `undefined`. O `if` aceitava a função e a concatenação estourava com
 * "Object of type Function found where a Number, Array, or Property is needed",
 * mensagem que não aponta para string, JSON, nem escape.
 *
 * O sintoma no After Effects foi a ponte inteira parecer um problema de permissão de
 * arquivo: todo comando dava timeout, porque a resposta nunca chegava a ser montada.
 */
test("quote não quebra com Object.prototype poluído", () => {
  const vec = loadVec();

  Object.defineProperty(Object.prototype, "e", {
    value: function poluicao() {},
    configurable: true,
    enumerable: false,
    writable: true,
  });

  try {
    assert.equal(vec.quote("teste"), '"teste"');
    assert.equal(vec.quote("mfk3p2q-1a2b3c4d"), '"mfk3p2q-1a2b3c4d"');
    assert.equal(JSON.parse(vec.json({ error: "e" })).error, "e");
  } finally {
    delete Object.prototype.e;
  }
});

test("json cobre os tipos que a resposta da ponte carrega", () => {
  const vec = loadVec();

  assert.equal(vec.json(null), "null");
  assert.equal(vec.json(undefined), "null");
  assert.equal(vec.json(true), "true");
  assert.equal(vec.json(12.5), "12.5");
  // Infinity e NaN não existem em JSON; viram null, como no JSON.stringify real.
  assert.equal(vec.json(Infinity), "null");
  assert.equal(vec.json(NaN), "null");
  assert.equal(vec.json([1, "dois", null]), '[1,"dois",null]');
  assert.equal(vec.json({ a: 1, f: function () {} }), '{"a":1}');

  const resposta = { id: "abc-123", ok: true, result: { afterEffects: "26.3x87" }, error: undefined };
  assert.deepEqual(JSON.parse(vec.json(resposta)), {
    id: "abc-123",
    ok: true,
    result: { afterEffects: "26.3x87" },
    error: null,
  });
});

test("hexToColor aceita as duas formas e aplica gamma", () => {
  const vec = loadVec();

  assert.deepEqual(vec.hexToColor("#ffffff"), [1, 1, 1]);
  assert.deepEqual(vec.hexToColor("000"), [0, 0, 0]);
  assert.deepEqual(vec.hexToColor("#f00"), [1, 0, 0]);

  const [r] = vec.hexToColor("#808080", 2.2);
  assert.ok(r < 0.5, "gamma > 1 escurece o meio-tom");
});

test("safeName tira quebra de linha e respeita o limite do AE", () => {
  const vec = loadVec();

  assert.equal(vec.safeName("uma\nlinha\tsó"), "uma linha só");
  assert.equal(vec.safeName("", "reserva"), "reserva");
  assert.equal(vec.safeName(null, "reserva"), "reserva");
  assert.equal(vec.safeName("x".repeat(400)).length, 200);
});
