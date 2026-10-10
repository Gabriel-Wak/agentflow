#!/bin/zsh
# Always Flow 24h — mantém o daemon da Orquestra e o app rodando neste Mac (launchd).
#
#   scripts/alwaysflow-24h.sh instalar     # compila o app, instala e liga os serviços
#   scripts/alwaysflow-24h.sh status       # mostra se está tudo no ar
#   scripts/alwaysflow-24h.sh logs         # últimas linhas dos logs
#   scripts/alwaysflow-24h.sh reiniciar    # reinicia os serviços (ex.: depois de atualizar o código)
#   scripts/alwaysflow-24h.sh desinstalar  # desliga e remove os serviços
#
# Os serviços rodam com o seu usuário (precisam do login do Claude Code, do gh e do perfil MySQL).
set -euo pipefail

PROJ="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/.agentflow/logs"
PORT_APP="${ALWAYSFLOW_PORT:-3001}"
PORT_DAEMON="${ORQUESTRA_PORT:-4545}"
LABELS=(com.alwaysfit.alwaysflow.daemon com.alwaysfit.alwaysflow.web com.alwaysfit.alwaysflow.acordado)
UID_NUM="$(id -u)"

ok() { print -P "%F{green}✔%f $1"; }
warn() { print -P "%F{yellow}!%f $1"; }
err() { print -P "%F{red}✖%f $1" >&2; }

# PATH do seu shell de login: o launchd começa quase vazio e não acharia claude/gh/mysql/node.
login_path() { zsh -lic 'print -r -- $PATH' 2>/dev/null | tail -1; }

plist() { # label, comando, log
  cat > "$AGENTS/$1.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>-c</string><string>$2</string></array>
  <key>WorkingDirectory</key><string>$PROJ</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$PATH_LOGIN</string>
    <key>HOME</key><string>$HOME</string>
    <key>LANG</key><string>pt_BR.UTF-8</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$3</string>
  <key>StandardErrorPath</key><string>$3</string>
</dict>
</plist>
EOF
}

port_owner() { lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2" "$1; exit}'; }

free_port() { # porta, nome
  local who; who="$(port_owner "$1")"
  [[ -z "$who" ]] && return 0
  local pid="${who%% *}"
  # Serviço nosso do launchd? Ele será recarregado, sem perguntar.
  if launchctl print "gui/$UID_NUM" 2>/dev/null | grep -q "com.alwaysfit.alwaysflow"; then return 0; fi
  warn "A porta $1 ($2) está em uso pelo processo $who."
  read -q "?Encerrar esse processo para o serviço 24h assumir? [s/N] " && { print; kill "$pid"; sleep 2; } || { print; err "Libere a porta $1 e rode de novo."; exit 1; }
}

check_prereqs() {
  local missing=0
  for c in node npm claude gh mysql; do
    if ! PATH="$PATH_LOGIN" command -v "$c" >/dev/null; then err "não encontrei '$c' no PATH"; missing=1; fi
  done
  (( missing )) && exit 1
  PATH="$PATH_LOGIN" gh auth status >/dev/null 2>&1 && ok "GitHub (gh) autenticado" || warn "gh sem login — rode: gh auth login (os repositórios não vão sincronizar)"
  if PATH="$PATH_LOGIN" mysql --login-path=alwaysfit-readonly --batch -e "select 1" >/dev/null 2>&1; then
    ok "Banco Always Fit (perfil alwaysfit-readonly) respondendo"
  else
    warn "Perfil MySQL 'alwaysfit-readonly' ausente ou sem acesso — o banco fica desligado até você criar:"
    print "    mysql_config_editor set --login-path=alwaysfit-readonly --host=read-db-homolog-mysql.c3q0u4ksqqea.sa-east-1.rds.amazonaws.com --port=3306 --user=gabriel.bezerra --password"
  fi
  [[ -f "$PROJ/.env.local" ]] || { err "falta $PROJ/.env.local (copie de .env.example)"; exit 1; }
}

