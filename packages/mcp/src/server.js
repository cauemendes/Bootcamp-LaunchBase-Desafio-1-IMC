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
 * Nove ferramentas, de propósito. Cada uma ocupa contexto em toda conversa; um
 * conjunto grande piora a escolha do modelo em vez de melhorar. O que não couber
 * aqui vai por `execute_script`, e só vira ferramenta dedicada quando houver motivo.
 */

import fs from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { normalizeScene, validateScene } from "@vectorize-ae/core";
import { Bridge, BridgeError } from "./bridge.js";
import { SCENE_FORMAT_GUIDE } from "./scene-guide.js";

const BRIDGE_HINT =
  "Abra o After Effects e o painel em Window → Vectorize AE Bridge. " +
  "O painel precisa mostrar “ouvindo”.";

export function createServer({ bridge = new Bridge() } = {}) {
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
        "Lista as composições do projeto aberto, com dimensões, frame rate e número de " +
        "camadas. Comece por aqui quando não souber o que existe no projeto.",
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
      const { result } = await call("save_frame", args, { timeoutMs: 60_000 });

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
            text: `${result.comp} · ${result.width}×${result.height} · t=${result.time}s`,
          },
          { type: "image", data: base64, mimeType: "image/png" },
        ],
      };
    }
  );

  // ---------------------------------------------------------------- construção

  server.registerTool(
    "describe_scene_format",
    {
      title: "Formato do SceneSpec",
      description:
        "Explica o formato JSON que build_scene aceita, com todos os tipos de forma e " +
        "exemplos. Leia isto antes de usar build_scene pela primeira vez.",
      inputSchema: {},
    },
    async () => asText(SCENE_FORMAT_GUIDE)
  );

  server.registerTool(
    "build_scene",
    {
      title: "Construir camadas vetoriais",
      description:
        "Constrói uma cena como shape layers e camadas de texto editáveis no After Effects. " +
        "Recebe um SceneSpec em JSON — chame describe_scene_format primeiro para saber o " +
        "formato. Use isto para reconstruir uma imagem de design 2D como camadas nativas.",
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
      },
    },
    async ({ sceneJson, compName, layerMode, reuseComp, recenterAnchors }) => {
      let scene;
      try {
        scene = JSON.parse(sceneJson);
      } catch (err) {
        return asError(`sceneJson não é JSON válido: ${err.message}`);
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

      const avisos = [...validation.warnings, ...(result.warnings ?? [])];

      return asText({
        ok: true,
        comp: result.compName,
        camadas: result.layerCount,
        avisos: avisos.length ? avisos : undefined,
        proximoPasso:
          "Chame save_frame para ver o resultado antes de considerar a tarefa concluída.",
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
