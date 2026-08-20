/**
 * Remoção do fundo de um recorte.
 *
 * O recorte vem do frame de referência, então traz o fundo do frame junto. Colocado por
 * cima do cartão reconstruído, esse retângulo tapa o cartão — e o defeito parece de
 * posicionamento ou de ordem de camada, que é onde ninguém vai procurar.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CUTOUT_TOLERANCE,
  contentBounds,
  edgeColor,
  removeFlatBackground,
  trimTo,
} from "../src/cutout.js";

const FUNDO = [247, 245, 240];
const TINTA = [20, 20, 30];

/**
 * Imagem de fundo chapado com um retângulo de tinta no meio, e opcionalmente um miolo da
 * cor do fundo dentro dele — o caso que separa recorte utilizável de recorte com furos.
 */
function arte({ width = 21, height = 21, miolo = false } = {}) {
  const data = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dentro = x >= 6 && x <= 14 && y >= 6 && y <= 14;
      const noMiolo = miolo && x >= 9 && x <= 11 && y >= 9 && y <= 11;
      const cor = dentro && !noMiolo ? TINTA : FUNDO;

      const i = (y * width + x) * 4;
      data[i] = cor[0];
      data[i + 1] = cor[1];
      data[i + 2] = cor[2];
      data[i + 3] = 255;
    }
  }

  return { width, height, data };
}

const alfa = (img, x, y) => img.data[(y * img.width + x) * 4 + 3];

test("a cor do fundo é deduzida da borda", () => {
  const { hex, share } = edgeColor(arte());

  assert.equal(hex, "#f7f5f0");
  assert.equal(share, 1, "a borda inteira é fundo nesta imagem");
});

test("o fundo vira transparente e a arte fica intacta", () => {
  const r = removeFlatBackground(arte(), { feather: false });

  assert.equal(alfa(r, 0, 0), 0, "canto é fundo");
  assert.equal(alfa(r, 10, 10), 255, "o meio da forma continua opaco");
  assert.equal(r.color, "#f7f5f0");
  assert.ok(r.removed > 0);
});

test("área interna da cor do fundo NÃO é perfurada", () => {
  // ── O critério que faz a função existir ──────────────────────────────────────
  // Trocar toda ocorrência da cor do fundo por transparente perfura a ilustração: o
  // branco do tênis, o miolo de um ícone, qualquer área interna daquela cor virariam
  // buraco. O fundo é o que está CONECTADO À BORDA.
  const r = removeFlatBackground(arte({ miolo: true }), { feather: false });

  assert.equal(alfa(r, 0, 0), 0, "o fundo de fora saiu");
  assert.equal(alfa(r, 10, 10), 255, "o miolo cercado ficou");
});

test("a franja quase-fundo é atenuada, e o miolo da borda não", () => {
  // ── Que faixa o feather cobre, e por que essa ────────────────────────────────
  // A borda do desenho é suavizada contra o fundo, e esses pixels vão de "quase fundo"
  // até "quase tinta". Deixar os quase-fundo opacos produz uma auréola da cor do fundo
  // em volta da ilustração — escandalosa justamente sobre fundo diferente, que é onde o
  // recorte vai ser usado.
  //
  // Mas um pixel a meio caminho entre fundo e tinta é ARTE, não auréola: é o que faz a
  // borda parecer lisa em vez de serrilhada. Atenuar aquele também comeria a borda do
  // desenho. Então a faixa vai da tolerância até o triplo dela — a franja, não a borda
  // inteira.
  const mistura = (fracaoDeTinta) => [
    Math.round(FUNDO[0] + (TINTA[0] - FUNDO[0]) * fracaoDeTinta),
    Math.round(FUNDO[1] + (TINTA[1] - FUNDO[1]) * fracaoDeTinta),
    Math.round(FUNDO[2] + (TINTA[2] - FUNDO[2]) * fracaoDeTinta),
  ];

  const comColuna = (cor) => {
    const img = arte();
    for (let y = 6; y <= 14; y++) {
      const i = (y * img.width + 5) * 4;
      [img.data[i], img.data[i + 1], img.data[i + 2]] = cor;
    }
    return img;
  };

  const franja = comColuna(mistura(0.03));
  const suavizado = removeFlatBackground(franja, {});
  const cru = removeFlatBackground(franja, { feather: false });

  const alfaEm = (r) => r.data[(10 * r.width + 5) * 4 + 3];

  assert.equal(alfaEm(cru), 255, "sem feather a franja fica opaca");
  assert.ok(alfaEm(suavizado) < 255, "com feather ela fica parcialmente transparente");
  assert.ok(alfaEm(suavizado) > 0, "e não desaparece — ainda é parte da borda");

  // Meio caminho é borda de verdade e continua cheia.
  const borda = removeFlatBackground(comColuna(mistura(0.5)), {});
  assert.equal(alfaEm(borda), 255);
});

