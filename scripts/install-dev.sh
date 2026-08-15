#!/usr/bin/env bash
#
# Instala o painel em modo de desenvolvimento.
#
# Faz duas coisas:
#   1. Liga o PlayerDebugMode, que permite o CEP carregar extensões não assinadas.
#      Sem isso o painel simplesmente não aparece no menu Extensions — sem erro,
#      sem aviso, e é a causa de 90% dos "não funciona" com CEP.
#   2. Cria um symlink da pasta da extensão para a pasta de extensões do CEP, para
#      que rebuild não exija reinstalar.
#
# Para distribuir para outras pessoas é preciso empacotar e assinar um .zxp — isso
# ainda não está no projeto (ver docs/roadmap.md).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXTENSION_SRC="$REPO_ROOT/packages/cep"
EXTENSION_NAME="ai.vectorize.ae"

# CSXS.11 é o runtime do After Effects 2024/2025. Versões mais novas do AE podem
# usar um número maior — se o painel não aparecer, confira qual pasta CSXS.* existe
# na sua máquina e ajuste aqui.
CSXS_VERSION="11"

case "$(uname -s)" in
  Darwin)
    EXTENSIONS_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions"
    PREFS_FILE="$HOME/Library/Preferences/com.adobe.CSXS.$CSXS_VERSION.plist"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    EXTENSIONS_DIR="$APPDATA/Adobe/CEP/extensions"
    PREFS_FILE=""
    ;;
  *)
    echo "Este script cobre macOS e Windows (Git Bash). O CEP não roda em Linux." >&2
    exit 1
    ;;
esac

echo "▸ Compilando o painel…"
npm --prefix "$EXTENSION_SRC" run build

echo "▸ Habilitando extensões não assinadas (PlayerDebugMode)…"
if [ -n "$PREFS_FILE" ]; then
  defaults write "com.adobe.CSXS.$CSXS_VERSION" PlayerDebugMode 1
  # Sem isso o macOS pode servir um valor em cache do daemon de preferências e o
  # ajuste não vale até o próximo logout.
  killall cfprefsd 2>/dev/null || true
else
  reg add "HKCU\\Software\\Adobe\\CSXS.$CSXS_VERSION" /v PlayerDebugMode /t REG_SZ /d 1 /f >/dev/null
fi

echo "▸ Ligando a extensão em $EXTENSIONS_DIR…"
mkdir -p "$EXTENSIONS_DIR"
TARGET="$EXTENSIONS_DIR/$EXTENSION_NAME"
rm -rf "$TARGET"
ln -s "$EXTENSION_SRC" "$TARGET"

cat <<EOF

✓ Pronto.

  Reinicie o After Effects e abra:
      Window → Extensions → Vectorize AE

  Para depurar o painel, com ele aberto acesse:
      http://localhost:8088

  Como é um symlink, basta rodar 'npm run build --prefix packages/cep' e recarregar
  o painel (clique direito → Reload) depois de mexer no código.
EOF
