/**
 * Ponto de entrada do adapter ExtendScript.
 *
 * O painel chama `vecBuildSceneFromFile(caminho)`. A função lê o SceneSpec
 * normalizado, constrói a comp e devolve uma string JSON com o resultado.
 *
 * O contrato de retorno é sempre uma string JSON, nunca uma exceção que atravessa a
 * ponte: `evalScript` transforma erro de ExtendScript em "EvalScript error." sem
 * mais nada, o que é inútil pra quem está usando. Aqui todo erro vira
 * `{ ok: false, error: "..." }` com mensagem legível.
 */

//@include "util.jsx"
//@include "ae-shape.jsx"
//@include "ae-font.jsx"
//@include "ae-text.jsx"

/*global app, Folder, vec, CompItem*/

/**
 * @param {String} specPath  caminho do JSON escrito pelo painel
 * @returns {String}         JSON: { ok, compName?, layerCount?, warnings[], error? }
 */
function vecBuildSceneFromFile(specPath) {
  try {
    var raw = vec.readFile(specPath);
    if (raw === null) {
      return vec.json({ ok: false, error: "Não consegui ler o arquivo da cena em: " + specPath });
    }

    var payload;
    try {
      // JSON é um subconjunto de literal de objeto JS; os parênteses forçam o
      // parser a ler "{...}" como expressão e não como bloco.
      payload = eval("(" + raw + ")");
    } catch (e) {
      return vec.json({ ok: false, error: "O arquivo da cena não é JSON válido: " + e.toString() });
    }

    return vec.json(vecBuildScene(payload.scene, payload.options || {}));
  } catch (e) {
    return vec.json({ ok: false, error: vecDescribeError(e) });
  }
}

/**
 * Constrói a cena. Separada do wrapper de arquivo para poder ser chamada direto
 * pelo ScriptUI ou por um teste manual dentro do AE.
 *
 * @param {Object} scene    SceneSpec normalizado (saída de normalizeScene)
 * @param {Object} options  { compName, gamma, recenterAnchors, reuseComp }
 */
function vecBuildScene(scene, options) {
  var warnings = [];

  if (!scene || !scene.canvas || !scene.layers) {
    return { ok: false, error: "SceneSpec sem canvas ou layers." };
  }
  if (scene.layers.length === 0) {
    return { ok: false, error: "A cena não tem nenhuma camada para construir." };
  }

  var compName = vec.safeName(options.compName, "Vectorized Scene");

  // Um único grupo de undo para a cena inteira: o usuário desfaz com um Ctrl+Z, e
  // não com um por camada.
  var silenciado = vec.suppressDialogs();
  app.beginUndoGroup("Vectorize AE - " + compName);

  try {
    var comp = vecResolveComp(scene.canvas, compName, options);

    if (scene.canvas.background) {
      vecAddBackground(comp, scene.canvas.background, options);
    }

    var buildOpts = {
      gamma: options.gamma || 1,
      recenterAnchors: options.recenterAnchors !== false,
    };

    // O SceneSpec vem em ordem de trás para frente. No AE, `add*` empilha cada nova
    // camada no índice 1 (topo), então construir nessa ordem já produz o
    // empilhamento correto sem precisar reordenar depois.
    for (var i = 0; i < scene.layers.length; i++) {
      var spec = scene.layers[i];
      try {
        if (spec.type === "image") {
          var img = vec.addImageLayer(comp, spec, buildOpts);
          if (img.warning) warnings.push(img.warning);
        } else if (spec.type === "text") {
          var result = vec.addTextLayer(comp, spec, buildOpts);
          if (result.fontWarning) warnings.push(result.fontWarning);
        } else {
          vec.addShapeLayer(comp, spec, buildOpts);
        }
      } catch (e) {
        // Uma camada problemática não deve levar a cena inteira junto — o designer
        // prefere 19 camadas certas e um aviso a zero camadas e um erro.
        warnings.push(
          'Camada "' + (spec.name || "(sem nome)") + '" não pôde ser criada: ' + vecDescribeError(e)
        );
      }
    }

    comp.openInViewer();

    return {
      ok: true,
      compName: comp.name,
      // Quem decide salvar é o usuário. O que a ferramenta deve fazer é não deixar
      // isso passar em branco quando ele estiver produzindo em série: vinte telas numa
      // noite, o AE fechando, e nada em disco é o pior desfecho possível.
      projectFile: app.project && app.project.file ? app.project.file.fsName : null,
      suggestedSavePath: app.project && app.project.file
        ? null
        : Folder.desktop.fsName + "/" + vec.safeName(compName, "cena") + ".aep",
      layerCount: comp.numLayers,
      warnings: warnings,
    };
  } catch (e) {
    return { ok: false, error: vecDescribeError(e), warnings: warnings };
  } finally {
    vec.restoreDialogs(silenciado);
    app.endUndoGroup();
  }
}

/**
 * Devolve a comp de destino: a ativa (se `reuseComp` e as dimensões baterem) ou uma
 * nova. Reaproveitar importa quando o designer já montou o projeto e só quer as
 * camadas dentro da comp em que está trabalhando.
 */
function vecResolveComp(canvas, compName, options) {
  if (options.reuseComp) {
    var active = app.project.activeItem;
    if (active instanceof CompItem) {
      if (active.width !== canvas.width || active.height !== canvas.height) {
        throw new Error(
          "A comp ativa é " + active.width + "×" + active.height + " e a cena é " +
            canvas.width + "×" + canvas.height + ". Desligue 'usar comp ativa' ou " +
            "ajuste as dimensões da comp."
        );
      }
      return active;
    }
    throw new Error("Nenhuma composição ativa. Selecione uma comp ou desligue 'usar comp ativa'.");
  }

  return app.project.items.addComp(
    compName,
    Math.round(canvas.width),
    Math.round(canvas.height),
    1, // pixel aspect ratio
    canvas.duration,
    canvas.frameRate
  );
}

/**
 * Fundo sólido como shape layer, não como Solid.
 *
 * Um Solid vira um item no painel de projeto e não guarda a cor de forma editável;
 * uma shape layer com um retângulo do tamanho da comp fica com a cor num parâmetro
 * animável, que é o que serve pra motion.
 */
function vecAddBackground(comp, hex, options) {
  var spec = {
    name: "BG",
    contents: [
      {
        type: "group",
        name: "Fundo",
        items: [
          {
            kind: "geometry",
            shape: {
              type: "rect",
              cx: comp.width / 2,
              cy: comp.height / 2,
              w: comp.width,
              h: comp.height,
              roundness: 0,
              rotation: 0,
            },
          },
          { kind: "fill", color: hex, opacity: 100 },
        ],
      },
    ],
  };

  // O fundo não recentra âncora: ele cobre a comp inteira e mover a âncora dele não
  // ajuda ninguém.
  return vec.addShapeLayer(comp, spec, { gamma: options.gamma || 1, recenterAnchors: false });
}

/** Erros do ExtendScript trazem contexto útil em `line`; erros de JS, não. */
function vecDescribeError(e) {
  if (e && e.line !== undefined && e.fileName) {
    return e.toString() + " (" + e.fileName + ":" + e.line + ")";
  }
  return e && e.toString ? e.toString() : String(e);
}
