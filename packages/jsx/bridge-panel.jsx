/**
 * Vectorize AE Bridge — o painel que fica aberto dentro do After Effects.
 *
 * ── O que ele faz ─────────────────────────────────────────────────────────────
 * O After Effects não tem servidor de scripting: nenhum processo de fora consegue
 * chamá-lo. Este painel é a ponte. Ele fica lendo uma pasta compartilhada; quando o
 * servidor MCP escreve um comando ali, o painel executa dentro do AE e escreve a
 * resposta de volta.
 *
 * ── #targetengine não é opcional ──────────────────────────────────────────────
 * Sem uma engine própria e persistente, o ExtendScript coleta as variáveis do
 * painel entre um evento e outro, e o polling para de funcionar sozinho depois de
 * alguns segundos — sem erro nenhum, o que torna a depuração horrível.
 *
 * ── Instalação ────────────────────────────────────────────────────────────────
 * Este arquivo e a pasta `lib/` vão para a pasta ScriptUI Panels do After Effects.
 * Só ele fica solto ali: os demais `.jsx` também apareceriam no menu Window, e o
 * autoteste rodaria sozinho ao abrir o app. `scripts/install-bridge.sh` cuida disso.
 */

#targetengine "vectorizeAE"

//@include "lib/tools.jsx"

/*global app, Folder, File, Panel, Window, ScriptUI, vec*/

// ---------------------------------------------------------------- estado

/**
 * Cancela o polling de uma carga anterior nesta mesma engine.
 *
 * Abrir o painel duas vezes — o encaixado da instalação mais o flutuante do
 * Run Script File, por exemplo — reexecuta este arquivo na engine "vectorizeAE" e
 * substitui `vecBridge` por um objeto novo. A tarefa agendada pela carga anterior
 * continua viva, mas apontando para um estado que não existe mais: dois pollings
 * disputando a mesma pasta, e o log de um dos painéis congelado sem explicação.
 *
 * O id fica em $.global porque `var vecBridge` é reinicializado a cada carga, e
 * portanto não serve para lembrar do que veio antes.
 */
if ($.global.vecBridgeTaskId !== undefined && $.global.vecBridgeTaskId !== null) {
  try {
    app.cancelTask($.global.vecBridgeTaskId);
  } catch (e) {
    // A tarefa já pode ter sido cancelada; o que importa é não deixar duas.
  }
  $.global.vecBridgeTaskId = null;
}

if ($.global.vecBridgeSupervisorId !== undefined && $.global.vecBridgeSupervisorId !== null) {
  try {
    app.cancelTask($.global.vecBridgeSupervisorId);
  } catch (e) {}
  $.global.vecBridgeSupervisorId = null;
}

var vecBridge = {
  running: false,
  taskId: null,
  processed: 0,
  errors: 0,
  ui: null,
  log: [],
  lastHeartbeat: 0,
  lastPoll: 0,
  cycles: 0,
  supervisorId: null,
  revivals: 0,
  // null = ainda não sei se dá pra escrever dentro de res/. Ver vecWriteResult().
  resSubpastaOk: null,
  POLL_MS: 350,
};

/**
 * Pasta compartilhada com o servidor.
 *
 * `Folder.userData` devolve Application Support no macOS e AppData\Roaming no
 * Windows — o lado Node calcula o mesmo caminho, então os dois se encontram sem
 * precisar configurar nada.
 */
function vecBridgeDir() {
  var override = $.getenv("VECTORIZE_AE_BRIDGE_DIR");
  var base = override ? new Folder(override) : new Folder(Folder.userData.fsName + "/vectorize-ae/bridge");

  var cmd = new Folder(base.fsName + "/cmd");
  var res = new Folder(base.fsName + "/res");
  if (!cmd.exists) cmd.create();
  if (!res.exists) res.create();

  return { base: base, cmd: cmd, res: res };
}

// ---------------------------------------------------------------- ponte

