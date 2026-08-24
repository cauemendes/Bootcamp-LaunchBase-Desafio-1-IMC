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
