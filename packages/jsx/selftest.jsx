/**
 * Autoteste do adapter — roda direto no After Effects.
 *
 *   File → Scripts → Run Script File… → selecione este arquivo
 *
 * Não precisa instalar o painel, não precisa de chave de API, não precisa de build.
 * É um arquivo só, sem includes, de propósito: quanto menos peças, menos coisa pode
 * dar errado antes do teste começar.
 *
 * O que ele faz: cria uma comp descartável, tenta escrever em cada matchname e cada
 * comportamento que o construtor assume, e reporta o que passou e o que falhou. Tudo
 * dentro de um único grupo de undo — um Ctrl+Z apaga o teste inteiro.
 *
 * O relatório vai para a Área de Trabalho e um resumo aparece num alerta.
 */

/*global app, Shape, CompItem, ParagraphJustification, File, Folder, alert, $*/

(function vectorizeSelfTest() {
  var results = [];
  var comp = null;

  // ---------------------------------------------------------------- helpers

  function record(section, name, ok, detail) {
    results.push({ section: section, name: name, ok: ok, detail: detail || "" });
  }

  /** Espera que a operação funcione. */
  function check(section, name, fn) {
    try {
      var detail = fn();
      record(section, name, true, detail === undefined ? "" : String(detail));
    } catch (e) {
      record(section, name, false, e.toString());
    }
  }

  /**
   * Espera que a operação FALHE. Serve para confirmar suposições sobre o que o AE
   * recusa — por exemplo, escrever raio interno num polígono regular. Se isso passar
   * a funcionar numa versão futura, o teste avisa em vez de deixar passar batido.
   */
  function checkThrows(section, name, fn) {
    try {
      fn();
      record(section, name, false, "esperava um erro, mas a operação foi aceita");
    } catch (e) {
      record(section, name, true, "recusado como esperado");
    }
  }

  function approx(a, b, tol) {
    return Math.abs(a - b) <= (tol === undefined ? 0.5 : tol);
  }

  function newShapeLayer(name) {
    var layer = comp.layers.addShape();
    layer.name = name;
    var t = layer.property("ADBE Transform Group");
    t.property("ADBE Anchor Point").setValue([0, 0]);
    t.property("ADBE Position").setValue([0, 0]);
    return layer;
  }

  function newGroup(layer, name) {
    var group = layer.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
    group.name = name;
    return group;
  }

  // ---------------------------------------------------------------- execução

  app.beginUndoGroup("Vectorize AE — autoteste");

  try {
    record("Ambiente", "Versão do After Effects", true, app.version);
    record("Ambiente", "Build", true, app.buildName || "(não informado)");

    comp = app.project.items.addComp("VectorizeAE — Autoteste", 1000, 1000, 1, 10, 30);

    // ---- estrutura básica -------------------------------------------------

    var layer = newShapeLayer("Teste / Estrutura");

    check("Estrutura", 'Contents = "ADBE Root Vectors Group"', function () {
      return layer.property("ADBE Root Vectors Group").name;
    });

    var group = newGroup(layer, "Grupo");

    check("Estrutura", 'Grupo = "ADBE Vector Group"', function () {
      return group.matchName;
    });

    check("Estrutura", 'Conteúdo do grupo = "ADBE Vectors Group" (com S)', function () {
      return group.property("ADBE Vectors Group").matchName;
    });

    var inner = group.property("ADBE Vectors Group");

    // ---- retângulo --------------------------------------------------------

    check("Retângulo", "addProperty ADBE Vector Shape - Rect", function () {
      var rect = inner.addProperty("ADBE Vector Shape - Rect");
      rect.property("ADBE Vector Rect Size").setValue([200, 100]);
      rect.property("ADBE Vector Rect Position").setValue([300, 250]);
      rect.property("ADBE Vector Rect Roundness").setValue(16);
      return "Size, Position e Roundness aceitos";
    });

    // ---- elipse -----------------------------------------------------------

    check("Elipse", "addProperty ADBE Vector Shape - Ellipse", function () {
      var l = newShapeLayer("Teste / Elipse");
      var g = newGroup(l, "Elipse").property("ADBE Vectors Group");
      var e = g.addProperty("ADBE Vector Shape - Ellipse");
      e.property("ADBE Vector Ellipse Size").setValue([120, 80]);
      e.property("ADBE Vector Ellipse Position").setValue([500, 500]);
      return "Size e Position aceitos";
    });

    // ---- estrela e polígono ----------------------------------------------

    var starLayer = newShapeLayer("Teste / Estrela");
    var starInner = newGroup(starLayer, "Estrela").property("ADBE Vectors Group");
    var star = null;

    check("Estrela", "addProperty ADBE Vector Shape - Star", function () {
      star = starInner.addProperty("ADBE Vector Shape - Star");
      return star.matchName;
    });

    check("Estrela", "Type / Points / Position / Outer Radius", function () {
      star.property("ADBE Vector Star Type").setValue(1); // 1 = estrela
      star.property("ADBE Vector Star Points").setValue(5);
      star.property("ADBE Vector Star Position").setValue([700, 300]);
      star.property("ADBE Vector Star Outer Radius").setValue(100);
      return "aceitos";
    });

    check("Estrela", "Inner Radius com Type = estrela", function () {
      star.property("ADBE Vector Star Inner Radius").setValue(45);
      return "aceito";
    });

    check("Estrela", "Rotation", function () {
      star.property("ADBE Vector Star Rotation").setValue(15);
      return "aceito";
    });

    // Estes dois matchnames têm erro de digitação preservado pela Adobe.
    // Testamos as duas grafias para saber qual vale de fato.
    check("Estrela", 'Outer Roundness — grafia "Roundess" (com erro)', function () {
      star.property("ADBE Vector Star Outer Roundess").setValue(10);
      return "a grafia COM erro é a correta";
    });

    check("Estrela", 'Outer Roundness — grafia "Roundness" (correta)', function () {
      star.property("ADBE Vector Star Outer Roundness").setValue(10);
      return "a grafia SEM erro é a correta";
    });

    checkThrows("Estrela", "Inner Radius num polígono regular deve ser recusado", function () {
      var l = newShapeLayer("Teste / Polígono");
      var g = newGroup(l, "Polígono").property("ADBE Vectors Group");
      var p = g.addProperty("ADBE Vector Shape - Star");
      p.property("ADBE Vector Star Type").setValue(2); // 2 = polígono
      p.property("ADBE Vector Star Points").setValue(6);
      p.property("ADBE Vector Star Outer Radius").setValue(80);
      p.property("ADBE Vector Star Inner Radius").setValue(40);
    });

    // ---- path bezier ------------------------------------------------------

    check("Path", "Shape com vértices e tangentes", function () {
      var l = newShapeLayer("Teste / Path");
      var g = newGroup(l, "Path").property("ADBE Vectors Group");
      var pathProp = g.addProperty("ADBE Vector Shape - Group");

      var s = new Shape();
      s.vertices = [[100, 700], [200, 700], [200, 800]];
      s.inTangents = [[0, 0], [-30, 0], [0, 0]];
      s.outTangents = [[30, 0], [0, 0], [0, 0]];
      s.closed = true;

      pathProp.property("ADBE Vector Shape").setValue(s);

      var back = pathProp.property("ADBE Vector Shape").value;
      return "vértices gravados: " + back.vertices.length + ", closed: " + back.closed;
    });

    check("Path", "Dois subpaths no mesmo grupo (ícone com furo)", function () {
      var l = newShapeLayer("Teste / Furo");
      var g = newGroup(l, "Furo").property("ADBE Vectors Group");

      var fora = g.addProperty("ADBE Vector Shape - Group");
      var s1 = new Shape();
      s1.vertices = [[0, 0], [100, 0], [100, 100], [0, 100]];
      s1.inTangents = [[0, 0], [0, 0], [0, 0], [0, 0]];
      s1.outTangents = [[0, 0], [0, 0], [0, 0], [0, 0]];
      s1.closed = true;
      fora.property("ADBE Vector Shape").setValue(s1);

      var dentro = g.addProperty("ADBE Vector Shape - Group");
      var s2 = new Shape();
      s2.vertices = [[25, 25], [75, 25], [75, 75], [25, 75]];
      s2.inTangents = [[0, 0], [0, 0], [0, 0], [0, 0]];
      s2.outTangents = [[0, 0], [0, 0], [0, 0], [0, 0]];
      s2.closed = true;
      dentro.property("ADBE Vector Shape").setValue(s2);

      return "dois paths aceitos no mesmo grupo";
    });

    // ---- fill e stroke ----------------------------------------------------

    var paintLayer = newShapeLayer("Teste / Pintura");
    var paintInner = newGroup(paintLayer, "Pintura").property("ADBE Vectors Group");

    check("Pintura", "Geometria antes da pintura", function () {
      var r = paintInner.addProperty("ADBE Vector Shape - Rect");
      r.property("ADBE Vector Rect Size").setValue([150, 150]);
      r.property("ADBE Vector Rect Position").setValue([500, 850]);
      return "ok";
    });

    check("Pintura", "Stroke: Color / Opacity / Width / Line Cap / Line Join", function () {
      var s = paintInner.addProperty("ADBE Vector Graphic - Stroke");
      s.property("ADBE Vector Stroke Color").setValue([1, 0.3, 0.18, 1]);
      s.property("ADBE Vector Stroke Opacity").setValue(100);
      s.property("ADBE Vector Stroke Width").setValue(8);
      s.property("ADBE Vector Stroke Line Cap").setValue(2);
      s.property("ADBE Vector Stroke Line Join").setValue(2);
      return "todos aceitos";
    });

    check("Pintura", "Fill: Color / Opacity", function () {
      var f = paintInner.addProperty("ADBE Vector Graphic - Fill");
      f.property("ADBE Vector Fill Color").setValue([0.1, 0.1, 0.13, 1]);
      f.property("ADBE Vector Fill Opacity").setValue(100);
      return "aceitos";
    });

    check("Pintura", "Cor aceita array de 3 componentes (sem alpha)", function () {
      var f = paintInner.property("ADBE Vector Graphic - Fill");
      f.property("ADBE Vector Fill Color").setValue([0.2, 0.4, 0.6]);
      return "aceito — alpha é opcional";
    });

    // ---- transform do grupo ----------------------------------------------

    check("Transform de grupo", "Anchor / Position / Rotation", function () {
      var t = group.property("ADBE Vector Transform Group");
      t.property("ADBE Vector Anchor").setValue([300, 250]);
      t.property("ADBE Vector Position").setValue([300, 250]);
      t.property("ADBE Vector Rotation").setValue(12);
      return "aceitos";
    });

    // ---- suposição de coordenadas (a mais importante) ---------------------

    check("Coordenadas", "Âncora e posição em (0,0) fazem espaço de layer = espaço de comp", function () {
      var l = newShapeLayer("Teste / Coordenadas");
      var g = newGroup(l, "Alvo").property("ADBE Vectors Group");

      // Retângulo de 200×100 centrado em (400, 300) → canto em (300, 250).
      var r = g.addProperty("ADBE Vector Shape - Rect");
      r.property("ADBE Vector Rect Size").setValue([200, 100]);
      r.property("ADBE Vector Rect Position").setValue([400, 300]);

      var f = g.addProperty("ADBE Vector Graphic - Fill");
      f.property("ADBE Vector Fill Color").setValue([1, 1, 1, 1]);

      var rect = l.sourceRectAtTime(0, false);
      var esperado = "left=300 top=250 w=200 h=100";
      var obtido = "left=" + rect.left + " top=" + rect.top + " w=" + rect.width + " h=" + rect.height;

      if (approx(rect.left, 300) && approx(rect.top, 250) &&
          approx(rect.width, 200) && approx(rect.height, 100)) {
        return "confirmado — " + obtido;
      }
      throw new Error("SUPOSIÇÃO ERRADA. Esperava " + esperado + ", obtive " + obtido);
    });

    check("Coordenadas", "recenterAnchor mantém o visual no lugar", function () {
      var l = newShapeLayer("Teste / Recentrar");
      var g = newGroup(l, "Alvo").property("ADBE Vectors Group");
      var r = g.addProperty("ADBE Vector Shape - Rect");
      r.property("ADBE Vector Rect Size").setValue([100, 100]);
      r.property("ADBE Vector Rect Position").setValue([600, 600]);
      g.addProperty("ADBE Vector Graphic - Fill")
        .property("ADBE Vector Fill Color").setValue([1, 1, 1, 1]);

      var antes = l.sourceRectAtTime(0, false);
      var centro = [antes.left + antes.width / 2, antes.top + antes.height / 2];

      l.property("ADBE Transform Group").property("ADBE Anchor Point").setValue(centro);
      l.property("ADBE Transform Group").property("ADBE Position").setValue(centro);

      var depois = l.sourceRectAtTime(0, false);

      // sourceRect é espaço de layer, então não muda ao recentrar — o que precisa
      // ser verificado é que âncora e posição ficaram iguais, que é o que preserva
      // o visual.
      var anchor = l.property("ADBE Transform Group").property("ADBE Anchor Point").value;
      var pos = l.property("ADBE Transform Group").property("ADBE Position").value;

      if (approx(anchor[0], pos[0]) && approx(anchor[1], pos[1])) {
        return "âncora = posição = [" + Math.round(pos[0]) + ", " + Math.round(pos[1]) + "]";
      }
      throw new Error("âncora e posição divergiram: " + anchor + " vs " + pos);
    });

    // ---- texto ------------------------------------------------------------

    var textLayer = null;

    check("Texto", "addText e acesso ao Text Document", function () {
      textLayer = comp.layers.addText("LANÇAMENTO");
      textLayer.name = "Teste / Texto";
      return textLayer.property("ADBE Text Properties").property("ADBE Text Document").matchName;
    });

    check("Texto", "fontSize / fillColor / justification / tracking", function () {
      var tp = textLayer.property("ADBE Text Properties").property("ADBE Text Document");
      var doc = tp.value;
      doc.fontSize = 72;
      doc.applyFill = true;
      doc.fillColor = [1, 1, 1];
      doc.applyStroke = false;
      doc.justification = ParagraphJustification.LEFT_JUSTIFY;
      doc.tracking = 40;
      tp.setValue(doc);
      return "aceitos";
    });

    check("Texto", "fontFamily / fontStyle (AE 2020+)", function () {
      var tp = textLayer.property("ADBE Text Properties").property("ADBE Text Document");
      var doc = tp.value;
      doc.fontFamily = "Helvetica";
      doc.fontStyle = "Bold";
      tp.setValue(doc);
      return "aplicado — fonte resultante: " + tp.value.fontFamily + " / " + tp.value.fontStyle;
    });

    check("Texto", "Detecção de substituição de fonte", function () {
      var tp = textLayer.property("ADBE Text Properties").property("ADBE Text Document");
      var doc = tp.value;
      doc.fontFamily = "Fonte Que Nao Existe 12345";
      tp.setValue(doc);
      var aplicada = tp.value.fontFamily;
      return 'pedi uma fonte inexistente, o AE aplicou "' + aplicada +
        '" — a detecção ' + (aplicada !== "Fonte Que Nao Existe 12345" ? "FUNCIONA" : "NÃO funciona");
    });

    check("Texto", "app.fonts disponível (para listar fontes instaladas)", function () {
      if (app.fonts && app.fonts.allFonts) {
        return app.fonts.allFonts.length + " fontes visíveis ao script";
      }
      throw new Error("app.fonts não existe nesta versão");
    });

    // ---- gradiente (esperado ser parcial) ---------------------------------

    var gradFill = null;

    check("Gradiente", "addProperty ADBE Vector Graphic - G-Fill", function () {
      var l = newShapeLayer("Teste / Gradiente");
      var g = newGroup(l, "Gradiente").property("ADBE Vectors Group");
      var r = g.addProperty("ADBE Vector Shape - Rect");
      r.property("ADBE Vector Rect Size").setValue([200, 200]);
      r.property("ADBE Vector Rect Position").setValue([800, 800]);
      gradFill = g.addProperty("ADBE Vector Graphic - G-Fill");
      return gradFill.matchName;
    });

    check("Gradiente", "Type / Start Pt / End Pt", function () {
      gradFill.property("ADBE Vector Grad Type").setValue(1);
      gradFill.property("ADBE Vector Grad Start Pt").setValue([700, 700]);
      gradFill.property("ADBE Vector Grad End Pt").setValue([900, 900]);
      return "aceitos";
    });

    check("Gradiente", "Ler a estrutura de ADBE Vector Grad Colors", function () {
      var colors = gradFill.property("ADBE Vector Grad Colors");
      var v = colors.value;
      return "tipo de valor: " + typeof v + ", é array: " + (v instanceof Array) +
        (v instanceof Array ? ", comprimento: " + v.length : "") +
        " | valueType: " + colors.propertyValueType;
    });

    // ---- leitura da comp (a camada de ferramentas que vem a seguir) -------

    check("Leitura", "Percorrer camadas e ler propriedades", function () {
      var n = 0;
      for (var i = 1; i <= comp.numLayers; i++) {
        var l = comp.layer(i);
        var p = l.property("ADBE Transform Group").property("ADBE Position").value;
        if (p) n++;
      }
      return n + " de " + comp.numLayers + " camadas lidas";
    });

    check("Leitura", "Descer recursivamente em Contents de uma shape layer", function () {
      var contents = paintLayer.property("ADBE Root Vectors Group");
      var found = [];
      for (var i = 1; i <= contents.numProperties; i++) {
        var g = contents.property(i);
        var gi = g.property("ADBE Vectors Group");
        for (var j = 1; j <= gi.numProperties; j++) {
          found.push(gi.property(j).matchName);
        }
      }
      return found.join(", ");
    });

    check("Leitura", "selectedLayers e selectedProperties", function () {
      return "selectedLayers: " + comp.selectedLayers.length +
        ", selectedProperties: " + comp.selectedProperties.length;
    });
  } catch (fatal) {
    record("FATAL", "O teste abortou", false, fatal.toString() +
      (fatal.line ? " (linha " + fatal.line + ")" : ""));
  } finally {
    app.endUndoGroup();
  }

  // ---------------------------------------------------------------- relatório

  var passou = 0;
  var falhou = 0;
  var linhas = [];
  var falhas = [];
  var secaoAtual = "";

  linhas.push("Autoteste do Vectorize AE");
  linhas.push("=========================");
  linhas.push("");

  for (var i = 0; i < results.length; i++) {
    var r = results[i];

    if (r.section !== secaoAtual) {
      secaoAtual = r.section;
      linhas.push("");
      linhas.push("── " + secaoAtual + " ──");
    }

    linhas.push((r.ok ? "  OK    " : "  FALHA ") + r.name + (r.detail ? "  ·  " + r.detail : ""));

    if (r.ok) {
      passou++;
    } else {
      falhou++;
      falhas.push(r.section + " › " + r.name + "\n    " + r.detail);
    }
  }

  linhas.push("");
  linhas.push("Total: " + passou + " ok, " + falhou + " falha(s), de " + results.length + " verificações.");
  linhas.push("");
  linhas.push("A comp de teste foi criada no projeto. Um Ctrl+Z (Cmd+Z) desfaz tudo.");

  var texto = linhas.join("\n");
  var destino = "(não consegui escrever o arquivo)";

  try {
    var f = new File(Folder.desktop.fsName + "/vectorize-ae-selftest.txt");
    f.encoding = "UTF-8";
    if (f.open("w")) {
      f.write(texto);
      f.close();
      destino = f.fsName;
    }
  } catch (e) {
    destino = "erro ao escrever: " + e.toString();
  }

  var resumo = "Autoteste do Vectorize AE\n\n" +
    passou + " ok · " + falhou + " falha(s)\n\n";

  if (falhou > 0) {
    // Só as primeiras falhas, para o alerta não virar um paredão ilegível.
    resumo += "Falhas:\n\n" + falhas.slice(0, 8).join("\n\n");
    if (falhas.length > 8) resumo += "\n\n… e mais " + (falhas.length - 8) + ". Veja o arquivo.";
    resumo += "\n\n";
  } else {
    resumo += "Todas as suposições do adapter foram confirmadas.\n\n";
  }

  resumo += "Relatório completo:\n" + destino;

  alert(resumo);
})();
