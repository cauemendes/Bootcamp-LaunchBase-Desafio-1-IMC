/**
 * Arrumação de projeto: renomear, mexer em propriedades de comp, organizar em pastas.
 *
 * ── Por que isto merece ferramenta, e não `execute_script` ────────────────────
 * São as tarefas em que o assistente é mais confiável — nada de medir imagem, nada de
 * julgar design, só mexer no DOM de forma mecânica. Justamente por isso não deveriam
 * passar por script escrito na hora: código improvisado erra de um jeito novo a cada vez,
 * e renomear em lote é operação que a pessoa só percebe depois de salvar.
 *
 * ── Por que tudo age por `id`, e não por nome ─────────────────────────────────
 * Nome não é único no After Effects. Num projeto com "SC01" e "SC01 old", agir por nome
 * renomeia a errada — e a pessoa descobre folheando 54 comps. `id` é do próprio DOM,
 * estável enquanto o projeto está aberto, e vem no `describe_project`.
 *
 * ── Por que devolve o antes ───────────────────────────────────────────────────
 * Cada operação relata o valor anterior. Um Ctrl+Z desfaz tudo, mas quem estava
 * acompanhando precisa saber o que mudou para conferir — e num lote de 54 renomeações,
 * "renomeei 54 itens" não é resposta.
 */

/*global app, CompItem, FolderItem, $, vec*/

var vec = vec || {};

/** Item do projeto por id. Erro que nomeia o id, porque é o que quem chamou tem em mão. */
function vecItemPorId(id) {
  for (var i = 1; i <= app.project.numItems; i++) {
    var item = app.project.item(i);
    if (item.id === id) return item;
  }

  throw new Error(
    "Não existe item com id " + id + " neste projeto. Os ids vêm de describe_project, e " +
      "mudam quando o projeto é fechado e reaberto."
  );
}

/**
 * Renomeia itens do projeto e camadas.
 *
 * @param {Object} args  { items: [{id, name}], layers: [{compName, layerIndex, name}] }
 */
vec.renameItems = function (args) {
  args = args || {};

  var itens = args.items || [];
  var camadas = args.layers || [];

  if (itens.length === 0 && camadas.length === 0) {
    throw new Error("rename_items precisa de pelo menos um item em `items` ou `layers`.");
  }

  var feitos = [];
  var avisos = [];
  var i;

  for (i = 0; i < itens.length; i++) {
    var pedido = itens[i];

    if (typeof pedido.name !== "string" || pedido.name === "") {
      avisos.push("item " + pedido.id + ": nome vazio — pulei.");
      continue;
    }

    try {
      var item = vecItemPorId(pedido.id);
      var antes = item.name;

      // O AE aceita nome repetido, e nome repetido é a origem de "renomeei e a errada
      // mudou" na próxima vez que alguém agir por nome. Avisar aqui é mais útil que
      // recusar: quem pediu pode ter motivo.
      item.name = vec.safeName(pedido.name, antes);

      feitos.push({ kind: "item", id: pedido.id, from: antes, to: item.name });
    } catch (e) {
      avisos.push(vec.describeError(e));
    }
  }

  for (i = 0; i < camadas.length; i++) {
    var pc = camadas[i];

    try {
      var comp = vec.findComp(pc.compName);
      var layer = vec.findLayer(comp, pc);
      var antesLayer = layer.name;

      layer.name = vec.safeName(pc.name, antesLayer);

      feitos.push({
        kind: "layer",
        comp: comp.name,
        index: layer.index,
        from: antesLayer,
        to: layer.name,
      });
    } catch (e) {
      avisos.push(vec.describeError(e));
    }
  }

  return { renamed: feitos, count: feitos.length, warnings: avisos };
};

/**
 * Muda propriedades de uma composição.
 *
 * ── Encurtar duração não apaga camada ─────────────────────────────────────────
 * O After Effects deixa as camadas onde estão; elas passam a existir fora do intervalo
 * visível. Nada se perde, e nada avisa — a comp simplesmente parece ter perdido conteúdo.
 * Por isso a resposta conta quantas camadas ficaram fora.
 */