function vecBridgeLog(message) {
  var hora = new Date().toTimeString().substring(0, 8);
  vecBridge.log.push(hora + "  " + message);

  // Um painel aberto o dia inteiro acumularia milhares de linhas.
  if (vecBridge.log.length > 60) vecBridge.log.shift();

  if (vecBridge.ui && vecBridge.ui.logBox) {
    vecBridge.ui.logBox.text = vecBridge.log.join("\n");
    // Sem isso o usuário fica olhando o começo do log enquanto o interessante
    // acontece no fim.
    try {
      vecBridge.ui.logBox.textselection = "";
    } catch (e) {}
  }
}

function vecBridgeStatus(text) {
  if (vecBridge.ui && vecBridge.ui.status) {
    vecBridge.ui.status.text = text;
  }
}

/**
 * Grava um arquivo e confere que o que ficou no disco é o que se pediu.
 *
 * `File.open`, `File.write` e `File.rename` do ExtendScript devolvem `false` em vez
 * de lançar erro. Ignorar o retorno — que é o que quase todo código de AE faz — deixa
 * a falha invisível: o arquivo aparece na pasta com zero byte e nada no log.
 *
 * A releitura existe porque nem o `write()` retornando `true` garante o conteúdo:
 * foi assim que o AE 2026 gravou `.tmp` vazios sem reclamar de nada.
 *
 * @returns {String|null} null se deu certo; a explicação da falha se não deu.
 */
function vecWriteVerified(file, text) {
  file.encoding = "UTF-8";

  if (!file.open("w")) return "open('w') devolveu false em " + file.fsName;

  var escreveu;
  try {
    escreveu = file.write(text);
  } finally {
    file.close();
  }

  if (escreveu === false) return "write() devolveu false em " + file.fsName;

  var conferencia = new File(file.fsName);
  conferencia.encoding = "UTF-8";
  if (!conferencia.open("r")) return "gravei mas não consigo reler " + file.fsName;

  var lido;
  try {
    lido = conferencia.read();
  } finally {
    conferencia.close();
  }

  if (lido !== text) {
    return "o disco ficou com " + lido.length + " de " + text.length +
      " caracteres em " + file.fsName;
  }

  return null;
}

/**
 * `vecWriteVerified` com as duas formas de falha unificadas.
 *
 * A gravação em `res/` no AE 2026 não devolve `false` — ela *lança*
 * "Object of type Function found where a Number, Array, or Property is needed",
 * que não tem relação nenhuma com o que se estava fazendo. Tratar só o retorno
 * deixaria a exceção passar por cima do plano B, que é justamente o que existe para
 * cobrir esse caso.
 */
function vecTentarEscrever(file, texto) {
  try {
    return vecWriteVerified(file, texto);
  } catch (e) {
    return vec.describeError(e) + " (em " + file.fsName + ")";
  }
}

/**
 * O JSON da resposta, ou uma resposta de erro montada à mão.
 *
 * Uma resposta de erro vale muito mais que um timeout. Sem isto, uma falha de
 * serialização deixa o servidor esperando 30s e concluindo "a ponte não respondeu" —
 * o que manda investigar a instalação do painel, que está perfeita. O texto é
 * concatenado à mão de propósito: depender de `vec.json` para relatar que `vec.json`
 * falhou não faria sentido.
 */
function vecTextoResposta(payload) {
  try {
    return vec.json(payload);
  } catch (e) {
    return '{"id":' + vec.quote(String(payload.id)) + ',"ok":false,"error":' +
      vec.quote("falhei ao serializar a resposta: " + vec.describeError(e)) + "}";
  }
}

/**
 * Escreve a resposta onde o servidor consiga achar.
 *
 * O caminho normal é `res/<id>.json`. O alternativo é `res-<id>.json` na raiz da
 * pasta da ponte, e existe por observação, não por elegância: no AE 2026 do macOS a
 * gravação dentro de `res/` falha — ora com arquivo de zero byte e `rename()`
 * devolvendo false, ora com uma exceção sem nexo — enquanto a mesma operação na raiz
 * funciona. É onde o heartbeat mora, e o heartbeat nunca falhou. Ler e apagar dentro
 * de `cmd/` também funciona; só a escrita em subpasta é que quebra.
 *
 * Não sei o motivo, e chutar um motivo errado custaria mais uma rodada de teste no
 * After Effects. O que dá pra fazer é tentar, conferir o que ficou no disco, e cair
 * para um caminho comprovado quando o primeiro não entregar.
 *
 * `resSubpastaOk` guarda o resultado da primeira tentativa. Sem isso, toda resposta
 * pagaria uma exceção antes de acertar o caminho, e o log encheria de aviso repetido.
 *
 * Sem o par `.tmp`+rename a leitura poderia pegar um JSON pela metade; quem cobre
 * esse risco é o lado Node, que trata JSON incompleto como "ainda não chegou" e
 * tenta de novo, em vez de estourar.
 */
