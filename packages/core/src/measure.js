/**
 * Medir uma imagem de referência: cor, extensão de forma, raio de canto.
 *
 * ── O problema que isto resolve ───────────────────────────────────────────────
 * Reconstruir design a partir de imagem exige número, não impressão. Duas coisas
 * ficaram evidentes na primeira reconstrução real:
 *
 * Amostrar um pixel só quase sempre erra. Bordas são suavizadas, e um clique a dois
 * pixels da borda devolve uma mistura que não existe no design — foi o que fez o
 * primeiro sampler reportar cores que não estavam na paleta. Por isso `sampleColor`
 * amostra um bloco e devolve a cor dominante junto com o quanto ela domina: 1.0
 * significa área chapada, 0.4 significa que a amostra caiu em cima de uma borda e o
 * número não vale nada.
 *
 * E forma de design raramente é regular. Medindo um card real, os cantos superiores
 * tinham raios de 172px e 114px — o contorno fora desenhado à mão. Quem assume um
 * retângulo arredondado uniforme erra justamente na silhueta, que é o que o olho
 * compara primeiro. Por isso `measureRegion` mede os quatro cantos separados.
 */

import { colorDistance, rgb255ToHex } from "./color.js";

/** Distância de cor abaixo da qual dois pixels são "a mesma cor com ruído". */
export const DEFAULT_TOLERANCE = 12;

function pixel(img, x, y) {
  const i = (y * img.width + x) * 4;
  return { r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: img.data[i + 3] };
}

function dentro(img, x, y) {
  return x >= 0 && y >= 0 && x < img.width && y < img.height;
}

function exigirDentro(img, x, y) {
  if (!dentro(img, x, y)) {
    throw new RangeError(
      `(${x}, ${y}) está fora da imagem de ${img.width}×${img.height}.`
    );
  }
}

/**
 * A cor dominante num bloco centrado em (x, y).
 *
 * @returns {{hex: string, alpha: number, uniformity: number, samples: number}}
 *   `uniformity` é a fração do bloco que tem a cor dominante. Perto de 1 a amostra
 *   caiu em área chapada e o hex vale; abaixo de ~0.8 ela pegou borda, gradiente ou
 *   textura, e o valor é uma média sem significado no design.
 */
export function sampleColor(img, x, y, { radius = 3, tolerance = DEFAULT_TOLERANCE } = {}) {
  exigirDentro(img, x, y);

  const contagem = new Map();
  let alphaTotal = 0;
  let total = 0;

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const px = x + dx;
      const py = y + dy;
      if (!dentro(img, px, py)) continue;

      const p = pixel(img, px, py);
      const hex = rgb255ToHex(p);
      contagem.set(hex, (contagem.get(hex) ?? 0) + 1);
      alphaTotal += p.a;
      total++;
    }
  }

  let dominante = null;
  let melhor = 0;
  for (const [hex, n] of contagem) {
    if (n > melhor) {
      melhor = n;
      dominante = hex;
    }
  }

  // Tons quase idênticos contam a favor da dominante: compressão com perdas espalha
  // uma área chapada em dezenas de valores vizinhos, e contá-los como divergência
  // faria toda amostra de JPEG parecer não confiável.
  let proximos = 0;
  for (const [hex, n] of contagem) {
    if (colorDistance(hex, dominante) <= tolerance) proximos += n;
  }

  return {
    hex: dominante,
    alpha: Math.round(alphaTotal / total),
    uniformity: Number((proximos / total).toFixed(3)),
    samples: total,
  };
}

/**
 * A região contígua da mesma cor que contém (x, y).
 *
 * Preenchimento por inundação a partir da semente, iterativo — recursivo estoura a
 * pilha numa área grande de 1920×1080.
 *
 * @returns {{color, bounds, pixelCount, corners, edgeRows}}
 */
