/**
 * Ferramentas de leitura: descrever projeto, composição e camada.
 *
 * ── Por que leitura vem primeiro ──────────────────────────────────────────────
 * Sem enxergar o projeto, o modelo só sabe criar do zero. Ajudar no que já existe
 * — renomear, reorganizar, animar o que está lá, achar o que está errado — é onde
 * mora o tempo do dia a dia de um motion designer, e tudo isso começa em ler.
 *
 * ── Economia de contexto é requisito, não detalhe ─────────────────────────────
 * O resultado destas funções vira texto na conversa com o modelo. Uma comp de 60
 * camadas descrita com tudo que o AE oferece são dezenas de milhares de tokens, e
 * o modelo se perde no ruído antes de acabar o orçamento.
 *
 * Por isso a leitura é em dois níveis: `describeComp` devolve um resumo por camada,
 * e `describeLayer` devolve o detalhe de uma só. O modelo lista, escolhe, e aprofunda
 * onde precisa — em vez de receber tudo e filtrar depois.
 */

/*global app, CompItem, FolderItem, FootageItem, ShapeLayer, TextLayer, CameraLayer, LightLayer, AVLayer, PropertyType*/

var vec = vec || {};

/** Panorama do projeto: o que existe e onde. */
vec.describeProject = function () {
  var proj = app.project;

  if (!proj) return { open: false };

  var comps = [];
  var footage = [];
  var folders = [];

  // ── Pasta e seleção precisam aparecer ────────────────────────────────────────
  // "Renomeie as comps que estão nesta pasta" e "as que eu selecionei" são pedidos
  // normais, e sem estes dois campos quem for atender tem de descobrir a estrutura
  // escrevendo script no chute — arriscando renomear a comp errada num projeto com nomes
  // parecidos. A informação existe no DOM e custa uma linha cada.
  var selecionados = {};
  try {
    var sel = proj.selection;
    for (var s = 0; s < sel.length; s++) selecionados["id" + sel[s].id] = true;
  } catch (eSel) {
    // Projeto sem seleção, ou API indisponível: `selected` sai false em tudo.
  }

  function nomeDaPasta(item) {
    try {
      // A raiz do projeto também é um FolderItem, e chamá-la de pasta confundiria quem
      // for filtrar por pasta. null significa "está na raiz".
      if (!item.parentFolder || item.parentFolder === proj.rootFolder) return null;
      return item.parentFolder.name;
    } catch (e) {
      return null;
    }
  }

  for (var i = 1; i <= proj.numItems; i++) {
    var item = proj.item(i);
    var estaSelecionado = selecionados["id" + item.id] === true;

    if (item instanceof CompItem) {
      comps.push({
        name: item.name,
        id: item.id,
        width: item.width,
        height: item.height,
        frameRate: item.frameRate,
        duration: round(item.duration, 3),
        layers: item.numLayers,
        folder: nomeDaPasta(item),
        selected: estaSelecionado,
      });
    } else if (item instanceof FolderItem) {
      folders.push({
        name: item.name,
        id: item.id,
        items: item.numItems,
        folder: nomeDaPasta(item),
        selected: estaSelecionado,
      });
    } else {
      // O caminho em disco é o que torna a imagem utilizável: medir e enxergar
      // acontecem fora do After Effects, lendo o arquivo. Sem isto, uma referência
      // importada no projeto é invisível para quem for reconstruí-la — sobrava
      // pedir o caminho ao usuário ou vasculhar o disco no chute.
      var entrada = {
        name: item.name,
        id: item.id,
        width: item.width,
        height: item.height,
        // A duração é o que permite montar uma comp master casada com a locução sem
        // ninguém precisar medir o arquivo por fora. Sem ela, `fitToAudio` exigia um
        // número que só existia na cabeça de quem tinha aberto o áudio em outro lugar.
        duration: round(item.duration, 3),
        folder: nomeDaPasta(item),
        selected: estaSelecionado,
        file: null,
      };

      try {
        if (item.mainSource && item.mainSource.file) {
          entrada.file = item.mainSource.file.fsName;
        }
      } catch (e) {
        // Sólido, nulo e placeholder não têm arquivo — `file: null` já diz isso.
      }

      footage.push(entrada);
    }
  }

  var active = app.project.activeItem;

  return {
    open: true,
    file: proj.file ? proj.file.name : null,
    saved: !!proj.file,
    comps: comps,
    footageCount: footage.length,
    footage: footage,
    folderCount: folders.length,
    folders: folders,
    // Quantos itens estão selecionados no painel de projeto. Zero com um pedido do tipo
    // "as que eu selecionei" quer dizer que a seleção se perdeu — vale avisar em vez de
    // agir sobre o projeto inteiro.
    selectedCount: (function () {
      var n = 0;
      for (var k in selecionados) if (selecionados.hasOwnProperty(k)) n++;
      return n;
    })(),
    activeComp: active instanceof CompItem ? active.name : null,
    // Sem projeto salvo, qualquer caminho relativo que o modelo sugerir é chute.
    projectFolder: proj.file ? proj.file.parent.fsName : null,
  };
};