test("tolerância menor preserva mais, maior remove mais", () => {
  // Fundo com variação leve, como um JPEG ou um degradê discreto devolve.
  const img = arte();
  for (let x = 0; x < img.width; x++) {
    const i = (0 * img.width + x) * 4;
    img.data[i] += 6;
    img.data[i + 1] += 6;
  }

  const apertado = removeFlatBackground(img, { tolerance: 1, feather: false });
  const folgado = removeFlatBackground(img, { tolerance: 30, feather: false });

  assert.ok(folgado.removed > apertado.removed);
});

test("cor de fundo pode ser imposta em vez de deduzida", () => {
  // Recorte que pega mais borda de um elemento vizinho que de fundo faria a dedução
  // escolher a cor errada.
  const r = removeFlatBackground(arte(), { color: "#141420", tolerance: 10, feather: false });

  assert.equal(r.color, "#141420");
  assert.equal(alfa(r, 0, 0), 255, "o off-white não era o alvo, então ficou");
});

test("imagem inteira de uma cor só é removida por completo", () => {
  // Não é erro: é o sinal de que o recorte caiu fora da ilustração. Quem chama decide,
  // olhando a proporção removida.
  const width = 8;
  const height = 8;
  const data = new Uint8Array(width * height * 4).fill(255);
  const r = removeFlatBackground({ width, height, data }, { feather: false });

  assert.equal(r.removed, width * height);
});

test("a tolerância padrão está exposta, para quem chama poder explicar o número", () => {
  assert.equal(typeof DEFAULT_CUTOUT_TOLERANCE, "number");
  assert.ok(DEFAULT_CUTOUT_TOLERANCE > 0);
});

test("desenho encostando na borda é detectado — o recorte cortou a ilustração", () => {
  // ── Por que este aviso vale mais que a maioria ───────────────────────────────
  // O arquivo abre, tem a ilustração dentro, o fundo saiu direito. Só de perto se vê que
  // falta um pedaço — e a essa altura a cena já está montada. Aconteceu com um tênis.
  const width = 12;
  const height = 12;
  const data = new Uint8Array(width * height * 4);

  // Fundo chapado com a forma indo até a borda direita: o desenho continua além.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const forma = y >= 4 && y <= 8 && x >= 6;
      const cor = forma ? [20, 20, 30] : [247, 245, 240];
      data[i] = cor[0];
      data[i + 1] = cor[1];
      data[i + 2] = cor[2];
      data[i + 3] = 255;
    }
  }

  const semFundo = removeFlatBackground({ width, height, data }, { feather: false });
  const caixa = contentBounds(semFundo);

  assert.deepEqual(caixa.touches, ["direita"]);
  assert.equal(caixa.empty, false);
});

test("desenho folgado não acusa corte", () => {
  const semFundo = removeFlatBackground(arte(), { feather: false });
  const caixa = contentBounds(semFundo);

  assert.deepEqual(caixa.touches, []);
  assert.equal(caixa.x, 6, "a caixa acha a forma onde ela está");
  assert.equal(caixa.width, 9);
});

test("trim aperta na ilustração e devolve a posição certa", () => {
  // Medir com folga é o certo — folga se tira, corte não se recupera. Mas as coordenadas
  // que vão para a cena têm que ser as apertadas, senão a ilustração fica deslocada.
  const semFundo = removeFlatBackground(arte(), { feather: false });
  const caixa = contentBounds(semFundo);
  const apertado = trimTo(semFundo, caixa);

  assert.equal(apertado.width, 9);
  assert.equal(apertado.height, 9);
  assert.notEqual(apertado.data[3], 0, "o canto do recorte apertado já é desenho");
});

test("recorte sem nenhum desenho é reportado como vazio, não como corte", () => {
  const width = 6;
  const height = 6;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = 247;
    data[i * 4 + 1] = 245;
    data[i * 4 + 2] = 240;
    data[i * 4 + 3] = 255;
  }

  const caixa = contentBounds(removeFlatBackground({ width, height, data }, { feather: false }));

  assert.equal(caixa.empty, true);
  assert.deepEqual(caixa.touches, []);
});
