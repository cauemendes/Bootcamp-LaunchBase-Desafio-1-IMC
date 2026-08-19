/**
 * Cliente da ponte: manda comando pro After Effects e espera o resultado.
 *
 * O polling é adaptativo — começa rápido (a maioria dos comandos de leitura volta
 * em menos de meio segundo) e vai desacelerando. Um intervalo fixo curto queima CPU
 * à toa num comando demorado; um fixo longo faz toda leitura parecer lenta.
 */

import fs from "node:fs";
import path from "node:path";

import {
  PANEL_BUILD_ESPERADO,
  clearStale,
  commandPath,
  consumeJson,
  ensureBridgeDirs,
  fallbackResultPath,
  newCommandId,
  resolveBridgeDir,
  resultPath,
  writeJsonAtomic,
} from "./protocol.js";

export class BridgeError extends Error {
  constructor(message, { kind, detail } = {}) {
    super(message);
    this.name = "BridgeError";
    this.kind = kind ?? "unknown";
    this.detail = detail;
  }
}

const NOT_RUNNING_HINT =
  "O After Effects não respondeu. Confirme que:\n" +
  "  1. o After Effects está aberto;\n" +
  "  2. o painel está aberto em Window → Vectorize AE Bridge;\n" +
  "  3. o painel mostra “ouvindo”.\n" +
  "Se o painel não aparecer no menu Window, o arquivo bridge-panel.jsx precisa " +
  "estar na pasta ScriptUI Panels do After Effects.";

export class Bridge {
  /**
   * @param {object} [options]
   * @param {string} [options.dir]         pasta da ponte
   * @param {number} [options.timeoutMs]   tempo máximo por comando
   */
  constructor({ dir, timeoutMs = 30_000 } = {}) {
    this.dir = ensureBridgeDirs(dir ?? resolveBridgeDir());
    this.timeoutMs = timeoutMs;
  }

  /** Limpa restos de sessões anteriores. Chame uma vez ao subir o servidor. */
  cleanup(maxAgeMs) {
    return clearStale(this.dir, maxAgeMs);
  }

  /**
   * Executa um comando no After Effects.
   *
   * @param {string} tool             nome da ferramenta, como o painel conhece
   * @param {object} [args]
   * @param {object} [options]
   * @param {number} [options.timeoutMs] sobrescreve o timeout para este comando
   * @returns {Promise<any>} o campo `result` devolvido pelo painel
   */
  async call(tool, args = {}, { timeoutMs } = {}) {
    const id = newCommandId();
    const limit = timeoutMs ?? this.timeoutMs;

    writeJsonAtomic(commandPath(this.dir, id), { id, tool, args, sentAt: Date.now() });

    const response = await this.#awaitResult(id, limit, tool);

    if (!response.ok) {
      throw new BridgeError(response.error || `A ferramenta "${tool}" falhou no After Effects.`, {
        kind: "tool-error",
        detail: { tool, warnings: response.warnings },
      });
    }

    return { result: response.result, warnings: response.warnings ?? [] };
  }

  async #awaitResult(id, limit, tool) {
    const deadline = Date.now() + limit;

    // Dois lugares porque o painel tem dois: `res/<id>.json` é o normal, e a raiz é
    // o plano B de quando a subpasta recusa a escrita. Ver `fallbackResultPath`.
    const alvos = [resultPath(this.dir, id), fallbackResultPath(this.dir, id)];

    // Sobe de 50ms até 500ms. Leitura simples volta na primeira ou segunda tentativa;
    // um build de cena grande não fica martelando o disco.
    let interval = 50;

    while (Date.now() < deadline) {
      for (const alvo of alvos) {
        const payload = consumeJson(alvo, { tolerateIncomplete: true });
        if (payload) return payload;
      }

      await sleep(interval);
      interval = Math.min(interval * 1.4, 500);
    }

    // O comando pode ter sido pego e estar rodando — deixar o arquivo faria o painel
    // executar uma ação que ninguém está mais esperando.
    this.#discardCommand(id);

