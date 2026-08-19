/**
 * Testes do painel da ponte, rodados no Node contra um After Effects falso.
 *
 * ── Por que isto existe ───────────────────────────────────────────────────────
 * O painel só rodava dentro do After Effects, então todo defeito dele custava uma
 * rodada de teste manual na máquina de outra pessoa: instalar, reiniciar o app, abrir
 * o projeto, tentar, relatar. Dois defeitos passaram por esse ciclo várias vezes cada.
 *
 * O painel não precisa do AE para a maior parte do que faz. Ele mexe em estado, em
 * widgets e em arquivo — e as três coisas dão para fingir. O que sobra de verdadeiro é
 * exatamente onde os defeitos estavam: quem atualiza qual painel, o que acontece na
 * segunda carga do arquivo, e o que o painel mostra quando as tarefas agendadas não
 * rodam.
 *
 * `scheduleTask` do host falso **não dispara sozinho**. Quem dispara é o teste. Isso
 * não é preguiça de implementação: é a condição que importa reproduzir, porque com um
 * diálogo do After Effects na tela a thread principal fica bloqueada e nenhuma tarefa
 * agendada roda. Um host que disparasse tarefas automaticamente não conseguiria
 * expressar o cenário que mais deu trabalho.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { bundleJsx } from "../../../scripts/bundle-jsx.mjs";

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// O bundle é montado aqui a partir das fontes, não lido de `dist/`. Ler o `dist/`
// deixaria o teste passar contra um bundle velho sempre que alguém esquecesse de rodar
// `npm run bundle` — e um teste que aprova código que não é o do repositório é pior que
// nenhum teste.
const { code: FONTE_BUNDLE } = bundleJsx(path.join(RAIZ, "packages", "jsx", "bridge-panel.jsx"));

// ---------------------------------------------------------------- host falso

/** Widget de ScriptUI: guarda texto e deixa o teste ler e clicar. */
function widget(tipo, texto) {
  return {
    tipo,
    text: texto === undefined ? "" : texto,
    alignment: null,
    preferredSize: { width: 0, height: 0 },
    minimumSize: { width: 0, height: 0 },
    textselection: "",
    onClick: null,
    add: (t, _b, tx) => widget(t, tx),
  };
}

function janela() {
  const w = {
    filhos: [],
    orientation: null,
    alignChildren: null,
    spacing: 0,
    margins: 0,
    resizes: 0,
    layout: {
      layout() {},
      resize() {
        w.resizes++;
      },
    },
    center() {},
    show() {},
    close() {
      if (this.onClose) this.onClose();
    },
    add(tipo, _bounds, texto) {
      const filho = widget(tipo, texto);
      filho.add = (t, _b, tx) => {
        const neto = widget(t, tx);
        filho.filhos = filho.filhos || [];
        filho.filhos.push(neto);
        return neto;
      };
      this.filhos.push(filho);
      return filho;
    },
  };
  return w;
}

/** File e Folder sobre o disco real: o heartbeat é gravado de verdade e conferido. */
function fazerArquivos() {
  function File(p) {
    if (!(this instanceof File)) return new File(p);
    this.fsName = String(p);
    this.encoding = "UTF-8";
    this._modo = null;
    this._buf = "";
  }
  Object.defineProperty(File.prototype, "exists", {
    get() {
      return fs.existsSync(this.fsName);
    },
  });
  File.prototype.open = function (modo) {
    this._modo = modo;
    this._buf = "";
    return true;
  };
  File.prototype.write = function (texto) {
    this._buf += texto;
    fs.writeFileSync(this.fsName, this._buf, "utf8");
    return true;
  };
  File.prototype.read = function () {
    return fs.readFileSync(this.fsName, "utf8");
  };
  File.prototype.close = function () {
    this._modo = null;
    return true;
  };
  File.prototype.remove = function () {
    try {
      fs.unlinkSync(this.fsName);
      return true;
    } catch {
      return false;
    }
  };
  File.prototype.rename = function (nome) {
    const destino = path.join(path.dirname(this.fsName), nome);
    fs.renameSync(this.fsName, destino);
    this.fsName = destino;
    return true;
  };

  function Folder(p) {
    if (!(this instanceof Folder)) return new Folder(p);
    this.fsName = String(p);
  }
  Object.defineProperty(Folder.prototype, "exists", {
    get() {
      return fs.existsSync(this.fsName);
    },
  });
  Folder.prototype.create = function () {
    fs.mkdirSync(this.fsName, { recursive: true });
    return true;
  };
  Folder.prototype.getFiles = function () {
    return [];
  };
  Folder.prototype.execute = function () {
    return true;
  };

  return { File, Folder };
}

