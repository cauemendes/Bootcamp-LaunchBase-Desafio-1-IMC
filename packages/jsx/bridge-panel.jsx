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

var vecBridge = {
  running: false,
  taskId: null,
  processed: 0,
  errors: 0,
  ui: null,
  log: [],
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

/** Escreve JSON de forma atômica: `.tmp` primeiro, depois renomeia. */
function vecWriteResult(dirs, id, payload) {
  var tmp = new File(dirs.res.fsName + "/" + id + ".json.tmp");
  tmp.encoding = "UTF-8";

  if (!tmp.open("w")) throw new Error("Não consegui escrever em " + tmp.fsName);

  try {
    tmp.write(vec.json(payload));
  } finally {
    tmp.close();
  }

  // O leitor faz polling nessa pasta; sem o rename ele pode pegar um JSON pela
  // metade e o erro seria intermitente.
  tmp.rename(id + ".json");
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
      vecBridgeLog("falhei ao responder: " + e.toString());
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
