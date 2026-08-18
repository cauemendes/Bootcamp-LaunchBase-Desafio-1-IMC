/**
 * Identidade visual do cliente: cores e fontes com nome.
 *
 * ── Por que isso existe ───────────────────────────────────────────────────────
 * Um modelo de visão olhando um print devolve `#FF5A1F` porque foi isso que ele
 * mediu nos pixels. A cor da marca é `#FF5A20`, e a diferença é invisível na tela e
 * fatal no arquivo: quem for trocar a cor depois vai achar dezoito hexadecimais
 * ligeiramente diferentes espalhados por vinte camadas. O mesmo vale para fonte —
 * um print não diz qual família é, e "parecido com Helvetica" vira Helvetica.
 *
 * Corrigir isso à mão depois é exatamente o trabalho que a ferramenta existe para
 * eliminar. Então a marca entra **antes** da construção, não depois.
 *
 * ── Duas formas de usar ───────────────────────────────────────────────────────
 * 1. Por nome — o modelo escreve `"fill": { "color": "primary" }` e
 *    `"fontFamily": "heading"`. É o caminho preferido: o SceneSpec fica legível e a
 *    troca de marca é uma troca de arquivo.
 * 2. Por aproximação — o modelo escreve o hex que mediu, e `applyBrand` encosta na
 *    cor da marca mais próxima quando a distância é pequena. Cobre o caso real de
 *    reconstruir a partir de imagem, onde o modelo não tem como saber os nomes.
 *
 * A aproximação é conservadora de propósito: encostar cor errada estraga o design de
 * um jeito difícil de perceber. O limite padrão pega variação de compressão e
 * anti-aliasing, não cores que são realmente outras.
 */

import { colorDistance, normalizeHex } from "./color.js";

/** Distância a partir da qual duas cores deixam de ser "a mesma com ruído". */
export const DEFAULT_SNAP_TOLERANCE = 14;

/** Fonte usada quando a marca não diz nada e o design não especifica. */
export const DEFAULT_FALLBACK_FONT = "Arial";

/**
 * Confere um perfil de marca antes de usar.
 *
 * Erro impede o uso; aviso não. Um perfil só com cores é perfeitamente válido — a
 * maioria dos clientes tem paleta fechada e fonte que muda por peça.
 */
