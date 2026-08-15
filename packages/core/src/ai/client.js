/**
 * Cliente da API do Claude para análise de imagem → SceneSpec.
 *
 * Roda em Node (CLI, testes) e dentro do painel CEP, que é um Chromium com Node
 * habilitado. No painel o SDK precisa de `dangerouslyAllowBrowser` porque detecta
 * ambiente de browser; ali isso é seguro — a chave fica no processo local do
 * usuário, não numa página web servida a terceiros.
 */

import Anthropic from "@anthropic-ai/sdk";

import { SCENE_SCHEMA } from "./schema.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt.js";
import { validateScene } from "../scene-spec.js";
import { SUPPORTED_MEDIA_TYPES } from "../image-info.js";

export const DEFAULT_MODEL = "claude-opus-5";

/** Erro com contexto suficiente pro painel mostrar algo útil em vez de "falhou". */
export class AnalysisError extends Error {
  constructor(message, { kind, detail } = {}) {
    super(message);
    this.name = "AnalysisError";
    this.kind = kind ?? "unknown";
    this.detail = detail;
  }
}

export function createClient({ apiKey, allowBrowser = false, ...rest } = {}) {
  if (!apiKey) {
    throw new AnalysisError(
      "Chave da API não configurada. No painel, abra Ajustes e cole sua chave da Anthropic.",
      { kind: "no-api-key" }
    );
  }
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: allowBrowser, ...rest });
}

/**
 * Analisa uma imagem e devolve um SceneSpec flat.
 *
 * @param {object} params
 * @param {string} params.imageBase64   imagem em base64, sem prefixo data:
 * @param {string} params.mediaType     "image/png" | "image/jpeg" | "image/gif" | "image/webp"
 * @param {number} params.width         largura real em pixels
 * @param {number} params.height        altura real em pixels
 * @param {string} [params.hints]       instruções livres do usuário
 * @param {string} [params.model]
 * @param {"low"|"medium"|"high"|"xhigh"|"max"} [params.effort="high"]
 * @param {number} [params.maxTokens=16000]
 * @param {Anthropic} params.client
 * @param {AbortSignal} [params.signal]
 *
 * @returns {Promise<{ scene: object, validation: object, usage: object, model: string }>}
 */
export async function analyzeImage({
  client,
  imageBase64,
  mediaType,
  width,
  height,
  hints,
  model = DEFAULT_MODEL,
  effort = "high",
  maxTokens = 16000,
  signal,
}) {
  if (!client) throw new AnalysisError("analyzeImage precisa de um client", { kind: "usage" });
  if (!imageBase64) throw new AnalysisError("analyzeImage precisa de imageBase64", { kind: "usage" });
  if (!SUPPORTED_MEDIA_TYPES.has(mediaType)) {
    throw new AnalysisError(
      `Tipo de imagem não suportado pela API: ${mediaType}. Use PNG, JPEG, GIF ou WebP.`,
      { kind: "unsupported-media-type" }
    );
  }

  let response;
  try {
    response = await client.beta.messages.create(
      {
        model,
        max_tokens: maxTokens,
        system: SYSTEM_PROMPT,
        // Classificadores de segurança podem recusar uma requisição no Opus 5. Com
        // fallbacks server-side a chamada é reservida por um modelo alternativo em
        // vez de simplesmente parar.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: {
          effort,
          format: { type: "json_schema", schema: SCENE_SCHEMA },
        },
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
              { type: "text", text: buildUserPrompt({ width, height, hints }) },
            ],
          },
        ],
      },
      { signal }
    );
  } catch (err) {
    throw wrapApiError(err);
  }

  if (response.stop_reason === "refusal") {
    throw new AnalysisError(
      "O modelo recusou analisar esta imagem." +
        (response.stop_details?.explanation ? ` Motivo: ${response.stop_details.explanation}` : ""),
      { kind: "refusal", detail: response.stop_details }
    );
  }

  if (response.stop_reason === "max_tokens") {
    throw new AnalysisError(
      `A descrição da cena passou do limite de ${maxTokens} tokens e saiu cortada. ` +
        "Este design tem elementos demais para uma passada só — recorte a imagem em " +
        "regiões e analise uma de cada vez, ou aumente maxTokens.",
      { kind: "truncated", detail: { maxTokens, usage: response.usage } }
    );
  }

  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) {
    throw new AnalysisError("A resposta não trouxe nenhum bloco de texto", {
      kind: "empty-response",
      detail: { stopReason: response.stop_reason },
    });
  }

  let scene;
  try {
    scene = JSON.parse(text);
  } catch (err) {
    // Com output_config.format isso não deveria acontecer; se acontecer, é sinal
    // de algo mais fundo do que "o modelo escorregou no formato".
    throw new AnalysisError(`A resposta não é JSON válido: ${err.message}`, {
      kind: "bad-json",
      detail: { text: text.slice(0, 500) },
    });
  }

  const validation = validateScene(scene);

  return {
    scene,
    validation,
    usage: response.usage,
    model: response.model,
  };
}

function wrapApiError(err) {
  const status = err?.status;

  if (err?.name === "AbortError") {
    return new AnalysisError("Análise cancelada.", { kind: "aborted" });
  }
  if (status === 401) {
    return new AnalysisError("Chave da API inválida ou revogada.", { kind: "auth", detail: err });
  }
  if (status === 429) {
    return new AnalysisError(
      "Limite de requisições atingido. Espere alguns instantes e tente de novo.",
      { kind: "rate-limit", detail: err }
    );
  }
  if (status === 413) {
    return new AnalysisError(
      "A imagem é grande demais para a requisição. Reduza a resolução antes de analisar.",
      { kind: "too-large", detail: err }
    );
  }
  if (typeof status === "number" && status >= 500) {
    return new AnalysisError("A API está indisponível no momento. Tente de novo em instantes.", {
      kind: "server",
      detail: err,
    });
  }

  return new AnalysisError(err?.message ?? String(err), { kind: "api", detail: err });
}