/**
 * Sobe um "After Effects" e carrega o painel nele.
 *
 * Devolve o host para o teste inspecionar, e `carregar()` para simular uma segunda
 * carga do arquivo na mesma engine — que é como nascem dois painéis.
 */
function abrirAE({ escutandoAntes = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vec-painel-"));
  const { File, Folder } = fazerArquivos();
  Folder.userData = { fsName: base };

  // A preferência precisa existir antes da carga: é ela que o painel consulta para
  // decidir se retoma sozinho.
  if (escutandoAntes) {
    const pasta = path.join(base, "vectorize-ae", "bridge");
    fs.mkdirSync(pasta, { recursive: true });
    fs.writeFileSync(path.join(pasta, "panel-pref.json"), '{"escutando":true}', "utf8");
  }

  const fonte = FONTE_BUNDLE.replace(/^#targetengine.*$/m, "");

  const tarefas = [];
  const dollar = { global: {}, getenv: () => null, stack: "", writeln() {} };

  const app = {
    version: "26.3x87",
    tarefas,
    scheduleTask(codigo, ms, repeat) {
      tarefas.push({ id: tarefas.length + 1, codigo, ms, repeat, cancelada: false });
      return tarefas.length;
    },
    cancelTask(id) {
      const t = tarefas[id - 1];
      if (t) t.cancelada = true;
      return true;
    },
    beginSuppressDialogs() {},
    endSuppressDialogs() {},
    project: { numItems: 0 },
  };

  function Panel() {}
  const paineis = [];

  const Window = function (tipo, titulo) {
    const w = janela();
    w.tipo = tipo;
    w.titulo = titulo;
    paineis.push(w);
    return w;
  };

  const host = { base, app, dollar, paineis, tarefas, File, Folder };

  // ── Por que um contexto vm com global tolerante ─────────────────────────────
  // O bundle carrega o projeto inteiro, e partes dele mencionam enums do After Effects
  // (ParagraphJustification e companhia) já na carga. Enumerar esses nomes num
  // `new Function` seria uma lista que quebra a cada arquivo novo em packages/jsx.
  // Um global que devolve um stub para qualquer nome desconhecido resolve de uma vez:
  // o que o teste realmente exercita está todo nos stubs de verdade acima.
  const alvo = { app, File, Folder, Window, Panel, ScriptUI: {}, $: dollar, console };

  const stub = () =>
    new Proxy(function () {}, {
      get: (_t, p) => (p === "toString" ? () => "[stub]" : 0),
      apply: () => 0,
      construct: () => ({}),
    });

  const global = new Proxy(alvo, {
    has: () => true,
    get(t, p) {
      if (typeof p === "symbol") return undefined;
      if (p in t) return t[p];

      // Intrínsecos primeiro: `has: () => true` sombreia Date, Math e companhia, e um
      // stub no lugar de `Date` produz erro a dez quadros de distância da causa.
      if (p in globalThis) return globalThis[p];

      // Só nome que começa em maiúscula ganha stub — é a forma dos enums do AE
      // (ParagraphJustification, KeyframeInterpolationType). Nome minúsculo tem que
      // devolver undefined, porque o projeto usa o idioma `var vec = vec || {}`: um
      // stub ali viraria o `vec` de todo mundo, e `vec.quote` passaria a ser um número.
      // Foi exatamente isso que fez o heartbeat falhar em silêncio na primeira versão
      // deste harness — e o silêncio era um defeito real do painel, hoje corrigido.
      if (!/^[A-Z]/.test(p)) return undefined;

      t[p] = stub();
      return t[p];
    },
    set(t, p, v) {
      t[p] = v;
      return true;
    },
  });

  const contexto = vm.createContext(global);

  host.carregar = () => {
    // `this` no topo do script não é um Panel, então o painel se constrói como janela
    // flutuante — o mesmo caminho de código, com widgets que o teste consegue ler.
    vm.runInContext(fonte, contexto);

    return {
      estado: dollar.global.vecBridgeState,
      poll: alvo.vecBridgePoll,
      supervisor: alvo.vecBridgeSupervise,
      autoStart: alvo.vecBridgeAutoStart,
      start: alvo.vecBridgeStart,
      stop: alvo.vecBridgeStop,
    };
  };

  host.api = host.carregar();
  return host;
}

/** Dispara uma tarefa agendada ainda viva, pelo trecho de código que ela executa. */
function dispararTarefa(host, api, trecho) {
  const t = host.tarefas.find((x) => !x.cancelada && x.codigo.indexOf(trecho) !== -1);
  assert.ok(t, `nenhuma tarefa viva para ${trecho}`);

  if (trecho === "vecBridgeAutoStart") api.autoStart();
  else if (trecho === "vecBridgePoll") api.poll();
  else if (trecho === "vecBridgeSupervise") api.supervisor();
  return t;
}

/** Liga a ponte pelo caminho real: o clique no botão. */
function ligar(host, n) {
  widgetsDo(host, n === undefined ? 0 : n).toggle.onClick();
}

/** Widgets do painel n, na ordem em que o painel os cria. */
function widgetsDo(host, n) {
  const win = host.paineis[n];
  const topo = win.filhos[0];
  return {
    status: topo.filhos[0],
    toggle: topo.filhos[1],
    logBox: win.filhos[1],
    rodape: win.filhos[2],
    win,
  };
}

const logDe = (w) => w.logBox.text;

// ---------------------------------------------------------------- testes

test("instalação nova não escuta sozinha, nem depois da tarefa adiada", () => {
  // Painel encaixado volta com o workspace: abrir o After Effects para trabalhar trazia
  // a ponte escutando sem ninguém ter pedido — e ponte escutando faz o AE recusar rodar
  // outros scripts que abram janela. Escutar é a opção que incomoda; tem que ser pedida.
  const host = abrirAE();
  const { status, toggle } = widgetsDo(host, 0);

  assert.equal(host.api.estado.running, false);
  assert.equal(toggle.text, "Iniciar");
  assert.match(status.text, /parada/);

  dispararTarefa(host, host.api, "vecBridgeAutoStart");

  assert.equal(host.api.estado.running, false, "sem preferência gravada, não escuta");
  assert.match(widgetsDo(host, 0).status.text, /clique em Iniciar/);
});

test("a ponte que estava escutando retoma sozinha na sessão seguinte", () => {
  // É o que mantém um lote noturno vivo se o After Effects reiniciar no meio.
  const host = abrirAE({ escutandoAntes: true });

  assert.match(widgetsDo(host, 0).status.text, /aguardando/);
  assert.equal(host.api.estado.running, false, "não escuta durante a subida do app");

  dispararTarefa(host, host.api, "vecBridgeAutoStart");

  assert.equal(host.api.estado.running, true);
  assert.equal(widgetsDo(host, 0).toggle.text, "Parar");

  // No auto-início ninguém está esperando resposta, então começa no ritmo lento: assim
  // um diálogo que já esteja na tela é atropelado o mínimo possível.
  assert.equal(host.api.estado.intervalo, host.api.estado.IDLE_MS);
});

test("Parar clicado vale para as próximas sessões do After Effects", () => {
  const host = abrirAE({ escutandoAntes: true });
  dispararTarefa(host, host.api, "vecBridgeAutoStart");
  assert.equal(host.api.estado.running, true);

  ligar(host); // agora é um Parar
  assert.equal(host.api.estado.running, false);

  const pref = fs.readFileSync(
    path.join(host.base, "vectorize-ae", "bridge", "panel-pref.json"),
    "utf8"
  );
  assert.match(pref, /"escutando":false/);
});

test("com dois painéis abertos, o clique num deles atualiza os dois", () => {
  // ── O defeito ────────────────────────────────────────────────────────────────
  // `vecBridge.ui` era um slot único, tomado pelo último painel carregado. Clicar em
  // Iniciar no primeiro painel mudava o botão do segundo, e o painel clicado não
  // reagia — indistinguível, para quem olha, de um clique que não chegou.
  const host = abrirAE();
  host.carregar();

  assert.equal(host.paineis.length, 2);

  const a = widgetsDo(host, 0);
  const b = widgetsDo(host, 1);

  a.toggle.onClick();

  assert.equal(host.api.estado.running, true);
  assert.equal(a.toggle.text, "Parar", "o painel clicado reage");
  assert.equal(b.toggle.text, "Parar", "o outro painel também");
  assert.match(a.status.text, /ouvindo/);
  assert.match(b.status.text, /ouvindo/);

  b.toggle.onClick();

  assert.equal(host.api.estado.running, false);
  assert.equal(a.toggle.text, "Iniciar");
  assert.equal(b.toggle.text, "Iniciar");
});

test("o clique se anuncia no log antes de qualquer coisa poder falhar", () => {
  // "Cliquei e não mudou nada" é ambíguo entre o handler não ter rodado e ter falhado.
  const host = abrirAE();
  const { toggle, logBox } = widgetsDo(host, 0);

  toggle.onClick();
  assert.match(logBox.text, /clique: Iniciar/);

  toggle.onClick();
  assert.match(logBox.text, /clique: Parar/);
});

test("fechar um painel duplicado não desliga a ponte; fechar o último desliga", () => {
  const host = abrirAE();
  host.carregar();

  widgetsDo(host, 0).toggle.onClick();
  assert.equal(host.api.estado.running, true);

  widgetsDo(host, 1).win.close();
  assert.equal(host.api.estado.running, true, "ainda há um painel mostrando a ponte");
  assert.equal(host.api.estado.uis.length, 1);

  widgetsDo(host, 0).win.close();
  assert.equal(host.api.estado.running, false, "sem painel, o polling não pode ficar órfão");
});

test("uma segunda carga não zera as contas da ponte já em pé", () => {
  // `var vecBridge = {...}` era refeito a cada carga: `cycles` voltava a zero e
  // `running` voltava a false com o polling ainda agendado.
  const host = abrirAE();
  ligar(host);
  host.api.poll();
  host.api.poll();

  const ciclos = host.api.estado.cycles;
  assert.ok(ciclos >= 2);

  const segunda = host.carregar();

  assert.equal(segunda.estado, host.api.estado, "o estado é o mesmo objeto na engine");
  assert.equal(segunda.estado.cycles, ciclos, "as contas sobrevivem");
  assert.equal(segunda.estado.running, true);
  assert.match(widgetsDo(host, 1).status.text, /ouvindo/, "o painel novo já nasce sabendo");
});

test("o diagnóstico denuncia a ponte ligada cujo polling nunca rodou", () => {
  // O cenário do diálogo modal: as tarefas agendadas não rodam, e o painel continua
  // dizendo "ouvindo" porque não sobrou ninguém para corrigir o texto. O botão de
  // diagnóstico é evento de UI, então funciona justamente aí.
  const host = abrirAE();
  const { toggle, logBox, rodape } = widgetsDo(host, 0);

  toggle.onClick();
  assert.equal(host.api.estado.running, true);

  // Logo depois do clique o diagnóstico pede paciência, e está certo: um ciclo leva
  // 350ms para acontecer. O alarme aqui seria falso.
  rodape.filhos[0].onClick();
  assert.match(logDe({ logBox }), /ainda não rodou/);
  assert.doesNotMatch(logDe({ logBox }), /ATENÇÃO/);

  // Alguns segundos depois, ainda sem um único ciclo, não há mais desculpa. É o que um
  // diálogo do After Effects provoca: a tarefa agendada existe e não roda.
  host.api.estado.startedAt = Date.now() - 10_000;
  rodape.filhos[0].onClick();

  assert.match(logDe({ logBox }), /diagnóstico/);
  assert.match(logDe({ logBox }), /ATENÇÃO/);
  assert.match(logDe({ logBox }), /diálogo do After Effects/);
  assert.match(logDe({ logBox }), /nem.*Parar → Iniciar resolve/s);
});

test("o diagnóstico confirma polling normal sem falar de diálogo", () => {
  const host = abrirAE();
  const { toggle, logBox, rodape } = widgetsDo(host, 0);

  toggle.onClick();
  host.api.poll();
  rodape.filhos[0].onClick();

  assert.match(logDe({ logBox }), /polling normal/);
  assert.doesNotMatch(logDe({ logBox }), /ATENÇÃO/);
});

test("um painel morto sai do registro sem impedir os vivos de atualizar", () => {
  const host = abrirAE();
  host.carregar();

  // Simula a aba fechada pelo usuário sem passar por onClose: escrever na widget lança.
  const morto = host.api.estado.uis[0];
  Object.defineProperty(morto, "status", {
    get() {
      throw new Error("widget destruída");
    },
  });

  const vivo = widgetsDo(host, 1);
  vivo.toggle.onClick();

  assert.equal(host.api.estado.uis.length, 1, "o morto saiu do registro");
  assert.match(vivo.status.text, /ouvindo/, "o vivo recebeu a atualização");
});

test("o heartbeat grava running e uptime — é o que separa parada de travada", () => {
  const host = abrirAE();
  ligar(host);
  host.api.poll();

  const ler = () => JSON.parse(fs.readFileSync(path.join(host.base, "vectorize-ae", "bridge", "heartbeat.json"), "utf8"));

  const vivo = ler();
  assert.equal(vivo.running, true);
  assert.equal(vivo.afterEffects, "26.3x87");
  assert.ok(typeof vivo.uptime === "number");

  host.api.stop();

  const parado = ler();
  assert.equal(parado.running, false, "parar grava o heartbeat final na hora");
});

/**
 * Simula um bloqueio da thread principal: o ciclo seguinte chega muito depois do
 * combinado, que é a única evidência que o painel consegue observar. O After Effects
 * recusa executar script com diálogo modal na tela, e a recusa acontece antes do nosso
 * código — não há try/catch que a capture.
 */
function bloquear(host, vezes) {
  const estado = host.api.estado;
  for (let i = 0; i < vezes; i++) {
    estado.lastPoll = Date.now() - estado.intervalo * 5 - 2_000;
    host.api.poll();
  }
}

test("a ponte recua o ritmo quando algo bloqueia o After Effects", () => {
  // ── Por que isto importa mais que a ponte ────────────────────────────────────
  // Cada verificação é uma execução de script, e o AE recusa rodar script com diálogo
  // na tela mostrando um erro. A 250ms isso são centenas de diálogos por minuto, e o
  // estrago cai sobre os outros scripts do usuário — um painel do Motion aberto fica
  // inutilizável. A ferramenta não pode atrapalhar as ferramentas da pessoa.
  const host = abrirAE();
  ligar(host);

  const estado = host.api.estado;
  assert.equal(estado.intervalo, estado.BUSY_MS, "começa rápido, quem ligou está esperando");

  bloquear(host, 1);

  assert.equal(estado.bloqueios, 1);
  assert.ok(estado.intervalo > estado.BUSY_MS, "recuou");
  assert.match(widgetsDo(host, 0).logBox.text, /bloqueou a thread/);
  assert.match(widgetsDo(host, 0).logBox.text, /clique em Parar/);
});

test("o recuo dobra até o teto, e nunca passa dele", () => {
  const host = abrirAE();
  ligar(host);
  const estado = host.api.estado;

  bloquear(host, 1);
  const primeiro = estado.intervalo;

  bloquear(host, 1);
  assert.ok(estado.intervalo > primeiro, "dobrou");
  assert.ok(estado.intervalo <= estado.MAX_MS);
});

test("bloqueio que insiste faz a ponte sair da frente sozinha", () => {
  // Recuar não basta: mesmo devagar, cada bloqueio ainda é um erro na tela de quem está
  // tentando usar outro script. Bloqueio que insiste significa "tem gente usando o AE".
  const host = abrirAE();
  ligar(host);
  const estado = host.api.estado;

  bloquear(host, estado.LIMITE_BLOQUEIOS);

  assert.equal(estado.running, false, "a ponte se pausou");
  assert.equal(estado.pausadaPorBloqueio, true);
  assert.match(widgetsDo(host, 0).logBox.text, /PAUSEI a ponte/);
  assert.match(widgetsDo(host, 0).status.text, /ocupado/);

  // E o heartbeat conta o motivo, senão o servidor manda "clique em Iniciar" — que é
  // exatamente voltar a atrapalhar quem está trabalhando.
  const hb = JSON.parse(
    fs.readFileSync(path.join(host.base, "vectorize-ae", "bridge", "heartbeat.json"), "utf8")
  );
  assert.equal(hb.running, false);
  assert.equal(hb.pausadaPorBloqueio, true);
});

test("clicar em Iniciar depois da pausa devolve a ponte ao ritmo rápido", () => {
  const host = abrirAE();
  ligar(host);
  const estado = host.api.estado;

  bloquear(host, estado.LIMITE_BLOQUEIOS);
  assert.equal(estado.running, false);

  widgetsDo(host, 0).toggle.onClick();

  assert.equal(estado.running, true);
  assert.equal(estado.bloqueios, 0);
  assert.equal(estado.pausadaPorBloqueio, false);
  assert.equal(estado.intervalo, estado.BUSY_MS);
});

test("ciclos limpos devolvem o ritmo, um degrau por vez", () => {
  // Voltar direto ao rápido recriaria a tempestade: o diálogo que bloqueou costuma ser
  // o primeiro de vários, porque a pessoa está usando outro script.
  const host = abrirAE();
  ligar(host);
  const estado = host.api.estado;

  bloquear(host, 2);
  assert.equal(estado.bloqueios, 2);

  for (let i = 0; i < 3; i++) host.api.poll();
  assert.equal(estado.bloqueios, 1, "um degrau, não a escada toda");

  for (let i = 0; i < 3; i++) host.api.poll();
  assert.equal(estado.bloqueios, 0);
  assert.match(widgetsDo(host, 0).logBox.text, /bloqueio passou/);
});

test("ociosa, a ponte verifica devagar; com comando na fila, rápido", () => {
  const host = abrirAE();
  ligar(host);
  const estado = host.api.estado;

  // Passada a janela de trabalho sem comando nenhum, não há ninguém esperando.
  estado.busyUntil = Date.now() - 1;
  host.api.poll();

  assert.equal(estado.intervalo, estado.IDLE_MS, "ocioso é lento de propósito");

  // Um comando reabre a janela — rajada de comandos é o caso normal.
  estado.busyUntil = Date.now() + estado.BUSY_JANELA;
  host.api.poll();

  assert.equal(estado.intervalo, estado.BUSY_MS);
});

test("o supervisor não reanima um polling que está apenas em recuo", () => {
  // Em recuo de 16s, um limite fixo de 1s faria o supervisor cancelar e reagendar a
  // toda hora — voltando a martelar exatamente quando o objetivo era parar.
  const host = abrirAE();
  ligar(host);
  const estado = host.api.estado;

  bloquear(host, 2);
  estado.lastPoll = Date.now() - estado.intervalo;

  host.api.supervisor();

  assert.equal(estado.revivals, 0);
});

test("o painel se adapta ao tamanho que o usuário deixar", () => {
  // `preferredSize.height = 180` no log era um piso disfarçado: o ScriptUI monta o
  // layout a partir do tamanho preferido dos filhos, então o painel não encolhia abaixo
  // disso e o conteúdo era cortado em vez de se ajustar.
  const host = abrirAE();
  const { logBox, win } = widgetsDo(host, 0);

  assert.equal(logBox.alignment[0], "fill");
  assert.equal(logBox.alignment[1], "fill", "o log tem que crescer nos dois eixos");
  assert.ok(logBox.minimumSize[1] < 180, "sem piso de 180px");

  // Arrastar a borda chama o layout de novo; sem isso o conteúdo fica do tamanho antigo.
  const antes = win.resizes;
  win.onResize();
  win.onResizing();

  assert.equal(win.resizes, antes + 2);
});

test("erro no redimensionamento não vira diálogo no meio do arraste", () => {
  const host = abrirAE();
  const { win } = widgetsDo(host, 0);

  win.layout.resize = () => {
    throw new Error("layout quebrado");
  };

  // Evento de UI que lança durante um arraste do After Effects aparece como diálogo de
  // erro — e diálogo trava a ponte.
  assert.doesNotThrow(() => win.onResize());
});

test("o botão não muda de largura ao alternar o rótulo", () => {
  // "Iniciar" e "Parar" têm larguras diferentes; sem largura fixa o status é empurrado
  // de um lado para o outro a cada clique.
  const host = abrirAE();
  const { toggle } = widgetsDo(host, 0);

  assert.equal(toggle.minimumSize.width, toggle.preferredSize.width);
});

test("o supervisor reanima o polling e conta a reanimação", () => {
  const host = abrirAE();
  ligar(host);

  const estado = host.api.estado;
  estado.lastPoll = Date.now() - estado.intervalo * 10 - 5_000;

  host.api.supervisor();

  assert.equal(estado.revivals, 1);
  assert.match(widgetsDo(host, 0).logBox.text, /reiniciei/);
});
