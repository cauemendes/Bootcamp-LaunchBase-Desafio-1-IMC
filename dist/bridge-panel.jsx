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
 *   packages/jsx/lib/ae-frame.jsx
 *   packages/jsx/lib/ae-anim.jsx
 *   packages/jsx/lib/ae-image.jsx
 *   packages/jsx/lib/ae-footage.jsx
 *   packages/jsx/lib/ae-sequence.jsx
 *   packages/jsx/lib/ae-organize.jsx
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

/*global app, File*/

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

/**
 * Escapa uma string para JSON.
 *
 * ── Por que não uma tabela de escape ──────────────────────────────────────────
 * A versão anterior usava `var ESCAPES = {...}` e consultava `ESCAPES[ch]`. Isso
 * quebrou dentro do After Effects, e de um jeito difícil de rastrear: um objeto comum
 * herda de `Object.prototype`, então `ESCAPES[ch]` pode devolver um **método
 * herdado** em vez de `undefined`. O `if` aceita a função (é truthy) e a
 * concatenação seguinte estoura com
 *
 *     Object of type Function found where a Number, Array, or Property is needed
 *
 * — uma mensagem que não menciona string, nem JSON, nem escape, e que levou a
 * ponte inteira a parecer um problema de permissão de arquivo.
 *
 * Basta um script instalado no After Effects ter feito `Object.prototype.x = ...`
 * alguma vez para envenenar qualquer objeto usado como mapa. Comparação direta não
 * consulta cadeia de protótipo nenhuma, então o problema deixa de existir.
 */
vec.quote = function (str) {
  var s = String(str);
  var out = '"';

  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);

    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (ch < " ") {
      var code = ch.charCodeAt(0).toString(16);
      out += "\\u" + "0000".substring(code.length) + code;
    } else {
      out += ch;
    }
  }

  return out + '"';
};

/**
 * Silencia diálogos do After Effects durante uma operação longa.
 *
 * ── Por que isto é crítico e não cosmético ────────────────────────────────────
 * Diálogo modal congela a thread principal do After Effects, que é a mesma que roda o
 * polling do painel da ponte. E o script **não tem como fechar o diálogo**: para
 * clicar em OK ele precisaria rodar, e a thread que o executaria é exatamente a que
 * está bloqueada. Não existe saída por dentro — só evitar que o diálogo apareça.
 *
 * O que abre sem ser chamado: substituição de fonte, footage faltando, avisos da fila
 * de render sobre intervalo de tempo. Nenhum precisa de resposta para o trabalho
 * seguir, e qualquer um deles derruba uma execução sem ninguém na frente da máquina.
 *
 * Em try/catch porque isto é proteção, não função: se a API mudar de nome, o pior
 * resultado aceitável é ficar sem a proteção — nunca derrubar o que ela protegia.
 */
vec.suppressDialogs = function () {
  try {
    app.beginSuppressDialogs();
    return true;
  } catch (e) {
    return false;
  }
};

vec.restoreDialogs = function (silenciado) {
  if (!silenciado) return;
  try {
    // `false`: não despejar os alertas acumulados no fim. Eles não seriam lidos por
    // ninguém e ainda travariam o painel justamente na saída.
    app.endSuppressDialogs(false);
  } catch (e) {}
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
  var inner = group.property("ADBE Vectors Group");
  var cores = [];

  for (var i = 0; i < groupSpec.items.length; i++) {
    var item = groupSpec.items[i];

    if (item.kind === "geometry") {
      vec.addGeometry(inner, item.shape);
      vec.applyGeometryRotation(group, item.shape);
    } else if (item.kind === "stroke" || item.kind === "fill") {
      var eContorno = item.kind === "stroke";

      if (item.paint === "gradient") {
        vec.addGradient(inner, vecGradienteComPadrao(item, groupSpec), eContorno, opts);
        // As cores pretendidas viram parte do nome: o AE não deixa definir paradas de
        // gradiente por script, e sem isso o designer não tem como saber o que
        // colocar sem voltar à imagem de origem.
        cores.push(item.from + " → " + item.to);
      } else if (eContorno) {
        vec.addStroke(inner, item, opts);
      } else {
        vec.addFill(inner, item, opts);
      }
    }
  }

  var nome = vec.safeName(groupSpec.name, "Group");
  group.name = cores.length ? nome + " · " + cores.join(" / ") : nome;

  return group;
};

/**
 * Completa os pontos do gradiente quando o spec não os trouxe.
 *
 * Início e fim no mesmo lugar faz o After Effects renderizar cor chapada, e o
 * resultado parece que o gradiente não foi aplicado. A diagonal do próprio elemento é
 * o palpite mais útil: cobre a forma inteira e é o que um designer desenharia à mão.
 */
function vecGradienteComPadrao(item, groupSpec) {
  if (item.start && item.end) return item;

  var caixa = vecCaixaDoGrupo(groupSpec);
  if (caixa === null) return item;

  var copia = {};
  for (var k in item) {
    if (item.hasOwnProperty(k)) copia[k] = item[k];
  }

  copia.start = item.start || [caixa.x, caixa.y];
  copia.end = item.end || [caixa.x + caixa.w, caixa.y + caixa.h];
  return copia;
}

/** Caixa aproximada do elemento, a partir da geometria já normalizada. */
function vecCaixaDoGrupo(groupSpec) {
  for (var i = 0; i < groupSpec.items.length; i++) {
    var item = groupSpec.items[i];
    if (item.kind !== "geometry") continue;

    var f = item.shape;

    if (f.type === "rect") {
      return { x: f.cx - f.w / 2, y: f.cy - f.h / 2, w: f.w, h: f.h };
    }
    if (f.type === "ellipse") {
      return { x: f.cx - f.w / 2, y: f.cy - f.h / 2, w: f.w, h: f.h };
    }
    if (f.type === "star") {
      var r = f.outerRadius;
      return { x: f.cx - r, y: f.cy - r, w: r * 2, h: r * 2 };
    }
    if (f.type === "bezier" && f.subpaths && f.subpaths.length) {
      return vecCaixaDeSubpaths(f.subpaths);
    }
  }

  return null;
}