/**
 * Descreve uma composição e resume suas camadas.
 *
 * @param {Object} args  { compName: String|null, selectedOnly: Boolean }
 *                       compName ausente = comp ativa
 */
vec.describeComp = function (args) {
  args = args || {};
  var comp = vec.findComp(args.compName);

  var camadas = [];
  var alvo = args.selectedOnly ? comp.selectedLayers : null;

  for (var i = 1; i <= comp.numLayers; i++) {
    var layer = comp.layer(i);
    if (alvo && !vec.inArray(alvo, layer)) continue;
    camadas.push(vec.summarizeLayer(layer));
  }

  return {
    name: comp.name,
    id: comp.id,
    width: comp.width,
    height: comp.height,
    frameRate: comp.frameRate,
    duration: round(comp.duration, 3),
    currentTime: round(comp.time, 3),
    workArea: { start: round(comp.workAreaStart, 3), duration: round(comp.workAreaDuration, 3) },
    bgColor: vec.colorToHex(comp.bgColor),
    numLayers: comp.numLayers,
    selectedLayers: vec.mapNames(comp.selectedLayers),
    layers: camadas,
  };
};

/** Uma linha por camada: o suficiente pro modelo decidir onde aprofundar. */
vec.summarizeLayer = function (layer) {
  var t = layer.property("ADBE Transform Group");

  var resumo = {
    index: layer.index,
    name: layer.name,
    type: vec.layerKind(layer),
    enabled: layer.enabled,
    selected: layer.selected,
    locked: layer.locked,
    shy: layer.shy,
    inPoint: round(layer.inPoint, 3),
    outPoint: round(layer.outPoint, 3),
    parent: layer.parent ? layer.parent.name : null,
    position: vec.readValue(t.property("ADBE Position")),
    scale: vec.readValue(t.property("ADBE Scale")),
    opacity: vec.readValue(t.property("ADBE Opacity")),
    animated: vec.countKeyframes(layer) > 0,
  };

  if (layer instanceof TextLayer) {
    try {
      resumo.text = layer.property("ADBE Text Properties").property("ADBE Text Document").value.text;
    } catch (e) {
      resumo.text = null;
    }
  }

  if (layer instanceof AVLayer && layer.source && !(layer instanceof ShapeLayer)) {
    resumo.source = layer.source.name;

    // O caminho em disco acompanha o nome porque é ele que serve para alguma coisa:
    // medir a imagem e enxergá-la acontece fora do After Effects, lendo o arquivo.
    // Dizer "a camada chama 11-1.png" sem dizer onde ela está deixa quem for
    // reconstruir procurando no disco.
    try {
      if (layer.source.mainSource && layer.source.mainSource.file) {
        resumo.sourceFile = layer.source.mainSource.file.fsName;
      }
    } catch (e) {
      // Sólido e comp aninhada não têm arquivo.
    }
  }

  var efeitos = layer.property("ADBE Effect Parade");
  if (efeitos && efeitos.numProperties > 0) {
    resumo.effects = [];
    for (var e = 1; e <= efeitos.numProperties; e++) {
      resumo.effects.push(efeitos.property(e).name);
    }
  }

  return resumo;
};

/**
 * Detalhe completo de uma camada: transform com keyframes, efeitos com valores, e
 * a árvore de Contents se for shape layer.
 *
 * @param {Object} args  { compName, layerName } ou { compName, layerIndex }
 */
vec.describeLayer = function (args) {
  args = args || {};
  var comp = vec.findComp(args.compName);
  var layer = vec.findLayer(comp, args);

  var detalhe = vec.summarizeLayer(layer);
  detalhe.blendMode = vec.blendModeName(layer.blendingMode);
  detalhe.transform = vec.describeTransform(layer);
  detalhe.effects = vec.describeEffects(layer);

  if (layer instanceof ShapeLayer) {
    detalhe.contents = vec.describeContents(layer.property("ADBE Root Vectors Group"));
  }

  if (layer instanceof TextLayer) {
    detalhe.textDocument = vec.describeText(layer);
  }

  return detalhe;
};

