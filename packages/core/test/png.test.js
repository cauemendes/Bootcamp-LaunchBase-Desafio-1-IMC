/**
 * Testes do decodificador de PNG e das medições.
 *
 * Os PNGs são gerados aqui, com zlib do Node, em vez de virem de arquivos fixos: um
 * arquivo binário no repositório não diz que cor tem em que pixel, e um teste que
 * falha vira adivinhação. Gerando, a expectativa está escrita ao lado da asserção.
 */

import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

import { PngError, decodePng } from "../src/png.js";
import { measureRegion, sampleColor, scanLine } from "../src/measure.js";

const inflate = (bytes) => new Uint8Array(zlib.inflateSync(Buffer.from(bytes)));

// ---------------------------------------------------------------- geração

function crc32(bytes) {
  let c = ~0;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(tipo, dados) {
  const corpo = Buffer.concat([Buffer.from(tipo, "ascii"), Buffer.from(dados)]);
  const tamanho = Buffer.alloc(4);
  tamanho.writeUInt32BE(dados.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo));
  return Buffer.concat([tamanho, corpo, crc]);
}

/**
 * Monta um PNG RGBA de 8 bits a partir de uma função (x, y) => [r,g,b,a].
 * `filtro` escolhe o tipo de filtro por linha, para exercitar o desfiltrador.
 */
function png(width, height, pinta, filtro = 0) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;  // compressão
  ihdr[11] = 0;  // filtro
  ihdr[12] = 0;  // sem entrelaçamento

  const stride = width * 4;
  const bruto = Buffer.alloc((stride + 1) * height);

  // Linhas cruas primeiro; o filtro é aplicado depois, em cima delas.
  const linhas = [];
  for (let y = 0; y < height; y++) {
    const linha = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pinta(x, y);
      linha[x * 4] = r;
      linha[x * 4 + 1] = g;
      linha[x * 4 + 2] = b;
      linha[x * 4 + 3] = a ?? 255;
    }
    linhas.push(linha);
  }

  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    bruto[base] = filtro;
    for (let x = 0; x < stride; x++) {
      const atual = linhas[y][x];
      if (filtro === 0) {
        bruto[base + 1 + x] = atual;
      } else if (filtro === 1) {
        bruto[base + 1 + x] = (atual - (x >= 4 ? linhas[y][x - 4] : 0)) & 0xff;
      } else if (filtro === 2) {
        bruto[base + 1 + x] = (atual - (y > 0 ? linhas[y - 1][x] : 0)) & 0xff;
      }
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(bruto)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const LARANJA = [0xff, 0x62, 0x00];
const TINTA = [0x16, 0x1d, 0x26];

// ---------------------------------------------------------------- decodificação

test("decodifica RGBA sem filtro", () => {
  const img = decodePng(png(4, 3, (x) => (x < 2 ? LARANJA : TINTA)), inflate);

  assert.equal(img.width, 4);
  assert.equal(img.height, 3);
  assert.deepEqual([...img.data.slice(0, 4)], [0xff, 0x62, 0x00, 255]);
  assert.deepEqual([...img.data.slice(8, 12)], [0x16, 0x1d, 0x26, 255]);
});

test("desfaz os filtros Sub e Up", () => {
  // Filtro por linha é sequencial e depende do que já foi reconstruído; errar aqui
  // produz imagem visivelmente embaralhada, não um erro.
  const pinta = (x, y) => [x * 30, y * 30, 100];

  for (const filtro of [1, 2]) {
    const img = decodePng(png(8, 8, pinta, filtro), inflate);
    const ultimo = (7 * 8 + 7) * 4;

    assert.deepEqual([...img.data.slice(0, 3)], [0, 0, 100], `filtro ${filtro}: primeiro pixel`);
    assert.deepEqual([...img.data.slice(ultimo, ultimo + 3)], [210, 210, 100], `filtro ${filtro}: último pixel`);
  }
});

test("preserva o canal alpha", () => {
  const img = decodePng(png(2, 1, (x) => [...LARANJA, x === 0 ? 0 : 128]), inflate);
  assert.equal(img.data[3], 0);
  assert.equal(img.data[7], 128);
});

test("recusa arquivo que não é PNG, com mensagem clara", () => {
  assert.throws(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), inflate), PngError);
});

test("recusa PNG entrelaçado em vez de devolver pixel embaralhado", () => {
  const bytes = png(4, 4, () => LARANJA);
  bytes[8 + 8 + 12] = 1; // byte de interlace no IHDR

  assert.throws(() => decodePng(bytes, inflate), /entrelaçado/);
});

test("exige a função inflate, e explica", () => {
  assert.throws(() => decodePng(png(2, 2, () => LARANJA)), /inflate/);
});

