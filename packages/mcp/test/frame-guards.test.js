/**
 * Guardas do save_frame: frame em branco e frame do tamanho errado.
 *
 * ── Por que estas duas conferências existem ───────────────────────────────────
 * As duas cobrem o mesmo modo de falhar, que é o pior que este projeto tem: **nada
 * falha**. O frame chega como imagem válida, a medição responde com números coerentes,
 * e a cena sai com o desenho certo e a cor ou o tamanho errados. A primeira suspeita
 * recai sobre a medição, que está funcionando.
 *
 * Aconteceu em uso, e as duas causas eram reais: `timeSpanStart` fora do intervalo da
 * comp entregando quadro vazio, e o seletor de resolução da composição em Half
 * encolhendo o frame que serve de régua.
 *
 * A lógica está em `server.js` porque é lá que o arquivo é lido. Aqui ela é reescrita
 * contra os mesmos PNGs para travar o comportamento — e os PNGs são gerados a partir de
 * pixels de verdade, não de bytes fixos, para o teste continuar valendo se o codificador
 * mudar.
 */

import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

import { decodePng } from "../../core/src/png.js";

const inflate = (b) => new Uint8Array(zlib.inflateSync(Buffer.from(b)));

/** Monta um PNG RGBA sem filtro, do jeito mais simples que o formato permite. */
function png(width, height, pixelDe) {
  const bruto = Buffer.alloc(height * (1 + width * 4));
  let p = 0;

  for (let y = 0; y < height; y++) {
    bruto[p++] = 0; // filtro "none"
    for (let x = 0; x < width; x++) {
      const c = pixelDe(x, y);
      bruto[p++] = c[0];
      bruto[p++] = c[1];
      bruto[p++] = c[2];
      bruto[p++] = c.length > 3 ? c[3] : 255;
    }
  }

  const chunk = (tipo, dados) => {
    const tamanho = Buffer.alloc(4);
    tamanho.writeUInt32BE(dados.length);
    const corpo = Buffer.concat([Buffer.from(tipo, "latin1"), dados]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(corpo) : crc32(corpo));
    return Buffer.concat([tamanho, corpo, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(bruto)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** CRC-32 para o caso de o Node em uso não expor zlib.crc32. */
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (~c) >>> 0;
}

// As duas funções sob teste, iguais às de server.js.

function dimensoesPng(bytes) {
  if (!bytes || bytes.length < 24) return null;
  if (bytes.toString("latin1", 1, 4) !== "PNG") return null;
  if (bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function frameUniforme(bytes) {
  let img;
  try {
    img = decodePng(new Uint8Array(bytes), inflate);
  } catch {
    return null;
  }

  const d = img.data;
  if (d.length < 8) return null;

  for (let i = 4; i < d.length; i += 4) {
    if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2] || d[i + 3] !== d[3]) {
      return null;
    }
  }

  const hex = (v) => v.toString(16).padStart(2, "0");
  return d[3] === 0
    ? "totalmente transparente"
    : `de uma cor só (#${hex(d[0])}${hex(d[1])}${hex(d[2])})`;
}

test("frame preto inteiro é reconhecido como vazio", () => {
  // Foi este o caso real: a fila de render entregou quadro vazio, e a reconstrução saiu
  // escura porque a medição de cor respondeu "preto" com toda a coerência do mundo.
  const preto = png(40, 30, () => [0, 0, 0, 255]);

  assert.equal(frameUniforme(preto), "de uma cor só (#000000)");
});

test("frame totalmente transparente também, e é dito com outras palavras", () => {
  const vazio = png(20, 20, () => [0, 0, 0, 0]);

  assert.equal(frameUniforme(vazio), "totalmente transparente");
});

test("frame de cor sólida não-preta conta igual", () => {
  // Comp com só um fundo, ou camadas todas desligadas: o desenho não está lá.
  const bege = png(16, 16, () => [246, 244, 238, 255]);

  assert.match(frameUniforme(bege), /#f6f4ee/);
});

test("arte de verdade passa, mesmo com um único pixel diferente", () => {
  // A varredura sai no primeiro pixel diferente. Um único pixel distinto já é desenho,
  // e o limite tem que ser exatamente esse — qualquer tolerância aqui rejeitaria arte
  // legítima de fundo quase uniforme.
  const quaseVazio = png(64, 64, (x, y) => (x === 33 && y === 17 ? [255, 0, 0] : [10, 10, 10]));

  assert.equal(frameUniforme(quaseVazio), null);

  const desenho = png(64, 64, (x, y) => [x * 3, y * 3, 128]);
  assert.equal(frameUniforme(desenho), null);
});

test("as dimensões saem do IHDR sem decodificar a imagem", () => {
  // Decodificar um frame 4K inteiro para ler dois inteiros faria uma conferência barata
  // custar caro, e ela roda em todo save_frame.
  const arte = png(1920, 1080, (x, y) => [x & 255, y & 255, 64]);

  assert.deepEqual(dimensoesPng(arte), { width: 1920, height: 1080 });
});

test("o que não é PNG devolve null — 'não sei' não é 'está errado'", () => {
  assert.equal(dimensoesPng(Buffer.from("isto não é um png, nem de longe")), null);
  assert.equal(dimensoesPng(Buffer.alloc(0)), null);
  assert.equal(frameUniforme(Buffer.from("lixo")), null);
});

test("comp em Half é detectada pela divergência de tamanho", () => {
  // O seletor Full / Half / Third encolhe o frame exportado, e o frame exportado é a
  // régua de todas as medições feitas em cima dele. As medidas sairiam coerentes entre
  // si e erradas pelo mesmo fator.
  const metade = png(960, 540, (x, y) => [x & 255, y & 255, 64]);
  const medidas = dimensoesPng(metade);

  const comp = { width: 1920, height: 1080 };
  const divergente = medidas.width !== comp.width || medidas.height !== comp.height;

  assert.equal(divergente, true);
});
