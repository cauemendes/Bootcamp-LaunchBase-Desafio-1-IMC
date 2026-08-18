/**
 * Decodificador de PNG.
 *
 * ── Por que existe ────────────────────────────────────────────────────────────
 * Reconstruir um design a partir de imagem exige medir a imagem: a cor exata de uma
 * área chapada, onde uma forma começa e termina, qual o raio de um canto. Sem isso o
 * modelo estima no olho, e estimativa em cima de estimativa vira um layout que parece
 * certo até alguém colocar lado a lado com o original.
 *
 * Na primeira reconstrução real o modelo escreveu o próprio decodificador em Node,
 * do zero, no meio da tarefa — e gastou a maior parte de dezessete minutos nisso.
 * Isso é trabalho que não precisa acontecer duas vezes.
 *
 * ── Por que `inflate` vem de fora ─────────────────────────────────────────────
 * Este pacote não importa nada do host: é o que permite ele rodar igual no Node de
 * hoje e num painel UXP amanhã. `zlib` é do Node, então quem chama injeta. O servidor
 * MCP passa `zlib.inflateSync`; no navegador seria `DecompressionStream`.
 *
 * PNG entrelaçado (Adam7) não é suportado — é raro em exportação de design e o custo
 * de implementar não se paga. O erro diz isso, em vez de devolver pixels embaralhados.
 */

const ASSINATURA = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Canais por tipo de cor, conforme a especificação PNG. */
const CANAIS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export class PngError extends Error {
  constructor(message) {
    super(message);
    this.name = "PngError";
  }
}

/**
 * @param {Uint8Array} bytes    conteúdo do arquivo
 * @param {Function} inflate    (Uint8Array) => Uint8Array, descompressão zlib
 * @returns {{width: number, height: number, data: Uint8Array}} data em RGBA, 8 bits
 */
export function decodePng(bytes, inflate) {
  if (typeof inflate !== "function") {
    throw new PngError("decodePng precisa de uma função inflate — veja o cabeçalho do módulo.");
  }

  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  for (let i = 0; i < ASSINATURA.length; i++) {
    if (b[i] !== ASSINATURA[i]) throw new PngError("Isto não é um arquivo PNG.");
  }

  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let pos = 8;

  let ihdr = null;
  let paleta = null;
  let transparencia = null;
  const partes = [];

  while (pos + 8 <= b.length) {
    const tamanho = view.getUint32(pos);
    const tipo = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
    const dados = b.subarray(pos + 8, pos + 8 + tamanho);

    if (tipo === "IHDR") {
      ihdr = {
        width: view.getUint32(pos + 8),
        height: view.getUint32(pos + 12),
        bitDepth: b[pos + 16],
        colorType: b[pos + 17],
        interlace: b[pos + 20],
      };
    } else if (tipo === "PLTE") {
      paleta = dados;
    } else if (tipo === "tRNS") {
      transparencia = dados;
    } else if (tipo === "IDAT") {
      partes.push(dados);
    } else if (tipo === "IEND") {
      break;
    }

    pos += 12 + tamanho;
  }

  if (!ihdr) throw new PngError("PNG sem cabeçalho IHDR.");
  if (ihdr.interlace !== 0) {
    throw new PngError(
      "PNG entrelaçado (Adam7) não é suportado. Reexporte sem entrelaçamento."
    );
  }

  const canais = CANAIS[ihdr.colorType];
  if (!canais) throw new PngError(`Tipo de cor PNG desconhecido: ${ihdr.colorType}`);
  if (ihdr.colorType === 3 && !paleta) throw new PngError("PNG indexado sem paleta.");

  const bruto = inflate(concat(partes));
  const linhas = desfiltrar(bruto, ihdr, canais);

  return {
    width: ihdr.width,
    height: ihdr.height,
    data: paraRgba(linhas, ihdr, canais, paleta, transparencia),
  };
}

function concat(partes) {
  let total = 0;
  for (const p of partes) total += p.length;

  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of partes) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Desfaz os filtros por linha.
 *
 * Cada scanline do PNG começa com um byte dizendo como ela foi filtrada, e o filtro
 * se refere ao pixel à esquerda e à linha de cima já reconstruídas. É por isso que
 * isto tem que ser sequencial: não dá para desfiltrar uma linha isolada.
 */
