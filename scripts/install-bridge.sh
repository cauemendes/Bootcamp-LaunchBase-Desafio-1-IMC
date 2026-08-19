#!/usr/bin/env bash
#
# Instala o painel da ponte na pasta ScriptUI Panels do After Effects.
#
# ── Onde ele instala, e por quê ───────────────────────────────────────────────
# O padrão é a pasta de painéis DENTRO do pacote do aplicativo:
#
#   /Applications/Adobe After Effects <ano>/Scripts/ScriptUI Panels/
#
# Ela pede senha de administrador e é apagada quando o After Effects se atualiza. As
# duas coisas são chatas, e mesmo assim é o padrão — porque é a única que comprovadamente
# funciona.
#
# Houve uma tentativa de usar a pasta por usuário
# (~/Library/Application Support/Adobe/<AE>/Scripts/ScriptUI Panels), que resolveria as
# duas chatices de uma vez. O painel foi instalado lá e **sumiu do menu Window**: esta
# versão do After Effects não varre aquela pasta, ou não com esse nome. A troca foi feita
# com base no que a documentação sugere, sem verificação numa instalação real, e o
# resultado foi um usuário sem painel nenhum.
#
# `--user` continua disponível para quem quiser testar de novo, e está marcado como não
# verificado. Se funcionar na sua instalação, avise — o padrão volta a mudar, aí com prova.
#
# Ter cópia nas duas pastas é a pior situação possível: o aplicativo carrega uma, você
# confere o build na outra, e todo defeito já corrigido reaparece sem que nada aponte
# para a causa. Este script instala numa e denuncia a outra.
#
# Uso:
#   bash scripts/install-bridge.sh              # instala no aplicativo (padrão, pede sudo)
#   bash scripts/install-bridge.sh --user       # instala por usuário — NÃO VERIFICADO
#   bash scripts/install-bridge.sh --dest DIR   # instala num caminho que você indicar
#   bash scripts/install-bridge.sh --doctor     # não instala nada, só relata
#   bash scripts/install-bridge.sh --ae "/Applications/Adobe After Effects 2026"

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JSX_DIR="$REPO_ROOT/packages/jsx"

MODO="aplicativo"
AE_APP=""
DIR_DEST=""

while [ $# -gt 0 ]; do
  case "$1" in
    --app)    MODO="aplicativo"; shift ;;
    --user)   MODO="usuario"; shift ;;
    --dest)   MODO="dest"; DIR_DEST="$2"; shift 2 ;;
    --doctor) MODO="doctor"; shift ;;
    --ae)     AE_APP="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      # Compatibilidade com a forma antiga: o caminho do AE vinha solto.
      AE_APP="$1"; shift ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ] && [[ "$(uname -s)" != MINGW* ]] && [[ "$(uname -s)" != MSYS* ]]; then
  echo "O After Effects roda em macOS e Windows. Este script cobre os dois." >&2
  exit 1
fi

# ---- localizar o After Effects ----------------------------------------------

if [ -z "$AE_APP" ]; then
  # Pega a versão mais recente quando há mais de uma instalada.
  AE_APP="$(ls -d /Applications/Adobe\ After\ Effects\ * 2>/dev/null | sort -V | tail -1 || true)"
fi

if [ -z "${AE_APP:-}" ] || [ ! -d "$AE_APP" ]; then
  cat >&2 <<EOF
Não encontrei o After Effects em /Applications.

Passe o caminho:
    bash scripts/install-bridge.sh --ae "/Applications/Adobe After Effects 2026"
EOF
  exit 1
fi

AE_NOME="$(basename "$AE_APP")"
DIR_USUARIO="$HOME/Library/Application Support/Adobe/$AE_NOME/Scripts/ScriptUI Panels"
DIR_APP="$AE_APP/Scripts/ScriptUI Panels"

echo "▸ After Effects: $AE_APP"

# ── Este script não pode participar de um downgrade silencioso ─────────────────
# O caso real: `git pull` abortou porque `dist/` estava sujo, e o instalador rodou em
# seguida, na mesma linha de comando, e instalou a versão antiga com um "✓" no fim.
# Quem leu a saída de baixo para cima viu sucesso. Dizer de qual commit veio o que foi
# instalado é barato e transforma isso em algo conferível.
if command -v git >/dev/null 2>&1 && git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo '?')"
  echo "▸ Repositório: commit $COMMIT"

  # `dist/` é gerado, e até agora era gerado por este script — o que travava o pull
  # seguinte. Se ainda estiver sujo de uma execução antiga, o pull vai continuar
  # falhando até alguém desfazer.
  if ! git -C "$REPO_ROOT" diff --quiet -- dist/bridge-panel.jsx 2>/dev/null; then
    cat <<AVISO

  ⚠️  dist/bridge-panel.jsx está modificado na árvore de trabalho.

      Ele é gerado, então a modificação é resto de uma instalação antiga — e é o que
      faz o git pull abortar com "your local changes would be overwritten". Enquanto
      isso não for desfeito, cada pull falha e cada instalação seguinte reinstala a
      versão que já estava aqui.

      Desfaça e puxe de novo:

        git -C "$REPO_ROOT" checkout -- dist/bridge-panel.jsx
        git -C "$REPO_ROOT" pull

