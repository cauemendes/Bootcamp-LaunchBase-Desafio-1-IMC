/**
 * Compara duas imagens do mesmo tamanho e diz onde elas diferem.
 *
 * ── Por que medir, em vez de olhar ────────────────────────────────────────────
 * Olhar duas imagens lado a lado responde bem "está parecido?" e mal "o que falta?".
 * Cor errada num elemento pequeno, ilustração deslocada em vinte pixels, texto que saiu
 * regular em vez de bold — nada disso salta numa comparação de tela, e tudo isso é
 * exatamente o que apareceu nas reconstruções reais deste projeto.
 *
 * A saída é um número e um mapa. O número diz se vale investigar; o mapa diz onde, o que
 * é a diferença entre "a cena está diferente" e "o canto superior esquerdo está diferente
 * e o resto bate".
 *
 * ── Por que blocos, e não uma caixa ───────────────────────────────────────────
 * Uma caixa em volta de tudo o que difere quase sempre cobre a imagem inteira: basta um
 * pixel diferente em dois cantos opostos. Uma grade grosseira sobrevive a isso e continua
 * apontando o lugar.
 */

import { colorDistance, rgb255ToHex } from "./color.js";

export class CompareError extends Error {
  constructor(message) {
    super(message);
    this.name = "CompareError";
  }
}

/** Diferença de cor abaixo disto é compressão e suavização, não erro de reconstrução. */
export const DEFAULT_COMPARE_TOLERANCE = 12;

const DEFAULT_GRID = 6;

/**
 * @param {{width, height, data: Uint8Array}} a
 * @param {{width, height, data: Uint8Array}} b
 * @param {Object} [opts]
 * @param {number} [opts.tolerance]  distância de cor que ainda conta como igual
 * @param {number} [opts.grid]       divisões por eixo no mapa de blocos
 * @returns {{differing, total, ratio, blocks, worst}}
 */
export function compareImages(a, b, opts = {}) {
  if (!a?.data || !b?.data) throw new CompareError("compareImages precisa de duas imagens.");

  if (a.width !== b.width || a.height !== b.height) {
    throw new CompareError(
      `As imagens têm tamanhos diferentes: ${a.width}×${a.height} e ${b.width}×${b.height}. ` +
        "Comparar exige o mesmo tamanho — provavelmente uma delas foi renderizada com a " +
        "resolução da composição em Half, ou é de outra comp."
    );
  }

  const tolerance = Number.isFinite(opts.tolerance) ? opts.tolerance : DEFAULT_COMPARE_TOLERANCE;
  const divisoes = Number.isInteger(opts.grid) && opts.grid > 0 ? opts.grid : DEFAULT_GRID;

  const { width, height } = a;
  const larguraBloco = Math.ceil(width / divisoes);
  const alturaBloco = Math.ceil(height / divisoes);

  const contagem = new Array(divisoes * divisoes).fill(0);
  const totalBloco = new Array(divisoes * divisoes).fill(0);
  const mapa = new Uint8Array(width * height);

  let differing = 0;

  for (let y = 0; y < height; y++) {
    const bloco = Math.min(divisoes - 1, Math.floor(y / alturaBloco)) * divisoes;

    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const b1 = bloco + Math.min(divisoes - 1, Math.floor(x / larguraBloco));
      totalBloco[b1]++;

      // Alfa entra na conta: uma ilustração com fundo onde devia haver transparência é
      // diferença que a cor sozinha não pega.
      const dAlfa = Math.abs(a.data[i + 3] - b.data[i + 3]);

      const dCor = colorDistance(
        rgb255ToHex({ r: a.data[i], g: a.data[i + 1], b: a.data[i + 2] }),
        rgb255ToHex({ r: b.data[i], g: b.data[i + 1], b: b.data[i + 2] })
      );

      if (dCor <= tolerance && dAlfa <= tolerance) continue;

      differing++;
      contagem[b1]++;
      mapa[y * width + x] = 1;
    }
  }

  const blocks = contagem.map((n, i) => {
    const bx = i % divisoes;
    const by = (i - bx) / divisoes;
    return {
      x: bx * larguraBloco,
      y: by * alturaBloco,
      width: Math.min(larguraBloco, width - bx * larguraBloco),
      height: Math.min(alturaBloco, height - by * alturaBloco),
      ratio: totalBloco[i] ? n / totalBloco[i] : 0,
    };
  });

  const worst = blocks.reduce((melhor, bloco) => (bloco.ratio > melhor.ratio ? bloco : melhor), blocks[0]);

  return {
    differing,
    total: width * height,
    ratio: differing / (width * height),
    blocks,
    worst,
    map: mapa,
  };
}

/**
 * Imagem que mostra a diferença: o resultado esmaecido, com o que difere em vermelho.
 *
 * Um mapa preto e branco diria onde sem dizer o quê. Manter a imagem por baixo é o que
 * permite reconhecer o elemento errado só de olhar.
 */
export function differenceImage(b, resultado) {
  const { width, height } = b;
  const data = new Uint8Array(width * height * 4);

  for (let p = 0; p < width * height; p++) {
    const i = p * 4;

    if (resultado.map[p]) {
      data[i] = 255;
      data[i + 1] = 40;
      data[i + 2] = 40;
      data[i + 3] = 255;
      continue;
    }

    // Esmaecido para o vermelho saltar sem esconder o contexto.
    data[i] = 200 + Math.round(b.data[i] * 0.2);
    data[i + 1] = 200 + Math.round(b.data[i + 1] * 0.2);
    data[i + 2] = 200 + Math.round(b.data[i + 2] * 0.2);
    data[i + 3] = 255;
  }

  return { width, height, data };
}
