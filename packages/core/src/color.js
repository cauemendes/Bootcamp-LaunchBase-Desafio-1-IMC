/**
 * Conversão de cor entre o hex do SceneSpec e o formato do After Effects.
 *
 * O AE espera arrays [r, g, b] com componentes de 0 a 1. O detalhe que morde é
 * espaço de cor: num projeto com "Linearize Working Space" ligado, o valor que o
 * scripting grava é interpretado como linear, e uma cor sRGB crua sai visivelmente
 * mais clara. Por isso `hexToAeColor` aceita uma gama opcional.
 */

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Normaliza "#f42", "f42", "#FF4422" → "#ff4422". Lança se for inválido. */
export function normalizeHex(hex) {
  if (typeof hex !== "string") throw new TypeError(`hex deve ser string, recebi ${typeof hex}`);
  const m = HEX_RE.exec(hex.trim());
  if (!m) throw new Error(`hex inválido: ${JSON.stringify(hex)}`);
  let body = m[1].toLowerCase();
  if (body.length === 3) body = body[0] + body[0] + body[1] + body[1] + body[2] + body[2];
  return `#${body}`;
}

/** "#ff4422" → { r: 255, g: 68, b: 34 } */
export function hexToRgb255(hex) {
  const n = parseInt(normalizeHex(hex).slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** { r, g, b } em 0–255 → "#rrggbb" */
export function rgb255ToHex({ r, g, b }) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[clamp(r), clamp(g), clamp(b)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * "#ff4422" → [0.999, 0.267, 0.133] para `setValue` de uma propriedade de cor.
 *
 * `gamma` compensa projeto em espaço linear. Deixe em 1 (padrão) para projeto sRGB
 * — que é o caso da maioria. Use 2.2 se as cores estiverem saindo lavadas.
 */
export function hexToAeColor(hex, gamma = 1) {
  const { r, g, b } = hexToRgb255(hex);
  const conv = gamma === 1 ? (v) => v / 255 : (v) => Math.pow(v / 255, gamma);
  return [conv(r), conv(g), conv(b)];
}

/** Distância perceptual grosseira entre duas cores, para deduplicar paleta. */
export function colorDistance(hexA, hexB) {
  const a = hexToRgb255(hexA);
  const b = hexToRgb255(hexB);
  // Ponderação aproximando a sensibilidade do olho — verde pesa mais que azul.
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(2 * dr * dr + 4 * dg * dg + 3 * db * db);
}

/**
 * Colapsa cores quase idênticas numa só. Modelos de visão costumam devolver
 * #FF4D2E e #FF4E2F para o que é obviamente a mesma cor da marca; isso vira duas
 * entradas de paleta e duas layers com fills diferentes se não for tratado.
 *
 * Devolve { palette, remap } — `remap` mapeia cada hex de entrada para o
 * representante escolhido.
 */
export function quantizePalette(hexes, threshold = 12) {
  const palette = [];
  const remap = new Map();

  for (const raw of hexes) {
    const hex = normalizeHex(raw);
    if (remap.has(hex)) continue;

    const match = palette.find((p) => colorDistance(p, hex) <= threshold);
    if (match) {
      remap.set(hex, match);
    } else {
      palette.push(hex);
      remap.set(hex, hex);
    }
  }

  return { palette, remap };
}
