/**
 * Utilitários de base para o ExtendScript.
 *
 * ExtendScript é ECMAScript 3. Não existe JSON, não existe Array.prototype.map /
 * forEach / indexOf, não existe String.prototype.trim. Tudo que o código do projeto
 * usa além do ES3 puro está aqui, escrito à mão.
 *
 * Sobre JSON: o painel escreve o SceneSpec num arquivo temporário e o ExtendScript
 * lê e avalia com eval(). JSON é um subconjunto de literal de objeto JavaScript,
 * então isso funciona sem parser — desde que o painel escape U+2028/U+2029, que são
 * válidos em JSON mas quebram literais de string em engines antigas. Ver
 * `writeSceneFile()` no painel.
 *
 * A ida de volta (resultado → painel) precisa de serialização, e é o que `vecJson`
 * faz. Ele cobre só o que o objeto de resultado contém: string, número, booleano,
 * null, array e objeto simples.
 */

/*global app, File*/

var vec = vec || {};

/** Serializa um valor para JSON. Escopo deliberadamente pequeno — ver acima. */
vec.json = function (value) {
  if (value === null || value === undefined) return "null";

  var t = typeof value;

  if (t === "boolean") return value ? "true" : "false";

  if (t === "number") {
    // Infinity e NaN não existem em JSON; viram null, como no JSON.stringify real.
    return isFinite(value) ? String(value) : "null";
  }

  if (t === "string") return vec.quote(value);

  if (value instanceof Array) {
    var parts = [];
    for (var i = 0; i < value.length; i++) parts.push(vec.json(value[i]));
    return "[" + parts.join(",") + "]";
  }

  if (t === "object") {
    var pairs = [];
    for (var key in value) {
      if (!value.hasOwnProperty(key)) continue;
      if (typeof value[key] === "function") continue;
      pairs.push(vec.quote(key) + ":" + vec.json(value[key]));
    }
    return "{" + pairs.join(",") + "}";
  }

  return "null";
};

/**
 * Escapa uma string para JSON.
 *
 * ── Por que não uma tabela de escape ──────────────────────────────────────────
 * A versão anterior usava `var ESCAPES = {...}` e consultava `ESCAPES[ch]`. Isso
 * quebrou dentro do After Effects, e de um jeito difícil de rastrear: um objeto comum
 * herda de `Object.prototype`, então `ESCAPES[ch]` pode devolver um **método
 * herdado** em vez de `undefined`. O `if` aceita a função (é truthy) e a
 * concatenação seguinte estoura com
 *
 *     Object of type Function found where a Number, Array, or Property is needed
 *
 * — uma mensagem que não menciona string, nem JSON, nem escape, e que levou a
 * ponte inteira a parecer um problema de permissão de arquivo.
 *
 * Basta um script instalado no After Effects ter feito `Object.prototype.x = ...`
 * alguma vez para envenenar qualquer objeto usado como mapa. Comparação direta não
 * consulta cadeia de protótipo nenhuma, então o problema deixa de existir.
 */
vec.quote = function (str) {
  var s = String(str);
  var out = '"';

  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);

    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (ch < " ") {
      var code = ch.charCodeAt(0).toString(16);
      out += "\\u" + "0000".substring(code.length) + code;
    } else {
      out += ch;
    }
  }

  return out + '"';
};

/**
 * Silencia diálogos do After Effects durante uma operação longa.
 *
 * ── Por que isto é crítico e não cosmético ────────────────────────────────────
 * Diálogo modal congela a thread principal do After Effects, que é a mesma que roda o
 * polling do painel da ponte. E o script **não tem como fechar o diálogo**: para
 * clicar em OK ele precisaria rodar, e a thread que o executaria é exatamente a que
 * está bloqueada. Não existe saída por dentro — só evitar que o diálogo apareça.
 *
 * O que abre sem ser chamado: substituição de fonte, footage faltando, avisos da fila
 * de render sobre intervalo de tempo. Nenhum precisa de resposta para o trabalho
 * seguir, e qualquer um deles derruba uma execução sem ninguém na frente da máquina.
 *
 * Em try/catch porque isto é proteção, não função: se a API mudar de nome, o pior
 * resultado aceitável é ficar sem a proteção — nunca derrubar o que ela protegia.
 */
vec.suppressDialogs = function () {
  try {
    app.beginSuppressDialogs();
    return true;
  } catch (e) {
    return false;
  }
};

vec.restoreDialogs = function (silenciado) {
  if (!silenciado) return;
  try {
    // `false`: não despejar os alertas acumulados no fim. Eles não seriam lidos por
    // ninguém e ainda travariam o painel justamente na saída.
    app.endSuppressDialogs(false);
  } catch (e) {}
};

/** Lê um arquivo UTF-8 inteiro. Devolve null se não der pra abrir. */
vec.readFile = function (path) {
  var file = new File(path);
  if (!file.exists) return null;

  file.encoding = "UTF-8";
  if (!file.open("r")) return null;

  try {
    return file.read();
  } finally {
    file.close();
  }
};

/**
 * "#ff4422" → [r, g, b] com componentes de 0 a 1.
 *
 * `gamma` compensa projeto em espaço de trabalho linear, onde uma cor sRGB crua
 * sai lavada. Deixe 1 (padrão) para projeto sRGB.
 */
vec.hexToColor = function (hex, gamma) {
  var body = String(hex).replace("#", "");
  if (body.length === 3) {
    body = body.charAt(0) + body.charAt(0) + body.charAt(1) + body.charAt(1) + body.charAt(2) + body.charAt(2);
  }

  var r = parseInt(body.substring(0, 2), 16) / 255;
  var g = parseInt(body.substring(2, 4), 16) / 255;
  var b = parseInt(body.substring(4, 6), 16) / 255;

  if (gamma && gamma !== 1) {
    r = Math.pow(r, gamma);
    g = Math.pow(g, gamma);
    b = Math.pow(b, gamma);
  }

  return [r, g, b];
};

/** Nome de camada seguro: o AE trunca em 255 e engasga com quebra de linha. */
vec.safeName = function (name, fallback) {
  var s = String(name === undefined || name === null ? "" : name);
  s = s.replace(/[\r\n\t]+/g, " ");
  if (s.length > 200) s = s.substring(0, 200);
  return s === "" ? fallback : s;
};

vec.has = function (obj, key) {
  return obj !== null && obj !== undefined && obj[key] !== undefined;
};
