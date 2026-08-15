/**
 * Painel Vectorize AE.
 *
 * Fluxo: escolher imagem → analisar com o Claude → revisar o SceneSpec → construir
 * no After Effects.
 *
 * A revisão no meio é intencional. A análise custa dinheiro e leva alguns segundos;
 * jogar as camadas direto na comp sem o designer ver quantos elementos vieram e
 * quais avisos apareceram faz com que erros só sejam descobertos depois de sujar o
 * projeto. Com o passo de revisão dá pra reanalisar com outra dica antes de gastar
 * um undo.
 */

import {
  analyzeImage,
  createClient,
  normalizeScene,
  readImageInfo,
  toBase64,
  AnalysisError,
  DEFAULT_MODEL,
} from "@vectorize-ae/core";

import {
  evalScriptJson,
  getSystemPath,
  isInsideHost,
  jsxString,
  nodeRequire,
} from "./cep-bridge.js";

const STORAGE_KEY = "vectorize-ae.settings";

const state = {
  image: null,      // { bytes, info, base64, name }
  scene: null,      // SceneSpec flat
  validation: null,
  busy: false,
};

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------- ajustes

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function saveSettings(patch) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadSettings(), ...patch }));
}

// ---------------------------------------------------------------- UI

function setStatus(message, kind = "info") {
  const node = el("status");
  node.textContent = message;
  node.className = `status status--${kind}`;
}

function setBusy(busy, message) {
  state.busy = busy;
  document.body.classList.toggle("is-busy", busy);
  el("analyze").disabled = busy || !state.image;
  el("build").disabled = busy || !state.scene;
  if (message) setStatus(message, "info");
}

function renderReport() {
  const box = el("report");

  if (!state.scene) {
    box.innerHTML = "";
    box.hidden = true;
    return;
  }

  const counts = new Map();
  for (const element of state.scene.elements) {
    counts.set(element.shape.type, (counts.get(element.shape.type) ?? 0) + 1);
  }

  const breakdown = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${n} ${type}`)
    .join(" · ");

  const issues = [
    ...state.validation.errors.map((m) => ({ level: "error", m })),
    ...state.validation.warnings.map((m) => ({ level: "warn", m })),
  ];

  box.hidden = false;
  box.innerHTML = `
    <div class="report__summary">
      <strong>${state.scene.elements.length} elementos</strong>
      <span>${breakdown}</span>
      <span>paleta: ${state.scene.palette.length} cores</span>
    </div>
    ${
      issues.length === 0
        ? '<p class="report__clean">Nenhum problema encontrado.</p>'
        : `<ul class="report__issues">${issues
            .map((i) => `<li class="is-${i.level}">${escapeHtml(i.m)}</li>`)
            .join("")}</ul>`
    }
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---------------------------------------------------------------- imagem

async function onImageChosen(file) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const info = readImageInfo(bytes);

    state.image = { bytes, info, base64: toBase64(bytes), name: file.name };
    state.scene = null;
    state.validation = null;

    el("preview").src = URL.createObjectURL(file);
    el("preview").hidden = false;
    el("image-meta").textContent = `${file.name} — ${info.width} × ${info.height}`;

    renderReport();
    setBusy(false, "Imagem carregada. Analise para gerar as camadas.");
  } catch (err) {
    state.image = null;
    setBusy(false);
    setStatus(err.message, "error");
  }
}

// ---------------------------------------------------------------- análise

