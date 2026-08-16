import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_FALLBACK_FONT,
  applyBrand,
  brandSummary,
  validateBrand,
} from "../src/brand.js";

const MARCA = {
  name: "Cliente X",
  colors: { primary: "#FF5A20", ink: "#12263A", paper: "#F7F5F0" },
  fonts: {
    heading: { family: "ABC Diatype", style: "Bold" },
    body: { family: "ABC Diatype", style: "Regular" },
  },
};

const cena = (elements) => ({ canvas: { width: 100, height: 100 }, elements });

// ---------------------------------------------------------------- validação

test("validateBrand aceita um perfil só com cores", () => {
  const r = validateBrand({ colors: { primary: "#fff" } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test("validateBrand recusa hex inválido e fonte sem family", () => {
  const r = validateBrand({ colors: { primary: "nao-e-cor" }, fonts: { heading: {} } });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 2);
  assert.match(r.errors.join(" "), /colors\.primary/);
  assert.match(r.errors.join(" "), /fonts\.heading/);
});

test("validateBrand avisa quando o perfil não muda nada", () => {
  const r = validateBrand({ name: "Vazio" });
  assert.equal(r.ok, true);
  assert.match(r.warnings.join(" "), /não define nenhuma cor nem fonte/);
});

test("validateBrand recusa o que não é objeto", () => {
  assert.equal(validateBrand(null).ok, false);
  assert.equal(validateBrand([]).ok, false);
  assert.equal(validateBrand("marca").ok, false);
});

// ---------------------------------------------------------------- cores

test("token de cor vira o hex da marca", () => {
  const { scene, applied } = applyBrand(
    cena([{ shape: { type: "rect", x: 0, y: 0, w: 10, h: 10 }, fill: { color: "primary" } }]),
    MARCA
  );

  assert.equal(scene.elements[0].fill.color, "#ff5a20");
  assert.equal(applied.colors, 1);
});

test("token que não existe fica como está e vira aviso", () => {
  const { scene, warnings, applied } = applyBrand(
    cena([{ shape: { type: "rect", x: 0, y: 0, w: 10, h: 10 }, fill: { color: "secundaria" } }]),
    MARCA
  );

  assert.equal(scene.elements[0].fill.color, "secundaria");
  assert.deepEqual(applied.unresolved, ["secundaria"]);
  assert.match(warnings.join(" "), /não existe na marca/);
  // O aviso precisa dizer quais existem, senão o modelo chuta de novo.
  assert.match(warnings.join(" "), /primary/);
});

test("hex quase igual encosta na cor da marca", () => {
  // O que um modelo de visão devolve medindo pixels de um JPEG da cor #ff5a20.
  const { scene, warnings, applied } = applyBrand(
    cena([{ shape: { type: "rect", x: 0, y: 0, w: 10, h: 10 }, fill: { color: "#ff5b1f" } }]),
    MARCA
  );

  assert.equal(scene.elements[0].fill.color, "#ff5a20");
  assert.equal(applied.snapped, 1);
  assert.match(warnings.join(" "), /virou #ff5a20 \(primary\)/);
});

test("hex realmente diferente não é encostado", () => {
  const { scene, applied } = applyBrand(
    cena([{ shape: { type: "rect", x: 0, y: 0, w: 10, h: 10 }, fill: { color: "#2e7d32" } }]),
    MARCA
  );

  assert.equal(scene.elements[0].fill.color, "#2e7d32");
  assert.equal(applied.snapped, 0);
});

test("snapColors: false preserva o hex medido", () => {
  const { scene, applied } = applyBrand(
    cena([{ shape: { type: "rect", x: 0, y: 0, w: 10, h: 10 }, fill: { color: "#ff5b1f" } }]),
    MARCA,
    { snapColors: false }
  );

  assert.equal(scene.elements[0].fill.color, "#ff5b1f");
  assert.equal(applied.snapped, 0);
});

test("stroke e background passam pela mesma resolução", () => {
  const { scene } = applyBrand(
    {
      canvas: { width: 100, height: 100 },
      background: "paper",
      elements: [
        {
          shape: { type: "rect", x: 0, y: 0, w: 10, h: 10 },
          stroke: { color: "ink", width: 2 },
        },
      ],
    },
    MARCA
  );

  assert.equal(scene.background, "#f7f5f0");
  assert.equal(scene.elements[0].stroke.color, "#12263a");
  assert.equal(scene.elements[0].stroke.width, 2, "o resto do paint fica intacto");
});

// ---------------------------------------------------------------- fontes

test("token de fonte traz família e estilo", () => {
  const { scene, applied } = applyBrand(
    cena([{ shape: { type: "text", x: 0, y: 0, fontSize: 24, content: "oi", fontFamily: "heading" } }]),
    MARCA
  );

  assert.equal(scene.elements[0].shape.fontFamily, "ABC Diatype");
  assert.equal(scene.elements[0].shape.fontStyle, "Bold");
  assert.equal(applied.fonts, 1);
});

test("estilo explícito na cena ganha do estilo da marca", () => {
  const { scene } = applyBrand(
    cena([
      {
        shape: {
          type: "text", x: 0, y: 0, fontSize: 24, content: "oi",
          fontFamily: "heading", fontStyle: "Light",
        },
      },
    ]),
    MARCA
  );

  assert.equal(scene.elements[0].shape.fontStyle, "Light");
});

test("família que não é token da marca passa direto", () => {
  const { scene } = applyBrand(
    cena([{ shape: { type: "text", x: 0, y: 0, fontSize: 24, content: "oi", fontFamily: "Futura" } }]),
    MARCA
  );

  assert.equal(scene.elements[0].shape.fontFamily, "Futura");
});

test("texto sem fonte cai no fallback, com aviso", () => {
  const { scene, warnings } = applyBrand(
    cena([{ shape: { type: "text", x: 0, y: 0, fontSize: 24, content: "oi" } }]),
    { colors: { primary: "#fff" } }
  );

  assert.equal(scene.elements[0].shape.fontFamily, DEFAULT_FALLBACK_FONT);
  assert.match(warnings.join(" "), /texto sem fonte/);
});

test("fallbackFont da marca substitui o padrão", () => {
  const { scene } = applyBrand(
    cena([{ shape: { type: "text", x: 0, y: 0, fontSize: 24, content: "oi" } }]),
    { ...MARCA, fallbackFont: "Helvetica" }
  );

  assert.equal(scene.elements[0].shape.fontFamily, "Helvetica");
});

// ---------------------------------------------------------------- forma e escopo

test("a cena original não é modificada", () => {
  const original = cena([
    { shape: { type: "rect", x: 0, y: 0, w: 10, h: 10 }, fill: { color: "primary" } },
  ]);

  applyBrand(original, MARCA);

  assert.equal(original.elements[0].fill.color, "primary");
});

test("a forma aninhada (layers/items) também é resolvida", () => {
  const { scene } = applyBrand(
    {
      canvas: { width: 100, height: 100 },
      layers: [
        {
          name: "cabeçalho",
          items: [{ shape: { type: "rect", x: 0, y: 0, w: 10, h: 10 }, fill: { color: "primary" } }],
        },
      ],
    },
    MARCA
  );

  assert.equal(scene.layers[0].items[0].fill.color, "#ff5a20");
  assert.equal(scene.layers[0].name, "cabeçalho");
});

test("primitiva continua primitiva depois da marca", () => {
  const { scene } = applyBrand(
    cena([{ shape: { type: "ellipse", cx: 5, cy: 5, rx: 3, ry: 3 }, fill: { color: "ink" } }]),
    MARCA
  );

  // Trocar cor não pode transformar geometria — é o que garante a editabilidade.
  assert.deepEqual(scene.elements[0].shape, { type: "ellipse", cx: 5, cy: 5, rx: 3, ry: 3 });
});

// ---------------------------------------------------------------- resumo

test("brandSummary cabe em poucas linhas e lista os nomes usáveis", () => {
  const texto = brandSummary(MARCA);

  assert.match(texto, /Cliente X/);
  assert.match(texto, /primary=#ff5a20/);
  assert.match(texto, /heading=ABC Diatype Bold/);
  assert.ok(texto.split("\n").length <= 5, "resumo longo demais gasta contexto à toa");
});

test("brandSummary avisa quando não há fonte definida", () => {
  assert.match(brandSummary({ colors: { primary: "#fff" } }), /texto sai em Arial/);
});

test("brandSummary carrega as regras de uso do manual", () => {
  // Um manual real tem cor que só vale em certo contexto. É a regra que se viola sem
  // perceber, porque o hexadecimal está certo — só o lugar é que não.
  const texto = brandSummary({
    ...MARCA,
    colors: { ...MARCA.colors, "primary-text": "#f55600" },
    notes: ["primary-text só como cor de texto sobre paper"],
  });

  assert.match(texto, /Regras de uso/);
  assert.match(texto, /só como cor de texto sobre paper/);
});

test("notes malformado é erro, não aviso", () => {
  // Silenciar uma regra de marca inválida é pior que recusar: o usuário acha que
  // registrou a restrição e ela não existe.
  assert.equal(validateBrand({ ...MARCA, notes: "uma regra só" }).ok, false);
  assert.equal(validateBrand({ ...MARCA, notes: [42] }).ok, false);
  assert.equal(validateBrand({ ...MARCA, notes: ["ok"] }).ok, true);
});