vec.describeTransform = function (layer) {
  var t = layer.property("ADBE Transform Group");
  var props = ["ADBE Anchor Point", "ADBE Position", "ADBE Scale", "ADBE Rotate Z", "ADBE Opacity"];
  var rotulos = ["anchorPoint", "position", "scale", "rotation", "opacity"];
  var saida = {};

  for (var i = 0; i < props.length; i++) {
    var p = layer.property("ADBE Transform Group").property(props[i]);
    if (!p) continue;
    saida[rotulos[i]] = vec.describeProperty(p);
  }

  return saida;
};

/**
 * Uma propriedade: valor, expressão e keyframes.
 *
 * Keyframes vêm com tempo e valor. Um easing completo (influence e speed por
 * dimensão) multiplicaria o tamanho da resposta por quatro; quando o modelo
 * precisar disso, é caso de uma ferramenta específica.
 */
vec.describeProperty = function (prop) {
  var info = { value: vec.readValue(prop) };

  if (prop.expressionEnabled && prop.expression) {
    info.expression = prop.expression;
  }

  if (prop.numKeys > 0) {
    info.keyframes = [];
    for (var k = 1; k <= prop.numKeys; k++) {
      info.keyframes.push({ time: round(prop.keyTime(k), 3), value: vec.roundValue(prop.keyValue(k)) });
    }
  }

  return info;
};

vec.describeEffects = function (layer) {
  var parade = layer.property("ADBE Effect Parade");
  if (!parade || parade.numProperties === 0) return [];

  var lista = [];

  for (var i = 1; i <= parade.numProperties; i++) {
    var efeito = parade.property(i);
    var params = {};

    for (var j = 1; j <= efeito.numProperties; j++) {
      var p = efeito.property(j);
      // Grupos e propriedades sem valor (como o "Compositing Options") não têm o
      // que reportar e só ocupariam espaço.
      if (p.propertyType !== PropertyType.PROPERTY) continue;
      try {
        params[p.name] = vec.readValue(p);
      } catch (e) {
        // Propriedade sem valor legível — segue.
      }
    }

    lista.push({
      name: efeito.name,
      matchName: efeito.matchName,
      enabled: efeito.enabled,
      params: params,
    });
  }

  return lista;
};

/** Árvore de Contents de uma shape layer, recursiva. */
vec.describeContents = function (group) {
  var itens = [];

  for (var i = 1; i <= group.numProperties; i++) {
    var prop = group.property(i);
    var item = { name: prop.name, matchName: prop.matchName };

    if (prop.matchName === "ADBE Vector Group") {
      item.type = "group";
      item.items = vec.describeContents(prop.property("ADBE Vectors Group"));
    } else if (prop.matchName === "ADBE Vector Graphic - Fill" ||
               prop.matchName === "ADBE Vector Graphic - Stroke") {
      item.type = prop.matchName.indexOf("Fill") !== -1 ? "fill" : "stroke";
      item.color = vec.readColorProperty(prop);
      var largura = prop.property("ADBE Vector Stroke Width");
      if (largura) item.width = vec.readValue(largura);
    } else if (prop.matchName === "ADBE Vector Shape - Rect") {
      item.type = "rect";
      item.size = vec.readValue(prop.property("ADBE Vector Rect Size"));
      item.position = vec.readValue(prop.property("ADBE Vector Rect Position"));
      item.roundness = vec.readValue(prop.property("ADBE Vector Rect Roundness"));
    } else if (prop.matchName === "ADBE Vector Shape - Ellipse") {
      item.type = "ellipse";
      item.size = vec.readValue(prop.property("ADBE Vector Ellipse Size"));
      item.position = vec.readValue(prop.property("ADBE Vector Ellipse Position"));
    } else if (prop.matchName === "ADBE Vector Shape - Star") {
      item.type = "star";
      item.points = vec.readValue(prop.property("ADBE Vector Star Points"));
      item.outerRadius = vec.readValue(prop.property("ADBE Vector Star Outer Radius"));
    } else if (prop.matchName === "ADBE Vector Shape - Group") {
      item.type = "path";
      try {
        item.vertexCount = prop.property("ADBE Vector Shape").value.vertices.length;
      } catch (e) {
        item.vertexCount = null;
      }
    } else {
      item.type = "other";
    }

    itens.push(item);
  }

  return itens;
};

vec.describeText = function (layer) {
  var doc = layer.property("ADBE Text Properties").property("ADBE Text Document").value;
  var out = {};

  var campos = ["text", "font", "fontSize", "tracking", "leading", "justification"];
  for (var i = 0; i < campos.length; i++) {
    try {
      out[campos[i]] = doc[campos[i]];
    } catch (e) {
      // Campo ausente nesta versão — segue.
    }
  }

  try {
    out.fillColor = vec.colorToHex(doc.fillColor);
  } catch (e) {
    out.fillColor = null;
  }

  // fontFamily é somente leitura no 26.3, mas LER funciona — e é o nome que um
  // humano reconhece, ao contrário do PostScript.
  try {
    out.fontFamily = doc.fontFamily;
  } catch (e) {
    // Ignora.
  }

  return out;
};

