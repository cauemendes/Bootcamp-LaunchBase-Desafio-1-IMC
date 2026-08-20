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
  CutoutError,
  DEFAULT_CUTOUT_TOLERANCE,
  contentBounds,
  edgeColor,
  isolateComponent,
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

/** Ilustração e um vizinho da MESMA cor, separados por fundo. */
function comVizinho() {
  const width = 21;
  const height = 11;
  const data = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ilustracao = x >= 2 && x <= 7 && y >= 3 && y <= 7;
      const vizinho = x >= 13 && x <= 18 && y >= 3 && y <= 7;
      const cor = ilustracao || vizinho ? TINTA : FUNDO;

      const i = (y * width + x) * 4;
      data[i] = cor[0];
      data[i + 1] = cor[1];
      data[i + 2] = cor[2];
      data[i + 3] = 255;
    }
  }

  return { width, height, data };
}

test("isolar por conectividade descarta vizinho da mesma cor", () => {
  // ── O caso que só isto resolve ───────────────────────────────────────────────
  // Retângulo separa o que está separado. Quando a ilustração encosta em outro elemento,
  // não existe retângulo certo: com folga leva o vizinho, apertado corta a ilustração.
  // E remover por cor falha do jeito pior quando o vizinho tem a mesma tinta — o caso
  // comum numa arte de paleta fechada. O que separa é estar ligado a um ponto de dentro.
  const semFundo = removeFlatBackground(comVizinho(), { feather: false });
  const iso = isolateComponent(semFundo, { x: 4, y: 5 });

  const alfaEm = (x, y) => iso.data[(y * iso.width + x) * 4 + 3];

  assert.equal(alfaEm(4, 5), 255, "a ilustração ficou");
  assert.equal(alfaEm(15, 5), 0, "o vizinho da mesma cor saiu");
  assert.equal(iso.kept, 30);
  assert.equal(iso.removed, 30);
});

test("semente em pixel transparente é erro que diz o que fazer", () => {
  // Errar a semente é o normal: ela é apontada olhando a imagem. O erro tem que dizer
  // que caiu no fundo, senão parece defeito da ferramenta.
  const semFundo = removeFlatBackground(comVizinho(), { feather: false });

  assert.throws(
    () => isolateComponent(semFundo, { x: 10, y: 5 }),
    (e) => e instanceof CutoutError && /transparente/.test(e.message)
  );
});

test("semente fora do recorte é erro com os dois tamanhos", () => {
  const semFundo = removeFlatBackground(comVizinho(), { feather: false });

  assert.throws(
    () => isolateComponent(semFundo, { x: 500, y: 5 }),
    (e) => e instanceof CutoutError && /21×11/.test(e.message)
  );
});

test("isolar antes de tirar o fundo não separa nada", () => {
  // Roda sobre o alfa. Antes do fundo sair, a imagem é um bloco opaco só e tudo está
  // conectado a tudo — inclusive pelo fundo. Deixar isso implícito faria a ferramenta
  // parecer quebrada quando a ordem fosse invertida.
  const iso = isolateComponent(comVizinho(), { x: 4, y: 5 });

  assert.equal(iso.removed, 0, "nada foi descartado: tudo estava conectado");
  assert.equal(iso.kept, 21 * 11);
});

test("duas partes da mesma ilustração ligadas por um traço fino ficam juntas", () => {
  // Conectividade é o critério, então um fio de um pixel basta para manter duas massas
  // juntas — o que é o comportamento certo: numa ilustração, o que se toca é a mesma
  // coisa.
  const img = comVizinho();
  for (let x = 8; x <= 12; x++) {
    const i = (5 * img.width + x) * 4;
    img.data[i] = TINTA[0];
    img.data[i + 1] = TINTA[1];
    img.data[i + 2] = TINTA[2];
  }

  const iso = isolateComponent(removeFlatBackground(img, { feather: false }), { x: 4, y: 5 });

  assert.equal(iso.data[(5 * img.width + 15) * 4 + 3], 255, "o vizinho agora está ligado");
});

test("partes ligadas só pela quina ficam juntas — 8-conectividade é o padrão", () => {
  // ── Por que este teste existe ────────────────────────────────────────────────
  // Com 4-conectividade, dois pedaços do mesmo desenho que se tocam apenas pela quina
  // contam como coisas separadas. Num traço fino diagonal — laço de tênis, cabo, contorno
  // inclinado de um pixel — a ligação entre partes é frequentemente só diagonal, e o
  // resultado seria jogar metade da ilustração fora.
  //
  // O erro simétrico existe: um vizinho que encosta de canto vem junto. Mas trazer uma
  // lasca a mais é visível e se apaga; perder metade do desenho passa por "a ilustração é
  // assim mesmo".
  const width = 9;
  const height = 9;
  const data = new Uint8Array(width * height * 4);

  const pintar = (x, y, cor) => {
    const i = (y * width + x) * 4;
    data[i] = cor[0];
    data[i + 1] = cor[1];
    data[i + 2] = cor[2];
    data[i + 3] = 255;
  };

  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pintar(x, y, FUNDO);

  // Dois blocos 2×2 encostando só pela diagonal: (2,2)-(3,3) e (4,4)-(5,5).
  for (let y = 2; y <= 3; y++) for (let x = 2; x <= 3; x++) pintar(x, y, TINTA);
  for (let y = 4; y <= 5; y++) for (let x = 4; x <= 5; x++) pintar(x, y, TINTA);

  const semFundo = removeFlatBackground({ width, height, data }, { feather: false });
  const alfaEm = (r, x, y) => r.data[(y * width + x) * 4 + 3];

  const padrao = isolateComponent(semFundo, { x: 2, y: 2 });
  assert.equal(alfaEm(padrao, 5, 5), 255, "o padrão mantém a parte ligada pela quina");

  const apertado = isolateComponent(semFundo, { x: 2, y: 2 }, { connectivity: 4 });
  assert.equal(alfaEm(apertado, 5, 5), 0, "com 4 ela é descartada");
});