async function onAnalyze() {
  const settings = loadSettings();

  if (!settings.apiKey) {
    setStatus("Cole sua chave da API da Anthropic em Ajustes antes de analisar.", "error");
    el("settings").open = true;
    return;
  }

  setBusy(true, "Analisando a imagem…");

  try {
    const client = createClient({ apiKey: settings.apiKey, allowBrowser: true });

    const { scene, validation, usage, model } = await analyzeImage({
      client,
      imageBase64: state.image.base64,
      mediaType: state.image.info.mediaType,
      width: state.image.info.width,
      height: state.image.info.height,
      hints: el("hints").value,
      model: settings.model || DEFAULT_MODEL,
      effort: el("effort").value,
    });

    state.scene = scene;
    state.validation = validation;
    renderReport();

    const tokens = (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
    setBusy(false, `Análise concluída com ${model} — ${tokens.toLocaleString("pt-BR")} tokens.`);

    if (!validation.ok) {
      setStatus("A cena tem erros que impedem a construção. Veja a lista abaixo.", "error");
    }
  } catch (err) {
    setBusy(false);
    setStatus(err instanceof AnalysisError ? err.message : `Falha inesperada: ${err.message}`, "error");
  }
}

// ---------------------------------------------------------------- construção

async function onBuild() {
  if (!state.validation?.ok) {
    setStatus("Corrija os erros da cena antes de construir.", "error");
    return;
  }

  setBusy(true, "Construindo no After Effects…");

  try {
    const normalized = normalizeScene(state.scene, { layerMode: el("layer-mode").value });

    const payload = {
      scene: normalized,
      options: {
        compName: state.image.name.replace(/\.[^.]+$/, ""),
        gamma: el("linear-gamma").checked ? 2.2 : 1,
        recenterAnchors: el("recenter").checked,
        reuseComp: el("reuse-comp").checked,
      },
    };

    const specPath = writeSceneFile(payload);
    const result = await evalScriptJson(`vecBuildSceneFromFile(${jsxString(specPath)})`);

    if (!result.ok) {
      setBusy(false);
      setStatus(result.error, "error");
      return;
    }

    setBusy(false);
    const warnCount = result.warnings?.length ?? 0;
    setStatus(
      `"${result.compName}" criada com ${result.layerCount} camadas` +
        (warnCount ? ` — ${warnCount} aviso(s), veja abaixo.` : "."),
      warnCount ? "warn" : "ok"
    );

    if (warnCount) {
      state.validation = { ...state.validation, warnings: [...state.validation.warnings, ...result.warnings] };
      renderReport();
    }
  } catch (err) {
    setBusy(false);
    setStatus(err.message, "error");
  }
}

/**
 * Escreve o SceneSpec num arquivo temporário e devolve o caminho.
 *
 * Por que arquivo em vez de passar o JSON dentro da string do evalScript: uma cena
 * densa vira dezenas de milhares de caracteres, e a ponte do CEP não é confiável
 * com strings desse tamanho. Passar um caminho é curto e previsível.
 *
 * O escape de U+2028/U+2029 não é preciosismo: são caracteres válidos em JSON mas
 * inválidos dentro de um literal de string em ExtendScript, que é ES3. O
 * build-scene.jsx lê o arquivo e avalia o conteúdo — sem esse escape, um texto do
 * design com separador de linha Unicode derrubaria o eval.
 */
function writeSceneFile(payload) {
  const fs = nodeRequire("fs");
  const path = nodeRequire("path");
  const os = nodeRequire("os");

  const json = JSON.stringify(payload)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vectorize-ae-"));
  const file = path.join(dir, "scene.json");
  fs.writeFileSync(file, json, "utf8");

  return file;
}

// ---------------------------------------------------------------- boot

function boot() {
  const settings = loadSettings();
  el("api-key").value = settings.apiKey ?? "";
  el("model").value = settings.model ?? DEFAULT_MODEL;

  el("api-key").addEventListener("change", (e) => saveSettings({ apiKey: e.target.value.trim() }));
  el("model").addEventListener("change", (e) => saveSettings({ model: e.target.value.trim() }));

  el("file").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) onImageChosen(file);
  });

  el("analyze").addEventListener("click", onAnalyze);
  el("build").addEventListener("click", onBuild);

  // Arrastar a imagem direto pro painel é como um designer espera trabalhar.
  const drop = el("dropzone");
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("is-over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("is-over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("is-over");
    const file = e.dataTransfer?.files?.[0];
    if (file) onImageChosen(file);
  });

  if (isInsideHost()) {
    setStatus("Arraste uma imagem ou clique para escolher.", "info");
  } else {
    setStatus("Painel aberto fora do After Effects — a construção não vai funcionar.", "warn");
  }

  // Só para aparecer no console de debug quando algo estranho acontecer.
  if (isInsideHost()) {
    console.log("Extensão em:", getSystemPath("extension"));
  }
}

document.addEventListener("DOMContentLoaded", boot);
