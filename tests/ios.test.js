'use strict';
/* Строковые регрессы устройства/кэша/версий: методика из alex/purchases. */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const syncSrc = fs.readFileSync(path.join(root, 'sync.js'), 'utf8');
const storeSrc = fs.readFileSync(path.join(root, 'store.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function appVersion() {
  const m = appSrc.match(/APP_VERSION\s*=\s*'([^']+)'/);
  return m && m[1];
}

function swCache() {
  const m = swSrc.match(/CACHE\s*=\s*'([^']+)'/);
  return m && m[1];
}

describe('версии app.js и sw.js меняются вместе', () => {
  it('APP_VERSION и CACHE содержат одну метку', () => {
    const v = appVersion();
    const c = swCache();
    assert.ok(v, 'нет APP_VERSION в app.js');
    assert.ok(c, 'нет CACHE в sw.js');
    assert.ok(c.includes(v), 'CACHE ' + c + ' не содержит ' + v);
  });
  it('версия видна в шапке', () => {
    assert.ok(html.includes('id="appVerHead"'), 'нет appVerHead в шапке');
    assert.ok(appSrc.includes("el('appVerHead')"), 'версия не подставляется');
  });
});

describe('service worker: методика кэша', () => {
  it('install берёт файлы из сети (cache reload)', () => {
    assert.ok(swSrc.includes("cache: 'reload'"), 'нет cache reload в install');
  });
  it('старые кэши чистятся, клиент захватывается', () => {
    assert.ok(swSrc.includes('skipWaiting'), 'нет skipWaiting');
    assert.ok(swSrc.includes('clients.claim'), 'нет clients.claim');
  });
  it('проверка версии идёт мимо кэша', () => {
    assert.ok(swSrc.includes('nocache='), 'нет bypass nocache в sw.js');
    assert.ok(appSrc.includes('?nocache='), 'нет проверки версии в app.js');
    assert.ok(appSrc.includes('caches.delete'), 'нет чистки кэша при обновлении');
  });
  it('в кэш положены все части оболочки', () => {
    for (const u of ['index.html', 'app.js', 'store.js', 'sync.js', 'src/logic.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png']) {
      assert.ok(swSrc.includes(u), 'нет ' + u + ' в ASSETS');
    }
  });
});