function vecWriteResult(dirs, id, payload) {
  // O rótulo de etapa existe porque o erro que apareceu aqui no AE 2026 —
  // "Object of type Function found where a Number, Array, or Property is needed" —
  // não descreve nada do que o código estava fazendo, e nem sempre traz linha. Sem
  // saber em qual passo ele estoura, cada tentativa de correção é um chute.
  var etapa = "início";

  try {
    etapa = "serializar a resposta";
    var texto = vecTextoResposta(payload);

    etapa = "montar o caminho da raiz";
    var alternativo = new File(dirs.base.fsName + "/res-" + id + ".json");

    if (vecBridge.resSubpastaOk === false) {
      etapa = "gravar na raiz (res/ já reprovada antes)";
      var soAlternativo = vecTentarEscrever(alternativo, texto);
      if (soAlternativo) throw new Error(soAlternativo);
      return;
    }

    etapa = "montar o caminho de res/";
    var principal = new File(dirs.res.fsName + "/" + id + ".json");

    etapa = "gravar em res/";
    var problema = vecTentarEscrever(principal, texto);

    if (!problema) {
      vecBridge.resSubpastaOk = true;
      return;
    }

    vecBridge.resSubpastaOk = false;

    // Um arquivo pela metade em res/ seria lido pelo servidor como resposta válida.
    etapa = "limpar o arquivo incompleto em res/";
    try {
      if (principal.exists) principal.remove();
    } catch (eLimpeza) {}

    etapa = "gravar na raiz depois de res/ falhar";
    var problemaAlt = vecTentarEscrever(alternativo, texto);
    if (problemaAlt) {
      throw new Error("res/: " + problema + " · raiz: " + problemaAlt);
    }

    vecBridgeLog("aviso: res/ recusou a escrita — respondendo pela raiz daqui em diante");
    vecBridgeLog("       (motivo: " + problema + ")");
  } catch (e) {
    throw new Error("[etapa: " + etapa + "] " + vec.describeError(e));
  }
}

function vecReadCommand(file) {
  file.encoding = "UTF-8";
  if (!file.open("r")) return null;

  var raw;
  try {
    raw = file.read();
  } finally {
    file.close();
  }

  // Consome antes de executar: se a execução travar o AE, o comando não fica pra
  // ser reexecutado no próximo start do painel.
  file.remove();

  try {
    return eval("(" + raw + ")");
  } catch (e) {
    vecBridgeLog("comando ilegível, descartado: " + e.toString());
    return null;
  }
}

/**
 * Marca de vida, gravada periodicamente na pasta da ponte.
 *
 * Existe porque não dá para perguntar "você está aí?" de dentro do After Effects:
 * um script rodando bloqueia a thread principal, que é a mesma que executa o
 * polling do painel. Qualquer diagnóstico que envie um comando e espere a resposta
 * trava justamente quem deveria responder.
 *
 * Com o heartbeat, basta olhar a idade do arquivo — sem esperar, sem bloquear.
 * O lado Node também usa isso para saber se vale a pena tentar um comando.
 */
