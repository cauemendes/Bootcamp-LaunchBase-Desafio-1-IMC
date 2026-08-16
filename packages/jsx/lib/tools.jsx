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
 * `saveFrameToPng` é o caminho nativo do After Effects: nada de fila de render,
 * nada de plugin externo, nada de snapshot manual.
 */
vec.tools.save_frame = function (args) {
  args = args || {};
  var comp = vec.findComp(args.compName);

  if (typeof comp.saveFrameToPng !== "function") {
    throw new Error(
      "Esta versão do After Effects não expõe saveFrameToPng. " +
        "Sem ela, a captura de frame teria que passar pela fila de render."
    );
  }

  var time = typeof args.time === "number" ? args.time : comp.time;

  if (time < 0 || time > comp.duration) {
    throw new Error(
      "time " + time + "s está fora da duração da comp (0 a " + round3(comp.duration) + "s)."
    );
  }

  var destino = args.path
    ? new File(args.path)
    : new File(Folder.temp.fsName + "/vectorize-ae-frame-" + new Date().getTime() + ".png");

  comp.saveFrameToPng(time, destino);

  if (!destino.exists) {
    throw new Error("O After Effects não gravou o arquivo em " + destino.fsName + ".");
  }

  return {
    path: destino.fsName,
    time: round3(time),
    comp: comp.name,
    width: comp.width,
    height: comp.height,
  };
};

// ---------------------------------------------------------------- construção

vec.tools.build_scene = function (args) {
  args = args || {};
  if (!args.scene) throw new Error("build_scene precisa de um SceneSpec normalizado em `scene`.");
  return vecBuildScene(args.scene, args.options || {});
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

  var rotulo = args.label || "Vectorize AE — script";
  app.beginUndoGroup(rotulo);

  try {
    var resultado = eval(args.code);

    // O retorno vai virar JSON. Objetos do DOM do AE (camadas, comps, propriedades)
    // não serializam — descrever em vez de tentar.
    return { value: vec.serializable(resultado) };
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
