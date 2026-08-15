import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeHex,
  hexToRgb255,
  rgb255ToHex,
  hexToAeColor,
  colorDistance,
  quantizePalette,
} from "../src/color.js";

test("normalizeHex aceita as formas comuns", () => {
  assert.equal(normalizeHex("#FF4422"), "#ff4422");
  assert.equal(normalizeHex("ff4422"), "#ff4422");
  assert.equal(normalizeHex("#f42"), "#ff4422");
  assert.equal(normalizeHex("  #F42  "), "#ff4422");
});

test("normalizeHex rejeita entrada inválida", () => {
  assert.throws(() => normalizeHex("#ff44"), /hex inválido/);
  assert.throws(() => normalizeHex("vermelho"), /hex inválido/);
  assert.throws(() => normalizeHex(null), /deve ser string/);
});

test("hex e rgb são inversos um do outro", () => {
  assert.deepEqual(hexToRgb255("#ff4422"), { r: 255, g: 68, b: 34 });
  assert.equal(rgb255ToHex({ r: 255, g: 68, b: 34 }), "#ff4422");
  assert.equal(rgb255ToHex(hexToRgb255("#0e0e12")), "#0e0e12");
});

test("rgb255ToHex limita valores fora de faixa em vez de gerar hex inválido", () => {
  assert.equal(rgb255ToHex({ r: 300, g: -20, b: 128 }), "#ff0080");
});

test("hexToAeColor devolve componentes de 0 a 1", () => {
  assert.deepEqual(hexToAeColor("#000000"), [0, 0, 0]);
  assert.deepEqual(hexToAeColor("#ffffff"), [1, 1, 1]);

  const [r] = hexToAeColor("#800000");
  assert.ok(Math.abs(r - 128 / 255) < 1e-9);
});

test("hexToAeColor com gama escurece o valor, para projeto em espaço linear", () => {
  const [plain] = hexToAeColor("#808080");
  const [gammad] = hexToAeColor("#808080", 2.2);
  assert.ok(gammad < plain, "com gama 2.2 o valor precisa ficar menor");
});

test("colorDistance é zero pra cores iguais e cresce com a diferença", () => {
  assert.equal(colorDistance("#ff4422", "#ff4422"), 0);
  assert.ok(colorDistance("#ff4422", "#ff4523") < colorDistance("#ff4422", "#00ff00"));
});

test("quantizePalette funde cores quase idênticas num representante só", () => {
  // O caso real: o modelo devolve a mesma cor de marca com um ponto de diferença
  // em amostras distintas da imagem.
  const { palette, remap } = quantizePalette(["#ff4d2e", "#ff4e2f", "#101014"]);

  assert.equal(palette.length, 2, "duas cores distintas de verdade");
  assert.equal(remap.get("#ff4e2f"), "#ff4d2e", "a variação aponta pro primeiro visto");
  assert.equal(remap.get("#101014"), "#101014");
});

test("quantizePalette mantém separadas cores que só são parecidas de longe", () => {
  const { palette } = quantizePalette(["#ff0000", "#cc0000"], 12);
  assert.equal(palette.length, 2);
});
