#targetengine "vectorizeAE"

/*
 * GERADO AUTOMATICAMENTE — não edite este arquivo.
 *
 * Produzido por scripts/bundle-jsx.mjs a partir de:
 *   packages/jsx/bridge-panel.jsx
 *   packages/jsx/lib/tools.jsx
 *   packages/jsx/lib/util.jsx
 *   packages/jsx/lib/ae-shape.jsx
 *   packages/jsx/lib/ae-font.jsx
 *   packages/jsx/lib/ae-text.jsx
 *   packages/jsx/lib/ae-read.jsx
 *   packages/jsx/lib/build-scene.jsx
 *
 * Edite os originais em packages/jsx/ e rode a instalação de novo.
 */
/**
 * Vectorize AE Bridge — o painel que fica aberto dentro do After Effects.
 *
 * ── O que ele faz ─────────────────────────────────────────────────────────────
 * O After Effects não tem servidor de scripting: nenhum processo de fora consegue
 * chamá-lo. Este painel é a ponte. Ele fica lendo uma pasta compartilhada; quando o
 * servidor MCP escreve um comando ali, o painel executa dentro do AE e escreve a
 * resposta de volta.
 *
 * ── #targetengine não é opcional ──────────────────────────────────────────────
 * Sem uma engine própria e persistente, o ExtendScript coleta as variáveis do
 * painel entre um evento e outro, e o polling para de funcionar sozinho depois de
 * alguns segundos — sem erro nenhum, o que torna a depuração horrível.
 *
 * ── Instalação ────────────────────────────────────────────────────────────────
 * Este arquivo e a pasta `lib/` vão para a pasta ScriptUI Panels do After Effects.
 * Só ele fica solto ali: os demais `.jsx` também apareceriam no menu Window, e o
 * autoteste rodaria sozinho ao abrir o app. `scripts/install-bridge.sh` cuida disso.
 */


// ── lib/tools.jsx ──
/**
 * Tabela de ferramentas: o que o modelo pode pedir ao After Effects.
 *
 * Cada entrada recebe os argumentos já parseados e devolve um valor serializável.
 * Erros sobem — quem chama (o painel) transforma em resposta de erro legível.
 *
 * ── Sobre o tamanho desta tabela ──────────────────────────────────────────────
 * A tentação é expor tudo que o AE faz. Não vale a pena: cada ferramenta ocupa
 * contexto em toda conversa e aumenta a chance de o modelo escolher a errada.
 *
 * A regra aqui é a mesma de um bom conjunto de ferramentas de agente: poucas
 * operações bem delimitadas para o que é comum, mais `execute_script` como escape
 * hatch para o resto. Uma operação só vira ferramenta dedicada quando há motivo —
 * precisa de confirmação antes de executar, o resultado precisa de formatação
 * própria, ou o modelo erra fazendo à mão.
 */

// ── util.jsx ──
/**
 * Utilitários de base para o ExtendScript.
 *
 * ExtendScript é ECMAScript 3. Não existe JSON, não existe Array.prototype.map /
 * forEach / indexOf, não existe String.prototype.trim. Tudo que o código do projeto
 * usa além do ES3 puro está aqui, escrito à mão.
 *
 * Sobre JSON: o painel escreve o SceneSpec num arquivo temporário e o ExtendScript
 * lê e avalia com eval(). JSON é um subconjunto de literal de objeto JavaScript,
 * então isso funciona sem parser — desde que o painel escape U+2028/U+2029, que são
 * válidos em JSON mas quebram literais de string em engines antigas. Ver
 * `writeSceneFile()` no painel.
 *
 * A ida de volta (resultado → painel) precisa de serialização, e é o que `vecJson`
 * faz. Ele cobre só o que o objeto de resultado contém: string, número, booleano,
 * null, array e objeto simples.
 */

/*global File*/

var vec = vec || {};

/** Serializa um valor para JSON. Escopo deliberadamente pequeno — ver acima. */
vec.json = function (value) {
  if (value === null || value === undefined) return "null";

  var t = typeof value;

  if (t === "boolean") return value ? "true" : "false";

  if (t === "number") {
    // Infinity e NaN não existem em JSON; viram null, como no JSON.stringify real.
    return isFinite(value) ? String(value) : "null";
  }

  if (t === "string") return vec.quote(value);

  if (value instanceof Array) {
    var parts = [];
    for (var i = 0; i < value.length; i++) parts.push(vec.json(value[i]));
    return "[" + parts.join(",") + "]";
  }

  if (t === "object") {
    var pairs = [];
    for (var key in value) {
      if (!value.hasOwnProperty(key)) continue;
      if (typeof value[key] === "function") continue;
      pairs.push(vec.quote(key) + ":" + vec.json(value[key]));
    }
    return "{" + pairs.join(",") + "}";
  }

  return "null";
};

var ESCAPES = { "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r", '"': '\\"', "\\": "\\\\" };

vec.quote = function (str) {
  var out = '"';
  for (var i = 0; i < str.length; i++) {
    var ch = str.charAt(i);
    if (ESCAPES[ch]) {
      out += ESCAPES[ch];
    } else if (ch < " ") {
      var code = ch.charCodeAt(0).toString(16);
      out += "\\u" + "0000".substring(code.length) + code;
    } else {
      out += ch;
    }
  }
  return out + '"';
};

/** Lê um arquivo UTF-8 inteiro. Devolve null se não der pra abrir. */
vec.readFile = function (path) {
  var file = new File(path);
  if (!file.exists) return null;

  file.encoding = "UTF-8";
  if (!file.open("r")) return null;

  try {
    return file.read();
  } finally {
    file.close();
  }
};

/**
 * "#ff4422" → [r, g, b] com componentes de 0 a 1.
 *
 * `gamma` compensa projeto em espaço de trabalho linear, onde uma cor sRGB crua
 * sai lavada. Deixe 1 (padrão) para projeto sRGB.
 */
vec.hexToColor = function (hex, gamma) {
  var body = String(hex).replace("#", "");
  if (body.length === 3) {
    body = body.charAt(0) + body.charAt(0) + body.charAt(1) + body.charAt(1) + body.charAt(2) + body.charAt(2);
  }

  var r = parseInt(body.substring(0, 2), 16) / 255;
  var g = parseInt(body.substring(2, 4), 16) / 255;
  var b = parseInt(body.substring(4, 6), 16) / 255;

  if (gamma && gamma !== 1) {
    r = Math.pow(r, gamma);
    g = Math.pow(g, gamma);
    b = Math.pow(b, gamma);
  }

  return [r, g, b];
};

/** Nome de camada seguro: o AE trunca em 255 e engasga com quebra de linha. */
vec.safeName = function (name, fallback) {
  var s = String(name === undefined || name === null ? "" : name);
  s = s.replace(/[\r\n\t]+/g, " ");
  if (s.length > 200) s = s.substring(0, 200);
  return s === "" ? fallback : s;
};

vec.has = function (obj, key) {
  return obj !== null && obj !== undefined && obj[key] !== undefined;
};

// ── ae-shape.jsx ──
/**
 * Construção de shape layers a partir do SceneSpec normalizado.
 *
 * ── Sistema de coordenadas ────────────────────────────────────────────────────
 * O SceneSpec usa origem no canto superior esquerdo da comp. Para que isso caia
 * exatamente onde deve, cada layer é criada com âncora E posição em (0,0): assim o
 * espaço da layer coincide com o espaço da comp, e um valor de x/y do SceneSpec vai
 * direto pra propriedade sem conversão.
 *
 * O efeito colateral é que a âncora fica no canto da comp, o que é péssimo pra
 * animar. `vec.recenterAnchor()` conserta isso depois, movendo a âncora pro centro
 * do conteúdo e compensando a posição — o visual não muda.
 *
 * ── Ordem dentro de um grupo ──────────────────────────────────────────────────
 * No After Effects, um Fill ou Stroke pinta os paths que estão ACIMA dele na lista
 * de Contents. Por isso a ordem é geometria → stroke → fill: o fill acaba embaixo
 * do stroke, que é o que praticamente todo design assume. O core já entrega os
 * itens nessa ordem; aqui é só percorrer.
 */

