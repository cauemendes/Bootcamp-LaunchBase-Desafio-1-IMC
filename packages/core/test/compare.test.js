/**
 * Comparação entre a referência e o que foi reconstruído.
 *
 * Existe porque olhar as duas imagens responde bem "está parecido?" e mal "o que falta?".
 * Cor errada num elemento pequeno, ilustração deslocada, texto que saiu regular em vez de
 * bold — nada disso salta numa comparação de tela, e é tudo o que saiu errado nas
 * reconstruções reais deste projeto.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CompareError, compareImages, differenceImage } from "../src/compare.js";

const imagem = (width, height, pixel) => {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const c = pixel(x, y);
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = c.length > 3 ? c[3] : 255;
    }
  }
  return { width, height, data };
};

const CLARO = [240, 240, 240];
const ESCURO = [10, 10, 10];

test("imagens idênticas não diferem", () => {
  const a = imagem(30, 30, (x, y) => (x < 10 ? ESCURO : CLARO));
  const b = imagem(30, 30, (x, y) => (x < 10 ? ESCURO : CLARO));

  const r = compareImages(a, b);
  assert.equal(r.differing, 0);
  assert.equal(r.ratio, 0);
});

test("diferença dentro da tolerância não conta", () => {
  // Compressão e suavização mudam alguns valores em todo pixel. Contar isso como erro
  // faria toda comparação parecer catástrofe e ninguém olharia o número de novo.
  const a = imagem(20, 20, () => [200, 200, 200]);
  const b = imagem(20, 20, () => [202, 201, 203]);

  assert.equal(compareImages(a, b).differing, 0);
});

test("o mapa aponta onde a diferença se concentra", () => {
  // É a parte que importa: "a cena está diferente" não ajuda; "o canto superior esquerdo
  // está diferente e o resto bate" manda para o elemento errado.
  const a = imagem(60, 60, () => CLARO);
  const b = imagem(60, 60, (x, y) => (x < 15 && y < 15 ? ESCURO : CLARO));

  const r = compareImages(a, b);

  assert.ok(r.ratio > 0.05);
  assert.equal(r.worst.x, 0);
  assert.equal(r.worst.y, 0);
  assert.equal(r.worst.ratio, 1, "o bloco do canto difere inteiro");

  // E os blocos longe do canto não acusam nada.
  const longe = r.blocks.find((bl) => bl.x > 30 && bl.y > 30);
  assert.equal(longe.ratio, 0);
});

test("alfa diferente conta como diferença", () => {
  // Ilustração com fundo onde devia haver transparência é erro que a cor sozinha não
  // pega: os dois pixels podem ter exatamente a mesma cor.
  const a = imagem(10, 10, () => [255, 255, 255, 0]);
  const b = imagem(10, 10, () => [255, 255, 255, 255]);

  assert.equal(compareImages(a, b).differing, 100);
});

test("tamanhos diferentes é erro que explica a causa provável", () => {
  // A causa quase sempre é a resolução da composição em Half, ou comparar com a comp
  // errada. Dizer isso poupa a rodada de investigação.
  assert.throws(
    () => compareImages(imagem(10, 10, () => CLARO), imagem(20, 20, () => CLARO)),
    (e) => e instanceof CompareError && /Half/.test(e.message)
  );
});

test("a imagem de diferença marca o que difere e mantém o contexto", () => {
  // Um mapa preto e branco diria onde sem dizer o quê. Manter a imagem por baixo é o que
  // permite reconhecer o elemento errado só de olhar.
  const a = imagem(20, 20, () => CLARO);
  const b = imagem(20, 20, (x) => (x < 5 ? ESCURO : CLARO));

  const diff = differenceImage(b, compareImages(a, b));

  const em = (x, y) => {
    const i = (y * 20 + x) * 4;
    return [diff.data[i], diff.data[i + 1], diff.data[i + 2]];
  };

  assert.deepEqual(em(2, 10), [255, 40, 40], "o que difere sai vermelho");

  const igual = em(15, 10);
  assert.ok(igual[0] > 200 && igual[1] > 200, "o resto fica esmaecido, não preto");
  assert.notDeepEqual(igual, [255, 40, 40]);
});

test("grade mais fina localiza melhor, sem mudar o total", () => {
  const a = imagem(60, 60, () => CLARO);
  const b = imagem(60, 60, (x, y) => (x < 6 && y < 6 ? ESCURO : CLARO));

  const grosso = compareImages(a, b, { grid: 2 });
  const fino = compareImages(a, b, { grid: 10 });

  assert.equal(grosso.differing, fino.differing);
  assert.ok(fino.worst.ratio > grosso.worst.ratio, "a grade fina isola melhor a região");
});

test("tom errado em área grande: muita área, nenhuma estrutura", () => {
  // ── A inversão que motivou a segunda medida ──────────────────────────────────
  // Numa comparação real de quatro cenas, a que o designer considerou boa marcou 21% de
  // área e a que ele considerou horrível marcou 13%. A ordem do número era o inverso da
  // ordem da qualidade, porque área pesa tamanho e os defeitos graves eram pequenos.
  const ref = imagem(100, 100, (x, y) => (y < 50 ? [80, 80, 200] : CLARO));
  const tomErrado = imagem(100, 100, (x, y) => (y < 50 ? [110, 110, 215] : CLARO));

  const r = compareImages(ref, tomErrado);

  assert.ok(r.ratio > 0.4, "metade da imagem tem o tom trocado");
  assert.equal(r.edgeRatio, 0, "o desenho é o mesmo: nenhuma borda mudou");
});

test("detalhe pequeno faltando: pouca área, muita estrutura", () => {
  // Um número que falta dentro de um selo, um ícone trocado. Poucos pixels, e é o erro
  // que uma pessoa nota primeiro.
  const dentro = (x, y) => x > 70 && x < 80 && y > 70 && y < 80;

  const ref = imagem(100, 100, (x, y) => (dentro(x, y) ? ESCURO : CLARO));
  const semDetalhe = imagem(100, 100, () => CLARO);

  const r = compareImages(ref, semDetalhe);

  assert.ok(r.ratio < 0.02, "quase nada da área mudou");
  assert.ok(r.edgeRatio > 0.2, "mas as bordas daquele detalhe sumiram");
});

test("as duas medidas em zero quando as imagens são iguais", () => {
  const a = imagem(40, 40, (x, y) => (x < 20 ? ESCURO : CLARO));

  const r = compareImages(a, imagem(40, 40, (x, y) => (x < 20 ? ESCURO : CLARO)));
  assert.equal(r.ratio, 0);
  assert.equal(r.edgeRatio, 0);
});