// ---------------------------------------------------------------- utilitários

vec.findComp = function (compName) {
  if (!compName) {
    var ativa = app.project.activeItem;
    if (ativa instanceof CompItem) return ativa;
    throw new Error(
      "Nenhuma composição ativa. Abra uma comp na timeline, ou informe compName."
    );
  }

  for (var i = 1; i <= app.project.numItems; i++) {
    var item = app.project.item(i);
    if (item instanceof CompItem && item.name === compName) return item;
  }

  throw new Error('Não encontrei nenhuma composição chamada "' + compName + '".');
};

vec.findLayer = function (comp, args) {
  if (args.layerIndex) {
    if (args.layerIndex < 1 || args.layerIndex > comp.numLayers) {
      throw new Error(
        "layerIndex " + args.layerIndex + ' fora do intervalo: a comp "' + comp.name +
          '" tem ' + comp.numLayers + " camadas."
      );
    }
    return comp.layer(args.layerIndex);
  }

  if (args.layerName) {
    for (var i = 1; i <= comp.numLayers; i++) {
      if (comp.layer(i).name === args.layerName) return comp.layer(i);
    }
    throw new Error('Não encontrei a camada "' + args.layerName + '" em "' + comp.name + '".');
  }

  if (comp.selectedLayers.length > 0) return comp.selectedLayers[0];

  throw new Error("Informe layerName ou layerIndex, ou selecione uma camada na timeline.");
};

vec.layerKind = function (layer) {
  if (layer instanceof ShapeLayer) return "shape";
  if (layer instanceof TextLayer) return "text";
  if (layer instanceof CameraLayer) return "camera";
  if (layer instanceof LightLayer) return "light";
  if (layer.nullLayer) return "null";
  if (layer.adjustmentLayer) return "adjustment";
  if (layer instanceof AVLayer) return "footage";
  return "other";
};

vec.readValue = function (prop) {
  if (!prop) return null;
  try {
    return vec.roundValue(prop.value);
  } catch (e) {
    return null;
  }
};

/** Arredonda para 3 casas: o AE devolve valores como 899.0999999999999. */
vec.roundValue = function (value) {
  if (typeof value === "number") return round(value, 3);
  if (value instanceof Array) {
    var out = [];
    for (var i = 0; i < value.length; i++) out.push(vec.roundValue(value[i]));
    return out;
  }
  return value;
};

vec.readColorProperty = function (prop) {
  var nomes = ["ADBE Vector Fill Color", "ADBE Vector Stroke Color"];
  for (var i = 0; i < nomes.length; i++) {
    var p = prop.property(nomes[i]);
    if (p) {
      try {
        return vec.colorToHex(p.value);
      } catch (e) {
        return null;
      }
    }
  }
  return null;
};

/** [r,g,b] de 0–1 → "#rrggbb", que é como um designer pensa em cor. */
vec.colorToHex = function (color) {
  if (!color || !(color instanceof Array)) return null;
  var out = "#";
  for (var i = 0; i < 3; i++) {
    var v = Math.round(Math.max(0, Math.min(1, color[i])) * 255).toString(16);
    out += v.length === 1 ? "0" + v : v;
  }
  return out;
};

vec.countKeyframes = function (layer) {
  var total = 0;
  var t = layer.property("ADBE Transform Group");
  for (var i = 1; i <= t.numProperties; i++) {
    try {
      total += t.property(i).numKeys;
    } catch (e) {
      // Grupo sem numKeys — segue.
    }
  }
  return total;
};

vec.mapNames = function (layers) {
  var nomes = [];
  for (var i = 0; i < layers.length; i++) nomes.push(layers[i].name);
  return nomes;
};

vec.inArray = function (arr, value) {
  for (var i = 0; i < arr.length; i++) if (arr[i] === value) return true;
  return false;
};

vec.blendModeName = function (mode) {
  // O enum BlendingMode é numérico; devolver o número não diz nada ao modelo.
  for (var key in BlendingMode) {
    if (BlendingMode.hasOwnProperty(key) && BlendingMode[key] === mode) {
      return key.toLowerCase().replace(/_/g, " ");
    }
  }
  return String(mode);
};

function round(n, casas) {
  if (typeof n !== "number" || !isFinite(n)) return n;
  var f = Math.pow(10, casas);
  return Math.round(n * f) / f;
}
