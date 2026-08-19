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

// Também há um auto-início pendente (ver o fim do arquivo). Uma carga nova não pode
// deixar o agendamento da anterior de pé, ou dois deles brigam para iniciar a ponte.
if ($.global.vecBridgeAutoStartId !== undefined && $.global.vecBridgeAutoStartId !== null) {
  try {
    app.cancelTask($.global.vecBridgeAutoStartId);
  } catch (e) {}
  $.global.vecBridgeAutoStartId = null;
}

/**
 * O estado vive em `$.global`, não numa `var` deste arquivo.
 *
 * ── O defeito que isto conserta ───────────────────────────────────────────────
 * `var vecBridge = {...}` era refeito a cada carga do arquivo. Duas cargas na mesma
 * engine — o painel encaixado mais um flutuante, ou fechar e reabrir a aba — davam
 * dois objetos de estado, e o segundo apagava as contas do primeiro: `cycles` voltava
 * a zero, `running` voltava a false com o polling ainda rodando.
 *
 * Pior, `ui` era **um slot só**. O último painel carregado tomava o slot, e daí em
 * diante todo `vecBridgeStatus` e todo texto de botão iam para aquele painel — não
 * para o painel em que a pessoa clicou. O sintoma na tela era o pior possível: clicar
 * em Iniciar e o botão não mudar, sem erro nenhum, como se o clique tivesse sumido.
 *
 * `SCHEMA` existe porque uma versão nova deste arquivo pode carregar numa engine que
 * já tem o estado antigo, sem os campos novos. Aí é melhor recomeçar do zero do que
 * rodar com metade da estrutura.
 */
/**
 * Build deste painel. Precisa casar com `PANEL_BUILD_ESPERADO` no servidor.
 *
 * A engine `vectorizeAE` só relê este arquivo quando o After Effects sobe, então copiar
 * o arquivo novo com o AE aberto não troca o código que está rodando. Sem este número
 * isso é invisível: a correção está no disco, o defeito continua na tela, e a conclusão
 * natural é que a correção está errada.
 */
var VEC_PANEL_BUILD = 7;

var VEC_BRIDGE_SCHEMA = 3;

if (!$.global.vecBridgeState || $.global.vecBridgeState.schema !== VEC_BRIDGE_SCHEMA) {
  $.global.vecBridgeState = {
    schema: VEC_BRIDGE_SCHEMA,
    running: false,
    taskId: null,
    processed: 0,
    errors: 0,
    // Registro de painéis abertos, não um slot. Ver `vecBridgeCadaUI`.
    uis: [],
    log: [],
    lastHeartbeat: 0,
    lastPoll: 0,
    // Fim do último ciclo. Régua do bloqueio — ver `vecBridgePoll`.
    lastEnd: 0,
    cycles: 0,
    supervisorId: null,
    revivals: 0,
    startedAt: 0,
    // O auto-início é adiado (ver o fim do arquivo). Um clique no botão é decisão
    // explícita do usuário e cancela o agendamento pendente.
    autoStart: true,
    avisouHeartbeat: false,
    // null = ainda não sei se dá pra escrever dentro de res/. Ver vecWriteResult().
    resSubpastaOk: null,

    // ── Ritmo do polling ──────────────────────────────────────────────────────
    // Verificar a pasta a cada 350ms parece inofensivo e não é: cada verificação é uma
    // execução de script, e o After Effects **recusa** executar script enquanto há um
    // diálogo modal esperando resposta — recusa mostrando outro diálogo, "Cannot run a
    // script while a modal dialog is waiting for response". A 350ms isso são 171
    // diálogos de erro por minuto de diálogo aberto.
    //
    // O estrago não fica na ponte: qualquer script do usuário que abra uma janela
    // própria — Motion, Ease and Wizz, um painel qualquer — fica inutilizável enquanto a
    // ponte estiver escutando. A ferramenta não pode atrapalhar as outras ferramentas da
    // pessoa.
    //
    // Daí três velocidades. Ocioso é lento, porque ninguém está esperando nada.
    // Trabalhando é rápido, porque comando vem em rajada. E recuo é o que entra em cena
    // quando um bloqueio é detectado, dobrando até o teto. Ver `vecBridgeRitmo`.
    intervalo: 2000,
    IDLE_MS: 2000,
    BUSY_MS: 250,
    MAX_MS: 16000,
    // Bloqueios seguidos que fazem a ponte sair da frente de vez. Ver `vecBridgeRitmo`.
    //
    // Três, e não cinco: cada bloqueio é um diálogo de erro na tela de quem está
    // tentando usar outro script, então o número é literalmente quantos erros a pessoa
    // vê antes de a ponte sumir. Cinco só se justificava enquanto um comando demorado
    // podia ser confundido com bloqueio — o que a régua do `lastEnd` resolveu.
    LIMITE_BLOQUEIOS: 3,
    pausadaPorBloqueio: false,
    // Depois de um comando, vale continuar rápido por um tempo: uma conversa com o
    // servidor manda dezenas de comandos seguidos, não um isolado.
    BUSY_JANELA: 60000,
    busyUntil: 0,
    // Quantos bloqueios seguidos, e quantos ciclos limpos desde o último.
    bloqueios: 0,
    limpos: 0,
    avisouBloqueio: false,
  };
}

