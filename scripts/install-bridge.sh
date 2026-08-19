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

# O painel vai como ARQUIVO ÚNICO, com os includes já resolvidos.
#
# Copiar `bridge-panel.jsx` mais a pasta `lib/` parecia mais simples, mas a
# resolução de //@include muda de comportamento quando o script está dentro do
# pacote do aplicativo — e quando falha, falha em silêncio: o painel abre, a
# interface aparece, e só na primeira chamada é que se descobre que as funções não
# existem. Empacotar elimina a classe inteira de erro.
echo "▸ Empacotando o painel num arquivo só…"
BUNDLE="$REPO_ROOT/dist/bridge-panel.jsx"
node "$REPO_ROOT/scripts/bundle-jsx.mjs" "$JSX_DIR/bridge-panel.jsx" "$BUNDLE"

# A pasta de painéis fica dentro do pacote do aplicativo e exige administrador.
#
# Quando este script é chamado por um agente (Claude Code, CI, qualquer coisa sem
# terminal interativo), o sudo não tem como mostrar o prompt de senha e falha na
# hora — mas o `set -e` aborta antes de copiar, e o sintoma que aparece é "o painel
# não está no menu Window", que não sugere nada disso.
#
# Detectar aqui e explicar vale mais que deixar falhar lá na frente.
if [ -w "$PANELS_DIR" ]; then
  SUDO=""
elif sudo -n true 2>/dev/null || [ -t 0 ]; then
  echo "▸ A pasta de painéis exige permissão de administrador — vou pedir sua senha."
  SUDO="sudo"
else
  cat >&2 <<MSG

✗ Preciso de permissão de administrador, mas não há terminal interativo para
  pedir a senha — provavelmente este script foi chamado por um agente.

  DUAS SAÍDAS:

  A) Sem instalar nada (mais rápido, e é o que eu recomendo agora):
     No After Effects, use File → Scripts → Run Script File… e escolha
         $REPO_ROOT/dist/bridge-panel.jsx
     O painel abre como janela flutuante e funciona igual. Só precisa repetir
     quando reiniciar o After Effects.

  B) Instalar de forma permanente (painel encaixável):
     Abra o Terminal.app — não o Claude Code — e rode:
         bash "$REPO_ROOT/scripts/install-bridge.sh"

MSG
  # O bundle já está pronto, então a saída A funciona imediatamente.
  echo "▸ Bundle gerado em: $BUNDLE" >&2
  exit 1
fi

# Remove a instalação antiga com includes, se existir. Deixar a pasta lib/ para trás
# faria o painel velho continuar carregável e confundir o diagnóstico.
$SUDO rm -rf "$PANELS_DIR/lib"
$SUDO cp "$BUNDLE" "$PANELS_DIR/bridge-panel.jsx"

echo "▸ Instalado em: $PANELS_DIR/bridge-panel.jsx"

# ---- cópias duplicadas -------------------------------------------------------
#
# O After Effects carrega painéis de DUAS pastas: a de dentro do pacote do
# aplicativo, que é a que este script usa, e uma por usuário em
# ~/Library/Application Support. Uma cópia velha na segunda continua aparecendo no
# menu Window e continua carregável.
#
# Isso produz o diagnóstico mais caro que este projeto já teve. Você copia o arquivo
# novo, confere o número de build no arquivo copiado, ele está certo — e o After
# Effects carrega o outro. Todo defeito já corrigido reaparece, e a leitura natural
# ("a correção está errada") é falsa. Não há sintoma que aponte para cá.
USER_PANELS="$HOME/Library/Application Support/Adobe/$(basename "$AE_APP")/Scripts/ScriptUI Panels"
DUPLICATA="$USER_PANELS/bridge-panel.jsx"

if [ -f "$DUPLICATA" ]; then
  BUILD_DUP="$(grep -m1 -o 'VEC_PANEL_BUILD = [0-9]*' "$DUPLICATA" || echo 'sem marca de build')"
  echo "▸ Achei outra cópia do painel — e ela competia com esta:"
  echo "    $DUPLICATA  ($BUILD_DUP)"

  # Só remove o que é comprovadamente nosso.
  if grep -q "Vectorize AE Bridge" "$DUPLICATA"; then
    rm -f "$DUPLICATA"
    rm -rf "$USER_PANELS/lib"
    echo "    removida — agora há uma instalação só."
  else
    echo "    NÃO removi: este arquivo não parece ser o painel deste projeto."
    echo "    Confira e apague à mão, senão o After Effects pode carregar o errado."
  fi
fi

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