    throw new BridgeError(
      `A ferramenta "${tool}" não respondeu em ${Math.round(limit / 1000)}s.\n\n` +
        `${this.#diagnose()}\n\n${NOT_RUNNING_HINT}`,
      { kind: "timeout", detail: { tool, timeoutMs: limit } }
    );
  }

  /**
   * Estado do painel, lido do heartbeat.
   *
   * Público porque `check_bridge` precisa disto. A versão anterior tinha este
   * diagnóstico e o descartava: a ferramenta capturava a exceção e devolvia um
   * genérico "a ponte não respondeu". Numa execução noturna isso custou oito horas de
   * tentativas contra um painel que estava aberto e havia parado de escutar — a
   * informação existia e não chegava a quem precisava dela.
   *
   * @returns {{state: string, message: string, heartbeat: object|null}}
   */
  diagnose() {
    let dados;
    try {
      dados = JSON.parse(fs.readFileSync(path.join(this.dir, "heartbeat.json"), "utf8"));
    } catch {
      return {
        state: "sem-sinal",
        heartbeat: null,
        message:
          "O painel nunca deu sinal de vida nesta pasta. Provavelmente não está aberto, " +
          "ou o After Effects não está rodando.\n\n" +
          "AÇÃO: no After Effects, abra Window → bridge-panel.jsx e confirme que mostra " +
          "“ouvindo”. Se já estiver aberto, clique em Parar e depois Iniciar.",
      };
    }

    const idade = (Date.now() - dados.at) / 1000;

    // ── Isto vem antes de todo o resto ──────────────────────────────────────────
    // Painel desatualizado invalida qualquer outro diagnóstico: o defeito que se está
    // investigando pode já estar corrigido no disco e não estar rodando, porque a engine
    // do After Effects só relê o arquivo do painel quando o aplicativo sobe. Sem este
    // aviso, a conclusão natural diante de um defeito reincidente é "a correção está
    // errada" — e já foi falsa uma vez.
    const build = typeof dados.build === "number" ? dados.build : 0;

    if (build !== PANEL_BUILD_ESPERADO) {
      return {
        state: "desatualizado",
        heartbeat: dados,
        message:
          `O painel instalado no After Effects é o build ${build || "antigo (sem marca)"}, ` +
          `e este servidor espera o build ${PANEL_BUILD_ESPERADO}.\n\n` +
          "Enquanto isso não bater, qualquer defeito observado pode já estar corrigido no " +
          "código e simplesmente não estar rodando. NÃO investigue o comportamento nem " +
          "tente contornar: o resultado não diz nada sobre o código atual.\n\n" +
          "AÇÃO: peça para reinstalar o painel e REINICIAR o After Effects. Copiar o " +
          "arquivo com o aplicativo aberto não troca o código em execução — a engine só " +
          "relê o painel quando o After Effects sobe.",
      };
    }

    // Desligado no botão. Estado normal, e o conselho é o mais simples de todos —
    // que só ajuda se não vier embrulhado no alarme de "travou".
    if (dados.running === false) {
      // A ponte se pausa sozinha quando bloqueios seguidos mostram que o After Effects
      // está sendo usado — outro script com janela aberta, por exemplo. Mandar "clique
      // em Iniciar" aqui é o oposto do que a situação pede: significaria voltar a
      // atrapalhar quem está trabalhando.
      if (dados.pausadaPorBloqueio) {
        return {
          state: "pausada",
          heartbeat: dados,
          message:
            "A ponte se PAUSOU sozinha: o After Effects estava sendo usado por outro " +
            "script, ou com uma janela esperando resposta, e cada verificação dela " +
            "virava um erro na tela.\n\n" +
            "Isto não é defeito e não é para você resolver reiniciando nada. Significa " +
            "que há uma pessoa usando o After Effects agora.\n\n" +
            "AÇÃO: pare e avise que a ponte está pausada, e que basta clicar em Iniciar " +
            "no painel quando o After Effects estiver livre. NÃO fique tentando.",
        };
      }

      return {
        state: "desligado",
        heartbeat: dados,
        message:
          "O painel está aberto e a ponte está PARADA no botão — não travou, foi " +
          "desligada.\n\nAÇÃO: clique em Iniciar no painel Vectorize AE Bridge.",
      };
    }

    if (idade > 15) {
      // Quanto tempo a ponte viveu antes de congelar é o que diz *onde* olhar.
      // Congelar poucos segundos depois de iniciar é a assinatura de um diálogo do
      // After Effects na subida ou na abertura do projeto: enquanto ele está na tela,
      // a thread principal está bloqueada e nenhuma tarefa agendada roda.
      const uptime = typeof dados.uptime === "number" ? dados.uptime / 1000 : null;
      const morreuNaSubida = uptime !== null && uptime < 30;

      return {
        state: "parado",
        heartbeat: dados,
        message:
          `O painel está no projeto mas PAROU de escutar há ${Math.round(idade)}s ` +
          `(${dados.cycles ?? "?"} ciclos` +
          (uptime !== null ? `, ${uptime.toFixed(1)}s de vida antes de congelar` : "") +
          ").\n\n" +
          (morreuNaSubida
            ? "A ponte congelou poucos segundos depois de começar. Isso é quase sempre um " +
              "DIÁLOGO do After Effects na tela: erro na abertura do projeto, fonte " +
              "faltando, footage ausente. Enquanto o diálogo está aberto a thread " +
              "principal do AE fica bloqueada, e NENHUMA tarefa agendada roda — o " +
              "polling do painel inclusive.\n\n" +
              "Por isso Parar → Iniciar não resolve neste caso: o clique agenda a tarefa, " +
              "e a tarefa não roda enquanto o diálogo não sair da tela.\n\n" +
              "AÇÃO, nesta ordem: (1) traga o After Effects para a frente e feche todo " +
              "diálogo aberto, inclusive atrás da janela principal; (2) só então clique em " +
              "Parar e Iniciar no painel."
            : "O After Effects pode estar com um diálogo modal na frente, ou o painel foi " +
              "fechado.\n\nAÇÃO: traga o After Effects para a frente e veja se há uma " +
              "janela de diálogo esperando resposta. Depois clique em Parar e Iniciar no " +
              "painel.") +
          "\n\nNÃO fique tentando de novo em silêncio: sem alguém mexer no After Effects, " +
          "isto não se resolve sozinho. Avise quem está acompanhando.",
      };
    }

    // Em recuo, a ponte pode levar um ciclo inteiro só para notar o arquivo de comando.
    // Sem dizer isto, um timeout durante o recuo parece ponte morta e manda reiniciar
    // um painel que está funcionando — só devagar, de propósito.
    const emRecuo = typeof dados.intervalo === "number" && dados.intervalo > 4_000;

    return {
      state: "vivo",
      heartbeat: dados,
      message:
        `O painel ESTÁ escutando (sinal há ${idade.toFixed(1)}s, After Effects ` +
        `${dados.afterEffects}, ${dados.cycles ?? "?"} ciclos` +
        (dados.revivals ? `, ${dados.revivals} reanimações do polling` : "") +
        ")" +
        (emRecuo
          ? `, mas em RECUO: ${(dados.intervalo / 1000).toFixed(0)}s entre verificações, ` +
            "porque algo bloqueou o After Effects. Um comando pode demorar esse tempo só " +
            "para ser notado — tente de novo com timeout maior antes de concluir que " +
            "há defeito, e considere que pode haver alguém usando o After Effects agora."
          : " — então ele recebeu o comando e falhou ao responder. O log do painel, " +
            "dentro do After Effects, mostra o erro exato."),
    };
  }

  #diagnose() {
    return this.diagnose().message;
  }

  #discardCommand(id) {
    try {
      consumeJson(commandPath(this.dir, id));
    } catch {
      // Já consumido pelo painel; nada a fazer.
    }
  }

  /**
   * Verifica se o painel está vivo. Timeout curto de propósito: isso é uma pergunta
   * de "tem alguém aí?", não de trabalho — esperar 30s por um ping não ajuda ninguém.
   */
  async isAlive({ timeoutMs = 3_000 } = {}) {
    try {
      await this.call("ping", {}, { timeoutMs });
      return true;
    } catch {
      return false;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