var vecBridge = $.global.vecBridgeState;

// Uma carga nova sempre reabre a possibilidade de auto-iniciar: se o arquivo está
// sendo executado, alguém abriu o painel agora.
vecBridge.autoStart = true;

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

/**
 * Lembra, entre sessões do After Effects, se a ponte deve escutar.
 *
 * ── Por que isto não é conforto, é segurança ──────────────────────────────────
 * Painel encaixado volta com o workspace: abrir o After Effects para trabalhar já
 * trazia a ponte escutando, sem ninguém ter pedido. E ponte escutando atropela os
 * outros scripts do usuário, porque o AE recusa executar script com diálogo na tela e
 * mostra um erro a cada verificação. Ou seja: o auto-início transformava "abri o AE
 * para usar o Motion" em "o Motion parou de funcionar".
 *
 * Com a preferência gravada, um clique em Parar vale para as próximas sessões também —
 * é um interruptor de verdade. E um lote noturno em andamento sobrevive a um reinício
 * do aplicativo, porque a última escolha foi "escutando".
 *
 * O padrão de instalação nova é **não** escutar. Escutar é a opção que pode incomodar;
 * ela tem que ser pedida.
 */
function vecBridgePrefFile() {
  return new File(vecBridgeDir().base.fsName + "/panel-pref.json");
}

function vecBridgeLerPref() {
  try {
    var f = vecBridgePrefFile();
    if (!f.exists) return false;

    f.encoding = "UTF-8";
    if (!f.open("r")) return false;

    var texto;
    try {
      texto = f.read();
    } finally {
      f.close();
    }

    // Comparação de substring em vez de eval: o arquivo é escrito por nós, tem uma
    // chave só, e avaliar conteúdo de disco para ler um booleano seria desproporcional.
    return String(texto).indexOf('"escutando":true') !== -1;
  } catch (e) {
    return false;
  }
}

function vecBridgeGravarPref(escutando) {
  try {
    var f = vecBridgePrefFile();
    f.encoding = "UTF-8";
    if (!f.open("w")) return;
    try {
      f.write('{"escutando":' + (escutando ? "true" : "false") + "}");
    } finally {
      f.close();
    }
  } catch (e) {
    // Preferência é conveniência: perdê-la custa um clique, não uma sessão.
  }
}

// ---------------------------------------------------------------- ponte

/**
 * Aplica algo a todos os painéis abertos, e esquece os que morreram.
 *
 * Escrever numa widget de painel já destruído lança. Antes de existir o registro isso
 * era um risco só; com N painéis passa a ser certeza, porque fechar uma aba não avisa
 * ninguém. Cada escrita que falha remove aquele painel da lista — a UI se limpa sozinha
 * em vez de precisar de bookkeeping perfeito no fechamento.
 */
function vecBridgeCadaUI(fn) {
  var vivos = [];

  for (var i = 0; i < vecBridge.uis.length; i++) {
    var ui = vecBridge.uis[i];

    try {
      fn(ui);
      ui.falhas = 0;
      vivos.push(ui);
    } catch (e) {
      // ── Por que não podar na primeira falha ───────────────────────────────
      // A versão anterior tirava o painel do registro em qualquer exceção. Isso
      // confunde duas coisas muito diferentes: painel destruído, que nunca mais aceita
      // escrita, e falha passageira — o After Effects refazendo o layout durante a
      // subida do aplicativo, um diálogo de erro de outro script na frente.
      //
      // Podar por uma falha passageira produz o sintoma mais confuso que este painel
      // já teve: o botão para de responder para sempre. O clique roda, o estado muda,
      // a ponte liga e desliga de verdade — e o rótulo nunca mais acompanha, porque o
      // painel saiu da lista de quem recebe atualização. Quem olha vê um botão morto.
      ui.falhas = (ui.falhas || 0) + 1;
      if (ui.falhas < 3) vivos.push(ui);
    }
  }

  vecBridge.uis = vivos;
}

/**
 * Garante que este painel está no registro.
 *
 * Um painel em que alguém acabou de clicar está vivo, por definição. Se ele não estiver
 * na lista — podado por falhas, ou de uma carga anterior do arquivo —, o lugar certo de
 * corrigir isso é aqui, onde há prova de vida.
 */