vec.setCompSettings = function (args) {
  args = args || {};

  var comp = args.id ? vecItemPorId(args.id) : vec.findComp(args.compName);

  if (!(comp instanceof CompItem)) {
    throw new Error("O id " + args.id + " não é de uma composição.");
  }

  var antes = {
    name: comp.name,
    duration: comp.duration,
    frameRate: comp.frameRate,
    width: comp.width,
    height: comp.height,
  };

  var mudou = [];

  if (typeof args.name === "string" && args.name !== "") {
    comp.name = vec.safeName(args.name, antes.name);
    mudou.push("name");
  }

  if (typeof args.frameRate === "number" && args.frameRate > 0) {
    comp.frameRate = args.frameRate;
    mudou.push("frameRate");
  }

  // Largura e altura antes da duração: mudar tamanho não interfere no tempo, e mudar as
  // duas de uma vez num objeto só evita duas atualizações de layout da comp.
  if (typeof args.width === "number" && args.width > 0) {
    comp.width = Math.round(args.width);
    mudou.push("width");
  }

  if (typeof args.height === "number" && args.height > 0) {
    comp.height = Math.round(args.height);
    mudou.push("height");
  }

  var foraDoIntervalo = 0;

  if (typeof args.durationSeconds === "number" && args.durationSeconds > 0) {
    comp.duration = args.durationSeconds;
    mudou.push("duration");

    for (var i = 1; i <= comp.numLayers; i++) {
      if (comp.layer(i).inPoint >= comp.duration) foraDoIntervalo++;
    }
  }

  if (mudou.length === 0) {
    throw new Error(
      "Nada para mudar. Informe pelo menos um de: name, durationSeconds, frameRate, " +
        "width, height."
    );
  }

  return {
    comp: comp.name,
    id: comp.id,
    changed: mudou,
    before: {
      name: antes.name,
      duration: Math.round(antes.duration * 1000) / 1000,
      frameRate: antes.frameRate,
      width: antes.width,
      height: antes.height,
    },
    after: {
      name: comp.name,
      duration: Math.round(comp.duration * 1000) / 1000,
      frameRate: comp.frameRate,
      width: comp.width,
      height: comp.height,
    },
    layersOutOfRange: foraDoIntervalo,
  };
};

/**
 * Move itens para uma pasta, criando-a se preciso.
 *
 * A pasta é procurada por nome porque é assim que uma pessoa pensa nela, e criada quando
 * não existe — pedir para criar antes seria uma ida e volta a mais para o mesmo resultado.
 */
vec.moveToFolder = function (args) {
  args = args || {};

  var nome = args.folderName;
  if (typeof nome !== "string" || nome === "") {
    throw new Error("move_to_folder precisa de `folderName`.");
  }

  var ids = args.itemIds || [];
  if (ids.length === 0) {
    throw new Error("move_to_folder precisa de `itemIds` — os ids vêm de describe_project.");
  }

  var pasta = null;
  var i;

  for (i = 1; i <= app.project.numItems; i++) {
    var candidato = app.project.item(i);
    if (candidato instanceof FolderItem && candidato.name === nome) {
      pasta = candidato;
      break;
    }
  }

  var criada = false;
  if (pasta === null) {
    pasta = app.project.items.addFolder(vec.safeName(nome, "Folder"));
    criada = true;
  }

  var movidos = [];
  var avisos = [];

  for (i = 0; i < ids.length; i++) {
    try {
      var item = vecItemPorId(ids[i]);

      if (item === pasta) {
        avisos.push("a pasta não pode ser movida para dentro de si mesma — pulei.");
        continue;
      }

      var de = item.parentFolder && item.parentFolder !== app.project.rootFolder
        ? item.parentFolder.name
        : null;

      item.parentFolder = pasta;
      movidos.push({ id: ids[i], name: item.name, from: de });
    } catch (e) {
      avisos.push(vec.describeError(e));
    }
  }

  return {
    folder: pasta.name,
    folderId: pasta.id,
    created: criada,
    moved: movidos,
    count: movidos.length,
    warnings: avisos,
  };
};
