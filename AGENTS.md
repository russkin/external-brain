# AGENTS.md — Внешний мозг (external-brain)

Простое PWA для списка дел по «Джедайским техникам»: инбокс → прояснение →
следующие/ожидание/когда-нибудь, лягушка дня, слоны-бифштексы.
Репозиторий: `git@github.com:russkin/external-brain.git`, ветка `main`.
Прод: https://russkin.github.io/external-brain/ (GitHub Pages, source = GitHub Actions).
Текущая версия: v40 (сентябрь 2026). Тестов: 122 (`logic` + `ios` + `sync` + `sync-devices`).

## Регламент публикации (обязательный после КАЖДОГО коммита)

1. `node --test tests/logic.test.js tests/ios.test.js tests/sync.test.js tests/sync-devices.test.js` — всё зелёное.
2. Покрытие: `node --test --experimental-test-coverage ...` — logic.js/sync.js ≥90% строк и веток.
3. `git commit`, затем push. Прямой push без токена не взлетит (origin — SSH):
   `git push "https://x-access-token:${GITHUB_TOKEN}@github.com/russkin/external-brain.git" main:main`
   Токен брать из локального `.env` (`GITHUB_TOKEN`), в выводе затирать через
   `sed -E 's/x-access-token:[^@]+@/x-access-token:REDACTED@/g'`.
   При `rejected` — `fetch + rebase origin/main + push`, повторы до успеха.
4. Дождаться workflow «Deploy PWA to GitHub Pages» (`completed/success`) через Actions API.
   Учти `concurrency.cancel-in-progress`: первый запуск может быть `cancelled`, жди следующий.
5. Проверить прод curl'ом (200 + маркеры новой версии в `app.js`/`sw.js`).
6. Сообщить пользователю: опубликованную версию (`APP_VERSION`) и адрес https://russkin.github.io/external-brain/

## Версии

`APP_VERSION` в `app.js` и `CACHE = 'extbrain-vN'` в `sw.js` — менять ВМЕСТЕ при любом
изменении кода приложения (иначе устройства не поймут, что обновились).
Версия видна в шапке (`#appVerHead`). Service worker: skipWaiting +
clients.claim, приложение само перезагружается при смене контроллера.
Docs-only правки версию НЕ bump'ят. Есть регресс-тест на совпадение меток.

## Карта файлов

- `index.html` — оболочка: шапка (версия, сеть, светофор, ⚙), фокус дня, быстрый ввод
  в инбокс, группы (gInbox/gNext/gWaiting/gSomeday/gDone), своя модалка.
- `app.js` — UI: рендер групп, кнопки прояснения (Next/Wait/Someday/Proj/X),
  лягушка, нарезка слона, single-flight синк, ретраи ошибок, проверка обновлений.
- `store.js` — IndexedDB + fallback localStorage (`external-brain-v1`), `sanitize` нормализует.
- `sync.js` — синк через GitHub Contents API, UMD (браузер + `require` в тестах),
  `timedFetch` (таймаут 20 сек), GET мимо HTTP-кэша (`no-store`).
- `src/logic.js` — чистая логика без DOM (UMD), вся мутабельность задач здесь.
- `sw.js`, `manifest.webmanifest`, `icon.svg` + `icon-192/512.png` (PNG обязательны —
  старый Chrome один SVG не признаёт и ставит битый ярлык). Install берёт файлы строго из сети
  (`cache: 'reload'`, иначе Pages с `max-age=600` кладёт старье).
- `data/state.json` — ОБЩИЙ файл синка в репозитории: `{ updatedAt, tasks }`. Seed
  закоммичен один раз; дальше его правят устройства по API — при коммитах кода
  `data/**` не трогать (в workflow `paths-ignore`, синк-коммиты деплой не триггерят).
- `.github/workflows/pages.yml` — job `test` (все 4 файла), сборка `_site/` (явный список
  файлов, без `.env`/`.git`), deploy.
- `tests/` — `logic.test.js`, `ios.test.js` (строковые регрессы app.js/index.html/sw.js),
  `sync.test.js`, `sync-devices.test.js` (фейковый GitHub с sha-семантикой).
- `docs/USER_GUIDE.md` (+ `.html` для офлайна, ссылка из ⚙), `README.md`.

