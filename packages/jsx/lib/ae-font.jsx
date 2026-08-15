/**
 * Resolução de fonte: nome humano → nome PostScript.
 *
 * ── Por que isso existe ───────────────────────────────────────────────────────
 * No After Effects 2026, `textDocument.fontFamily` e `fontStyle` são somente
 * leitura — verificado no 26.3. A única forma de definir fonte por script é
 * `textDocument.font`, que espera o nome PostScript exato ("HelveticaNeue-Bold"),
 * não o nome de família.
 *
 * Um modelo olhando uma imagem consegue dizer "parece Helvetica Bold". Ele não tem
 * como saber o nome PostScript. Esta é a ponte.
 *
 * ── A API, verificada no 26.3 ────────────────────────────────────────────────
 * `app.fonts` expõe:
 *
 *   allFonts                             Array de FAMÍLIAS, não de fontes.
 *                                        Cada item é um array com as variantes:
 *                                        allFonts[0] → [ABCDiatype-Regular,
 *                                                       ABCDiatype-Bold, …]
 *   getFontsByFamilyNameAndStyleName()   → Array de fontes. Existe e funciona.
 *   getFontsByPostScriptName()           → Array de fontes. Existe e funciona.
 *   missingOrSubstitutedFonts            Array das fontes que o AE substituiu.
 *
 * `getFontsByFamilyName` NÃO existe nesta versão.
 *
 * O aninhamento de `allFonts` é a pegadinha: ler `.familyName` direto nos itens
 * devolve `undefined` em silêncio, não erro.
 */

/*global app*/

var vec = vec || {};

/** Fonte usada quando não dá pra resolver o que o modelo pediu. */
vec.FALLBACK_FONT_FAMILY = "Arial";

/**
 * Índice família → variantes, montado uma vez por sessão.
 *
 * A máquina de teste tem 467 famílias. Varrer isso por camada de texto é
 * desperdício óbvio numa cena com vinte títulos.
 */
vec._fontIndex = null;

/** Normaliza para comparar: "Helvetica Neue" e "HelveticaNeue" viram a mesma chave. */
vec.normalizeFontName = function (name) {
  return String(name === undefined || name === null ? "" : name)
    .toLowerCase()
    .replace(/[\s_\-]+/g, "");
};

/**
 * Monta (uma vez) o índice das fontes instaladas.
 * @returns {Object} mapa de família normalizada → [{ family, style, postScriptName }]
 */
vec.buildFontIndex = function () {
  if (vec._fontIndex !== null) return vec._fontIndex;

  var index = {};

  try {
    var families = app.fonts && app.fonts.allFonts ? app.fonts.allFonts : null;
    if (families) {
      for (var i = 0; i < families.length; i++) {
        // Cada item de allFonts é uma família (array de variantes). O teste do
        // instanceof cobre uma versão futura que resolva devolver a fonte direto.
        var entry = families[i];
        var variants = entry instanceof Array ? entry : [entry];

        for (var j = 0; j < variants.length; j++) {
          var font = variants[j];

          var family, style, ps;
          try { family = font.familyName; } catch (e) { family = null; }
          try { style = font.styleName; } catch (e) { style = ""; }
          try { ps = font.postScriptName; } catch (e) { ps = null; }

          // Sem nome PostScript a entrada é inútil — é exatamente o que buscamos.
          if (!family || !ps) continue;

          var key = vec.normalizeFontName(family);
          if (!index[key]) index[key] = [];
          index[key].push({ family: family, style: style || "", postScriptName: ps });
        }
      }
    }
  } catch (e) {
    // app.fonts inacessível: índice vazio, a resolução cai no fallback.
  }

  vec._fontIndex = index;
  return index;
};

/** Limpa o índice. Chame se o usuário instalar fontes com a ferramenta aberta. */
vec.resetFontIndex = function () {
  vec._fontIndex = null;
};

/**
 * Nomes das famílias instaladas, em ordem alfabética.
 *
 * Serve para mostrar ao modelo o que existe na máquina, em vez de deixá-lo chutar
 * uma fonte que vai ser substituída em silêncio.
 */
vec.listFontFamilies = function () {
  var index = vec.buildFontIndex();
  var nomes = [];

  for (var key in index) {
    if (index.hasOwnProperty(key) && index[key].length > 0) {
      nomes.push(index[key][0].family);
    }
  }

  nomes.sort();
  return nomes;
};

/**
 * Resolve o nome PostScript de uma família + estilo.
 *
 * @param {String} family  "Helvetica", "Gilroy"… vindo do modelo
 * @param {String} style   "Bold", "Regular"… pode ser vazio
 * @returns {{postScriptName: String, exact: Boolean, style: String}|null}
 */
