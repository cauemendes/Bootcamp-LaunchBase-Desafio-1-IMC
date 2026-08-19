#!/usr/bin/env bash
#
# Instala o painel da ponte na pasta ScriptUI Panels do After Effects.
#
# ── Onde ele instala, e por quê ───────────────────────────────────────────────
# O After Effects carrega painéis de DUAS pastas:
#
#   1. ~/Library/Application Support/Adobe/<AE>/Scripts/ScriptUI Panels/   (por usuário)
#   2. /Applications/Adobe After Effects <ano>/Scripts/ScriptUI Panels/     (aplicativo)
#
# O padrão daqui é a primeira, e por três motivos que importam na prática: não pede
# senha de administrador, sobrevive a uma atualização do After Effects — a segunda é
# apagada junto —, e é a mesma para qualquer pessoa da equipe.
#
# Ter cópia nas duas é a pior situação possível. O aplicativo carrega uma delas, você
# confere o número de build na outra, e todo defeito já corrigido reaparece sem que
# nada aponte para a causa. Este script trata isso: instala numa, e denuncia a outra.
#
# Uso:
#   bash scripts/install-bridge.sh              # instala para o usuário (recomendado)
#   bash scripts/install-bridge.sh --app        # instala dentro do aplicativo (sudo)
#   bash scripts/install-bridge.sh --doctor     # não instala nada, só relata
#   bash scripts/install-bridge.sh --ae "/Applications/Adobe After Effects 2026"

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JSX_DIR="$REPO_ROOT/packages/jsx"

MODO="usuario"
AE_APP=""

while [ $# -gt 0 ]; do
  case "$1" in
    --app)    MODO="aplicativo"; shift ;;
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

# ---- relatório ---------------------------------------------------------------

# Lê o número de build de uma cópia instalada. É a única forma de saber o que o
# aplicativo vai carregar de verdade.
build_de() {
  if [ ! -f "$1" ]; then
    echo "ausente"
    return
  fi
  grep -m1 -o 'VEC_PANEL_BUILD = [0-9]*' "$1" | grep -o '[0-9]*' || echo "sem marca"
}

relatar() {
  echo ""
  echo "▸ Cópias do painel encontradas:"
  echo "    usuário    build $(build_de "$DIR_USUARIO/bridge-panel.jsx")"
  echo "               $DIR_USUARIO"
  echo "    aplicativo build $(build_de "$DIR_APP/bridge-panel.jsx")"
  echo "               $DIR_APP"

  if [ -f "$DIR_USUARIO/bridge-panel.jsx" ] && [ -f "$DIR_APP/bridge-panel.jsx" ]; then
    cat <<'AVISO'

  ⚠️  DUAS CÓPIAS INSTALADAS.

      O After Effects vai carregar uma delas e você não tem como saber qual. Se as
      duas tiverem builds diferentes, todo defeito já corrigido pode reaparecer sem
      que nada aponte para a causa — conferir o arquivo dá certo enquanto o
      aplicativo carrega o outro.

      Apague uma. Rode este script sem --app para ficar só com a do usuário.
AVISO
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
echo "▸ Empacotando o painel num arquivo só…"
BUNDLE="$REPO_ROOT/dist/bridge-panel.jsx"
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
else
  DESTINO="$DIR_USUARIO"
  OUTRO="$DIR_APP"
  SUDO=""
  mkdir -p "$DESTINO"
fi

# A pasta lib/ é resquício de uma instalação antiga com includes. Deixá-la para trás
# mantém um painel velho carregável, e confunde o diagnóstico.
$SUDO rm -rf "$DESTINO/lib"
$SUDO cp "$BUNDLE" "$DESTINO/bridge-panel.jsx"

echo "▸ Instalado (build $BUILD) em:"
echo "    $DESTINO/bridge-panel.jsx"

# ---- remover a cópia concorrente ---------------------------------------------

if [ -f "$OUTRO/bridge-panel.jsx" ]; then
  echo "▸ Existe outra cópia competindo:"
  echo "    $OUTRO/bridge-panel.jsx  (build $(build_de "$OUTRO/bridge-panel.jsx"))"

  # Só mexe no que é comprovadamente nosso.
  if ! grep -q "Vectorize AE Bridge" "$OUTRO/bridge-panel.jsx"; then
    echo "    NÃO removi: o arquivo não parece ser o painel deste projeto. Confira à mão."
  elif rm -f "$OUTRO/bridge-panel.jsx" 2>/dev/null; then
    rm -rf "$OUTRO/lib" 2>/dev/null || true
    echo "    removida — agora há uma instalação só."
  else
    echo "    Não consegui remover (a pasta é do sistema). Rode no Terminal.app:"
    echo ""
    echo "      sudo rm -f \"$OUTRO/bridge-panel.jsx\""
    echo "      sudo rm -rf \"$OUTRO/lib\""
    echo ""
  fi
fi

relatar

cat <<'EOF'

✓ Painel instalado.

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
