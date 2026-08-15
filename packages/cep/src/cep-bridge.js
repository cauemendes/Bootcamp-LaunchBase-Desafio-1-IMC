/**
 * Ponte mínima com o host CEP.
 *
 * O `CSInterface.js` que a Adobe distribui é, no essencial, um wrapper em volta do
 * objeto global `window.__adobe_cep__` que o runtime injeta no painel. Este arquivo
 * implementa só a parte que o projeto usa, o que evita carregar ~900 linhas de
 * biblioteca — e deixa explícito onde exatamente o código toca o CEP, que é a
 * fronteira a refazer quando a migração pra UXP acontecer.
 *
 * Se em algum momento for preciso mais superfície (eventos, temas, janelas), dá pra
 * dropar o CSInterface.js oficial em `js/` e trocar as chamadas daqui — a API tem
 * os mesmos nomes de propósito.
 */

/** O runtime só existe dentro do painel; fora dele (testes, browser) é undefined. */
function host() {
  const h = typeof window !== "undefined" ? window.__adobe_cep__ : undefined;
  if (!h) {
    throw new Error(
      "Runtime do CEP não encontrado. Este código só roda dentro do painel do After Effects."
    );
  }
  return h;
}

export function isInsideHost() {
  return typeof window !== "undefined" && !!window.__adobe_cep__;
}

/**
 * Executa ExtendScript no host e resolve com o valor retornado (sempre string).
 *
 * Quando o ExtendScript lança, o CEP devolve a string literal "EvalScript error."
 * sem nenhum detalhe — por isso `build-scene.jsx` captura tudo e retorna JSON de
 * erro em vez de deixar a exceção subir. Se mesmo assim essa string chegar aqui, é
 * sinal de erro de sintaxe no próprio .jsx.
 */
export function evalScript(script) {
  return new Promise((resolve, reject) => {
    host().evalScript(script, (result) => {
      if (result === "EvalScript error.") {
        reject(
          new Error(
            "O ExtendScript falhou antes de conseguir reportar o erro — normalmente " +
              "isso é erro de sintaxe no .jsx. Abra o painel de debug (localhost:8088) " +
              "para ver o stack."
          )
        );
        return;
      }
      resolve(result);
    });
  });
}

/** Executa e já faz o parse do JSON de retorno do build-scene.jsx. */
export async function evalScriptJson(script) {
  const raw = await evalScript(script);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Resposta do ExtendScript não é JSON: ${String(raw).slice(0, 300)}`);
  }
}

/** Escapa uma string para embutir como literal dentro de código ExtendScript. */
export function jsxString(value) {
  return JSON.stringify(String(value));
}

const PATH_TYPES = {
  extension: 1,   // pasta da própria extensão
  userData: 2,
  commonFiles: 3,
  myDocuments: 5,
  application: 7,
  hostApplication: 9,
};

export function getSystemPath(kind = "extension") {
  const type = PATH_TYPES[kind];
  if (type === undefined) throw new Error(`Tipo de caminho desconhecido: ${kind}`);
  // O host devolve uma URL file://, com percent-encoding.
  return decodeURI(host().getSystemPath(type)).replace(/^file:\/\//, "");
}

export function getHostEnvironment() {
  return JSON.parse(host().getHostEnvironment());
}

/**
 * Módulos de Node dentro do painel.
 *
 * Com `--enable-nodejs --mixed-context` no manifesto, `require` fica disponível no
 * escopo global da página. O acesso é feito por `window` de propósito: assim o
 * bundler (esbuild) não tenta resolver esses módulos em tempo de build e deixa a
 * resolução para o runtime do CEP.
 */
export function nodeRequire(moduleName) {
  const req =
    (typeof window !== "undefined" && window.cep_node && window.cep_node.require) ||
    (typeof window !== "undefined" && window.require);

  if (!req) {
    throw new Error(
      "Node não está habilitado no painel. Confirme que o manifesto tem " +
        "--enable-nodejs e --mixed-context em CEFCommandLine."
    );
  }
  return req(moduleName);
}
