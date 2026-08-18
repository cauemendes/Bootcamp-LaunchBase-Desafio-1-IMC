import test from "node:test";
import assert from "node:assert/strict";

import { validateScene, normalizeScene, shapeBounds } from "../src/scene-spec.js";

const el = (over = {}) => ({
  id: "e1",
  name: "Elemento",
  group: "",
  z: 0,
  shape: { type: "rect", x: 0, y: 0, w: 100, h: 50, roundness: 0, rotation: 0 },
  fill: { color: "#ff0000", opacity: 100 },
  stroke: null,
  ...over,
});

const scene = (elements, over = {}) => ({
  version: "1.0",
  canvas: { width: 800, height: 600, background: "#000000", frameRate: 30, duration: 10 },
  palette: [],
  elements,
  ...over,
});

// --- validação ---

test("uma cena bem formada passa sem erros nem avisos", () => {
  const r = validateScene(scene([el()]));
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test("campos obrigatórios que faltam viram erro", () => {
  assert.equal(validateScene(null).ok, false);
  assert.match(validateScene({ version: "1.0" }).errors.join(), /canvas ausente/);
  assert.match(validateScene(scene([{ id: "x" }])).errors.join(), /shape ausente/);
});

test("dimensão de canvas inválida é erro, não aviso", () => {
  const r = validateScene(scene([el()], { canvas: { width: 0, height: 600 } }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /canvas\.width/);
});

test("cor malformada num fill é erro", () => {
  const r = validateScene(scene([el({ fill: { color: "vermelho", opacity: 100 } })]));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /hex inválido/);
});

test("path com sintaxe quebrada é pego na validação, não só na hora de construir", () => {
  const r = validateScene(scene([el({ shape: { type: "path", d: "M0,0 A10,10 0 0 1 20,0" } })]));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /não pôde ser lido/);
});

test("id duplicado é aviso — a construção segue", () => {
  const r = validateScene(scene([el({ id: "dup" }), el({ id: "dup" })]));
  assert.equal(r.ok, true);
  assert.match(r.warnings.join(), /duplicado/);
});

test("elemento sem fill nem stroke avisa que sairá invisível", () => {
  const r = validateScene(scene([el({ fill: null, stroke: null })]));
  assert.equal(r.ok, true);
  assert.match(r.warnings.join(), /invisível/);
});

test("elemento inteiramente fora do canvas avisa", () => {
  const r = validateScene(
    scene([el({ shape: { type: "rect", x: 5000, y: 0, w: 10, h: 10, roundness: 0, rotation: 0 } })])
  );
  assert.match(r.warnings.join(), /fora do canvas/);
});

test("opacidade fora de 0–100 é aviso, e é limitada na normalização", () => {
  const s = scene([el({ fill: { color: "#ff0000", opacity: 150 } })]);
  assert.match(validateScene(s).warnings.join(), /opacity fora/);
  assert.equal(normalizeScene(s).layers[0].contents[0].items[1].opacity, 100);
});

test("stroke sem width é erro", () => {
  const r = validateScene(scene([el({ stroke: { color: "#000000", opacity: 100 } })]));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /width/);
});

test("star com menos de 3 pontas é erro", () => {
  const r = validateScene(
    scene([
      el({
        shape: { type: "star", cx: 0, cy: 0, points: 2, outerRadius: 10, innerRadius: 5, rotation: 0 },
      }),
    ])
  );
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /points precisa ser inteiro/);
});

test("texto sem conteúdo é erro; sem fonte é só aviso", () => {
  const semTexto = validateScene(
    scene([
      el({
        shape: { type: "text", x: 0, y: 0, content: "", fontFamily: "Arial", fontSize: 40, weight: "", align: "left", letterSpacing: 0 },
      }),
    ])
  );
  assert.equal(semTexto.ok, false);

  const semFonte = validateScene(
    scene([
      el({
        shape: { type: "text", x: 0, y: 0, content: "oi", fontFamily: "", fontSize: 40, weight: "", align: "left", letterSpacing: 0 },
      }),
    ])
  );
  assert.equal(semFonte.ok, true);
  assert.match(semFonte.warnings.join(), /fontFamily/);
});

// --- normalização ---

test("normalizeScene preenche defaults do canvas", () => {
  const n = normalizeScene(scene([el()], { canvas: { width: 800, height: 600, background: null } }));
  assert.equal(n.canvas.frameRate, 30);
  assert.equal(n.canvas.duration, 10);
  assert.equal(n.canvas.background, null);
});

test("elementos são ordenados por z, e empates mantêm a ordem original", () => {
  const n = normalizeScene(
    scene([
      el({ id: "c", name: "C", z: 5, group: "" }),
      el({ id: "a", name: "A", z: 1, group: "" }),
      el({ id: "b", name: "B", z: 1, group: "" }),
    ])
  );
  assert.deepEqual(n.layers.map((l) => l.name), ["A", "B", "C"]);
});

