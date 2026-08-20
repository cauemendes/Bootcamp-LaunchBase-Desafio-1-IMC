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
