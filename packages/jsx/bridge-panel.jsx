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

var vecBridge = {
  running: false,
  taskId: null,
  processed: 0,
  errors: 0,
  ui: null,
  log: [],
  lastHeartbeat: 0,
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
 * Escreve a resposta onde o servidor consiga achar.
 *
 * O caminho normal é `res/<id>.json`. O alternativo é `<id>.json` na raiz da pasta
 * da ponte, e existe por observação, não por elegância: no AE 2026 do macOS a
 * gravação dentro de `res/` falhou em silêncio — arquivos de zero byte, `rename()`
 * devolvendo false — enquanto a mesma operação na raiz funcionou (é onde o heartbeat
 * mora, e o heartbeat nunca falhou). Ler e apagar dentro de `cmd/` funciona; só a
 * escrita em subpasta é que quebra.
 *
 * Não sei o motivo, e chutar um motivo errado custaria mais uma rodada de teste. O
 * que dá pra fazer é tentar, conferir, e cair pra um caminho comprovado quando o
 * primeiro não entregar. O log diz qual dos dois valeu — é isso que vai permitir
 * simplificar isto depois, com evidência em vez de teoria.
 *
 * Sem o par `.tmp`+rename a leitura poderia pegar um JSON pela metade; quem cobre
 * esse risco agora é o lado Node, que trata JSON incompleto como "ainda não chegou"
 * e tenta de novo, em vez de estourar.
 */
function vecWriteResult(dirs, id, payload) {
  var texto = vec.json(payload);

  var principal = new File(dirs.res.fsName + "/" + id + ".json");
  var problema = vecWriteVerified(principal, texto);
  if (!problema) return;

  try {
    principal.remove();
  } catch (e) {}

  var alternativo = new File(dirs.base.fsName + "/res-" + id + ".json");
  var problemaAlt = vecWriteVerified(alternativo, texto);

  if (problemaAlt) {
    throw new Error("res/: " + problema + " · raiz: " + problemaAlt);
  }

  vecBridgeLog("aviso: res/ não aceitou a escrita (" + problema + ") — respondi pela raiz");
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
      ',"errors":' + vecBridge.errors + "}"
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
 * Um ciclo de polling. Chamado por `app.scheduleTask` — precisa ser global.
 */
function vecBridgePoll() {
  if (!vecBridge.running) return;

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
      // Sem uma pista do que estava sendo serializado, um erro aqui é
      // indiagnosticável — foi exatamente o que aconteceu na primeira rodada.
      var pista;
      try {
        pista = " · ao serializar: " + String(vec.json(resposta)).substring(0, 200);
      } catch (e2) {
        pista = " · a própria serialização falhou: " + e2.toString();
      }
      vecBridgeLog("falhei ao responder: " + e.toString() + pista);
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
  vecBridge.taskId = app.scheduleTask("vecBridgePoll()", vecBridge.POLL_MS, true);
  $.global.vecBridgeTaskId = vecBridge.taskId;

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