/*global app, Shape, PropertyValueType*/

var vec = vec || {};

// Constantes numéricas das propriedades enumeradas do AE. Os valores não estão em
// nenhum enum exposto ao scripting — vêm da documentação de matchnames.
vec.LINE_CAP = { butt: 1, round: 2, square: 3 };
vec.LINE_JOIN = { miter: 1, round: 2, bevel: 3 };
vec.STAR_TYPE = { star: 1, polygon: 2 };

/**
 * Cria uma shape layer completa.
 *
 * @param {CompItem} comp
 * @param {Object} spec   layer normalizada: { name, contents: [grupo, ...] }
 * @param {Object} opts   { gamma: Number, recenterAnchors: Boolean }
 * @returns {ShapeLayer}
 */
vec.addShapeLayer = function (comp, spec, opts) {
  var layer = comp.layers.addShape();
  layer.name = vec.safeName(spec.name, "Shape");

  var transform = layer.property("ADBE Transform Group");
  transform.property("ADBE Anchor Point").setValue([0, 0]);
  transform.property("ADBE Position").setValue([0, 0]);

  var contents = layer.property("ADBE Root Vectors Group");

  for (var i = 0; i < spec.contents.length; i++) {
    vec.addGroup(contents, spec.contents[i], opts);
  }

  if (opts && opts.recenterAnchors) {
    vec.recenterAnchor(layer);
  }

  return layer;
};

/** Adiciona um grupo (um elemento do design) dentro de Contents. */
vec.addGroup = function (contents, groupSpec, opts) {
  var group = contents.addProperty("ADBE Vector Group");
  group.name = vec.safeName(groupSpec.name, "Grupo");

  var inner = group.property("ADBE Vectors Group");

  for (var i = 0; i < groupSpec.items.length; i++) {
    var item = groupSpec.items[i];

    if (item.kind === "geometry") {
      vec.addGeometry(inner, item.shape);
      vec.applyGeometryRotation(group, item.shape);
    } else if (item.kind === "stroke") {
      vec.addStroke(inner, item, opts);
    } else if (item.kind === "fill") {
      vec.addFill(inner, item, opts);
    }
  }

  return group;
};

vec.addGeometry = function (inner, shape) {
  switch (shape.type) {
    case "rect":
      return vec.addRect(inner, shape);
    case "ellipse":
      return vec.addEllipse(inner, shape);
    case "star":
      return vec.addStar(inner, shape);
    case "bezier":
      return vec.addBezier(inner, shape);
    default:
      throw new Error('Tipo de geometria desconhecido: "' + shape.type + '"');
  }
};

vec.addRect = function (inner, shape) {
  var rect = inner.addProperty("ADBE Vector Shape - Rect");
  rect.property("ADBE Vector Rect Size").setValue([shape.w, shape.h]);
  rect.property("ADBE Vector Rect Position").setValue([shape.cx, shape.cy]);
  rect.property("ADBE Vector Rect Roundness").setValue(shape.roundness || 0);
  return rect;
};

vec.addEllipse = function (inner, shape) {
  var ellipse = inner.addProperty("ADBE Vector Shape - Ellipse");
  ellipse.property("ADBE Vector Ellipse Size").setValue([shape.w, shape.h]);
  ellipse.property("ADBE Vector Ellipse Position").setValue([shape.cx, shape.cy]);
  return ellipse;
};

vec.addStar = function (inner, shape) {
  var star = inner.addProperty("ADBE Vector Shape - Star");
  star.property("ADBE Vector Star Type").setValue(
    shape.isPolygon ? vec.STAR_TYPE.polygon : vec.STAR_TYPE.star
  );
  star.property("ADBE Vector Star Points").setValue(shape.points);
  star.property("ADBE Vector Star Position").setValue([shape.cx, shape.cy]);
  star.property("ADBE Vector Star Outer Radius").setValue(shape.outerRadius);

  // Um polígono regular não expõe raio interno — tentar escrever nele dispara erro.
  if (!shape.isPolygon) {
    star.property("ADBE Vector Star Inner Radius").setValue(shape.innerRadius);
  }

  // A rotação da estrela é parâmetro da própria primitiva, ao contrário de
  // retângulo e elipse, que precisam da transform do grupo.
  if (shape.rotation) {
    star.property("ADBE Vector Star Rotation").setValue(shape.rotation);
  }

  return star;
};

/**
 * Path bezier. Um subpath por "ADBE Vector Shape - Group" — um único Shape do AE
 * não representa caminhos desconexos, então um ícone com furo vira dois paths no
 * mesmo grupo, e a regra de preenchimento (even-odd) faz o furo aparecer.
 */
vec.addBezier = function (inner, shape) {
  var created = [];

  for (var i = 0; i < shape.subpaths.length; i++) {
    var sp = shape.subpaths[i];

    var pathProp = inner.addProperty("ADBE Vector Shape - Group");
    var s = new Shape();
    s.vertices = sp.vertices;
    s.inTangents = sp.inTangents;
    s.outTangents = sp.outTangents;
    s.closed = sp.closed;

    pathProp.property("ADBE Vector Shape").setValue(s);
    created.push(pathProp);
  }

  return created;
};

/**
 * Rotação de retângulo e elipse.
 *
 * Nem `ADBE Vector Shape - Rect` nem `- Ellipse` têm parâmetro de rotação; a
 * rotação precisa vir da transform do grupo. Para girar em torno do próprio centro
 * (e não do canto da comp), a âncora do grupo vai pro centro da forma e a posição
 * compensa na mesma medida.
 */
vec.applyGeometryRotation = function (group, shape) {
  if (!shape.rotation) return;
  if (shape.type !== "rect" && shape.type !== "ellipse") return;

  var t = group.property("ADBE Vector Transform Group");
  t.property("ADBE Vector Anchor").setValue([shape.cx, shape.cy]);
  t.property("ADBE Vector Position").setValue([shape.cx, shape.cy]);
  t.property("ADBE Vector Rotation").setValue(shape.rotation);
};

vec.addFill = function (inner, spec, opts) {
  var gamma = opts && opts.gamma ? opts.gamma : 1;
  var fill = inner.addProperty("ADBE Vector Graphic - Fill");
  fill.property("ADBE Vector Fill Color").setValue(vec.hexToColor(spec.color, gamma).concat([1]));
  fill.property("ADBE Vector Fill Opacity").setValue(spec.opacity);
  return fill;
};

vec.addStroke = function (inner, spec, opts) {
  var gamma = opts && opts.gamma ? opts.gamma : 1;
  var stroke = inner.addProperty("ADBE Vector Graphic - Stroke");
  stroke.property("ADBE Vector Stroke Color").setValue(vec.hexToColor(spec.color, gamma).concat([1]));
  stroke.property("ADBE Vector Stroke Opacity").setValue(spec.opacity);
  stroke.property("ADBE Vector Stroke Width").setValue(spec.width);
  stroke.property("ADBE Vector Stroke Line Cap").setValue(vec.LINE_CAP[spec.cap] || vec.LINE_CAP.butt);
  stroke.property("ADBE Vector Stroke Line Join").setValue(vec.LINE_JOIN[spec.join] || vec.LINE_JOIN.miter);
  return stroke;
};

/**
 * Move a âncora da layer para o centro do seu conteúdo, compensando a posição para
 * que nada se mexa visualmente.
 *
 * `sourceRectAtTime` devolve o bounding box em espaço de layer. Como criamos a
 * layer com âncora e posição em (0,0), esse retângulo já está em coordenadas de
 * comp — a compensação é uma subtração direta.
 *
 * O segundo argumento `false` desliga o cálculo de extensões (sombras, blur). Aqui
 * ainda não há efeito nenhum aplicado, então o resultado é o mesmo e é mais rápido.
 */