AVISO
  fi
fi

# ---- relatório ---------------------------------------------------------------

# Lê o número de build de uma cópia instalada. É a única forma de saber o que o
# aplicativo vai carregar de verdade.
build_de() {
  if [ ! -f "$1" ]; then
    echo "ausente"
    return
  fi

  # Distinguir "não consigo ler" de "não tem marca de build" evita mandar alguém
  # investigar uma instalação corrompida quando o problema é permissão — e permissão
  # aqui é grave por si só: se este script não lê, o After Effects também não.
  if [ ! -r "$1" ]; then
    echo "ILEGÍVEL — sem permissão de leitura"
    return
  fi
  grep -m1 -o 'VEC_PANEL_BUILD = [0-9]*' "$1" | grep -o '[0-9]*' || echo "sem marca"
}

# Preenchido quando a cópia concorrente existe e não pôde ser removida. O relatório
# precisa disso: mandar "rode sem --app" para quem já rodou sem --app é o pior tipo de
# conselho, porque parece uma instrução e é um beco.
REMOVER_A_MAO=""

relatar() {
  echo ""
  echo "▸ Cópias do painel encontradas:"
  echo "    usuário    build $(build_de "$DIR_USUARIO/bridge-panel.jsx")"
  echo "               $DIR_USUARIO"
  echo "    aplicativo build $(build_de "$DIR_APP/bridge-panel.jsx")"
  echo "               $DIR_APP"

  if [ -n "$DIR_DEST" ]; then
    echo "    indicado   build $(build_de "$DIR_DEST/bridge-panel.jsx")"
    echo "               $DIR_DEST"
  fi

  if [ -f "$DIR_USUARIO/bridge-panel.jsx" ] && [ -f "$DIR_APP/bridge-panel.jsx" ]; then
    cat <<'AVISO'

  ⚠️  DUAS CÓPIAS INSTALADAS.

      O After Effects vai carregar uma delas e você não tem como saber qual. Enquanto
      os builds forem iguais isso é inofensivo; assim que divergirem, todo defeito já
      corrigido pode reaparecer sem que nada aponte para a causa — conferir o arquivo
      dá certo enquanto o aplicativo carrega o outro.
AVISO

    if [ -n "$REMOVER_A_MAO" ]; then
      cat <<AVISO

      A cópia do aplicativo está numa pasta do sistema e este script não tem permissão
      para apagá-la. Rode isto no Terminal.app e a duplicata acaba:

        sudo rm -f "$DIR_APP/bridge-panel.jsx"
        sudo rm -rf "$DIR_APP/lib"
AVISO
    else
      echo ""
      echo "      Apague uma. Rode este script sem --user para ficar só com a do aplicativo."
    fi
  fi
}

if [ "$MODO" = "doctor" ]; then
  relatar
  echo ""
  echo "▸ Nada foi instalado (--doctor)."
  exit 0
fi

# ---- empacotar ---------------------------------------------------------------

# O painel vai como ARQUIVO ÚNICO, com os includes já resolvidos.
#
# Copiar `bridge-panel.jsx` mais a pasta `lib/` parecia mais simples, mas a resolução
# de //@include muda de comportamento dependendo de onde o script está — e quando
# falha, falha em silêncio: o painel abre, a interface aparece, e só na primeira
# chamada é que se descobre que as funções não existem.
#
# ── Por que num arquivo temporário, e não em dist/ ──────────────────────────────
# `dist/bridge-panel.jsx` é versionado, para quem não quer construir nada poder usar
# File → Scripts → Run Script File direto do repositório. Gerar por cima dele aqui
# sujava a árvore de trabalho a cada instalação — e o `git pull` seguinte abortava com
# "your local changes would be overwritten".
#
# O estrago disso é maior que o incômodo: o pull falha, o instalador roda em seguida na
# mesma linha de comando e instala alegremente a versão ANTIGA, com um "✓ instalado" no
# fim. A pessoa fica com a impressão de estar atualizada, e o defeito que a versão nova
# corrige continua acontecendo.
echo "▸ Empacotando o painel num arquivo só…"
BUNDLE="$(mktemp "${TMPDIR:-/tmp}/vectorize-bridge-panel.XXXXXX")"
trap 'rm -f "$BUNDLE"' EXIT
node "$REPO_ROOT/scripts/bundle-jsx.mjs" "$JSX_DIR/bridge-panel.jsx" "$BUNDLE"
BUILD="$(build_de "$BUNDLE")"

# ---- instalar ----------------------------------------------------------------

