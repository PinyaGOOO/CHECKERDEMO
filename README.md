# Web Demo Checker

Веб-панель автопроверки стенда демонстрационного экзамена на Proxmox VE. Сервис запускается непосредственно на Proxmox-ноде, получает инвентарь через `pvesh`, выполняет команды в Linux-гостях через QEMU Guest Agent и проверяет EcoRouter через `serial0`.

Основная панель: `http://<IP-ноды>:8007/`
Центр консолей: `https://<IP-ноды>:8443/consoles.html`

## Возможности

- живая инвентаризация VM 100–106 и отображение состояния стенда;
- пошаговая проверка с прогрессом, командами и доказательствами;
- проверка hostname, адресации RFC1918, масок и связности сегментов;
- проверка VLAN 100/200/999 и тегов Proxmox;
- проверка WAN, маршрута по умолчанию, NAT, GRE/IPIP, OSPF и MD5;
- проверка DHCP на HQ-RTR и получения параметров на HQ-CLI;
- проверка часового пояса, пользователей, `sudo`, SSH и DNS A/PTR;
- отдельная страница со всеми критериями модуля 1 из оценочной ведомости;
- единый снимок `show running-config` для всех статических проверок каждого EcoRouter;
- централизованные xterm.js-консоли, VNC для HQ-CLI и BR-FW;
- режим визуализации реального трафика на основе `tcpdump`.

BR-FW пока не участвует в автоматической оценке.

## Требования

- Proxmox VE на Debian;
- права `root` на ноде;
- Node.js 20 или новее;
- включённый QEMU Guest Agent в Linux VM;
- `serial0` у HQ-RTR и BR-RTR;
- VMID стенда:

| VMID | Устройство |
|---:|---|
| 100 | ISP |
| 101 | HQ-RTR |
| 102 | BR-RTR |
| 103 | BR-FW |
| 104 | HQ-SRV |
| 105 | BR-SRV |
| 106 | HQ-CLI |

Для EcoRouter в описании VM должна быть первая непустая строка с учётными данными в формате `пользователь:пароль`. Значение хранится в конфигурации Proxmox и не передаётся браузеру.

## Автоматическая установка

На Proxmox-ноде:

```bash
git clone https://github.com/PinyaGOOO/CHECKERDEMO.git /tmp/web-demo-checker
cd /tmp/web-demo-checker
sudo ./deploy/install.sh
```

Установщик:

1. проверит, что запуск выполняется на Proxmox от `root`;
2. установит Node.js 20 и системные зависимости;
3. клонирует или обновит проект в `/opt/web-demo-checker`;
4. установит production-зависимости через `npm ci`;
5. создаст самоподписанный TLS-сертификат;
6. установит и запустит `web-demo-checker.service`;
7. проверит HTTP API на 8007 и HTTPS-консоли на 8443.

Повторный запуск скрипта выполняет обновление без удаления настроек и TLS-сертификата. Рабочее дерево в `/opt/web-demo-checker` должно быть чистым.

Доступные параметры:

```bash
PORT=8007 \
CONSOLE_HTTPS_PORT=8443 \
BRANCH=main \
INSTALL_DIR=/opt/web-demo-checker \
sudo -E ./deploy/install.sh
```

Для установки без `apt` (например, когда зависимости уже подготовлены):

```bash
sudo SKIP_PACKAGES=1 ./deploy/install.sh
```

## Управление службой

```bash
systemctl status web-demo-checker
journalctl -u web-demo-checker -f
systemctl restart web-demo-checker
```

Проверка API:

```bash
curl http://127.0.0.1:8007/api/health
```

Обновление выполняется повторным запуском установщика:

```bash
cd /opt/web-demo-checker
sudo ./deploy/install.sh
```

## Ручной запуск для разработки

```bash
npm ci
npm test
npm start
```

По умолчанию приложение использует SSH-алиас `checker`. Для запуска непосредственно на Proxmox-ноде:

```bash
CHECKER_MODE=live CHECKER_TRANSPORT=local npm start
```

Основные переменные окружения:

| Переменная | Значение по умолчанию | Назначение |
|---|---|---|
| `PORT` | `8007` | HTTP-порт основной панели |
| `CONSOLE_HTTPS_PORT` | `8443` | HTTPS-порт центра консолей |
| `CHECKER_MODE` | `mock` | отображаемый режим приложения |
| `CHECKER_TRANSPORT` | `ssh` | `local` на Proxmox или `ssh` для разработки |
| `CHECKER_SSH_ALIAS` | `checker` | SSH-алиас Proxmox при удалённом запуске |
| `CONSOLE_TLS_KEY` | `/etc/web-demo-checker/tls.key` | закрытый ключ HTTPS |
| `CONSOLE_TLS_CERT` | `/etc/web-demo-checker/tls.crt` | сертификат HTTPS |

## Безопасность

Сервис работает от `root`, поскольку ему необходимы `qm`, `pvesh`, serial-сокеты, VNC Proxy и захват трафика. Центр консолей автоматически открывает привилегированные консоли VM.

**Не публикуйте порты 8007 и особенно 8443 в недоверенную сеть.** Ограничьте доступ правилами Proxmox Firewall, внешним межсетевым экраном или отдельной управляющей сетью. Самоподписанный сертификат шифрует соединение, но не заменяет контроль доступа.

## Тесты

```bash
npm test
```

Тесты проверяют парсеры EcoRouter, адресацию, DHCP, VLAN, OSPF, пользователей, SSH, DNS и повторное использование единого снимка конфигурации.
