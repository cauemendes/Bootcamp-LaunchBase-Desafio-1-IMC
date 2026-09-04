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

//@include "util.jsx"
//@include "ae-shape.jsx"
//@include "ae-font.jsx"
//@include "ae-text.jsx"
//@include "ae-read.jsx"
//@include "ae-frame.jsx"
//@include "ae-anim.jsx"
//@include "ae-image.jsx"
//@include "ae-footage.jsx"
//@include "ae-sequence.jsx"
//@include "ae-organize.jsx"
//@include "build-scene.jsx"

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