instalar() {
  PATH_LOGIN="$(login_path)"
  check_prereqs
  mkdir -p "$AGENTS" "$LOGS"
  chmod 700 "$HOME/.agentflow" "$LOGS"

  print "Compilando o app (produção)..."
  ( cd "$PROJ" && PATH="$PATH_LOGIN" npm run build >"$LOGS/build.log" 2>&1 ) || { err "o build falhou — veja $LOGS/build.log"; exit 1; }
  ok "App compilado"

  free_port "$PORT_DAEMON" "daemon da Orquestra"
  free_port "$PORT_APP" "app"

  plist com.alwaysfit.alwaysflow.daemon "ORQUESTRA_CAFFEINATE=0 exec npm run orquestra" "$LOGS/daemon.log"
  plist com.alwaysfit.alwaysflow.web "exec npm run start -- -p $PORT_APP" "$LOGS/web.log"
  # Impede o Mac de dormir (com a tampa aberta ou monitor externo). -i: ocioso, -m: disco, -s: na tomada.
  plist com.alwaysfit.alwaysflow.acordado "exec /usr/bin/caffeinate -ims" "$LOGS/acordado.log"

  for l in "${LABELS[@]}"; do
    launchctl bootout "gui/$UID_NUM/$l" 2>/dev/null || true
    launchctl bootstrap "gui/$UID_NUM" "$AGENTS/$l.plist"
  done
  sleep 6
  status
  local token; token="$(cat "$HOME/.agentflow/orquestra-token" 2>/dev/null || true)"
  print
  ok "Always Flow 24h instalado. Abra: http://localhost:$PORT_APP/orquestra${token:+#token=$token}"
  print "  Na Orquestra, monte a formação (ex.: Sustentação 24h) e clique em \"Manter esta formação rodando 24h\"."
  warn "MacBook: com a tampa FECHADA o Mac dorme mesmo assim (a não ser com carregador + monitor externo). Deixe a tampa aberta."
}

status() {
  for l in "${LABELS[@]}"; do
    if launchctl print "gui/$UID_NUM/$l" >/dev/null 2>&1; then
      local st; st="$(launchctl print "gui/$UID_NUM/$l" | awk -F'= ' '/^\tstate/{print $2; exit}')"
      [[ "$st" == "running" ]] && ok "$l: rodando" || warn "$l: $st"
    else
      warn "$l: não instalado"
    fi
  done
  curl -fsS "http://127.0.0.1:$PORT_DAEMON/health" >/dev/null 2>&1 && ok "daemon respondendo em :$PORT_DAEMON" || warn "daemon não respondeu em :$PORT_DAEMON"
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT_APP/login" 2>/dev/null && ok "app respondendo em :$PORT_APP" || warn "app não respondeu em :$PORT_APP"
}

logs() { for f in daemon web; do print -P "%B== $f ==%b"; tail -n 25 "$LOGS/$f.log" 2>/dev/null || true; done; }

reiniciar() {
  PATH_LOGIN="$(login_path)"
  ( cd "$PROJ" && PATH="$PATH_LOGIN" npm run build >"$LOGS/build.log" 2>&1 ) || { err "o build falhou — veja $LOGS/build.log"; exit 1; }
  for l in "${LABELS[@]}"; do launchctl kickstart -k "gui/$UID_NUM/$l" 2>/dev/null || true; done
  sleep 6; status
}

desinstalar() {
  for l in "${LABELS[@]}"; do
    launchctl bootout "gui/$UID_NUM/$l" 2>/dev/null || true
    rm -f "$AGENTS/$l.plist"
  done
  ok "Serviços removidos (rotinas, relatórios e partituras continuam em ~/.agentflow)."
}

case "${1:-}" in
  instalar) instalar ;;
  status) status ;;
  logs) logs ;;
  reiniciar) reiniciar ;;
  desinstalar) desinstalar ;;
  *) print "uso: $0 instalar | status | logs | reiniciar | desinstalar"; exit 1 ;;
esac