function vecCaixaDeSubpaths(subpaths) {
  var minX = null, minY = null, maxX = null, maxY = null;

  for (var i = 0; i < subpaths.length; i++) {
    var v = subpaths[i].vertices;
    for (var j = 0; j < v.length; j++) {
      var x = v[j][0];
      var y = v[j][1];
      if (minX === null || x < minX) minX = x;
      if (maxX === null || x > maxX) maxX = x;
      if (minY === null || y < minY) minY = y;
      if (maxY === null || y > maxY) maxY = y;
    }
  }

  if (minX === null) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

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

/**
 * Preenchimento ou contorno com gradiente nativo.
 *
 * ── O que dá e o que não dá ───────────────────────────────────────────────────
 * A geometria é scriptável: tipo (linear ou radial) e os pontos de início e fim. As
 * **paradas de cor não são**. `ADBE Vector Grad Colors` tem `propertyValueType` igual
 * a `NO_VALUE` — não é questão de descobrir o formato do array, o After Effects
 * simplesmente não expõe essa propriedade para script. Verificado no 26.3.
 *
 * Então o gradiente nasce com o preto-e-branco padrão do AE e o designer define as
 * duas cores em dois cliques. Para isso ele precisa saber quais são, e é por isso que
 * elas vão para o nome do grupo: "Fundo · #ff6200 → #161d26" aparece na timeline, do
 * lado de quem vai editar, sem precisar voltar à imagem original.
 *
 * O ponto inicial padrão é o canto superior esquerdo do conteúdo e o final o inferior
 * direito, porque um gradiente com os dois pontos no mesmo lugar é renderizado como
 * cor chapada e parece que nada aconteceu.
 */
vec.addGradient = function (inner, spec, isStroke, opts) {
  var matchName = isStroke
    ? "ADBE Vector Graphic - G-Stroke"
    : "ADBE Vector Graphic - G-Fill";

  var g = inner.addProperty(matchName);

  g.property("ADBE Vector Grad Type").setValue(spec.gradient === "radial" ? 2 : 1);

  if (spec.start) g.property("ADBE Vector Grad Start Pt").setValue(spec.start);
  if (spec.end) g.property("ADBE Vector Grad End Pt").setValue(spec.end);

  if (isStroke) {
    g.property("ADBE Vector Stroke Opacity").setValue(spec.opacity);
    g.property("ADBE Vector Stroke Width").setValue(spec.width);
    g.property("ADBE Vector Stroke Line Cap").setValue(vec.LINE_CAP[spec.cap] || vec.LINE_CAP.butt);
    g.property("ADBE Vector Stroke Line Join").setValue(vec.LINE_JOIN[spec.join] || vec.LINE_JOIN.miter);
  } else {
    g.property("ADBE Vector Fill Opacity").setValue(spec.opacity);
  }

  return g;
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
 * @param {Object} spec  { name, content, x, y, fontFamily, fontSize, weight, align,
 *                          letterSpacing, lineHeight, color, opacity }
 * @param {Object} opts  { gamma: Number }
 * @returns {{ layer: TextLayer, fontWarning: String|null }}
 */
vec.addTextLayer = function (comp, spec, opts) {
  var gamma = opts && opts.gamma ? opts.gamma : 1;

  var layer = comp.layers.addText(spec.content);
  layer.name = vec.safeName(spec.name, "Text");

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

  // ── Entrelinha ────────────────────────────────────────────────────────────
  // Sem `autoLeading = false` o After Effects ignora `leading` e usa 1,2 × o corpo.
  // Design costuma usar entrelinha mais fechada que isso, e a diferença aparece
  // exatamente onde é mais visível: texto de duas linhas dentro de um botão.
  //
  // Em try porque `leading` e `autoLeading` são propriedades relativamente novas do
  // TextDocument. Se faltarem, o texto sai com a entrelinha automática do AE — pior que
  // o pedido, e muito melhor que derrubar a camada inteira.
  if (spec.lineHeight) {
    try {
      doc.autoLeading = false;
      doc.leading = spec.lineHeight;
    } catch (e) {}
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
  var footage = [];
  var folders = [];

  // ── Pasta e seleção precisam aparecer ────────────────────────────────────────
  // "Renomeie as comps que estão nesta pasta" e "as que eu selecionei" são pedidos
  // normais, e sem estes dois campos quem for atender tem de descobrir a estrutura
  // escrevendo script no chute — arriscando renomear a comp errada num projeto com nomes
  // parecidos. A informação existe no DOM e custa uma linha cada.
  var selecionados = {};
  try {
    var sel = proj.selection;
    for (var s = 0; s < sel.length; s++) selecionados["id" + sel[s].id] = true;
  } catch (eSel) {
    // Projeto sem seleção, ou API indisponível: `selected` sai false em tudo.
  }

  function nomeDaPasta(item) {
    try {
      // A raiz do projeto também é um FolderItem, e chamá-la de pasta confundiria quem
      // for filtrar por pasta. null significa "está na raiz".
      if (!item.parentFolder || item.parentFolder === proj.rootFolder) return null;
      return item.parentFolder.name;
    } catch (e) {
      return null;
    }
  }

  for (var i = 1; i <= proj.numItems; i++) {
    var item = proj.item(i);
    var estaSelecionado = selecionados["id" + item.id] === true;

    if (item instanceof CompItem) {
      comps.push({
        name: item.name,
        id: item.id,
        width: item.width,
        height: item.height,
        frameRate: item.frameRate,
        duration: round(item.duration, 3),
        layers: item.numLayers,
        folder: nomeDaPasta(item),
        selected: estaSelecionado,
      });
    } else if (item instanceof FolderItem) {
      folders.push({
        name: item.name,
        id: item.id,
        items: item.numItems,
        folder: nomeDaPasta(item),
        selected: estaSelecionado,
      });
    } else {
      // O caminho em disco é o que torna a imagem utilizável: medir e enxergar
      // acontecem fora do After Effects, lendo o arquivo. Sem isto, uma referência
      // importada no projeto é invisível para quem for reconstruí-la — sobrava
      // pedir o caminho ao usuário ou vasculhar o disco no chute.
      var entrada = {
        name: item.name,
        id: item.id,
        width: item.width,
        height: item.height,
        // A duração é o que permite montar uma comp master casada com a locução sem
        // ninguém precisar medir o arquivo por fora. Sem ela, `fitToAudio` exigia um
        // número que só existia na cabeça de quem tinha aberto o áudio em outro lugar.
        duration: round(item.duration, 3),
        folder: nomeDaPasta(item),
        selected: estaSelecionado,
        file: null,
      };

      try {
        if (item.mainSource && item.mainSource.file) {
          entrada.file = item.mainSource.file.fsName;
        }
      } catch (e) {
        // Sólido, nulo e placeholder não têm arquivo — `file: null` já diz isso.
      }

      footage.push(entrada);
    }
  }

  var active = app.project.activeItem;

  return {
    open: true,
    file: proj.file ? proj.file.name : null,
    saved: !!proj.file,
    comps: comps,
    footageCount: footage.length,
    footage: footage,
    folderCount: folders.length,
    folders: folders,
    // Quantos itens estão selecionados no painel de projeto. Zero com um pedido do tipo
    // "as que eu selecionei" quer dizer que a seleção se perdeu — vale avisar em vez de
    // agir sobre o projeto inteiro.
    selectedCount: (function () {
      var n = 0;
      for (var k in selecionados) if (selecionados.hasOwnProperty(k)) n++;
      return n;
    })(),
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

    // O caminho em disco acompanha o nome porque é ele que serve para alguma coisa:
    // medir a imagem e enxergá-la acontece fora do After Effects, lendo o arquivo.
    // Dizer "a camada chama 11-1.png" sem dizer onde ela está deixa quem for
    // reconstruir procurando no disco.
    try {
      if (layer.source.mainSource && layer.source.mainSource.file) {
        resumo.sourceFile = layer.source.mainSource.file.fsName;
      }
    } catch (e) {
      // Sólido e comp aninhada não têm arquivo.
    }
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

// ── ae-frame.jsx ──
/**
 * Renderizar um frame para arquivo.
 *
 * ── Por que isto não é uma linha ──────────────────────────────────────────────
 * `comp.saveFrameToPng(tempo, arquivo)` é a forma documentada e deveria bastar. No
 * After Effects 26.3 do macOS o método existe, a chamada retorna sem lançar erro, e
 * nenhum arquivo aparece. Não é permissão: a mesma pasta aceita `File.write` na mesma
 * sessão. Testar `typeof comp.saveFrameToPng === "function"` não protege de nada.
 *
 * A única verificação que vale é olhar o disco depois. Quando não colar, o caminho
 * confiável é a fila de render — mais lenta, e ainda assim muito mais rápida que o
 * usuário descobrir sozinho que a imagem que ele está vendo é a de dois passos atrás.
 *
 * ── O que a fila exige de cuidado ─────────────────────────────────────────────
 * A fila de render é global e é do usuário. Enfileirar sem cuidado renderiza o que
 * já estava lá — possivelmente um projeto de horas. Por isso tudo que estava na fila
 * é desligado antes e restaurado depois, e o item criado aqui é sempre removido.
 */

/*global app, File, Folder, $, vec, RQItemStatus*/

var vec = vec || {};

/**
 * Onde os frames renderizados vão.
 *
 * NÃO é `Folder.temp`. No macOS ele resolve para `.../T/TemporaryItems`, uma pasta
 * especial do sistema onde a fila de render do After Effects roda e não entrega
 * arquivo — o sintoma foi "a fila rodou mas não encontrei o arquivo gerado".
 *
 * A pasta da ponte, por outro lado, é território conhecido: é onde o heartbeat e as
 * respostas são gravados o tempo todo, com sucesso, desde o primeiro dia. Trocar uma
 * pasta duvidosa por uma comprovada elimina a classe inteira de problema.
 */
function vecPastaDeFrames() {
  var override = $.getenv("VECTORIZE_AE_BRIDGE_DIR");
  var base = override ? override : Folder.userData.fsName + "/vectorize-ae/bridge";
  var pasta = new Folder(base + "/frames");

  if (!pasta.exists && !pasta.create()) {
    throw new Error("Não consegui criar a pasta de frames em " + pasta.fsName + ".");
  }

  return pasta;
}

/**
 * Apaga frames velhos.
 *
 * ── Por que a janela é curta ──────────────────────────────────────────────────
 * Cada `save_frame` deixa um PNG de tela cheia, e ele não pode ser apagado na hora: o
 * `measure_image` lê esse mesmo arquivo em seguida, e é dele que saem todas as medidas.
 * Apagar cedo quebraria a reconstrução; deixar acumular enche a máquina de quem usa com
 * megabytes num diretório que ninguém abre.
 *
 * Vinte minutos resolve os dois lados. Cinco era pouco: um frame também serve de
 * REFERÊNCIA a reconstruir, e uma reconstrução mede o mesmo arquivo várias vezes ao longo
 * de uma sessão inteira. Apagá-lo no meio faria a referência desaparecer com o trabalho
 * em andamento — e o erro apareceria como "não consigo ler o arquivo", longe da causa.
 *
 * Para referência de trabalho longo, o certo é passar `path` em `save_frame` e guardar o
 * frame fora desta pasta. Vinte minutos é a rede de segurança para quem não passou.
 */
function vecLimparFramesVelhos(pasta) {
  try {
    var limite = new Date().getTime() - 1200 * 1000;
    var arquivos = pasta.getFiles();

    for (var i = 0; i < arquivos.length; i++) {
      var f = arquivos[i];
      if (!(f instanceof File)) continue;
      if (f.modified && f.modified.getTime() < limite) {
        try {
          f.remove();
        } catch (e) {}
      }
    }
  } catch (e) {
    // Limpeza é cortesia; falhar aqui não pode impedir a renderização.
  }
}

vec.framesFolder = vecPastaDeFrames;
vec.pruneFrames = vecLimparFramesVelhos;

/** Alinha um tempo ao frame mais próximo — a fila recusa tempo fora da grade. */
function vecSnapToFrame(comp, time) {
  var passo = comp.frameDuration;
  var alinhado = Math.round(time / passo) * passo;

  // O último frame da comp é `duration - frameDuration`; pedir `duration` devolve
  // um span vazio e a fila renderiza nada, sem reclamar. `time` aqui é relativo ao
  // início da comp (base zero) — quem soma `displayStartTime` é a fila de render.
  var ultimo = comp.duration - passo;
  if (alinhado > ultimo) alinhado = ultimo;
  if (alinhado < 0) alinhado = 0;

  return alinhado;
}

/** O template de output que produz PNG, com o nome que esta instalação usa. */
function vecPngTemplate(om) {
  var nomes = om.templates;

  // Nome exato primeiro: em várias instalações existem vários templates com "PNG" no
  // nome e só um deles é o de sequência simples.
  var preferidos = ["PNG Sequence", "PNG", "PNG Sequence with Alpha"];
  var i, j;

  for (i = 0; i < preferidos.length; i++) {
    for (j = 0; j < nomes.length; j++) {
      if (nomes[j] === preferidos[i]) return nomes[j];
    }
  }

  for (j = 0; j < nomes.length; j++) {
    if (String(nomes[j]).toUpperCase().indexOf("PNG") !== -1) return nomes[j];
  }

  return null;
}

/**
 * Acha o arquivo que a fila realmente gravou.
 *
 * Sequência de imagem numera o arquivo — `quadro.png` vira `quadro_00042.png`, e o
 * número é o do frame na comp, não zero. Procurar pelo prefixo é o que funciona sem
 * depender do formato de numeração desta versão.
 */
/**
 * `Folder.name` vem com URI-encoding, e decodificar é o que permite comparar. Mas
 * `decodeURI` **lança exceção** num `%` solto — um arquivo chamado `100%.png` na
 * mesma pasta derrubava a busca inteira, não só aquela entrada. Um filtro que estoura
 * dentro de `getFiles` devolve lista vazia, e o sintoma vira "a fila rodou mas não
 * achei o arquivo": aponta para o render, quando o problema é a leitura da pasta.
 */
function vecNomeLegivel(f) {
  try {
    return decodeURI(f.name);
  } catch (e) {
    return String(f.name);
  }
}

/**
 * Acha o arquivo que a fila gravou.
 *
 * Sem callback no `getFiles`: listar tudo e filtrar aqui deixa a falha de uma entrada
 * isolada, em vez de contaminar o resultado inteiro.
 *
 * `desde` é a segunda tentativa. Se o nome não casar — porque o template numerou de
 * um jeito que não previmos, ou trocou a extensão — o arquivo mais novo que a pasta
 * ganhou depois do início do render ainda é a resposta certa. Vale mais que devolver
 * "não achei" quando o render funcionou.
 */
function vecAcharSaida(pasta, prefixo, desde) {
  var todos = pasta.getFiles();
  if (!todos) return null;

  var porPrefixo = [];
  var recentes = [];
  var i;

  for (i = 0; i < todos.length; i++) {
    var f = todos[i];
    if (!(f instanceof File)) continue;

    if (vecNomeLegivel(f).indexOf(prefixo) === 0) {
      porPrefixo.push(f);
    } else if (desde && f.modified && f.modified.getTime() >= desde) {
      recentes.push(f);
    }
  }

  var candidatos = porPrefixo.length ? porPrefixo : recentes;
  if (candidatos.length === 0) return null;

  // Mais de um só acontece se sobrou lixo de uma tentativa anterior; o mais novo é o
  // desta rodada.
  var escolhido = candidatos[0];
  for (i = 1; i < candidatos.length; i++) {
    if (candidatos[i].modified > escolhido.modified) escolhido = candidatos[i];
  }
  return escolhido;
}

/** O que a pasta tem, para a mensagem de erro não ser um beco sem saída. */
function vecListarPasta(pasta, limite) {
  var todos = pasta.getFiles();
  if (!todos || todos.length === 0) return "(vazia)";

  var nomes = [];
  for (var i = 0; i < todos.length && i < limite; i++) nomes.push(vecNomeLegivel(todos[i]));
  if (todos.length > limite) nomes.push("… e mais " + (todos.length - limite));

  return nomes.join(", ");
}

/** Renderiza um frame pela fila. Devolve o File gravado, ou lança erro explicando. */
function vecSaveFrameViaQueue(comp, time, destino) {
  var fila = app.project.renderQueue;

  if (fila.rendering) {
    throw new Error("A fila de render já está rodando — espere terminar e tente de novo.");
  }

  // A fila é do usuário: nada do que já estava lá pode ser renderizado por engano.
  var estados = [];
  var i;
  for (i = 1; i <= fila.numItems; i++) {
    var existente = fila.item(i);
    estados.push({ item: existente, render: existente.render });
    if (existente.status === RQItemStatus.QUEUED) existente.render = false;
  }

  var pasta = destino.parent;
  if (!pasta.exists) pasta.create();

  // Prefixo próprio para achar a saída depois sem confundir com outro arquivo.
  var prefixo = "vecframe" + new Date().getTime();
  // Um segundo de folga: `File.modified` tem resolução de segundo, e um arquivo
  // gravado no mesmo segundo do início ficaria de fora da comparação.
  var comecou = new Date().getTime() - 1000;
  var item = null;

  try {
    item = fila.items.add(comp);

    // `timeSpanStart` é no TEMPO DE EXIBIÇÃO da comp, não em zero.
    //
    // Uma comp com `displayStartTime` de 137,71s — coisa normal quando ela veio de uma
    // sequência maior — recebia `timeSpanStart = 4,79` e o After Effects abria um aviso:
    // "will cause render to have frames outside of range". Aviso é diálogo modal, e
    // diálogo modal congela a thread do polling: a ponte "perdia conexão" e a culpa
    // parecia ser da ponte.
    var inicioAbsoluto = comp.displayStartTime + time;

    item.timeSpanStart = inicioAbsoluto;
    item.timeSpanDuration = comp.frameDuration;

    var om = item.outputModule(1);
    var template = vecPngTemplate(om);
    if (template === null) {
      throw new Error(
        "Nenhum template de output em PNG nesta instalação. " +
          "Disponíveis: " + om.templates.join(", ")
      );
    }
    om.applyTemplate(template);
    om.file = new File(pasta.fsName + "/" + prefixo + ".png");

    item.render = true;
    fila.render();

    if (item.status === RQItemStatus.ERR_STOPPED) {
      throw new Error("A fila de render parou com erro ao gravar o frame.");
    }

    var gravado = vecAcharSaida(pasta, prefixo, comecou);
    if (gravado === null) {
      throw new Error(
        "A fila rodou mas não encontrei o arquivo gerado em " + pasta.fsName +
          ". Template usado: " + template + ". A pasta tem: " + vecListarPasta(pasta, 12)
      );
    }

    // O nome vem numerado pela sequência; quem chamou pediu um caminho específico.
    if (destino.exists) destino.remove();
    if (!gravado.rename(decodeURI(destino.name))) {
      // Renomear falhando não invalida o render — o arquivo existe, só com outro nome.
      return gravado;
    }

    return destino;
  } finally {
    if (item !== null) {
      try {
        item.remove();
      } catch (e) {}
    }
    for (i = 0; i < estados.length; i++) {
      try {
        estados[i].item.render = estados[i].render;
      } catch (e) {}
    }
  }
}

/**
 * Grava um frame da comp em PNG.
 *
 * @returns {{file: File, method: String}} `method` diz qual caminho funcionou — é o
 *   que permite descobrir, sem outra rodada de teste, se a API direta voltou a
 *   funcionar numa versão futura do After Effects.
 */
/**
 * Força resolução Full pela duração de uma operação, e devolve o que estava antes.
 *
 * ── Por que isto não é cosmético ──────────────────────────────────────────────
 * O seletor de resolução do painel de composição é `comp.resolutionFactor`: Half é
 * `[2,2]`, Third é `[3,3]`. Uma comp em Half exporta o frame com metade da largura e
 * da altura — e o frame exportado é a régua de todas as medições feitas em cima dele.
 *
 * O resultado de errar isso é o pior tipo: nada falha. As medidas saem coerentes entre
 * si e erradas por um fator constante, e a cena reconstruída sai proporcional e com
 * metade do tamanho. Um designer trabalhando em Half para ganhar velocidade — o caso
 * normal numa comp pesada — pagaria por isso sem nenhum aviso na tela.
 */
function vecForcarFull(comp) {
  var antes = null;

  try {
    antes = comp.resolutionFactor;
    if (antes && (antes[0] !== 1 || antes[1] !== 1)) comp.resolutionFactor = [1, 1];
  } catch (e) {
    // Sem acesso à propriedade, o melhor resultado aceitável é seguir sem a garantia.
    return null;
  }

  return antes;
}

function vecRestaurarResolucao(comp, antes) {
  if (!antes) return;
  try {
    comp.resolutionFactor = antes;
  } catch (e) {}
}

vec.saveFrame = function (comp, time, destino, metodo) {
  var alinhado = vecSnapToFrame(comp, time);
  // A fila de render é a operação mais propensa a diálogo de todo o projeto, e era a
  // única sem esta proteção. Foi por aqui que um aviso de intervalo de tempo derrubou
  // a ponte no meio de uma tarefa.
  var silenciado = vec.suppressDialogs();
  var resolucao = vecForcarFull(comp);

  try {
    return vecSaveFrameInterno(comp, alinhado, destino, metodo);
  } finally {
    vecRestaurarResolucao(comp, resolucao);
    vec.restoreDialogs(silenciado);
  }
};

/**
 * @param {String} [metodo]  "auto" (padrão), "direct" ou "queue".
 *
 * ── Por que dá para escolher o caminho ────────────────────────────────────────
 * Os dois falham, e falham em situações diferentes. `saveFrameToPng` às vezes retorna sem
 * erro e sem gravar nada. A fila de render, num projeto com footage de vídeo offline,
 * entrega PRETO SÓLIDO — arquivo válido, tamanho normal, imagem vazia.
 *
 * O segundo é muito pior que o primeiro: não gravar nada é detectável na hora, e preto
 * sólido passa por frame. Quem for medir cor nele recebe respostas coerentes e a cena sai
 * inteira escura, com a suspeita caindo na medição de cor.
 *
 * Por isso o caminho é escolhível: quem detectou preto de fora pode pedir o outro método
 * em vez de receber o mesmo preto de novo.
 */
function vecSaveFrameInterno(comp, alinhado, destino, metodo) {
  metodo = metodo || "auto";
  var motivo = null;

  if (metodo !== "queue" && typeof comp.saveFrameToPng === "function") {
    try {
      comp.saveFrameToPng(alinhado, destino);
    } catch (e) {
      // O texto da exceção é a única pista de por que o caminho documentado não colou.
      // Engolir sem guardar foi o que manteve isso um mistério por semanas.
      motivo = vec.describeError(e);
    }

    // A conferência no disco é o ponto inteiro desta função.
    var conferencia = new File(destino.fsName);
    if (conferencia.exists && conferencia.length > 0) {
      return { file: conferencia, method: "saveFrameToPng", time: alinhado };
    }

    if (motivo === null) {
      motivo = conferencia.exists
        ? "gravou um arquivo de zero byte"
        : "retornou sem erro e não gravou arquivo";
    }
  }

  if (metodo === "direct") {
    throw new Error(
      "saveFrameToPng não entregou o arquivo: " + motivo +
        ". Foi pedido method \"direct\", então não caí para a fila de render."
    );
  }

  return {
    file: vecSaveFrameViaQueue(comp, alinhado, destino),
    method: "renderQueue",
    time: alinhado,
    // Quem recebe isto fica sabendo por que o caminho rápido não foi usado. Sem essa
    // linha, "via renderQueue" parece escolha nossa em vez de consequência de uma falha.
    fallbackReason: motivo,
  };
}

/**
 * Por que este frame saiu de uma cor só.
 *
 * ── Por que isto existe ───────────────────────────────────────────────────────
 * Preto sólido tem duas causas que exigem respostas opostas, e de fora elas são
 * idênticas:
 *
 *   1. O render falhou. Footage offline na comp faz a fila de render entregar preto —
 *      arquivo válido, tamanho normal, imagem vazia.
 *   2. O frame É preto. Nenhuma camada visível naquele instante, porque o in-point
 *      ainda não chegou, a opacidade está em zero, ou tudo está desligado.
 *
 * Sem distinguir as duas, quem está do outro lado ou fica tentando renderizar de novo
 * um frame que está certo, ou ajusta o design achando que o problema é o design.
 *
 * A resposta aqui é factual de propósito: conta o que existe na comp naquele instante e
 * deixa a conclusão para quem lê. Chutar a causa e errar é pior que listar.
 */
vec.diagnoseFrame = function (comp, time) {
  var t = typeof time === "number" ? time : comp.time;
  var absoluto = comp.displayStartTime + t;

  var offline = [];
  var visiveis = [];
  var solados = 0;
  var desligadas = 0;
  var foraDoTempo = 0;
  var transparentes = 0;

  for (var i = 1; i <= comp.numLayers; i++) {
    var layer = comp.layer(i);

    // Footage que sumiu do disco é a causa nº 1 de preto vindo da fila de render, e o
    // AE não reclama: ele renderiza o buraco.
    try {
      if (layer.source && layer.source.footageMissing) offline.push(layer.name);
    } catch (e) {}

    try {
      if (layer.solo) solados++;
    } catch (e) {}

    var ativa = true;

    try {
      if (!layer.enabled) {
        desligadas++;
        ativa = false;
      }
    } catch (e) {}

    // in/out são medidos em tempo de comp, e `time` aqui chega relativo. Comparar os
    // dois sem alinhar acusa "fora do tempo" numa comp cujo displayStartTime não é zero.
    if (ativa) {
      try {
        if (absoluto < layer.inPoint || absoluto >= layer.outPoint) {
          foraDoTempo++;
          ativa = false;
        }
      } catch (e) {}
    }

    if (ativa) {
      try {
        var op = layer
          .property("ADBE Transform Group")
          .property("ADBE Opacity")
          .valueAtTime(absoluto, false);
        if (op <= 0) {
          transparentes++;
          ativa = false;
        }
      } catch (e) {}
    }

    if (ativa) visiveis.push(layer.name);
  }

  var conclusao;

  if (offline.length > 0) {
    conclusao =
      "Há footage offline na comp (" + offline.length + "). É a causa nº 1 de preto vindo " +
      "da fila de render: o After Effects renderiza o buraco sem reclamar. Relinke o " +
      "arquivo, ou desligue essas camadas antes de exportar o frame.";
  } else if (visiveis.length === 0) {
    conclusao =
      "Nenhuma camada está visível em " + absoluto + "s — o frame é preto de verdade, e " +
      "renderizar de novo vai dar preto de novo. Escolha outro instante, ou confira " +
      "in-point e opacidade das camadas.";
  } else if (solados > 0) {
    conclusao =
      solados + " camada(s) em solo. Só elas renderizam; se estiverem vazias naquele " +
      "instante, o resultado é uma cor só, mesmo com a comp cheia.";
  } else {
    conclusao =
      visiveis.length + " camada(s) deveriam aparecer em " + absoluto + "s. O frame não " +
      "deveria ter saído de uma cor só: isto parece falha de render, não a comp. Tente o " +
      "outro método em save_frame.";
  }

  return {
    comp: comp.name,
    time: t,
    displayTime: absoluto,
    layers: comp.numLayers,
    visibleLayers: visiveis,
    offlineFootage: offline,
    soloed: solados,
    disabled: desligadas,
    outsideTimeRange: foraDoTempo,
    fullyTransparent: transparentes,
    verdict: conclusao,
  };
};

// ── ae-anim.jsx ──
/**
 * Aplicar keyframes resolvidos pelo core.
 *
 * Este arquivo é deliberadamente burro: não decide timing, não escolhe easing, não
 * sabe o que é "entrada com overshoot". Recebe trilhas com frame, valor e influência
 * já calculados e as escreve no projeto. Toda a decisão está em
 * `packages/core/src/anim.js`, onde tem teste.
 */

/*global app, KeyframeEase, KeyframeInterpolationType, MaskMode, Shape, ShapeLayer, TextLayer, vec*/

/** Nome da máscara e do animator que criamos, para reusar em vez de empilhar. */
var VEC_REVEAL = "Vectorize Reveal";

var vec = vec || {};

/** Nome simbólico → onde a propriedade vive de verdade. */
function vecPropAnimavel(layer, nome) {
  var t = layer.property("ADBE Transform Group");

  if (nome === "position") return t.property("ADBE Position");
  if (nome === "scale") return t.property("ADBE Scale");
  if (nome === "rotation") return t.property("ADBE Rotate Z");
  if (nome === "opacity") return t.property("ADBE Opacity");
  if (nome === "anchorPoint") return t.property("ADBE Anchor Point");

  if (nome === "trimStart" || nome === "trimEnd" || nome === "trimOffset") {
    return vecTrimPaths(layer, nome);
  }

  if (nome === "textPosition") return vecAnimatorPosicao(layer);

  throw new Error("Propriedade animável desconhecida: " + nome);
}

/**
 * A posição do animator de texto, criando o animator se ele não existir.
 *
 * ── Por que não a posição da camada ───────────────────────────────────────────
 * Máscara é aplicada antes do transform. Mascarar a camada e animar a posição dela
 * arrasta o recorte junto, e o texto desliza inteiro em vez de aparecer atrás da
 * janela. O animator age no estágio do texto, antes da máscara: os glifos se movem, o
 * recorte fica parado. É a diferença entre o rig funcionar e parecer quebrado sem
 * nenhuma mensagem de erro.
 *
 * O animator ganha nome próprio para ser reusado — rodar de novo em cima da mesma
 * camada não deve empilhar animator novo a cada chamada.
 */
function vecAnimatorPosicao(layer) {
  if (!(layer instanceof TextLayer)) {
    throw new Error(
      'A camada "' + layer.name + '" não é de texto, e o preset revealIn depende do ' +
        "animator de texto. Para shape ou imagem, use slideIn — ou faça a máscara à mão " +
        "numa precomp, que é o equivalente fora do texto."
    );
  }

  var animadores = layer.property("ADBE Text Properties").property("ADBE Text Animators");
  var animador = null;
  var i;

  for (i = 1; i <= animadores.numProperties; i++) {
    if (animadores.property(i).name === VEC_REVEAL) {
      animador = animadores.property(i);
      break;
    }
  }

  if (animador === null) {
    animador = animadores.addProperty("ADBE Text Animator");
    animador.name = VEC_REVEAL;
    // Sem seletor o animator não afeta caractere nenhum: ele nasce vazio, e a
    // propriedade recebe keyframe que não muda nada na tela.
    animador.property("ADBE Text Selectors").addProperty("ADBE Text Selector");
  }

  var props = animador.property("ADBE Text Animator Properties");
  var pos = null;
  try {
    pos = props.property("ADBE Text Position 3D");
  } catch (e) {
    pos = null;
  }
  if (pos === null) pos = props.addProperty("ADBE Text Position 3D");

  return pos;
}

/** Retângulo da camada no espaço dela, no instante pedido. */
function vecRetangulo(layer, tempo) {
  var r = layer.sourceRectAtTime(tempo, false);
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

/**
 * A janela por onde o texto aparece.
 *
 * Folga em três lados e rente no quarto: rente do lado de onde o texto vem, porque
 * folga ali deixa o texto assomar antes da hora. Nos outros três a folga existe para
 * não raspar acento em cima nem perna de "g" embaixo.
 */
function vecCriarMascaraReveal(layer, setup, avisos) {
  var mascaras = layer.property("ADBE Masks");
  var mascara = null;
  var i;

  for (i = 1; i <= mascaras.numProperties; i++) {
    if (mascaras.property(i).name === VEC_REVEAL) {
      mascara = mascaras.property(i);
      break;
    }
  }

  if (mascara === null && mascaras.numProperties > 0) {
    avisos.push(
      '"' + layer.name + '" já tinha ' + mascaras.numProperties + " máscara(s). A janela " +
        "do revealIn entra somando a elas, então o resultado pode não ser o esperado."
    );
  }

  var r = vecRetangulo(layer, layer.inPoint);
  var pad = setup.padding || 0;

  var topo = r.top - pad;
  var esquerda = r.left - pad;
  var direita = r.left + r.width + pad;
  var base = r.top + r.height + pad;

  if (setup.from === "bottom") base = r.top + r.height;
  else if (setup.from === "top") topo = r.top;
  else if (setup.from === "left") esquerda = r.left;
  else if (setup.from === "right") direita = r.left + r.width;

  if (mascara === null) {
    mascara = mascaras.addProperty("ADBE Mask Atom");
    mascara.name = VEC_REVEAL;
  }

  var forma = new Shape();
  forma.vertices = [
    [esquerda, topo],
    [direita, topo],
    [direita, base],
    [esquerda, base],
  ];
  forma.closed = true;

  mascara.property("ADBE Mask Shape").setValue(forma);
  mascara.maskMode = MaskMode.ADD;

  return { top: topo, left: esquerda, bottom: base, right: direita };
}

/**
 * A propriedade de Trim Paths, criando o efeito se ele ainda não existir.
 *
 * Trim tem que vir **depois** do path dentro do grupo, senão não corta nada — é a
 * ordem de operações do shape layer, e a causa nº 1 de "apliquei trim e não
 * aconteceu nada".
 */
function vecTrimPaths(layer, nome) {
  if (!(layer instanceof ShapeLayer)) {
    throw new Error(
      'A camada "' + layer.name + '" não é shape layer — Trim Paths só existe em shape. ' +
        "Para camada de texto ou imagem, use outro preset."
    );
  }

  var conteudo = layer.property("ADBE Root Vectors Group");
  var trim = null;
  var i;

  // Procura em toda a árvore: o trim pode estar solto no conteúdo ou dentro do grupo
  // que a reconstrução criou.
  for (i = 1; i <= conteudo.numProperties; i++) {
    var item = conteudo.property(i);

    if (item.matchName === "ADBE Vector Filter - Trim") {
      trim = item;
      break;
    }

    if (item.matchName === "ADBE Vector Group") {
      var interno = item.property("ADBE Vectors Group");
      for (var j = 1; j <= interno.numProperties; j++) {
        if (interno.property(j).matchName === "ADBE Vector Filter - Trim") {
          trim = interno.property(j);
          break;
        }
      }
      if (trim) break;
    }
  }

  if (trim === null) {
    trim = conteudo.addProperty("ADBE Vector Filter - Trim");
  }

  if (nome === "trimStart") return trim.property("ADBE Vector Trim Start");
  if (nome === "trimEnd") return trim.property("ADBE Vector Trim End");
  return trim.property("ADBE Vector Trim Offset");
}

/** A camada pelo nome, ou null — `comp.layer(nome)` lança quando não acha. */
function vecCamadaPorNome(comp, nome) {
  try {
    return comp.layer(nome);
  } catch (e) {
    return null;
  }
}

/** Remove os keyframes que já existiam, do último para o primeiro. */
function vecLimparKeys(prop) {
  // De trás para frente: remover o primeiro reindexa os demais, e um laço crescente
  // pularia keyframes silenciosamente.
  for (var i = prop.numKeys; i >= 1; i--) prop.removeKey(i);
}

/**
 * Ajusta o valor da trilha à dimensão real da propriedade.
 *
 * O core trabalha com array sempre — `[100]` para opacidade, `[x, y]` para posição —
 * porque isso mantém uma regra só para todos os presets. O After Effects espera número
 * em propriedade de uma dimensão e array nas outras.
 */
function vecValorAe(prop, valores, base, modo) {
  var atual = prop.value;
  var dimensoes = atual instanceof Array ? atual.length : 1;

  if (dimensoes === 1) {
    var v = valores[0];
    return modo === "offset" ? base + v : v;
  }

  var out = [];
  for (var i = 0; i < dimensoes; i++) {
    var parte = i < valores.length ? valores[i] : 0;
    out.push(modo === "offset" ? base[i] + parte : parte);
  }
  return out;
}

/** Vetor de zeros, para zerar propriedade de dimensão desconhecida. */
function vecZeros(dimensoes) {
  var out = [];
  for (var i = 0; i < dimensoes; i++) out.push(0);
  return out;
}

/** Valores em unidade de camada viram pixel. */
function vecEmPixels(valores, escala) {
  var out = [];
  for (var i = 0; i < valores.length; i++) out.push(valores[i] * escala);
  return out;
}

/** Um KeyframeEase por dimensão — o AE recusa array de tamanho diferente. */
function vecEases(dimensoes, influencia) {
  var lista = [];
  for (var i = 0; i < dimensoes; i++) lista.push(new KeyframeEase(0, influencia));
  return lista;
}

/**
 * Escreve uma trilha na camada.
 *
 * @param {Object} track   { property, mode, keys: [{frame, value, easeIn, easeOut}] }
 */
function vecAplicarTrilha(comp, layer, track) {
  var prop = vecPropAnimavel(layer, track.property);

  if (prop === null) {
    throw new Error("A propriedade " + track.property + ' não existe em "' + layer.name + '".');
  }

  // Expressão vence keyframe: com uma expressão ativa, os keyframes que escrevemos
  // não teriam efeito nenhum e a falha seria invisível.
  if (prop.expression !== "" && prop.canSetExpression) {
    prop.expression = "";
  }

  vecLimparKeys(prop);

  var base = prop.value;
  var dimensoes = base instanceof Array ? base.length : 1;
  var i;

  // ── Unidade de camada ───────────────────────────────────────────────────────
  // O core diz "uma altura de camada" porque o tamanho do texto só existe dentro do
  // After Effects. Aqui isso vira pixel. A medida é tirada com a propriedade zerada:
  // sobra de uma execução anterior deslocaria os glifos e a altura sairia errada,
  // fazendo o texto começar meio visível — que é o defeito clássico deste rig.
  var escala = 1;
  if (track.unit === "layerHeight" || track.unit === "layerWidth") {
    try {
      prop.setValue(dimensoes === 1 ? 0 : vecZeros(dimensoes));
    } catch (e) {}

    base = prop.value;

    var r = vecRetangulo(layer, layer.inPoint);
    escala = track.unit === "layerHeight" ? r.height : r.width;

    if (!(escala > 0)) {
      throw new Error(
        'Não consegui medir "' + layer.name + '" — o retângulo saiu com ' + escala +
          " de tamanho. Camada de texto vazia mede zero; informe `distance` em pixels."
      );
    }
  }

  for (i = 0; i < track.keys.length; i++) {
    var k = track.keys[i];
    prop.setValueAtTime(
      k.frame / comp.frameRate,
      vecValorAe(prop, escala === 1 ? k.value : vecEmPixels(k.value, escala), base, track.mode)
    );
  }

  // O easing só pode ser aplicado depois de todos os keyframes existirem: o índice de
  // um keyframe muda conforme outros são inseridos antes dele.
  for (i = 0; i < track.keys.length; i++) {
    var chave = track.keys[i];
    var indice = i + 1;

    try {
      prop.setInterpolationTypeAtKey(
        indice,
        KeyframeInterpolationType.BEZIER,
        KeyframeInterpolationType.BEZIER
      );
      prop.setTemporalEaseAtKey(
        indice,
        vecEases(dimensoes, chave.easeIn),
        vecEases(dimensoes, chave.easeOut)
      );
    } catch (e) {
      // Propriedade que não aceita ease temporal (algumas são só hold) não invalida
      // o keyframe já escrito.
    }
  }

  // Posição em 2D ganha tangente espacial automática, o que curva o caminho entre
  // keyframes. Num slide reto isso aparece como uma barriga que ninguém pediu.
  if (track.property === "position" && dimensoes >= 2) {
    var zero = dimensoes === 3 ? [0, 0, 0] : [0, 0];
    for (i = 1; i <= prop.numKeys; i++) {
      try {
        prop.setSpatialTangentsAtKey(i, zero, zero);
      } catch (e) {}
    }
  }

  return prop.numKeys;
}

/**
 * Aplica um conjunto de trilhas.
 *
 * Erro numa camada não derruba as outras: um designer prefere sete camadas animadas e
 * um aviso a zero camadas e um stack trace.
 *
 * @returns {{ok, compName, applied, keyframes, masks, warnings}}
 */
vec.applyAnimation = function (tracks, options, setups) {
  options = options || {};
  setups = setups || [];

  var comp = vec.findComp(options.compName);
  var avisos = [];
  var aplicadas = 0;
  var keyframes = 0;
  var mascaras = 0;

  var silenciado = vec.suppressDialogs();
  app.beginUndoGroup("Vectorize AE - animation");

  try {
    // Montagem antes de keyframe: a máscara é medida com o texto parado, e criá-la
    // depois de escrever as chaves mediria o texto já deslocado.
    for (var s = 0; s < setups.length; s++) {
      var setup = setups[s];
      var alvo = vecCamadaPorNome(comp, setup.layer);

      if (alvo === null) {
        avisos.push('Camada não encontrada: "' + setup.layer + '" — máscara ignorada.');
        continue;
      }

      try {
        if (setup.kind === "revealMask") {
          vecCriarMascaraReveal(alvo, setup, avisos);
          mascaras++;
        }
      } catch (e) {
        avisos.push('"' + setup.layer + '" / máscara: ' + vec.describeError(e));
      }
    }

    for (var i = 0; i < tracks.length; i++) {
      var track = tracks[i];
      var layer = vecCamadaPorNome(comp, track.layer);

      if (layer === null) {
        avisos.push('Camada não encontrada: "' + track.layer + '" — trilha ignorada.');
        continue;
      }

      try {
        keyframes += vecAplicarTrilha(comp, layer, track);
        aplicadas++;
      } catch (e) {
        avisos.push('"' + track.layer + '" / ' + track.property + ": " + vec.describeError(e));
      }
    }
  } finally {
    vec.restoreDialogs(silenciado);
    app.endUndoGroup();
  }

  return {
    ok: aplicadas > 0,
    compName: comp.name,
    applied: aplicadas,
    keyframes: keyframes,
    masks: mascaras,
    warnings: avisos,
  };
};

// ── ae-image.jsx ──
/**
 * Camada de imagem: um arquivo colocado na caixa, ou um placeholder honesto.
 *
 * ── Por que isto existe ───────────────────────────────────────────────────────
 * Nem tudo numa arte é vetor. Uma fotografia redesenhada com shapes fica pior que um
 * espaço reservado — e um logo redesenhado a partir de print é pior ainda: existe
 * versão oficial, e a aproximação é uso indevido de marca.
 *
 * Então há dois caminhos, e a diferença entre eles é ter o arquivo ou não:
 *
 *   com `source`  → importa e posiciona na caixa medida
 *   sem `source`  → placeholder marcado, para o designer trocar pela imagem real
 *
 * ── O placeholder precisa gritar ──────────────────────────────────────────────
 * Um retângulo cinza discreto passa batido e vai para o cliente. Este vem com nome
 * prefixado, rótulo de cor laranja na timeline, e um comentário na camada dizendo o
 * que colocar ali. Três sinais, porque um só se perde numa comp de trinta camadas.
 */

/*global app, File, ImportOptions, vec*/

var vec = vec || {};

/**
 * Rótulos de cor da timeline usados pela ferramenta.
 *
 * Cor de rótulo é como um motion designer varre uma comp de longe. Reservar dois
 * valores para "isto não é vetor" transforma uma verificação item por item num olhar.
 */
vec.LABEL = {
  placeholder: 11, // laranja: falta trocar por imagem real
  asset: 3, // aqua: arquivo colocado, confira o enquadramento
};

/**
 * Se o arquivo é arte vetorial.
 *
 * O After Effects **não importa SVG** — nunca importou. Os formatos vetoriais que ele
 * lê são .ai, .eps e .pdf. Saber disso antes evita a descoberta pelo caminho ruim: o
 * import falha e a camada simplesmente não aparece.
 */
function vecEhVetor(arquivo) {
  var nome = decodeURI(arquivo.name).toLowerCase();
  return /\.(ai|eps|pdf)$/.test(nome);
}

/** Escala que faz a imagem cobrir ou caber na caixa, preservando proporção. */
vec.escalaParaCaixa = function (larguraFonte, alturaFonte, caixaW, caixaH, fit) {
  if (!larguraFonte || !alturaFonte) return [100, 100];

  var porX = (caixaW / larguraFonte) * 100;
  var porY = (caixaH / alturaFonte) * 100;

  if (fit === "stretch") return [porX, porY];

  // `cover` preenche a caixa e sobra fora; `contain` cabe inteira e sobra espaço.
  var fator = fit === "contain" ? Math.min(porX, porY) : Math.max(porX, porY);
  return [fator, fator];
};

/**
 * O item do projeto que já aponta para este arquivo, ou null.
 *
 * Importar duas vezes cria dois itens para o mesmo arquivo, e o painel de projeto
 * fica com duplicatas que o designer teria que limpar à mão.
 */
vec.itemPorArquivo = function (arquivo) {
  var alvo = arquivo.fsName;

  for (var i = 1; i <= app.project.numItems; i++) {
    var item = app.project.item(i);
    try {
      if (item.mainSource && item.mainSource.file && item.mainSource.file.fsName === alvo) {
        return item;
      }
    } catch (e) {}
  }

  return null;
};

/** Importa o arquivo, reaproveitando o item se ele já estiver no projeto. */
vec.importarArquivo = function (arquivo) {
  var existente = vec.itemPorArquivo(arquivo);
  if (existente !== null) return existente;

  return app.project.importFile(new ImportOptions(arquivo));
};

/**
 * Constrói a camada.
 *
 * @param {CompItem} comp
 * @param {Object} spec  { name, x, y, width, height, source, fit, label, opacity }
 * @returns {{layer: Layer, warning: String|null}}
 */
vec.addImageLayer = function (comp, spec, opts) {
  var aviso = null;

  if (spec.source) {
    var arquivo = new File(spec.source);

    if (/\.svg$/i.test(decodeURI(arquivo.name))) {
      aviso = 'SVG não é importável pelo After Effects: "' + spec.name + '" (' +
        arquivo.fsName + "). Converta para .ai ou .pdf, ou use PNG grande com " +
        "transparência. Entrou como placeholder.";
      return { layer: vecPlaceholder(comp, spec, aviso), warning: aviso };
    }

    if (!arquivo.exists) {
      // Caminho errado não pode virar camada silenciosamente ausente: cai para
      // placeholder e o aviso diz o caminho que faltou.
      aviso = 'File not found for "' + spec.name + '": ' + arquivo.fsName +
        " - added as a placeholder instead.";
      return { layer: vecPlaceholder(comp, spec, aviso), warning: aviso };
    }

    var item = vec.importarArquivo(arquivo);
    var layer = comp.layers.add(item);

    layer.name = vec.safeName(spec.name, "Image");
    layer.label = vec.LABEL.asset;
    layer.comment = "Placed by Vectorize AE - check the framing";

    // Arte vetorial precisa de rasterização contínua para escalar sem serrilhar. Sem
    // isto, um logo .ai colocado a 40% e depois ampliado num zoom sai borrado — e o
    // logo é justamente o elemento em que ninguém perdoa perda de qualidade.
    if (vecEhVetor(arquivo)) {
      try {
        layer.collapseTransformation = true;
      } catch (e) {
        // Nem todo tipo de footage aceita; não vale derrubar a colocação por isso.
      }
    }

    var t = layer.property("ADBE Transform Group");
    var escala = vec.escalaParaCaixa(
      item.width,
      item.height,
      spec.width,
      spec.height,
      spec.fit
    );

    // Âncora no centro do conteúdo e posição no centro da caixa: é o único par que
    // mantém a imagem centrada qualquer que seja a escala.
    t.property("ADBE Anchor Point").setValue([item.width / 2, item.height / 2]);
    t.property("ADBE Position").setValue([spec.x + spec.width / 2, spec.y + spec.height / 2]);
    t.property("ADBE Scale").setValue(escala);
    t.property("ADBE Opacity").setValue(spec.opacity);

    return { layer: layer, warning: null };
  }

  aviso = 'PLACEHOLDER: "' + spec.name + '" needs a real image' +
    (spec.label ? " (" + spec.label + ")" : "") + ".";

  return { layer: vecPlaceholder(comp, spec, aviso), warning: aviso };
};

/**
 * O retângulo que ocupa o lugar da imagem que falta.
 *
 * Shape layer e não solid: solid vira item no painel de projeto e polui a lista, e o
 * designer costuma apagar o placeholder em vez de reaproveitá-lo — deixar lixo no
 * projeto é pior que deixar uma camada.
 */
function vecPlaceholder(comp, spec, descricao) {
  var layer = comp.layers.addShape();

  layer.name = "[IMAGE] " + vec.safeName(spec.name, "Image");
  layer.label = vec.LABEL.placeholder;
  layer.comment = descricao + " Replace this layer with the real image and delete the placeholder.";

  var contents = layer.property("ADBE Root Vectors Group");
  var group = contents.addProperty("ADBE Vector Group");
  group.name = spec.label ? vec.safeName(spec.label, "Content") : "Image area";

  var inner = group.property("ADBE Vectors Group");

  vec.addRect(inner, {
    type: "rect",
    cx: spec.x + spec.width / 2,
    cy: spec.y + spec.height / 2,
    w: spec.width,
    h: spec.height,
    roundness: 0,
  });

  // Cinza médio com contorno: lê como "espaço reservado" em qualquer fundo, claro ou
  // escuro. Uma cor da marca aqui seria pior — pareceria parte do design.
  vec.addFill(inner, { color: "#8a8a8a", opacity: 35 }, {});
  vec.addStroke(
    inner,
    { color: "#8a8a8a", opacity: 100, width: 2, cap: "butt", join: "miter" },
    {}
  );

  var t = layer.property("ADBE Transform Group");
  t.property("ADBE Anchor Point").setValue([0, 0]);
  t.property("ADBE Position").setValue([0, 0]);

  return layer;
}

// ── ae-footage.jsx ──
/**
 * Trazer um arquivo pronto para dentro da comp — imagem ou vídeo.
 *
 * ── Por que isto existe, e por que é só isto ──────────────────────────────────
 * O que gera a imagem ou o vídeo não é esta ferramenta, e não deve ser. Quem gera é a
 * conversa: o Claude Code já tem MCPs de geração e de edição de imagem ligados, e
 * qual deles é permitido muda por empresa, por cliente e por mês. Amarrar um provedor
 * aqui dentro seria escolher hoje, no código, uma decisão que é de política.
 *
 * Então o contrato é o mais estreito possível: **um caminho em disco vira camada no
 * lugar certo, no tempo certo.** Qualquer provedor que saiba gravar um arquivo serve,
 * e trocar de provedor não é mudança de código.
 *
 * ── O que "no tempo certo" quer dizer ─────────────────────────────────────────
 * Imagem parada e vídeo se comportam diferente, e a diferença morde:
 *
 *   - Imagem parada dura o que você mandar. O After Effects dá a ela a duração padrão
 *     das preferências, que quase nunca é a que você quer.
 *   - Vídeo não estica. Pedir que ele cubra uma comp mais longa que ele encurta em
 *     silêncio, e o buraco no fim só aparece na renderização.
 *
 * Por isso o retorno diz o que aconteceu de verdade com o tempo, não o que foi pedido.
 */

/*global app, File, ImportOptions, vec*/

var vec = vec || {};

/** Segundos → frames, arredondando para a grade da comp. */
function vecEmFrames(segundos, fps) {
  return Math.round(segundos * fps);
}

/**
 * O que dá para saber do arquivo antes de colocá-lo.
 *
 * Isto vira resposta para o modelo. Sem `hasAlpha` ele não sabe se precisa de fundo;
 * sem `isStill` ele pede duração a um vídeo; sem `durationSeconds` ele monta a cena
 * inteira com o tempo errado e só descobre olhando.
 */
function vecDescreverFootage(item) {
  var fonte = null;
  try {
    fonte = item.mainSource;
  } catch (e) {
    fonte = null;
  }

  var parado = true;
  var alfa = false;
  try {
    parado = fonte ? fonte.isStill : true;
    alfa = fonte ? fonte.hasAlpha : false;
  } catch (e) {}

  var audio = false;
  try {
    audio = item.hasAudio;
  } catch (e) {}

  return {
    name: item.name,
    path: item.file ? item.file.fsName : null,
    width: item.width,
    height: item.height,
    durationSeconds: item.duration,
    frameRate: item.frameRate,
    isStill: parado,
    hasAlpha: alfa,
    hasAudio: audio,
  };
}

/**
 * Põe a camada na caixa: âncora no centro do conteúdo, posição no centro da caixa.
 *
 * É o único par que mantém a imagem centrada qualquer que seja a escala — e âncora
 * no centro também é o que faz `popIn` crescer no lugar em vez de pular para o canto.
 */
function vecEnquadrar(layer, item, caixa, fit, opacidade) {
  var escala =
    fit === "none"
      ? [100, 100]
      : vec.escalaParaCaixa(item.width, item.height, caixa.w, caixa.h, fit);

  var t = layer.property("ADBE Transform Group");
  t.property("ADBE Anchor Point").setValue([item.width / 2, item.height / 2]);
  t.property("ADBE Position").setValue([caixa.x + caixa.w / 2, caixa.y + caixa.h / 2]);
  t.property("ADBE Scale").setValue(escala);
  t.property("ADBE Opacity").setValue(opacidade);

  return escala;
}

/**
 * Coloca um arquivo do disco como camada.
 *
 * @param {Object} args  { path, compName, name, x, y, width, height, fit,
 *                         startFrame, durationFrames, fillComp, opacity, folderName }
 */
vec.importFootage = function (args) {
  args = args || {};

  if (!args.path) {
    throw new Error("import_footage precisa de `path` — o caminho completo do arquivo.");
  }

  var arquivo = new File(args.path);

  if (!arquivo.exists) {
    throw new Error(
      "Não achei o arquivo: " + arquivo.fsName + ". Confira o caminho — o After Effects " +
        "não procura em lugar nenhum além do que você mandar."
    );
  }

  // O AE nunca importou SVG, e o erro dele não diz isso: a importação falha e a camada
  // simplesmente não aparece. Recusar antes é a única forma de a mensagem ser útil.
  if (/\.svg$/i.test(decodeURI(arquivo.name))) {
    throw new Error(
      "O After Effects não importa SVG (" + arquivo.fsName + "). Os formatos vetoriais " +
        "que ele lê são .ai, .eps e .pdf. Para arte gerada, PNG grande com transparência " +
        "costuma ser o caminho mais curto."
    );
  }

  var comp = vec.findComp(args.compName);
  var avisos = [];
  var fps = comp.frameRate;

  var silenciado = vec.suppressDialogs();
  app.beginUndoGroup("Vectorize AE - import footage");

  var resultado;

  try {
    var jaEstava = vec.itemPorArquivo(arquivo) !== null;
    var item = vec.importarArquivo(arquivo);
    var info = vecDescreverFootage(item);

    var layer = comp.layers.add(item);
    layer.name = vec.safeName(args.name, item.name);
    layer.label = vec.LABEL.asset;
    layer.comment = "Imported by Vectorize AE - check the framing";

    // Arte vetorial sem rasterização contínua serrilha ao ampliar, e é justamente em
    // logo e ícone que ninguém perdoa isso.
    if (/\.(ai|eps|pdf)$/i.test(decodeURI(arquivo.name))) {
      try {
        layer.collapseTransformation = true;
      } catch (e) {}
    }

    // ── Enquadramento ─────────────────────────────────────────────────────────
    // Sem retângulo, a caixa é a comp inteira. É o que se quer num fundo gerado ou
    // numa placa de vídeo, que são os dois casos mais comuns.
    var temCaixa =
      vec.has(args, "x") && vec.has(args, "y") && vec.has(args, "width") && vec.has(args, "height");

    var caixa = temCaixa
      ? { x: args.x, y: args.y, w: args.width, h: args.height }
      : { x: 0, y: 0, w: comp.width, h: comp.height };

    var fit = args.fit || "contain";
    var escala = vecEnquadrar(layer, item, caixa, fit, vec.has(args, "opacity") ? args.opacity : 100);

    // ── Tempo ─────────────────────────────────────────────────────────────────
    var inicio = vec.has(args, "startFrame") ? Math.round(args.startFrame) : 0;
    layer.startTime = inicio / fps;

    var duracaoComp = vecEmFrames(comp.duration, fps);
    var pedido = null;

    if (args.fillComp === true) {
      layer.startTime = 0;
      pedido = duracaoComp;
      inicio = 0;
    } else if (vec.has(args, "durationFrames")) {
      pedido = Math.round(args.durationFrames);
    }

    if (pedido !== null) {
      if (pedido < 1) {
        throw new Error("durationFrames precisa ser >= 1 — recebi " + pedido + ".");
      }

      layer.inPoint = inicio / fps;
      layer.outPoint = (inicio + pedido) / fps;
    }

    // O outPoint é lido de volta em vez de assumido: vídeo não estica, e o AE encurta
    // sem avisar. Um buraco no fim da cena que só aparece na renderização é exatamente
    // o tipo de defeito que esta ferramenta existe para não produzir.
    var deFato = vecEmFrames(layer.outPoint - layer.inPoint, fps);

    if (pedido !== null && deFato < pedido) {
      avisos.push(
        'O vídeo "' + item.name + '" tem ' + deFato + " frames e você pediu " + pedido +
          ". Vídeo não estica: a camada ficou com o que existe, e sobra um buraco de " +
          (pedido - deFato) + " frames no fim. Para preencher, congele o último frame " +
          "(time remap) ou gere um clipe mais longo."
      );
    }

    if (info.hasAudio) {
      avisos.push(
        'A camada "' + layer.name + '" traz áudio junto. Se a locução já está na master, ' +
          "silencie ou desligue o áudio dela."
      );
    }

    if (args.folderName) {
      try {
        vec.moveToFolder({ folderName: args.folderName, itemIds: [item.id] });
      } catch (e) {
        avisos.push("Não consegui mover para a pasta: " + vec.describeError(e));
      }
    }

    resultado = {
      ok: true,
      comp: comp.name,
      layer: { name: layer.name, index: layer.index },
      source: info,
      reused: jaEstava,
      placed: {
        x: caixa.x,
        y: caixa.y,
        width: caixa.w,
        height: caixa.h,
        fit: fit,
        scale: escala[0],
      },
      timing: {
        startFrame: vecEmFrames(layer.inPoint, fps),
        durationFrames: deFato,
        compDurationFrames: duracaoComp,
      },
      warnings: avisos,
    };
  } finally {
    vec.restoreDialogs(silenciado);
    app.endUndoGroup();
  }

  return resultado;
};

/**
 * Remonta uma imagem achatada como várias camadas.
 *
 * ── O que isto resolve ────────────────────────────────────────────────────────
 * Um JPG de referência vira N recortes com alpha — cada elemento no seu PNG —, e o
 * designer quer os N de volta na comp exatamente onde estavam, empilhados na ordem
 * certa. Fazer isso à mão é importar, posicionar e conferir N vezes; o erro de um
 * pixel em cada um some no meio e só aparece quando algo anima.
 *
 * Quem recorta não é esta ferramenta — é a conversa, com o provedor que estiver
 * ligado. Aqui chega a lista já resolvida, com cada caixa medida no espaço do
 * canvas original, e o trabalho é mecânico: importar, escalar do canvas para a comp,
 * empilhar.
 *
 * ── Ordem ─────────────────────────────────────────────────────────────────────
 * A lista vem de cima para baixo, como se lê no painel de timeline. Como toda camada
 * nova entra no topo, o laço anda de trás para frente — assim o primeiro da lista
 * termina em cima, que é o que quem pediu espera.
 */
vec.importLayers = function (args) {
  args = args || {};

  var lista = args.layers;
  if (!(lista instanceof Array) || lista.length === 0) {
    throw new Error("import_layers precisa de `layers` com pelo menos um recorte.");
  }

  var comp = vec.findComp(args.compName);
  var avisos = [];

  // O canvas do recorte quase nunca é do tamanho da comp: o print veio de outra
  // resolução, ou o provedor reduziu a imagem antes de processar. Uma proporção só,
  // aplicada a todas as caixas, mantém a remontagem fiel.
  var canvasW = args.canvasWidth || comp.width;
  var canvasH = args.canvasHeight || comp.height;
  var k = comp.width / canvasW;

  if (Math.abs(comp.height / canvasH - k) > 0.01) {
    avisos.push(
      "O canvas dos recortes (" + canvasW + "x" + canvasH + ") tem proporção diferente da " +
        "comp (" + comp.width + "x" + comp.height + "). Usei a escala horizontal; confira " +
        "o alinhamento vertical."
    );
  }

  var silenciado = vec.suppressDialogs();
  app.beginUndoGroup("Vectorize AE - import layers");

  var colocadas = [];

  try {
    for (var i = lista.length - 1; i >= 0; i--) {
      var spec = lista[i];

      try {
        var arquivo = new File(spec.path);

        if (!arquivo.exists) {
          avisos.push('Não achei "' + spec.path + '" — camada ignorada.');
          continue;
        }

        var item = vec.importarArquivo(arquivo);
        var layer = comp.layers.add(item);

        layer.name = vec.safeName(spec.name, item.name);
        layer.label = vec.LABEL.asset;
        layer.comment = "Layer rebuilt by Vectorize AE";

        var caixa = {
          x: spec.x * k,
          y: spec.y * k,
          w: spec.width * k,
          h: spec.height * k,
        };

        vecEnquadrar(layer, item, caixa, "contain", vec.has(spec, "opacity") ? spec.opacity : 100);

        colocadas.push({
          name: layer.name,
          index: layer.index,
          x: Math.round(caixa.x),
          y: Math.round(caixa.y),
          width: Math.round(caixa.w),
          height: Math.round(caixa.h),
        });
      } catch (e) {
        avisos.push('"' + (spec.name || spec.path) + '": ' + vec.describeError(e));
      }
    }
  } finally {
    vec.restoreDialogs(silenciado);
    app.endUndoGroup();
  }

  // Invertido de volta: o laço andou de trás para frente, e quem lê a resposta espera
  // a mesma ordem que mandou.
  colocadas.reverse();

  return {
    ok: colocadas.length > 0,
    comp: comp.name,
    placed: colocadas.length,
    layers: colocadas,
    canvasScale: k,
    warnings: avisos,
  };
};

// ── ae-sequence.jsx ──
/**
 * Comp master: as cenas montadas numa timeline, com áudio e marcadores.
 *
 * ── O que isto entrega ────────────────────────────────────────────────────────
 * Um projeto onde o designer abre a comp master e já vê a estrutura do vídeo: cada
 * cena no seu tempo, o áudio embaixo, marcadores nomeando os momentos. O trabalho que
 * sobra é o que só ele sabe fazer — acertar o ritmo ouvindo, polir as entradas.
 *
 * O que isto NÃO tenta fazer é adivinhar o ritmo. As durações vêm do plano calculado
 * no core (roteiro, duração declarada, ou áudio), e ficam explicitamente sujeitas a
 * ajuste. Uma ferramenta que finge acertar o timing na primeira faz o designer
 * desconfiar de tudo.
 */

/*global app, File, ImportOptions, CompItem, MarkerValue, KeyframeInterpolationType, vec*/

var vec = vec || {};

/** A comp da cena, pelo nome. `null` quando não existe — quem chama decide o que fazer. */
function vecAcharComp(nome) {
  for (var i = 1; i <= app.project.numItems; i++) {
    var item = app.project.item(i);
    if (item instanceof CompItem && item.name === nome) return item;
  }
  return null;
}

/** Importa o áudio, reaproveitando o item se já estiver no projeto. */
function vecImportarAudio(caminho) {
  var arquivo = new File(caminho);
  if (!arquivo.exists) return null;

  for (var i = 1; i <= app.project.numItems; i++) {
    var item = app.project.item(i);
    try {
      if (item.mainSource && item.mainSource.file && item.mainSource.file.fsName === arquivo.fsName) {
        return item;
      }
    } catch (e) {}
  }

  return app.project.importFile(new ImportOptions(arquivo));
}

/**
 * Crossfade na entrada da cena.
 *
 * Só na entrada, e não na saída da anterior: as camadas se sobrepõem, então a de cima
 * aparecendo já revela a de baixo sumindo. Animar as duas dobraria o trabalho e
 * produziria um vale escuro no meio da transição, onde as duas estariam
 * semitransparentes ao mesmo tempo.
 */
function vecCrossfade(layer, inicioSegundos, duracaoSegundos) {
  var opacidade = layer.property("ADBE Transform Group").property("ADBE Opacity");

  opacidade.setValueAtTime(inicioSegundos, 0);
  opacidade.setValueAtTime(inicioSegundos + duracaoSegundos, 100);

  for (var i = 1; i <= opacidade.numKeys; i++) {
    try {
      opacidade.setInterpolationTypeAtKey(
        i,
        KeyframeInterpolationType.BEZIER,
        KeyframeInterpolationType.BEZIER
      );
    } catch (e) {}
  }
}

/**
 * Encaixa a comp da cena no quadro da master.
 *
 * ── Por que isto não pode ficar implícito ─────────────────────────────────────
 * `layers.add(comp)` coloca a comp em 100%, pixel a pixel. Quando a cena tem o mesmo
 * tamanho da master — o caso normal — isso está certo e nada acontece. Quando não tem,
 * o resultado é uma cena com tarja em volta ou estourando o quadro, e ninguém escreveu
 * uma linha pedindo isso. Foi assim que 54 cenas foram montadas erradas de uma vez.
 *
 * O padrão é caber inteiro (`contain`). `cover` preenche o quadro cortando o que sobra,
 * e cortar é irreversível: some conteúdo sem deixar rastro. Tarja é feia e visível, e
 * quem olha decide o que fazer. Entre errar de um jeito que aparece e errar de um jeito
 * que esconde, o que aparece é sempre melhor.
 */
function vecAjustarEscala(layer, compCena, plan, avisos) {
  var modo = plan.fit || "contain";
  if (modo === "none") return;

  if (compCena.width === plan.width && compCena.height === plan.height) return;

  var fx = plan.width / compCena.width;
  var fy = plan.height / compCena.height;
  var fator = modo === "cover" ? Math.max(fx, fy) : Math.min(fx, fy);

  layer.property("ADBE Transform Group").property("ADBE Scale").setValue([fator * 100, fator * 100]);

  avisos.push(
    compCena.name + ": a cena é " + compCena.width + "×" + compCena.height + " e a master é " +
      plan.width + "×" + plan.height + ". Escalei para " + Math.round(fator * 100) + "% (" +
      modo + ")." +
      (Math.abs(fx - fy) > 0.001
        ? " As proporções são diferentes, então " +
          (modo === "cover" ? "sobra conteúdo cortado fora do quadro." : "fica tarja em volta.")
        : "")
  );
}

/**
 * Monta a comp master.
 *
 * @param {Object} plan     { name, width, height, frameRate, totalFrames, audio, fit, scenes }
 * @returns {Object} relatório com avisos
 */
vec.buildSequence = function (plan, options) {
  options = options || {};

  var avisos = [];
  var fps = plan.frameRate;
  var nome = vec.safeName(plan.name, "Master");

  var silenciado = vec.suppressDialogs();
  app.beginUndoGroup("Vectorize AE - " + nome);

  try {
    var existente = vecAcharComp(nome);

    if (existente && !options.replace) {
      throw new Error(
        'Já existe uma composição chamada "' + nome + '". Use outro nome, ou passe ' +
          "`replace` para substituir — substituir apaga o que estiver nela."
      );
    }

    if (existente) existente.remove();

    var master = app.project.items.addComp(
      nome,
      plan.width,
      plan.height,
      1,
      plan.totalFrames / fps,
      fps
    );

    // O áudio entra primeiro para ficar no fundo da pilha: é o lugar em que um motion
    // designer espera encontrá-lo, e onde ele não atrapalha a leitura das cenas.
    if (plan.audio) {
      var itemAudio = vecImportarAudio(plan.audio);

      if (itemAudio === null) {
        avisos.push("Áudio não encontrado: " + plan.audio + " — a comp foi montada sem ele.");
      } else {
        var camadaAudio = master.layers.add(itemAudio);
        camadaAudio.startTime = 0;
        camadaAudio.name = "VO / Audio";
        camadaAudio.label = 16;

        if (itemAudio.duration > master.duration + 1 / fps) {
          avisos.push(
            "O áudio dura " + Math.round(itemAudio.duration * 10) / 10 + "s e a comp tem " +
              Math.round(master.duration * 10) / 10 + "s — parte do áudio fica fora."
          );
        }
      }
    }

    // Em ordem: cada camada nova entra no índice 1, então a última cena termina no
    // topo. É o que faz o crossfade funcionar — a que entra aparece SOBRE a que sai.
    var colocadas = 0;

    for (var i = 0; i < plan.scenes.length; i++) {
      var cena = plan.scenes[i];
      var compCena = vecAcharComp(cena.comp);

      if (compCena === null) {
        avisos.push('Composição não encontrada: "' + cena.comp + '" — cena pulada.');
        continue;
      }

      var layer = master.layers.add(compCena);
      vecAjustarEscala(layer, compCena, plan, avisos);

      var inicio = cena.startFrame / fps;

      // `startTime` desloca o conteúdo; `inPoint`/`outPoint` recortam. Os três juntos
      // fazem a cena começar do frame 0 dela no instante certo da master.
      layer.startTime = inicio;
      layer.inPoint = inicio;
      layer.outPoint = inicio + cena.durationFrames / fps;

      if (cena.transitionFrames > 0 && i > 0) {
        vecCrossfade(layer, inicio, cena.transitionFrames / fps);
      }

      // Marcador na comp, não na camada: é o que aparece na régua de tempo e permite
      // navegar o vídeo inteiro sem selecionar nada.
      try {
        master.markerProperty.setValueAtTime(inicio, new MarkerValue(cena.marker));
      } catch (e) {
        avisos.push("Não consegui criar o marcador de " + cena.comp + ": " + vec.describeError(e));
      }

      colocadas++;
    }

    if (colocadas === 0) {
      throw new Error(
        "Nenhuma das composições de cena foi encontrada no projeto. " +
          "Construa as cenas antes de montar a master."
      );
    }

    master.openInViewer();

    return {
      ok: true,
      compName: master.name,
      scenes: colocadas,
      durationFrames: plan.totalFrames,
      durationSeconds: Math.round((plan.totalFrames / fps) * 100) / 100,
      warnings: avisos,
    };
  } finally {
    vec.restoreDialogs(silenciado);
    app.endUndoGroup();
  }
};

// ── ae-organize.jsx ──
/**
 * Arrumação de projeto: renomear, mexer em propriedades de comp, organizar em pastas.
 *
 * ── Por que isto merece ferramenta, e não `execute_script` ────────────────────
 * São as tarefas em que o assistente é mais confiável — nada de medir imagem, nada de
 * julgar design, só mexer no DOM de forma mecânica. Justamente por isso não deveriam
 * passar por script escrito na hora: código improvisado erra de um jeito novo a cada vez,
 * e renomear em lote é operação que a pessoa só percebe depois de salvar.
 *
 * ── Por que tudo age por `id`, e não por nome ─────────────────────────────────
 * Nome não é único no After Effects. Num projeto com "SC01" e "SC01 old", agir por nome
 * renomeia a errada — e a pessoa descobre folheando 54 comps. `id` é do próprio DOM,
 * estável enquanto o projeto está aberto, e vem no `describe_project`.
 *
 * ── Por que devolve o antes ───────────────────────────────────────────────────
 * Cada operação relata o valor anterior. Um Ctrl+Z desfaz tudo, mas quem estava
 * acompanhando precisa saber o que mudou para conferir — e num lote de 54 renomeações,
 * "renomeei 54 itens" não é resposta.
 */

/*global app, CompItem, FolderItem, $, vec*/

var vec = vec || {};

/** Item do projeto por id. Erro que nomeia o id, porque é o que quem chamou tem em mão. */
function vecItemPorId(id) {
  for (var i = 1; i <= app.project.numItems; i++) {
    var item = app.project.item(i);
    if (item.id === id) return item;
  }

  throw new Error(
    "Não existe item com id " + id + " neste projeto. Os ids vêm de describe_project, e " +
      "mudam quando o projeto é fechado e reaberto."
  );
}

/**
 * Renomeia itens do projeto e camadas.
 *
 * @param {Object} args  { items: [{id, name}], layers: [{compName, layerIndex, name}] }
 */
vec.renameItems = function (args) {
  args = args || {};

  var itens = args.items || [];
  var camadas = args.layers || [];

  if (itens.length === 0 && camadas.length === 0) {
    throw new Error("rename_items precisa de pelo menos um item em `items` ou `layers`.");
  }

  var feitos = [];
  var avisos = [];
  var i;

  for (i = 0; i < itens.length; i++) {
    var pedido = itens[i];

    if (typeof pedido.name !== "string" || pedido.name === "") {
      avisos.push("item " + pedido.id + ": nome vazio — pulei.");
      continue;
    }

    try {
      var item = vecItemPorId(pedido.id);
      var antes = item.name;

      // O AE aceita nome repetido, e nome repetido é a origem de "renomeei e a errada
      // mudou" na próxima vez que alguém agir por nome. Avisar aqui é mais útil que
      // recusar: quem pediu pode ter motivo.
      item.name = vec.safeName(pedido.name, antes);

      feitos.push({ kind: "item", id: pedido.id, from: antes, to: item.name });
    } catch (e) {
      avisos.push(vec.describeError(e));
    }
  }

  for (i = 0; i < camadas.length; i++) {
    var pc = camadas[i];

    try {
      var comp = vec.findComp(pc.compName);
      var layer = vec.findLayer(comp, pc);
      var antesLayer = layer.name;

      layer.name = vec.safeName(pc.name, antesLayer);

      feitos.push({
        kind: "layer",
        comp: comp.name,
        index: layer.index,
        from: antesLayer,
        to: layer.name,
      });
    } catch (e) {
      avisos.push(vec.describeError(e));
    }
  }

  return { renamed: feitos, count: feitos.length, warnings: avisos };
};

/**
 * Muda propriedades de uma composição.
 *
 * ── Encurtar duração não apaga camada ─────────────────────────────────────────
 * O After Effects deixa as camadas onde estão; elas passam a existir fora do intervalo
 * visível. Nada se perde, e nada avisa — a comp simplesmente parece ter perdido conteúdo.
 * Por isso a resposta conta quantas camadas ficaram fora.
 */
vec.setCompSettings = function (args) {
  args = args || {};

  var comp = args.id ? vecItemPorId(args.id) : vec.findComp(args.compName);

  if (!(comp instanceof CompItem)) {
    throw new Error("O id " + args.id + " não é de uma composição.");
  }

  var antes = {
    name: comp.name,
    duration: comp.duration,
    frameRate: comp.frameRate,
    width: comp.width,
    height: comp.height,
  };

  var mudou = [];

  if (typeof args.name === "string" && args.name !== "") {
    comp.name = vec.safeName(args.name, antes.name);
    mudou.push("name");
  }

  if (typeof args.frameRate === "number" && args.frameRate > 0) {
    comp.frameRate = args.frameRate;
    mudou.push("frameRate");
  }

  // Largura e altura antes da duração: mudar tamanho não interfere no tempo, e mudar as
  // duas de uma vez num objeto só evita duas atualizações de layout da comp.
  if (typeof args.width === "number" && args.width > 0) {
    comp.width = Math.round(args.width);
    mudou.push("width");
  }

  if (typeof args.height === "number" && args.height > 0) {
    comp.height = Math.round(args.height);
    mudou.push("height");
  }

  var foraDoIntervalo = 0;

  if (typeof args.durationSeconds === "number" && args.durationSeconds > 0) {
    comp.duration = args.durationSeconds;
    mudou.push("duration");

    for (var i = 1; i <= comp.numLayers; i++) {
      if (comp.layer(i).inPoint >= comp.duration) foraDoIntervalo++;
    }
  }

  if (mudou.length === 0) {
    throw new Error(
      "Nada para mudar. Informe pelo menos um de: name, durationSeconds, frameRate, " +
        "width, height."
    );
  }

  return {
    comp: comp.name,
    id: comp.id,
    changed: mudou,
    before: {
      name: antes.name,
      duration: Math.round(antes.duration * 1000) / 1000,
      frameRate: antes.frameRate,
      width: antes.width,
      height: antes.height,
    },
    after: {
      name: comp.name,
      duration: Math.round(comp.duration * 1000) / 1000,
      frameRate: comp.frameRate,
      width: comp.width,
      height: comp.height,
    },
    layersOutOfRange: foraDoIntervalo,
  };
};

/**
 * Move itens para uma pasta, criando-a se preciso.
 *
 * A pasta é procurada por nome porque é assim que uma pessoa pensa nela, e criada quando
 * não existe — pedir para criar antes seria uma ida e volta a mais para o mesmo resultado.
 */
vec.moveToFolder = function (args) {
  args = args || {};

  var nome = args.folderName;
  if (typeof nome !== "string" || nome === "") {
    throw new Error("move_to_folder precisa de `folderName`.");
  }

  var ids = args.itemIds || [];
  if (ids.length === 0) {
    throw new Error("move_to_folder precisa de `itemIds` — os ids vêm de describe_project.");
  }

  var pasta = null;
  var i;

  for (i = 1; i <= app.project.numItems; i++) {
    var candidato = app.project.item(i);
    if (candidato instanceof FolderItem && candidato.name === nome) {
      pasta = candidato;
      break;
    }
  }

  var criada = false;
  if (pasta === null) {
    pasta = app.project.items.addFolder(vec.safeName(nome, "Folder"));
    criada = true;
  }

  var movidos = [];
  var avisos = [];

  for (i = 0; i < ids.length; i++) {
    try {
      var item = vecItemPorId(ids[i]);

      if (item === pasta) {
        avisos.push("a pasta não pode ser movida para dentro de si mesma — pulei.");
        continue;
      }

      var de = item.parentFolder && item.parentFolder !== app.project.rootFolder
        ? item.parentFolder.name
        : null;

      item.parentFolder = pasta;
      movidos.push({ id: ids[i], name: item.name, from: de });
    } catch (e) {
      avisos.push(vec.describeError(e));
    }
  }

  return {
    folder: pasta.name,
    folderId: pasta.id,
    created: criada,
    moved: movidos,
    count: movidos.length,
    warnings: avisos,
  };
};

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


/*global app, Folder, vec, CompItem*/

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

  var compName = vec.safeName(options.compName, "Vectorized Scene");

  // Um único grupo de undo para a cena inteira: o usuário desfaz com um Ctrl+Z, e
  // não com um por camada.
  var silenciado = vec.suppressDialogs();
  app.beginUndoGroup("Vectorize AE - " + compName);

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
        if (spec.type === "image") {
          var img = vec.addImageLayer(comp, spec, buildOpts);
          if (img.warning) warnings.push(img.warning);
        } else if (spec.type === "text") {
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
      // Quem decide salvar é o usuário. O que a ferramenta deve fazer é não deixar
      // isso passar em branco quando ele estiver produzindo em série: vinte telas numa
      // noite, o AE fechando, e nada em disco é o pior desfecho possível.
      projectFile: app.project && app.project.file ? app.project.file.fsName : null,
      suggestedSavePath: app.project && app.project.file
        ? null
        : Folder.desktop.fsName + "/" + vec.safeName(compName, "cena") + ".aep",
      layerCount: comp.numLayers,
      warnings: warnings,
    };
  } catch (e) {
    return { ok: false, error: vecDescribeError(e), warnings: warnings };
  } finally {
    vec.restoreDialogs(silenciado);
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
 * A gravação em si está em `vec.saveFrame`, que confere o disco depois de chamar a
 * API nativa e cai para a fila de render quando ela não entrega — no 26.3 do macOS
 * `saveFrameToPng` retorna sem erro e não grava nada.
 */
vec.tools.save_frame = function (args) {
  args = args || {};
  var comp = vec.findComp(args.compName);

  var time = typeof args.time === "number" ? args.time : comp.time;

  if (time < 0 || time > comp.duration) {
    throw new Error(
      "time " + time + "s está fora da duração da comp (0 a " + round3(comp.duration) + "s)."
    );
  }

  // `Folder.temp` no macOS cai em `.../T/TemporaryItems`, e a fila de render do AE
  // não entrega arquivo ali. A pasta da ponte é território comprovado.
  var pasta = vec.framesFolder();
  vec.pruneFrames(pasta);

  var destino = args.path
    ? new File(args.path)
    : new File(pasta.fsName + "/frame-" + new Date().getTime() + ".png");

  var saida = vec.saveFrame(comp, time, destino, args.method);

  return {
    path: saida.file.fsName,
    method: saida.method,
    fallbackReason: saida.fallbackReason || null,
    time: round3(saida.time),
    comp: comp.name,
    width: comp.width,
    height: comp.height,
  };
};

/**
 * Por que o frame saiu de uma cor só.
 *
 * Chamado só quando já saiu — não vale gastar uma varredura da comp em toda exportação
 * que deu certo.
 */
vec.tools.diagnose_frame = function (args) {
  args = args || {};
  var comp = vec.findComp(args.compName);
  return vec.diagnoseFrame(comp, typeof args.time === "number" ? args.time : comp.time);
};

// ---------------------------------------------------------------- construção

vec.tools.build_scene = function (args) {
  args = args || {};
  if (!args.scene) throw new Error("build_scene precisa de um SceneSpec normalizado em `scene`.");
  return vecBuildScene(args.scene, args.options || {});
};

/**
 * Salva o projeto.
 *
 * ── A armadilha que isto existe para evitar ───────────────────────────────────
 * `app.project.save()` num projeto que nunca foi salvo abre o diálogo de "salvar
 * como". Diálogo modal congela a thread principal do After Effects — que é a mesma
 * que roda o polling do painel. O comando nunca responde, todo comando seguinte dá
 * timeout, e nada na tela explica que a ponte está esperando um clique.
 *
 * Então: projeto sem arquivo exige `path`. Nunca deixamos o diálogo aparecer.
 */
vec.tools.save_project = function (args) {
  args = args || {};

  var jaTemArquivo = !!(app.project && app.project.file);

  if (!jaTemArquivo && !args.path) {
    throw new Error(
      "Este projeto nunca foi salvo, então preciso de um caminho completo em `path` " +
        "(terminando em .aep). Salvar sem caminho abriria um diálogo modal, que " +
        "congelaria a ponte esperando um clique."
    );
  }

  if (args.path) {
    var destino = new File(args.path);

    if (!/\.aep$/i.test(decodeURI(destino.name))) {
      throw new Error("O caminho precisa terminar em .aep — recebi: " + destino.fsName);
    }

    var pasta = destino.parent;
    if (!pasta.exists && !pasta.create()) {
      throw new Error("Não consegui criar a pasta " + pasta.fsName + ".");
    }

    var sobrescreveu = destino.exists;
    app.project.save(destino);

    return {
      path: app.project.file ? app.project.file.fsName : destino.fsName,
      overwrote: sobrescreveu,
      wasUnsaved: !jaTemArquivo,
    };
  }

  app.project.save();

  return {
    path: app.project.file.fsName,
    overwrote: true,
    wasUnsaved: false,
  };
};

vec.tools.build_sequence = function (args) {
  args = args || {};
  if (!args.plan) throw new Error("build_sequence precisa de um plano resolvido em `plan`.");
  return vec.buildSequence(args.plan, args.options || {});
};

vec.tools.animate = function (args) {
  args = args || {};
  if (!args.tracks || !(args.tracks instanceof Array)) {
    throw new Error("animate precisa de `tracks` — trilhas já resolvidas pelo core.");
  }
  return vec.applyAnimation(args.tracks, args.options || {}, args.setups || []);
};

// ---------------------------------------------------------------- material pronto

/**
 * Traz um arquivo do disco para dentro da comp.
 *
 * Quem gera a imagem ou o vídeo é a conversa, não esta ferramenta — o Claude Code já
 * tem provedores ligados, e qual deles é permitido é decisão de política, não de
 * código. Aqui o contrato é o mais estreito possível: caminho em disco vira camada.
 */
vec.tools.import_footage = function (args) {
  return vec.importFootage(args || {});
};

vec.tools.import_layers = function (args) {
  return vec.importLayers(args || {});
};

// ---------------------------------------------------------------- arrumação

/**
 * As três abaixo mexem no projeto sem julgar nada: renomear, mudar propriedade de comp,
 * mover para pasta. São as tarefas em que o assistente é mais confiável, e justamente por
 * isso não deveriam passar por `execute_script` — script escrito na hora erra de um jeito
 * novo a cada vez, e renomear em lote é o tipo de erro que só aparece depois de salvar.
 */

vec.tools.rename_items = function (args) {
  return vec.renameItems(args || {});
};

vec.tools.set_comp_settings = function (args) {
  return vec.setCompSettings(args || {});
};

vec.tools.move_to_folder = function (args) {
  return vec.moveToFolder(args || {});
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

  // ── Por que recusar em vez de tolerar ───────────────────────────────────────
  // Esta função embrulha o código em um grupo de undo, para o usuário desfazer tudo com
  // um Ctrl+Z. Grupo de undo no After Effects não aninha: se o código avaliado abrir o
  // seu, ou fechar o nosso, o balanço quebra e o AE mostra "Undo group mismatch, will
  // attempt to fix" — um diálogo modal, que congela a thread do polling e derruba a
  // ponte no meio da tarefa.
  //
  // Não há API para consultar profundidade de undo, então não dá para detectar depois.
  // Recusar antes é a única defesa, e é barata.
  if (args.code.indexOf("UndoGroup") !== -1) {
    throw new Error(
      "Este código chama beginUndoGroup ou endUndoGroup, e execute_script já embrulha " +
        "tudo o que você manda num único grupo de undo. Grupo de undo não aninha no " +
        "After Effects: abrir ou fechar um aqui quebra o balanço e faz o AE abrir um " +
        "diálogo modal, que trava a ponte. Remova essas chamadas — o undo em um passo " +
        "já está garantido."
    );
  }

  // ── Por que a fila de render é proibida aqui ────────────────────────────────
  // `save_frame` existe e já paga o preço de usar a fila de render: `timeSpanStart` em
  // tempo de exibição (`comp.displayStartTime + relativo`, e errar isso rende quadro em
  // branco), template de output em PNG achado por busca, pasta que a fila realmente
  // aceita gravar no macOS, resolução forçada para Full, diálogos silenciados, e
  // conferência do arquivo no disco depois.
  //
  // Código escrito na hora não tem como saber de nada disso, e reimplementá-lo aqui
  // reencontra exatamente as mesmas armadilhas — uma por uma, cada uma custando uma
  // rodada de diagnóstico. Foi o que aconteceu: o aviso "will cause render to have
  // frames outside of range" voltou depois de corrigido, porque a fila estava sendo
  // usada por fora do caminho que tinha a correção.
  if (args.code.indexOf("renderQueue") !== -1) {
    throw new Error(
      "Este código usa app.project.renderQueue. Use a ferramenta save_frame em vez " +
        "disso — ela já resolve o que a fila de render exige e que é fácil de errar: " +
        "timeSpanStart em tempo de exibição (comp.displayStartTime + tempo relativo, " +
        "senão o frame sai em branco), template de output em PNG, pasta que a fila " +
        "aceita no macOS, resolução Full forçada, diálogos silenciados e conferência do " +
        "arquivo no disco. Se save_frame falhar, relate a falha em vez de contornar: o " +
        "contorno reencontra todas essas armadilhas."
    );
  }

  var rotulo = args.label || "Vectorize AE - script";
  app.beginUndoGroup(rotulo);

  try {
    var resultado = eval(args.code);

    // O retorno vai virar JSON. Objetos do DOM do AE (camadas, comps, propriedades)
    // não serializam — descrever em vez de tentar.
    return { value: vec.serializable(resultado) };
  } catch (e) {
    // ── Por que a mensagem de erro fala do que ficou para trás ─────────────────
    // Script que para no meio não desfaz o que já fez. As camadas, os keyframes e os
    // efeitos criados até a linha que falhou continuam no projeto, e nada na tela diz
    // isso. Quem estava usando escreve a correção, roda de novo, e agora depura em
    // cima de resíduo: keyframes de uma tentativa antiga parecendo resultado da nova.
    //
    // Já custou uma rodada inteira de diagnóstico num efeito de glitch. O grupo de undo
    // sempre existiu e sempre desfez tudo em um passo — o que faltava era alguém dizer.
    throw new Error(
      vec.describeError(e) +
        "\n\nATENÇÃO: o script parou no meio, e o que ele já tinha feito CONTINUA no " +
        'projeto. Está tudo num grupo de undo só, chamado "' + rotulo + '": um Cmd+Z ' +
        "desfaz o parcial inteiro. Desfaça, ou confira a comp com describe_comp, ANTES " +
        "de tentar de novo — corrigir por cima do resíduo é como um defeito novo se " +
        "esconde."
    );
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
  // `vec.tools[name]` sozinho consultaria a cadeia de protótipo: um pedido para a
  // ferramenta "toString" ou "valueOf" acharia um método herdado, passaria no teste
  // de `typeof === "function"` e seria executado. O nome vem de fora, então isso é
  // entrada não confiável escolhendo o que rodar dentro do After Effects.
  var fn = vec.tools.hasOwnProperty(name) ? vec.tools[name] : null;

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

if ($.global.vecBridgeSupervisorId !== undefined && $.global.vecBridgeSupervisorId !== null) {
  try {
    app.cancelTask($.global.vecBridgeSupervisorId);
  } catch (e) {}
  $.global.vecBridgeSupervisorId = null;
}

// Também há um auto-início pendente (ver o fim do arquivo). Uma carga nova não pode
// deixar o agendamento da anterior de pé, ou dois deles brigam para iniciar a ponte.
if ($.global.vecBridgeAutoStartId !== undefined && $.global.vecBridgeAutoStartId !== null) {
  try {
    app.cancelTask($.global.vecBridgeAutoStartId);
  } catch (e) {}
  $.global.vecBridgeAutoStartId = null;
}

/**
 * O estado vive em `$.global`, não numa `var` deste arquivo.
 *
 * ── O defeito que isto conserta ───────────────────────────────────────────────
 * `var vecBridge = {...}` era refeito a cada carga do arquivo. Duas cargas na mesma
 * engine — o painel encaixado mais um flutuante, ou fechar e reabrir a aba — davam
 * dois objetos de estado, e o segundo apagava as contas do primeiro: `cycles` voltava
 * a zero, `running` voltava a false com o polling ainda rodando.
 *
 * Pior, `ui` era **um slot só**. O último painel carregado tomava o slot, e daí em
 * diante todo `vecBridgeStatus` e todo texto de botão iam para aquele painel — não
 * para o painel em que a pessoa clicou. O sintoma na tela era o pior possível: clicar
 * em Iniciar e o botão não mudar, sem erro nenhum, como se o clique tivesse sumido.
 *
 * `SCHEMA` existe porque uma versão nova deste arquivo pode carregar numa engine que
 * já tem o estado antigo, sem os campos novos. Aí é melhor recomeçar do zero do que
 * rodar com metade da estrutura.
 */
/**
 * Build deste painel. Precisa casar com `PANEL_BUILD_ESPERADO` no servidor.
 *
 * A engine `vectorizeAE` só relê este arquivo quando o After Effects sobe, então copiar
 * o arquivo novo com o AE aberto não troca o código que está rodando. Sem este número
 * isso é invisível: a correção está no disco, o defeito continua na tela, e a conclusão
 * natural é que a correção está errada.
 */
var VEC_PANEL_BUILD = 18;

var VEC_BRIDGE_SCHEMA = 3;

if (!$.global.vecBridgeState || $.global.vecBridgeState.schema !== VEC_BRIDGE_SCHEMA) {
  $.global.vecBridgeState = {
    schema: VEC_BRIDGE_SCHEMA,
    running: false,
    taskId: null,
    processed: 0,
    errors: 0,
    // Registro de painéis abertos, não um slot. Ver `vecBridgeCadaUI`.
    uis: [],
    log: [],
    lastHeartbeat: 0,
    lastPoll: 0,
    // Fim do último ciclo. Régua do bloqueio — ver `vecBridgePoll`.
    lastEnd: 0,
    cycles: 0,
    supervisorId: null,
    revivals: 0,
    startedAt: 0,
    // O auto-início é adiado (ver o fim do arquivo). Um clique no botão é decisão
    // explícita do usuário e cancela o agendamento pendente.
    autoStart: true,
    avisouHeartbeat: false,
    // null = ainda não sei se dá pra escrever dentro de res/. Ver vecWriteResult().
    resSubpastaOk: null,

    // ── Ritmo do polling ──────────────────────────────────────────────────────
    // Verificar a pasta a cada 350ms parece inofensivo e não é: cada verificação é uma
    // execução de script, e o After Effects **recusa** executar script enquanto há um
    // diálogo modal esperando resposta — recusa mostrando outro diálogo, "Cannot run a
    // script while a modal dialog is waiting for response". A 350ms isso são 171
    // diálogos de erro por minuto de diálogo aberto.
    //
    // O estrago não fica na ponte: qualquer script do usuário que abra uma janela
    // própria — Motion, Ease and Wizz, um painel qualquer — fica inutilizável enquanto a
    // ponte estiver escutando. A ferramenta não pode atrapalhar as outras ferramentas da
    // pessoa.
    //
    // Daí três velocidades. Ocioso é lento, porque ninguém está esperando nada.
    // Trabalhando é rápido, porque comando vem em rajada. E recuo é o que entra em cena
    // quando um bloqueio é detectado, dobrando até o teto. Ver `vecBridgeRitmo`.
    intervalo: 2000,
    IDLE_MS: 2000,
    BUSY_MS: 250,
    MAX_MS: 16000,
    // Bloqueios seguidos que fazem a ponte sair da frente de vez. Ver `vecBridgeRitmo`.
    //
    // Três, e não cinco: cada bloqueio é um diálogo de erro na tela de quem está
    // tentando usar outro script, então o número é literalmente quantos erros a pessoa
    // vê antes de a ponte sumir. Cinco só se justificava enquanto um comando demorado
    // podia ser confundido com bloqueio — o que a régua do `lastEnd` resolveu.
    LIMITE_BLOQUEIOS: 3,
    pausadaPorBloqueio: false,
    // Depois de um comando, vale continuar rápido por um tempo: uma conversa com o
    // servidor manda dezenas de comandos seguidos, não um isolado.
    BUSY_JANELA: 60000,
    busyUntil: 0,
    // Quantos bloqueios seguidos, e quantos ciclos limpos desde o último.
    bloqueios: 0,
    limpos: 0,
    avisouBloqueio: false,
  };
}

var vecBridge = $.global.vecBridgeState;

// Uma carga nova sempre reabre a possibilidade de auto-iniciar: se o arquivo está
// sendo executado, alguém abriu o painel agora.
vecBridge.autoStart = true;

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

/**
 * Lembra, entre sessões do After Effects, se a ponte deve escutar.
 *
 * ── Por que isto não é conforto, é segurança ──────────────────────────────────
 * Painel encaixado volta com o workspace: abrir o After Effects para trabalhar já
 * trazia a ponte escutando, sem ninguém ter pedido. E ponte escutando atropela os
 * outros scripts do usuário, porque o AE recusa executar script com diálogo na tela e
 * mostra um erro a cada verificação. Ou seja: o auto-início transformava "abri o AE
 * para usar o Motion" em "o Motion parou de funcionar".
 *
 * Com a preferência gravada, um clique em Parar vale para as próximas sessões também —
 * é um interruptor de verdade. E um lote noturno em andamento sobrevive a um reinício
 * do aplicativo, porque a última escolha foi "escutando".
 *
 * O padrão de instalação nova é **não** escutar. Escutar é a opção que pode incomodar;
 * ela tem que ser pedida.
 */
function vecBridgePrefFile() {
  return new File(vecBridgeDir().base.fsName + "/panel-pref.json");
}

function vecBridgeLerPref() {
  try {
    var f = vecBridgePrefFile();
    if (!f.exists) return false;

    f.encoding = "UTF-8";
    if (!f.open("r")) return false;

    var texto;
    try {
      texto = f.read();
    } finally {
      f.close();
    }

    // Comparação de substring em vez de eval: o arquivo é escrito por nós, tem uma
    // chave só, e avaliar conteúdo de disco para ler um booleano seria desproporcional.
    return String(texto).indexOf('"escutando":true') !== -1;
  } catch (e) {
    return false;
  }
}

function vecBridgeGravarPref(escutando) {
  try {
    var f = vecBridgePrefFile();
    f.encoding = "UTF-8";
    if (!f.open("w")) return;
    try {
      f.write('{"escutando":' + (escutando ? "true" : "false") + "}");
    } finally {
      f.close();
    }
  } catch (e) {
    // Preferência é conveniência: perdê-la custa um clique, não uma sessão.
  }
}

// ---------------------------------------------------------------- ponte

/**
 * Aplica algo a todos os painéis abertos, e esquece os que morreram.
 *
 * Escrever numa widget de painel já destruído lança. Antes de existir o registro isso
 * era um risco só; com N painéis passa a ser certeza, porque fechar uma aba não avisa
 * ninguém. Cada escrita que falha remove aquele painel da lista — a UI se limpa sozinha
 * em vez de precisar de bookkeeping perfeito no fechamento.
 */
function vecBridgeCadaUI(fn) {
  var vivos = [];

  for (var i = 0; i < vecBridge.uis.length; i++) {
    var ui = vecBridge.uis[i];

    try {
      fn(ui);
      ui.falhas = 0;
      vivos.push(ui);
    } catch (e) {
      // ── Por que não podar na primeira falha ───────────────────────────────
      // A versão anterior tirava o painel do registro em qualquer exceção. Isso
      // confunde duas coisas muito diferentes: painel destruído, que nunca mais aceita
      // escrita, e falha passageira — o After Effects refazendo o layout durante a
      // subida do aplicativo, um diálogo de erro de outro script na frente.
      //
      // Podar por uma falha passageira produz o sintoma mais confuso que este painel
      // já teve: o botão para de responder para sempre. O clique roda, o estado muda,
      // a ponte liga e desliga de verdade — e o rótulo nunca mais acompanha, porque o
      // painel saiu da lista de quem recebe atualização. Quem olha vê um botão morto.
      ui.falhas = (ui.falhas || 0) + 1;
      if (ui.falhas < 3) vivos.push(ui);
    }
  }

  vecBridge.uis = vivos;
}

/**
 * Garante que este painel está no registro.
 *
 * Um painel em que alguém acabou de clicar está vivo, por definição. Se ele não estiver
 * na lista — podado por falhas, ou de uma carga anterior do arquivo —, o lugar certo de
 * corrigir isso é aqui, onde há prova de vida.
 */
function vecBridgeGarantirUI(ui) {
  for (var i = 0; i < vecBridge.uis.length; i++) {
    if (vecBridge.uis[i] === ui) {
      ui.falhas = 0;
      return;
    }
  }

  ui.falhas = 0;
  vecBridge.uis.push(ui);
}

function vecBridgeLog(message) {
  var hora = new Date().toTimeString().substring(0, 8);
  vecBridge.log.push(hora + "  " + message);

  // Um painel aberto o dia inteiro acumularia milhares de linhas.
  if (vecBridge.log.length > 60) vecBridge.log.shift();

  var texto = vecBridge.log.join("\n");

  vecBridgeCadaUI(function (ui) {
    ui.logBox.text = texto;
    // Sem isso o usuário fica olhando o começo do log enquanto o interessante
    // acontece no fim.
    try {
      ui.logBox.textselection = "";
    } catch (e) {}
  });
}

/**
 * Descreve um erro sem nunca poder lançar.
 *
 * ── Por que isto não é paranoia ───────────────────────────────────────────────
 * O painel tem três camadas de captura, e todas as três chamavam `vec.describeError(e)`
 * ao montar a mensagem. O argumento é avaliado antes da chamada, então se
 * `describeError` lançasse — `vec` não carregado, uma versão sem o método —, a exceção
 * escapava do catch que devia relatá-la, subia para o catch de cima, lançava de novo
 * ali, e terminava no `catch (e2) {}` que engole. Resultado: a falha original
 * desaparecia sem uma linha de log.
 *
 * Um relator de erro que pode lançar não é um relator de erro.
 */
function vecBridgeMotivo(e) {
  try {
    return vec.describeError(e);
  } catch (semVec) {}

  try {
    return String(e);
  } catch (semString) {}

  return "erro que não consegui descrever";
}

function vecBridgeStatus(text) {
  vecBridgeCadaUI(function (ui) {
    ui.status.text = text;
  });
}

/**
 * Sincroniza o rótulo do botão em todos os painéis com o estado real da ponte.
 *
 * Existe como função própria porque `running` pode mudar sem clique — o supervisor
 * reanima, uma carga nova assume o estado — e um botão dizendo "Iniciar" com a ponte
 * ligada é pior que inútil: convida o usuário a desligar pensando que está ligando.
 */
function vecBridgeRefreshUI() {
  var rotulo = vecBridge.running ? "Parar" : "Iniciar";

  vecBridgeCadaUI(function (ui) {
    ui.toggle.text = rotulo;
  });
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
  // O rótulo de etapa existe porque o erro que apareceu aqui no AE 2026 —
  // "Object of type Function found where a Number, Array, or Property is needed" —
  // não descreve nada do que o código estava fazendo, e nem sempre traz linha. Sem
  // saber em qual passo ele estoura, cada tentativa de correção é um chute.
  var etapa = "início";

  try {
    etapa = "serializar a resposta";
    var texto = vecTextoResposta(payload);

    etapa = "montar o caminho da raiz";
    var alternativo = new File(dirs.base.fsName + "/res-" + id + ".json");

    if (vecBridge.resSubpastaOk === false) {
      etapa = "gravar na raiz (res/ já reprovada antes)";
      var soAlternativo = vecTentarEscrever(alternativo, texto);
      if (soAlternativo) throw new Error(soAlternativo);
      return;
    }

    etapa = "montar o caminho de res/";
    var principal = new File(dirs.res.fsName + "/" + id + ".json");

    etapa = "gravar em res/";
    var problema = vecTentarEscrever(principal, texto);

    if (!problema) {
      vecBridge.resSubpastaOk = true;
      return;
    }

    vecBridge.resSubpastaOk = false;

    // Um arquivo pela metade em res/ seria lido pelo servidor como resposta válida.
    etapa = "limpar o arquivo incompleto em res/";
    try {
      if (principal.exists) principal.remove();
    } catch (eLimpeza) {}

    etapa = "gravar na raiz depois de res/ falhar";
    var problemaAlt = vecTentarEscrever(alternativo, texto);
    if (problemaAlt) {
      throw new Error("res/: " + problema + " · raiz: " + problemaAlt);
    }

    vecBridgeLog("aviso: res/ recusou a escrita — respondendo pela raiz daqui em diante");
    vecBridgeLog("       (motivo: " + problema + ")");
  } catch (e) {
    throw new Error("[etapa: " + etapa + "] " + vec.describeError(e));
  }
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
function vecBridgeHeartbeat(dirs, forcar) {
  var agora = new Date().getTime();

  // Escrever a cada ciclo de 350ms seria disco à toa; 2s dá resolução de sobra
  // para diferenciar "vivo" de "morto". `forcar` existe para o heartbeat final,
  // gravado ao parar a ponte, que precisa sair na hora.
  if (!forcar && vecBridge.lastHeartbeat && agora - vecBridge.lastHeartbeat < 2000) return;
  vecBridge.lastHeartbeat = agora;

  try {
    var tmp = new File(dirs.base.fsName + "/heartbeat.json.tmp");
    tmp.encoding = "UTF-8";
    if (!tmp.open("w")) {
      vecBridgeAvisoHeartbeat("open('w') devolveu false");
      return;
    }
    tmp.write(
      '{"at":' + agora +
      ',"afterEffects":' + vec.quote(app.version) +
      ',"processed":' + vecBridge.processed +
      ',"errors":' + vecBridge.errors +
      // `cycles` e `revivals` são o que permite ao lado Node distinguir "AE fechado"
      // de "AE aberto e o polling morreu" — dois problemas com soluções diferentes,
      // que antes davam a mesma mensagem inútil.
      ',"cycles":' + vecBridge.cycles +
      ',"revivals":' + vecBridge.revivals +
      // `running` separa "parei porque me pediram" de "congelei". Sem isto, um painel
      // com a ponte desligada no botão é indistinguível de um painel travado, e o
      // conselho que o lado Node dá para cada caso é diferente.
      ',"running":' + (vecBridge.running ? "true" : "false") +
      // `uptime` é o que revela *quando* congelou. Parar depois de 2s de vida é a
      // assinatura de um diálogo do After Effects na subida; parar depois de meia hora
      // é outro problema inteiramente.
      ',"uptime":' + (vecBridge.startedAt ? agora - vecBridge.startedAt : 0) +
      // Diz ao servidor que a pausa não é descuido: alguém está usando o After Effects.
      // Sem isto ele manda "clique em Iniciar", que é o oposto do que a situação pede.
      ',"pausadaPorBloqueio":' + (vecBridge.pausadaPorBloqueio ? "true" : "false") +
      ',"intervalo":' + vecBridge.intervalo +
      ',"build":' + VEC_PANEL_BUILD + "}"
    );
    tmp.close();

    var alvo = new File(dirs.base.fsName + "/heartbeat.json");
    if (alvo.exists) alvo.remove();
    if (!tmp.rename("heartbeat.json")) vecBridgeAvisoHeartbeat("rename devolveu false");
  } catch (e) {
    // Heartbeat é diagnóstico; falhar aqui não pode derrubar o polling.
    vecBridgeAvisoHeartbeat(vecBridgeMotivo(e));
  }
}

/**
 * Avisa no log que o heartbeat não está sendo gravado — uma vez, não a cada 2s.
 *
 * Antes esta falha era engolida em silêncio, e o efeito era cruel: o arquivo
 * congelava no último valor bom, o lado Node lia "parou de escutar há 300s" e mandava
 * reiniciar o painel — enquanto o painel estava perfeito e só não conseguia gravar o
 * arquivo de diagnóstico. Silêncio aqui manda investigar o lugar errado.
 */
function vecBridgeAvisoHeartbeat(motivo) {
  if (vecBridge.avisouHeartbeat) return;
  vecBridge.avisouHeartbeat = true;
  try {
    vecBridgeLog(
      "AVISO: não consigo gravar heartbeat.json (" + motivo + "). A ponte funciona, " +
        "mas o servidor vai achar que ela parou. Só aviso isto uma vez."
    );
  } catch (e) {}
}

/**
 * Resposta de erro escrita com o mínimo possível de código.
 *
 * Serve a dois propósitos ao mesmo tempo. Para quem usa: o servidor recebe um erro
 * em vez de esperar 30s e concluir "a ponte não respondeu", que manda investigar a
 * instalação do painel quando o painel está perfeito.
 *
 * Para quem depura: isto usa só `new File`, `open`, `write`, `close` na raiz da pasta
 * — nenhuma das partes que `vecWriteResult` usa a mais. Se esta linha aparecer no log
 * como bem-sucedida, gravar arquivo funciona e o problema está no caminho mais longo.
 * Se falhar também, gravar arquivo é que não funciona a partir do polling. Uma
 * pergunta que vinha custando uma rodada inteira de teste, respondida de graça.
 */
function vecRespostaDeEmergencia(dirs, id, motivo) {
  try {
    var f = new File(dirs.base.fsName + "/res-" + id + ".json");
    f.encoding = "UTF-8";
    if (!f.open("w")) {
      vecBridgeLog("       emergência: open('w') devolveu false");
      return;
    }
    f.write(
      '{"id":' + vec.quote(String(id)) + ',"ok":false,"error":' +
      vec.quote("o painel executou o comando mas falhou ao gravar a resposta: " + motivo) + "}"
    );
    f.close();
    vecBridgeLog("       emergência: resposta de erro gravada na raiz — escrever arquivo funciona");
  } catch (e) {
    vecBridgeLog("       emergência falhou também: " + vecBridgeMotivo(e));
  }
}

/**
 * Um ciclo de polling. Chamado por `app.scheduleTask` — precisa ser global.
 */
/**
 * Um ciclo de polling, com tudo dentro de um try.
 *
 * ── Por que o try envolve o corpo inteiro ─────────────────────────────────────
 * Uma exceção que escapa daqui faz o After Effects **cancelar a tarefa agendada**. O
 * polling morre, o painel continua mostrando "ouvindo" — porque o texto não muda
 * sozinho — e a ponte fica inerte sem nenhum sinal na tela.
 *
 * Foi isso que consumiu uma noite inteira de execução: oito horas de tentativas contra
 * um painel que parecia aberto e tinha parado de escutar. Qualquer coisa pode lançar
 * aqui: uma pasta que ficou inacessível, um `getFiles` num volume que dormiu, uma
 * escrita de log numa UI já destruída. Nenhuma dessas justifica derrubar a ponte.
 */
function vecBridgePoll() {
  if (!vecBridge.running) return;

  var agora = new Date().getTime();

  // ── Como se detecta que houve bloqueio ──────────────────────────────────────
  // O After Effects recusa executar script com diálogo modal na tela, e a recusa
  // acontece antes do nosso código: não há try/catch que a capture. O que sobra é
  // medir depois. Se o ciclo chegou muito mais tarde que o combinado, alguém segurou a
  // thread principal — e a única coisa útil a fazer é passar a incomodar menos.
  //
  // A medida sai do FIM do ciclo anterior, não do início dele. A diferença não é
  // detalhe: um `build_scene` de quarenta segundos roda dentro de um ciclo, e medido do
  // início ele apareceria como quarenta segundos de atraso — um bloqueio inventado a
  // cada comando demorado. Num lote de dezenas de cenas isso pausaria a ponte sozinha,
  // no meio do trabalho, dizendo que o After Effects estava ocupado por causa do
  // trabalho que ela mesma estava fazendo.
  var atraso = vecBridge.lastEnd ? agora - vecBridge.lastEnd : 0;

  if (atraso > vecBridge.intervalo * 4 + 1000) {
    vecBridge.bloqueios++;
    vecBridge.limpos = 0;
  } else {
    vecBridge.limpos++;
  }

  // Este carimbo é o que o supervisor usa para saber que o polling está de pé.
  vecBridge.lastPoll = agora;
  vecBridge.cycles++;

  try {
    vecBridgePollInterno();
  } catch (e) {
    // Log em try próprio: se a UI foi destruída, escrever nela lança — e essa exceção
    // seria justamente a que mata a tarefa.
    try {
      vecBridgeLog("erro no ciclo de polling (a ponte continua): " + vecBridgeMotivo(e));
    } catch (e2) {}
  }

  // Os dois carimbos de saída. `lastEnd` é a régua do bloqueio; `lastPoll` também é
  // atualizado aqui porque, sem isso, um comando demorado faria o supervisor concluir
  // que o polling morreu e reanimar um polling que estava só trabalhando.
  vecBridge.lastEnd = new Date().getTime();
  vecBridge.lastPoll = vecBridge.lastEnd;

  // Depois do trabalho, nunca antes: se o ritmo mudar, esta tarefa é cancelada e
  // substituída, e o que vier depois da troca não roda.
  try {
    vecBridgeRitmo();
  } catch (e) {}
}

/**
 * Reagenda o polling com um intervalo novo.
 *
 * `scheduleTask` não deixa mudar o intervalo de uma tarefa existente, então trocar de
 * ritmo é cancelar e agendar de novo.
 */
function vecBridgeAgendarPoll(ms) {
  if (vecBridge.taskId !== null) {
    try {
      app.cancelTask(vecBridge.taskId);
    } catch (e) {}
  }

  vecBridge.intervalo = ms;
  vecBridge.taskId = app.scheduleTask("vecBridgePoll()", ms, true);
  $.global.vecBridgeTaskId = vecBridge.taskId;
}

/** Intervalo que o estado atual pede. Ver o comentário de `intervalo` no estado. */
function vecBridgeIntervaloDesejado() {
  if (vecBridge.bloqueios > 0) {
    var recuo = vecBridge.IDLE_MS;
    for (var i = 0; i < vecBridge.bloqueios && recuo < vecBridge.MAX_MS; i++) recuo *= 2;
    return recuo > vecBridge.MAX_MS ? vecBridge.MAX_MS : recuo;
  }

  if (vecBridge.busyUntil > new Date().getTime()) return vecBridge.BUSY_MS;

  return vecBridge.IDLE_MS;
}

/**
 * Ajusta o ritmo ao fim de cada ciclo.
 *
 * A recuperação é gradual, um degrau por três ciclos limpos, e não de uma vez. Voltar
 * direto ao ritmo rápido depois de um bloqueio só recriaria a tempestade: o diálogo que
 * bloqueou costuma ser o primeiro de vários, porque a pessoa está usando outro script.
 */
function vecBridgeRitmo() {
  // ── Recuar não é suficiente ─────────────────────────────────────────────────
  // Mesmo a 16s a ponte ainda produz um diálogo de erro por bloqueio, e quem está do
  // outro lado é uma pessoa tentando usar o Motion ou outro painel. Bloqueio que
  // insiste significa que o After Effects está sendo usado por alguém, e a única
  // resposta correta é sair da frente e esperar ser chamada de volta.
  //
  // Numa execução sem ninguém acompanhando isto também está certo: diálogo que não sai
  // da tela precisa de um humano de qualquer jeito.
  if (vecBridge.bloqueios >= vecBridge.LIMITE_BLOQUEIOS) {
    vecBridge.pausadaPorBloqueio = true;

    vecBridgeLog(
      "PAUSEI a ponte: " + vecBridge.bloqueios + " bloqueios seguidos. O After Effects " +
        "está sendo usado por outro script ou esperando resposta numa janela, e cada " +
        "verificação minha virava um erro na sua tela."
    );
    vecBridgeLog("Clique em Iniciar quando quiser a ponte de volta.");

    vecBridgeStop();
    vecBridgeStatus("pausada — o After Effects está ocupado");
    return;
  }

  if (vecBridge.bloqueios > 0 && vecBridge.limpos >= 3) {
    vecBridge.bloqueios--;
    vecBridge.limpos = 0;

    if (vecBridge.bloqueios === 0) {
      vecBridge.avisouBloqueio = false;
      vecBridgeLog("o bloqueio passou — voltei ao ritmo normal.");
    }
  }

  var alvo = vecBridgeIntervaloDesejado();
  if (alvo === vecBridge.intervalo) return;

  var subiu = alvo > vecBridge.intervalo;
  vecBridgeAgendarPoll(alvo);

  if (subiu && vecBridge.bloqueios > 0 && !vecBridge.avisouBloqueio) {
    vecBridge.avisouBloqueio = true;
    vecBridgeLog(
      "algo bloqueou a thread do After Effects — quase sempre uma janela aberta por " +
        "outro script, ou pelo próprio AE. Passei a verificar a cada " +
        (alvo / 1000).toFixed(0) + "s para não atrapalhar."
    );
    vecBridgeLog(
      "Se você vai trabalhar com outro script agora, clique em Parar: enquanto a ponte " +
        "escuta, o AE recusa rodar script com diálogo na tela e mostra um erro a cada " +
        "verificação."
    );
  }
}

function vecBridgePollInterno() {
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

    // Comando vem em rajada: fica rápido por um tempo depois deste.
    vecBridge.busyUntil = new Date().getTime() + vecBridge.BUSY_JANELA;

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
      // `vec.describeError` acrescenta arquivo:linha quando o erro traz. Com o painel
      // empacotado num arquivo só, a linha aponta direto para a instrução culpada —
      // que é a diferença entre corrigir e continuar chutando. `e.toString()`
      // sozinho, que era o que estava aqui, esconde justamente isso.
      vecBridgeLog("falhei ao responder: " + vecBridgeMotivo(e));

      try {
        vecBridgeLog("       pilha: " + String($.stack).replace(/\n/g, " ‹ ").substring(0, 300));
      } catch (eStack) {}

      vecRespostaDeEmergencia(dirs, comando.id, vecBridgeMotivo(e));
      vecBridge.errors++;
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

/**
 * Supervisor: confere se o polling ainda está vivo e o reanima.
 *
 * Duas tarefas agendadas independentes em vez de uma. Se o polling morrer — por
 * exceção, por cancelamento, por qualquer motivo que eu não previ — o supervisor
 * reagenda em poucos segundos e a ponte volta sozinha. Só uma falha que derrube as
 * duas deixa a ferramenta parada, e isso é uma classe de problema muito menor.
 *
 * O intervalo é folgado de propósito: o supervisor não faz trabalho, só verifica um
 * número. Rodar rápido não o tornaria mais útil.
 */
function vecBridgeSupervise() {
  if (!vecBridge.running) return;

  try {
    var agora = new Date().getTime();
    var idade = agora - vecBridge.lastPoll;

    // Três vezes o intervalo do polling: folga suficiente para não confundir uma
    // operação demorada dentro do AE com um polling morto.
    // Folga sobre o intervalo *ativo*, não sobre um número fixo: em recuo de 30s um
    // limite de 1s faria o supervisor reanimar um polling que está apenas devagar.
    if (idade < vecBridge.intervalo * 3 + 2000) return;

    vecBridge.revivals++;

    if (vecBridge.taskId !== null) {
      try {
        app.cancelTask(vecBridge.taskId);
      } catch (e) {}
    }

    vecBridgeAgendarPoll(vecBridge.intervalo);
    vecBridge.lastPoll = agora;

    vecBridgeLog(
      "o polling havia parado (" + Math.round(idade / 1000) + "s sem ciclo) — reiniciei. " +
        "Reanimações nesta sessão: " + vecBridge.revivals
    );
  } catch (e) {
    // Nem o supervisor pode lançar: se ele morrer, ninguém reanima ninguém.
  }
}

/**
 * @param {Boolean} rapido true quando um humano clicou e está esperando resposta.
 *   No auto-início ninguém clicou, então começar no ritmo rápido só aumentaria a
 *   chance de atropelar um diálogo que já esteja na tela.
 */
function vecBridgeStart(rapido) {
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
  vecBridge.lastPoll = new Date().getTime();
  vecBridge.startedAt = vecBridge.lastPoll;
  vecBridge.lastEnd = vecBridge.lastPoll;

  vecBridge.busyUntil = rapido ? vecBridge.lastPoll + vecBridge.BUSY_JANELA : 0;
  vecBridge.bloqueios = 0;
  vecBridge.limpos = 0;
  vecBridge.avisouBloqueio = false;
  vecBridge.pausadaPorBloqueio = false;
  vecBridgeAgendarPoll(rapido ? vecBridge.BUSY_MS : vecBridge.IDLE_MS);

  // Segunda tarefa, independente: vigia a primeira.
  vecBridge.supervisorId = app.scheduleTask("vecBridgeSupervise()", 5000, true);
  $.global.vecBridgeSupervisorId = vecBridge.supervisorId;

  vecBridgeStatus("ouvindo");
  vecBridgeLog("ponte ativa em " + dirs.base.fsName);

  vecBridgeRefreshUI();
}

/**
 * Alvo do auto-início adiado. Global porque `scheduleTask` avalia uma string no
 * escopo global — uma função aninhada não seria encontrada.
 */
function vecBridgeAutoStart() {
  if (!vecBridge.autoStart) return;
  vecBridge.autoStart = false;

  // Saiu da carga do painel para cá: `app.version` é DOM e a preferência é disco, e
  // nenhum dos dois precisa acontecer no meio da subida do aplicativo.
  vecBridgeLog(
    "painel carregado — build " + VEC_PANEL_BUILD + " · After Effects " + app.version
  );

  if (!vecBridgeLerPref()) {
    vecBridgeStatus("parada — clique em Iniciar");
    vecBridgeLog(
      "não iniciei sozinha: a última escolha foi deixar a ponte parada. Enquanto ela " +
        "escuta, o After Effects pode recusar rodar outros scripts que abram janela."
    );
    return;
  }

  vecBridgeLog("retomando: a ponte estava escutando quando o After Effects fechou.");
  vecBridgeStart(false);
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

  if (vecBridge.supervisorId !== null) {
    try {
      app.cancelTask(vecBridge.supervisorId);
    } catch (e) {}
    vecBridge.supervisorId = null;
    $.global.vecBridgeSupervisorId = null;
  }

  vecBridge.running = false;

  // Heartbeat final. Sem ele o arquivo fica com `running:true` para sempre, e o
  // servidor lê uma ponte desligada de propósito como uma ponte travada.
  try {
    vecBridgeHeartbeat(vecBridgeDir(), true);
  } catch (e) {}

  vecBridgeStatus("parado");
  vecBridgeLog("ponte parada");

  vecBridgeRefreshUI();
}

/**
 * Relatório do estado real da ponte, escrito no log.
 *
 * ── Por que isto roda no clique e não numa tarefa ─────────────────────────────
 * Todo o resto do diagnóstico depende de `scheduleTask`, e existe um caso em que
 * `scheduleTask` é justamente o que não funciona: com um diálogo do After Effects na
 * tela, a thread principal está bloqueada e nenhuma tarefa agendada roda. O painel
 * continua dizendo "ouvindo" porque ninguém sobrou para corrigir o texto.
 *
 * Um clique de botão é evento de UI e roda de todo jeito. Então esta é a única leitura
 * que funciona exatamente quando é mais necessária.
 */
function vecBridgeDiagnostico() {
  var agora = new Date().getTime();

  vecBridgeLog("── diagnóstico ──");
  vecBridgeLog(
    "ponte: " + (vecBridge.running ? "ligada" : "desligada") +
      " · ciclos: " + vecBridge.cycles +
      " · comandos: " + vecBridge.processed + " ok, " + vecBridge.errors + " com erro"
  );
  vecBridgeLog(
    "painéis abertos: " + vecBridge.uis.length +
      " · reanimações: " + vecBridge.revivals +
      " · After Effects " + app.version
  );
  vecBridgeLog("build do painel: " + VEC_PANEL_BUILD);
  vecBridgeLog(
    "ritmo: " + (vecBridge.intervalo / 1000).toFixed(2) + "s entre verificações" +
      (vecBridge.bloqueios ? " · em recuo por " + vecBridge.bloqueios + " bloqueio(s)" : "")
  );

  if (vecBridge.pausadaPorBloqueio) {
    vecBridgeLog(
      "a ponte se pausou sozinha porque bloqueios seguidos indicam que o After Effects " +
        "está em uso. Clique em Iniciar quando quiser retomar."
    );
  }

  if (!vecBridge.running) {
    vecBridgeLog("a ponte está desligada — clique em Iniciar.");
    vecBridgeLog("── fim ──");
    return;
  }

  // ── Por que `cycles` e não só `lastPoll` ────────────────────────────────────
  // `vecBridgeStart` carimba `lastPoll` na largada, para o supervisor não confundir uma
  // ponte recém-ligada com uma morta. O efeito colateral é que, no instante seguinte ao
  // clique em Iniciar, `lastPoll` está fresco e o polling parece saudável — mesmo que
  // nenhum ciclo tenha rodado. E é justamente esse o momento em que a pessoa aperta o
  // diagnóstico. Zero ciclo é a evidência que não mente.
  var espera = vecBridge.intervalo * 6 + 1000;
  var desdeInicio = vecBridge.startedAt ? agora - vecBridge.startedAt : 0;

  if (vecBridge.cycles === 0) {
    if (desdeInicio < espera) {
      vecBridgeLog(
        "liguei há " + (desdeInicio / 1000).toFixed(1) + "s e o primeiro ciclo ainda não " +
          "rodou. Espere um segundo e clique aqui de novo."
      );
      vecBridgeLog("── fim ──");
      return;
    }
    vecBridgeLog(
      "ATENÇÃO: a ponte está ligada há " + (desdeInicio / 1000).toFixed(1) +
        "s e o polling nunca rodou nenhum ciclo."
    );
  } else {
    var idade = agora - vecBridge.lastPoll;

    if (idade <= espera) {
      vecBridgeLog("polling normal: último ciclo há " + (idade / 1000).toFixed(1) + "s.");
      vecBridgeLog("── fim ──");
      return;
    }

    vecBridgeLog("ATENÇÃO: último ciclo há " + (idade / 1000).toFixed(1) + "s — o polling parou.");
  }

  // Chegou aqui: ligada e sem rodar. Só há uma causa comum, e ela não se resolve no
  // painel — então vale dizer o que fazer em vez de deixar o usuário adivinhar.
  vecBridgeLog(
    "Causa mais comum: um diálogo do After Effects aberto — inclusive atrás da janela " +
      "principal. Enquanto ele estiver na tela, nenhuma tarefa agendada roda, e nem " +
      "Parar → Iniciar resolve. Feche todo diálogo primeiro, depois clique aqui de novo."
  );
  vecBridgeLog("── fim ──");
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
    win.minimumSize = [180, 160];

    var topo = win.add("group");
    topo.alignChildren = ["left", "center"];
    topo.alignment = ["fill", "top"];

    // `truncate` evita que uma mensagem longa force o painel a ficar largo: com o painel
    // estreito o texto é cortado, em vez de o layout empurrar as bordas para fora.
    var status = topo.add("statictext", undefined, "parado", { truncate: "end" });
    status.alignment = ["fill", "center"];
    status.minimumSize.width = 40;

    var toggle = topo.add("button", undefined, "Iniciar");
    // Largura fixa: o rótulo alterna entre "Iniciar" e "Parar", e sem isto o botão muda
    // de tamanho a cada clique, empurrando o status de um lado para o outro.
    toggle.preferredSize.width = 80;
    toggle.minimumSize.width = 80;

    var logBox = win.add("edittext", undefined, "", { multiline: true, readonly: true, scrolling: true });

    // ── Por que minimumSize e não preferredSize ─────────────────────────────────
    // `preferredSize.height = 180` era um piso disfarçado: o ScriptUI monta o layout a
    // partir do tamanho preferido dos filhos, então o painel não conseguia ficar menor
    // que isso e o conteúdo era cortado em vez de encolher. `minimumSize` diz o mínimo
    // de verdade, e `preferredSize` fica só como sugestão de tamanho inicial.
    logBox.minimumSize = [120, 48];
    logBox.preferredSize = [260, 160];
    logBox.alignment = ["fill", "fill"];

    var rodape = win.add("group");
    rodape.alignment = ["fill", "bottom"];
    rodape.spacing = 6;
    var diagnostico = rodape.add("button", undefined, "Diagnóstico");
    diagnostico.alignment = ["fill", "bottom"];
    var abrirPasta = rodape.add("button", undefined, "Abrir pasta");
    abrirPasta.alignment = ["fill", "bottom"];

    var minhaUI = { win: win, status: status, toggle: toggle, logBox: logBox };
    vecBridge.uis.push(minhaUI);

    toggle.onClick = function () {
      // Prova de vida: este painel aceitou um clique, então tem que estar recebendo as
      // atualizações. Se tinha saído do registro, volta agora.
      vecBridgeGarantirUI(minhaUI);

      // ── O clique se anuncia no log ───────────────────────────────────────────
      // "Cliquei e não mudou nada" é ambíguo entre duas coisas muito diferentes: o
      // handler não rodou, ou rodou e falhou. Uma linha no log separa as duas de graça,
      // e sem ela a pergunta só se responde com outra rodada de teste.
      vecBridgeLog(vecBridge.running ? "clique: Parar" : "clique: Iniciar");

      // Um clique é decisão explícita e vence o auto-início pendente — inclusive um
      // "Parar" durante a espera, que antes seria desfeito pelo agendamento.
      vecBridge.autoStart = false;

      // ScriptUI engole exceção de handler sem deixar rastro: o botão simplesmente
      // não reage. Melhor capturar e contar.
      try {
        if (vecBridge.running) {
          vecBridgeStop();
          // Um Parar clicado vale para as próximas sessões: é a diferença entre um
          // botão e um interruptor.
          vecBridgeGravarPref(false);
        } else {
          vecBridgeStart(true);
          vecBridgeGravarPref(true);
        }
      } catch (e) {
        try {
          vecBridgeLog("o clique falhou: " + vecBridgeMotivo(e));
        } catch (e2) {}
      }

      // Mesmo que algo acima tenha falhado, o rótulo passa a refletir a verdade.
      vecBridgeRefreshUI();

      // E o painel clicado é atualizado direto, sem passar pelo registro. Redundante
      // quando tudo funciona, e é o que garante a resposta visual ao clique quando
      // não funciona — que é o único momento em que isso importa.
      try {
        minhaUI.toggle.text = vecBridge.running ? "Parar" : "Iniciar";
      } catch (e) {}
    };

    diagnostico.onClick = function () {
      try {
        vecBridgeDiagnostico();
      } catch (e) {
        try {
          vecBridgeLog("o diagnóstico falhou: " + vecBridgeMotivo(e));
        } catch (e2) {}
      }
    };

    abrirPasta.onClick = function () {
      try {
        vecBridgeDir().base.execute();
      } catch (e) {
        vecBridgeLog("não consegui abrir a pasta: " + e.toString());
      }
    };

    // ── Redimensionamento ───────────────────────────────────────────────────────
    // `onResizing` dispara durante o arraste e `onResize` no fim; painel encaixado usa o
    // segundo, janela flutuante os dois. `layout.resize()` reaproveita o layout já
    // montado para a nova área — é o que faz o log crescer junto com o painel.
    //
    // Em try porque isto é evento de UI: uma exceção aqui, num painel que o After
    // Effects está redimensionando, aparece como diálogo de erro no meio do arraste.
    win.onResizing = win.onResize = function () {
      try {
        this.layout.resize();
      } catch (e) {}
    };

    win.onClose = function () {
      // Sai do registro primeiro, senão as escritas seguintes vão para uma widget
      // destruída.
      var restantes = [];
      for (var i = 0; i < vecBridge.uis.length; i++) {
        if (vecBridge.uis[i] !== minhaUI) restantes.push(vecBridge.uis[i]);
      }
      vecBridge.uis = restantes;

      // Fechar o painel sem parar o polling deixaria uma tarefa órfã rodando na engine
      // até o After Effects fechar. Mas só para se este era o último painel: com outro
      // aberto, fechar uma aba duplicada desligava a ponte que o outro painel ainda
      // mostrava como "ouvindo".
      if (vecBridge.uis.length === 0) vecBridgeStop();

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

  // ── Por que quase nada acontece aqui ────────────────────────────────────────
  // Um painel encaixado carrega junto com o workspace, durante a subida do After
  // Effects, antes de existir projeto aberto — e ao lado dos outros painéis de script
  // do usuário, que estão carregando no mesmo instante. É a janela mais frágil que
  // existe, e onde apareceu `internal verification failure {no current context}` com o
  // Bridge e o Motion abertos juntos.
  //
  // Então a carga faz o mínimo: monta as widgets e agenda uma tarefa. Nada de ler
  // arquivo de preferência, nada de consultar `app.version`, nada de escrever no log —
  // tudo isso foi para dentro do início adiado, onde a thread já está livre.
  //
  // `scheduleTask` com repeat=false só registra o timer; o callback roda depois, na
  // thread principal, quando ela estiver desocupada. Se o AE ainda estiver subindo, ou
  // com um diálogo na frente, ele simplesmente atrasa — que é o comportamento
  // desejado, não um efeito colateral.
  vecBridgeRefreshUI();

  // Se a ponte já está de pé — carga nova de painel numa engine que já estava
  // escutando — não há o que aguardar nem o que reiniciar.
  if (vecBridge.running) {
    vecBridgeStatus("ouvindo");
  } else {
    vecBridgeStatus("aguardando o After Effects terminar de subir…");
    $.global.vecBridgeAutoStartId = app.scheduleTask("vecBridgeAutoStart()", 5000, false);
  }
})(this);