vec.resolveFont = function (family, style) {
  if (!family) return null;

  // 1. Busca dedicada — o caminho oficial, e o mais barato.
  var direta = vec._lookupByFamilyAndStyle(family, style || "Regular");
  if (direta) return { postScriptName: direta, exact: true, style: style || "Regular" };

  // 2. Pediu um estilo que não existe? Tenta Regular antes de desistir da família.
  if (style) {
    var regular = vec._lookupByFamilyAndStyle(family, "Regular");
    if (regular) return { postScriptName: regular, exact: false, style: "Regular" };
  }

  // 3. Índice local — cobre grafias que o método oficial não casa.
  var candidatos = vec.buildFontIndex()[vec.normalizeFontName(family)];
  if (!candidatos || candidatos.length === 0) return null;

  if (style) {
    var alvo = vec.normalizeFontName(style);
    for (var i = 0; i < candidatos.length; i++) {
      if (vec.normalizeFontName(candidatos[i].style) === alvo) {
        return { postScriptName: candidatos[i].postScriptName, exact: true, style: candidatos[i].style };
      }
    }
  }

  // Sem estilo compatível: prefere um peso neutro. Sem esse cuidado, uma família
  // grande pode devolver "Thin Italic" por acaso, só por estar em primeiro.
  for (var j = 0; j < candidatos.length; j++) {
    var s = vec.normalizeFontName(candidatos[j].style);
    if (s === "regular" || s === "" || s === "book" || s === "roman") {
      return { postScriptName: candidatos[j].postScriptName, exact: !style, style: candidatos[j].style };
    }
  }

  return { postScriptName: candidatos[0].postScriptName, exact: false, style: candidatos[0].style };
};

/** @returns {String|null} nome PostScript, ou null se não achou */
vec._lookupByFamilyAndStyle = function (family, style) {
  try {
    if (!app.fonts || typeof app.fonts.getFontsByFamilyNameAndStyleName !== "function") {
      return null;
    }
    var achadas = app.fonts.getFontsByFamilyNameAndStyleName(family, style);
    if (achadas && achadas.length > 0 && achadas[0].postScriptName) {
      return achadas[0].postScriptName;
    }
  } catch (e) {
    // Assinatura diferente nesta versão: quem chama cai no índice.
  }
  return null;
};

/**
 * Aplica a fonte num TextDocument, com fallback, e relata o que aconteceu.
 *
 * Nunca lança: fonte errada é problema de acabamento, não motivo pra perder a
 * camada. O designer troca a fonte depois; ele não recupera uma camada que não foi
 * criada.
 *
 * @returns {String|null} aviso legível, ou null se aplicou exatamente o pedido
 */
vec.applyFont = function (doc, family, style) {
  if (!family) return null;

  var resolvida = vec.resolveFont(family, style);

  if (resolvida) {
    try {
      doc.font = resolvida.postScriptName;
      if (resolvida.exact) return null;
      return 'A fonte "' + family + (style ? " " + style : "") +
        '" não existe nesse estilo — usei "' + resolvida.postScriptName + '".';
    } catch (e) {
      // Resolveu mas o AE recusou: cai no fallback.
    }
  }

  var fallback = vec.resolveFont(vec.FALLBACK_FONT_FAMILY, style) ||
    vec.resolveFont(vec.FALLBACK_FONT_FAMILY, "Regular");

  if (fallback) {
    try {
      doc.font = fallback.postScriptName;
      return 'A fonte "' + family + '" não está instalada — usei ' +
        vec.FALLBACK_FONT_FAMILY + ". Troque pela fonte do projeto depois.";
    } catch (e) {
      // Nem o fallback entrou: fica a fonte padrão do AE.
    }
  }

  return 'Não consegui aplicar "' + family +
    '" nem o fallback — a camada ficou com a fonte padrão do After Effects.';
};

/**
 * Fontes que o After Effects substituiu no projeto.
 *
 * Bem mais confiável que comparar nomes antes e depois: é o próprio AE dizendo o
 * que faltou. Vale chamar no fim de um build para avisar o usuário de uma vez.
 *
 * @returns {String[]}
 */
vec.missingFonts = function () {
  var faltando = [];
  try {
    var lista = app.fonts && app.fonts.missingOrSubstitutedFonts;
    if (lista) {
      for (var i = 0; i < lista.length; i++) {
        var f = lista[i];
        var nome;
        try {
          nome = f.postScriptName || f.familyName || String(f);
        } catch (e) {
          nome = String(f);
        }
        faltando.push(nome);
      }
    }
  } catch (e) {
    // Propriedade ausente nesta versão: devolve vazio.
  }
  return faltando;
};