function vecBridgeGarantirUI(ui) {
  for (var i = 0; i < vecBridge.uis.length; i++) {
    if (vecBridge.uis[i] === ui) {
      ui.falhas = 0;
      return;
    }
  }

  ui.falhas = 0;
  vecBridge.uis.push(ui);
}

function vecBridgeLog(message) {
  var hora = new Date().toTimeString().substring(0, 8);
  vecBridge.log.push(hora + "  " + message);

  // Um painel aberto o dia inteiro acumularia milhares de linhas.
  if (vecBridge.log.length > 60) vecBridge.log.shift();

  var texto = vecBridge.log.join("\n");

  vecBridgeCadaUI(function (ui) {
    ui.logBox.text = texto;
    // Sem isso o usuário fica olhando o começo do log enquanto o interessante
    // acontece no fim.
    try {
      ui.logBox.textselection = "";
    } catch (e) {}
  });
}

/**
 * Descreve um erro sem nunca poder lançar.
 *
 * ── Por que isto não é paranoia ───────────────────────────────────────────────
 * O painel tem três camadas de captura, e todas as três chamavam `vec.describeError(e)`
 * ao montar a mensagem. O argumento é avaliado antes da chamada, então se
 * `describeError` lançasse — `vec` não carregado, uma versão sem o método —, a exceção
 * escapava do catch que devia relatá-la, subia para o catch de cima, lançava de novo
 * ali, e terminava no `catch (e2) {}` que engole. Resultado: a falha original
 * desaparecia sem uma linha de log.
 *
 * Um relator de erro que pode lançar não é um relator de erro.
 */
function vecBridgeMotivo(e) {
  try {
    return vec.describeError(e);
  } catch (semVec) {}

  try {
    return String(e);
  } catch (semString) {}

  return "erro que não consegui descrever";
}

function vecBridgeStatus(text) {
  vecBridgeCadaUI(function (ui) {
    ui.status.text = text;
  });
}

/**
 * Sincroniza o rótulo do botão em todos os painéis com o estado real da ponte.
 *
 * Existe como função própria porque `running` pode mudar sem clique — o supervisor
 * reanima, uma carga nova assume o estado — e um botão dizendo "Iniciar" com a ponte
 * ligada é pior que inútil: convida o usuário a desligar pensando que está ligando.
 */