if [ "$MODO" = "aplicativo" ]; then
  DESTINO="$DIR_APP"
  OUTRO="$DIR_USUARIO"

  if [ -w "$DESTINO" ]; then
    SUDO=""
  elif sudo -n true 2>/dev/null || [ -t 0 ]; then
    echo "▸ A pasta do aplicativo exige administrador — vou pedir sua senha."
    SUDO="sudo"
  else
    cat >&2 <<MSG

✗ Preciso de administrador e não há terminal interativo para pedir a senha —
  provavelmente este script foi chamado por um agente.

  Rode sem --app: a instalação por usuário não pede senha nenhuma.

MSG
    exit 1
  fi
elif [ "$MODO" = "dest" ]; then
  if [ -z "$DIR_DEST" ]; then
    echo "--dest precisa do caminho da pasta." >&2
    exit 1
  fi

  DESTINO="$DIR_DEST"
  # Com destino indicado, "a outra cópia" não é uma só — o relatório no fim mostra as
  # três, e quem escolheu o caminho é quem sabe qual apagar.
  OUTRO=""

  if [ -w "$(dirname "$DESTINO")" ] || [ -w "$DESTINO" ]; then
    SUDO=""
  elif sudo -n true 2>/dev/null || [ -t 0 ]; then
    echo "▸ Essa pasta exige administrador — vou pedir sua senha."
    SUDO="sudo"
  else
    echo "✗ Preciso de administrador para escrever em $DESTINO." >&2
    exit 1
  fi

  $SUDO mkdir -p "$DESTINO"
else
  cat <<'AVISO'

  ⚠️  --user instala numa pasta que NÃO foi verificada nesta versão do After Effects.

      Numa tentativa anterior o painel foi instalado aqui e sumiu do menu Window. Se
      isso acontecer, rode de novo sem --user para voltar ao caminho que funciona.

AVISO
  DESTINO="$DIR_USUARIO"
  OUTRO="$DIR_APP"
  SUDO=""
  mkdir -p "$DESTINO"
fi

# A pasta lib/ é resquício de uma instalação antiga com includes. Deixá-la para trás
# mantém um painel velho carregável, e confunde o diagnóstico.
$SUDO rm -rf "$DESTINO/lib"
$SUDO cp "$BUNDLE" "$DESTINO/bridge-panel.jsx"

# ── O painel precisa ser legível por quem roda o After Effects ─────────────────
# O bundle sai de `mktemp`, que cria o arquivo com modo 600 — só o dono lê. Instalando
# com sudo, o dono passa a ser o root, e o After Effects roda como você: sem esta linha
# ele pode simplesmente não conseguir abrir o painel, e o sintoma é o pior possível —
# o arquivo está lá, no caminho certo, com o build certo, e não aparece no menu Window.
$SUDO chmod 644 "$DESTINO/bridge-panel.jsx"

echo "▸ Instalado (build $BUILD) em:"
echo "    $DESTINO/bridge-panel.jsx"

# ---- remover a cópia concorrente ---------------------------------------------

if [ -n "$OUTRO" ] && [ -f "$OUTRO/bridge-panel.jsx" ]; then
  echo "▸ Existe outra cópia competindo:"
  echo "    $OUTRO/bridge-panel.jsx  (build $(build_de "$OUTRO/bridge-panel.jsx"))"

  # Só mexe no que é comprovadamente nosso.
  if ! grep -q "Vectorize AE Bridge" "$OUTRO/bridge-panel.jsx"; then
    echo "    NÃO removi: o arquivo não parece ser o painel deste projeto. Confira à mão."
  elif rm -f "$OUTRO/bridge-panel.jsx" 2>/dev/null; then
    rm -rf "$OUTRO/lib" 2>/dev/null || true
    echo "    removida — agora há uma instalação só."
  else
    REMOVER_A_MAO="sim"
    echo "    Não consegui remover: a pasta é do sistema e exige administrador."
  fi
fi

relatar

if [ -n "$REMOVER_A_MAO" ]; then
  echo ""
  echo "✓ Painel instalado — mas FALTA apagar a cópia duplicada, com os dois comandos"
  echo "  acima. Sem isso o After Effects pode continuar carregando o painel antigo."
else
  echo ""
  echo "✓ Painel instalado."
fi

cat <<'EOF'

  FALTA UM PASSO, e sem ele a ponte não funciona:

    After Effects → Settings → Scripting & Expressions
    → marque "Allow Scripts to Write Files and Access Network"

  Sem essa opção o painel não consegue escrever o arquivo de resposta, e todo
  comando dá timeout sem explicar o motivo.

  Depois: REINICIE o After Effects e abra
    Window → bridge-panel.jsx

  A primeira linha do log diz o build carregado. Confira que bate com o instalado
  acima — é a única prova de que o aplicativo está rodando o código novo.

  A ponte nasce parada. Clique em Iniciar quando quiser usá-la; ela lembra a
  escolha nas próximas sessões.

EOF