export function measureRegion(img, x, y, { tolerance = DEFAULT_TOLERANCE } = {}) {
  exigirDentro(img, x, y);

  const alvo = pixel(img, x, y);
  const alvoHex = rgb255ToHex(alvo);
  const visto = new Uint8Array(img.width * img.height);
  const pilha = [x, y];

  let minX = x;
  let maxX = x;
  let minY = y;
  let maxY = y;
  let contagem = 0;

  // Extremos horizontais por linha: é o que permite medir raio de canto depois sem
  // guardar a máscara inteira.
  const esquerda = new Int32Array(img.height).fill(-1);
  const direita = new Int32Array(img.height).fill(-1);

  while (pilha.length) {
    const py = pilha.pop();
    const px = pilha.pop();

    if (!dentro(img, px, py)) continue;

    const indice = py * img.width + px;
    if (visto[indice]) continue;

    const p = pixel(img, px, py);
    if (p.a !== alvo.a && Math.abs(p.a - alvo.a) > 8) continue;
    if (colorDistance(rgb255ToHex(p), alvoHex) > tolerance) continue;

    visto[indice] = 1;
    contagem++;

    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;

    if (esquerda[py] === -1 || px < esquerda[py]) esquerda[py] = px;
    if (direita[py] === -1 || px > direita[py]) direita[py] = px;

    pilha.push(px + 1, py, px - 1, py, px, py + 1, px, py - 1);
  }

  const bounds = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };

  return {
    color: alvoHex,
    alpha: alvo.a,
    bounds,
    pixelCount: contagem,
    // Quanto do retângulo delimitador a região preenche. Perto de 1 é retângulo;
    // bem abaixo indica forma recortada, e aí `rect` seria a primitiva errada.
    fill: Number((contagem / (bounds.width * bounds.height)).toFixed(3)),
    corners: cantos(bounds, esquerda, direita),
  };
}

/**
 * Raio de cada canto, medido em vez de assumido.
 *
 * Num retângulo de cantos arredondados, o primeiro pixel da linha do topo já está
 * deslocado do canto exatamente pelo raio. Comparar os quatro é o que revela contorno
 * desenhado à mão — e aí a escolha certa deixa de ser `rect` e passa a ser `path`.
 */
function cantos(bounds, esquerda, direita) {
  const topo = bounds.y;
  const base = bounds.y + bounds.height - 1;
  const fim = bounds.x + bounds.width - 1;

  const medir = (linha, lado) => {
    const valor = lado === "esq" ? esquerda[linha] : direita[linha];
    if (valor === -1) return null;
    return lado === "esq" ? valor - bounds.x : fim - valor;
  };

  return {
    topLeft: medir(topo, "esq"),
    topRight: medir(topo, "dir"),
    bottomLeft: medir(base, "esq"),
    bottomRight: medir(base, "dir"),
  };
}

/**
 * As transições de cor ao longo de uma linha reta.
 *
 * É como se acha a borda de uma forma sem adivinhar: varre e reporta onde a cor
 * mudou. Trechos curtos são descartados porque uma borda suavizada produz uma
 * escadinha de tons intermediários que não são cores do design — reportá-los
 * afogaria as transições reais em ruído.
 *
 * @param {"horizontal"|"vertical"} axis
 * @param {number} at   y da linha (horizontal) ou x da coluna (vertical)
 */
export function scanLine(img, axis, at, {
  from = 0,
  to = null,
  tolerance = DEFAULT_TOLERANCE,
  minRun = 3,
} = {}) {
  const horizontal = axis === "horizontal";
  const limite = horizontal ? img.width : img.height;
  const fim = to == null ? limite - 1 : Math.min(to, limite - 1);

  if (horizontal ? !dentro(img, 0, at) : !dentro(img, at, 0)) {
    throw new RangeError(`${axis} em ${at} está fora da imagem de ${img.width}×${img.height}.`);
  }

  const corEm = (i) => (horizontal ? pixel(img, i, at) : pixel(img, at, i));

  const trechos = [];
  let inicio = from;
  let atual = rgb255ToHex(corEm(from));

  for (let i = from + 1; i <= fim; i++) {
    const hex = rgb255ToHex(corEm(i));
    if (colorDistance(hex, atual) <= tolerance) continue;

    trechos.push({ start: inicio, end: i - 1, length: i - inicio, color: atual });
    inicio = i;
    atual = hex;
  }
  trechos.push({ start: inicio, end: fim, length: fim - inicio + 1, color: atual });

  const significativos = trechos.filter((t) => t.length >= minRun);

  return {
    axis,
    at,
    runs: significativos,
    edges: significativos.slice(1).map((t, i) => ({
      at: t.start,
      from: significativos[i].color,
      to: t.color,
    })),
    discardedRuns: trechos.length - significativos.length,
  };
}
