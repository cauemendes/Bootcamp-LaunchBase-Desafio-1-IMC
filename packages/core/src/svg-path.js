/**
 * Parser de path SVG → bezier no formato do After Effects.
 *
 * O AE guarda, por vértice, uma tangente de entrada e uma de saída, ambas
 * RELATIVAS ao vértice. O SVG guarda pontos de controle ABSOLUTOS por segmento.
 * A conversão é direta:
 *
 *   segmento cúbico P0 --C1--C2--> P1
 *     outTangent(P0) = C1 - P0
 *     inTangent(P1)  = C2 - P1
 *
 * Curvas quadráticas viram cúbicas (o AE não tem quadrática). Arcos (A/a) não são
 * suportados — a conversão exata exige trigonometria de elipse e ainda não foi
 * necessária; o parser lança um erro claro em vez de aproximar errado.
 */

const COMMANDS = "MmLlHhVvCcSsQqTtAaZz";

/** Quebra "M10,10 L20 20" em [{ cmd: "M", args: [10,10] }, ...] */
function tokenize(d) {
  const tokens = [];
  let i = 0;
  const numRe = /^[+-]?(\d*\.\d+|\d+\.?)([eE][+-]?\d+)?/;

  while (i < d.length) {
    const ch = d[i];

    if (ch === " " || ch === "," || ch === "\n" || ch === "\r" || ch === "\t") {
      i++;
      continue;
    }

    if (COMMANDS.includes(ch)) {
      tokens.push({ cmd: ch, args: [] });
      i++;
      continue;
    }

    const m = numRe.exec(d.slice(i));
    if (!m) throw new Error(`Caractere inesperado em "d" na posição ${i}: ${JSON.stringify(ch)}`);
    if (tokens.length === 0) throw new Error(`Path começa com número em vez de comando: ${JSON.stringify(d.slice(0, 20))}`);
    tokens[tokens.length - 1].args.push(parseFloat(m[0]));
    i += m[0].length;
  }

  return tokens;
}

/** Quantos argumentos cada comando consome por repetição. */
const ARITY = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/**
 * Converte dados de path SVG em subpaths prontos pro AE.
 *
 * @param {string} d  atributo "d" de um <path>
 * @returns {Array<{closed: boolean, vertices: number[][], inTangents: number[][], outTangents: number[][]}>}
 */
