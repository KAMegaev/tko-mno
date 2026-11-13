#!/usr/bin/env bash
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo 'Запустите под root'; exit 1; }
cd /opt/tko-mno
command -v sudo >/dev/null
command -v visudo >/dev/null
if ! getent passwd mno-deploy >/dev/null; then
  useradd --system --user-group --create-home --home-dir /var/lib/mno-deploy --shell /bin/sh mno-deploy
fi
install -m 750 -o root -g root server/deploy/github-deploy.sh /usr/local/sbin/mno-deploy
mno_sudoers="$(mktemp)"
trap 'rm -f "$mno_sudoers"' EXIT
printf '%s\n' 'mno-deploy ALL=(root) NOPASSWD: /usr/local/sbin/mno-deploy ""' > "$mno_sudoers"
visudo -cf "$mno_sudoers"
install -m 440 "$mno_sudoers" /etc/sudoers.d/mno-deploy
install -d -m 700 /root/.ssh
if [ ! -f /root/.ssh/mno-github-actions ]; then
  ssh-keygen -q -t ed25519 -N '' -C mno-github-actions -f /root/.ssh/mno-github-actions
fi
install -d -m 755 -o root -g root /var/lib/mno-deploy
install -d -m 700 -o mno-deploy -g mno-deploy /var/lib/mno-deploy/.ssh
mno_authorized="$(mktemp)"
trap 'rm -f "$mno_sudoers" "$mno_authorized"' EXIT
printf 'restrict,command="sudo -n /usr/local/sbin/mno-deploy" %s\n' "$(cat /root/.ssh/mno-github-actions.pub)" > "$mno_authorized"
install -m 600 -o mno-deploy -g mno-deploy "$mno_authorized" /var/lib/mno-deploy/.ssh/authorized_keys
echo 'Добавьте в Secrets репозитория KAMegaev/tko-mno:'
echo 'VPS_SSH_KEY — содержимое /root/.ssh/mno-github-actions (не отправлять в чат)'
echo 'VPS_KNOWN_HOSTS — следующая публичная строка:'
printf '185.200.179.49 '
cat /etc/ssh/ssh_host_ed25519_key.pub | cut -d' ' -f1-2
echo 'После этого создайте Actions variable MNO_DEPLOY_ENABLED=true.'