function vecBridgeHeartbeat(dirs) {
  var agora = new Date().getTime();

  // Escrever a cada ciclo de 350ms seria disco à toa; 2s dá resolução de sobra
  // para diferenciar "vivo" de "morto".
  if (vecBridge.lastHeartbeat && agora - vecBridge.lastHeartbeat < 2000) return;
  vecBridge.lastHeartbeat = agora;

  try {
    var tmp = new File(dirs.base.fsName + "/heartbeat.json.tmp");
    tmp.encoding = "UTF-8";
    if (!tmp.open("w")) return;
    tmp.write(
      '{"at":' + agora +
      ',"afterEffects":' + vec.quote(app.version) +
      ',"processed":' + vecBridge.processed +
      ',"errors":' + vecBridge.errors +
      // `cycles` e `revivals` são o que permite ao lado Node distinguir "AE fechado"
      // de "AE aberto e o polling morreu" — dois problemas com soluções diferentes,
      // que antes davam a mesma mensagem inútil.
      ',"cycles":' + vecBridge.cycles +
      ',"revivals":' + vecBridge.revivals + "}"
    );
    tmp.close();

    var alvo = new File(dirs.base.fsName + "/heartbeat.json");
    if (alvo.exists) alvo.remove();
    tmp.rename("heartbeat.json");
  } catch (e) {
    // Heartbeat é diagnóstico; falhar aqui não pode derrubar o polling.
  }
}

/**
 * Resposta de erro escrita com o mínimo possível de código.
 *
 * Serve a dois propósitos ao mesmo tempo. Para quem usa: o servidor recebe um erro
 * em vez de esperar 30s e concluir "a ponte não respondeu", que manda investigar a
 * instalação do painel quando o painel está perfeito.
 *
 * Para quem depura: isto usa só `new File`, `open`, `write`, `close` na raiz da pasta
 * — nenhuma das partes que `vecWriteResult` usa a mais. Se esta linha aparecer no log
 * como bem-sucedida, gravar arquivo funciona e o problema está no caminho mais longo.
 * Se falhar também, gravar arquivo é que não funciona a partir do polling. Uma
 * pergunta que vinha custando uma rodada inteira de teste, respondida de graça.
 */
function vecRespostaDeEmergencia(dirs, id, motivo) {
  try {
    var f = new File(dirs.base.fsName + "/res-" + id + ".json");
    f.encoding = "UTF-8";
    if (!f.open("w")) {
      vecBridgeLog("       emergência: open('w') devolveu false");
      return;
    }
    f.write(
      '{"id":' + vec.quote(String(id)) + ',"ok":false,"error":' +
      vec.quote("o painel executou o comando mas falhou ao gravar a resposta: " + motivo) + "}"
    );
    f.close();
    vecBridgeLog("       emergência: resposta de erro gravada na raiz — escrever arquivo funciona");
  } catch (e) {
    vecBridgeLog("       emergência falhou também: " + vec.describeError(e));
  }
}

/**
 * Um ciclo de polling. Chamado por `app.scheduleTask` — precisa ser global.
 */
/**
 * Um ciclo de polling, com tudo dentro de um try.
 *
 * ── Por que o try envolve o corpo inteiro ─────────────────────────────────────
 * Uma exceção que escapa daqui faz o After Effects **cancelar a tarefa agendada**. O
 * polling morre, o painel continua mostrando "ouvindo" — porque o texto não muda
 * sozinho — e a ponte fica inerte sem nenhum sinal na tela.
 *
 * Foi isso que consumiu uma noite inteira de execução: oito horas de tentativas contra
 * um painel que parecia aberto e tinha parado de escutar. Qualquer coisa pode lançar
 * aqui: uma pasta que ficou inacessível, um `getFiles` num volume que dormiu, uma
 * escrita de log numa UI já destruída. Nenhuma dessas justifica derrubar a ponte.
 */
function vecBridgePoll() {
  if (!vecBridge.running) return;

  // Antes de qualquer coisa que possa falhar: é este carimbo que o supervisor usa
  // para saber que o polling ainda está de pé.
  vecBridge.lastPoll = new Date().getTime();
  vecBridge.cycles++;

  try {
    vecBridgePollInterno();
  } catch (e) {
    // Log em try próprio: se a UI foi destruída, escrever nela lança — e essa exceção
    // seria justamente a que mata a tarefa.
    try {
      vecBridgeLog("erro no ciclo de polling (a ponte continua): " + vec.describeError(e));
    } catch (e2) {}
  }
}

