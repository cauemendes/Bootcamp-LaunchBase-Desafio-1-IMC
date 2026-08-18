/**
 * Servidor MCP do Vectorize AE.
 *
 * Expõe o After Effects como ferramentas para o Claude Code. O caminho é:
 *
 *   Claude Code  ──stdio/MCP──►  este servidor  ──arquivos──►  painel no AE
 *
 * ── Uma consequência boa de usar MCP ──────────────────────────────────────────
 * O modelo que enxerga a imagem é o próprio Claude Code. Este servidor não chama a
 * API da Anthropic — não precisa de chave, não gasta crédito de API, e a visão que
 * reconstrói o design é a mesma que você já usa no terminal.
 *
 * ── Sobre o tamanho do conjunto ───────────────────────────────────────────────
 * Dezesseis ferramentas, de propósito. Cada uma ocupa contexto em toda conversa; um
 * conjunto grande piora a escolha do modelo em vez de melhorar. O que não couber
 * aqui vai por `execute_script`, e só vira ferramenta dedicada quando houver motivo.
 */

import fs from "node:fs";
import zlib from "node:zlib";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  AnimError,
  applyBrand,
  brandSummary,
  decodePng,
  measureRegion,
  SequenceError,
  normalizeScene,
  planSequence,
  resolveAnimation,
  sampleColor,
  scanLine,
  validateScene,
} from "@vectorize-ae/core";
import { Bridge, BridgeError } from "./bridge.js";
import { BrandStore } from "./brand-store.js";
import { ANIM_FORMAT_GUIDE } from "./anim-guide.js";
import { sceneFormatGuide } from "./scene-guide.js";

/**
 * O que responder quando não há marca configurada.
 *
 * Isto é uma instrução, não um erro. Reconstruir um design com a cor errada custa
 * mais que perguntar: quem for ajustar depois vai achar dezoito hexadecimais quase
 * iguais espalhados por vinte camadas, e é exatamente esse trabalho manual que a
 * ferramenta existe para eliminar. Uma pergunta de dez segundos no início evita isso.
 */
const SEM_MARCA =
  "Nenhuma marca configurada.\n\n" +
  "Antes de construir, PERGUNTE ao usuário se existe um guia de marca para este " +
  "projeto — cores (hex), famílias de fonte, e arquivos de logo. Se houver, registre " +
  "com `set_brand` e só então construa; as cores e fontes saem certas de primeira.\n\n" +
  "O logo importa tanto quanto a cor: redesenhado a partir de print ele fica errado de " +
  "um jeito que ninguém aceita, e existe versão oficial. Se o usuário tiver o arquivo, " +
  "registre em `assets` e use `image` com `source`.\n\n" +
  "Se ele disser que não há, ou preferir não informar agora, siga assim mesmo: as " +
  "cores vêm da imagem e o texto sai em Arial. Não invente uma paleta de marca.";

const BRIDGE_HINT =
  "Abra o After Effects e o painel em Window → Vectorize AE Bridge. " +
  "O painel precisa mostrar “ouvindo”.";

