#!/usr/bin/env bash
set -euo pipefail
[ "$(id -u)" -eq 0 ] || exit 1
[ "$#" -eq 0 ] || exit 1
exec 9>/run/lock/tko-mno-deploy.lock
flock -n 9 || { echo 'Деплой уже выполняется'; exit 1; }
cd /opt/tko-mno
[ -z "$(git status --porcelain)" ] || { echo 'В рабочей копии есть изменения'; exit 1; }
mno_previous="$(git rev-parse HEAD)"
git -c core.hooksPath=/dev/null fetch origin claude/waste-accumulation-calculator-t45mxe
mno_next="$(git rev-parse FETCH_HEAD)"
git merge-base --is-ancestor "$mno_previous" "$mno_next" || { echo 'Обновление не является fast-forward'; exit 1; }
mno_rollback() {
  git -c core.hooksPath=/dev/null reset --hard "$mno_previous"
  systemctl restart tko-mno
}
trap mno_rollback ERR
git -c core.hooksPath=/dev/null merge --ff-only "$mno_next"
runuser -u tko-mno -- /opt/tko-node/bin/node --test server/test/*.test.js
systemctl restart tko-mno
mno_ready=0
for mno_attempt in $(seq 1 15); do
  if curl -fsS --max-time 3 http://127.0.0.1:8788/healthz; then mno_ready=1; break; fi
  sleep 1
done
[ "$mno_ready" -eq 1 ]
curl -fsS --max-time 15 https://mno.megaev.ru/healthz
trap - ERR
printf '\nМНО обновлён: %s\n' "$mno_next"