function desfiltrar(bruto, ihdr, canais) {
  const bitsPorPixel = ihdr.bitDepth * canais;
  const bytesPorPixel = Math.max(1, bitsPorPixel >> 3);
  const stride = Math.ceil((ihdr.width * bitsPorPixel) / 8);

  const esperado = (stride + 1) * ihdr.height;
  if (bruto.length < esperado) {
    throw new PngError(
      `PNG truncado: esperava ${esperado} bytes descomprimidos, recebi ${bruto.length}.`
    );
  }

  const out = new Uint8Array(stride * ihdr.height);

  for (let y = 0; y < ihdr.height; y++) {
    const tipo = bruto[y * (stride + 1)];
    const entrada = y * (stride + 1) + 1;
    const saida = y * stride;
    const acima = saida - stride;

    for (let x = 0; x < stride; x++) {
      const valor = bruto[entrada + x];
      const a = x >= bytesPorPixel ? out[saida + x - bytesPorPixel] : 0;
      const c = y > 0 ? out[acima + x] : 0;
      const d = y > 0 && x >= bytesPorPixel ? out[acima + x - bytesPorPixel] : 0;

      let resultado;
      switch (tipo) {
        case 0: resultado = valor; break;
        case 1: resultado = valor + a; break;
        case 2: resultado = valor + c; break;
        case 3: resultado = valor + ((a + c) >> 1); break;
        case 4: resultado = valor + paeth(a, c, d); break;
        default: throw new PngError(`Filtro PNG desconhecido na linha ${y}: ${tipo}`);
      }

      out[saida + x] = resultado & 0xff;
    }
  }

  return { bytes: out, stride };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Normaliza qualquer combinação de profundidade e tipo de cor para RGBA de 8 bits. */
function paraRgba({ bytes, stride }, ihdr, canais, paleta, transparencia) {
  const { width, height, bitDepth, colorType } = ihdr;
  const out = new Uint8Array(width * height * 4);

  // 16 bits por canal viram 8 pegando o byte alto: a diferença é invisível para o
  // que isto faz (medir cor de área chapada) e dobra a memória à toa.
  const passo = bitDepth === 16 ? 2 : 1;

  for (let y = 0; y < height; y++) {
    const linha = y * stride;

    for (let x = 0; x < width; x++) {
      const destino = (y * width + x) * 4;
      let r, g, b, a = 255;

      if (bitDepth < 8) {
        const valor = lerSubByte(bytes, linha, x, bitDepth);
        if (colorType === 3) {
          [r, g, b] = daPaleta(paleta, valor);
          a = corTransparente(transparencia, valor);
        } else {
          const maximo = (1 << bitDepth) - 1;
          r = g = b = Math.round((valor / maximo) * 255);
        }
      } else {
        const base = linha + x * canais * passo;

        if (colorType === 0) {
          r = g = b = bytes[base];
        } else if (colorType === 2) {
          r = bytes[base];
          g = bytes[base + passo];
          b = bytes[base + 2 * passo];
        } else if (colorType === 3) {
          const indice = bytes[base];
          [r, g, b] = daPaleta(paleta, indice);
          a = corTransparente(transparencia, indice);
        } else if (colorType === 4) {
          r = g = b = bytes[base];
          a = bytes[base + passo];
        } else {
          r = bytes[base];
          g = bytes[base + passo];
          b = bytes[base + 2 * passo];
          a = bytes[base + 3 * passo];
        }
      }

      out[destino] = r;
      out[destino + 1] = g;
      out[destino + 2] = b;
      out[destino + 3] = a;
    }
  }

  return out;
}

function lerSubByte(bytes, linha, x, bitDepth) {
  const porByte = 8 / bitDepth;
  const byte = bytes[linha + Math.floor(x / porByte)];
  const deslocamento = 8 - bitDepth * ((x % porByte) + 1);
  return (byte >> deslocamento) & ((1 << bitDepth) - 1);
}

function daPaleta(paleta, indice) {
  const i = indice * 3;
  return [paleta[i], paleta[i + 1], paleta[i + 2]];
}

function corTransparente(transparencia, indice) {
  if (!transparencia || indice >= transparencia.length) return 255;
  return transparencia[indice];
}
