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