function vecBridgePollInterno() {
  var dirs;
  try {
    dirs = vecBridgeDir();
  } catch (e) {
    vecBridgeLog("pasta da ponte inacessível: " + e.toString());
    return;
  }

  vecBridgeHeartbeat(dirs);

  var arquivos = dirs.cmd.getFiles("*.json");
  if (!arquivos || arquivos.length === 0) return;

  for (var i = 0; i < arquivos.length; i++) {
    var arquivo = arquivos[i];
    if (!(arquivo instanceof File)) continue;

    var comando = vecReadCommand(arquivo);
    if (!comando || !comando.id) continue;

    vecBridgeStatus("executando " + comando.tool + "…");
    vecBridgeLog("→ " + comando.tool);

    var resposta = vec.runTool(comando.tool, comando.args || {});

    try {
      vecWriteResult(dirs, comando.id, {
        id: comando.id,
        ok: resposta.ok,
        result: resposta.result,
        error: resposta.error,
      });
    } catch (e) {
      // `vec.describeError` acrescenta arquivo:linha quando o erro traz. Com o painel
      // empacotado num arquivo só, a linha aponta direto para a instrução culpada —
      // que é a diferença entre corrigir e continuar chutando. `e.toString()`
      // sozinho, que era o que estava aqui, esconde justamente isso.
      vecBridgeLog("falhei ao responder: " + vec.describeError(e));

      try {
        vecBridgeLog("       pilha: " + String($.stack).replace(/\n/g, " ‹ ").substring(0, 300));
      } catch (eStack) {}

      vecRespostaDeEmergencia(dirs, comando.id, vec.describeError(e));
      vecBridge.errors++;
      continue;
    }

    if (resposta.ok) {
      vecBridge.processed++;
      vecBridgeLog("← ok");
    } else {
      vecBridge.errors++;
      vecBridgeLog("← erro: " + resposta.error);
    }
  }

  vecBridgeStatus(
    "ouvindo · " + vecBridge.processed + " ok" +
      (vecBridge.errors ? " · " + vecBridge.errors + " com erro" : "")
  );
}

/**
 * Supervisor: confere se o polling ainda está vivo e o reanima.
 *
 * Duas tarefas agendadas independentes em vez de uma. Se o polling morrer — por
 * exceção, por cancelamento, por qualquer motivo que eu não previ — o supervisor
 * reagenda em poucos segundos e a ponte volta sozinha. Só uma falha que derrube as
 * duas deixa a ferramenta parada, e isso é uma classe de problema muito menor.
 *
 * O intervalo é folgado de propósito: o supervisor não faz trabalho, só verifica um
 * número. Rodar rápido não o tornaria mais útil.
 */
function vecBridgeSupervise() {
  if (!vecBridge.running) return;

  try {
    var agora = new Date().getTime();
    var idade = agora - vecBridge.lastPoll;

    // Três vezes o intervalo do polling: folga suficiente para não confundir uma
    // operação demorada dentro do AE com um polling morto.
    if (idade < vecBridge.POLL_MS * 3) return;

    vecBridge.revivals++;

    if (vecBridge.taskId !== null) {
      try {
        app.cancelTask(vecBridge.taskId);
      } catch (e) {}
    }

    vecBridge.taskId = app.scheduleTask("vecBridgePoll()", vecBridge.POLL_MS, true);
    $.global.vecBridgeTaskId = vecBridge.taskId;
    vecBridge.lastPoll = agora;

    vecBridgeLog(
      "o polling havia parado (" + Math.round(idade / 1000) + "s sem ciclo) — reiniciei. " +
        "Reanimações nesta sessão: " + vecBridge.revivals
    );
  } catch (e) {
    // Nem o supervisor pode lançar: se ele morrer, ninguém reanima ninguém.
  }
}