vec.recenterAnchor = function (layer) {
  var rect = layer.sourceRectAtTime(layer.containingComp.time, false);
  if (rect.width === 0 && rect.height === 0) return;

  var center = [rect.left + rect.width / 2, rect.top + rect.height / 2];

  layer.property("ADBE Transform Group").property("ADBE Anchor Point").setValue(center);
  layer.property("ADBE Transform Group").property("ADBE Position").setValue(center);
};

// ── ae-font.jsx ──
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

// ── ae-text.jsx ──
/**
 * Construção de camadas de texto.
 *
 * Texto não pode viver dentro de uma shape layer — no After Effects é um tipo de
 * camada separado. Por isso o core já separa os elementos de texto em camadas
 * próprias antes de chegar aqui.
 *
 * A resolução de fonte mora em `ae-font.jsx`: no AE 2026 `fontFamily` é somente
 * leitura, e definir fonte exige o nome PostScript. Veja lá o porquê.
 */

/*global ParagraphJustification*/

var vec = vec || {};

vec.JUSTIFICATION = {
  left: ParagraphJustification.LEFT_JUSTIFY,
  center: ParagraphJustification.CENTER_JUSTIFY,
  right: ParagraphJustification.RIGHT_JUSTIFY,
};

/**
 * @param {CompItem} comp
 * @param {Object} spec  { name, content, x, y, fontFamily, fontSize, weight, align, letterSpacing, color, opacity }
 * @param {Object} opts  { gamma: Number }
 * @returns {{ layer: TextLayer, fontWarning: String|null }}
 */
vec.addTextLayer = function (comp, spec, opts) {
  var gamma = opts && opts.gamma ? opts.gamma : 1;

  var layer = comp.layers.addText(spec.content);
  layer.name = vec.safeName(spec.name, "Texto");

  var textProp = layer.property("ADBE Text Properties").property("ADBE Text Document");

  // O TextDocument é um snapshot: mexer em `doc` não altera nada até o setValue.
  // Por isso a fonte entra no mesmo objeto, antes de gravar — dois setValue
  // seguidos custariam duas atualizações do layout do texto.
  var doc = textProp.value;

  doc.fontSize = spec.fontSize;
  doc.applyFill = true;
  doc.fillColor = vec.hexToColor(spec.color, gamma);
  doc.applyStroke = false;
  doc.justification = vec.JUSTIFICATION[spec.align] || ParagraphJustification.LEFT_JUSTIFY;

  if (spec.letterSpacing) {
    doc.tracking = spec.letterSpacing;
  }

  var fontWarning = vec.applyFont(doc, spec.fontFamily, spec.weight);

  textProp.setValue(doc);

  // A âncora de um texto de ponto fica na baseline, no ponto de alinhamento. Com a
  // posição em (x, y) do SceneSpec, o texto cai onde o modelo mediu.
  var transform = layer.property("ADBE Transform Group");
  transform.property("ADBE Position").setValue([spec.x, spec.y]);
  transform.property("ADBE Opacity").setValue(spec.opacity);

  return { layer: layer, fontWarning: fontWarning };
};

// ── ae-read.jsx ──
/**
 * Ferramentas de leitura: descrever projeto, composição e camada.
 *
 * ── Por que leitura vem primeiro ──────────────────────────────────────────────
 * Sem enxergar o projeto, o modelo só sabe criar do zero. Ajudar no que já existe
 * — renomear, reorganizar, animar o que está lá, achar o que está errado — é onde
 * mora o tempo do dia a dia de um motion designer, e tudo isso começa em ler.
 *
 * ── Economia de contexto é requisito, não detalhe ─────────────────────────────
 * O resultado destas funções vira texto na conversa com o modelo. Uma comp de 60
 * camadas descrita com tudo que o AE oferece são dezenas de milhares de tokens, e
 * o modelo se perde no ruído antes de acabar o orçamento.
 *
 * Por isso a leitura é em dois níveis: `describeComp` devolve um resumo por camada,
 * e `describeLayer` devolve o detalhe de uma só. O modelo lista, escolhe, e aprofunda
 * onde precisa — em vez de receber tudo e filtrar depois.
 */

/*global app, CompItem, FolderItem, FootageItem, ShapeLayer, TextLayer, CameraLayer, LightLayer, AVLayer, PropertyType*/

var vec = vec || {};

/** Panorama do projeto: o que existe e onde. */
vec.describeProject = function () {
  var proj = app.project;

  if (!proj) return { open: false };

  var comps = [];
  var footage = 0;
  var folders = 0;

  for (var i = 1; i <= proj.numItems; i++) {
    var item = proj.item(i);

    if (item instanceof CompItem) {
      comps.push({
        name: item.name,
        id: item.id,
        width: item.width,
        height: item.height,
        frameRate: item.frameRate,
        duration: round(item.duration, 3),
        layers: item.numLayers,
      });
    } else if (item instanceof FolderItem) {
      folders++;
    } else {
      footage++;
    }
  }

  var active = app.project.activeItem;

  return {
    open: true,
    file: proj.file ? proj.file.name : null,
    saved: !!proj.file,
    comps: comps,
    footageCount: footage,
    folderCount: folders,
    activeComp: active instanceof CompItem ? active.name : null,
    // Sem projeto salvo, qualquer caminho relativo que o modelo sugerir é chute.
    projectFolder: proj.file ? proj.file.parent.fsName : null,
  };
};

/**
 * Descreve uma composição e resume suas camadas.
 *
 * @param {Object} args  { compName: String|null, selectedOnly: Boolean }
 *                       compName ausente = comp ativa
 */
vec.describeComp = function (args) {
  args = args || {};
  var comp = vec.findComp(args.compName);

  var camadas = [];
  var alvo = args.selectedOnly ? comp.selectedLayers : null;

  for (var i = 1; i <= comp.numLayers; i++) {
    var layer = comp.layer(i);
    if (alvo && !vec.inArray(alvo, layer)) continue;
    camadas.push(vec.summarizeLayer(layer));
  }

  return {
    name: comp.name,
    id: comp.id,
    width: comp.width,
    height: comp.height,
    frameRate: comp.frameRate,
    duration: round(comp.duration, 3),
    currentTime: round(comp.time, 3),
    workArea: { start: round(comp.workAreaStart, 3), duration: round(comp.workAreaDuration, 3) },
    bgColor: vec.colorToHex(comp.bgColor),
    numLayers: comp.numLayers,
    selectedLayers: vec.mapNames(comp.selectedLayers),
    layers: camadas,
  };
};

/** Uma linha por camada: o suficiente pro modelo decidir onde aprofundar. */
vec.summarizeLayer = function (layer) {
  var t = layer.property("ADBE Transform Group");

  var resumo = {
    index: layer.index,
    name: layer.name,
    type: vec.layerKind(layer),
    enabled: layer.enabled,
    selected: layer.selected,
    locked: layer.locked,
    shy: layer.shy,
    inPoint: round(layer.inPoint, 3),
    outPoint: round(layer.outPoint, 3),
    parent: layer.parent ? layer.parent.name : null,
    position: vec.readValue(t.property("ADBE Position")),
    scale: vec.readValue(t.property("ADBE Scale")),
    opacity: vec.readValue(t.property("ADBE Opacity")),
    animated: vec.countKeyframes(layer) > 0,
  };

  if (layer instanceof TextLayer) {
    try {
      resumo.text = layer.property("ADBE Text Properties").property("ADBE Text Document").value.text;
    } catch (e) {
      resumo.text = null;
    }
  }

  if (layer instanceof AVLayer && layer.source && !(layer instanceof ShapeLayer)) {
    resumo.source = layer.source.name;
  }

  var efeitos = layer.property("ADBE Effect Parade");
  if (efeitos && efeitos.numProperties > 0) {
    resumo.effects = [];
    for (var e = 1; e <= efeitos.numProperties; e++) {
      resumo.effects.push(efeitos.property(e).name);
    }
  }

  return resumo;
};