export function parsePathData(d) {
  if (typeof d !== "string" || d.trim() === "") {
    throw new Error('parsePathData: "d" vazio');
  }

  const tokens = tokenize(d);
  const subpaths = [];

  let current = null;          // subpath em construção
  let cursor = [0, 0];         // ponto atual
  let subpathStart = [0, 0];   // pra onde Z volta
  let lastCubicC2 = null;      // pra refletir em S/s
  let lastQuadCtrl = null;     // pra refletir em T/t

  const startSubpath = (pt) => {
    current = { closed: false, vertices: [], inTangents: [], outTangents: [] };
    subpaths.push(current);
    current.vertices.push([pt[0], pt[1]]);
    current.inTangents.push([0, 0]);
    current.outTangents.push([0, 0]);
  };

  /** Adiciona um vértice, ajustando a tangente de saída do vértice anterior. */
  const addVertex = (pt, outTangentOfPrev, inTangentOfNew) => {
    if (!current) startSubpath(cursor);
    const lastIdx = current.vertices.length - 1;
    current.outTangents[lastIdx] = outTangentOfPrev;
    current.vertices.push([pt[0], pt[1]]);
    current.inTangents.push(inTangentOfNew);
    current.outTangents.push([0, 0]);
  };

  for (const token of tokens) {
    const upper = token.cmd.toUpperCase();
    const relative = token.cmd !== upper;
    const arity = ARITY[upper];

    if (upper === "A") {
      throw new Error(
        'Comando de arco ("A"/"a") não é suportado — converta arcos em curvas bezier ' +
          "antes de gerar o path (no Illustrator/Figma: exportar sem arcos)."
      );
    }

    if (upper === "Z") {
      if (current) {
        current.closed = true;
        cursor = [subpathStart[0], subpathStart[1]];
        current = null; // um novo comando de desenho abre outro subpath
      }
      continue;
    }

    if (token.args.length === 0 || token.args.length % arity !== 0) {
      throw new Error(
        `Comando "${token.cmd}" recebeu ${token.args.length} argumentos; ` +
          `esperava múltiplo de ${arity}`
      );
    }

    // Um comando pode trazer vários conjuntos de argumentos ("L10,10 20,20").
    // Repetições de M viram L, que é o que a spec do SVG manda.
    for (let k = 0; k < token.args.length; k += arity) {
      const a = token.args.slice(k, k + arity);
      const isRepeat = k > 0;
      const eff = upper === "M" && isRepeat ? "L" : upper;

      switch (eff) {
        case "M": {
          const pt = relative ? [cursor[0] + a[0], cursor[1] + a[1]] : [a[0], a[1]];
          startSubpath(pt);
          cursor = pt;
          subpathStart = pt;
          lastCubicC2 = null;
          lastQuadCtrl = null;
          break;
        }

        case "L": {
          const pt = relative ? [cursor[0] + a[0], cursor[1] + a[1]] : [a[0], a[1]];
          addVertex(pt, [0, 0], [0, 0]);
          cursor = pt;
          lastCubicC2 = null;
          lastQuadCtrl = null;
          break;
        }

        case "H": {
          const x = relative ? cursor[0] + a[0] : a[0];
          const pt = [x, cursor[1]];
          addVertex(pt, [0, 0], [0, 0]);
          cursor = pt;
          lastCubicC2 = null;
          lastQuadCtrl = null;
          break;
        }

        case "V": {
          const y = relative ? cursor[1] + a[0] : a[0];
          const pt = [cursor[0], y];
          addVertex(pt, [0, 0], [0, 0]);
          cursor = pt;
          lastCubicC2 = null;
          lastQuadCtrl = null;
          break;
        }

        case "C": {
          const [c1, c2, end] = absTriple(a, cursor, relative);
          addVertex(end, sub(c1, cursor), sub(c2, end));
          cursor = end;
          lastCubicC2 = c2;
          lastQuadCtrl = null;
          break;
        }

        case "S": {
          // Primeiro controle é o reflexo do último C2 em torno do ponto atual.
          const c1 = lastCubicC2 ? reflect(lastCubicC2, cursor) : [cursor[0], cursor[1]];
          const c2 = relative ? [cursor[0] + a[0], cursor[1] + a[1]] : [a[0], a[1]];
          const end = relative ? [cursor[0] + a[2], cursor[1] + a[3]] : [a[2], a[3]];
          addVertex(end, sub(c1, cursor), sub(c2, end));
          cursor = end;
          lastCubicC2 = c2;
          lastQuadCtrl = null;
          break;
        }

        case "Q": {
          const q = relative ? [cursor[0] + a[0], cursor[1] + a[1]] : [a[0], a[1]];
          const end = relative ? [cursor[0] + a[2], cursor[1] + a[3]] : [a[2], a[3]];
          const { c1, c2 } = quadToCubic(cursor, q, end);
          addVertex(end, sub(c1, cursor), sub(c2, end));
          cursor = end;
          lastQuadCtrl = q;
          lastCubicC2 = c2;
          break;
        }

        case "T": {
          const q = lastQuadCtrl ? reflect(lastQuadCtrl, cursor) : [cursor[0], cursor[1]];
          const end = relative ? [cursor[0] + a[0], cursor[1] + a[1]] : [a[0], a[1]];
          const { c1, c2 } = quadToCubic(cursor, q, end);
          addVertex(end, sub(c1, cursor), sub(c2, end));
          cursor = end;
          lastQuadCtrl = q;
          lastCubicC2 = c2;
          break;
        }

        default:
          throw new Error(`Comando de path não tratado: ${token.cmd}`);
      }
    }
  }

  // Num subpath fechado, o último vértice pode coincidir com o primeiro. O AE fecha
  // sozinho pela flag `closed`, então o vértice duplicado vira um ponto degenerado.
  for (const sp of subpaths) {
    if (!sp.closed || sp.vertices.length < 2) continue;
    const first = sp.vertices[0];
    const last = sp.vertices[sp.vertices.length - 1];
    if (Math.abs(first[0] - last[0]) < 1e-6 && Math.abs(first[1] - last[1]) < 1e-6) {
      // A tangente de entrada do duplicado pertence, de fato, ao primeiro vértice.
      sp.inTangents[0] = sp.inTangents[sp.inTangents.length - 1];
      sp.vertices.pop();
      sp.inTangents.pop();
      sp.outTangents.pop();
    }
  }

  return subpaths.filter((sp) => sp.vertices.length > 0);
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1]];
}

function reflect(point, about) {
  return [2 * about[0] - point[0], 2 * about[1] - point[1]];
}

function absTriple(a, cursor, relative) {
  if (!relative) return [[a[0], a[1]], [a[2], a[3]], [a[4], a[5]]];
  return [
    [cursor[0] + a[0], cursor[1] + a[1]],
    [cursor[0] + a[2], cursor[1] + a[3]],
    [cursor[0] + a[4], cursor[1] + a[5]],
  ];
}

/** Eleva uma quadrática (P0, Q, P1) para cúbica (P0, C1, C2, P1). */
function quadToCubic(p0, q, p1) {
  return {
    c1: [p0[0] + (2 / 3) * (q[0] - p0[0]), p0[1] + (2 / 3) * (q[1] - p0[1])],
    c2: [p1[0] + (2 / 3) * (q[0] - p1[0]), p1[1] + (2 / 3) * (q[1] - p1[1])],
  };
}

/** Bounding box de um conjunto de subpaths (ignora tangentes — é uma caixa dos vértices). */
export function subpathsBounds(subpaths) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const sp of subpaths) {
    for (const [x, y] of sp.vertices) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