function vecBridgeStart() {
  if (vecBridge.running) return;

  var dirs;
  try {
    dirs = vecBridgeDir();
  } catch (e) {
    vecBridgeLog("não consegui criar a pasta da ponte: " + e.toString());
    vecBridgeStatus("erro ao iniciar");
    return;
  }

  // Comandos de uma sessão anterior não interessam a ninguém, e executá-los
  // mexeria no projeto do usuário sem que ele tivesse pedido nada agora.
  var antigos = dirs.cmd.getFiles("*.json");
  for (var i = 0; i < antigos.length; i++) {
    try {
      antigos[i].remove();
    } catch (e) {}
  }
  if (antigos.length > 0) vecBridgeLog("descartei " + antigos.length + " comando(s) de sessão anterior");

  vecBridge.running = true;
  vecBridge.lastPoll = new Date().getTime();
  vecBridge.taskId = app.scheduleTask("vecBridgePoll()", vecBridge.POLL_MS, true);
  $.global.vecBridgeTaskId = vecBridge.taskId;

  // Segunda tarefa, independente: vigia a primeira.
  vecBridge.supervisorId = app.scheduleTask("vecBridgeSupervise()", 5000, true);
  $.global.vecBridgeSupervisorId = vecBridge.supervisorId;

  vecBridgeStatus("ouvindo");
  vecBridgeLog("ponte ativa em " + dirs.base.fsName);

  if (vecBridge.ui && vecBridge.ui.toggle) vecBridge.ui.toggle.text = "Parar";
}

function vecBridgeStop() {
  if (!vecBridge.running) return;

  if (vecBridge.taskId !== null) {
    try {
      app.cancelTask(vecBridge.taskId);
    } catch (e) {}
    vecBridge.taskId = null;
    $.global.vecBridgeTaskId = null;
  }

  if (vecBridge.supervisorId !== null) {
    try {
      app.cancelTask(vecBridge.supervisorId);
    } catch (e) {}
    vecBridge.supervisorId = null;
    $.global.vecBridgeSupervisorId = null;
  }

  vecBridge.running = false;
  vecBridgeStatus("parado");
  vecBridgeLog("ponte parada");

  if (vecBridge.ui && vecBridge.ui.toggle) vecBridge.ui.toggle.text = "Iniciar";
}

// ---------------------------------------------------------------- interface

(function (thisObj) {
  function build(thisObj) {
    var win = thisObj instanceof Panel
      ? thisObj
      : new Window("palette", "Vectorize AE Bridge", undefined, { resizeable: true });

    win.orientation = "column";
    win.alignChildren = ["fill", "top"];
    win.spacing = 8;
    win.margins = 12;

    var topo = win.add("group");
    topo.alignChildren = ["left", "center"];
    topo.alignment = ["fill", "top"];

    var status = topo.add("statictext", undefined, "parado");
    status.alignment = ["fill", "center"];

    var toggle = topo.add("button", undefined, "Iniciar");
    toggle.preferredSize.width = 80;

    var logBox = win.add("edittext", undefined, "", { multiline: true, readonly: true, scrolling: true });
    logBox.preferredSize.height = 180;
    logBox.alignment = ["fill", "fill"];

    var rodape = win.add("group");
    rodape.alignment = ["fill", "bottom"];
    var abrirPasta = rodape.add("button", undefined, "Abrir pasta da ponte");
    abrirPasta.alignment = ["fill", "bottom"];

    vecBridge.ui = { win: win, status: status, toggle: toggle, logBox: logBox };

    toggle.onClick = function () {
      if (vecBridge.running) {
        vecBridgeStop();
      } else {
        vecBridgeStart();
      }
    };

    abrirPasta.onClick = function () {
      try {
        vecBridgeDir().base.execute();
      } catch (e) {
        vecBridgeLog("não consegui abrir a pasta: " + e.toString());
      }
    };

    win.onResizing = win.onResize = function () {
      this.layout.resize();
    };

    // Fechar o painel sem parar o polling deixa uma tarefa órfã rodando na engine
    // até o After Effects fechar.
    win.onClose = function () {
      vecBridgeStop();
      return true;
    };

    return win;
  }

  var win = build(thisObj);

  if (win instanceof Window) {
    win.center();
    win.show();
  } else {
    win.layout.layout(true);
  }

  vecBridgeLog("painel carregado — After Effects " + app.version);

  // Auto-inicia: se o painel está aberto, a intenção é escutar. Ter que clicar
  // "Iniciar" toda vez seria só uma etapa a mais para esquecer.
  vecBridgeStart();
})(this);