/**
 * Detalhe completo de uma camada: transform com keyframes, efeitos com valores, e
 * a árvore de Contents se for shape layer.
 *
 * @param {Object} args  { compName, layerName } ou { compName, layerIndex }
 */
vec.describeLayer = function (args) {
  args = args || {};
  var comp = vec.findComp(args.compName);
  var layer = vec.findLayer(comp, args);

  var detalhe = vec.summarizeLayer(layer);
  detalhe.blendMode = vec.blendModeName(layer.blendingMode);
  detalhe.transform = vec.describeTransform(layer);
  detalhe.effects = vec.describeEffects(layer);

  if (layer instanceof ShapeLayer) {
    detalhe.contents = vec.describeContents(layer.property("ADBE Root Vectors Group"));
  }

  if (layer instanceof TextLayer) {
    detalhe.textDocument = vec.describeText(layer);
  }

  return detalhe;
};

vec.describeTransform = function (layer) {
  var t = layer.property("ADBE Transform Group");
  var props = ["ADBE Anchor Point", "ADBE Position", "ADBE Scale", "ADBE Rotate Z", "ADBE Opacity"];
  var rotulos = ["anchorPoint", "position", "scale", "rotation", "opacity"];
  var saida = {};

  for (var i = 0; i < props.length; i++) {
    var p = layer.property("ADBE Transform Group").property(props[i]);
    if (!p) continue;
    saida[rotulos[i]] = vec.describeProperty(p);
  }

  return saida;
};

/**
 * Uma propriedade: valor, expressão e keyframes.
 *
 * Keyframes vêm com tempo e valor. Um easing completo (influence e speed por
 * dimensão) multiplicaria o tamanho da resposta por quatro; quando o modelo
 * precisar disso, é caso de uma ferramenta específica.
 */
vec.describeProperty = function (prop) {
  var info = { value: vec.readValue(prop) };

  if (prop.expressionEnabled && prop.expression) {
    info.expression = prop.expression;
  }

  if (prop.numKeys > 0) {
    info.keyframes = [];
    for (var k = 1; k <= prop.numKeys; k++) {
      info.keyframes.push({ time: round(prop.keyTime(k), 3), value: vec.roundValue(prop.keyValue(k)) });
    }
  }

  return info;
};

vec.describeEffects = function (layer) {
  var parade = layer.property("ADBE Effect Parade");
  if (!parade || parade.numProperties === 0) return [];

  var lista = [];

  for (var i = 1; i <= parade.numProperties; i++) {
    var efeito = parade.property(i);
    var params = {};

    for (var j = 1; j <= efeito.numProperties; j++) {
      var p = efeito.property(j);
      // Grupos e propriedades sem valor (como o "Compositing Options") não têm o
      // que reportar e só ocupariam espaço.
      if (p.propertyType !== PropertyType.PROPERTY) continue;
      try {
        params[p.name] = vec.readValue(p);
      } catch (e) {
        // Propriedade sem valor legível — segue.
      }
    }

    lista.push({
      name: efeito.name,
      matchName: efeito.matchName,
      enabled: efeito.enabled,
      params: params,
    });
  }

  return lista;
};

/** Árvore de Contents de uma shape layer, recursiva. */
vec.describeContents = function (group) {
  var itens = [];

  for (var i = 1; i <= group.numProperties; i++) {
    var prop = group.property(i);
    var item = { name: prop.name, matchName: prop.matchName };

    if (prop.matchName === "ADBE Vector Group") {
      item.type = "group";
      item.items = vec.describeContents(prop.property("ADBE Vectors Group"));
    } else if (prop.matchName === "ADBE Vector Graphic - Fill" ||
               prop.matchName === "ADBE Vector Graphic - Stroke") {
      item.type = prop.matchName.indexOf("Fill") !== -1 ? "fill" : "stroke";
      item.color = vec.readColorProperty(prop);
      var largura = prop.property("ADBE Vector Stroke Width");
      if (largura) item.width = vec.readValue(largura);
    } else if (prop.matchName === "ADBE Vector Shape - Rect") {
      item.type = "rect";
      item.size = vec.readValue(prop.property("ADBE Vector Rect Size"));
      item.position = vec.readValue(prop.property("ADBE Vector Rect Position"));
      item.roundness = vec.readValue(prop.property("ADBE Vector Rect Roundness"));
    } else if (prop.matchName === "ADBE Vector Shape - Ellipse") {
      item.type = "ellipse";
      item.size = vec.readValue(prop.property("ADBE Vector Ellipse Size"));
      item.position = vec.readValue(prop.property("ADBE Vector Ellipse Position"));
    } else if (prop.matchName === "ADBE Vector Shape - Star") {
      item.type = "star";
      item.points = vec.readValue(prop.property("ADBE Vector Star Points"));
      item.outerRadius = vec.readValue(prop.property("ADBE Vector Star Outer Radius"));
    } else if (prop.matchName === "ADBE Vector Shape - Group") {
      item.type = "path";
      try {
        item.vertexCount = prop.property("ADBE Vector Shape").value.vertices.length;
      } catch (e) {
        item.vertexCount = null;
      }
    } else {
      item.type = "other";
    }

    itens.push(item);
  }

  return itens;
};

vec.describeText = function (layer) {
  var doc = layer.property("ADBE Text Properties").property("ADBE Text Document").value;
  var out = {};

  var campos = ["text", "font", "fontSize", "tracking", "leading", "justification"];
  for (var i = 0; i < campos.length; i++) {
    try {
      out[campos[i]] = doc[campos[i]];
    } catch (e) {
      // Campo ausente nesta versão — segue.
    }
  }

  try {
    out.fillColor = vec.colorToHex(doc.fillColor);
  } catch (e) {
    out.fillColor = null;
  }

  // fontFamily é somente leitura no 26.3, mas LER funciona — e é o nome que um
  // humano reconhece, ao contrário do PostScript.
  try {
    out.fontFamily = doc.fontFamily;
  } catch (e) {
    // Ignora.
  }

  return out;
};

// ---------------------------------------------------------------- utilitários

vec.findComp = function (compName) {
  if (!compName) {
    var ativa = app.project.activeItem;
    if (ativa instanceof CompItem) return ativa;
    throw new Error(
      "Nenhuma composição ativa. Abra uma comp na timeline, ou informe compName."
    );
  }

  for (var i = 1; i <= app.project.numItems; i++) {
    var item = app.project.item(i);
    if (item instanceof CompItem && item.name === compName) return item;
  }

  throw new Error('Não encontrei nenhuma composição chamada "' + compName + '".');
};

vec.findLayer = function (comp, args) {
  if (args.layerIndex) {
    if (args.layerIndex < 1 || args.layerIndex > comp.numLayers) {
      throw new Error(
        "layerIndex " + args.layerIndex + ' fora do intervalo: a comp "' + comp.name +
          '" tem ' + comp.numLayers + " camadas."
      );
    }
    return comp.layer(args.layerIndex);
  }

  if (args.layerName) {
    for (var i = 1; i <= comp.numLayers; i++) {
      if (comp.layer(i).name === args.layerName) return comp.layer(i);
    }
    throw new Error('Não encontrei a camada "' + args.layerName + '" em "' + comp.name + '".');
  }

  if (comp.selectedLayers.length > 0) return comp.selectedLayers[0];

  throw new Error("Informe layerName ou layerIndex, ou selecione uma camada na timeline.");
};

vec.layerKind = function (layer) {
  if (layer instanceof ShapeLayer) return "shape";
  if (layer instanceof TextLayer) return "text";
  if (layer instanceof CameraLayer) return "camera";
  if (layer instanceof LightLayer) return "light";
  if (layer.nullLayer) return "null";
  if (layer.adjustmentLayer) return "adjustment";
  if (layer instanceof AVLayer) return "footage";
  return "other";
};

vec.readValue = function (prop) {
  if (!prop) return null;
  try {
    return vec.roundValue(prop.value);
  } catch (e) {
    return null;
  }
};