function vecBridgeRefreshUI() {
  var rotulo = vecBridge.running ? "Parar" : "Iniciar";

  vecBridgeCadaUI(function (ui) {
    ui.toggle.text = rotulo;
  });
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
function vecBridgeHeartbeat(dirs, forcar) {
  var agora = new Date().getTime();

  // Escrever a cada ciclo de 350ms seria disco à toa; 2s dá resolução de sobra
  // para diferenciar "vivo" de "morto". `forcar` existe para o heartbeat final,
  // gravado ao parar a ponte, que precisa sair na hora.
  if (!forcar && vecBridge.lastHeartbeat && agora - vecBridge.lastHeartbeat < 2000) return;
  vecBridge.lastHeartbeat = agora;

  try {
    var tmp = new File(dirs.base.fsName + "/heartbeat.json.tmp");
    tmp.encoding = "UTF-8";
    if (!tmp.open("w")) {
      vecBridgeAvisoHeartbeat("open('w') devolveu false");
      return;
    }
    tmp.write(
      '{"at":' + agora +
      ',"afterEffects":' + vec.quote(app.version) +
      ',"processed":' + vecBridge.processed +
      ',"errors":' + vecBridge.errors +
      // `cycles` e `revivals` são o que permite ao lado Node distinguir "AE fechado"
      // de "AE aberto e o polling morreu" — dois problemas com soluções diferentes,
      // que antes davam a mesma mensagem inútil.
      ',"cycles":' + vecBridge.cycles +
      ',"revivals":' + vecBridge.revivals +
      // `running` separa "parei porque me pediram" de "congelei". Sem isto, um painel
      // com a ponte desligada no botão é indistinguível de um painel travado, e o
      // conselho que o lado Node dá para cada caso é diferente.
      ',"running":' + (vecBridge.running ? "true" : "false") +
      // `uptime` é o que revela *quando* congelou. Parar depois de 2s de vida é a
      // assinatura de um diálogo do After Effects na subida; parar depois de meia hora
      // é outro problema inteiramente.
      ',"uptime":' + (vecBridge.startedAt ? agora - vecBridge.startedAt : 0) +
      // Diz ao servidor que a pausa não é descuido: alguém está usando o After Effects.
      // Sem isto ele manda "clique em Iniciar", que é o oposto do que a situação pede.
      ',"pausadaPorBloqueio":' + (vecBridge.pausadaPorBloqueio ? "true" : "false") +
      ',"intervalo":' + vecBridge.intervalo +
      ',"build":' + VEC_PANEL_BUILD + "}"
    );
    tmp.close();

    var alvo = new File(dirs.base.fsName + "/heartbeat.json");
    if (alvo.exists) alvo.remove();
    if (!tmp.rename("heartbeat.json")) vecBridgeAvisoHeartbeat("rename devolveu false");
  } catch (e) {
    // Heartbeat é diagnóstico; falhar aqui não pode derrubar o polling.
    vecBridgeAvisoHeartbeat(vecBridgeMotivo(e));
  }
}

/**
 * Avisa no log que o heartbeat não está sendo gravado — uma vez, não a cada 2s.
 *
 * Antes esta falha era engolida em silêncio, e o efeito era cruel: o arquivo
 * congelava no último valor bom, o lado Node lia "parou de escutar há 300s" e mandava
 * reiniciar o painel — enquanto o painel estava perfeito e só não conseguia gravar o
 * arquivo de diagnóstico. Silêncio aqui manda investigar o lugar errado.
 */
function vecBridgeAvisoHeartbeat(motivo) {
  if (vecBridge.avisouHeartbeat) return;
  vecBridge.avisouHeartbeat = true;
  try {
    vecBridgeLog(
      "AVISO: não consigo gravar heartbeat.json (" + motivo + "). A ponte funciona, " +
        "mas o servidor vai achar que ela parou. Só aviso isto uma vez."
    );
  } catch (e) {}
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
    vecBridgeLog("       emergência falhou também: " + vecBridgeMotivo(e));
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

  var agora = new Date().getTime();

  // ── Como se detecta que houve bloqueio ──────────────────────────────────────
  // O After Effects recusa executar script com diálogo modal na tela, e a recusa
  // acontece antes do nosso código: não há try/catch que a capture. O que sobra é
  // medir depois. Se o ciclo chegou muito mais tarde que o combinado, alguém segurou a
  // thread principal — e a única coisa útil a fazer é passar a incomodar menos.
  //
  // A medida sai do FIM do ciclo anterior, não do início dele. A diferença não é
  // detalhe: um `build_scene` de quarenta segundos roda dentro de um ciclo, e medido do
  // início ele apareceria como quarenta segundos de atraso — um bloqueio inventado a
  // cada comando demorado. Num lote de dezenas de cenas isso pausaria a ponte sozinha,
  // no meio do trabalho, dizendo que o After Effects estava ocupado por causa do
  // trabalho que ela mesma estava fazendo.
  var atraso = vecBridge.lastEnd ? agora - vecBridge.lastEnd : 0;

  if (atraso > vecBridge.intervalo * 4 + 1000) {
    vecBridge.bloqueios++;
    vecBridge.limpos = 0;
  } else {
    vecBridge.limpos++;
  }

  // Este carimbo é o que o supervisor usa para saber que o polling está de pé.
  vecBridge.lastPoll = agora;
  vecBridge.cycles++;

  try {
    vecBridgePollInterno();
  } catch (e) {
    // Log em try próprio: se a UI foi destruída, escrever nela lança — e essa exceção
    // seria justamente a que mata a tarefa.
    try {
      vecBridgeLog("erro no ciclo de polling (a ponte continua): " + vecBridgeMotivo(e));
    } catch (e2) {}
  }

  // Os dois carimbos de saída. `lastEnd` é a régua do bloqueio; `lastPoll` também é
  // atualizado aqui porque, sem isso, um comando demorado faria o supervisor concluir
  // que o polling morreu e reanimar um polling que estava só trabalhando.
  vecBridge.lastEnd = new Date().getTime();
  vecBridge.lastPoll = vecBridge.lastEnd;

  // Depois do trabalho, nunca antes: se o ritmo mudar, esta tarefa é cancelada e
  // substituída, e o que vier depois da troca não roda.
  try {
    vecBridgeRitmo();
  } catch (e) {}
}

/**
 * Reagenda o polling com um intervalo novo.
 *
 * `scheduleTask` não deixa mudar o intervalo de uma tarefa existente, então trocar de
 * ritmo é cancelar e agendar de novo.
 */
function vecBridgeAgendarPoll(ms) {
  if (vecBridge.taskId !== null) {
    try {
      app.cancelTask(vecBridge.taskId);
    } catch (e) {}
  }

  vecBridge.intervalo = ms;
  vecBridge.taskId = app.scheduleTask("vecBridgePoll()", ms, true);
  $.global.vecBridgeTaskId = vecBridge.taskId;
}

/** Intervalo que o estado atual pede. Ver o comentário de `intervalo` no estado. */
function vecBridgeIntervaloDesejado() {
  if (vecBridge.bloqueios > 0) {
    var recuo = vecBridge.IDLE_MS;
    for (var i = 0; i < vecBridge.bloqueios && recuo < vecBridge.MAX_MS; i++) recuo *= 2;
    return recuo > vecBridge.MAX_MS ? vecBridge.MAX_MS : recuo;
  }

  if (vecBridge.busyUntil > new Date().getTime()) return vecBridge.BUSY_MS;

  return vecBridge.IDLE_MS;
}

/**
 * Ajusta o ritmo ao fim de cada ciclo.
 *
 * A recuperação é gradual, um degrau por três ciclos limpos, e não de uma vez. Voltar
 * direto ao ritmo rápido depois de um bloqueio só recriaria a tempestade: o diálogo que
 * bloqueou costuma ser o primeiro de vários, porque a pessoa está usando outro script.
 */
function vecBridgeRitmo() {
  // ── Recuar não é suficiente ─────────────────────────────────────────────────
  // Mesmo a 16s a ponte ainda produz um diálogo de erro por bloqueio, e quem está do
  // outro lado é uma pessoa tentando usar o Motion ou outro painel. Bloqueio que
  // insiste significa que o After Effects está sendo usado por alguém, e a única
  // resposta correta é sair da frente e esperar ser chamada de volta.
  //
  // Numa execução sem ninguém acompanhando isto também está certo: diálogo que não sai
  // da tela precisa de um humano de qualquer jeito.
  if (vecBridge.bloqueios >= vecBridge.LIMITE_BLOQUEIOS) {
    vecBridge.pausadaPorBloqueio = true;

    vecBridgeLog(
      "PAUSEI a ponte: " + vecBridge.bloqueios + " bloqueios seguidos. O After Effects " +
        "está sendo usado por outro script ou esperando resposta numa janela, e cada " +
        "verificação minha virava um erro na sua tela."
    );
    vecBridgeLog("Clique em Iniciar quando quiser a ponte de volta.");

    vecBridgeStop();
    vecBridgeStatus("pausada — o After Effects está ocupado");
    return;
  }

  if (vecBridge.bloqueios > 0 && vecBridge.limpos >= 3) {
    vecBridge.bloqueios--;
    vecBridge.limpos = 0;

    if (vecBridge.bloqueios === 0) {
      vecBridge.avisouBloqueio = false;
      vecBridgeLog("o bloqueio passou — voltei ao ritmo normal.");
    }
  }

  var alvo = vecBridgeIntervaloDesejado();
  if (alvo === vecBridge.intervalo) return;

  var subiu = alvo > vecBridge.intervalo;
  vecBridgeAgendarPoll(alvo);

  if (subiu && vecBridge.bloqueios > 0 && !vecBridge.avisouBloqueio) {
    vecBridge.avisouBloqueio = true;
    vecBridgeLog(
      "algo bloqueou a thread do After Effects — quase sempre uma janela aberta por " +
        "outro script, ou pelo próprio AE. Passei a verificar a cada " +
        (alvo / 1000).toFixed(0) + "s para não atrapalhar."
    );
    vecBridgeLog(
      "Se você vai trabalhar com outro script agora, clique em Parar: enquanto a ponte " +
        "escuta, o AE recusa rodar script com diálogo na tela e mostra um erro a cada " +
        "verificação."
    );
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

    // Comando vem em rajada: fica rápido por um tempo depois deste.
    vecBridge.busyUntil = new Date().getTime() + vecBridge.BUSY_JANELA;

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
      vecBridgeLog("falhei ao responder: " + vecBridgeMotivo(e));

      try {
        vecBridgeLog("       pilha: " + String($.stack).replace(/\n/g, " ‹ ").substring(0, 300));
      } catch (eStack) {}

      vecRespostaDeEmergencia(dirs, comando.id, vecBridgeMotivo(e));
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
    // Folga sobre o intervalo *ativo*, não sobre um número fixo: em recuo de 30s um
    // limite de 1s faria o supervisor reanimar um polling que está apenas devagar.
    if (idade < vecBridge.intervalo * 3 + 2000) return;

    vecBridge.revivals++;

    if (vecBridge.taskId !== null) {
      try {
        app.cancelTask(vecBridge.taskId);
      } catch (e) {}
    }

    vecBridgeAgendarPoll(vecBridge.intervalo);
    vecBridge.lastPoll = agora;

    vecBridgeLog(
      "o polling havia parado (" + Math.round(idade / 1000) + "s sem ciclo) — reiniciei. " +
        "Reanimações nesta sessão: " + vecBridge.revivals
    );
  } catch (e) {
    // Nem o supervisor pode lançar: se ele morrer, ninguém reanima ninguém.
  }
}

/**
 * @param {Boolean} rapido true quando um humano clicou e está esperando resposta.
 *   No auto-início ninguém clicou, então começar no ritmo rápido só aumentaria a
 *   chance de atropelar um diálogo que já esteja na tela.
 */
function vecBridgeStart(rapido) {
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
  vecBridge.startedAt = vecBridge.lastPoll;
  vecBridge.lastEnd = vecBridge.lastPoll;

  vecBridge.busyUntil = rapido ? vecBridge.lastPoll + vecBridge.BUSY_JANELA : 0;
  vecBridge.bloqueios = 0;
  vecBridge.limpos = 0;
  vecBridge.avisouBloqueio = false;
  vecBridge.pausadaPorBloqueio = false;
  vecBridgeAgendarPoll(rapido ? vecBridge.BUSY_MS : vecBridge.IDLE_MS);

  // Segunda tarefa, independente: vigia a primeira.
  vecBridge.supervisorId = app.scheduleTask("vecBridgeSupervise()", 5000, true);
  $.global.vecBridgeSupervisorId = vecBridge.supervisorId;

  vecBridgeStatus("ouvindo");
  vecBridgeLog("ponte ativa em " + dirs.base.fsName);

  vecBridgeRefreshUI();
}

/**
 * Alvo do auto-início adiado. Global porque `scheduleTask` avalia uma string no
 * escopo global — uma função aninhada não seria encontrada.
 */
function vecBridgeAutoStart() {
  if (!vecBridge.autoStart) return;
  vecBridge.autoStart = false;

  // Saiu da carga do painel para cá: `app.version` é DOM e a preferência é disco, e
  // nenhum dos dois precisa acontecer no meio da subida do aplicativo.
  vecBridgeLog(
    "painel carregado — build " + VEC_PANEL_BUILD + " · After Effects " + app.version
  );

  if (!vecBridgeLerPref()) {
    vecBridgeStatus("parada — clique em Iniciar");
    vecBridgeLog(
      "não iniciei sozinha: a última escolha foi deixar a ponte parada. Enquanto ela " +
        "escuta, o After Effects pode recusar rodar outros scripts que abram janela."
    );
    return;
  }

  vecBridgeLog("retomando: a ponte estava escutando quando o After Effects fechou.");
  vecBridgeStart(false);
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

  // Heartbeat final. Sem ele o arquivo fica com `running:true` para sempre, e o
  // servidor lê uma ponte desligada de propósito como uma ponte travada.
  try {
    vecBridgeHeartbeat(vecBridgeDir(), true);
  } catch (e) {}

  vecBridgeStatus("parado");
  vecBridgeLog("ponte parada");

  vecBridgeRefreshUI();
}

/**
 * Relatório do estado real da ponte, escrito no log.
 *
 * ── Por que isto roda no clique e não numa tarefa ─────────────────────────────
 * Todo o resto do diagnóstico depende de `scheduleTask`, e existe um caso em que
 * `scheduleTask` é justamente o que não funciona: com um diálogo do After Effects na
 * tela, a thread principal está bloqueada e nenhuma tarefa agendada roda. O painel
 * continua dizendo "ouvindo" porque ninguém sobrou para corrigir o texto.
 *
 * Um clique de botão é evento de UI e roda de todo jeito. Então esta é a única leitura
 * que funciona exatamente quando é mais necessária.
 */
function vecBridgeDiagnostico() {
  var agora = new Date().getTime();

  vecBridgeLog("── diagnóstico ──");
  vecBridgeLog(
    "ponte: " + (vecBridge.running ? "ligada" : "desligada") +
      " · ciclos: " + vecBridge.cycles +
      " · comandos: " + vecBridge.processed + " ok, " + vecBridge.errors + " com erro"
  );
  vecBridgeLog(
    "painéis abertos: " + vecBridge.uis.length +
      " · reanimações: " + vecBridge.revivals +
      " · After Effects " + app.version
  );
  vecBridgeLog("build do painel: " + VEC_PANEL_BUILD);
  vecBridgeLog(
    "ritmo: " + (vecBridge.intervalo / 1000).toFixed(2) + "s entre verificações" +
      (vecBridge.bloqueios ? " · em recuo por " + vecBridge.bloqueios + " bloqueio(s)" : "")
  );

  if (vecBridge.pausadaPorBloqueio) {
    vecBridgeLog(
      "a ponte se pausou sozinha porque bloqueios seguidos indicam que o After Effects " +
        "está em uso. Clique em Iniciar quando quiser retomar."
    );
  }

  if (!vecBridge.running) {
    vecBridgeLog("a ponte está desligada — clique em Iniciar.");
    vecBridgeLog("── fim ──");
    return;
  }

  // ── Por que `cycles` e não só `lastPoll` ────────────────────────────────────
  // `vecBridgeStart` carimba `lastPoll` na largada, para o supervisor não confundir uma
  // ponte recém-ligada com uma morta. O efeito colateral é que, no instante seguinte ao
  // clique em Iniciar, `lastPoll` está fresco e o polling parece saudável — mesmo que
  // nenhum ciclo tenha rodado. E é justamente esse o momento em que a pessoa aperta o
  // diagnóstico. Zero ciclo é a evidência que não mente.
  var espera = vecBridge.intervalo * 6 + 1000;
  var desdeInicio = vecBridge.startedAt ? agora - vecBridge.startedAt : 0;

  if (vecBridge.cycles === 0) {
    if (desdeInicio < espera) {
      vecBridgeLog(
        "liguei há " + (desdeInicio / 1000).toFixed(1) + "s e o primeiro ciclo ainda não " +
          "rodou. Espere um segundo e clique aqui de novo."
      );
      vecBridgeLog("── fim ──");
      return;
    }
    vecBridgeLog(
      "ATENÇÃO: a ponte está ligada há " + (desdeInicio / 1000).toFixed(1) +
        "s e o polling nunca rodou nenhum ciclo."
    );
  } else {
    var idade = agora - vecBridge.lastPoll;

    if (idade <= espera) {
      vecBridgeLog("polling normal: último ciclo há " + (idade / 1000).toFixed(1) + "s.");
      vecBridgeLog("── fim ──");
      return;
    }

    vecBridgeLog("ATENÇÃO: último ciclo há " + (idade / 1000).toFixed(1) + "s — o polling parou.");
  }

  // Chegou aqui: ligada e sem rodar. Só há uma causa comum, e ela não se resolve no
  // painel — então vale dizer o que fazer em vez de deixar o usuário adivinhar.
  vecBridgeLog(
    "Causa mais comum: um diálogo do After Effects aberto — inclusive atrás da janela " +
      "principal. Enquanto ele estiver na tela, nenhuma tarefa agendada roda, e nem " +
      "Parar → Iniciar resolve. Feche todo diálogo primeiro, depois clique aqui de novo."
  );
  vecBridgeLog("── fim ──");
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
    win.minimumSize = [180, 160];

    var topo = win.add("group");
    topo.alignChildren = ["left", "center"];
    topo.alignment = ["fill", "top"];

    // `truncate` evita que uma mensagem longa force o painel a ficar largo: com o painel
    // estreito o texto é cortado, em vez de o layout empurrar as bordas para fora.
    var status = topo.add("statictext", undefined, "parado", { truncate: "end" });
    status.alignment = ["fill", "center"];
    status.minimumSize.width = 40;

    var toggle = topo.add("button", undefined, "Iniciar");
    // Largura fixa: o rótulo alterna entre "Iniciar" e "Parar", e sem isto o botão muda
    // de tamanho a cada clique, empurrando o status de um lado para o outro.
    toggle.preferredSize.width = 80;
    toggle.minimumSize.width = 80;

    var logBox = win.add("edittext", undefined, "", { multiline: true, readonly: true, scrolling: true });

    // ── Por que minimumSize e não preferredSize ─────────────────────────────────
    // `preferredSize.height = 180` era um piso disfarçado: o ScriptUI monta o layout a
    // partir do tamanho preferido dos filhos, então o painel não conseguia ficar menor
    // que isso e o conteúdo era cortado em vez de encolher. `minimumSize` diz o mínimo
    // de verdade, e `preferredSize` fica só como sugestão de tamanho inicial.
    logBox.minimumSize = [120, 48];
    logBox.preferredSize = [260, 160];
    logBox.alignment = ["fill", "fill"];

    var rodape = win.add("group");
    rodape.alignment = ["fill", "bottom"];
    rodape.spacing = 6;
    var diagnostico = rodape.add("button", undefined, "Diagnóstico");
    diagnostico.alignment = ["fill", "bottom"];
    var abrirPasta = rodape.add("button", undefined, "Abrir pasta");
    abrirPasta.alignment = ["fill", "bottom"];

    var minhaUI = { win: win, status: status, toggle: toggle, logBox: logBox };
    vecBridge.uis.push(minhaUI);

    toggle.onClick = function () {
      // Prova de vida: este painel aceitou um clique, então tem que estar recebendo as
      // atualizações. Se tinha saído do registro, volta agora.
      vecBridgeGarantirUI(minhaUI);

      // ── O clique se anuncia no log ───────────────────────────────────────────
      // "Cliquei e não mudou nada" é ambíguo entre duas coisas muito diferentes: o
      // handler não rodou, ou rodou e falhou. Uma linha no log separa as duas de graça,
      // e sem ela a pergunta só se responde com outra rodada de teste.
      vecBridgeLog(vecBridge.running ? "clique: Parar" : "clique: Iniciar");

      // Um clique é decisão explícita e vence o auto-início pendente — inclusive um
      // "Parar" durante a espera, que antes seria desfeito pelo agendamento.
      vecBridge.autoStart = false;

      // ScriptUI engole exceção de handler sem deixar rastro: o botão simplesmente
      // não reage. Melhor capturar e contar.
      try {
        if (vecBridge.running) {
          vecBridgeStop();
          // Um Parar clicado vale para as próximas sessões: é a diferença entre um
          // botão e um interruptor.
          vecBridgeGravarPref(false);
        } else {
          vecBridgeStart(true);
          vecBridgeGravarPref(true);
        }
      } catch (e) {
        try {
          vecBridgeLog("o clique falhou: " + vecBridgeMotivo(e));
        } catch (e2) {}
      }

      // Mesmo que algo acima tenha falhado, o rótulo passa a refletir a verdade.
      vecBridgeRefreshUI();

      // E o painel clicado é atualizado direto, sem passar pelo registro. Redundante
      // quando tudo funciona, e é o que garante a resposta visual ao clique quando
      // não funciona — que é o único momento em que isso importa.
      try {
        minhaUI.toggle.text = vecBridge.running ? "Parar" : "Iniciar";
      } catch (e) {}
    };

    diagnostico.onClick = function () {
      try {
        vecBridgeDiagnostico();
      } catch (e) {
        try {
          vecBridgeLog("o diagnóstico falhou: " + vecBridgeMotivo(e));
        } catch (e2) {}
      }
    };

    abrirPasta.onClick = function () {
      try {
        vecBridgeDir().base.execute();
      } catch (e) {
        vecBridgeLog("não consegui abrir a pasta: " + e.toString());
      }
    };

    // ── Redimensionamento ───────────────────────────────────────────────────────
    // `onResizing` dispara durante o arraste e `onResize` no fim; painel encaixado usa o
    // segundo, janela flutuante os dois. `layout.resize()` reaproveita o layout já
    // montado para a nova área — é o que faz o log crescer junto com o painel.
    //
    // Em try porque isto é evento de UI: uma exceção aqui, num painel que o After
    // Effects está redimensionando, aparece como diálogo de erro no meio do arraste.
    win.onResizing = win.onResize = function () {
      try {
        this.layout.resize();
      } catch (e) {}
    };

    win.onClose = function () {
      // Sai do registro primeiro, senão as escritas seguintes vão para uma widget
      // destruída.
      var restantes = [];
      for (var i = 0; i < vecBridge.uis.length; i++) {
        if (vecBridge.uis[i] !== minhaUI) restantes.push(vecBridge.uis[i]);
      }
      vecBridge.uis = restantes;

      // Fechar o painel sem parar o polling deixaria uma tarefa órfã rodando na engine
      // até o After Effects fechar. Mas só para se este era o último painel: com outro
      // aberto, fechar uma aba duplicada desligava a ponte que o outro painel ainda
      // mostrava como "ouvindo".
      if (vecBridge.uis.length === 0) vecBridgeStop();

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

  // ── Por que quase nada acontece aqui ────────────────────────────────────────
  // Um painel encaixado carrega junto com o workspace, durante a subida do After
  // Effects, antes de existir projeto aberto — e ao lado dos outros painéis de script
  // do usuário, que estão carregando no mesmo instante. É a janela mais frágil que
  // existe, e onde apareceu `internal verification failure {no current context}` com o
  // Bridge e o Motion abertos juntos.
  //
  // Então a carga faz o mínimo: monta as widgets e agenda uma tarefa. Nada de ler
  // arquivo de preferência, nada de consultar `app.version`, nada de escrever no log —
  // tudo isso foi para dentro do início adiado, onde a thread já está livre.
  //
  // `scheduleTask` com repeat=false só registra o timer; o callback roda depois, na
  // thread principal, quando ela estiver desocupada. Se o AE ainda estiver subindo, ou
  // com um diálogo na frente, ele simplesmente atrasa — que é o comportamento
  // desejado, não um efeito colateral.
  vecBridgeRefreshUI();

  // Se a ponte já está de pé — carga nova de painel numa engine que já estava
  // escutando — não há o que aguardar nem o que reiniciar.
  if (vecBridge.running) {
    vecBridgeStatus("ouvindo");
  } else {
    vecBridgeStatus("aguardando o After Effects terminar de subir…");
    $.global.vecBridgeAutoStartId = app.scheduleTask("vecBridgeAutoStart()", 5000, false);
  }
})(this);
