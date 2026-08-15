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
