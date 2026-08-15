/**
 * Sonda da API de fontes — roda direto no After Effects.
 *
 *   File → Scripts → Run Script File… → selecione este arquivo
 *
 * O autoteste principal descobriu que `textDocument.fontFamily` é somente leitura no
 * After Effects 2026. O caminho que resta é `textDocument.font`, que espera o nome
 * PostScript da fonte — algo que um modelo de visão não tem como saber olhando uma
 * imagem. A ponte entre "parece Helvetica Bold" e "HelveticaNeue-Bold" é o objeto
 * `app.fonts`.
 *
 * Este script não testa nada: ele usa a reflexão do ExtendScript para listar o que
 * `app.fonts` e um objeto de fonte realmente expõem nesta versão. Assim a correção
 * é escrita contra a API que existe, e não contra a que eu lembro que existia.
 *
 * Não modifica o projeto. Escreve o resultado na Área de Trabalho.
 */

/*global app, File, Folder, alert*/

(function probeFontApi() {
  var out = [];

  function push(line) {
    out.push(line === undefined ? "" : String(line));
  }

  /** Lista propriedades e métodos de um objeto usando a reflexão do ExtendScript. */
  function describe(label, obj) {
    push("");
    push("── " + label + " ──");

    if (obj === undefined || obj === null) {
      push("  (não existe nesta versão)");
      return;
    }

    push("  typeof: " + typeof obj);

    try {
      push("  toString: " + obj.toString());
    } catch (e) {
      push("  toString lançou: " + e.toString());
    }

    var r;
    try {
      r = obj.reflect;
    } catch (e) {
      push("  sem reflexão disponível: " + e.toString());
      return;
    }

    if (!r) {
      push("  sem reflexão disponível");
      return;
    }

    try {
      var props = r.properties;
      push("");
      push("  Propriedades (" + props.length + "):");
      for (var i = 0; i < props.length; i++) {
        var nome = props[i].name;
        var valor;
        try {
          var v = obj[nome];
          if (v === undefined) {
            valor = "undefined";
          } else if (v === null) {
            valor = "null";
          } else if (v instanceof Array) {
            valor = "Array(" + v.length + ")";
          } else if (typeof v === "object") {
            valor = "[object]";
          } else {
            valor = String(v);
            if (valor.length > 70) valor = valor.substring(0, 70) + "…";
          }
        } catch (e) {
          valor = "<erro ao ler: " + e.toString() + ">";
        }
        push("    ." + nome + " = " + valor);
      }
    } catch (e) {
      push("  erro ao listar propriedades: " + e.toString());
    }

    try {
      var methods = r.methods;
      push("");
      push("  Métodos (" + methods.length + "):");
      for (var j = 0; j < methods.length; j++) {
        var m = methods[j];
        var args = [];
        try {
          for (var k = 0; k < m.arguments.length; k++) {
            args.push(m.arguments[k].name + ": " + m.arguments[k].dataType);
          }
        } catch (e) {
          args.push("?");
        }
        push("    ." + m.name + "(" + args.join(", ") + ")");
      }
    } catch (e) {
      push("  erro ao listar métodos: " + e.toString());
    }
  }

  push("Sonda da API de fontes — Vectorize AE");
  push("=====================================");
  push("");
  push("After Effects: " + app.version);
  push("Build: " + (app.buildName || "(não informado)"));

  // ---- app.fonts --------------------------------------------------------

  var fonts = null;
  try {
    fonts = app.fonts;
  } catch (e) {
    push("");
    push("app.fonts lançou ao ser acessado: " + e.toString());
  }

  describe("app.fonts", fonts);

  // ---- um objeto de fonte concreto --------------------------------------

  var amostra = null;
  var total = 0;

  if (fonts) {
    try {
      var todas = fonts.allFonts;
      total = todas ? todas.length : 0;
      push("");
      push("Total de fontes visíveis ao script: " + total);
      if (total > 0) amostra = todas[0];
    } catch (e) {
      push("");
      push("Erro ao ler app.fonts.allFonts: " + e.toString());
    }
  }

  describe("Objeto de fonte (a primeira de allFonts)", amostra);

  // ---- amostra legível: as 25 primeiras fontes --------------------------
  //
  // Precisamos ver o formato real de familyName / styleName / postScriptName para
  // saber como casar o palpite do modelo ("Helvetica" + "Bold") com o que o AE quer.

  if (fonts && total > 0) {
    push("");
    push("── Amostra: 25 primeiras fontes ──");
    push("");
    try {
      var lista = fonts.allFonts;
      var limite = Math.min(25, lista.length);
      for (var f = 0; f < limite; f++) {
        var fo = lista[f];
        var familia = "?", estilo = "?", ps = "?";
        try { familia = fo.familyName; } catch (e) {}
        try { estilo = fo.styleName; } catch (e) {}
        try { ps = fo.postScriptName; } catch (e) {}
        push("  " + familia + "  |  " + estilo + "  |  " + ps);
      }
    } catch (e) {
      push("  erro ao percorrer: " + e.toString());
    }
  }

  // ---- testar a busca por família e estilo ------------------------------
  //
  // Se existir um método de busca, ele é muito melhor que varrer milhares de
  // fontes a cada camada de texto.

  push("");
  push("── Busca por família + estilo ──");

  if (fonts) {
    var candidatos = [
      "getFontsByFamilyNameAndStyleName",
      "getFontsByPostScriptName",
      "getFontsByFamilyName",
    ];

    for (var c = 0; c < candidatos.length; c++) {
      var nome = candidatos[c];
      if (typeof fonts[nome] !== "function") {
        push("  " + nome + " — não existe");
        continue;
      }

      try {
        var res;
        if (nome === "getFontsByFamilyNameAndStyleName") {
          res = fonts[nome]("Helvetica", "Regular");
        } else if (nome === "getFontsByPostScriptName") {
          res = fonts[nome]("Helvetica");
        } else {
          res = fonts[nome]("Helvetica");
        }

        var descricao = res === null || res === undefined
          ? "null/undefined"
          : (res instanceof Array ? "Array(" + res.length + ")" : typeof res);

        var primeiro = "";
        if (res instanceof Array && res.length > 0) {
          try { primeiro = " → postScriptName: " + res[0].postScriptName; } catch (e) {}
        }

        push("  " + nome + '("Helvetica"…) → ' + descricao + primeiro);
      } catch (e) {
        push("  " + nome + " lançou: " + e.toString());
      }
    }
  }

  // ---- escrita ----------------------------------------------------------

  var texto = out.join("\n");
  var destino = "(não consegui escrever o arquivo)";

  try {
    var file = new File(Folder.desktop.fsName + "/vectorize-ae-fonts.txt");
    file.encoding = "UTF-8";
    if (file.open("w")) {
      file.write(texto);
      file.close();
      destino = file.fsName;
    }
  } catch (e) {
    destino = "erro ao escrever: " + e.toString();
  }

  alert(
    "Sonda de fontes concluída.\n\n" +
      total + " fontes visíveis ao script.\n\n" +
      "O relatório tem a lista completa de propriedades e métodos.\n\n" +
      destino
  );
})();