// ---------------------------------------------------------------- amostragem

test("sampleColor devolve a cor chapada com uniformidade total", () => {
  const img = decodePng(png(20, 20, () => LARANJA), inflate);
  const amostra = sampleColor(img, 10, 10);

  assert.equal(amostra.hex, "#ff6200");
  assert.equal(amostra.uniformity, 1);
});

test("sampleColor acusa quando a amostra cai em cima de uma borda", () => {
  // Metade laranja, metade tinta: amostrar exatamente na divisa dá um hex que não
  // existe no design. A uniformidade é o que impede o modelo de confiar nele.
  const img = decodePng(png(20, 20, (x) => (x < 10 ? LARANJA : TINTA)), inflate);

  assert.equal(sampleColor(img, 3, 10).uniformity, 1, "longe da borda");
  assert.ok(sampleColor(img, 10, 10).uniformity < 0.7, "em cima da borda");
});

// ---------------------------------------------------------------- região

test("measureRegion acha os limites de um retângulo chapado", () => {
  const dentro = (x, y) => x >= 4 && x < 14 && y >= 2 && y < 8;
  const img = decodePng(png(20, 12, (x, y) => (dentro(x, y) ? LARANJA : TINTA)), inflate);

  const r = measureRegion(img, 6, 4);

  assert.equal(r.color, "#ff6200");
  assert.deepEqual(r.bounds, { x: 4, y: 2, width: 10, height: 6 });
  assert.equal(r.pixelCount, 60);
  assert.equal(r.fill, 1, "retângulo cheio preenche o próprio bounding box");
  assert.deepEqual(r.corners, { topLeft: 0, topRight: 0, bottomLeft: 0, bottomRight: 0 });
});

test("measureRegion mede cada canto separado — o caso que motivou isto", () => {
  // Canto superior esquerdo cortado em 4, o direito em 1: contorno assimétrico, como
  // o card real que tinha 172px de um lado e 114px do outro.
  const dentro = (x, y) => {
    if (x < 0 || x >= 20 || y < 0 || y >= 10) return false;
    if (y === 0 && x < 4) return false;
    if (y === 0 && x > 18) return false;
    return true;
  };
  const img = decodePng(png(20, 10, (x, y) => (dentro(x, y) ? LARANJA : TINTA)), inflate);

  const r = measureRegion(img, 10, 5);

  assert.equal(r.corners.topLeft, 4);
  assert.equal(r.corners.topRight, 1);
  assert.equal(r.corners.bottomLeft, 0);
  assert.notEqual(r.corners.topLeft, r.corners.topRight);
});

test("measureRegion não vaza por diagonal", () => {
  // Duas áreas da mesma cor tocando só pelo vértice são formas diferentes no design.
  const img = decodePng(
    png(4, 4, (x, y) => {
      const a = x < 2 && y < 2;
      const b = x >= 2 && y >= 2;
      return a || b ? LARANJA : TINTA;
    }),
    inflate
  );

  assert.equal(measureRegion(img, 0, 0).pixelCount, 4);
});

test("measureRegion recusa semente fora da imagem", () => {
  const img = decodePng(png(4, 4, () => LARANJA), inflate);
  assert.throws(() => measureRegion(img, 99, 0), RangeError);
});

// ---------------------------------------------------------------- varredura

test("scanLine reporta onde a cor muda", () => {
  const img = decodePng(png(30, 4, (x) => (x >= 10 && x < 20 ? LARANJA : TINTA)), inflate);
  const r = scanLine(img, "horizontal", 2);

  assert.equal(r.runs.length, 3);
  assert.deepEqual(
    r.edges.map((e) => e.at),
    [10, 20]
  );
  assert.equal(r.edges[0].from, "#161d26");
  assert.equal(r.edges[0].to, "#ff6200");
});

test("scanLine descarta trechos curtos de antialiasing", () => {
  // Um pixel intermediário entre duas áreas é borda suavizada, não cor do design.
  const img = decodePng(
    png(30, 4, (x) => {
      if (x === 15) return [0x8b, 0x3f, 0x13];
      return x > 15 ? LARANJA : TINTA;
    }),
    inflate
  );

  const r = scanLine(img, "horizontal", 2);

  assert.equal(r.runs.length, 2, "o pixel de transição não vira um trecho");
  assert.equal(r.discardedRuns, 1);
});

test("scanLine funciona na vertical", () => {
  const img = decodePng(png(4, 30, (x, y) => (y >= 12 ? LARANJA : TINTA)), inflate);
  const r = scanLine(img, "vertical", 2);

  assert.deepEqual(r.edges.map((e) => e.at), [12]);
});
