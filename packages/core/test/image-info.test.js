import test from "node:test";
import assert from "node:assert/strict";

import { readImageInfo, toBase64 } from "../src/image-info.js";

/** PNG mínimo: assinatura + IHDR com as dimensões pedidas. */
function makePng(width, height) {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false);             // tamanho do chunk IHDR
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);  // "IHDR"
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

/** JPEG mínimo: SOI, um APP0 pra ser pulado, depois SOF0 com as dimensões. */
function makeJpeg(width, height) {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  bytes.set([0xff, 0xd8], 0);               // SOI
  bytes.set([0xff, 0xe0], 2);               // APP0
  view.setUint16(4, 8, false);              // tamanho do APP0 (inclui os 2 bytes)
  bytes.set([0xff, 0xc0], 12);              // SOF0
  view.setUint16(14, 11, false);            // tamanho do segmento
  bytes[16] = 8;                            // precisão
  view.setUint16(17, height, false);
  view.setUint16(19, width, false);
  return bytes;
}

function makeGif(width, height) {
  const bytes = new Uint8Array(24);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // "GIF89a"
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

test("lê dimensões de PNG", () => {
  const info = readImageInfo(makePng(1920, 1080));
  assert.equal(info.format, "png");
  assert.equal(info.mediaType, "image/png");
  assert.equal(info.width, 1920);
  assert.equal(info.height, 1080);
});

test("lê dimensões de JPEG pulando o segmento APP0", () => {
  const info = readImageInfo(makeJpeg(800, 600));
  assert.equal(info.format, "jpeg");
  assert.equal(info.mediaType, "image/jpeg");
  assert.equal(info.width, 800);
  assert.equal(info.height, 600);
});

test("lê dimensões de GIF (little-endian, diferente do PNG)", () => {
  const info = readImageInfo(makeGif(320, 240));
  assert.equal(info.format, "gif");
  assert.equal(info.width, 320);
  assert.equal(info.height, 240);
});

test("formato desconhecido dá mensagem acionável", () => {
  const lixo = new Uint8Array(64).fill(0x41);
  assert.throws(() => readImageInfo(lixo), /não reconhecido/);
});

test("arquivo truncado é recusado antes de ler fora dos limites", () => {
  assert.throws(() => readImageInfo(new Uint8Array(4)), /curto demais/);
});

test("readImageInfo exige Uint8Array", () => {
  assert.throws(() => readImageInfo("um png, prometo"), /Uint8Array/);
});

test("toBase64 bate com a implementação de referência do Node", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString("base64"));
});

test("toBase64 aguenta um payload grande sem estourar o limite de argumentos", () => {
  // O caminho sem Buffer usa String.fromCharCode.apply, que quebra com arrays
  // grandes se não for feito em blocos. Uma imagem de verdade tem esse tamanho.
  const bytes = new Uint8Array(300_000).map((_, i) => i % 256);
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString("base64"));
});
