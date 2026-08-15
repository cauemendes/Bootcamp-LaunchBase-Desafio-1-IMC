import test from "node:test";
import assert from "node:assert/strict";

import { normalizeScene } from "../src/scene-spec.js";

const wrap = (shape) => ({
  version: "1.0",
  canvas: { width: 800, height: 600, background: null, frameRate: 30, duration: 10 },
  palette: [],
  elements: [
    { id: "e", name: "E", group: "", z: 0, shape, fill: { color: "#ff0000", opacity: 100 }, stroke: null },
  ],
});

const geometryOf = (shape) =>
  normalizeScene(wrap(shape)).layers[0].contents[0].items[0].shape;

test("rect: canto superior esquerdo do SceneSpec vira centro, como o AE espera", () => {
  const g = geometryOf({ type: "rect", x: 100, y: 50, w: 200, h: 80, roundness: 12, rotation: 0 });
  assert.equal(g.type, "rect");
  assert.equal(g.cx, 200);
  assert.equal(g.cy, 90);
  assert.equal(g.w, 200);
  assert.equal(g.h, 80);
  assert.equal(g.roundness, 12);
});

test("rect: roundness negativo é zerado antes de chegar no AE", () => {
  const g = geometryOf({ type: "rect", x: 0, y: 0, w: 10, h: 10, roundness: -5, rotation: 0 });
  assert.equal(g.roundness, 0);
});

test("ellipse: raios viram tamanho (o AE usa diâmetro)", () => {
  const g = geometryOf({ type: "ellipse", cx: 300, cy: 200, rx: 60, ry: 40 });
  assert.equal(g.type, "ellipse");
  assert.deepEqual([g.cx, g.cy, g.w, g.h], [300, 200, 120, 80]);
});

test("star: innerRadius igual ao outerRadius é marcado como polígono regular", () => {
  const estrela = geometryOf({ type: "star", cx: 0, cy: 0, points: 5, outerRadius: 100, innerRadius: 40, rotation: 0 });
  assert.equal(estrela.isPolygon, false);

  const poligono = geometryOf({ type: "star", cx: 0, cy: 0, points: 6, outerRadius: 100, innerRadius: 100, rotation: 0 });
  assert.equal(poligono.isPolygon, true);
});

test("primitivas permanecem primitivas — não viram path", () => {
  // Se rect/ellipse/star virassem listas de vértices, o motion designer perderia os
  // controles de tamanho e raio. Este teste existe pra travar essa regressão.
  assert.equal(geometryOf({ type: "rect", x: 0, y: 0, w: 10, h: 10, roundness: 0, rotation: 0 }).type, "rect");
  assert.equal(geometryOf({ type: "ellipse", cx: 0, cy: 0, rx: 5, ry: 5 }).type, "ellipse");
  assert.equal(
    geometryOf({ type: "star", cx: 0, cy: 0, points: 5, outerRadius: 10, innerRadius: 4, rotation: 0 }).type,
    "star"
  );
});

test("polygon vira bezier com tangentes zeradas", () => {
  const g = geometryOf({ type: "polygon", points: [[0, 0], [10, 0], [5, 8]], closed: true });

  assert.equal(g.type, "bezier");
  assert.equal(g.subpaths.length, 1);
  assert.equal(g.subpaths[0].closed, true);
  assert.deepEqual(g.subpaths[0].vertices, [[0, 0], [10, 0], [5, 8]]);
  assert.ok(g.subpaths[0].inTangents.every((t) => t[0] === 0 && t[1] === 0));
});

test("polygon aberto preserva closed: false", () => {
  const g = geometryOf({ type: "polygon", points: [[0, 0], [10, 10]], closed: false });
  assert.equal(g.subpaths[0].closed, false);
});

test("path é resolvido no core — o ExtendScript recebe vértices, não a string 'd'", () => {
  const g = geometryOf({ type: "path", d: "M0,0 C10,0 20,10 30,10 Z" });

  assert.equal(g.type, "bezier");
  assert.equal(g.subpaths.length, 1);
  assert.deepEqual(g.subpaths[0].vertices[0], [0, 0]);
  assert.deepEqual(g.subpaths[0].outTangents[0], [10, 0]);
  assert.ok(!("d" in g), "a string do SVG não deve vazar pro adapter");
});

test("path com múltiplos subpaths (buraco em ícone) mantém os dois", () => {
  const g = geometryOf({ type: "path", d: "M0,0 L20,0 L20,20 Z M5,5 L15,5 L15,15 Z" });
  assert.equal(g.subpaths.length, 2);
});
