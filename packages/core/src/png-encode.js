/**
 * Escreve PNG. O par de `decodePng`.
 *
 * ── Por que isto existe ───────────────────────────────────────────────────────
 * Reconstruir com formas é o que dá editabilidade, e é a razão do projeto. Mas há coisa
 * que não se reconstrói: um tênis desenhado à mão, um braço robótico com garra, qualquer
 * ilustração orgânica com dezenas de curvas e sombreados sobrepostos. Medir primitivas
 * numa dessas produz um borrão de formas coloridas — pior que honesto, porque parece
 * tentativa.
 *
 * A saída é usar os pixels originais naquela região e reconstruir com formas só o resto:
 * cartão, barra, botão, texto — que é justamente o que se anima. Para isso é preciso
 * recortar a região e gravar um arquivo, e gravar exige codificar.
 *
 * O escopo é o mínimo que serve: RGBA 8 bits, sem filtro, sem entrelaçamento. O ganho de
 * escolher filtro por linha não paga a complexidade para um recorte que vai direto para
 * uma camada do After Effects.
 */

const ASSINATURA = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export class PngEncodeError extends Error {
  constructor(message) {
    super(message);
    this.name = "PngEncodeError";
  }
}

/** CRC-32 do PNG. Tabela montada na primeira chamada. */
let TABELA = null;

function crc32(bytes) {
  if (TABELA === null) {
    TABELA = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABELA[i] = c >>> 0;
    }
  }

  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABELA[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32(valor) {
  return [(valor >>> 24) & 0xff, (valor >>> 16) & 0xff, (valor >>> 8) & 0xff, valor & 0xff];
}

function chunk(tipo, dados) {
  const cabecalho = [];
  for (let i = 0; i < tipo.length; i++) cabecalho.push(tipo.charCodeAt(i));

  const corpo = new Uint8Array(cabecalho.length + dados.length);
  corpo.set(cabecalho, 0);
  corpo.set(dados, cabecalho.length);

  return [...u32(dados.length), ...corpo, ...u32(crc32(corpo))];
}

/**
 * Codifica uma imagem RGBA em PNG.
 *
 * @param {{width: number, height: number, data: Uint8Array}} img  `data` em RGBA, 8 bits
 * @param {(bytes: Uint8Array) => Uint8Array} deflate  o inverso do inflate de decodePng
 * @returns {Uint8Array}
 */
export function encodePng(img, deflate) {
  if (typeof deflate !== "function") {
    throw new PngEncodeError("encodePng precisa de uma função deflate — o core não conhece zlib.");
  }

  const { width, height, data } = img ?? {};

  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new PngEncodeError("encodePng precisa de width e height inteiros positivos.");
  }

  const esperado = width * height * 4;
  if (!data || data.length !== esperado) {
    throw new PngEncodeError(
      `data tem ${data?.length ?? 0} bytes e ${width}×${height} em RGBA precisa de ${esperado}.`
    );
  }

  // Uma linha por vez, cada uma precedida do byte de filtro. Zero é "sem filtro".
  const bruto = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const destino = y * (1 + width * 4);
    bruto[destino] = 0;
    bruto.set(data.subarray(y * width * 4, (y + 1) * width * 4), destino + 1);
  }

  const ihdr = new Uint8Array([
    ...u32(width),
    ...u32(height),
    8, // bits por canal
    6, // RGBA
    0, // compressão
    0, // filtro
    0, // sem entrelaçamento
  ]);

  return new Uint8Array([
    ...ASSINATURA,
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", deflate(bruto)),
    ...chunk("IEND", new Uint8Array(0)),
  ]);
}

/**
 * Recorta uma região de uma imagem decodificada.
 *
 * Recorta o que existe: pedir uma região que passa da borda devolve a parte que cabe, em
 * vez de erro. Uma medição feita em cima de um frame quase sempre erra alguns pixels na
 * borda, e falhar por isso obrigaria a ajustar o retângulo no chute.
 *
 * @returns {{width: number, height: number, data: Uint8Array, x: number, y: number}}
 */
export function cropImage(img, { x, y, width, height }) {
  for (const [nome, v] of [["x", x], ["y", y], ["width", width], ["height", height]]) {
    if (!Number.isFinite(v)) throw new PngEncodeError(`cropImage precisa de ${nome} numérico.`);
  }

  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(img.width, Math.round(x + width));
  const y1 = Math.min(img.height, Math.round(y + height));

  const w = x1 - x0;
  const h = y1 - y0;

  if (w <= 0 || h <= 0) {
    throw new PngEncodeError(
      `O recorte não encosta na imagem: pedido ${Math.round(x)},${Math.round(y)} ` +
        `${Math.round(width)}×${Math.round(height)} numa imagem de ${img.width}×${img.height}.`
    );
  }

  const data = new Uint8Array(w * h * 4);
  for (let linha = 0; linha < h; linha++) {
    const origem = ((y0 + linha) * img.width + x0) * 4;
    data.set(img.data.subarray(origem, origem + w * 4), linha * w * 4);
  }

  return { width: w, height: h, data, x: x0, y: y0 };
}