export function createServer({ bridge = new Bridge(), brands = new BrandStore() } = {}) {
  const server = new McpServer({ name: "vectorize-ae", version: "0.1.0" });

  /** Executa uma ferramenta da ponte e formata a resposta pro MCP. */
  const call = async (tool, args, { timeoutMs } = {}) => {
    try {
      const { result, warnings } = await bridge.call(tool, args, { timeoutMs });
      return { result, warnings };
    } catch (err) {
      if (err instanceof BridgeError && err.kind === "timeout") {
        throw new Error(`${err.message}`);
      }
      throw err;
    }
  };

  const asText = (value) => ({
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  });

  const asError = (message) => ({
    isError: true,
    content: [{ type: "text", text: message }],
  });

  // ---------------------------------------------------------------- diagnóstico

  server.registerTool(
    "check_bridge",
    {
      title: "Verificar a ponte",
      description:
        "Confirma que o After Effects está aberto e o painel da ponte está ouvindo. " +
        "Use isto antes de concluir que outra ferramenta falhou.",
      inputSchema: {},
    },
    async () => {
      try {
        const { result } = await call("ping", {}, { timeoutMs: 4000 });
        return asText({ conectado: true, ...result });
      } catch {
        return asError(`A ponte não respondeu.\n\n${BRIDGE_HINT}`);
      }
    }
  );

  // ---------------------------------------------------------------- leitura

  server.registerTool(
    "describe_project",
    {
      title: "Descrever o projeto",
      description:
        "Lista as composições do projeto aberto e os arquivos importados, com o caminho " +
        "de cada um em disco. Comece por aqui quando não souber o que existe no projeto — " +
        "é também como se acha o caminho de uma imagem de referência para `measure_image`, " +
        "que lê o arquivo direto e não depende do After Effects.",
      inputSchema: {},
    },
    async () => asText((await call("describe_project", {})).result)
  );

  server.registerTool(
    "describe_comp",
    {
      title: "Descrever uma composição",
      description:
        "Resumo de uma composição e de todas as suas camadas: tipo, posição, escala, " +
        "opacidade, efeitos aplicados e se tem keyframes. Para o detalhe completo de uma " +
        "camada específica, use describe_layer depois.",
      inputSchema: {
        compName: z
          .string()
          .optional()
          .describe("Nome da composição. Se omitido, usa a composição ativa na timeline."),
        selectedOnly: z
          .boolean()
          .optional()
          .describe("Descrever apenas as camadas selecionadas na timeline."),
      },
    },
    async (args) => asText((await call("describe_comp", args)).result)
  );

  server.registerTool(
    "describe_layer",
    {
      title: "Descrever uma camada",
      description:
        "Detalhe completo de uma camada: transform com keyframes e expressões, efeitos " +
        "com seus valores, árvore de shapes, e o texto se for camada de texto.",
      inputSchema: {
        compName: z.string().optional().describe("Composição. Omitido = a ativa."),
        layerName: z.string().optional().describe("Nome da camada."),
        layerIndex: z
          .number()
          .int()
          .optional()
          .describe("Índice da camada (1 = topo da timeline). Alternativa a layerName."),
      },
    },
    async (args) => asText((await call("describe_layer", args)).result)
  );

  server.registerTool(
    "list_fonts",
    {
      title: "Listar fontes instaladas",
      description:
        "Famílias de fonte disponíveis nesta máquina. Use com `filter` para checar se uma " +
        "fonte específica existe antes de pedir por ela — o After Effects substitui fonte " +
        "ausente em silêncio, e o layout sai diferente sem nenhum aviso.",
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe("Filtra por trecho do nome. Sem filtro, devolve a lista inteira (pode ser longa)."),
      },
    },
    async (args) => asText((await call("list_fonts", args)).result)
  );

  // ---------------------------------------------------------------- visão

  server.registerTool(
    "save_frame",
    {
      title: "Renderizar um frame",
      description:
        "Renderiza um frame da composição e devolve a imagem, para você VER o resultado do " +
        "que fez. Use depois de construir ou animar: nenhuma chamada ter dado erro não é a " +
        "mesma coisa que o resultado ter ficado bom.",
      inputSchema: {
        compName: z.string().optional().describe("Composição. Omitido = a ativa."),
        time: z
          .number()
          .optional()
          .describe("Instante em segundos. Omitido = o tempo atual da timeline."),
      },
    },
    async (args) => {
      // Timeout generoso: quando a API direta não entrega, o painel cai para a fila
      // de render, que abre progresso e leva bem mais que os 60s de antes.
      const { result } = await call("save_frame", args, { timeoutMs: 180_000 });

      let base64;
      try {
        base64 = fs.readFileSync(result.path).toString("base64");
      } catch (err) {
        return asError(
          `O After Effects gravou o frame em ${result.path}, mas não consegui ler o arquivo: ${err.message}`
        );
      }

      return {
        content: [
          {
            type: "text",
            text:
              `${result.comp} · ${result.width}×${result.height} · t=${result.time}s` +
              // Qual caminho funcionou importa: no 26.3 do macOS a API direta retorna
              // sem erro e não grava nada, e a fila é o contorno. Saber disso evita
              // rediagnosticar quando ficar lento, e revela quando a API voltar a
              // funcionar numa versão futura.
              (result.method && result.method !== "saveFrameToPng"
                ? ` · via ${result.method}`
                : ""),
          },
          { type: "image", data: base64, mimeType: "image/png" },
        ],
      };
    }
  );

  // ---------------------------------------------------------------- medição

  /** Decodifica uma vez por chamada — a mesma imagem costuma render várias medidas. */
  const carregarPng = (caminho) => {
    const bytes = fs.readFileSync(caminho);
    return decodePng(new Uint8Array(bytes), (b) => new Uint8Array(zlib.inflateSync(Buffer.from(b))));
  };

  server.registerTool(
    "measure_image",
    {
      title: "Medir uma imagem de referência",
      description:
        "Mede cor, extensão de forma e raio de canto direto nos pixels de um PNG. Use " +
        "ANTES de montar um SceneSpec a partir de imagem: estimar coordenada e cor no " +
        "olho produz um layout que parece certo até alguém pôr lado a lado com o " +
        "original.\n\n" +
        "As três operações são independentes e vêm na mesma chamada, porque a imagem é " +
        "decodificada uma vez só:\n" +
        "  • `samples` — cor num ponto. Devolve `uniformity`; abaixo de ~0.8 a amostra " +
        "caiu em borda ou gradiente e o hex NÃO é uma cor do design.\n" +
        "  • `regions` — a forma contígua que contém o ponto: limites, quanto ela " +
        "preenche do próprio retângulo, e o raio de CADA canto separado.\n" +
        "  • `lines` — onde a cor muda ao longo de uma linha. É como se acha borda.\n\n" +
        "Só PNG. Para medir uma referência em JPEG, converta antes.",
      inputSchema: {
        path: z.string().describe("Caminho absoluto do PNG."),
        samples: z
          .array(z.object({ x: z.number().int(), y: z.number().int() }))
          .optional()
          .describe("Pontos a amostrar. Amostre o meio das áreas chapadas, longe das bordas."),
        regions: z
          .array(z.object({ x: z.number().int(), y: z.number().int() }))
          .optional()
          .describe("Sementes: um ponto dentro de cada forma que você quer medir."),
        lines: z
          .array(
            z.object({
              axis: z.enum(["horizontal", "vertical"]),
              at: z.number().int().describe("y da linha, ou x da coluna."),
              from: z.number().int().optional(),
              to: z.number().int().optional(),
            })
          )
          .optional()
          .describe("Varreduras para achar bordas."),
        radius: z.number().int().optional().describe("Raio do bloco de amostragem. Padrão 3."),
        tolerance: z
          .number()
          .optional()
          .describe(
            "Distância de cor que ainda conta como a mesma. Padrão 12 — cobre ruído de " +
              "compressão. Aumente para imagem muito comprimida."
          ),
      },
    },
    async ({ path: caminho, samples = [], regions = [], lines = [], radius, tolerance }) => {
      let img;
      try {
        img = carregarPng(caminho);
      } catch (err) {
        return asError(`Não consegui ler ${caminho}: ${err.message}`);
      }

      const opcoes = {};
      if (tolerance != null) opcoes.tolerance = tolerance;

      // Uma medição fora dos limites não pode derrubar as outras: quem pediu dez
      // pontos prefere nove medidos e um avisado a nenhum.
      const tentar = (fn) => {
        try {
          return fn();
        } catch (err) {
          return { error: err.message };
        }
      };

      return asText({
        image: { width: img.width, height: img.height },
        samples: samples.map((p) => ({
          ...p,
          ...tentar(() => sampleColor(img, p.x, p.y, { ...opcoes, radius: radius ?? 3 })),
        })),
        regions: regions.map((p) => ({
          seed: p,
          ...tentar(() => measureRegion(img, p.x, p.y, opcoes)),
        })),
        lines: lines.map((l) =>
          tentar(() => scanLine(img, l.axis, l.at, { ...opcoes, from: l.from ?? 0, to: l.to ?? null }))
        ),
      });
    }
  );

  // ---------------------------------------------------------------- marca

  server.registerTool(
    "describe_brand",
    {
      title: "Marca ativa",
      description:
        "Cores e fontes da marca em uso. CHAME ANTES de build_scene, sempre. Se não " +
        "houver marca configurada, pergunte ao usuário se existe um guia de marca para " +
        "o projeto antes de construir — cor e fonte erradas viram retrabalho manual em " +
        "todas as camadas.",
      inputSchema: {},
    },
    async () => {
      const ativa = brands.active();
      const salvas = brands.list();

      if (!ativa) {
        return asText(
          SEM_MARCA +
            (salvas.length
              ? `\n\nPerfis já salvos: ${salvas.map((b) => `${b.name} (${b.slug})`).join(", ")}. ` +
                "Use `set_brand` com `activateSlug` para reativar um deles."
              : "")
        );
      }

      return asText(
        `${brandSummary(ativa.brand)}\n\nPerfil ativo: ${ativa.slug}` +
          (salvas.length > 1
            ? `\nOutros perfis: ${salvas.filter((b) => b.slug !== ativa.slug).map((b) => b.slug).join(", ")}`
            : "")
      );
    }
  );

  server.registerTool(
    "set_brand",
    {
      title: "Registrar a marca do projeto",
      description:
        "Guarda as cores e fontes do cliente e passa a usá-las nas construções. Depois " +
        "disso o SceneSpec pode usar os nomes (`\"color\": \"primary\"`, " +
        "`\"fontFamily\": \"heading\"`) em vez de hexadecimal, e um hex medido da imagem " +
        "que esteja perto de uma cor da marca é encostado nela automaticamente.\n\n" +
        "Colete do usuário antes de chamar: os hexadecimais com seus nomes e as famílias " +
        "de fonte com o estilo. Para trocar de cliente sem redigitar, passe só " +
        "`activateSlug`.",
      inputSchema: {
        name: z.string().optional().describe("Nome do cliente ou do projeto."),
        colors: z
          .record(z.string())
          .optional()
          .describe('Cores por nome, ex.: {"primary": "#FF5A20", "ink": "#12263A"}.'),
        fonts: z
          .record(z.object({ family: z.string(), style: z.string().optional() }))
          .optional()
          .describe('Fontes por nome, ex.: {"heading": {"family": "ABC Diatype", "style": "Bold"}}.'),
        fallbackFont: z
          .string()
          .optional()
          .describe("Fonte para texto sem família definida. Padrão Arial."),
        assets: z
          .record(z.string())
          .optional()
          .describe(
            'Arquivos da marca por nome, ex.: {"logo": "/Users/eu/marca/logo.ai"}. ' +
              "Formatos que o After Effects importa: .ai, .eps, .pdf (vetor, escala sem " +
              "perder) ou .png grande com transparência. **SVG o AE não importa** — nunca " +
              "importou. Caminho absoluto, e o arquivo precisa existir em disco: não dá " +
              "para usar uma imagem colada na conversa, porque o que vai para a camada é " +
              "o arquivo, não a visualização. " +
              "Logo NUNCA deve ser redesenhado a partir de print: existe versão oficial, " +
              "e a aproximação é uso indevido de marca. Com o asset registrado, uma forma " +
              '`image` com `"source": "logo"` coloca o arquivo real. Pergunte ao usuário ' +
              "se há logos ou imagens fixas junto das cores e fontes."
          ),
        notes: z
          .array(z.string())
          .optional()
          .describe(
            "Regras de uso que o manual da marca traz e que uma paleta sozinha não " +
              'expressa. Ex.: "smile-orange-text só como cor de texto sobre off-white", ' +
              '"nunca usar as cores terciárias em área grande". Registre o que estiver ' +
              "no guia — é a parte que se viola sem perceber, porque o hex está certo."
          ),
        snapTolerance: z
          .number()
          .optional()
          .describe(
            "Distância máxima para encostar um hex medido numa cor da marca. Padrão 14 — " +
              "cobre ruído de compressão sem trocar cores que são realmente outras."
          ),
        activateSlug: z
          .string()
          .optional()
          .describe("Reativa um perfil já salvo, pelo slug. Ignora os demais campos."),
      },
    },
    async ({ activateSlug, ...brand }) => {
      if (activateSlug) {
        const ativa = brands.activate(activateSlug);
        if (!ativa) return asError(`Não achei nenhum perfil salvo com o slug "${activateSlug}".`);
        return asText(`Perfil "${activateSlug}" ativado.\n\n${brandSummary(ativa.brand)}`);
      }

      const resultado = brands.save(brand);
      if (!resultado.ok) {
        return asError("O perfil de marca tem erros:\n\n" + resultado.errors.map((e) => `  • ${e}`).join("\n"));
      }

      return asText({
        ok: true,
        slug: resultado.slug,
        arquivo: resultado.file,
        avisos: resultado.warnings.length ? resultado.warnings : undefined,
        resumo: brandSummary(brand),
      });
    }
  );

  // ---------------------------------------------------------------- construção

  server.registerTool(
    "describe_scene_format",
    {
      title: "Formato do SceneSpec",
      description:
        "Explica o formato JSON que build_scene aceita, com todos os tipos de forma e " +
        "exemplos. Leia isto antes de usar build_scene pela primeira vez.\n\n" +
        "`fidelity` decide quanto medir antes de construir, e é o que separa uma " +
        "reconstrução de três minutos de uma de vinte. Se o usuário não disse qual " +
        "quer, PERGUNTE em vez de escolher por ele — é a escolha dele entre tempo e " +
        "exatidão, e ela muda o resultado.",
      inputSchema: {
        fidelity: z
          .enum(["draft", "balanced", "precise"])
          .optional()
          .describe(
            "draft: rápido, mede só paleta e blocos grandes, sem iterar. " +
              "balanced (padrão): mede todas as formas, uma rodada de conferência. " +
              "precise: mede tudo e itera até a diferença ser imperceptível — vale " +
              "quando a reconstrução vai virar base de uma animação longa."
          ),
      },
    },
    async ({ fidelity }) => asText(sceneFormatGuide(fidelity))
  );

  server.registerTool(
    "build_scene",
    {
      title: "Construir camadas vetoriais",
      description:
        "Constrói uma cena como shape layers e camadas de texto editáveis no After Effects. " +
        "Recebe um SceneSpec em JSON — chame describe_scene_format primeiro para saber o " +
        "formato, e describe_brand para saber quais cores e fontes usar. Use isto para " +
        "reconstruir uma imagem de design 2D como camadas nativas.",
      inputSchema: {
        sceneJson: z
          .string()
          .describe("O SceneSpec completo, em JSON. Veja describe_scene_format."),
        compName: z.string().optional().describe("Nome da composição a criar."),
        layerMode: z
          .enum(["per-group", "per-element"])
          .optional()
          .describe(
            "per-group (padrão): elementos do mesmo grupo viram uma camada só. " +
              "per-element: cada elemento vira sua própria camada."
          ),
        reuseComp: z
          .boolean()
          .optional()
          .describe("Construir na composição ativa em vez de criar uma nova."),
        recenterAnchors: z
          .boolean()
          .optional()
          .describe("Centralizar a âncora de cada camada. Padrão true — necessário para animar."),
        useBrand: z
          .boolean()
          .optional()
          .describe(
            "Aplicar a marca ativa. Padrão true. Passe false só quando o design " +
              "deliberadamente não segue a identidade do cliente."
          ),
      },
    },
    async ({ sceneJson, compName, layerMode, reuseComp, recenterAnchors, useBrand = true }) => {
      let scene;
      try {
        scene = JSON.parse(sceneJson);
      } catch (err) {
        return asError(`sceneJson não é JSON válido: ${err.message}`);
      }

      // A marca entra antes da validação: um token como "primary" não é hex válido,
      // e o validador reprovaria algo que está certo — só ainda não foi resolvido.
      const marca = useBrand ? brands.active() : null;
      const avisosMarca = [];

      if (marca) {
        const resolvida = applyBrand(scene, marca.brand);
        scene = resolvida.scene;
        avisosMarca.push(...resolvida.warnings);
      }

      // Validar antes de mandar pro AE: um erro apanhado aqui vira uma mensagem
      // que diz qual elemento está errado, em vez de uma camada faltando na comp.
      const validation = validateScene(scene);

      if (!validation.ok) {
        return asError(
          "O SceneSpec tem erros que impedem a construção:\n\n" +
            validation.errors.map((e) => `  • ${e}`).join("\n") +
            "\n\nCorrija e chame de novo."
        );
      }

      const normalized = normalizeScene(scene, { layerMode });

      const { result } = await call(
        "build_scene",
        {
          scene: normalized,
          options: { compName, reuseComp, recenterAnchors },
        },
        { timeoutMs: 120_000 }
      );

      if (!result.ok) return asError(result.error);

      const avisos = [...avisosMarca, ...validation.warnings, ...(result.warnings ?? [])];

      // Salvar é decisão do usuário, não obrigação da ferramenta. Mas produzir em
      // série sem nada em disco é o pior desfecho possível, então quando o projeto
      // nunca foi salvo o aviso vem com um caminho pronto na Mesa.
      const semArquivo = !result.projectFile;

      return asText({
        ok: true,
        comp: result.compName,
        camadas: result.layerCount,
        marca: marca ? marca.slug : "nenhuma — cores da imagem, texto em Arial",
        avisos: avisos.length ? avisos : undefined,
        projeto: semArquivo
          ? "NUNCA SALVO — nada disto está em disco. Ofereça salvar em " +
            `${result.suggestedSavePath} (save_project com esse path). Não salve sem ` +
            "o usuário concordar; só não deixe passar em branco."
          : result.projectFile,
        proximoPasso:
          "Chame save_frame para ver o resultado antes de considerar a tarefa concluída.",
      });
    }
  );

  server.registerTool(
    "save_project",
    {
      title: "Salvar o projeto",
      description:
        "Grava o .aep em disco. Nada do que build_scene e animate_layers criam está " +
        "salvo até isto rodar — o trabalho existe na memória do After Effects e some " +
        "se ele fechar.\n\n" +
        "Sobrescreve o arquivo atual. Se o projeto nunca foi salvo, `path` é " +
        "obrigatório: salvar sem caminho abriria um diálogo modal no After Effects, e " +
        "diálogo modal congela a ponte esperando um clique que ninguém vai dar.\n\n" +
        "PERGUNTE ao usuário antes de sobrescrever um projeto que ele já salvou.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Caminho completo terminando em .aep. Omitido = sobrescreve onde o projeto " +
              "já está. Obrigatório se o projeto nunca foi salvo."
          ),
      },
    },
    async (args) => {
      const { result } = await call("save_project", args, { timeoutMs: 120_000 });

      return asText({
        salvo: result.path,
        sobrescreveu: result.overwrote,
        primeiraVez: result.wasUnsaved || undefined,
      });
    }
  );

  // ---------------------------------------------------------------- animação

  server.registerTool(
    "describe_animation_format",
    {
      title: "Formato do AnimSpec",
      description:
        "Explica o formato que animate_layers aceita: presets, easing, stagger, " +
        "overshoot, e as faixas de duração que funcionam. Leia antes de animar pela " +
        "primeira vez.",
      inputSchema: {},
    },
    async () => asText(ANIM_FORMAT_GUIDE)
  );

  server.registerTool(
    "animate_layers",
    {
      title: "Animar camadas com keyframes",
      description:
        "Anima camadas que já existem na composição, criando keyframes editáveis com " +
        "easing temporal do After Effects — não expressões. Recebe um AnimSpec em JSON; " +
        "chame describe_animation_format primeiro para saber o formato.\n\n" +
        "Keyframes já existentes na propriedade são substituídos.",
      inputSchema: {
        animJson: z
          .string()
          .describe("O AnimSpec completo, em JSON. Veja describe_animation_format."),
        compName: z
          .string()
          .optional()
          .describe("Composição onde as camadas estão. Omitido = a ativa."),
      },
    },
    async ({ animJson, compName }) => {
      let spec;
      try {
        spec = JSON.parse(animJson);
      } catch (err) {
        return asError(`animJson não é JSON válido: ${err.message}`);
      }

      // Resolver aqui, antes de tocar no After Effects: um preset escrito errado vira
      // uma mensagem dizendo qual e quais existem, em vez de camadas paradas na comp.
      let resolvido;
      try {
        resolvido = resolveAnimation(spec);
      } catch (err) {
        if (err instanceof AnimError) return asError(err.message);
        throw err;
      }

      const { result } = await call(
        "animate",
        { tracks: resolvido.tracks, options: { compName } },
        { timeoutMs: 120_000 }
      );

      const avisos = [...resolvido.warnings, ...(result.warnings ?? [])];

      return asText({
        ok: result.ok,
        comp: result.compName,
        trilhas: result.applied,
        keyframes: result.keyframes,
        avisos: avisos.length ? avisos : undefined,
        proximoPasso:
          "Chame save_frame em dois ou três instantes diferentes e olhe — nenhuma " +
          "chamada ter dado erro não é a mesma coisa que o timing ter ficado bom. " +
          "Os keyframes existem só na memória do After Effects até save_project rodar.",
      });
    }
  );

  // ---------------------------------------------------------------- montagem

  server.registerTool(
    "build_master_comp",
    {
      title: "Montar a comp master",
      description:
        "Sequencia composições de cena numa comp master, com áudio e marcadores. É o " +
        "passo que transforma cenas soltas num vídeo: cada cena no seu tempo, a locução " +
        "embaixo, marcadores nomeando os momentos na régua.\n\n" +
        "As cenas precisam existir antes — construa cada uma com build_scene, depois " +
        "monte.\n\n" +
        "A duração de cada cena vem, nesta ordem: `durationFrames` declarado, estimativa " +
        "pelo `script` da cena, ou o padrão. A estimativa por texto não pretende ser " +
        "exata: ela põe as cenas perto do lugar certo para o designer ajustar ouvindo o " +
        "áudio, que é como esse trabalho é feito de verdade.\n\n" +
        "Nomeie comps e marcadores em INGLÊS.",
      inputSchema: {
        name: z.string().describe('Nome da comp master, em inglês. Ex.: "Master - Bid Adjustments".'),
        width: z.number().int().optional().describe("Largura. Padrão 1920."),
        height: z.number().int().optional().describe("Altura. Padrão 1080."),
        frameRate: z.number().optional().describe("Frame rate. Padrão 30."),
        audio: z
          .string()
          .optional()
          .describe("Caminho do arquivo de locução ou trilha. Entra no fundo da pilha."),
        audioDurationFrames: z
          .number()
          .int()
          .optional()
          .describe(
            "Duração do áudio em frames, se você já souber. Serve para avisar quando as " +
              "cenas não cobrem o áudio."
          ),
        fitToAudio: z
          .boolean()
          .optional()
          .describe(
            "Esticar ou encolher todas as cenas proporcionalmente para casar com o áudio. " +
              "Mantém o ritmo relativo entre elas."
          ),
        defaultDurationFrames: z
          .number()
          .int()
          .optional()
          .describe("Duração de cena sem texto e sem duração declarada. Padrão 90."),
        wordsPerMinute: z
          .number()
          .optional()
          .describe("Velocidade da locução para estimar por texto. Padrão 150."),
        scenes: z
          .array(
            z.object({
              comp: z.string().describe("Nome da composição da cena, que já deve existir."),
              durationFrames: z.number().int().optional(),
              script: z
                .string()
                .optional()
                .describe("O que é falado nesta cena. Vira estimativa de duração."),
              transitionFrames: z
                .number()
                .int()
                .optional()
                .describe("Crossfade na entrada desta cena. 0 = corte seco."),
              marker: z.string().optional().describe("Nome do marcador. Omitido = nome da comp."),
            })
          )
          .describe("As cenas, na ordem em que aparecem."),
        replace: z
          .boolean()
          .optional()
          .describe("Substituir a master se já existir. DESTRUTIVO — pergunte antes."),
      },
    },
    async ({ name, width, height, frameRate, audio, replace, ...spec }) => {
      const fps = frameRate ?? 30;

      let plano;
      try {
        plano = planSequence({ ...spec, fps });
      } catch (err) {
        if (err instanceof SequenceError) return asError(err.message);
        throw err;
      }

      const { result } = await call(
        "build_sequence",
        {
          plan: {
            name,
            width: width ?? 1920,
            height: height ?? 1080,
            frameRate: fps,
            totalFrames: plano.totalFrames,
            audio,
            scenes: plano.scenes,
          },
          options: { replace },
        },
        { timeoutMs: 120_000 }
      );

      const avisos = [...plano.warnings, ...(result.warnings ?? [])];

      return asText({
        ok: result.ok,
        comp: result.compName,
        cenas: result.scenes,
        duracao: `${result.durationSeconds}s (${result.durationFrames} frames)`,
        origemDasDuracoes: plano.scenes.map((s) => `${s.comp}: ${s.durationSource}`),
        avisos: avisos.length ? avisos : undefined,
        proximoPasso:
          "Abra a master e ouça. As durações estimadas põem as cenas perto do lugar " +
          "certo, não no lugar exato — o ajuste fino é ouvindo.",
      });
    }
  );

  // ---------------------------------------------------------------- escape hatch

  server.registerTool(
    "execute_script",
    {
      title: "Executar ExtendScript",
      description:
        "Executa ExtendScript arbitrário dentro do After Effects e devolve o resultado. " +
        "É o escape hatch para o que as outras ferramentas não cobrem — animar, aplicar " +
        "efeitos, reorganizar camadas, qualquer coisa que a API de scripting do AE permita.\n\n" +
        "A linguagem é ECMAScript 3: use var, nada de arrow function, template literal, " +
        "const/let ou JSON. Acesse propriedades por matchName (\"ADBE Transform Group\"), " +
        "nunca por nome exibido — o nome muda com o idioma do aplicativo.\n\n" +
        "O código roda num grupo de undo próprio, então um Cmd+Z desfaz tudo que ele fez. " +
        "A última expressão é o valor de retorno.",
      inputSchema: {
        code: z.string().describe("O código ExtendScript. A última expressão é o retorno."),
        label: z
          .string()
          .optional()
          .describe("Nome que aparece no menu Edit → Undo. Descreva a ação em poucas palavras."),
      },
    },
    async (args) => {
      const { result } = await call("execute_script", args, { timeoutMs: 120_000 });
      return asText(result.value);
    }
  );

  return server;
}
