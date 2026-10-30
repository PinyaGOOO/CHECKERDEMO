#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_NAME="${SERVICE_NAME:-web-demo-checker}"
REPO_URL="${REPO_URL:-https://github.com/PinyaGOOO/CHECKERDEMO.git}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/web-demo-checker}"
CONFIG_DIR="${CONFIG_DIR:-/etc/web-demo-checker}"
PORT="${PORT:-8007}"
CONSOLE_HTTPS_PORT="${CONSOLE_HTTPS_PORT:-8443}"
NODE_MAJOR="${NODE_MAJOR:-20}"
SKIP_PACKAGES="${SKIP_PACKAGES:-0}"
REGENERATE_TLS="${REGENERATE_TLS:-0}"

log() { printf '\n[%s] %s\n' "${SERVICE_NAME}" "$*"; }
fail() { printf '\n[%s] ERROR: %s\n' "${SERVICE_NAME}" "$*" >&2; exit 1; }

[[ "${EUID}" -eq 0 ]] || fail "запустите установщик от root"
command -v pvesh >/dev/null 2>&1 || fail "pvesh не найден: установку нужно выполнять на Proxmox VE"
command -v qm >/dev/null 2>&1 || fail "qm не найден: установку нужно выполнять на Proxmox VE"
[[ "${PORT}" =~ ^[0-9]+$ ]] && (( PORT > 0 && PORT < 65536 )) || fail "некорректный PORT"
[[ "${CONSOLE_HTTPS_PORT}" =~ ^[0-9]+$ ]] && (( CONSOLE_HTTPS_PORT > 0 && CONSOLE_HTTPS_PORT < 65536 )) || fail "некорректный CONSOLE_HTTPS_PORT"
[[ "${PORT}" != "${CONSOLE_HTTPS_PORT}" ]] || fail "HTTP и HTTPS порты должны различаться"

if [[ "${SKIP_PACKAGES}" != "1" ]]; then
  log "Установка системных зависимостей"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl git openssl tcpdump pamtester

  installed_major=0
  if command -v node >/dev/null 2>&1; then
    installed_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  fi
  if (( installed_major < NODE_MAJOR )); then
    setup_script="$(mktemp /tmp/nodesource-setup.XXXXXX)"
    trap 'rm -f "${setup_script:-}"' EXIT
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o "${setup_script}"
    bash "${setup_script}"
    rm -f "${setup_script}"
    trap - EXIT
    apt-get install -y nodejs
  fi
fi

command -v node >/dev/null 2>&1 || fail "Node.js не найден"
command -v npm >/dev/null 2>&1 || fail "npm не найден"
node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
(( node_major >= 20 )) || fail "требуется Node.js 20+, установлен $(node --version)"

log "Установка исходного кода в ${INSTALL_DIR}"
if [[ -d "${INSTALL_DIR}/.git" ]]; then
  git -C "${INSTALL_DIR}" diff --quiet || fail "в ${INSTALL_DIR} есть незакоммиченные изменения"
  git -C "${INSTALL_DIR}" diff --cached --quiet || fail "в ${INSTALL_DIR} есть подготовленные изменения"
  git -C "${INSTALL_DIR}" fetch --prune origin
  git -C "${INSTALL_DIR}" checkout "${BRANCH}"
  git -C "${INSTALL_DIR}" pull --ff-only origin "${BRANCH}"
elif [[ -e "${INSTALL_DIR}" ]] && [[ -n "$(find "${INSTALL_DIR}" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
  fail "каталог ${INSTALL_DIR} существует и не является чистым Git-репозиторием"
else
  mkdir -p "$(dirname "${INSTALL_DIR}")"
  git clone --branch "${BRANCH}" --depth 1 "${REPO_URL}" "${INSTALL_DIR}"
fi

log "Установка Node.js-зависимостей и запуск тестов"
npm_config_fetch_retries="${NPM_FETCH_RETRIES:-2}" \
npm_config_fetch_retry_maxtimeout="${NPM_FETCH_RETRY_MAXTIMEOUT:-10000}" \
npm_config_fetch_timeout="${NPM_FETCH_TIMEOUT:-20000}" \
  npm --prefix "${INSTALL_DIR}" ci --omit=dev --prefer-offline --no-audit --no-fund
npm --prefix "${INSTALL_DIR}" test

log "Подготовка TLS"
install -d -m 0700 "${CONFIG_DIR}"
tls_key="${CONFIG_DIR}/tls.key"
tls_cert="${CONFIG_DIR}/tls.crt"
if [[ "${REGENERATE_TLS}" == "1" || ! -s "${tls_key}" || ! -s "${tls_cert}" ]]; then
  node_name="$(hostname -f 2>/dev/null || hostname)"
  node_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  san="DNS:${node_name},DNS:$(hostname)"
  [[ -z "${node_ip}" ]] || san="${san},IP:${node_ip}"
  openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 825 \
    -keyout "${tls_key}" -out "${tls_cert}" \
    -subj "/CN=${node_name}" -addext "subjectAltName=${san}"
fi
chmod 0600 "${tls_key}"
chmod 0644 "${tls_cert}"

cat > "${CONFIG_DIR}/checker.env" <<EOF
NODE_ENV=production
PORT=${PORT}
CONSOLE_HTTPS_PORT=${CONSOLE_HTTPS_PORT}
CONSOLE_TLS_KEY=${tls_key}
CONSOLE_TLS_CERT=${tls_cert}
CHECKER_MODE=live
CHECKER_TRANSPORT=local
EOF
chmod 0600 "${CONFIG_DIR}/checker.env"

log "Установка systemd-службы"
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Web Demo Checker assessment service
After=network-online.target pve-cluster.service
Wants=network-online.target

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=${INSTALL_DIR}
ExecStart=$(command -v node) ${INSTALL_DIR}/src/server.js
EnvironmentFile=${CONFIG_DIR}/checker.env
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_PACKET

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.service"
systemctl restart "${SERVICE_NAME}.service"

log "Проверка сервиса"
http_ok=0
https_ok=0
for _ in {1..20}; do
  curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 && http_ok=1 || true
  curl -kfsS "https://127.0.0.1:${CONSOLE_HTTPS_PORT}/api/console/session" >/dev/null 2>&1 && https_ok=1 || true
  if (( http_ok == 1 && https_ok == 1 )); then
    break
  fi
  sleep 0.5
done

if (( http_ok != 1 || https_ok != 1 )); then
  systemctl --no-pager --full status "${SERVICE_NAME}.service" || true
  journalctl -u "${SERVICE_NAME}.service" -n 50 --no-pager || true
  fail "сервис запущен, но проверка портов не пройдена"
fi

node_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
node_ip="${node_ip:-127.0.0.1}"
log "Установка завершена"
printf 'Панель:   http://%s:%s/\n' "${node_ip}" "${PORT}"
printf 'Консоли: https://%s:%s/consoles.html\n' "${node_ip}" "${CONSOLE_HTTPS_PORT}"
printf 'Статус:  systemctl status %s\n' "${SERVICE_NAME}"
printf '\nОграничьте доступ к портам %s и %s правилами firewall.\n' "${PORT}" "${CONSOLE_HTTPS_PORT}"
