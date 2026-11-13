#!/usr/bin/env bash
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo 'Запустите под root'; exit 1; }
[ -x /opt/tko-node/bin/node ] || { echo 'Не найден /opt/tko-node/bin/node'; exit 1; }
cd /opt/tko-mno
/opt/tko-node/bin/node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
if ss -ltnH 'sport = :8788' | grep -q . && ! systemctl is-active --quiet tko-mno; then
  echo 'Порт 8788 уже занят другим приложением'; exit 1
fi
if ! getent passwd tko-mno >/dev/null; then
  useradd --system --user-group --home-dir /var/lib/tko-mno --shell /usr/sbin/nologin tko-mno
fi
if [ ! -e /etc/tko-mno.env ]; then
  read -rsp 'Вставьте новый API-ключ OpenAI (ввод скрыт): ' mno_key
  printf '\n'
  [[ "$mno_key" =~ ^[A-Za-z0-9_-]{20,}$ ]] || { unset mno_key; echo 'Некорректный формат ключа'; exit 1; }
  (
    umask 077
    printf 'OPENAI_API_KEY=%s\nOPENAI_MODEL=gpt-4.1-mini\nPORT=8788\nPUBLIC_ORIGIN=https://mno.megaev.ru\n' "$mno_key" > /etc/tko-mno.env
  )
  unset mno_key
fi
chown root:tko-mno /etc/tko-mno.env
chmod 640 /etc/tko-mno.env
runuser -u tko-mno -- /opt/tko-node/bin/node --test server/test/*.test.js
install -m 644 server/deploy/tko-mno.service /etc/systemd/system/tko-mno.service
systemctl daemon-reload
systemctl enable --now tko-mno
for mno_attempt in $(seq 1 15); do
  if curl -fsS --max-time 3 http://127.0.0.1:8788/healthz; then
    printf '\nСервис МНО запущен. Следующий шаг — Nginx и HTTPS.\n'
    exit 0
  fi
  sleep 1
done
echo 'Сервис не ответил. Диагностика: journalctl -u tko-mno -n 30 --no-pager'
exit 1