/** Arredonda para 3 casas: o AE devolve valores como 899.0999999999999. */
vec.roundValue = function (value) {
  if (typeof value === "number") return round(value, 3);
  if (value instanceof Array) {
    var out = [];
    for (var i = 0; i < value.length; i++) out.push(vec.roundValue(value[i]));
    return out;
  }
  return value;
};

vec.readColorProperty = function (prop) {
  var nomes = ["ADBE Vector Fill Color", "ADBE Vector Stroke Color"];
  for (var i = 0; i < nomes.length; i++) {
    var p = prop.property(nomes[i]);
    if (p) {
      try {
        return vec.colorToHex(p.value);
      } catch (e) {
        return null;
      }
    }
  }
  return null;
};

/** [r,g,b] de 0–1 → "#rrggbb", que é como um designer pensa em cor. */
vec.colorToHex = function (color) {
  if (!color || !(color instanceof Array)) return null;
  var out = "#";
  for (var i = 0; i < 3; i++) {
    var v = Math.round(Math.max(0, Math.min(1, color[i])) * 255).toString(16);
    out += v.length === 1 ? "0" + v : v;
  }
  return out;
};

vec.countKeyframes = function (layer) {
  var total = 0;
  var t = layer.property("ADBE Transform Group");
  for (var i = 1; i <= t.numProperties; i++) {
    try {
      total += t.property(i).numKeys;
    } catch (e) {
      // Grupo sem numKeys — segue.
    }
  }
  return total;
};

vec.mapNames = function (layers) {
  var nomes = [];
  for (var i = 0; i < layers.length; i++) nomes.push(layers[i].name);
  return nomes;
};

vec.inArray = function (arr, value) {
  for (var i = 0; i < arr.length; i++) if (arr[i] === value) return true;
  return false;
};

vec.blendModeName = function (mode) {
  // O enum BlendingMode é numérico; devolver o número não diz nada ao modelo.
  for (var key in BlendingMode) {
    if (BlendingMode.hasOwnProperty(key) && BlendingMode[key] === mode) {
      return key.toLowerCase().replace(/_/g, " ");
    }
  }
  return String(mode);
};

function round(n, casas) {
  if (typeof n !== "number" || !isFinite(n)) return n;
  var f = Math.pow(10, casas);
  return Math.round(n * f) / f;
}

// ── build-scene.jsx ──
/**
 * Ponto de entrada do adapter ExtendScript.
 *
 * O painel chama `vecBuildSceneFromFile(caminho)`. A função lê o SceneSpec
 * normalizado, constrói a comp e devolve uma string JSON com o resultado.
 *
 * O contrato de retorno é sempre uma string JSON, nunca uma exceção que atravessa a
 * ponte: `evalScript` transforma erro de ExtendScript em "EvalScript error." sem
 * mais nada, o que é inútil pra quem está usando. Aqui todo erro vira
 * `{ ok: false, error: "..." }` com mensagem legível.
 */

// ── util.jsx ──

// ── ae-shape.jsx ──

// ── ae-font.jsx ──

// ── ae-text.jsx ──


/*global app, vec, CompItem*/

/**
 * @param {String} specPath  caminho do JSON escrito pelo painel
 * @returns {String}         JSON: { ok, compName?, layerCount?, warnings[], error? }
 */
function vecBuildSceneFromFile(specPath) {
  try {
    var raw = vec.readFile(specPath);
    if (raw === null) {
      return vec.json({ ok: false, error: "Não consegui ler o arquivo da cena em: " + specPath });
    }

    var payload;
    try {
      // JSON é um subconjunto de literal de objeto JS; os parênteses forçam o
      // parser a ler "{...}" como expressão e não como bloco.
      payload = eval("(" + raw + ")");
    } catch (e) {
      return vec.json({ ok: false, error: "O arquivo da cena não é JSON válido: " + e.toString() });
    }

    return vec.json(vecBuildScene(payload.scene, payload.options || {}));
  } catch (e) {
    return vec.json({ ok: false, error: vecDescribeError(e) });
  }
}

/**
 * Constrói a cena. Separada do wrapper de arquivo para poder ser chamada direto
 * pelo ScriptUI ou por um teste manual dentro do AE.
 *
 * @param {Object} scene    SceneSpec normalizado (saída de normalizeScene)
 * @param {Object} options  { compName, gamma, recenterAnchors, reuseComp }
 */
function vecBuildScene(scene, options) {
  var warnings = [];

  if (!scene || !scene.canvas || !scene.layers) {
    return { ok: false, error: "SceneSpec sem canvas ou layers." };
  }
  if (scene.layers.length === 0) {
    return { ok: false, error: "A cena não tem nenhuma camada para construir." };
  }

  var compName = vec.safeName(options.compName, "Cena Vetorizada");

  // Um único grupo de undo para a cena inteira: o usuário desfaz com um Ctrl+Z, e
  // não com um por camada.
  app.beginUndoGroup("Vectorize AE — " + compName);

  try {
    var comp = vecResolveComp(scene.canvas, compName, options);

    if (scene.canvas.background) {
      vecAddBackground(comp, scene.canvas.background, options);
    }

    var buildOpts = {
      gamma: options.gamma || 1,
      recenterAnchors: options.recenterAnchors !== false,
    };

    // O SceneSpec vem em ordem de trás para frente. No AE, `add*` empilha cada nova
    // camada no índice 1 (topo), então construir nessa ordem já produz o
    // empilhamento correto sem precisar reordenar depois.
    for (var i = 0; i < scene.layers.length; i++) {
      var spec = scene.layers[i];
      try {
        if (spec.type === "text") {
          var result = vec.addTextLayer(comp, spec, buildOpts);
          if (result.fontWarning) warnings.push(result.fontWarning);
        } else {
          vec.addShapeLayer(comp, spec, buildOpts);
        }
      } catch (e) {
        // Uma camada problemática não deve levar a cena inteira junto — o designer
        // prefere 19 camadas certas e um aviso a zero camadas e um erro.
        warnings.push(
          'Camada "' + (spec.name || "(sem nome)") + '" não pôde ser criada: ' + vecDescribeError(e)
        );
      }
    }

    comp.openInViewer();

    return {
      ok: true,
      compName: comp.name,
      layerCount: comp.numLayers,
      warnings: warnings,
    };
  } catch (e) {
    return { ok: false, error: vecDescribeError(e), warnings: warnings };
  } finally {
    app.endUndoGroup();
  }
}

/**
 * Devolve a comp de destino: a ativa (se `reuseComp` e as dimensões baterem) ou uma
 * nova. Reaproveitar importa quando o designer já montou o projeto e só quer as
 * camadas dentro da comp em que está trabalhando.
 */
function vecResolveComp(canvas, compName, options) {
  if (options.reuseComp) {
    var active = app.project.activeItem;
    if (active instanceof CompItem) {
      if (active.width !== canvas.width || active.height !== canvas.height) {
        throw new Error(
          "A comp ativa é " + active.width + "×" + active.height + " e a cena é " +
            canvas.width + "×" + canvas.height + ". Desligue 'usar comp ativa' ou " +
            "ajuste as dimensões da comp."
        );
      }
      return active;
    }
    throw new Error("Nenhuma composição ativa. Selecione uma comp ou desligue 'usar comp ativa'.");
  }

  return app.project.items.addComp(
    compName,
    Math.round(canvas.width),
    Math.round(canvas.height),
    1, // pixel aspect ratio
    canvas.duration,
    canvas.frameRate
  );
}

/**
 * Fundo sólido como shape layer, não como Solid.
 *
 * Um Solid vira um item no painel de projeto e não guarda a cor de forma editável;
 * uma shape layer com um retângulo do tamanho da comp fica com a cor num parâmetro
 * animável, que é o que serve pra motion.
 */