export function validateBrand(brand) {
  const errors = [];
  const warnings = [];

  if (brand == null || typeof brand !== "object" || Array.isArray(brand)) {
    return { ok: false, errors: ["o perfil de marca precisa ser um objeto JSON"], warnings };
  }

  if (brand.name != null && typeof brand.name !== "string") {
    warnings.push("name deveria ser texto — ignorado");
  }

  const colors = brand.colors;
  if (colors != null) {
    if (typeof colors !== "object" || Array.isArray(colors)) {
      errors.push("colors precisa ser um objeto { nome: hex }");
    } else {
      for (const [token, hex] of Object.entries(colors)) {
        try {
          normalizeHex(hex);
        } catch (e) {
          errors.push(`colors.${token}: ${e.message}`);
        }
      }
    }
  }

  const fonts = brand.fonts;
  if (fonts != null) {
    if (typeof fonts !== "object" || Array.isArray(fonts)) {
      errors.push("fonts precisa ser um objeto { nome: { family, style } }");
    } else {
      for (const [token, spec] of Object.entries(fonts)) {
        const family = typeof spec === "string" ? spec : spec?.family;
        if (typeof family !== "string" || family === "") {
          errors.push(`fonts.${token}: precisa de uma family (texto)`);
        }
        if (spec != null && typeof spec === "object" && spec.style != null && typeof spec.style !== "string") {
          warnings.push(`fonts.${token}.style deveria ser texto — ignorado`);
        }
      }
    }
  }

  if (brand.snapTolerance != null && (typeof brand.snapTolerance !== "number" || brand.snapTolerance < 0)) {
    warnings.push("snapTolerance inválido — usando o padrão");
  }

  if (brand.notes != null) {
    if (!Array.isArray(brand.notes) || brand.notes.some((n) => typeof n !== "string")) {
      errors.push("notes precisa ser uma lista de textos");
    }
  }

  const semCores = colors == null || Object.keys(colors).length === 0;
  const semFontes = fonts == null || Object.keys(fonts).length === 0;
  if (semCores && semFontes) {
    warnings.push("o perfil não define nenhuma cor nem fonte — não vai mudar nada");
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Só os campos que o resto do código usa, já normalizados. */
function readBrand(brand) {
  const colors = new Map();
  for (const [token, hex] of Object.entries(brand?.colors ?? {})) {
    try {
      colors.set(token.toLowerCase(), normalizeHex(hex));
    } catch {
      // validateBrand já reportou; aqui é melhor seguir com o resto do perfil.
    }
  }

  const fonts = new Map();
  for (const [token, spec] of Object.entries(brand?.fonts ?? {})) {
    const family = typeof spec === "string" ? spec : spec?.family;
    if (typeof family !== "string" || family === "") continue;
    const style = typeof spec === "object" && typeof spec?.style === "string" ? spec.style : null;
    fonts.set(token.toLowerCase(), { family, style });
  }

  return {
    name: typeof brand?.name === "string" ? brand.name : null,
    colors,
    fonts,
    notes: Array.isArray(brand?.notes) ? brand.notes.filter((n) => typeof n === "string") : [],
    fallbackFont:
      typeof brand?.fallbackFont === "string" && brand.fallbackFont !== ""
        ? brand.fallbackFont
        : DEFAULT_FALLBACK_FONT,
    snapTolerance:
      typeof brand?.snapTolerance === "number" && brand.snapTolerance >= 0
        ? brand.snapTolerance
        : DEFAULT_SNAP_TOLERANCE,
  };
}

/** A cor da marca mais próxima, se estiver perto o suficiente para ser a mesma. */
function nearestBrandColor(hex, colors, tolerance) {
  let melhor = null;

  for (const [token, brandHex] of colors) {
    if (brandHex === hex) return { token, hex: brandHex, distance: 0, exact: true };
    const distance = colorDistance(hex, brandHex);
    if (distance <= tolerance && (melhor === null || distance < melhor.distance)) {
      melhor = { token, hex: brandHex, distance, exact: false };
    }
  }

  return melhor;
}

/**
 * Aplica a marca a uma cena, antes de ela virar camadas.
 *
 * Devolve uma cena nova — a original não é tocada, porque quem chamou pode querer
 * mostrar as duas versões ou reaplicar com outra marca.
 *
 * @param {object} scene            SceneSpec (plano ou aninhado)
 * @param {object} brand            perfil de marca
 * @param {object} [options]
 * @param {boolean} [options.snapColors=true]  encostar hex próximo na cor da marca
 * @returns {{scene: object, warnings: string[], applied: object}}
 */
export function applyBrand(scene, brand, { snapColors = true } = {}) {
  const b = readBrand(brand);
  const warnings = [];
  const applied = { colors: 0, fonts: 0, snapped: 0, unresolved: [] };

  const resolveColor = (valor, onde) => {
    if (typeof valor !== "string" || valor === "") return valor;

    // Token nomeado: é o caminho preferido, e um nome que não existe é erro do
    // modelo, não da marca — avisar é mais útil que cair no silêncio.
    if (!valor.startsWith("#")) {
      const achado = b.colors.get(valor.toLowerCase());
      if (achado) {
        applied.colors++;
        return achado;
      }
      applied.unresolved.push(valor);
      warnings.push(
        `${onde}: "${valor}" não existe na marca` +
          (b.colors.size ? ` (disponíveis: ${[...b.colors.keys()].join(", ")})` : "")
      );
      return valor;
    }

    if (!snapColors || b.colors.size === 0) return valor;

    let hex;
    try {
      hex = normalizeHex(valor);
    } catch {
      return valor;
    }

    const perto = nearestBrandColor(hex, b.colors, b.snapTolerance);
    if (!perto || perto.exact) return hex;

    applied.snapped++;
    warnings.push(
      `${onde}: ${hex} virou ${perto.hex} (${perto.token}) — diferença de ` +
        `${perto.distance.toFixed(1)}, dentro do limite de ${b.snapTolerance}`
    );
    return perto.hex;
  };

  const resolvePaint = (paint, onde) => {
    if (paint == null || typeof paint !== "object") return paint;

    // Gradiente tem duas cores e nenhuma delas se chama `color`. Sem este caso,
    // `"from": "primary"` chegaria ao After Effects como a string "primary" e o
    // designer veria um token no nome do grupo em vez do hexadecimal que precisa
    // digitar.
    if (paint.type === "gradient") {
      return {
        ...paint,
        from: resolveColor(paint.from, `${onde}.from`),
        to: resolveColor(paint.to, `${onde}.to`),
      };
    }

    return { ...paint, color: resolveColor(paint.color, `${onde}.color`) };
  };

  const resolveShape = (shape, onde) => {
    if (shape == null || typeof shape !== "object") return shape;
    if (shape.type !== "text") return shape;

    const pedida = shape.fontFamily;

    if (typeof pedida === "string" && pedida !== "") {
      const achado = b.fonts.get(pedida.toLowerCase());
      if (achado) {
        applied.fonts++;
        return {
          ...shape,
          fontFamily: achado.family,
          fontStyle: shape.fontStyle ?? achado.style ?? undefined,
        };
      }
      // Uma família de verdade (não um token) passa direto: o designer pode querer
      // uma fonte que não está na marca, e o AE resolve ou substitui com aviso.
      return shape;
    }

    warnings.push(`${onde}: texto sem fonte — usando ${b.fallbackFont}`);
    return { ...shape, fontFamily: b.fallbackFont };
  };

  const resolveElement = (el, onde) => {
    if (el == null || typeof el !== "object") return el;
    return {
      ...el,
      shape: resolveShape(el.shape, onde),
      fill: resolvePaint(el.fill, `${onde}.fill`),
      stroke: resolvePaint(el.stroke, `${onde}.stroke`),
    };
  };

  const out = { ...scene };

  if (Array.isArray(scene?.elements)) {
    out.elements = scene.elements.map((el, i) => resolveElement(el, `elements[${i}]`));
  }

  // Forma aninhada: `layers[].items[]`, produzida por normalizeScene.
  if (Array.isArray(scene?.layers)) {
    out.layers = scene.layers.map((layer, i) => ({
      ...layer,
      items: Array.isArray(layer?.items)
        ? layer.items.map((el, j) => resolveElement(el, `layers[${i}].items[${j}]`))
        : layer?.items,
    }));
  }

  if (scene?.background != null) {
    out.background = resolveColor(scene.background, "background");
  }

  return { scene: out, warnings, applied };
}

/**
 * Descrição curta da marca, para entrar no contexto do modelo antes dele desenhar.
 *
 * Curto de propósito: isso vai junto de toda reconstrução, e um perfil despejado como
 * JSON cru gasta contexto sem ajudar a escolher melhor.
 */
export function brandSummary(brand) {
  const b = readBrand(brand);
  const linhas = [];

  linhas.push(b.name ? `Marca: ${b.name}` : "Marca (sem nome)");

  if (b.colors.size) {
    linhas.push(
      "Cores: " + [...b.colors].map(([token, hex]) => `${token}=${hex}`).join(", ")
    );
  } else {
    linhas.push("Cores: nenhuma definida");
  }

  if (b.fonts.size) {
    linhas.push(
      "Fontes: " +
        [...b.fonts]
          .map(([token, f]) => `${token}=${f.family}${f.style ? ` ${f.style}` : ""}`)
          .join(", ")
    );
  } else {
    linhas.push(`Fontes: nenhuma definida — texto sai em ${b.fallbackFont}`);
  }

  // As regras de uso vêm antes da explicação do formato: um manual de marca real tem
  // cor que só vale em certo contexto — "este laranja só como texto sobre off-white" —
  // e essa é a parte que um modelo viola sem perceber, porque o hex está certo.
  if (b.notes.length) {
    linhas.push("Regras de uso (siga à risca):");
    for (const nota of b.notes) linhas.push(`  • ${nota}`);
  }

  linhas.push(
    "Use os nomes acima em `fill.color`, `stroke.color` e `fontFamily` no SceneSpec. " +
      "Hex medido da imagem também vale: cor a menos de " +
      `${b.snapTolerance} de distância de uma cor da marca é encostada nela automaticamente.`
  );

  return linhas.join("\n");
}
