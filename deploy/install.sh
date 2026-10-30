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
LAB_VMIDS="${LAB_VMIDS:-100 101 102 103 104 105 106}"
QGA_GUEST_VMIDS="${QGA_GUEST_VMIDS:-100 104 105 106}"
ALT_ISO_NAME="${ALT_ISO_NAME:-alt-server-11.1-x86_64.iso}"
ALT_ISO_URL="${ALT_ISO_URL:-https://download.basealt.ru/pub/distributions/ALTLinux/p11/images/server/x86_64/${ALT_ISO_NAME}}"
ALT_ISO_SHA512_URL="${ALT_ISO_SHA512_URL:-https://download.basealt.ru/pub/distributions/ALTLinux/p11/images/server/x86_64/SHA512SUM}"
ISO_STORAGE="${ISO_STORAGE:-}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '\n[%s] %s\n' "${SERVICE_NAME}" "$*"; }
fail() { printf '\n[%s] ERROR: %s\n' "${SERVICE_NAME}" "$*" >&2; exit 1; }
detect_ip() {
  local addresses route_address
  addresses="$(hostname -I 2>/dev/null || true)"
  if [[ -n "${addresses}" ]]; then
    printf '%s\n' "${addresses%% *}"
    return
  fi
  route_address="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1; i<=NF; i++) if ($i == "src") {print $(i+1); exit}}' || true)"
  printf '%s\n' "${route_address}"
}

