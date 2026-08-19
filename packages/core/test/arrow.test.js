/**
 * Geometria de seta.
 *
 * O After Effects não tem seta: ela é um path com stroke mais um triângulo preenchido,
 * e o triângulo precisa estar na ponta do path, girado para a direção em que o path
 * chega ali. Num traço curvo essa direção é a tangente no fim da curva, não a direção
 * de A para B — e é aí que uma seta feita à mão sai torta.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ArrowError, arrowGeometry, expandArrow } from "../src/arrow.js";
import { normalizeScene, validateScene, SCENE_SPEC_VERSION, shapeBounds } from "../src/scene-spec.js";

const perto = (a, b, tol = 0.05) =>
  assert.ok(Math.abs(a - b) <= tol, `esperava ~${b}, veio ${a}`);

test("seta reta: a ponta encosta no destino e o traço para na base dela", () => {
  const g = arrowGeometry({ x1: 0, y1: 0, x2: 100, y2: 0, headLength: 20, headWidth: 10 });

  assert.deepEqual(g.head[0], [100, 0], "o bico fica exatamente no destino");
  assert.equal(g.angle, 0);

  // O traço termina na base do triângulo. Sobreposto, o stroke aparece por dentro da
  // ponta e engrossa o bico — é o defeito mais visível de uma seta montada à mão.
  assert.match(g.shaft, /L 80 0$/);

  const [, a, b] = g.head;
  perto(a[0], 80);
  perto(b[0], 80);
  perto(Math.abs(a[1] - b[1]), 10, 0.01);
});

test("seta curva: a ponta gira para a tangente de chegada, não para A→B", () => {
  // Este é o defeito que o módulo existe para impedir. Numa seta com barriga, usar a
  // direção A→B deixa a ponta visivelmente torta em relação ao traço.
  const g = arrowGeometry({ x1: 0, y1: 0, x2: 100, y2: 0, bend: -40, headLength: 20 });

  assert.notEqual(g.angle, 0, "a direção A→B seria 0°");
  perto(g.angle, 38.66, 0.1);
  assert.deepEqual(g.head[0], [100, 0]);
});

test("o traço curvo chega alinhado com a ponta", () => {
  // A base do triângulo está sobre o segmento controle→destino, então a tangente do
  // traço no ponto onde ele termina é exatamente a mesma que orienta a ponta. Sem isso
  // haveria um degrau entre traço e bico.
  const g = arrowGeometry({ x1: 0, y1: 0, x2: 100, y2: 0, bend: 60, headLength: 24 });

  const [, cx, cy, ex, ey] = g.shaft.match(/Q ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)/).map(Number);
  const anguloDoTraco = (Math.atan2(ey - cy, ex - cx) * 180) / Math.PI;

  perto(anguloDoTraco, g.angle, 0.01);
});

test("bend zero produz reta, não curva de controle inútil", () => {
  const g = arrowGeometry({ x1: 10, y1: 10, x2: 60, y2: 10 });
  assert.match(g.shaft, /^M 10 10 L /);
  assert.ok(!g.shaft.includes("Q"));
});

test("sem tamanho declarado, a ponta acompanha a espessura do traço", () => {
  // Ponta fixa num traço grosso some; num traço fino vira uma bandeira.
  const fino = arrowGeometry({ x1: 0, y1: 0, x2: 200, y2: 0, strokeWidth: 2 });
  const grosso = arrowGeometry({ x1: 0, y1: 0, x2: 200, y2: 0, strokeWidth: 12 });

  const tamanho = (g) => 200 - g.head[1][0];
  assert.ok(tamanho(grosso) > tamanho(fino) * 2);
});

test("seta sem direção é erro, não uma ponta em ângulo aleatório", () => {
  assert.throws(() => arrowGeometry({ x1: 5, y1: 5, x2: 5, y2: 5 }), ArrowError);
  assert.throws(() => arrowGeometry({ x1: 0, y1: 0, x2: "cem", y2: 0 }), ArrowError);
});

test("expandArrow dá traço com stroke e ponta com fill da cor do traço", () => {
  // Numa seta desenhada à mão o bico é da mesma cor do traço. Exigir declarar a cor
  // duas vezes é convite para elas divergirem numa das vinte setas de um diagrama.
  const [traco, ponta] = expandArrow({
    id: "seta1",
    name: "Fluxo",
    group: "diagrama",
    shape: { type: "arrow", x1: 0, y1: 0, x2: 100, y2: 0 },
    stroke: { color: "#12263a", width: 4 },
  });

  assert.equal(traco.shape.type, "path");
  assert.equal(traco.stroke.color, "#12263a");
  assert.equal(traco.fill, null);

  assert.equal(ponta.shape.type, "polygon");
  assert.equal(ponta.shape.points.length, 3);
  assert.equal(ponta.fill.color, "#12263a");
  assert.equal(ponta.stroke, null);

  // Os dois ficam no mesmo grupo, senão a seta se separa na hora de montar as camadas.
  assert.equal(traco.group, "diagrama");
  assert.equal(ponta.group, "diagrama");
  assert.match(traco.name, /Line/);
  assert.match(ponta.name, /Head/);
});

test("uma seta na cena vira duas formas construíveis", () => {
  const cena = {
    version: SCENE_SPEC_VERSION,
    canvas: { width: 400, height: 200 },
    elements: [
      {
        id: "seta",
        shape: { type: "arrow", x1: 20, y1: 100, x2: 300, y2: 100, bend: -30 },
        stroke: { color: "#ff5a20", width: 6 },
      },
    ],
  };

  assert.equal(validateScene(cena).ok, true);

  const { layers } = normalizeScene(cena);

  // Traço e ponta na MESMA camada: partida em duas, quem for mexer na seta arrasta uma
  // metade e deixa a outra para trás.
  assert.equal(layers.length, 1);

  // Um grupo por forma, cada um com sua geometria e sua pintura.
  assert.equal(layers[0].contents.length, 2, "traço e ponta");

  const geometrias = layers[0].contents
    .flatMap((g) => g.items ?? [])
    .filter((i) => i.kind === "geometry");

  assert.equal(geometrias.length, 2);
  assert.ok(geometrias.every((g) => g.shape.type === "bezier"), "os dois viram path no AE");

  const pinturas = layers[0].contents.flatMap((g) => (g.items ?? []).filter((i) => i.kind !== "geometry"));
  assert.ok(pinturas.some((p) => p.kind === "stroke"), "o traço tem stroke");
  assert.ok(pinturas.some((p) => p.kind === "fill"), "a ponta é preenchida");
});

test("a caixa da seta inclui a barriga da curva", () => {
  // Sem isso o aviso de enquadramento diria que uma seta muito curva cabe na tela
  // quando ela sai por cima.
  const reta = shapeBounds({ type: "arrow", x1: 0, y1: 100, x2: 200, y2: 100 });
  const curva = shapeBounds({ type: "arrow", x1: 0, y1: 100, x2: 200, y2: 100, bend: -80 });

  assert.ok(curva.h > reta.h + 50, "a curva ocupa altura que a reta não ocupa");
  assert.ok(curva.y < reta.y);
});

test("seta sem direção é recusada pela validação, com o elemento nomeado", () => {
  const { ok, errors } = validateScene({
    version: SCENE_SPEC_VERSION,
    canvas: { width: 400, height: 200 },
    elements: [
      { id: "ruim", shape: { type: "arrow", x1: 5, y1: 5, x2: 5, y2: 5 }, stroke: { color: "#000", width: 2 } },
    ],
  });

  assert.equal(ok, false);
  assert.match(errors.join(" "), /elements\[0\]/);
  assert.match(errors.join(" "), /mesmo lugar/);
});
