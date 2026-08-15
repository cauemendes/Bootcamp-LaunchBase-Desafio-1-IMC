import test from "node:test";
import assert from "node:assert/strict";

import { parsePathData, subpathsBounds } from "../src/svg-path.js";

const close = (a, b, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) < tol, `esperava ${b}, recebi ${a}`);

const closePoint = (a, b, tol = 1e-6) => {
  close(a[0], b[0], tol);
  close(a[1], b[1], tol);
};

test("triângulo fechado com linhas retas", () => {
  const [sp] = parsePathData("M10,10 L90,10 L50,80 Z");

  assert.equal(sp.closed, true);
  assert.equal(sp.vertices.length, 3);
  assert.deepEqual(sp.vertices, [[10, 10], [90, 10], [50, 80]]);
  // Segmento reto = tangentes zeradas nas duas pontas.
  assert.ok(sp.inTangents.every((t) => t[0] === 0 && t[1] === 0));
  assert.ok(sp.outTangents.every((t) => t[0] === 0 && t[1] === 0));
});

test("vértice duplicado no fim de um path fechado é colapsado", () => {
  // Exportadores costumam repetir o ponto inicial antes do Z. O AE fecha pela flag,
  // então o duplicado viraria um ponto degenerado se não fosse removido.
  const [sp] = parsePathData("M0,0 L10,0 L10,10 L0,0 Z");
  assert.equal(sp.vertices.length, 3);
  assert.deepEqual(sp.vertices[0], [0, 0]);
});

test("comandos relativos acumulam a partir do cursor", () => {
  const [sp] = parsePathData("M10,10 l20,0 l0,20");
  assert.deepEqual(sp.vertices, [[10, 10], [30, 10], [30, 30]]);
});

test("H e V, absolutos e relativos", () => {
  const [sp] = parsePathData("M10,10 H50 V60 h-20 v-10");
  assert.deepEqual(sp.vertices, [[10, 10], [50, 10], [50, 60], [30, 60], [30, 50]]);
});

test("cúbica vira tangentes relativas ao vértice", () => {
  // P0=(0,0) C1=(10,0) C2=(20,10) P1=(30,10)
  const [sp] = parsePathData("M0,0 C10,0 20,10 30,10");

  assert.equal(sp.vertices.length, 2);
  closePoint(sp.outTangents[0], [10, 0], 1e-9);   // C1 - P0
  closePoint(sp.inTangents[1], [-10, 0], 1e-9);   // C2 - P1
});

test("S reflete o controle anterior", () => {
  // Depois de C com C2=(20,10) em P1=(30,10), o S usa C1 = reflexo de C2 = (40,10).
  const [sp] = parsePathData("M0,0 C10,0 20,10 30,10 S50,20 60,20");

  assert.equal(sp.vertices.length, 3);
  closePoint(sp.outTangents[1], [10, 0], 1e-9);   // (40,10) - (30,10)
  closePoint(sp.inTangents[2], [-10, 0], 1e-9);   // (50,20) - (60,20)
});

test("quadrática é elevada para cúbica", () => {
  // P0=(0,0) Q=(30,30) P1=(60,0)
  // C1 = P0 + 2/3*(Q-P0) = (20,20);  C2 = P1 + 2/3*(Q-P1) = (40,20)
  const [sp] = parsePathData("M0,0 Q30,30 60,0");

  closePoint(sp.outTangents[0], [20, 20], 1e-9);
  closePoint(sp.inTangents[1], [-20, 20], 1e-9);
});

test("T reflete o controle quadrático anterior", () => {
  const [sp] = parsePathData("M0,0 Q30,30 60,0 T120,0");
  assert.equal(sp.vertices.length, 3);
  // O reflexo de (30,30) em torno de (60,0) é (90,-30).
  closePoint(sp.outTangents[1], [20, -20], 1e-9);
});

test("vários subpaths a partir de M repetido", () => {
  const subpaths = parsePathData("M0,0 L10,0 Z M20,0 L30,0 Z");
  assert.equal(subpaths.length, 2);
  assert.deepEqual(subpaths[0].vertices, [[0, 0], [10, 0]]);
  assert.deepEqual(subpaths[1].vertices, [[20, 0], [30, 0]]);
});

test("argumentos repetidos num só comando são expandidos", () => {
  const [sp] = parsePathData("M0,0 L10,0 20,0 30,0");
  assert.deepEqual(sp.vertices, [[0, 0], [10, 0], [20, 0], [30, 0]]);
});

test("M repetido vira L, como manda a spec do SVG", () => {
  const subpaths = parsePathData("M0,0 10,10 20,20");
  assert.equal(subpaths.length, 1, "só o primeiro par abre um subpath");
  assert.deepEqual(subpaths[0].vertices, [[0, 0], [10, 10], [20, 20]]);
});

test("arco é recusado com mensagem acionável em vez de aproximação errada", () => {
  assert.throws(() => parsePathData("M0,0 A10,10 0 0 1 20,0"), /arco/i);
});

test("erros de sintaxe são explícitos", () => {
  assert.throws(() => parsePathData(""), /vazio/);
  assert.throws(() => parsePathData("10,10 L20,20"), /começa com número/);
  assert.throws(() => parsePathData("M10"), /esperava múltiplo de 2/);
});

test("subpathsBounds cobre todos os subpaths", () => {
  const b = subpathsBounds(parsePathData("M0,0 L10,0 Z M-5,20 L30,25 Z"));
  assert.deepEqual(b, { x: -5, y: 0, width: 35, height: 25 });
});

test("espaços e vírgulas são intercambiáveis", () => {
  const a = parsePathData("M10,10L20,20");
  const b = parsePathData("M 10 10 L 20 20");
  assert.deepEqual(a[0].vertices, b[0].vertices);
});

test("notação científica e decimais sem zero à esquerda são lidos", () => {
  const [sp] = parsePathData("M.5,.5 L1e2,2.5e1");
  closePoint(sp.vertices[0], [0.5, 0.5]);
  closePoint(sp.vertices[1], [100, 25]);
});