function vecAddBackground(comp, hex, options) {
  var spec = {
    name: "BG",
    contents: [
      {
        type: "group",
        name: "Fundo",
        items: [
          {
            kind: "geometry",
            shape: {
              type: "rect",
              cx: comp.width / 2,
              cy: comp.height / 2,
              w: comp.width,
              h: comp.height,
              roundness: 0,
              rotation: 0,
            },
          },
          { kind: "fill", color: hex, opacity: 100 },
        ],
      },
    ],
  };

  // O fundo não recentra âncora: ele cobre a comp inteira e mover a âncora dele não
  // ajuda ninguém.
  return vec.addShapeLayer(comp, spec, { gamma: options.gamma || 1, recenterAnchors: false });
}

/** Erros do ExtendScript trazem contexto útil em `line`; erros de JS, não. */
function vecDescribeError(e) {
  if (e && e.line !== undefined && e.fileName) {
    return e.toString() + " (" + e.fileName + ":" + e.line + ")";
  }
  return e && e.toString ? e.toString() : String(e);
}


/*global app, File, Folder, CompItem*/

var vec = vec || {};

vec.tools = {};

// ---------------------------------------------------------------- diagnóstico

vec.tools.ping = function () {
  return {
    ok: true,
    afterEffects: app.version,
    project: app.project && app.project.file ? app.project.file.name : "(sem projeto salvo)",
  };
};

// ---------------------------------------------------------------- leitura

vec.tools.describe_project = function () {
  return vec.describeProject();
};

vec.tools.describe_comp = function (args) {
  return vec.describeComp(args);
};

vec.tools.describe_layer = function (args) {
  return vec.describeLayer(args);
};

vec.tools.list_fonts = function (args) {
  var familias = vec.listFontFamilies();

  // A máquina de teste tem 467 famílias. Devolver todas custa milhares de tokens
  // e o modelo raramente precisa da lista inteira — precisa saber se a fonte que
  // ele quer existe.
  if (args && args.filter) {
    var alvo = vec.normalizeFontName(args.filter);
    var achadas = [];
    for (var i = 0; i < familias.length; i++) {
      if (vec.normalizeFontName(familias[i]).indexOf(alvo) !== -1) achadas.push(familias[i]);
    }
    return { total: familias.length, matching: achadas };
  }

  return { total: familias.length, families: familias };
};

// ---------------------------------------------------------------- visão

/**
 * Renderiza um frame para PNG, para o modelo VER o que fez.
 *
 * É o que fecha o laço: sem enxergar o resultado, o modelo aplica uma animação e
 * conclui que funcionou porque nenhuma chamada deu erro — o que não é a mesma coisa
 * que ter ficado bom.
 *
 * `saveFrameToPng` é o caminho nativo do After Effects: nada de fila de render,
 * nada de plugin externo, nada de snapshot manual.
 */
vec.tools.save_frame = function (args) {
  args = args || {};
  var comp = vec.findComp(args.compName);

  if (typeof comp.saveFrameToPng !== "function") {
    throw new Error(
      "Esta versão do After Effects não expõe saveFrameToPng. " +
        "Sem ela, a captura de frame teria que passar pela fila de render."
    );
  }

  var time = typeof args.time === "number" ? args.time : comp.time;

  if (time < 0 || time > comp.duration) {
    throw new Error(
      "time " + time + "s está fora da duração da comp (0 a " + round3(comp.duration) + "s)."
    );
  }

  var destino = args.path
    ? new File(args.path)
    : new File(Folder.temp.fsName + "/vectorize-ae-frame-" + new Date().getTime() + ".png");

  comp.saveFrameToPng(time, destino);

  if (!destino.exists) {
    throw new Error("O After Effects não gravou o arquivo em " + destino.fsName + ".");
  }

  return {
    path: destino.fsName,
    time: round3(time),
    comp: comp.name,
    width: comp.width,
    height: comp.height,
  };
};

// ---------------------------------------------------------------- construção

vec.tools.build_scene = function (args) {
  args = args || {};
  if (!args.scene) throw new Error("build_scene precisa de um SceneSpec normalizado em `scene`.");
  return vecBuildScene(args.scene, args.options || {});
};

// ---------------------------------------------------------------- escape hatch

/**
 * ExtendScript arbitrário. É o "bash" do After Effects: alavanca máxima, controle
 * mínimo.
 *
 * Existe porque nenhuma tabela de ferramentas cobre tudo que um motion designer
 * pede, e porque descobrir o que falta é mais fácil vendo o modelo usar isto do que
 * adivinhando antes.
 *
 * O código roda dentro de um grupo de undo próprio — um Cmd+Z desfaz o que ele fez,
 * inteiro.
 */
vec.tools.execute_script = function (args) {
  args = args || {};
  if (typeof args.code !== "string" || args.code === "") {
    throw new Error("execute_script precisa de `code`.");
  }

  var rotulo = args.label || "Vectorize AE — script";
  app.beginUndoGroup(rotulo);

  try {
    var resultado = eval(args.code);

    // O retorno vai virar JSON. Objetos do DOM do AE (camadas, comps, propriedades)
    // não serializam — descrever em vez de tentar.
    return { value: vec.serializable(resultado) };
  } finally {
    app.endUndoGroup();
  }
};

/**
 * Converte o retorno de um script arbitrário em algo que atravessa o JSON.
 *
 * Sem isso, `return comp.layer(1)` devolveria `{}` — o modelo veria um objeto vazio
 * e concluiria que a camada não existe.
 */
vec.serializable = function (value) {
  if (value === null || value === undefined) return null;

  var t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;

  if (value instanceof Array) {
    var out = [];
    for (var i = 0; i < value.length; i++) out.push(vec.serializable(value[i]));
    return out;
  }

  if (t === "object") {
    // Objetos do DOM do AE: descrever pelo que o modelo consegue usar depois.
    try {
      if (value instanceof CompItem) {
        return { __type: "CompItem", name: value.name, id: value.id, layers: value.numLayers };
      }
      if (value.matchName !== undefined && value.name !== undefined) {
        return { __type: "Property", name: value.name, matchName: value.matchName };
      }
      if (value.index !== undefined && value.name !== undefined) {
        return { __type: "Layer", name: value.name, index: value.index };
      }
    } catch (e) {
      // Não é objeto do AE — segue como objeto comum.
    }

    var obj = {};
    for (var key in value) {
      if (!value.hasOwnProperty(key)) continue;
      if (typeof value[key] === "function") continue;
      try {
        obj[key] = vec.serializable(value[key]);
      } catch (e) {
        obj[key] = "<não serializável>";
      }
    }
    return obj;
  }

  return String(value);
};

// ---------------------------------------------------------------- despacho

/**
 * Executa uma ferramenta pelo nome.
 * @returns {{ok: Boolean, result: *, error: String}}
 */
vec.runTool = function (name, args) {
  var fn = vec.tools[name];

  if (typeof fn !== "function") {
    var disponiveis = [];
    for (var k in vec.tools) {
      if (vec.tools.hasOwnProperty(k)) disponiveis.push(k);
    }
    return {
      ok: false,
      error: 'Ferramenta desconhecida: "' + name + '". Disponíveis: ' + disponiveis.join(", ") + ".",
    };
  }

  try {
    return { ok: true, result: fn(args) };
  } catch (e) {
    return { ok: false, error: vec.describeError(e) };
  }
};

vec.describeError = function (e) {
  if (e && e.line !== undefined && e.fileName) {
    return e.toString() + " (" + e.fileName + ":" + e.line + ")";
  }
  return e && e.toString ? e.toString() : String(e);
};

function round3(n) {
  return Math.round(n * 1000) / 1000;
}


/*global app, Folder, File, Panel, Window, ScriptUI, vec*/

// ---------------------------------------------------------------- estado

