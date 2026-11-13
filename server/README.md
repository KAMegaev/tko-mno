# МНО на VPS

Node.js 22+, без production-зависимостей npm. Сервис слушает только 127.0.0.1:8788.
Публичный адрес: https://mno.megaev.ru. ИОО на порту 8787 не изменяется.

## Работа с материалами

Браузер загружает два Excel-файла на /api/files (до 12 МБ каждый).
Сервер читает исходные книги в изолированном worker, возвращает распознанные
столбцы. Пользователь подтверждает столбцы и соответствия МО.
Сборка итоговой книги, расчёт контрольных сумм и отчёт выполняются на сервере.
Результат скачивается через /api/result. Случайный токен сессии хранится
только в памяти вкладки; файлы разных вкладок не смешиваются.

Материалы хранятся в закрытой временной папке не более 30 минут плюс до 10 секунд
на очистку (или до завершения текущего действия). Кнопка «Начать заново»
удаляет их сразу. После перезапуска сервиса вкладке потребуется повторная загрузка.
При штатной остановке временные файлы удаляются. systemd PrivateTmp удаляет
изолированный временный каталог при остановке сервиса, в том числе после сбоя.

## ИИ

Только сервер обращается к OpenAI. В ИИ отправляются заголовки столбцов и
названия МО, а не исходные Excel-книги. Модель и ключ задаёт администратор.
Модель по умолчанию: gpt-4.1-mini, структурированный JSON-ответ.
Ограничения: 12 обращений на сессию, 60 на час для экземпляра приложения,
до 250 исходных названий и до 100 000 символов исходных данных за обращение.
Изменение произвольных промптов, URL провайдера и модели браузером не поддерживается.

## Первичная установка под root

1. Обновить /opt/tko-mno из ветки claude/waste-accumulation-calculator-t45mxe.
2. Выполнить bash server/deploy/install.sh. Скрипт запросит ключ скрытым вводом.
   Ключ хранится в /etc/tko-mno.env (root:tko-mno, 0640), вне репозитория.
3. Установить только HTTP-конфигурацию:
   install -d -m 755 /var/www/letsencrypt
   install -m 644 server/deploy/nginx-http.conf /etc/nginx/conf.d/tko-mno.conf
   nginx -t && systemctl reload nginx
4. Проверить DNS mno.megaev.ru и получить сертификат:
   certbot certonly --webroot -w /var/www/letsencrypt -d mno.megaev.ru
5. Установить HTTPS-конфигурацию только после получения сертификата:
   install -m 644 server/deploy/nginx-https.conf /etc/nginx/conf.d/tko-mno-https.conf
   nginx -t && systemctl reload nginx
6. Проверить https://mno.megaev.ru/healthz и загрузку/скачивание Excel.
7. Убедиться, что существующий renewal hook Certbot перечитывает Nginx.
   При отсутствии:
   install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
   printf '%s\n' '#!/bin/sh' '/usr/sbin/nginx -t && /usr/bin/systemctl reload nginx' > /etc/letsencrypt/renewal-hooks/deploy/tko-mno-nginx-reload
   chmod 750 /etc/letsencrypt/renewal-hooks/deploy/tko-mno-nginx-reload

Если конфигурация Nginx не проходит nginx -t, не перезагружать сервис и исправить
новый файл МНО. Конфигурации других сайтов не заменять.

## GitHub Actions

После успешного первого запуска и настройки HTTPS:
bash server/deploy/setup-github.sh

В Settings → Secrets and variables → Actions добавить VPS_SSH_KEY
(приватный ключ из /root/.ssh/mno-github-actions) и VPS_KNOWN_HOSTS
(публичная строка, которую вывел скрипт). В Variables добавить
MNO_DEPLOY_ENABLED со значением true.

Workflow checks.yml сначала выполняет расчёт, серверные и браузерные тесты,
затем вызывает ограниченную SSH-команду на 185.200.179.49 от mno-deploy.
Этот доступ может обновить только /opt/tko-mno и перезапустить только tko-mno
через фиксированный root-скрипт. Приватный ключ ИИ в GitHub не передаётся.
При ошибке тестов/старта/HTTPS-проверки скрипт возвращает предыдущий коммит.

Обновление systemd/Nginx и привилегированного deploy-скрипта выполняется отдельно
администратором, не произвольной командой из workflow.

GitHub Pages workflow удалён: он не может запускать серверный backend.
Старый опубликованный Pages-сайт остаётся до ручного Unpublish site в Settings → Pages.
Отключать его только после проверки нового адреса.

## Проверки

node --test server/test/*.test.js
OUT=/tmp/mno-output.xlsx node tools/run.mjs
PUBLIC_ORIGIN=http://127.0.0.1:8765 PORT=8765 node server/index.js
BASE=http://127.0.0.1:8765 node tools/e2e.mjs
