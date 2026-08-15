/**
 * Diagnóstico da ponte — roda direto no After Effects.
 *
 *   File → Scripts → Run Script File… → selecione este arquivo
 *
 * Responde uma pergunta de cada vez, na ordem em que as coisas quebram:
 *
 *   1. A permissão de escrita está ligada nas preferências?
 *   2. A pasta da ponte existe e dá pra escrever nela?
 *   3. O painel está instalado onde deveria?
 *   4. O painel está aberto e respondendo?
 *
 * O passo 4 é o teste de verdade: escreve um comando na pasta e espera a resposta,
 * exatamente como o servidor MCP faz. Se ele passa, a ponte inteira funciona e o
 * problema está do lado do Node.
 *
 * Arquivo único e sem includes de propósito — se o diagnóstico dependesse das
 * bibliotecas, ele falharia junto com o que está tentando diagnosticar.
 */

/*global app, File, Folder, $, alert*/

(function bridgeDiagnostics() {
  var linhas = [];
  var problemas = [];

  function secao(titulo) {
    linhas.push("");
    linhas.push("── " + titulo + " ──");
  }

  function ok(msg) {
    linhas.push("  OK     " + msg);
  }

  function falha(msg, comoResolver) {
    linhas.push("  FALHA  " + msg);
    if (comoResolver) linhas.push("         → " + comoResolver);
    problemas.push(msg + (comoResolver ? "\n   → " + comoResolver : ""));
  }

  function info(msg) {
    linhas.push("         " + msg);
  }

  linhas.push("Diagnóstico da ponte — Vectorize AE");
  linhas.push("===================================");
  linhas.push("");
  linhas.push("After Effects " + app.version);

  // ---- 1. permissão de escrita -----------------------------------------

  secao("1. Permissão de scripting");

  var permissaoLigada = null;
  try {
    permissaoLigada = app.preferences.getPrefAsLong(
      "Main Pref Section",
      "Pref_SCRIPTING_FILE_NETWORK_SECURITY"
    ) === 1;
  } catch (e) {
    info("não consegui ler a preferência: " + e.toString());
  }

  if (permissaoLigada === true) {
    ok('"Allow Scripts to Write Files and Access Network" está ligada');
  } else if (permissaoLigada === false) {
    falha(
      '"Allow Scripts to Write Files and Access Network" está DESLIGADA',
      "After Effects → Settings → Scripting & Expressions → marque a opção, " +
        "e reinicie o After Effects"
    );
  } else {
    info("não deu pra confirmar pela preferência — o teste de escrita abaixo decide");
  }

  // ---- 2. pasta da ponte ------------------------------------------------

  secao("2. Pasta da ponte");

  var override = $.getenv("VECTORIZE_AE_BRIDGE_DIR");
  var basePath = override
    ? override
    : Folder.userData.fsName + "/vectorize-ae/bridge";

  info("caminho: " + basePath);
  if (override) info("(vindo de VECTORIZE_AE_BRIDGE_DIR)");

  var base = new Folder(basePath);
  var cmd = new Folder(basePath + "/cmd");
  var res = new Folder(basePath + "/res");

  var pastasOk = true;

  try {
    if (!cmd.exists && !cmd.create()) throw new Error("create() devolveu false");
    if (!res.exists && !res.create()) throw new Error("create() devolveu false");
    ok("pastas cmd/ e res/ existem");
  } catch (e) {
    pastasOk = false;
    falha("não consegui criar as pastas: " + e.toString(),
      "verifique a permissão do passo 1");
  }

  if (pastasOk) {
    var teste = new File(basePath + "/diagnostico.tmp");
    try {
      teste.encoding = "UTF-8";
      if (!teste.open("w")) throw new Error("open('w') devolveu false");
      teste.write('{"teste":true}');
      teste.close();

      if (!teste.open("r")) throw new Error("open('r') devolveu false");
      var lido = teste.read();
      teste.close();
      teste.remove();

      if (lido !== '{"teste":true}') throw new Error("o que voltou é diferente do que escrevi");
      ok("escrita e leitura de arquivo funcionam");
    } catch (e) {
      falha("não consigo escrever na pasta: " + e.toString(),
        'quase sempre é a opção "Allow Scripts to Write Files and Access Network" desligada');
    }

    // O rename é o que garante que ninguém leia um JSON pela metade.
    var origem = new File(basePath + "/diagnostico2.tmp");
    try {
      origem.encoding = "UTF-8";
      origem.open("w");
      origem.write("x");
      origem.close();

      if (!origem.rename("diagnostico2.json")) throw new Error("rename() devolveu false");

      var renomeado = new File(basePath + "/diagnostico2.json");
      if (!renomeado.exists) throw new Error("o arquivo renomeado não existe");
      renomeado.remove();
      ok("rename funciona (escrita atômica)");
    } catch (e) {
      falha("rename falhou: " + e.toString(),
        "sem ele o servidor pode ler respostas incompletas");
    }
  }

  // ---- 3. painel instalado ----------------------------------------------

  secao("3. Painel instalado");

  var candidatos = [];
  try {
    var apps = new Folder("/Applications").getFiles(function (f) {
      return f instanceof Folder && f.name.indexOf("Adobe After Effects") === 0;
    });
    for (var i = 0; i < apps.length; i++) {
      candidatos.push(apps[i].fsName + "/Scripts/ScriptUI Panels");
    }
  } catch (e) {
    info("não consegui listar /Applications: " + e.toString());
  }

  var achouPainel = false;

  for (var c = 0; c < candidatos.length; c++) {
    var painel = new File(candidatos[c] + "/bridge-panel.jsx");
    if (painel.exists) {
      achouPainel = true;
      ok("bridge-panel.jsx em " + candidatos[c]);

      // Se o arquivo ainda tiver includes, ele depende da pasta lib/ estar do lado —
      // e é justamente essa dependência que costuma quebrar depois da cópia.
      try {
        painel.encoding = "UTF-8";
        painel.open("r");
        var conteudo = painel.read();
        painel.close();

        if (conteudo.indexOf("@include") !== -1 || conteudo.indexOf("#include") !== -1) {
          var lib = new Folder(candidatos[c] + "/lib");
          if (lib.exists) {
            info("é a versão com includes, e a pasta lib/ está presente");
          } else {
            falha("o painel usa includes mas a pasta lib/ não está do lado dele",
              "rode `bash scripts/install-bridge.sh` de novo — a versão nova gera " +
                "um arquivo único, sem includes");
          }
        } else {
          info("é a versão empacotada (arquivo único, sem includes) — bom");
        }
      } catch (e) {
        info("não consegui ler o arquivo do painel: " + e.toString());
      }
    }
  }

  if (!achouPainel) {
    falha("não encontrei bridge-panel.jsx em nenhuma pasta ScriptUI Panels",
      "rode `bash scripts/install-bridge.sh` no terminal");
    for (var d = 0; d < candidatos.length; d++) info("procurei em: " + candidatos[d]);
  }

  // ---- 4. o teste que importa: a ponte responde? -------------------------

  secao("4. A ponte está respondendo?");

  if (!pastasOk) {
    info("pulado — as pastas não estão acessíveis");
  } else {
    var id = "diag-" + new Date().getTime();
    var enviado = false;

    try {
      var cmdTmp = new File(basePath + "/cmd/" + id + ".json.tmp");
      cmdTmp.encoding = "UTF-8";
      cmdTmp.open("w");
      cmdTmp.write('{"id":"' + id + '","tool":"ping","args":{}}');
      cmdTmp.close();
      cmdTmp.rename(id + ".json");
      enviado = true;
      info("comando ping enviado, esperando até 5s…");
    } catch (e) {
      falha("não consegui enviar o comando de teste: " + e.toString());
    }

    if (enviado) {
      var resposta = null;

      // O painel faz polling a cada 350ms; 5s dá margem de sobra.
      for (var tentativa = 0; tentativa < 25; tentativa++) {
        $.sleep(200);
        var arquivo = new File(basePath + "/res/" + id + ".json");
        if (arquivo.exists) {
          try {
            arquivo.encoding = "UTF-8";
            arquivo.open("r");
            resposta = arquivo.read();
            arquivo.close();
            arquivo.remove();
          } catch (e) {
            resposta = "(erro ao ler: " + e.toString() + ")";
          }
          break;
        }
      }

      if (resposta) {
        ok("a ponte respondeu");
        info(resposta.length > 300 ? resposta.substring(0, 300) + "…" : resposta);
        info("→ a ponte funciona. Se o Claude Code ainda falha, o problema é do lado do Node.");
      } else {
        falha("nenhuma resposta em 5 segundos",
          "o painel provavelmente não está aberto ou não está ouvindo");
        info("abra Window → bridge-panel.jsx e confirme que mostra \"ouvindo\"");

        // Limpa o comando: deixá-lo faria o painel executá-lo ao abrir depois.
        try {
          new File(basePath + "/cmd/" + id + ".json").remove();
        } catch (e) {}
      }
    }
  }

  // ---- relatório --------------------------------------------------------

  linhas.push("");
  linhas.push(problemas.length === 0
    ? "Nenhum problema encontrado — a ponte está pronta."
    : problemas.length + " problema(s) encontrado(s).");

  var texto = linhas.join("\n");
  var destino = "(não consegui escrever o arquivo)";

  try {
    var relatorio = new File(Folder.desktop.fsName + "/vectorize-ae-bridge.txt");
    relatorio.encoding = "UTF-8";
    if (relatorio.open("w")) {
      relatorio.write(texto);
      relatorio.close();
      destino = relatorio.fsName;
    }
  } catch (e) {
    destino = "erro ao escrever: " + e.toString();
  }

  var resumo = "Diagnóstico da ponte\n\n";
  resumo += problemas.length === 0
    ? "Tudo certo — a ponte está funcionando.\n\n"
    : problemas.join("\n\n") + "\n\n";
  resumo += "Relatório completo:\n" + destino;

  alert(resumo);
})();