select_iso_storage() {
  local status_output choice item index
  local -a storages=()
  status_output="$(pvesm status --content iso)"
  mapfile -t storages < <(awk 'NR > 1 && $3 == "active" {print $1}' <<<"${status_output}")
  (( ${#storages[@]} > 0 )) || fail "не найдено активных хранилищ с поддержкой ISO"

  if [[ -n "${ISO_STORAGE}" ]]; then
    for item in "${storages[@]}"; do
      [[ "${item}" == "${ISO_STORAGE}" ]] && return
    done
    fail "хранилище ${ISO_STORAGE} недоступно или не поддерживает ISO"
  fi

  [[ -t 0 && -r /dev/tty ]] || fail "интерактивный выбор хранилища недоступен; задайте ISO_STORAGE"
  printf '\n[%s] Доступные хранилища для ISO:\n' "${SERVICE_NAME}"
  index=1
  for item in "${storages[@]}"; do
    printf '  %d) %s\n' "${index}" "$(awk -v name="${item}" 'NR > 1 && $1 == name {print $0}' <<<"${status_output}")"
    ((index += 1))
  done
  printf '[%s] Выберите хранилище [1-%d]: ' "${SERVICE_NAME}" "${#storages[@]}"
  read -r choice </dev/tty
  [[ "${choice}" =~ ^[0-9]+$ ]] || fail "нужно указать номер хранилища"
  (( choice >= 1 && choice <= ${#storages[@]} )) || fail "номер хранилища вне диапазона"
  ISO_STORAGE="${storages[choice-1]}"
}

download_alt_iso() {
  local iso_path partial checksum_file expected actual
  [[ "${ALT_ISO_NAME}" =~ ^[A-Za-z0-9._-]+\.iso$ ]] || fail "некорректное имя ALT_ISO_NAME"
  command -v curl >/dev/null 2>&1 || fail "curl необходим для загрузки ALT ISO"
  command -v sha512sum >/dev/null 2>&1 || fail "sha512sum необходим для проверки ALT ISO"
  select_iso_storage
  ALT_ISO_VOLID="${ISO_STORAGE}:iso/${ALT_ISO_NAME}"
  iso_path="$(pvesm path "${ALT_ISO_VOLID}")"
  install -d "$(dirname "${iso_path}")"

  if [[ -s "${iso_path}" ]]; then
    log "ISO уже загружен: ${ALT_ISO_VOLID}"
    return
  fi

  log "Загрузка ${ALT_ISO_URL} в ${ALT_ISO_VOLID}"
  partial="${iso_path}.part"
  curl -fL --retry 3 --retry-delay 3 --continue-at - --progress-bar -o "${partial}" "${ALT_ISO_URL}"
  mv -f "${partial}" "${iso_path}"

  checksum_file="$(mktemp /tmp/alt-iso-sha512.XXXXXX)"
  if ! curl -fsSL --retry 3 -o "${checksum_file}" "${ALT_ISO_SHA512_URL}"; then
    rm -f "${checksum_file}"
    fail "не удалось загрузить SHA512SUM для ISO"
  fi
  expected="$(awk -v name="${ALT_ISO_NAME}" '$NF == name || $NF == "./" name {print $1; exit}' "${checksum_file}")"
  rm -f "${checksum_file}"
  [[ "${expected}" =~ ^[a-fA-F0-9]{128}$ ]] || fail "в SHA512SUM отсутствует ${ALT_ISO_NAME}"
  actual="$(sha512sum "${iso_path}" | awk '{print $1}')"
  if [[ "${actual,,}" != "${expected,,}" ]]; then
    rm -f "${iso_path}"
    fail "контрольная сумма ISO не совпала; повреждённый файл удалён"
  fi
  log "ISO загружен и проверен: ${ALT_ISO_VOLID}"
}

attach_alt_iso_if_needed() {
  local vmid line volid media_path
  for vmid in ${QGA_GUEST_VMIDS}; do
    line="$(qm config "${vmid}" | awk -F': ' '$2 ~ /media=cdrom/ {print $2; exit}')"
    volid="${line%%,*}"
    media_path=""
    if [[ -n "${volid}" ]]; then media_path="$(pvesm path "${volid}" 2>/dev/null || true)"; fi
    if [[ -n "${media_path}" && -s "${media_path}" ]]; then
      log "VM ${vmid}: используется подключённый ISO ${volid}"
      continue
    fi
    log "VM ${vmid}: подключение ${ALT_ISO_VOLID} к ide2"
    qm set "${vmid}" --ide2 "${ALT_ISO_VOLID},media=cdrom"
  done
}

qga_enabled_in_config() {
  local vmid="$1" agent
  agent="$(qm config "${vmid}" | awk -F': ' '$1 == "agent" {print $2; exit}')"
  [[ "${agent}" =~ ^1(,|$) || "${agent}" =~ (^|,)enabled=1(,|$) ]]
}

prepare_qga_devices() {
  local vmid status
  local -a vmids=() missing=()

  for vmid in ${LAB_VMIDS}; do
    [[ "${vmid}" =~ ^[0-9]+$ ]] || fail "некорректный VMID в LAB_VMIDS: ${vmid}"
    qm status "${vmid}" >/dev/null 2>&1 || fail "VM ${vmid} из LAB_VMIDS не найдена"
    vmids+=("${vmid}")
    qga_enabled_in_config "${vmid}" || missing+=("${vmid}")
  done
  (( ${#vmids[@]} > 0 )) || fail "LAB_VMIDS не содержит VMID"

  if (( ${#missing[@]} == 0 )); then
    log "QEMU Guest Agent уже включён в настройках VM ${LAB_VMIDS}"
    return
  fi

  log "QEMU Guest Agent выключен у VM: ${missing[*]}"
  printf '[%s] ВНИМАНИЕ: для применения настройки все VM (%s) будут жёстко остановлены командой qm stop и запущены снова.\n' "${SERVICE_NAME}" "${LAB_VMIDS}"

  for vmid in "${missing[@]}"; do
    log "Включение QEMU Guest Agent в конфигурации VM ${vmid}"
    qm set "${vmid}" --agent enabled=1
  done

  log "Жёсткая остановка VM ${LAB_VMIDS}"
  for vmid in "${vmids[@]}"; do
    status="$(qm status "${vmid}" | awk '{print $2}')"
    if [[ "${status}" == "running" ]]; then
      qm stop "${vmid}"
    fi
  done

  log "Запуск VM ${LAB_VMIDS}"
  for vmid in "${vmids[@]}"; do
    qm start "${vmid}"
  done

  for vmid in "${vmids[@]}"; do
    status="$(qm status "${vmid}" | awk '{print $2}')"
    [[ "${status}" == "running" ]] || fail "VM ${vmid} не запустилась после включения QEMU Guest Agent"
  done
}

[[ "${EUID}" -eq 0 ]] || fail "запустите установщик от root"
command -v pvesh >/dev/null 2>&1 || fail "pvesh не найден: установку нужно выполнять на Proxmox VE / ALT Virtualization"
command -v qm >/dev/null 2>&1 || fail "qm не найден: установку нужно выполнять на Proxmox VE / ALT Virtualization"
[[ "${PORT}" =~ ^[0-9]+$ ]] && (( PORT > 0 && PORT < 65536 )) || fail "некорректный PORT"
[[ "${CONSOLE_HTTPS_PORT}" =~ ^[0-9]+$ ]] && (( CONSOLE_HTTPS_PORT > 0 && CONSOLE_HTTPS_PORT < 65536 )) || fail "некорректный CONSOLE_HTTPS_PORT"
[[ "${PORT}" != "${CONSOLE_HTTPS_PORT}" ]] || fail "HTTP и HTTPS порты должны различаться"

download_alt_iso
attach_alt_iso_if_needed
prepare_qga_devices

if [[ "${SKIP_PACKAGES}" != "1" ]]; then
  log "Установка системных зависимостей"
  [[ -r /etc/os-release ]] || fail "/etc/os-release не найден: невозможно определить ОС"
  # shellcheck disable=SC1091
  . /etc/os-release
  os_id="${ID,,}"
  case "${os_id}" in
    altlinux)
      # ALT p11 ships a current Node.js as the `node` package. NodeSource's
      # Debian bootstrapper must not be used here: it intentionally rejects ALT.
      apt-get update
      apt-get install -y ca-certificates curl git openssl tcpdump pamtester node npm
      ;;
    debian|ubuntu)
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
      ;;
    *)
      fail "ОС ${PRETTY_NAME:-${os_id}} пока не поддерживается установщиком"
      ;;
  esac
fi

command -v node >/dev/null 2>&1 || fail "Node.js не найден"
command -v npm >/dev/null 2>&1 || fail "npm не найден"
node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
(( node_major >= NODE_MAJOR )) || fail "требуется Node.js ${NODE_MAJOR}+, установлен $(node --version)"

log "Установка QEMU Guest Agent внутри Linux VM ${QGA_GUEST_VMIDS}"
checker_was_active=0
if systemctl is-active --quiet "${SERVICE_NAME}.service" 2>/dev/null; then
  checker_was_active=1
  systemctl stop "${SERVICE_NAME}.service"
fi
if ! QGA_GUEST_VMIDS="${QGA_GUEST_VMIDS}" node "${SCRIPT_DIR}/bootstrap-qga.mjs"; then
  (( checker_was_active == 0 )) || systemctl start "${SERVICE_NAME}.service" || true
  fail "не удалось подготовить QEMU Guest Agent внутри Linux VM"
fi
(( checker_was_active == 0 )) || systemctl start "${SERVICE_NAME}.service"

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
  node_ip="$(detect_ip)"
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

node_ip="$(detect_ip)"
node_ip="${node_ip:-127.0.0.1}"
log "Установка завершена"
printf 'Панель:   http://%s:%s/\n' "${node_ip}" "${PORT}"
printf 'Консоли: https://%s:%s/consoles.html\n' "${node_ip}" "${CONSOLE_HTTPS_PORT}"
printf 'Статус:  systemctl status %s\n' "${SERVICE_NAME}"
printf '\nОграничьте доступ к портам %s и %s правилами firewall.\n' "${PORT}" "${CONSOLE_HTTPS_PORT}"
