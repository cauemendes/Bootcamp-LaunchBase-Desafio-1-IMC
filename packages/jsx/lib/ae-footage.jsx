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
    var escala = fit === "none" ? [100, 100] : vec.escalaParaCaixa(item.width, item.height, caixa.w, caixa.h, fit);

    var t = layer.property("ADBE Transform Group");
    t.property("ADBE Anchor Point").setValue([item.width / 2, item.height / 2]);
    t.property("ADBE Position").setValue([caixa.x + caixa.w / 2, caixa.y + caixa.h / 2]);
    t.property("ADBE Scale").setValue(escala);
    t.property("ADBE Opacity").setValue(vec.has(args, "opacity") ? args.opacity : 100);

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