test("per-group junta elementos do mesmo grupo numa layer só", () => {
  const n = normalizeScene(
    scene([
      el({ id: "logo-bg", name: "Logo / Fundo", group: "Logo", z: 0 }),
      el({ id: "logo-mark", name: "Logo / Símbolo", group: "Logo", z: 1 }),
      el({ id: "solto", name: "Solto", group: "", z: 2 }),
    ])
  );

  assert.equal(n.layers.length, 2);
  assert.equal(n.layers[0].name, "Logo");
  assert.equal(n.layers[0].contents.length, 2);
  assert.equal(n.layers[1].name, "Solto");
});

test("per-element dá uma layer para cada elemento, ignorando o grupo", () => {
  const n = normalizeScene(
    scene([
      el({ id: "a", name: "A", group: "Logo", z: 0 }),
      el({ id: "b", name: "B", group: "Logo", z: 1 }),
    ]),
    { layerMode: "per-element" }
  );
  assert.equal(n.layers.length, 2);
});

test("dentro da layer, os grupos vêm invertidos — no AE o primeiro item fica na frente", () => {
  const n = normalizeScene(
    scene([
      el({ id: "atras", name: "Atrás", group: "G", z: 0 }),
      el({ id: "frente", name: "Frente", group: "G", z: 1 }),
    ])
  );
  // z maior = mais na frente = primeiro em Contents.
  assert.deepEqual(n.layers[0].contents.map((c) => c.name), ["Frente", "Atrás"]);
});

test("dentro de um grupo, a ordem é geometria → stroke → fill", () => {
  const n = normalizeScene(
    scene([el({ stroke: { color: "#000000", width: 4, opacity: 100, cap: "round", join: "round" } })])
  );
  assert.deepEqual(
    n.layers[0].contents[0].items.map((i) => i.kind),
    ["geometry", "stroke", "fill"]
  );
});

test("texto vira layer própria mesmo tendo grupo", () => {
  const n = normalizeScene(
    scene([
      el({ id: "bg", name: "Fundo", group: "Card", z: 0 }),
      el({
        id: "t",
        name: "Título",
        group: "Card",
        z: 1,
        shape: { type: "text", x: 10, y: 40, content: "Olá", fontFamily: "Arial", fontSize: 40, weight: "Bold", align: "left", letterSpacing: 0 },
        fill: { color: "#ffffff", opacity: 100 },
      }),
    ])
  );

  assert.equal(n.layers.length, 2);
  const texto = n.layers.find((l) => l.type === "text");
  assert.equal(texto.content, "Olá");
  assert.equal(texto.color, "#ffffff");
});

test("valores inválidos de cap/join caem no default em vez de vazar pro ExtendScript", () => {
  const n = normalizeScene(
    scene([el({ stroke: { color: "#000000", width: 2, opacity: 100, cap: "arredondado", join: "torto" } })])
  );
  const stroke = n.layers[0].contents[0].items.find((i) => i.kind === "stroke");
  assert.equal(stroke.cap, "butt");
  assert.equal(stroke.join, "miter");
});

// --- bounds ---

test("shapeBounds cobre cada tipo de primitiva", () => {
  assert.deepEqual(
    shapeBounds({ type: "rect", x: 10, y: 20, w: 100, h: 50 }),
    { x: 10, y: 20, width: 100, height: 50 }
  );
  assert.deepEqual(
    shapeBounds({ type: "ellipse", cx: 50, cy: 50, rx: 20, ry: 10 }),
    { x: 30, y: 40, width: 40, height: 20 }
  );
  assert.deepEqual(
    shapeBounds({ type: "polygon", points: [[0, 0], [10, 5], [4, 20]] }),
    { x: 0, y: 0, width: 10, height: 20 }
  );
  assert.deepEqual(
    shapeBounds({ type: "path", d: "M0,0 L30,0 L30,40 Z" }),
    { x: 0, y: 0, width: 30, height: 40 }
  );
});

test("shapeBounds devolve null quando o path não é legível, em vez de quebrar", () => {
  assert.equal(shapeBounds({ type: "path", d: "isso não é um path" }), null);
});

// ---------------------------------------------------------------- gradiente

test("gradiente válido passa e chega normalizado ao adapter", () => {
  const cena = {
    version: "1.0",
    canvas: { width: 100, height: 100 },
    elements: [
      {
        id: "fundo",
        name: "Fundo",
        shape: { type: "rect", x: 0, y: 0, w: 50, h: 50 },
        fill: { type: "gradient", kind: "radial", from: "#FF6200", to: "#161D26", start: [0, 0], end: [50, 50] },
      },
    ],
  };

  assert.equal(validateScene(cena).ok, true);

  const item = normalizeScene(cena).layers[0].contents[0].items.find((i) => i.kind === "fill");

  assert.equal(item.paint, "gradient");
  // O campo é `gradient`, não `kind`: um `kind` aqui sobrescreveria "fill" no spread
  // e o adapter deixaria de saber se pinta o interior ou o contorno.
  assert.equal(item.kind, "fill");
  assert.equal(item.gradient, "radial");
  assert.equal(item.from, "#ff6200");
  assert.equal(item.to, "#161d26");
});

