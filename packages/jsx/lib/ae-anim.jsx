/**
 * Aplicar keyframes resolvidos pelo core.
 *
 * Este arquivo é deliberadamente burro: não decide timing, não escolhe easing, não
 * sabe o que é "entrada com overshoot". Recebe trilhas com frame, valor e influência
 * já calculados e as escreve no projeto. Toda a decisão está em
 * `packages/core/src/anim.js`, onde tem teste.
 */

/*global app, KeyframeEase, KeyframeInterpolationType, ShapeLayer, vec*/

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

  throw new Error("Propriedade animável desconhecida: " + nome);
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

  for (i = 0; i < track.keys.length; i++) {
    var k = track.keys[i];
    prop.setValueAtTime(k.frame / comp.frameRate, vecValorAe(prop, k.value, base, track.mode));
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
 * @returns {{ok, compName, applied, keyframes, warnings}}
 */
vec.applyAnimation = function (tracks, options) {
  options = options || {};

  var comp = vec.findComp(options.compName);
  var avisos = [];
  var aplicadas = 0;
  var keyframes = 0;

  var silenciado = vec.suppressDialogs();
  app.beginUndoGroup("Vectorize AE - animation");

  try {
    for (var i = 0; i < tracks.length; i++) {
      var track = tracks[i];
      var layer = null;

      try {
        layer = comp.layer(track.layer);
      } catch (e) {
        layer = null;
      }

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
    warnings: avisos,
  };
};
