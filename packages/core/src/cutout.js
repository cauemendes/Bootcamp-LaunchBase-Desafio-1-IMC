/**
 * Tira o fundo de um recorte, deixando a ilustração com alfa.
 *
 * ── Por que isto é necessário e não conforto ──────────────────────────────────
 * O recorte vem do frame de referência, então ele traz o fundo do frame junto — o
 * off-white da arte, normalmente. Colocado por cima do cartão reconstruído, esse
 * retângulo tapa o cartão. A ilustração aparece dentro de uma caixa da cor errada, e o
 * defeito parece de posicionamento ou de ordem de camada, que é onde ninguém vai achar.
 *
 * ── Por que preenchimento a partir da borda, e não "cor igual à do fundo" ─────
 * Trocar toda ocorrência da cor do fundo por transparente perfura a ilustração: o branco
 * do tênis, o miolo de um ícone, qualquer área interna daquela cor virariam buraco. O
 * fundo é o que está **conectado à borda** — é isso que o preenchimento respeita, e é a
 * diferença entre um recorte utilizável e um com furos.
 */

import { colorDistance, rgb255ToHex } from "./color.js";

/** Tolerância que separa fundo de arte sem comer a borda suavizada do desenho. */
export const DEFAULT_CUTOUT_TOLERANCE = 10;

const idx = (img, x, y) => (y * img.width + x) * 4;

/** Cor mais comum na borda. É ela que o preenchimento persegue. */
export function edgeColor(img) {
  const contagem = new Map();

  const somar = (x, y) => {
    const i = idx(img, x, y);
    const hex = rgb255ToHex({ r: img.data[i], g: img.data[i + 1], b: img.data[i + 2] });
    contagem.set(hex, (contagem.get(hex) ?? 0) + 1);
  };

  for (let x = 0; x < img.width; x++) {
    somar(x, 0);
    somar(x, img.height - 1);
  }
  for (let y = 0; y < img.height; y++) {
    somar(0, y);
    somar(img.width - 1, y);
  }

  let melhor = null;
  let maior = -1;
  for (const [hex, n] of contagem) {
    if (n > maior) {
      maior = n;
      melhor = hex;
    }
  }

  return { hex: melhor, share: maior / (2 * (img.width + img.height)) };
}

/**
 * Deixa transparente o fundo conectado à borda.
 *
 * @param {{width, height, data: Uint8Array}} img  RGBA; é modificada uma cópia
 * @param {Object} [opts]
 * @param {number} [opts.tolerance]  distância de cor que ainda conta como fundo
 * @param {string} [opts.color]      cor do fundo; omitida, deduz da borda
 * @param {boolean} [opts.feather]   suaviza a borda do recorte (padrão true)
 * @returns {{width, height, data: Uint8Array, removed: number, color: string, share: number}}
 */
export function removeFlatBackground(img, opts = {}) {
  const tolerance = Number.isFinite(opts.tolerance) ? opts.tolerance : DEFAULT_CUTOUT_TOLERANCE;
  const borda = edgeColor(img);
  const alvo = opts.color ?? borda.hex;

  const data = new Uint8Array(img.data);
  const saida = { width: img.width, height: img.height, data };

  const total = img.width * img.height;
  const fundo = new Uint8Array(total);
  const fila = new Int32Array(total);
  let inicio = 0;
  let fim = 0;

  const combina = (p) => {
    const i = p * 4;
    return (
      colorDistance(rgb255ToHex({ r: data[i], g: data[i + 1], b: data[i + 2] }), alvo) <= tolerance
    );
  };

  const empilhar = (p) => {
    if (fundo[p] || !combina(p)) return;
    fundo[p] = 1;
    fila[fim++] = p;
  };

  // Só a borda entra como semente: o fundo é o que está conectado a ela.
  for (let x = 0; x < img.width; x++) {
    empilhar(x);
    empilhar((img.height - 1) * img.width + x);
  }
  for (let y = 0; y < img.height; y++) {
    empilhar(y * img.width);
    empilhar(y * img.width + img.width - 1);
  }

  while (inicio < fim) {
    const p = fila[inicio++];
    const x = p % img.width;
    const y = (p - x) / img.width;

    if (x > 0) empilhar(p - 1);
    if (x < img.width - 1) empilhar(p + 1);
    if (y > 0) empilhar(p - img.width);
    if (y < img.height - 1) empilhar(p + img.width);
  }

  let removed = 0;
  for (let p = 0; p < total; p++) {
    if (!fundo[p]) continue;
    data[p * 4 + 3] = 0;
    removed++;
  }

  if (opts.feather !== false) suavizarBorda(saida, fundo, alvo, tolerance);

  return { ...saida, removed, color: alvo, share: borda.share };
}

/**
 * Reduz o alfa dos pixels de transição que sobraram na borda do recorte.
 *
 * A borda do desenho é suavizada contra o fundo, então logo depois do que o
 * preenchimento pegou existe uma fileira de pixels meio-fundo. Deixá-los opacos produz
 * uma auréola da cor do fundo em volta da ilustração — discreta sobre fundo parecido e
 * escandalosa sobre fundo diferente, que é justamente onde o recorte vai ser usado.
 *
 * O alfa cai conforme a cor se aproxima do fundo, em vez de virar 0 ou 255: um corte
 * duro devolveria o serrilhado que a suavização existia para evitar.
 */
function suavizarBorda(img, fundo, alvo, tolerance) {
  const largo = tolerance * 3;
  const { width, height, data } = img;
  const original = new Uint8Array(data);

  const eraFundo = (x, y) => x >= 0 && y >= 0 && x < width && y < height && fundo[y * width + x];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (fundo[p]) continue;
      if (!eraFundo(x - 1, y) && !eraFundo(x + 1, y) && !eraFundo(x, y - 1) && !eraFundo(x, y + 1)) {
        continue;
      }

      const i = p * 4;
      const d = colorDistance(
        rgb255ToHex({ r: original[i], g: original[i + 1], b: original[i + 2] }),
        alvo
      );

      if (d >= largo) continue;

      // d = 0 seria fundo puro (alfa 0); d = largo já é arte (alfa cheio).
      data[i + 3] = Math.round((d / largo) * original[i + 3]);
    }
  }
}
