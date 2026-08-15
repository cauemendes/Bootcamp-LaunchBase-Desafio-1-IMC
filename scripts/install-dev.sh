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

# Cada versão do host usa um domínio de preferências CSXS diferente, e o número não
# acompanha a versão do After Effects: CSXS.11 atende do CC 2021 em diante, mas
# versões mais novas podem passar para 12 ou além. Escrever PlayerDebugMode no
# domínio errado é a causa mais comum de "instalei e o painel não aparece" — sem
# erro, sem aviso, o painel simplesmente não existe no menu.
#
# Como escrever numa versão que o host não usa é inofensivo, marcamos a faixa toda.
CSXS_VERSIONS="10 11 12 13 14"

case "$(uname -s)" in
  Darwin)  PLATFORM="mac";     EXTENSIONS_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions" ;;
  MINGW*|MSYS*|CYGWIN*)
           PLATFORM="windows"; EXTENSIONS_DIR="$APPDATA/Adobe/CEP/extensions" ;;
  *)
    echo "Este script cobre macOS e Windows (Git Bash). O CEP não roda em Linux." >&2
    exit 1
    ;;
esac

echo "▸ Compilando o painel…"
npm --prefix "$EXTENSION_SRC" run build

echo "▸ Habilitando extensões não assinadas (PlayerDebugMode) em CSXS $CSXS_VERSIONS…"
for v in $CSXS_VERSIONS; do
  if [ "$PLATFORM" = "mac" ]; then
    defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1
  else
    reg add "HKCU\\Software\\Adobe\\CSXS.$v" /v PlayerDebugMode /t REG_SZ /d 1 /f >/dev/null
  fi
done

if [ "$PLATFORM" = "mac" ]; then
  # Sem isso o macOS pode continuar servindo o valor antigo em cache pelo daemon de
  # preferências, e o ajuste só valeria depois de um logout.
  killall cfprefsd 2>/dev/null || true
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
