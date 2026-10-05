# Внешний мозг

Простое PWA для списка дел по мотивам «Джедайских техник»: всё новое падает в инбокс,
затем проясняется по статусам, слоны режутся на бифштексы.
Работает офлайн, устанавливается без Play Market, хостинг — GitHub Pages.

Открыть: https://russkin.github.io/external-brain/

## Джедайский цикл (v1)

- **Инбокс** — сбор: любая мысль сразу сюда, цель — пустой инбокс в конце дня.
- **Прояснение** — разложить инбокс: следующие действия / ожидание / когда-нибудь / готово + проект.
- **Слон** — большая задача: «Нарезать» на N бифштексов, съедать по одному кнопкой «+1».
  Последний бифштекс закрывает задачу сам.

## Структура

- `index.html` — оболочка: шапка (версия, сеть, светофор синка, ⚙), фокус дня,
  быстрый ввод в инбокс, группы по статусам, своя модалка
- `app.js` — интерфейс (версия `APP_VERSION`, single-flight синк, проверка обновлений)
- `store.js` — хранилище: IndexedDB с fallback на localStorage (`external-brain-v1`)
- `sync.js` — необязательный синк через GitHub Contents API (`data/state.json`):
  скачать → позадачно объединить → опубликовать
- `src/logic.js` — чистая логика без DOM (общая для браузера и тестов)
- `sw.js` — service worker (версия `CACHE`, install строго из сети)
- `manifest.webmanifest`, `icon.svg` + `icon-192/512.png` (PNG обязательны —
  старый Chrome один SVG не признаёт и ставит битый ярлык)
- `data/state.json` — ОБЩИЙ файл синка в репозитории: `{ updatedAt, tasks }`
- `tests/` — unit-тесты (`node --test tests/logic.test.js tests/ios.test.js tests/sync.test.js tests/sync-devices.test.js`),
  покрытие logic.js/sync.js ≥90% строк и веток
- `docs/USER_GUIDE.md` (+ `.html` для офлайна, ссылка из ⚙), `AGENTS.md`

## Разработка

```sh
# тесты (обязательно перед публикацией)
node --test tests/logic.test.js tests/ios.test.js tests/sync.test.js tests/sync-devices.test.js

# покрытие (не менее 90% строк и веток logic.js/sync.js)
node --test --experimental-test-coverage tests/logic.test.js tests/ios.test.js tests/sync.test.js tests/sync-devices.test.js

# локальный предпросмотр
python3 -m http.server 8000
# → http://localhost:8000 (Service Worker требует http://localhost или https)
```

## Деплой

Push в `main` → workflow «Deploy PWA to GitHub Pages» (с job `test`) → https://russkin.github.io/external-brain/

Синхронизация между устройствами включается в меню приложения (repo + GitHub token,
хранится только на устройстве). Синк идёт после каждого изменения (debounce 2 сек),
при открытии и раз в минуту. Объединение — позадачное: у каждой задачи своя метка
времени, для каждой побеждает более свежая правка, поэтому параллельные добавления
с разных устройств не теряются. Одновременная правка одной задачи —
побеждает более поздняя. Удаление — tombstone, пустое устройство общий список не стирает.
