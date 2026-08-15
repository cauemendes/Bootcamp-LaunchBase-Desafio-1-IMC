/**
 * Construção de camadas de texto.
 *
 * Texto não pode viver dentro de uma shape layer — no After Effects é um tipo de
 * camada separado. Por isso o core já separa os elementos de texto em camadas
 * próprias antes de chegar aqui.
 *
 * ── Fonte é o ponto frágil ────────────────────────────────────────────────────
 * O modelo devolve um palpite de família de fonte olhando o desenho das letras. Se
 * essa fonte não estiver instalada, o AE substitui em silêncio e o layout sai
 * diferente do original — sem erro, sem aviso. Para que isso não passe despercebido,
 * a função lê a fonte de volta depois de gravar e reporta quando a substituição
 * aconteceu, e o painel mostra isso pro usuário.
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
  var doc = textProp.value;

  doc.fontSize = spec.fontSize;
  doc.applyFill = true;
  doc.fillColor = vec.hexToColor(spec.color, gamma);
  doc.applyStroke = false;
  doc.justification = vec.JUSTIFICATION[spec.align] || ParagraphJustification.LEFT_JUSTIFY;

  if (spec.letterSpacing) {
    doc.tracking = spec.letterSpacing;
  }

  // fontFamily/fontStyle existem a partir do AE 2020. São bem mais confiáveis que
  // `doc.font`, que exige o nome PostScript exato — algo que o modelo não tem como
  // saber olhando uma imagem.
  var requestedFamily = spec.fontFamily;
  if (requestedFamily) {
    try {
      doc.fontFamily = requestedFamily;
      if (spec.weight) doc.fontStyle = spec.weight;
    } catch (e) {
      // Fonte inexistente: segue com a padrão em vez de abortar a cena inteira.
      requestedFamily = null;
    }
  }

  textProp.setValue(doc);

  // A âncora de um texto de ponto fica na baseline, no ponto de alinhamento. Com a
  // posição em (x, y) do SceneSpec, o texto cai onde o modelo mediu.
  var transform = layer.property("ADBE Transform Group");
  transform.property("ADBE Position").setValue([spec.x, spec.y]);
  transform.property("ADBE Opacity").setValue(spec.opacity);

  return { layer: layer, fontWarning: vec.checkFontSubstitution(textProp, spec.fontFamily) };
};

/**
 * Compara a fonte pedida com a que o AE de fato aplicou.
 *
 * A comparação ignora caixa e espaços porque o AE normaliza nomes de família de
 * formas que não valem a pena adivinhar ("Helvetica Neue" vs "HelveticaNeue").
 */
vec.checkFontSubstitution = function (textProp, requestedFamily) {
  if (!requestedFamily) return null;

  var applied;
  try {
    applied = textProp.value.fontFamily;
  } catch (e) {
    return null; // versão do AE sem fontFamily — não dá pra verificar
  }

  if (!applied) return null;

  var norm = function (s) {
    return String(s).toLowerCase().replace(/[\s_-]+/g, "");
  };

  if (norm(applied) === norm(requestedFamily)) return null;

  return (
    'A fonte "' + requestedFamily + '" não está instalada — o After Effects usou "' +
    applied + '". O layout do texto vai diferir da imagem original.'
  );
};
