#!/usr/bin/env bash
#
# Instala o painel da ponte na pasta ScriptUI Panels do After Effects.
#
# Copia dois itens: `bridge-panel.jsx` e a pasta `lib/`. Só o painel fica solto ali
# — os outros .jsx do projeto também apareceriam no menu Window, e o autoteste
# rodaria sozinho ao abrir o aplicativo.
#
# Uso:
#   bash scripts/install-bridge.sh              # detecta a versão instalada
#   bash scripts/install-bridge.sh "/Applications/Adobe After Effects 2026"

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JSX_DIR="$REPO_ROOT/packages/jsx"

if [ "$(uname -s)" != "Darwin" ] && [[ "$(uname -s)" != MINGW* ]] && [[ "$(uname -s)" != MSYS* ]]; then
  echo "O After Effects roda em macOS e Windows. Este script cobre os dois." >&2
  exit 1
fi

# ---- localizar o After Effects ----------------------------------------------

if [ $# -ge 1 ]; then
  AE_APP="$1"
else
  # Pega a versão mais recente quando há mais de uma instalada.
  AE_APP="$(ls -d /Applications/Adobe\ After\ Effects\ * 2>/dev/null | sort -V | tail -1 || true)"
fi

if [ -z "${AE_APP:-}" ] || [ ! -d "$AE_APP" ]; then
  cat >&2 <<EOF
Não encontrei o After Effects em /Applications.

Passe o caminho como argumento:
    bash scripts/install-bridge.sh "/Applications/Adobe After Effects 2026"
EOF
  exit 1
fi

PANELS_DIR="$AE_APP/Scripts/ScriptUI Panels"

if [ ! -d "$PANELS_DIR" ]; then
  echo "Achei o After Effects em $AE_APP, mas não a pasta 'Scripts/ScriptUI Panels'." >&2
  exit 1
fi

echo "▸ After Effects: $AE_APP"

# ---- copiar ------------------------------------------------------------------

# A pasta fica dentro do aplicativo e normalmente exige permissão de administrador.
# Testar antes evita uma cópia pela metade.
if [ -w "$PANELS_DIR" ]; then
  SUDO=""
else
  echo "▸ A pasta de painéis exige permissão de administrador — vou pedir sua senha."
  SUDO="sudo"
fi

$SUDO rm -rf "$PANELS_DIR/lib"
$SUDO cp "$JSX_DIR/bridge-panel.jsx" "$PANELS_DIR/"
$SUDO cp -R "$JSX_DIR/lib" "$PANELS_DIR/"

echo "▸ Instalado em: $PANELS_DIR"

cat <<'EOF'

✓ Painel copiado.

  FALTA UM PASSO, e sem ele a ponte não funciona:

    After Effects → Settings → Scripting & Expressions
    → marque "Allow Scripts to Write Files and Access Network"

  Sem essa opção o painel não consegue escrever o arquivo de resposta, e todo
  comando vai dar timeout sem explicar o motivo.

  Depois: reinicie o After Effects e abra
    Window → bridge-panel.jsx

  O painel inicia sozinho e deve mostrar "ouvindo".

EOF
