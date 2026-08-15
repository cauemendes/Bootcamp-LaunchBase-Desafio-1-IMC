/**
 * Dimensões e tipo de uma imagem, lidos direto do cabeçalho do arquivo.
 *
 * O modelo precisa saber a resolução real para medir coordenadas na escala certa.
 * No painel dá pra usar um `<img>` e ler naturalWidth, mas o CLI e os testes não
 * têm DOM — e ler o cabeçalho é barato e sem dependência.
 *
 * Suporta PNG, JPEG, GIF e WebP (VP8, VP8L, VP8X), que cobre o que se arrasta pra
 * dentro de um painel de motion design.
 */

const MEDIA_TYPES = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** Media types que a API do Claude aceita como imagem. */
export const SUPPORTED_MEDIA_TYPES = new Set(Object.values(MEDIA_TYPES));

/**
 * @param {Uint8Array} bytes
 * @returns {{ format: string, mediaType: string, width: number, height: number }}
 */
export function readImageInfo(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("readImageInfo espera um Uint8Array");
  }
  if (bytes.length < 24) {
    throw new Error("Arquivo curto demais para ser uma imagem");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // PNG: assinatura de 8 bytes, depois o chunk IHDR com width/height big-endian.
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return {
      format: "png",
      mediaType: MEDIA_TYPES.png,
      width: view.getUint32(16, false),
      height: view.getUint32(20, false),
    };
  }

  // GIF: "GIF87a"/"GIF89a", depois width/height little-endian.
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return {
      format: "gif",
      mediaType: MEDIA_TYPES.gif,
      width: view.getUint16(6, true),
      height: view.getUint16(8, true),
    };
  }

  // WebP: "RIFF" .... "WEBP", depois um chunk que varia por variante.
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { format: "webp", mediaType: MEDIA_TYPES.webp, ...readWebpSize(bytes, view) };
  }

  // JPEG: 0xFFD8, depois percorrer os marcadores até um SOFn.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return { format: "jpeg", mediaType: MEDIA_TYPES.jpeg, ...readJpegSize(bytes, view) };
  }

  throw new Error(
    "Formato de imagem não reconhecido. Use PNG, JPEG, GIF ou WebP — " +
      "se estiver num formato do Photoshop/Illustrator, exporte antes."
  );
}

function readWebpSize(bytes, view) {
  const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);

  if (chunk === "VP8 ") {
    // Lossy: o frame header começa 6 bytes depois do início do payload.
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  }

  if (chunk === "VP8L") {
    // Lossless: 14 bits de largura e 14 de altura empacotados, ambos menos 1.
    const bits = view.getUint32(21, true);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }

  if (chunk === "VP8X") {
    // Estendido: dimensões em 24 bits little-endian, menos 1.
    const w = bytes[24] | (bytes[25] << 8) | (bytes[26] << 16);
    const h = bytes[27] | (bytes[28] << 8) | (bytes[29] << 16);
    return { width: w + 1, height: h + 1 };
  }

  throw new Error(`Variante de WebP não suportada: ${chunk}`);
}

function readJpegSize(bytes, view) {
  let offset = 2;

  while (offset < bytes.length - 1) {
    if (bytes[offset] !== 0xff) {
      offset++; // padding entre segmentos; a spec permite 0xFF repetido
      continue;
    }

    const marker = bytes[offset + 1];

    // SOF0–SOF15 carregam as dimensões. SOF4 (0xC4), SOF8 (0xC8) e SOF12 (0xCC)
    // são outra coisa (tabelas Huffman etc.) e precisam ser pulados.
    const isSOF =
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isSOF) {
      return {
        height: view.getUint16(offset + 5, false),
        width: view.getUint16(offset + 7, false),
      };
    }

    // Marcadores standalone não têm segmento de tamanho.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }

    const length = view.getUint16(offset + 2, false);
    if (length < 2) throw new Error("JPEG malformado: segmento com tamanho inválido");
    offset += 2 + length;
  }

  throw new Error("JPEG malformado: nenhum marcador SOF encontrado");
}

/** Uint8Array → string base64, sem depender de Buffer (roda no painel também). */
export function toBase64(bytes) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  const CHUNK = 0x8000; // evita estourar o limite de argumentos de apply()
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