describe('без системных диалогов (iOS)', () => {
  it('нет вызовов prompt(', () => {
    /* Точку исключаем: deferredPrompt.prompt() — не системный диалог. */
    assert.ok(!/(^|[^A-Za-z_$.])prompt\s*\(/.test(appSrc), 'найден prompt(');
  });
  it('нет вызовов confirm(', () => {
    assert.ok(!/(^|[^A-Za-z_$])confirm\s*\(/.test(appSrc), 'найден confirm(');
  });
  it('есть своя модалка', () => {
    assert.ok(appSrc.includes('modalBack'), 'нет modalBack');
    assert.ok(appSrc.includes('askText'), 'нет askText');
    assert.ok(appSrc.includes('askConfirm'), 'нет askConfirm');
  });
});

describe('устойчивость к рассинхрону кэшей', () => {
  it('все подписки через защищённый on()', () => {
    assert.ok(appSrc.includes('function on(id, ev, fn)'), 'нет on()');
    assert.ok(!/getElementById\('[a-zA-Z]+'\)\.addEventListener/.test(appSrc), 'прямая подписка без on()');
  });
  it('глобальные ошибки видны в статусе', () => {
    assert.ok(appSrc.includes("addEventListener('error'"), 'нет onerror');
    assert.ok(appSrc.includes('bootStack'), 'нет bootStack');
    assert.ok(appSrc.includes('lastAction'), 'нет lastAction');
    assert.ok(appSrc.includes('diagBtn'), 'нет diagBtn');
  });
});

describe('логика вызывается с state.tasks', () => {
  it('мутации получают state.tasks, а не state', () => {
    const fns = ['createTask', 'clarifyTask', 'completeTask', 'reopenTask', 'removeTask', 'setFrog', 'setSlices', 'completeSlice'];
    for (const fn of fns) {
      assert.ok(!new RegExp('L\\.' + fn + '\\(state[^.]').test(appSrc), 'найден вызов ' + fn + '(state, …)');
    }
    for (const fn of ['createTask', 'clarifyTask', 'removeTask', 'getTask']) {
      assert.ok(appSrc.includes('L.' + fn + '(state.tasks,'), 'нет вызова ' + fn + '(state.tasks, …)');
    }
  });
  it('стартовый экран: строки читаются из state.tasks', () => {
    for (const fn of ['stats', 'shareText', 'doneList']) {
      assert.ok(appSrc.includes('L.' + fn + '(state.tasks'), 'нет ' + fn + '(state.tasks');
    }
    assert.ok(appSrc.includes('renderLines'), 'нет renderLines');
    assert.ok(appSrc.includes("el('lines')"), 'нет lines в app.js');
    assert.ok(!appSrc.includes('focusTask(state.tasks'), 'фокус дня должен быть убран из UI');
  });
  it('стартовый экран: grip 6 точек + поле ввода', () => {
    assert.ok(html.includes('id="lines"'), 'нет lines в index.html');
    assert.ok(html.includes("class=\"grip\"") || html.includes('.grip'), 'нет grip в index.html');
    assert.ok(html.includes('tinput'), 'нет tinput в index.html/app');
    assert.ok(appSrc.includes("className = 'tline'") || appSrc.includes('tline'), 'нет tline в app.js');
    assert.ok(appSrc.includes("className = 'tinput'") || appSrc.includes('tinput'), 'нет tinput в app.js');
    assert.ok(appSrc.includes('Enter'), 'нет Enter для новой строки');
  });
  it('перетаскивание: сосед едет под наездом сразу, без перескока', () => {
    assert.ok(appSrc.includes('pointerdown'), 'нет pointerdown на grip');
    assert.ok(appSrc.includes('pointermove'), 'нет pointermove для живого drag');
    assert.ok(appSrc.includes('pointerup'), 'нет pointerup для завершения drag');
    assert.ok(appSrc.includes('setPointerCapture'), 'нет захвата указателя');
    assert.ok(!appSrc.includes('phold'), 'placeholder даёт скачок вместо плавного наезда');
    assert.ok(appSrc.includes('drag-active'), 'нет drag-active состояния');
    assert.ok(appSrc.includes('persistLineOrder'), 'порядок не сохраняется');
    assert.ok(appSrc.includes('lostpointercapture'), 'нет страховки завершения drag');
  });
  it('быстрый ввод и фокус дня убраны из оболочки', () => {
    assert.ok(!html.includes('id="focus"'), 'focus остался в index.html');
    assert.ok(!html.includes('id="quick"'), 'quick остался в index.html');
    assert.ok(!html.includes('id="quickInput"'), 'quickInput остался в index.html');
    assert.ok(!html.includes('id="quickAdd"'), 'quickAdd остался в index.html');
  });
});

describe('синк: триггеры и протокол', () => {
  it('возврат на вкладку слушается тремя событиями', () => {
    assert.ok(appSrc.includes('visibilitychange'), 'нет visibilitychange');
    assert.ok(appSrc.includes("addEventListener('focus'"), 'нет focus');
    assert.ok(appSrc.includes('pageshow'), 'нет pageshow');
  });
  it('фоновый опрос раз в 60 сек, debounce 2 сек', () => {
    assert.ok(appSrc.includes('60000'), 'нет опроса 60 сек');
    assert.ok(/2000/.test(appSrc), 'нет debounce 2 сек');
  });
  it('single-flight: летит один, повтор в очереди', () => {
    assert.ok(appSrc.includes('syncFlying'), 'нет флага syncFlying');
    assert.ok(appSrc.includes('syncQueued'), 'нет очереди syncQueued');
  });
  it('sync.js: LWW по задачам, no-store, ретраи 409/422', () => {
    assert.ok(syncSrc.includes('mergeTasks'), 'нет mergeTasks в sync');
    assert.ok(syncSrc.includes('normalizeTasks'), 'нет normalizeTasks в sync');
    assert.ok(syncSrc.includes('tasksEqual'), 'нет tasksEqual в sync');
    assert.ok(syncSrc.includes('isTasksEmpty'), 'нет isTasksEmpty в sync');
    assert.ok(syncSrc.includes("cache: 'no-store'"), 'нет no-store в getRemote');
    assert.ok(/github-put \(409\|422\)/.test(syncSrc), 'нет ретрая 409/422');
    assert.ok(syncSrc.includes('backoffDelay'), 'нет backoff');
    assert.ok(syncSrc.includes('timedFetch'), 'нет timedFetch');
    assert.ok(syncSrc.includes('publishFile'), 'нет publishFile');
  });
  it('файл состояния — data/state.json', () => {
    assert.ok(syncSrc.includes('contents/data/state.json'), 'не тот путь состояния');
  });
});

describe('PWA-оболочка', () => {
  it('манифест и иконки подключены', () => {
    assert.ok(html.includes('manifest.webmanifest'), 'нет манифеста');
    assert.ok(html.includes('icon.svg'), 'нет icon.svg');
    assert.ok(fs.existsSync(path.join(root, 'icon-192.png')), 'нет icon-192.png');
    assert.ok(fs.existsSync(path.join(root, 'icon-512.png')), 'нет icon-512.png');
  });
  it('все скрипты подключены', () => {
    for (const s of ['src/logic.js', 'store.js', 'sync.js', 'app.js']) {
      assert.ok(html.includes(s), 'нет ' + s + ' в index.html');
    }
  });
  it('токен живёт только в настройках', () => {
    assert.ok(!/type="password"/.test(html), 'постоянное поле пароля в html');
    assert.ok(appSrc.includes('tokenInput'), 'нет tokenInput');
    assert.ok(appSrc.includes('tokenWrap'), 'нет tokenWrap');
  });
  it('хранилище scoped под проект', () => {
    assert.ok(storeSrc.includes('external-brain-v1'), 'не тот LS-ключ');
    assert.ok(storeSrc.includes('normalizeTasks'), 'нет normalizeTasks в store');
  });
  it('service worker регистрируется, обновление перезагружает', () => {
    assert.ok(appSrc.includes('serviceWorker'), 'нет регистрации SW');
    assert.ok(appSrc.includes('controllerchange'), 'нет перезагрузки при смене контроллера');
  });
});
