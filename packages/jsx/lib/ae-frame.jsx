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

/*global app, File, Folder, vec, RQItemStatus*/

var vec = vec || {};

/** Alinha um tempo ao frame mais próximo — a fila recusa tempo fora da grade. */
function vecSnapToFrame(comp, time) {
  var passo = comp.frameDuration;
  var alinhado = Math.round(time / passo) * passo;

  // O último frame da comp é `duration - frameDuration`; pedir `duration` devolve
  // um span vazio e a fila renderiza nada, sem reclamar.
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
function vecAcharSaida(pasta, prefixo) {
  var arquivos = pasta.getFiles(function (f) {
    return f instanceof File && decodeURI(f.name).indexOf(prefixo) === 0;
  });

  if (!arquivos || arquivos.length === 0) return null;

  // Mais de um só acontece se sobrou lixo de uma tentativa anterior; o mais novo é o
  // desta rodada.
  var escolhido = arquivos[0];
  for (var i = 1; i < arquivos.length; i++) {
    if (arquivos[i].modified > escolhido.modified) escolhido = arquivos[i];
  }
  return escolhido;
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
  var item = null;

  try {
    item = fila.items.add(comp);
    item.timeSpanStart = time;
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

    var gravado = vecAcharSaida(pasta, prefixo);
    if (gravado === null) {
      throw new Error("A fila rodou mas não encontrei o arquivo gerado em " + pasta.fsName + ".");
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
vec.saveFrame = function (comp, time, destino) {
  var alinhado = vecSnapToFrame(comp, time);

  if (typeof comp.saveFrameToPng === "function") {
    try {
      comp.saveFrameToPng(alinhado, destino);
    } catch (e) {
      // Falha explícita é informação; a silenciosa é que exige a conferência abaixo.
    }

    // A conferência no disco é o ponto inteiro desta função.
    var conferencia = new File(destino.fsName);
    if (conferencia.exists && conferencia.length > 0) {
      return { file: conferencia, method: "saveFrameToPng", time: alinhado };
    }
  }

  return { file: vecSaveFrameViaQueue(comp, alinhado, destino), method: "renderQueue", time: alinhado };
};
