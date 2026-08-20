/**
 * Codificação e recorte de PNG.
 *
 * Existe porque há coisa que não se reconstrói com formas. Um tênis desenhado à mão, um
 * braço robótico com garra: dezenas de curvas e sombreados sobrepostos. Medir primitivas
 * numa dessas produz um borrão de formas coloridas — pior que honesto, porque parece
 * tentativa. Recortar os pixels originais e reconstruir com formas só o resto entrega as
 * duas coisas: a ilustração fiel e a interface editável.
 */

import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

import { decodePng } from "../src/png.js";
import { PngEncodeError, cropImage, encodePng } from "../src/png-encode.js";

const deflate = (b) => new Uint8Array(zlib.deflateSync(Buffer.from(b)));
const inflate = (b) => new Uint8Array(zlib.inflateSync(Buffer.from(b)));

/** Imagem com um valor previsível por pixel, para conferir posição depois do recorte. */
function imagem(width, height) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = x & 255;
      data[i + 1] = y & 255;
      data[i + 2] = (x + y) & 255;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

test("codificar e decodificar devolve os mesmos pixels", () => {
  const original = imagem(37, 19);
  const png = encodePng(original, deflate);
  const volta = decodePng(png, inflate);

  assert.equal(volta.width, 37);
  assert.equal(volta.height, 19);
  assert.deepEqual(Buffer.from(volta.data), Buffer.from(original.data));
});

test("o arquivo gerado é um PNG de verdade, com assinatura e IHDR", () => {
  const png = Buffer.from(encodePng(imagem(4, 4), deflate));

  assert.equal(png.toString("latin1", 1, 4), "PNG");
  assert.equal(png.toString("latin1", 12, 16), "IHDR");
  assert.equal(png.readUInt32BE(16), 4);
  assert.equal(png.readUInt32BE(20), 4);
  assert.ok(png.includes(Buffer.from("IEND")));
});

test("recorte devolve exatamente a região pedida", () => {
  const img = imagem(20, 20);
  const r = cropImage(img, { x: 5, y: 7, width: 6, height: 4 });

  assert.equal(r.width, 6);
  assert.equal(r.height, 4);
  assert.equal(r.x, 5);
  assert.equal(r.y, 7);

  // Primeiro pixel do recorte é o (5,7) do original — se estiver deslocado, a ilustração
  // entra fora de lugar na cena e o erro parece de posicionamento.
  assert.equal(r.data[0], 5);
  assert.equal(r.data[1], 7);

  // E o último é o (10,10).
  const ultimo = (r.height - 1) * r.width * 4 + (r.width - 1) * 4;
  assert.equal(r.data[ultimo], 10);
  assert.equal(r.data[ultimo + 1], 10);
});

test("recorte que passa da borda é aparado, não recusado", () => {
  // Uma medição feita em cima de um frame quase sempre erra alguns pixels na borda.
  // Falhar por isso obrigaria a ajustar o retângulo no chute.
  const img = imagem(10, 10);
  const r = cropImage(img, { x: 6, y: 6, width: 999, height: 999 });

  assert.equal(r.width, 4);
  assert.equal(r.height, 4);
});

test("coordenada negativa é aparada para dentro", () => {
  const r = cropImage(imagem(10, 10), { x: -5, y: -5, width: 8, height: 8 });

  assert.equal(r.x, 0);
  assert.equal(r.y, 0);
  assert.equal(r.width, 3, "a parte que sobra depois de cortar o que estava fora");
});

test("recorte fora da imagem é erro, com os números na mensagem", () => {
  // Erro aqui quase sempre é coordenada medida em outra escala. Dizer os dois tamanhos é
  // o que permite perceber isso sem abrir a imagem.
  assert.throws(
    () => cropImage(imagem(10, 10), { x: 50, y: 50, width: 10, height: 10 }),
    (e) => e instanceof PngEncodeError && /10×10/.test(e.message)
  );
});

test("o recorte gravado volta a ser lido com os pixels certos", () => {
  // O caminho completo: decodifica, recorta, codifica, decodifica de novo. É o que
  // acontece de verdade quando uma ilustração sai do frame para uma camada do AE.
  const original = imagem(30, 30);
  const r = cropImage(original, { x: 10, y: 10, width: 5, height: 5 });
  const volta = decodePng(encodePng(r, deflate), inflate);

  assert.equal(volta.width, 5);
  assert.deepEqual(Buffer.from(volta.data), Buffer.from(r.data));
  assert.equal(volta.data[0], 10, "o canto do recorte continua sendo o (10,10) original");
});

test("encodePng recusa dados de tamanho errado em vez de gravar lixo", () => {
  assert.throws(
    () => encodePng({ width: 4, height: 4, data: new Uint8Array(10) }, deflate),
    (e) => e instanceof PngEncodeError && /64/.test(e.message)
  );
});

test("encodePng exige a função deflate — o core não conhece zlib", () => {
  assert.throws(() => encodePng(imagem(2, 2)), PngEncodeError);
});