## Протокол синка (методология из alex/purchases)

- У каждой задачи своя метка `ts`, ставится при любом изменении.
- `mergeTasks`: для каждой задачи побеждает свежая `ts`, при равных — локальная.
- Удаление — tombstone (`deleted: true`): мёртвая задача с более свежей `ts`
  побеждает живую, иначе удаление на одном устройстве воскрешало бы задачу с другого.
- `syncNow` (`sync.js`): GET → merge → PUT merged если отличается
  (`pushed`/`merged`/`pulled`/`in-sync`). 409/422 → до 5 ретраев с экспоненциальным
  backoff + джиттер (настраивается 3-м аргументом фабрики в тестах).
  Токен — только из настроек устройства.
- `doSync` (`app.js`): single-flight (летит один, повтор ждёт очереди).
  Любая ошибка → ещё 5 повторов через 2 сек. Без сети повторы не тратятся впустую
  (триггеры — только по событиям + опрос).
- Триггеры: debounce 2 сек после каждого изменения, фоновый опрос раз в 60 сек
  (только если вкладка видима + сеть + токен), при открытии, при возврате на вкладку
  (`visibilitychange` + `focus` + `pageshow`, троттлинг 15 сек), при появлении сети,
  пункт ⚙ → «Синхронизировать», тап по светофору.
- Без токена синк молча ничего не делает (это НОРМА для одного устройства).
- Одновременная правка одной задачи с двух устройств — побеждает поздняя (файловый sync, не CRDT).
- Проверка новой версии (`checkUpdate`): качает `app.js?nocache=` мимо кэша SW
  (в sw.js явный bypass), при открытии и возврате на вкладку, не чаще раза в 5 минут.
  Находит новее — спрашивает и чистит кэш сам. Плюс `pokeSwUpdate`: при возврате
  на вкладку дёргает `reg.update()`.
- Пустое состояние никогда не затирает непустое (`mergeDecision`: pull/push/in-sync).

## UI-договорённости (не ломать молча)

- Своя модалка (`askText`/`askConfirm`): `prompt/confirm` на iOS Chrome вне
  user-activation блокируются — есть регресс-тест.
- Все подписки только через защищённый `on(id, ev, fn)` (пропускает отсутствующие
  элементы при рассинхроне кэшей) — есть регресс-тест.
- В функции логики передавать `state.tasks`, НЕ `state` — есть регресс-тест.
- Поле токена живёт в DOM только при открытых настройках (иначе Chrome предлагает
  сохранить токен как логин) — есть регресс-тест.
- Светофор (`#syncLight`): зелёный/жёлтый мигающий/красный/серый; тап — принудительный синк.
- Фокус дня: первая лягушка из следующих, иначе первое следующее, иначе первый инбокс.

## Секреты

- `.env` (gitignored, chmod 600): `GITHUB_TOKEN`. НИКОГДА не коммитить,
  не печатать в вывод, не класть в код/артефакты Pages. Не читать файл целиком —
  только `source` в shell для push/API без вывода значения.
- Токен для синка на устройствах вводит пользователь в меню (хранится локально).

## Грабли (унаследовано от purchases, проверено болью)

1. GitHub Pages отдаёт `Cache-Control: max-age=600` → обычный `addAll` в install кладёт
   старье. Лечится `cache: 'reload'` в install.
2. Браузер кэширует ответы Contents API до минуты → устройство видит старое и рапортует
   in-sync. Лечится `cache: 'no-store'` в `getRemote`.
3. fetch без таймаута на рваной сети висит минутами — лечится `timedFetch` (20 сек) + single-flight.
4. Одного `visibilitychange` мало (bfcache, фокус окна) → три события: `visibilitychange` + `focus` + `pageshow`.
5. `node --test tests/` (папкой) может падать в этом окружении — запускать перечислением файлов.
6. НИКОГДА `git add -A` в общем workspace: рядом чужие каталоги — комитить только явным
   списком файлов внутри `alex/external-brain`.
7. Каталог `alex/external-brain` пересоздан под пользователя opencode (исходный был
   root-owned); бэкап — `alex/external-brain-rootbak` (только `.env`, удалить после проверки).
