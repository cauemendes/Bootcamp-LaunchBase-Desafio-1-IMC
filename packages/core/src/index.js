/**
 * @vectorize-ae/core — lógica portátil, sem dependência do host.
 *
 * Nada aqui sabe que CEP, ExtendScript ou After Effects existem. É de propósito:
 * quando o painel migrar pra UXP, este pacote vai junto sem mudança.
 */

export {
  normalizeHex,
  hexToRgb255,
  rgb255ToHex,
  hexToAeColor,
  colorDistance,
  quantizePalette,
} from "./color.js";

export { parsePathData, subpathsBounds } from "./svg-path.js";

export {
  SCENE_SPEC_VERSION,
  validateScene,
  normalizeScene,
  shapeBounds,
} from "./scene-spec.js";

export { readImageInfo, toBase64, SUPPORTED_MEDIA_TYPES } from "./image-info.js";

export { PngError, decodePng } from "./png.js";
export { DEFAULT_TOLERANCE, measureRegion, sampleColor, scanLine } from "./measure.js";

export {
  AnimError,
  DEFAULT_EASE,
  EASINGS,
  PRESETS,
  resolveAnimation,
} from "./anim.js";

export {
  DEFAULT_FALLBACK_FONT,
  DEFAULT_SNAP_TOLERANCE,
  applyBrand,
  brandSummary,
  validateBrand,
} from "./brand.js";

export { SCENE_SCHEMA, SHAPE_SCHEMA } from "./ai/schema.js";
export { SYSTEM_PROMPT, buildUserPrompt } from "./ai/prompt.js";
export { createClient, analyzeImage, AnalysisError, DEFAULT_MODEL } from "./ai/client.js";