/**
 * Cancela o polling de uma carga anterior nesta mesma engine.
 *
 * Abrir o painel duas vezes — o encaixado da instalação mais o flutuante do
 * Run Script File, por exemplo — reexecuta este arquivo na engine "vectorizeAE" e
 * substitui `vecBridge` por um objeto novo. A tarefa agendada pela carga anterior
 * continua viva, mas apontando para um estado que não existe mais: dois pollings
 * disputando a mesma pasta, e o log de um dos painéis congelado sem explicação.
 *
 * O id fica em $.global porque `var vecBridge` é reinicializado a cada carga, e
 * portanto não serve para lembrar do que veio antes.
 */
if ($.global.vecBridgeTaskId !== undefined && $.global.vecBridgeTaskId !== null) {
  try {
    app.cancelTask($.global.vecBridgeTaskId);
  } catch (e) {
    // A tarefa já pode ter sido cancelada; o que importa é não deixar duas.
  }
  $.global.vecBridgeTaskId = null;
}

var vecBridge = {
  running: false,
  taskId: null,
  processed: 0,
  errors: 0,
  ui: null,
  log: [],
  lastHeartbeat: 0,
  // null = ainda não sei se dá pra escrever dentro de res/. Ver vecWriteResult().
  resSubpastaOk: null,
  POLL_MS: 350,
};

/**
 * Pasta compartilhada com o servidor.
 *
 * `Folder.userData` devolve Application Support no macOS e AppData\Roaming no
 * Windows — o lado Node calcula o mesmo caminho, então os dois se encontram sem
 * precisar configurar nada.
 */
function vecBridgeDir() {
  var override = $.getenv("VECTORIZE_AE_BRIDGE_DIR");
  var base = override ? new Folder(override) : new Folder(Folder.userData.fsName + "/vectorize-ae/bridge");

  var cmd = new Folder(base.fsName + "/cmd");
  var res = new Folder(base.fsName + "/res");
  if (!cmd.exists) cmd.create();
  if (!res.exists) res.create();

  return { base: base, cmd: cmd, res: res };
}

// ---------------------------------------------------------------- ponte

function vecBridgeLog(message) {
  var hora = new Date().toTimeString().substring(0, 8);
  vecBridge.log.push(hora + "  " + message);

  // Um painel aberto o dia inteiro acumularia milhares de linhas.
  if (vecBridge.log.length > 60) vecBridge.log.shift();

  if (vecBridge.ui && vecBridge.ui.logBox) {
    vecBridge.ui.logBox.text = vecBridge.log.join("\n");
    // Sem isso o usuário fica olhando o começo do log enquanto o interessante
    // acontece no fim.
    try {
      vecBridge.ui.logBox.textselection = "";
    } catch (e) {}
  }
}

function vecBridgeStatus(text) {
  if (vecBridge.ui && vecBridge.ui.status) {
    vecBridge.ui.status.text = text;
  }
}

/**
 * Grava um arquivo e confere que o que ficou no disco é o que se pediu.
 *
 * `File.open`, `File.write` e `File.rename` do ExtendScript devolvem `false` em vez
 * de lançar erro. Ignorar o retorno — que é o que quase todo código de AE faz — deixa
 * a falha invisível: o arquivo aparece na pasta com zero byte e nada no log.
 *
 * A releitura existe porque nem o `write()` retornando `true` garante o conteúdo:
 * foi assim que o AE 2026 gravou `.tmp` vazios sem reclamar de nada.
 *
 * @returns {String|null} null se deu certo; a explicação da falha se não deu.
 */
function vecWriteVerified(file, text) {
  file.encoding = "UTF-8";

  if (!file.open("w")) return "open('w') devolveu false em " + file.fsName;

  var escreveu;
  try {
    escreveu = file.write(text);
  } finally {
    file.close();
  }

  if (escreveu === false) return "write() devolveu false em " + file.fsName;

  var conferencia = new File(file.fsName);
  conferencia.encoding = "UTF-8";
  if (!conferencia.open("r")) return "gravei mas não consigo reler " + file.fsName;

  var lido;
  try {
    lido = conferencia.read();
  } finally {
    conferencia.close();
  }

  if (lido !== text) {
    return "o disco ficou com " + lido.length + " de " + text.length +
      " caracteres em " + file.fsName;
  }

  return null;
}

/**
 * `vecWriteVerified` com as duas formas de falha unificadas.
 *
 * A gravação em `res/` no AE 2026 não devolve `false` — ela *lança*
 * "Object of type Function found where a Number, Array, or Property is needed",
 * que não tem relação nenhuma com o que se estava fazendo. Tratar só o retorno
 * deixaria a exceção passar por cima do plano B, que é justamente o que existe para
 * cobrir esse caso.
 */
function vecTentarEscrever(file, texto) {
  try {
    return vecWriteVerified(file, texto);
  } catch (e) {
    return vec.describeError(e) + " (em " + file.fsName + ")";
  }
}

/**
 * O JSON da resposta, ou uma resposta de erro montada à mão.
 *
 * Uma resposta de erro vale muito mais que um timeout. Sem isto, uma falha de
 * serialização deixa o servidor esperando 30s e concluindo "a ponte não respondeu" —
 * o que manda investigar a instalação do painel, que está perfeita. O texto é
 * concatenado à mão de propósito: depender de `vec.json` para relatar que `vec.json`
 * falhou não faria sentido.
 */
function vecTextoResposta(payload) {
  try {
    return vec.json(payload);
  } catch (e) {
    return '{"id":' + vec.quote(String(payload.id)) + ',"ok":false,"error":' +
      vec.quote("falhei ao serializar a resposta: " + vec.describeError(e)) + "}";
  }
}

/**
 * Escreve a resposta onde o servidor consiga achar.
 *
 * O caminho normal é `res/<id>.json`. O alternativo é `res-<id>.json` na raiz da
 * pasta da ponte, e existe por observação, não por elegância: no AE 2026 do macOS a
 * gravação dentro de `res/` falha — ora com arquivo de zero byte e `rename()`
 * devolvendo false, ora com uma exceção sem nexo — enquanto a mesma operação na raiz
 * funciona. É onde o heartbeat mora, e o heartbeat nunca falhou. Ler e apagar dentro
 * de `cmd/` também funciona; só a escrita em subpasta é que quebra.
 *
 * Não sei o motivo, e chutar um motivo errado custaria mais uma rodada de teste no
 * After Effects. O que dá pra fazer é tentar, conferir o que ficou no disco, e cair
 * para um caminho comprovado quando o primeiro não entregar.
 *
 * `resSubpastaOk` guarda o resultado da primeira tentativa. Sem isso, toda resposta
 * pagaria uma exceção antes de acertar o caminho, e o log encheria de aviso repetido.
 *
 * Sem o par `.tmp`+rename a leitura poderia pegar um JSON pela metade; quem cobre
 * esse risco é o lado Node, que trata JSON incompleto como "ainda não chegou" e
 * tenta de novo, em vez de estourar.
 */
function vecWriteResult(dirs, id, payload) {
  var texto = vecTextoResposta(payload);
  var alternativo = new File(dirs.base.fsName + "/res-" + id + ".json");

  if (vecBridge.resSubpastaOk === false) {
    var soAlternativo = vecTentarEscrever(alternativo, texto);
    if (soAlternativo) throw new Error(soAlternativo);
    return;
  }

  var principal = new File(dirs.res.fsName + "/" + id + ".json");
  var problema = vecTentarEscrever(principal, texto);

  if (!problema) {
    vecBridge.resSubpastaOk = true;
    return;
  }

  vecBridge.resSubpastaOk = false;

  // Um arquivo pela metade em res/ seria lido pelo servidor como resposta válida.
  try {
    if (principal.exists) principal.remove();
  } catch (e) {}

  var problemaAlt = vecTentarEscrever(alternativo, texto);
  if (problemaAlt) {
    throw new Error("res/: " + problema + " · raiz: " + problemaAlt);
  }

  vecBridgeLog("aviso: res/ recusou a escrita — respondendo pela raiz daqui em diante");
  vecBridgeLog("       (motivo: " + problema + ")");
}

