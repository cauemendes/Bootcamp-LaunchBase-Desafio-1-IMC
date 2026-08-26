/**
 * Camada de imagem: um arquivo colocado na caixa, ou um placeholder honesto.
 *
 * ── Por que isto existe ───────────────────────────────────────────────────────
 * Nem tudo numa arte é vetor. Uma fotografia redesenhada com shapes fica pior que um
 * espaço reservado — e um logo redesenhado a partir de print é pior ainda: existe
 * versão oficial, e a aproximação é uso indevido de marca.
 *
 * Então há dois caminhos, e a diferença entre eles é ter o arquivo ou não:
 *
 *   com `source`  → importa e posiciona na caixa medida
 *   sem `source`  → placeholder marcado, para o designer trocar pela imagem real
 *
 * ── O placeholder precisa gritar ──────────────────────────────────────────────
 * Um retângulo cinza discreto passa batido e vai para o cliente. Este vem com nome
 * prefixado, rótulo de cor laranja na timeline, e um comentário na camada dizendo o
 * que colocar ali. Três sinais, porque um só se perde numa comp de trinta camadas.
 */

/*global app, File, ImportOptions, vec*/

var vec = vec || {};

/**
 * Rótulos de cor da timeline usados pela ferramenta.
 *
 * Cor de rótulo é como um motion designer varre uma comp de longe. Reservar dois
 * valores para "isto não é vetor" transforma uma verificação item por item num olhar.
 */
vec.LABEL = {
  placeholder: 11, // laranja: falta trocar por imagem real
  asset: 3, // aqua: arquivo colocado, confira o enquadramento
};

/**
 * Se o arquivo é arte vetorial.
 *
 * O After Effects **não importa SVG** — nunca importou. Os formatos vetoriais que ele
 * lê são .ai, .eps e .pdf. Saber disso antes evita a descoberta pelo caminho ruim: o
 * import falha e a camada simplesmente não aparece.
 */
function vecEhVetor(arquivo) {
  var nome = decodeURI(arquivo.name).toLowerCase();
  return /\.(ai|eps|pdf)$/.test(nome);
}

/** Escala que faz a imagem cobrir ou caber na caixa, preservando proporção. */
vec.escalaParaCaixa = function (larguraFonte, alturaFonte, caixaW, caixaH, fit) {
  if (!larguraFonte || !alturaFonte) return [100, 100];

  var porX = (caixaW / larguraFonte) * 100;
  var porY = (caixaH / alturaFonte) * 100;

  if (fit === "stretch") return [porX, porY];

  // `cover` preenche a caixa e sobra fora; `contain` cabe inteira e sobra espaço.
  var fator = fit === "contain" ? Math.min(porX, porY) : Math.max(porX, porY);
  return [fator, fator];
};

/**
 * O item do projeto que já aponta para este arquivo, ou null.
 *
 * Importar duas vezes cria dois itens para o mesmo arquivo, e o painel de projeto
 * fica com duplicatas que o designer teria que limpar à mão.
 */
vec.itemPorArquivo = function (arquivo) {
  var alvo = arquivo.fsName;

  for (var i = 1; i <= app.project.numItems; i++) {
    var item = app.project.item(i);
    try {
      if (item.mainSource && item.mainSource.file && item.mainSource.file.fsName === alvo) {
        return item;
      }
    } catch (e) {}
  }

  return null;
};

/** Importa o arquivo, reaproveitando o item se ele já estiver no projeto. */
vec.importarArquivo = function (arquivo) {
  var existente = vec.itemPorArquivo(arquivo);
  if (existente !== null) return existente;

  return app.project.importFile(new ImportOptions(arquivo));
};

/**
 * Constrói a camada.
 *
 * @param {CompItem} comp
 * @param {Object} spec  { name, x, y, width, height, source, fit, label, opacity }
 * @returns {{layer: Layer, warning: String|null}}
 */