test("gradiente em stroke preserva largura, cap e join", () => {
  const cena = {
    version: "1.0",
    canvas: { width: 100, height: 100 },
    elements: [
      {
        id: "linha",
        name: "Linha",
        shape: { type: "rect", x: 0, y: 0, w: 50, h: 50 },
        stroke: { type: "gradient", from: "#fff", to: "#000", width: 6, cap: "round", join: "round" },
      },
    ],
  };

  const item = normalizeScene(cena).layers[0].contents[0].items.find((i) => i.kind === "stroke");

  assert.equal(item.paint, "gradient");
  assert.equal(item.width, 6);
  assert.equal(item.cap, "round");
  assert.equal(item.join, "round");
});

test("gradiente com hex inválido é erro, e diz qual campo", () => {
  const cena = {
    version: "1.0",
    canvas: { width: 100, height: 100 },
    elements: [
      {
        id: "x",
        name: "X",
        shape: { type: "rect", x: 0, y: 0, w: 10, h: 10 },
        fill: { type: "gradient", from: "nao-e-cor", to: "#000" },
      },
    ],
  };

  const r = validateScene(cena);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /\.from/);
});

test("ponto de gradiente malformado é erro", () => {
  const cena = {
    version: "1.0",
    canvas: { width: 100, height: 100 },
    elements: [
      {
        id: "x",
        name: "X",
        shape: { type: "rect", x: 0, y: 0, w: 10, h: 10 },
        fill: { type: "gradient", from: "#fff", to: "#000", start: [1] },
      },
    ],
  };

  assert.match(validateScene(cena).errors.join(" "), /start/);
});

test("gradiente sem pontos é aceito — o adapter usa a diagonal do elemento", () => {
  const cena = {
    version: "1.0",
    canvas: { width: 100, height: 100 },
    elements: [
      {
        id: "x",
        name: "X",
        shape: { type: "rect", x: 0, y: 0, w: 10, h: 10 },
        fill: { type: "gradient", from: "#fff", to: "#000" },
      },
    ],
  };

  assert.equal(validateScene(cena).ok, true);
  const item = normalizeScene(cena).layers[0].contents[0].items.find((i) => i.kind === "fill");
  assert.equal(item.start, null);
  assert.equal(item.end, null);
});

// ---------------------------------------------------------------- imagem

test("imagem com arquivo vira camada própria, não item de shape layer", () => {
  // Footage não cabe dentro de um shape layer — tem que ser camada.
  const cena = {
    version: "1.0",
    canvas: { width: 1000, height: 800 },
    elements: [
      {
        id: "foto",
        name: "Foto / Produto",
        shape: { type: "image", x: 120, y: 340, w: 480, h: 360, fit: "contain", source: "/tmp/foto.png" },
      },
    ],
  };

  assert.equal(validateScene(cena).ok, true);

  const layer = normalizeScene(cena).layers[0];
  assert.equal(layer.type, "image");
  assert.equal(layer.source, "/tmp/foto.png");
  assert.equal(layer.fit, "contain");
  assert.deepEqual([layer.x, layer.y, layer.width, layer.height], [120, 340, 480, 360]);
});

test("imagem sem arquivo é aceita e avisa que entra como placeholder", () => {
  const cena = {
    version: "1.0",
    canvas: { width: 1000, height: 800 },
    elements: [
      {
        id: "foto",
        name: "Foto",
        shape: { type: "image", x: 0, y: 0, w: 100, h: 100, label: "foto do produto" },
      },
    ],
  };

  const r = validateScene(cena);
  assert.equal(r.ok, true, "placeholder é uma escolha válida, não um erro");
  assert.match(r.warnings.join(" "), /PLACEHOLDER/);

  const layer = normalizeScene(cena).layers[0];
  assert.equal(layer.source, null);
  assert.equal(layer.label, "foto do produto");
});

test("imagem sem dimensão é erro", () => {
  const cena = {
    version: "1.0",
    canvas: { width: 100, height: 100 },
    elements: [{ id: "x", name: "X", shape: { type: "image", x: 0, y: 0, w: 0, h: 50 } }],
  };

  assert.match(validateScene(cena).errors.join(" "), /w precisa ser > 0/);
});

test("fit inválido é aviso e cai em cover", () => {
  const cena = {
    version: "1.0",
    canvas: { width: 100, height: 100 },
    elements: [
      { id: "x", name: "X", shape: { type: "image", x: 0, y: 0, w: 50, h: 50, fit: "esticar", source: "/a.png" } },
    ],
  };

  assert.match(validateScene(cena).warnings.join(" "), /fit inválido/);
  assert.equal(normalizeScene(cena).layers[0].fit, "cover");
});

test("imagem fora do canvas recebe o mesmo aviso de enquadramento das formas", () => {
  const cena = {
    version: "1.0",
    canvas: { width: 100, height: 100 },
    elements: [
      { id: "x", name: "X", shape: { type: "image", x: 500, y: 500, w: 50, h: 50, source: "/a.png" } },
    ],
  };

  assert.match(validateScene(cena).warnings.join(" "), /fora do canvas/);
});
