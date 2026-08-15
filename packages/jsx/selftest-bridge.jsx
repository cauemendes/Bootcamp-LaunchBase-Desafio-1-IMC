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
 *   4. O painel está aberto e dando sinal de vida?
 *
 * O passo 4 lê o heartbeat que o painel grava a cada 2s. Não dá para enviar um
 * comando e esperar a resposta daqui: um script em execução bloqueia a thread
 * principal do After Effects, que é a mesma que roda o polling do painel — o
 * diagnóstico travaria justamente quem deveria responder.
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
      // ⚠️ Folder.name vem com URI-encoding: "Adobe%20After%20Effects%202026".
      // Comparar direto com "Adobe After Effects" nunca casa — e falha em
      // silêncio, porque getFiles simplesmente devolve lista vazia.
      return f instanceof Folder && decodeURI(f.name).indexOf("Adobe After Effects") === 0;
    });
    for (var i = 0; i < apps.length; i++) {
      candidatos.push(apps[i].fsName + "/Scripts/ScriptUI Panels");
    }
  } catch (e) {
    info("não consegui listar /Applications: " + e.toString());
  }

  // O After Effects também carrega painéis da pasta do usuário, que não exige
  // permissão de administrador.
  candidatos.push(Folder.userData.fsName + "/Adobe/After Effects/26.3/Scripts/ScriptUI Panels");
  candidatos.push(Folder.myDocuments.fsName + "/Adobe/After Effects 2026/Scripts/ScriptUI Panels");

  var achouPainel = false;

  for (var c = 0; c < candidatos.length; c++) {
    var painel = new File(candidatos[c] + "/bridge-panel.jsx");
    if (!painel.exists) continue;

    achouPainel = true;
    ok("bridge-panel.jsx em " + candidatos[c]);

    // Um arquivo ainda com includes depende da pasta lib/ ao lado — e é essa
    // dependência que quebra depois da cópia para dentro do aplicativo.
    try {
      painel.encoding = "UTF-8";
      painel.open("r");
      var conteudo = painel.read();
      painel.close();

      if (conteudo.indexOf("@include") !== -1 || conteudo.indexOf("#include") !== -1) {
        falha("este painel ainda usa includes (versão antiga)",
          "rode `bash scripts/install-bridge.sh` de novo — a versão nova gera um " +
            "arquivo único, sem includes");
      } else {
        info("versão empacotada, arquivo único — correto");
      }
    } catch (e) {
      info("não consegui ler o arquivo do painel: " + e.toString());
    }
  }

  if (!achouPainel) {
    falha("não encontrei bridge-panel.jsx em nenhuma pasta ScriptUI Panels",
      "se o painel está aberto no menu Window, ele foi instalado em outro lugar — " +
        "rode `bash scripts/install-bridge.sh` para padronizar");
    for (var d = 0; d < candidatos.length; d++) info("procurei em: " + candidatos[d]);
  }

  // ---- 4. o teste que importa: a ponte responde? -------------------------

  secao("4. A ponte está viva?");

  if (!pastasOk) {
    info("pulado — as pastas não estão acessíveis");
  } else {
    // Não dá para enviar um ping e esperar a resposta daqui: um script em execução
    // bloqueia a thread principal do After Effects, que é a mesma que roda o
    // polling do painel. O diagnóstico travaria justamente quem deveria responder.
    //
    // Por isso o painel grava um heartbeat a cada 2s, e aqui só olhamos a idade.
    var hb = new File(basePath + "/heartbeat.json");

    if (!hb.exists) {
      falha("o painel nunca gravou sinal de vida",
        "abra Window → bridge-panel.jsx e confirme que mostra \"ouvindo\"");
      info("se o painel já está aberto, feche e abra de novo — a versão antiga " +
        "não gravava heartbeat");
    } else {
      var conteudoHb = "";
      try {
        hb.encoding = "UTF-8";
        hb.open("r");
        conteudoHb = hb.read();
        hb.close();
      } catch (e) {
        info("não consegui ler o heartbeat: " + e.toString());
      }

      var marca = /"at":(\d+)/.exec(conteudoHb);
      var idade = marca ? (new Date().getTime() - parseInt(marca[1], 10)) / 1000 : null;

      if (idade === null) {
        falha("heartbeat ilegível: " + conteudoHb.substring(0, 120));
      } else if (idade < 15) {
        ok("painel vivo — último sinal há " + idade.toFixed(1) + "s");
        info(conteudoHb);
        info("→ a ponte está funcionando. Se o Claude Code ainda falha, o problema " +
          "é do lado do Node.");
      } else {
        falha("último sinal do painel há " + Math.round(idade) + "s — parado",
          "o painel foi fechado, ou o botão está em \"Parar\"");
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
