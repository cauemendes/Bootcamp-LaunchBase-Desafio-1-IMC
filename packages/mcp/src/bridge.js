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
   * O que o heartbeat diz sobre o painel.
   *
   * Um timeout tem dois significados muito diferentes — "o painel não está aberto" e
   * "o painel está aberto e falhou ao responder" — e a mensagem genérica manda o
   * usuário conferir justamente o que já está certo. O heartbeat separa os dois casos
   * sem custo: é um arquivo que o painel reescreve a cada 2s.
   */
  #diagnose() {
    let dados;
    try {
      dados = JSON.parse(fs.readFileSync(path.join(this.dir, "heartbeat.json"), "utf8"));
    } catch {
      return "O painel nunca deu sinal de vida nesta pasta — provavelmente não está aberto.";
    }

    const idade = (Date.now() - dados.at) / 1000;

    if (idade > 15) {
      return `O último sinal do painel foi há ${Math.round(idade)}s: ele foi fechado, está ` +
        "em “parado”, ou o After Effects está com uma janela de diálogo aberta na frente " +
        "(o polling não roda enquanto há diálogo modal).";
    }

    return `O painel ESTÁ vivo (sinal há ${idade.toFixed(1)}s, After Effects ${dados.afterEffects}) — ` +
      "então ele recebeu o comando e falhou ao gravar a resposta. O log do painel, dentro " +
      "do After Effects, mostra o erro exato.";
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
