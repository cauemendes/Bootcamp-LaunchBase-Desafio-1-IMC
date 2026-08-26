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
 * Vinte e duas ferramentas, de propósito. Cada uma ocupa contexto em toda conversa; um
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
  CompareError,
  CutoutError,
  compareImages,
  contentBounds,
  differenceImage,
  cropImage,
  encodePng,
  isolateComponent,
  removeFlatBackground,
  trimTo,
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
        // O diagnóstico do heartbeat existia e era descartado aqui. Distinguir "não
        // está aberto" de "está aberto e parou de escutar" é a diferença entre um
        // clique e uma noite de tentativas cegas.
        const d = bridge.diagnose();

        return asError(
          `A ponte não respondeu.\n\nDIAGNÓSTICO: ${d.message}\n\n` +
            (d.state === "vivo"
              ? ""
              : "IMPORTANTE: isto exige alguém mexer no After Effects. Se você está " +
                "rodando sem acompanhamento, PARE e registre o bloqueio em vez de " +
                "tentar de novo indefinidamente — nenhuma quantidade de tentativas " +
                "resolve um painel que precisa de um clique.")
        );
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
        "que lê o arquivo direto e não depende do After Effects.\n\n" +
        "Cada item traz `folder` (a pasta em que está, ou null se estiver na raiz), `id` e " +
        "`selected`. Use isto para atender pedidos como \"renomeie as comps desta pasta\" " +
        "ou \"as que eu selecionei\", em vez de descobrir a estrutura escrevendo script no " +
        "escuro. E aja sempre pelo `id`, não pelo nome: num projeto com nomes parecidos, " +
        "agir por nome renomeia a comp errada.\n\n" +
        "`selectedCount` em zero num pedido sobre seleção quer dizer que a seleção se " +
        "perdeu — pergunte, em vez de agir sobre o projeto inteiro.",
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

  /**
   * Largura e altura de um PNG, direto do IHDR.
   *
   * Não usa `decodePng` de propósito: aqui só interessa o cabeçalho, e decodificar a
   * imagem inteira para ler dois inteiros faria uma conferência barata custar caro num
   * frame de 4K. Devolve null se não parecer um PNG — quem chama trata como "não sei",
   * que é diferente de "está errado".
   */
  /**
   * Diz se o frame é inútil para medir: uma cor só, do primeiro ao último pixel.
   *
   * ── Por que isto é a proteção mais importante do save_frame ──────────────────
   * Um frame em branco não parece um erro. Ele chega como imagem válida, e quem for
   * medir cor nele recebe respostas coerentes: preto em todo lugar. A cena reconstruída
   * sai inteira em preto ou azul-escuro, com o desenho certo e a cor errada — e a
   * primeira suspeita recai sobre a medição de cor, que está funcionando.
   *
   * Aconteceu: `timeSpanStart` fora do intervalo da comp fez a fila de render entregar
   * quadro vazio, e o resultado foi uma reconstrução escura que parecia problema de
   * paleta. O aviso do próprio After Effects dizia "Render will succeed, but may have
   * blank frames" — e ninguém do lado de cá estava olhando para o pixel.
   *
   * A varredura sai no primeiro pixel diferente, então arte de verdade custa quase
   * nada. Só o caso degenerado percorre a imagem inteira, e é justamente o que precisa
   * de resposta certa.
   */
  const frameUniforme = (bytes) => {
    let img;
    try {
      img = decodePng(
        new Uint8Array(bytes),
        (b) => new Uint8Array(zlib.inflateSync(Buffer.from(b)))
      );
    } catch {
      // Não conseguir decodificar não é o mesmo que estar em branco.
      return null;
    }

    const d = img.data;
    if (d.length < 8) return null;

    for (let i = 4; i < d.length; i += 4) {
      if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2] || d[i + 3] !== d[3]) {
        return null;
      }
    }

    const hex = (v) => v.toString(16).padStart(2, "0");
    return d[3] === 0
      ? "totalmente transparente"
      : `de uma cor só (#${hex(d[0])}${hex(d[1])}${hex(d[2])})`;
  };

  const dimensoesPng = (bytes) => {
    // 8 bytes de assinatura + 4 de tamanho do chunk + 4 do tipo "IHDR" = 16.
    if (!bytes || bytes.length < 24) return null;
    if (bytes.toString("latin1", 1, 4) !== "PNG") return null;
    if (bytes.toString("latin1", 12, 16) !== "IHDR") return null;

    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  };

  server.registerTool(
    "save_frame",
    {
      title: "Renderizar um frame",
      description:
        "Renderiza um frame da composição, devolve a imagem e o caminho do arquivo.\n\n" +
        "Serve para DUAS coisas, e a segunda é fácil de esquecer:\n\n" +
        "1. VER o resultado do que você fez. Nenhuma chamada ter dado erro não é a mesma " +
        "coisa que o resultado ter ficado bom.\n\n" +
        "2. CAPTURAR a referência a reconstruir. Quando alguém pede para redesenhar o que " +
        "está na tela do After Effects, ou uma comp que já existe no projeto, a referência " +
        "é isto — não um arquivo que a pessoa precise exportar e te mandar. Renderize o " +
        "frame, passe `path` para guardá-lo onde quiser, e use esse caminho em " +
        "`measure_image` e `crop_image`. Pedir um print à pessoa quando você mesmo pode " +
        "renderizar o frame é trabalho manual que a ferramenta existe para eliminar.",
      inputSchema: {
        compName: z.string().optional().describe("Composição. Omitido = a ativa."),
        time: z
          .number()
          .optional()
          .describe("Instante em segundos. Omitido = o tempo atual da timeline."),
        path: z
          .string()
          .optional()
          .describe(
            "Onde gravar o PNG. Omitido = pasta temporária, apagada depois de um tempo. " +
              "PASSE um caminho quando o frame for a referência de um trabalho longo: o " +
              "arquivo temporário pode ser limpo no meio, e aí a referência desaparece " +
              "com a reconstrução ainda em andamento."
          ),
      },
    },
    async (args) => {
      // ── Preto sólido não é resposta, é sintoma ──────────────────────────────
      // Os dois caminhos de render falham de formas diferentes. `saveFrameToPng` às vezes
      // retorna sem gravar nada — detectável na hora. A fila de render, num projeto com
      // footage de vídeo offline, entrega PRETO SÓLIDO: arquivo válido, tamanho normal,
      // imagem vazia. Esse é muito pior, porque passa por frame: quem medir cor nele
      // recebe respostas coerentes e a cena sai inteira escura.
      //
      // Já que os dois falham em situações diferentes, receber preto de um é motivo para
      // tentar o outro — não para devolver o preto.
      //
      // Timeout generoso: a fila de render abre progresso e leva bem mais que 60s.
      const renderizar = async (extra) => {
        const { result } = await call("save_frame", { ...args, ...extra }, { timeoutMs: 180_000 });
        const bytes = fs.readFileSync(result.path);
        return { result, bytes, uniforme: frameUniforme(bytes) };
      };

      let tentativa;
      let recuperado = null;

      try {
        tentativa = await renderizar({});
      } catch (err) {
        return asError(`Não consegui renderizar o frame: ${err.message}`);
      }

      if (tentativa.uniforme && tentativa.result.method === "renderQueue") {
        try {
          const direto = await renderizar({ method: "direct" });
          if (!direto.uniforme) {
            recuperado = tentativa.result.method;
            tentativa = direto;
          }
        } catch {
          // O caminho direto também não colou. Segue com o que se tem — o aviso de frame
          // uniforme abaixo explica o que a pessoa está vendo.
        }
      }

      const { result, bytes } = tentativa;
      const base64 = bytes.toString("base64");

      // ── Confere o tamanho contra a comp ────────────────────────────────────
      // O frame exportado é a régua de todas as medições feitas em cima dele. Se ele
      // sair menor que a comp, as medidas saem coerentes entre si e erradas por um
      // fator constante — e nada falha. A cena reconstruída fica proporcional e do
      // tamanho errado, sem um único aviso.
      //
      // A causa conhecida é `comp.resolutionFactor` em Half ou Third, o que o painel
      // agora força para Full durante o export. Este confronto existe para o caso de
      // haver outra causa: assim ele aparece como aviso, não como cena torta.
      const medidas = dimensoesPng(bytes);
      const divergente =
        medidas && (medidas.width !== result.width || medidas.height !== result.height);

      const uniforme = tentativa.uniforme;

      return {
        content: [
          {
            type: "text",
            text:
              (recuperado
                ? "A fila de render devolveu um frame vazio nesta comp, então usei " +
                  "saveFrameToPng e deu certo. Isso acontece em projeto com footage de " +
                  "vídeo offline, mesmo com as camadas desligadas. Vale passar " +
                  '`method: "direct"` nas próximas chamadas desta comp e poupar a ida à ' +
                  "fila.\n\n"
                : "") +
              (uniforme
                ? `ATENÇÃO: o frame saiu ${uniforme} — não há desenho nenhum nele.\n\n` +
                  "NÃO meça nada aqui e NÃO conclua nada sobre o resultado do que você " +
                  "construiu. Medir cor num frame vazio devolve respostas coerentes e " +
                  "erradas, e a cena sai com o desenho certo e a cor errada.\n\n" +
                  "Causas conhecidas, em ordem: o tempo pedido cai fora do intervalo da " +
                  "comp; a comp está vazia neste instante; as camadas estão desligadas. " +
                  "Confirme o instante com describe_project antes de renderizar de novo.\n\n"
                : "") +
              (divergente
                ? `ATENÇÃO: o PNG saiu ${medidas.width}×${medidas.height}, mas a comp é ` +
                  `${result.width}×${result.height}. NÃO meça nada neste frame: toda ` +
                  "medida sairia errada pelo mesmo fator, e o erro não apareceria em " +
                  "lugar nenhum até a cena estar construída no tamanho errado. " +
                  "Confira a resolução da composição (o seletor Full / Half / Third do " +
                  "painel de composição) e renderize de novo.\n\n"
                : "") +
              `${result.comp} · ${result.width}×${result.height} · t=${result.time}s\n` +
              // O caminho é o que permite medir e recortar em cima deste frame. Sem ele
              // na resposta, quem está do outro lado pede um print à pessoa — que é
              // exatamente o trabalho manual que esta ferramenta elimina.
              `Arquivo: ${result.path}` +
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
    "compare_images",
    {
      title: "Comparar referência e resultado",
      description:
        "Compara dois PNGs do mesmo tamanho e diz QUANTO e ONDE eles diferem. Use a " +
        "referência original e o frame renderizado da cena reconstruída.\n\n" +
        "Olhar as duas imagens responde bem \"está parecido?\" e mal \"o que falta?\". Cor " +
        "errada num elemento pequeno, ilustração deslocada, texto que saiu regular em vez " +
        "de bold — nada disso salta na tela, e é tudo o que costuma sair errado.\n\n" +
        "Devolve DUAS medidas, e a segunda é a que importa mais:\n\n" +
        "• ÁREA — proporção de pixels diferentes. Pesa tamanho: um tom levemente errado " +
        "num preenchimento grande domina este número.\n" +
        "• ESTRUTURA — proporção de bordas que não batem. Contorno, texto e ícone são " +
        "feitos de borda; preenchimento chapado não tem nenhuma. É esta que acompanha o " +
        "que uma pessoa chama de \"está errado\".\n\n" +
        "Aconteceu numa comparação real: a cena que o designer considerou boa marcou 21% " +
        "de área (texto duplicado quase alinhado, muitos pixels) e a que ele considerou " +
        "horrível marcou 13%, porque os defeitos dela eram um ícone trocado e um número " +
        "faltando. A ordem da área era o inverso da ordem da qualidade.\n\n" +
        "NENHUM dos dois é nota. Os dois localizam. Área alta com estrutura baixa é cor " +
        "ou tom; estrutura alta com área baixa é desenho errado — e essa é a que precisa " +
        "de conserto.\n\n" +
        "Também devolve um mapa por região dizendo onde a diferença se concentra, e " +
        "opcionalmente uma imagem com o que difere marcado em vermelho.",
      inputSchema: {
        reference: z.string().describe("PNG da referência original."),
        result: z.string().describe("PNG do resultado — normalmente o que save_frame gravou."),
        tolerance: z
          .number()
          .optional()
          .describe(
            "Diferença de cor que ainda conta como igual. Padrão 12, que absorve " +
              "compressão e suavização. Aumente se a referência for JPEG."
          ),
        diffOut: z
          .string()
          .optional()
          .describe(
            "Caminho para gravar a imagem de diferença: o resultado esmaecido com o que " +
              "difere em vermelho. Peça quando o número indicar que vale olhar."
          ),
      },
    },
    async ({ reference, result: caminhoResultado, tolerance, diffOut }) => {
      let ref;
      let res;

      try {
        ref = carregarPng(reference);
        res = carregarPng(caminhoResultado);
      } catch (err) {
        return asError(`Não consegui ler as imagens: ${err.message}`);
      }

      let r;
      try {
        r = compareImages(ref, res, { tolerance });
      } catch (err) {
        if (err instanceof CompareError) return asError(err.message);
        throw err;
      }

      // Ordenar por concentração é o que transforma o mapa em lista de suspeitos. Uma
      // grade inteira em ordem de leitura obrigaria quem lê a fazer essa ordenação.
      const suspeitos = r.blocks
        .filter((b) => b.ratio > 0.02)
        .sort((a, b) => b.ratio - a.ratio)
        .slice(0, 5)
        .map(
          (b) =>
            `  • ${Math.round(b.ratio * 100)}% em ${b.x},${b.y} ` +
            `(${b.width}×${b.height})`
        );

      let notaDiff = "";
      if (diffOut) {
        try {
          const bytes = encodePng(differenceImage(res, r), (x) =>
            new Uint8Array(zlib.deflateSync(Buffer.from(x)))
          );
          fs.writeFileSync(diffOut, bytes);
          notaDiff = `\n\nImagem de diferença: ${diffOut} (o que difere está em vermelho).`;
        } catch (err) {
          notaDiff = `\n\nNão consegui gravar a imagem de diferença: ${err.message}`;
        }
      }

      // Estrutura primeiro: é a que corresponde ao julgamento de quem olha. Área
      // primeiro faria a leitura errada parecer a principal, que foi o que aconteceu.
      const estrutura = r.edgeRatio * 100;
      const area = r.ratio * 100;

      const leitura =
        estrutura >= 8
          ? "ESTRUTURA ALTA: traço, texto ou ícone estão diferentes. É o tipo de erro que " +
            "uma pessoa nota, e o que precisa de conserto."
          : area >= 10
            ? "Estrutura baixa com área alta: o DESENHO bate e a COR ou o TOM não. Confira " +
              "paleta e opacidade antes de mexer em geometria."
            : "As duas medidas baixas — a reconstrução bate com a referência.";

      return asText(
        `Estrutura: ${estrutura.toFixed(1)}% das bordas não batem ` +
          `(${r.edgesDiffering} de ${r.edges}).\n` +
          `Área: ${area.toFixed(1)}% dos pixels diferem ` +
          `(${r.differing} de ${r.total}), tolerância ${tolerance ?? 12}.\n\n` +
          `${leitura}\n\n` +
          (suspeitos.length
            ? `Onde a diferença se concentra:\n${suspeitos.join("\n")}\n\n` +
              "Vá para a região de maior concentração primeiro: é lá que está o elemento " +
              "errado, e não no que está espalhado."
            : "A diferença está espalhada e diluída, sem região concentrada — " +
              "compatível com suavização e compressão, não com elemento errado.") +
          notaDiff
      );
    }
  );

  server.registerTool(
    "crop_image",
    {
      title: "Recortar uma parte da imagem",
      description:
        "Recorta uma região do frame de referência e grava um PNG. Use para o que NÃO se " +
        "reconstrói com formas.\n\n" +
        "Reconstruir com formas é o que dá editabilidade, e vale para cartão, barra, botão, " +
        "pílula, ícone de linha, texto — geometria. Não vale para ilustração orgânica: um " +
        "tênis desenhado à mão, um personagem, um braço robótico com garra, qualquer coisa " +
        "com dezenas de curvas e sombreados sobrepostos. Medir primitivas numa dessas " +
        "produz um borrão de formas coloridas, e o resultado é pior do que honesto — " +
        "parece tentativa.\n\n" +
        "O caminho devolvido vai direto em `source` de uma forma `image`. Assim a " +
        "ilustração fica com os pixels originais e o resto da cena continua vetor " +
        "editável, que é o que se anima.\n\n" +
        "MODO PREFERIDO: passe apenas `isolate` com um ponto dentro da ilustração, " +
        "`removeBackground: true` e `trim: true`, sem x/y/width/height. A ferramenta " +
        "trabalha na imagem inteira, mantém só o que está ligado ao seu ponto, e aperta " +
        "no resultado. Assim a própria ilustração define os limites e não há como " +
        "cortá-la — que é o erro que mais aparece quando o retângulo é medido a olho.",
      inputSchema: {
        path: z.string().describe("PNG de origem — o frame de referência."),
        x: z
          .number()
          .optional()
          .describe(
            "Canto superior esquerdo da região. OPCIONAL quando você passa `isolate`: sem " +
              "retângulo a ferramenta trabalha na imagem inteira e a própria ilustração " +
              "define os limites, o que elimina a chance de cortá-la."
          ),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        out: z
          .string()
          .optional()
          .describe(
            "Caminho do PNG a gravar. Omitido = ao lado da origem, com sufixo da região."
          ),
        removeBackground: z
          .boolean()
          .optional()
          .describe(
            "Deixa transparente o fundo chapado ligado à borda do recorte. USE quando a " +
              "ilustração vai por cima de algo reconstruído — sem isso o retângulo do " +
              "recorte tapa o que está atrás, e o defeito parece de ordem de camada. " +
              "Áreas internas da mesma cor do fundo são preservadas: o fundo é o que " +
              "está conectado à borda, não toda ocorrência daquela cor."
          ),
        backgroundTolerance: z
          .number()
          .optional()
          .describe("Quanto a cor pode variar e ainda contar como fundo. Padrão 10."),
        isolate: z
          .object({ x: z.number(), y: z.number() })
          .optional()
          .describe(
            "Um ponto DENTRO da ilustração. Mantém só o desenho ligado a ele e apaga " +
              "qualquer outra coisa que caiu no recorte.\n\n" +
              "USE quando a ilustração encosta em outro elemento do design — um ícone ao " +
              "lado, a borda de um cartão — e nenhum retângulo separa os dois: com folga " +
              "para não cortar a ilustração ele leva um pedaço do vizinho, apertado para " +
              "excluir o vizinho ele corta a ilustração.\n\n" +
              "Separa por conectividade, não por cor, então funciona mesmo quando o " +
              "vizinho tem exatamente a mesma tinta — o caso comum numa arte de paleta " +
              "fechada. Só faz efeito com removeBackground: true, porque opera sobre o " +
              "alfa que sobra depois do fundo sair.\n\n" +
              "As coordenadas são as da imagem de ORIGEM, o mesmo espaço de x/y/width/" +
              "height acima — não do recorte já cortado."
          ),
        trim: z
          .boolean()
          .optional()
          .describe(
            "Aperta o recorte na ilustração depois de tirar o fundo, e devolve as " +
              "coordenadas apertadas. Só encolhe. Útil quando você mediu com folga de " +
              "propósito — o que é a forma certa de medir, porque folga se tira e corte " +
              "não se recupera."
          ),
      },
    },
    async ({
      path: origem,
      x,
      y,
      width,
      height,
      out,
      removeBackground,
      backgroundTolerance,
      isolate,
      trim,
    }) => {
      let img;
      try {
        img = carregarPng(origem);
      } catch (err) {
        return asError(`Não consegui ler ${origem}: ${err.message}`);
      }

      // ── Sem retângulo, quando há semente ────────────────────────────────────
      // Medir o retângulo de uma ilustração olhando um frame é chute com régua, e errar
      // para dentro corta o desenho — foi o defeito que mais voltou. Com `isolate`, errar
      // para FORA deixou de custar: o vizinho é descartado por conectividade, não por
      // estar fora de um retângulo. Então o retângulo deixou de ser necessário: a imagem
      // inteira entra, a ilustração define os próprios limites, e não há como cortá-la.
      const semRetangulo =
        x == null && y == null && width == null && height == null && Boolean(isolate);

      let recorte;
      try {
        recorte = semRetangulo
          ? { ...img, x: 0, y: 0 }
          : cropImage(img, {
              x: x ?? 0,
              y: y ?? 0,
              width: width ?? img.width,
              height: height ?? img.height,
            });
      } catch (err) {
        return asError(err.message);
      }

      if (!semRetangulo && !isolate && (x == null || y == null || width == null || height == null)) {
        return asError(
          "Sem `isolate`, o recorte precisa de x, y, width e height. Com `isolate`, os " +
            "quatro podem ser omitidos e a ilustração define os próprios limites — é o " +
            "caminho preferido, porque não há como cortar o desenho."
        );
      }

      let recorteFinal = recorte;
      let fundo = null;
      let caixa = null;
      let isolamento = null;
      let posX = recorte.x;
      let posY = recorte.y;

      if (removeBackground) {
        fundo = removeFlatBackground(recorte, { tolerance: backgroundTolerance });
        recorteFinal = { width: fundo.width, height: fundo.height, data: fundo.data };

        if (isolate) {
          // A semente chega em coordenada da imagem de origem — o mesmo espaço de x/y —
          // e `isolateComponent` a quer em coordenada local do recorte. Converter aqui
          // evita que quem chama tenha de fazer essa subtração, que é onde ela erraria.
          try {
            const isolado = isolateComponent(recorteFinal, {
              x: Math.round(isolate.x) - recorte.x,
              y: Math.round(isolate.y) - recorte.y,
            });
            recorteFinal = { width: isolado.width, height: isolado.height, data: isolado.data };
            isolamento = isolado;
          } catch (err) {
            if (err instanceof CutoutError) {
              return asError(
                `isolate não deu: ${err.message}\n\n` +
                  "A semente é em coordenada da IMAGEM DE ORIGEM, a mesma de x/y. " +
                  `Este recorte cobre ${recorte.x},${recorte.y} até ` +
                  `${recorte.x + recorte.width},${recorte.y + recorte.height}.`
              );
            }
            throw err;
          }
        }

        caixa = contentBounds(recorteFinal);

        if (trim && !caixa.empty) {
          recorteFinal = trimTo(recorteFinal, caixa);
          posX = recorte.x + caixa.x;
          posY = recorte.y + caixa.y;
        }
      }

      const destino =
        out ??
        origem.replace(
          /\.png$/i,
          `-crop-${recorte.x}-${recorte.y}-${recorte.width}x${recorte.height}.png`
        );

      try {
        const bytes = encodePng(recorteFinal, (b) => new Uint8Array(zlib.deflateSync(Buffer.from(b))));
        fs.writeFileSync(destino, bytes);
      } catch (err) {
        return asError(`Recortei mas não consegui gravar em ${destino}: ${err.message}`);
      }

      // Avisar quando o pedido foi aparado importa: as coordenadas do recorte são as que
      // vão para a forma `image`, e usar as pedidas deixaria a ilustração deslocada.
      const aparado =
        recorte.width !== Math.round(width) || recorte.height !== Math.round(height);

      // Quanto do recorte virou transparente é a única forma de perceber, sem abrir o
      // arquivo, que a remoção de fundo pegou a coisa errada — quase tudo significa que a
      // ilustração foi junto; quase nada, que o fundo não era chapado.
      const proporcao = fundo ? fundo.removed / (recorte.width * recorte.height) : 0;

      // ── O aviso que faltava ─────────────────────────────────────────────────
      // Pixel opaco na borda do recorte significa que a ilustração continua além dele: o
      // recorte cortou o desenho. É erro que passa fácil — o arquivo abre, tem a
      // ilustração dentro, o fundo saiu direito, e só de perto se vê que falta um pedaço.
      // A essa altura a cena já está montada.
      const notaCorte =
        caixa && caixa.touches.length > 0 && !caixa.empty
          ? `\n\nATENÇÃO: sobrou desenho encostando na borda (${caixa.touches.join(", ")}). ` +
            "Isso quase sempre quer dizer que a ILUSTRAÇÃO FOI CORTADA — ela continua além " +
            "do recorte. Refaça com mais folga desse lado. Medir com folga é o certo: " +
            "folga se tira depois com `trim`, corte não se recupera."
          : "";

      // Quanto o isolamento descartou é o que revela semente no lugar errado: apagar
      // quase tudo significa que ela caiu num detalhe solto em vez de na ilustração.
      const notaIsolar = !isolamento
        ? ""
        : `\n\nIsolamento: ${isolamento.kept} pixels mantidos, ${isolamento.removed} ` +
          "descartados por não estarem ligados à semente." +
          (isolamento.kept < isolamento.removed / 4
            ? " ISSO É POUCO MANTIDO — a semente provavelmente caiu num detalhe solto e " +
              "não no corpo da ilustração. Aponte um ponto no meio da maior área dela."
            : "");

      const notaFundo = !fundo
        ? ""
        : `\n\nFundo ${fundo.color} removido: ${Math.round(proporcao * 100)}% do recorte ` +
          "virou transparente." +
          (proporcao > 0.9
            ? " ISSO É MUITO — provavelmente a ilustração foi removida junto. Tente de novo " +
              "com backgroundTolerance menor, ou sem remover o fundo."
            : proporcao < 0.02
              ? " ISSO É POUCO — o fundo pode não ser chapado, ou o recorte pode estar todo " +
                "dentro da ilustração. Confira olhando o arquivo antes de usar."
              : "");

      return asText(
        `Gravei ${destino} — ${recorte.width}×${recorte.height} em ${recorte.x},${recorte.y}.` +
          notaCorte +
          notaFundo +
          notaIsolar +
          (aparado
            ? `\n\nATENÇÃO: o recorte foi aparado na borda da imagem (você pediu ` +
              `${Math.round(width)}×${Math.round(height)}). Use as coordenadas e o tamanho ` +
              "ACIMA na forma `image`, não os que você pediu, senão a ilustração fica " +
              "deslocada."
            : "") +
          `\n\nUse em: { "shape": { "type": "image", "x": ${posX}, "y": ${posY}, ` +
          `"w": ${recorteFinal.width}, "h": ${recorteFinal.height}, "source": "${destino}" } }`
      );
    }
  );

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
        { tracks: resolvido.tracks, setups: resolvido.setups, options: { compName } },
        { timeoutMs: 120_000 }
      );

      const avisos = [...resolvido.warnings, ...(result.warnings ?? [])];

      return asText({
        ok: result.ok,
        comp: result.compName,
        trilhas: result.applied,
        keyframes: result.keyframes,
        mascaras: result.masks || undefined,
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
        "Nomeie comps e marcadores em inglês — só os nomes dentro do After Effects. " +
        "Continue conversando com o usuário no idioma dele.",
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
            "Duração do áudio em frames. Serve para avisar quando as cenas não cobrem o " +
              "áudio, e é OBRIGATÓRIA com fitToAudio. Pegue em describe_project: o item " +
              "de footage do áudio traz `duration` em segundos — multiplique por frameRate."
          ),
        fitToAudio: z
          .boolean()
          .optional()
          .describe(
            "Esticar ou encolher todas as cenas proporcionalmente para casar com o áudio. " +
              "Mantém o ritmo relativo entre elas. EXIGE audioDurationFrames."
          ),
        fit: z
          .enum(["contain", "cover", "none"])
          .optional()
          .describe(
            "Como encaixar uma cena de tamanho diferente do da master. contain (padrão): " +
              "cabe inteira, com tarja se a proporção não bater. cover: preenche o quadro " +
              "cortando o que sobra. none: entra em 100%, pixel a pixel. Cenas do mesmo " +
              "tamanho da master não são tocadas em nenhum dos modos."
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
    async ({ name, width, height, frameRate, audio, replace, fit, ...spec }) => {
      const fps = frameRate ?? 30;

      // Falhar antes de montar, e não avisar depois de montado. Uma master com o ritmo
      // errado parece pronta: as 54 cenas estão lá, na ordem certa, e só ouvindo é que
      // se percebe. Recusar aqui custa uma chamada; descobrir depois custa a montagem
      // inteira e a confiança no resultado.
      if (spec.fitToAudio && spec.audioDurationFrames == null) {
        return asError(
          "fitToAudio precisa de audioDurationFrames — sem ele não há com o que casar, e " +
            "a master sairia com as durações originais parecendo pronta.\n\n" +
            "Chame describe_project: o item de footage do áudio traz `duration` em " +
            "segundos. Multiplique por frameRate e passe o resultado."
        );
      }

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
            fit: fit ?? "contain",
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

  // ---------------------------------------------------------------- material pronto

  server.registerTool(
    "import_footage",
    {
      title: "Trazer um arquivo para dentro da comp",
      description:
        "Importa uma imagem ou um vídeo do disco e coloca como camada, enquadrado e no " +
        "tempo pedido. Serve para tudo que já existe pronto em arquivo: uma foto do " +
        "cliente, um recorte, um fundo, uma placa de vídeo.\n\n" +
        "**Esta ferramenta não gera nada.** Se o arquivo precisa ser criado, editado ou " +
        "ter o fundo removido, faça isso com as ferramentas que você já tem nesta " +
        "conversa, salve o resultado em disco, e traga o caminho para cá. Assim o " +
        "provedor pode mudar sem mudar nada aqui — e qual provedor é permitido varia por " +
        "empresa e por cliente. Se não houver nenhum ligado, diga isso em vez de " +
        "improvisar.\n\n" +
        "Sem retângulo, a caixa é a comp inteira — o caso do fundo e da placa de vídeo. " +
        "As coordenadas são as do canvas, origem no canto superior esquerdo.\n\n" +
        "Imagem parada dura o que você mandar. **Vídeo não estica**: pedir que ele cubra " +
        "uma comp mais longa encurta a camada, e a resposta diz de quanto ficou o buraco " +
        "em vez de deixar você descobrir renderizando.\n\n" +
        "O After Effects não importa SVG — use .ai, .eps, .pdf, ou PNG grande com " +
        "transparência.",
      inputSchema: {
        path: z.string().describe("Caminho completo do arquivo em disco."),
        compName: z.string().optional().describe("Composição. Omitido = a ativa."),
        name: z.string().optional().describe("Nome da camada. Padrão: o nome do arquivo."),
        x: z.number().optional().describe("Canto esquerdo da caixa, no canvas."),
        y: z.number().optional().describe("Topo da caixa, no canvas."),
        width: z.number().optional().describe("Largura da caixa."),
        height: z.number().optional().describe("Altura da caixa."),
        fit: z
          .enum(["contain", "cover", "stretch", "none"])
          .optional()
          .describe(
            "contain (padrão) cabe inteira na caixa; cover preenche e sobra fora; " +
              "stretch distorce; none mantém 100%."
          ),
        startFrame: z.number().int().optional().describe("Frame em que a camada começa. Padrão 0."),
        durationFrames: z
          .number()
          .int()
          .optional()
          .describe("Duração da camada em frames. Em vídeo, corta; nunca estica."),
        fillComp: z
          .boolean()
          .optional()
          .describe("A camada cobre a comp inteira, do início ao fim."),
        opacity: z.number().optional().describe("Opacidade 0-100. Padrão 100."),
        folderName: z
          .string()
          .optional()
          .describe("Pasta do projeto onde guardar o item importado. Criada se não existir."),
      },
    },
    async (args) => {
      const { result } = await call("import_footage", args, { timeoutMs: 120_000 });

      return asText({
        comp: result.comp,
        camada: result.layer,
        arquivo: result.source,
        jaEstavaNoProjeto: result.reused || undefined,
        enquadramento: result.placed,
        tempo: result.timing,
        avisos: result.warnings?.length ? result.warnings : undefined,
        proximoPasso:
          "Chame save_frame e olhe o enquadramento. O `fit` acerta a proporção, não a " +
          "intenção — sobra de fundo e corte na borda só aparecem vendo.",
      });
    }
  );

  // ---------------------------------------------------------------- arrumação

  /**
   * ── Por que estas três não são `execute_script` ─────────────────────────────
   * Renomear em lote, mudar duração, mover para pasta: mecânico, sem julgamento, e o
   * modelo acerta. Mas script escrito na hora erra de um jeito novo a cada vez, e o erro
   * aqui é do tipo que só aparece depois de salvar — a comp errada renomeada no meio de
   * 54. Ferramenta dedicada tem esquema, valida antes, e devolve o antes de cada item.
   *
   * Todas agem por `id`, que vem de `describe_project`. Nome não é único no After
   * Effects: com "SC01" e "SC01 old" no projeto, agir por nome é sorteio.
   */

  server.registerTool(
    "rename_items",
    {
      title: "Renomear comps, pastas, footage e camadas",
      description:
        "Renomeia itens do projeto (composições, pastas, arquivos importados) e camadas " +
        "dentro de uma composição, em lote.\n\n" +
        "Os `id` vêm de `describe_project` — chame antes. Aja sempre por `id`, nunca " +
        "montando o pedido a partir do nome: num projeto com \"SC01\" e \"SC01 old\", agir " +
        "por nome renomeia a errada, e quem pediu descobre folheando o projeto.\n\n" +
        "Pedidos como \"as comps desta pasta\" ou \"as que eu selecionei\" se resolvem " +
        "filtrando o `folder` e o `selected` que `describe_project` devolve. Se o pedido " +
        "era sobre a seleção e `selectedCount` vier zero, a seleção se perdeu — pergunte, " +
        "não renomeie o projeto inteiro.\n\n" +
        "Um item que falha não impede os outros: a resposta traz o que mudou e um aviso " +
        "para cada falha. Um Cmd+Z desfaz o lote inteiro.",
      inputSchema: {
        items: z
          .array(
            z.object({
              id: z.number().int().describe("O `id` do item, como veio de describe_project."),
              name: z.string().describe("Nome novo."),
            })
          )
          .optional()
          .describe("Itens do projeto: comps, pastas, footage."),
        layers: z
          .array(
            z.object({
              compName: z.string().describe("Composição onde a camada está."),
              layerIndex: z
                .number()
                .int()
                .describe("Índice da camada (1 = topo da timeline)."),
              name: z.string().describe("Nome novo."),
            })
          )
          .optional()
          .describe("Camadas dentro de composições."),
      },
    },
    async (args) => {
      if (!args.items?.length && !args.layers?.length) {
        return asError(
          "Informe pelo menos um item em `items` ou `layers`. Os `id` vêm de describe_project."
        );
      }

      const { result } = await call("rename_items", args);

      return asText({
        renomeados: result.count,
        // Aspas tipográficas em vez de retas: a resposta é JSON, e aspa reta sai
        // escapada com barra invertida no meio do nome — ilegível justamente na linha
        // que a pessoa precisa ler para conferir.
        mudancas: result.renamed.map((r) =>
          r.kind === "layer"
            ? `${r.comp} · camada ${r.index}: “${r.from}” → “${r.to}”`
            : `“${r.from}” → “${r.to}”`
        ),
        avisos: result.warnings?.length ? result.warnings : undefined,
        proximoPasso:
          "Mostre a lista de mudanças ao usuário — “renomeei 54 itens” não deixa " +
          "ninguém conferir. Os nomes só existem na memória do After Effects até " +
          "save_project rodar.",
      });
    }
  );

  server.registerTool(
    "set_comp_settings",
    {
      title: "Mudar as configurações de uma composição",
      description:
        "Muda nome, duração, frame rate ou tamanho de uma composição. Informe só o que " +
        "quer mudar; o resto fica como está.\n\n" +
        "Prefira o `id` (de `describe_project`) ao nome. A resposta traz o antes e o " +
        "depois de todos os campos, para conferir.\n\n" +
        "Encurtar a duração não apaga camada: o After Effects deixa as camadas onde " +
        "estão e elas passam a existir fora do intervalo visível — a comp parece ter " +
        "perdido conteúdo sem nenhum aviso. A resposta conta quantas camadas ficaram " +
        "fora em `layersOutOfRange`; se vier maior que zero, diga isso ao usuário.",
      inputSchema: {
        id: z.number().int().optional().describe("O `id` da comp. Preferível ao nome."),
        compName: z
          .string()
          .optional()
          .describe("Nome da comp, se não tiver o id. Omitir os dois usa a comp ativa."),
        name: z.string().optional().describe("Nome novo."),
        durationSeconds: z.number().optional().describe("Duração nova, em segundos."),
        frameRate: z.number().optional().describe("Frames por segundo."),
        width: z.number().int().optional().describe("Largura em pixels."),
        height: z.number().int().optional().describe("Altura em pixels."),
      },
    },
    async (args) => {
      const { result } = await call("set_comp_settings", args);

      return asText({
        comp: result.comp,
        mudou: result.changed,
        antes: result.before,
        depois: result.after,
        camadasForaDoIntervalo: result.layersOutOfRange || undefined,
        aviso:
          result.layersOutOfRange > 0
            ? `${result.layersOutOfRange} camada(s) começam depois do fim da comp e ` +
              "não aparecem mais. Nada foi apagado — avise o usuário, porque na tela " +
              "isso parece conteúdo perdido."
            : undefined,
      });
    }
  );

  server.registerTool(
    "move_to_folder",
    {
      title: "Mover itens para uma pasta",
      description:
        "Move comps, pastas e arquivos importados para uma pasta do projeto, criando a " +
        "pasta se ela não existir. Os `id` vêm de `describe_project`.\n\n" +
        "A resposta diz de onde cada item saiu e se a pasta foi criada agora — útil " +
        "quando o nome tem um erro de digitação e a pasta \"não existia\".",
      inputSchema: {
        folderName: z
          .string()
          .describe("Nome da pasta destino. Criada se não existir."),
        itemIds: z
          .array(z.number().int())
          .describe("Os `id` dos itens a mover, como vieram de describe_project."),
      },
    },
    async (args) => {
      if (!args.itemIds?.length) {
        return asError("Informe os `itemIds`. Eles vêm de describe_project.");
      }

      const { result } = await call("move_to_folder", args);

      return asText({
        pasta: result.folder,
        pastaCriadaAgora: result.created || undefined,
        movidos: result.count,
        itens: result.moved.map((m) => `${m.name} (de ${m.from ?? "raiz do projeto"})`),
        avisos: result.warnings?.length ? result.warnings : undefined,
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