vec.addImageLayer = function (comp, spec, opts) {
  var aviso = null;

  if (spec.source) {
    var arquivo = new File(spec.source);

    if (/\.svg$/i.test(decodeURI(arquivo.name))) {
      aviso = 'SVG não é importável pelo After Effects: "' + spec.name + '" (' +
        arquivo.fsName + "). Converta para .ai ou .pdf, ou use PNG grande com " +
        "transparência. Entrou como placeholder.";
      return { layer: vecPlaceholder(comp, spec, aviso), warning: aviso };
    }

    if (!arquivo.exists) {
      // Caminho errado não pode virar camada silenciosamente ausente: cai para
      // placeholder e o aviso diz o caminho que faltou.
      aviso = 'File not found for "' + spec.name + '": ' + arquivo.fsName +
        " - added as a placeholder instead.";
      return { layer: vecPlaceholder(comp, spec, aviso), warning: aviso };
    }

    var item = vec.importarArquivo(arquivo);
    var layer = comp.layers.add(item);

    layer.name = vec.safeName(spec.name, "Image");
    layer.label = vec.LABEL.asset;
    layer.comment = "Placed by Vectorize AE - check the framing";

    // Arte vetorial precisa de rasterização contínua para escalar sem serrilhar. Sem
    // isto, um logo .ai colocado a 40% e depois ampliado num zoom sai borrado — e o
    // logo é justamente o elemento em que ninguém perdoa perda de qualidade.
    if (vecEhVetor(arquivo)) {
      try {
        layer.collapseTransformation = true;
      } catch (e) {
        // Nem todo tipo de footage aceita; não vale derrubar a colocação por isso.
      }
    }

    var t = layer.property("ADBE Transform Group");
    var escala = vec.escalaParaCaixa(
      item.width,
      item.height,
      spec.width,
      spec.height,
      spec.fit
    );

    // Âncora no centro do conteúdo e posição no centro da caixa: é o único par que
    // mantém a imagem centrada qualquer que seja a escala.
    t.property("ADBE Anchor Point").setValue([item.width / 2, item.height / 2]);
    t.property("ADBE Position").setValue([spec.x + spec.width / 2, spec.y + spec.height / 2]);
    t.property("ADBE Scale").setValue(escala);
    t.property("ADBE Opacity").setValue(spec.opacity);

    return { layer: layer, warning: null };
  }

  aviso = 'PLACEHOLDER: "' + spec.name + '" needs a real image' +
    (spec.label ? " (" + spec.label + ")" : "") + ".";

  return { layer: vecPlaceholder(comp, spec, aviso), warning: aviso };
};

/**
 * O retângulo que ocupa o lugar da imagem que falta.
 *
 * Shape layer e não solid: solid vira item no painel de projeto e polui a lista, e o
 * designer costuma apagar o placeholder em vez de reaproveitá-lo — deixar lixo no
 * projeto é pior que deixar uma camada.
 */
function vecPlaceholder(comp, spec, descricao) {
  var layer = comp.layers.addShape();

  layer.name = "[IMAGE] " + vec.safeName(spec.name, "Image");
  layer.label = vec.LABEL.placeholder;
  layer.comment = descricao + " Replace this layer with the real image and delete the placeholder.";

  var contents = layer.property("ADBE Root Vectors Group");
  var group = contents.addProperty("ADBE Vector Group");
  group.name = spec.label ? vec.safeName(spec.label, "Content") : "Image area";

  var inner = group.property("ADBE Vectors Group");

  vec.addRect(inner, {
    type: "rect",
    cx: spec.x + spec.width / 2,
    cy: spec.y + spec.height / 2,
    w: spec.width,
    h: spec.height,
    roundness: 0,
  });

  // Cinza médio com contorno: lê como "espaço reservado" em qualquer fundo, claro ou
  // escuro. Uma cor da marca aqui seria pior — pareceria parte do design.
  vec.addFill(inner, { color: "#8a8a8a", opacity: 35 }, {});
  vec.addStroke(
    inner,
    { color: "#8a8a8a", opacity: 100, width: 2, cap: "butt", join: "miter" },
    {}
  );

  var t = layer.property("ADBE Transform Group");
  t.property("ADBE Anchor Point").setValue([0, 0]);
  t.property("ADBE Position").setValue([0, 0]);

  return layer;
}
