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
 * Monta a comp master.
 *
 * @param {Object} plan     { name, width, height, frameRate, totalFrames, audio, scenes }
 * @returns {Object} relatório com avisos
 */
vec.buildSequence = function (plan, options) {
  options = options || {};

  var avisos = [];
  var fps = plan.frameRate;
  var nome = vec.safeName(plan.name, "Master");

  app.beginUndoGroup("Vectorize AE - " + nome);
  var silenciado = vec.suppressDialogs();

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