function vecReadCommand(file) {
  file.encoding = "UTF-8";
  if (!file.open("r")) return null;

  var raw;
  try {
    raw = file.read();
  } finally {
    file.close();
  }

  // Consome antes de executar: se a execução travar o AE, o comando não fica pra
  // ser reexecutado no próximo start do painel.
  file.remove();

  try {
    return eval("(" + raw + ")");
  } catch (e) {
    vecBridgeLog("comando ilegível, descartado: " + e.toString());
    return null;
  }
}

/**
 * Marca de vida, gravada periodicamente na pasta da ponte.
 *
 * Existe porque não dá para perguntar "você está aí?" de dentro do After Effects:
 * um script rodando bloqueia a thread principal, que é a mesma que executa o
 * polling do painel. Qualquer diagnóstico que envie um comando e espere a resposta
 * trava justamente quem deveria responder.
 *
 * Com o heartbeat, basta olhar a idade do arquivo — sem esperar, sem bloquear.
 * O lado Node também usa isso para saber se vale a pena tentar um comando.
 */
function vecBridgeHeartbeat(dirs) {
  var agora = new Date().getTime();

  // Escrever a cada ciclo de 350ms seria disco à toa; 2s dá resolução de sobra
  // para diferenciar "vivo" de "morto".
  if (vecBridge.lastHeartbeat && agora - vecBridge.lastHeartbeat < 2000) return;
  vecBridge.lastHeartbeat = agora;

  try {
    var tmp = new File(dirs.base.fsName + "/heartbeat.json.tmp");
    tmp.encoding = "UTF-8";
    if (!tmp.open("w")) return;
    tmp.write(
      '{"at":' + agora +
      ',"afterEffects":' + vec.quote(app.version) +
      ',"processed":' + vecBridge.processed +
      ',"errors":' + vecBridge.errors + "}"
    );
    tmp.close();

    var alvo = new File(dirs.base.fsName + "/heartbeat.json");
    if (alvo.exists) alvo.remove();
    tmp.rename("heartbeat.json");
  } catch (e) {
    // Heartbeat é diagnóstico; falhar aqui não pode derrubar o polling.
  }
}

/**
 * Um ciclo de polling. Chamado por `app.scheduleTask` — precisa ser global.
 */
function vecBridgePoll() {
  if (!vecBridge.running) return;

  var dirs;
  try {
    dirs = vecBridgeDir();
  } catch (e) {
    vecBridgeLog("pasta da ponte inacessível: " + e.toString());
    return;
  }

  vecBridgeHeartbeat(dirs);

  var arquivos = dirs.cmd.getFiles("*.json");
  if (!arquivos || arquivos.length === 0) return;

  for (var i = 0; i < arquivos.length; i++) {
    var arquivo = arquivos[i];
    if (!(arquivo instanceof File)) continue;

    var comando = vecReadCommand(arquivo);
    if (!comando || !comando.id) continue;

    vecBridgeStatus("executando " + comando.tool + "…");
    vecBridgeLog("→ " + comando.tool);

    var resposta = vec.runTool(comando.tool, comando.args || {});

    try {
      vecWriteResult(dirs, comando.id, {
        id: comando.id,
        ok: resposta.ok,
        result: resposta.result,
        error: resposta.error,
      });
    } catch (e) {
      // Sem uma pista do que estava sendo serializado, um erro aqui é
      // indiagnosticável — foi exatamente o que aconteceu na primeira rodada.
      var pista;
      try {
        pista = " · ao serializar: " + String(vec.json(resposta)).substring(0, 200);
      } catch (e2) {
        pista = " · a própria serialização falhou: " + e2.toString();
      }
      vecBridgeLog("falhei ao responder: " + e.toString() + pista);
      continue;
    }

    if (resposta.ok) {
      vecBridge.processed++;
      vecBridgeLog("← ok");
    } else {
      vecBridge.errors++;
      vecBridgeLog("← erro: " + resposta.error);
    }
  }

  vecBridgeStatus(
    "ouvindo · " + vecBridge.processed + " ok" +
      (vecBridge.errors ? " · " + vecBridge.errors + " com erro" : "")
  );
}

function vecBridgeStart() {
  if (vecBridge.running) return;

  var dirs;
  try {
    dirs = vecBridgeDir();
  } catch (e) {
    vecBridgeLog("não consegui criar a pasta da ponte: " + e.toString());
    vecBridgeStatus("erro ao iniciar");
    return;
  }

  // Comandos de uma sessão anterior não interessam a ninguém, e executá-los
  // mexeria no projeto do usuário sem que ele tivesse pedido nada agora.
  var antigos = dirs.cmd.getFiles("*.json");
  for (var i = 0; i < antigos.length; i++) {
    try {
      antigos[i].remove();
    } catch (e) {}
  }
  if (antigos.length > 0) vecBridgeLog("descartei " + antigos.length + " comando(s) de sessão anterior");

  vecBridge.running = true;
  vecBridge.taskId = app.scheduleTask("vecBridgePoll()", vecBridge.POLL_MS, true);
  $.global.vecBridgeTaskId = vecBridge.taskId;

  vecBridgeStatus("ouvindo");
  vecBridgeLog("ponte ativa em " + dirs.base.fsName);

  if (vecBridge.ui && vecBridge.ui.toggle) vecBridge.ui.toggle.text = "Parar";
}

function vecBridgeStop() {
  if (!vecBridge.running) return;

  if (vecBridge.taskId !== null) {
    try {
      app.cancelTask(vecBridge.taskId);
    } catch (e) {}
    vecBridge.taskId = null;
    $.global.vecBridgeTaskId = null;
  }

  vecBridge.running = false;
  vecBridgeStatus("parado");
  vecBridgeLog("ponte parada");

  if (vecBridge.ui && vecBridge.ui.toggle) vecBridge.ui.toggle.text = "Iniciar";
}

// ---------------------------------------------------------------- interface

(function (thisObj) {
  function build(thisObj) {
    var win = thisObj instanceof Panel
      ? thisObj
      : new Window("palette", "Vectorize AE Bridge", undefined, { resizeable: true });

    win.orientation = "column";
    win.alignChildren = ["fill", "top"];
    win.spacing = 8;
    win.margins = 12;

    var topo = win.add("group");
    topo.alignChildren = ["left", "center"];
    topo.alignment = ["fill", "top"];

    var status = topo.add("statictext", undefined, "parado");
    status.alignment = ["fill", "center"];

    var toggle = topo.add("button", undefined, "Iniciar");
    toggle.preferredSize.width = 80;

    var logBox = win.add("edittext", undefined, "", { multiline: true, readonly: true, scrolling: true });
    logBox.preferredSize.height = 180;
    logBox.alignment = ["fill", "fill"];

    var rodape = win.add("group");
    rodape.alignment = ["fill", "bottom"];
    var abrirPasta = rodape.add("button", undefined, "Abrir pasta da ponte");
    abrirPasta.alignment = ["fill", "bottom"];

    vecBridge.ui = { win: win, status: status, toggle: toggle, logBox: logBox };

    toggle.onClick = function () {
      if (vecBridge.running) {
        vecBridgeStop();
      } else {
        vecBridgeStart();
      }
    };

    abrirPasta.onClick = function () {
      try {
        vecBridgeDir().base.execute();
      } catch (e) {
        vecBridgeLog("não consegui abrir a pasta: " + e.toString());
      }
    };

    win.onResizing = win.onResize = function () {
      this.layout.resize();
    };

    // Fechar o painel sem parar o polling deixa uma tarefa órfã rodando na engine
    // até o After Effects fechar.
    win.onClose = function () {
      vecBridgeStop();
      return true;
    };

    return win;
  }

  var win = build(thisObj);

  if (win instanceof Window) {
    win.center();
    win.show();
  } else {
    win.layout.layout(true);
  }

  vecBridgeLog("painel carregado — After Effects " + app.version);

  // Auto-inicia: se o painel está aberto, a intenção é escutar. Ter que clicar
  // "Iniciar" toda vez seria só uma etapa a mais para esquecer.
  vecBridgeStart();
})(this);

