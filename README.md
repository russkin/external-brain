# Внешний мозг

Простое PWA для списка дел: строки одного списка с отступами (группы),
выполнение свайпом, время задачи, история ↩↪, копии. Работает офлайн,
устанавливается без Play Market, хостинг — GitHub Pages.

Открыть: https://russkin.github.io/external-brain/

## Что умеет

- Задачи — строки одного списка, вложенность — отступ (точки ⠿, свайпы точек).
- Выполнение — свайп влево (флаг «✓ Выполнено»), разделитель «Выполнено · N»
  скрывает секцию; свайп вправо — задать время (метка в углу, авто-сумма у родителя).
- Своя модалка (без `prompt`/`confirm` — работает на iOS Chrome), история ↩↪,
  локальная и «вечная» копии, диагностика ⓘ с журналом синка (при ошибке
  синка журнал уходит в `logs/` на сервер — для диагностики извне).
- Необязательный синк через GitHub (owner/repo + токен): позадачное
  объединение по меткам времени (LWW), офлайн-работа и повторы при ошибках.

Модель: статусы `inbox/next/done` живут в `src/logic.js` (`waiting`/`someday`,
проекты, нарезка и лягушка удалены — в живых задачах не использовались).
Интерфейс — плоский список строк.

## Структура

- `index.html` — оболочка: шапка (версия, сеть ⇅, светофор синка, ⚙, кнопки
  📁📂↩↪🗑), единый список строк, своя модалка
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
  покрытие logic.js/sync.js ≥90% строк и ≥89% веток
- `docs/USER_GUIDE.md` (+ `.html` для офлайна, ссылка из ⚙), `AGENTS.md`

## Разработка

```sh
# тесты (обязательно перед публикацией)
node --test tests/logic.test.js tests/ios.test.js tests/sync.test.js tests/sync-devices.test.js

# покрытие (строки ≥90%, ветки ≥89% logic.js/sync.js)
node --test --experimental-test-coverage tests/logic.test.js tests/ios.test.js tests/sync.test.js tests/sync-devices.test.js

# локальный предпросмотр
python3 -m http.server 8000
# → http://localhost:8000 (Service Worker требует http://localhost или https)
```

## Деплой

Push в `main` → workflow «Deploy PWA to GitHub Pages» (с job `test`) → https://russkin.github.io/external-brain/

Приложение рассчитано на один телефон: без синка всё работает локально и офлайн.
Синк (repo + GitHub token в меню, хранится только на устройстве) — страховка
списка в облаке и перенос на новый телефон. Синк идёт после каждого изменения
(debounce 2 сек), при открытии и раз в минуту, пока вкладка открыта.
Объединение — позадачное: у каждой задачи своя метка времени, побеждает более
свежая правка. Одновременная правка одной задачи — побеждает более поздняя.
Удаление — tombstone, пустое устройство общий список не стирает.
