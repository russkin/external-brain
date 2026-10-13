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
const diagSrc = fs.readFileSync(path.join(root, 'src/diag.js'), 'utf8');
const historySrc = fs.readFileSync(path.join(root, 'src/history.js'), 'utf8');
const settingsSrc = fs.readFileSync(path.join(root, 'src/settings.js'), 'utf8');
const searchSrc = fs.readFileSync(path.join(root, 'src/search.js'), 'utf8');
const trigSrc = fs.readFileSync(path.join(root, 'src/triggers.js'), 'utf8');
const gestSrc = fs.readFileSync(path.join(root, 'src/gestures.js'), 'utf8');
const rendSrc = fs.readFileSync(path.join(root, 'src/render.js'), 'utf8');
const logicSrc = fs.readFileSync(path.join(root, 'src/logic.js'), 'utf8');
const pagesYml = fs.readFileSync(path.join(root, '.github/workflows/pages.yml'), 'utf8');

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
    assert.ok(rendSrc.includes("el('appVerHead')"), 'версия не подставляется');
  });
});

describe('service worker: методика кэша', () => {
  it('install берёт файлы из сети (cache reload)', () => {
    assert.ok(swSrc.includes("cache: 'reload'"), 'нет cache reload в install');
  });
  it('чужие домены мимо воркера (иначе Safari роняет синк)', () => {
    assert.ok(swSrc.includes("indexOf(self.location.origin) !== 0"),
      'API синка идёт через SW — в Safari 15 respondWith(undefined)');
    assert.ok(swSrc.includes("Promise.reject(new Error('offline'))"),
      'обрыв без кэша даёт null вместо честной ошибки сети');
  });
  it('старые кэши чистятся, клиент захватывается', () => {
    assert.ok(swSrc.includes('skipWaiting'), 'нет skipWaiting');
    assert.ok(swSrc.includes('clients.claim'), 'нет clients.claim');
  });
  it('проверка версии идёт мимо кэша', () => {
    assert.ok(swSrc.includes('nocache='), 'нет bypass nocache в sw.js');
    assert.ok(trigSrc.includes('?nocache='), 'нет проверки версии в src/triggers.js');
    assert.ok(trigSrc.includes('caches.delete'), 'нет чистки кэша при обновлении');
  });
  it('в кэш положены все части оболочки', () => {
    for (const u of ["'./'", 'index.html', 'app.js', 'store.js', 'sync.js', 'src/logic.js', 'src/search.js', 'src/diag.js', 'src/settings.js', 'src/history.js', 'src/triggers.js', 'src/gestures.js', 'src/render.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'docs/USER_GUIDE.html', 'docs/VERSIONS.html']) {
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
    assert.ok(html.includes('id="diagBtn"'), 'нет diagBtn');
    assert.ok(storeSrc.includes('external-brain-backup-v1') &&
      storeSrc.includes('backupWrite(lastPersisted)'),
      'нет локальной копии state перед каждым сохранением');
    assert.ok(storeSrc.includes('skipBackupOnce') && storeSrc.includes('restoreBackup'),
      'восстановление перетирает собственную копию');
    assert.ok(html.includes('id="restoreBtn"') && appSrc.includes('on(\'restoreBtn\''),
      'нет кнопки восстановления копии');
    assert.ok(diagSrc.includes('Локальная копия: ') && diagSrc.includes('backupInfo'),
      'копия не видна в диагностике');
    /* Диагностика v72: сжатая статистика + синк/размер/сеть/устройство/SW. */
    assert.ok(diagSrc.includes("'Задач: ' + alive + ' · готово '"), 'нет строки «Задач: N · готово M»');
    assert.ok(!diagSrc.includes('Лягушка: '), 'строка диагностики про удалённое поле не удалена');
    assert.ok(diagSrc.includes("'Обновление: SW '"), 'нет строки SW/кэша');
    assert.ok(diagSrc.includes('external-brain-synclog-v1'), 'нет времени последнего синка');
    assert.ok(diagSrc.includes("'Ошибка синка: '"), 'нет строки ошибки синка');
    assert.ok(diagSrc.includes("'Данные: '"), 'нет времени изменения данных');
    assert.ok(diagSrc.includes("'Ошибок JS: нет'"), '«Ошибок: нет» спорит с журналом синка');
    assert.ok(diagSrc.includes('(локальный журнал цел)'), 'нет пометки о целости журнала при log-error');
    assert.ok(diagSrc.includes("' · свёрнуто групп '") && diagSrc.includes("'История: ↩ '"),
      'нет локальных флагов/истории');
    assert.ok(diagSrc.includes("'Размер: '") && diagSrc.includes("'Сеть: '") &&
      diagSrc.includes("'Устройство: '") && diagSrc.includes("'Последнее действие: '"),
      'нет размера/сети/устройства/последнего действия');
    assert.ok(diagSrc.includes('function diagSwInfo()') && diagSrc.includes('diagText().then'),
      'diagText не асинхронный/без SW-инфо');
    /* Окно диагностики: Поделиться + Закрыть (не OK), журнал синка внизу. */
    assert.ok(diagSrc.includes("showInfo('Диагностика', txt, txt)"),
      'диагностика не открывается через showInfo');
    assert.ok(appSrc.includes("ok.textContent = 'Закрыть'") &&
      appSrc.includes("clear.textContent = 'Поделиться'") &&
      appSrc.includes("cancel.style.display = 'none'"),
      'нет кнопок Поделиться+Закрыть / скрытой Отмены');
    assert.ok(appSrc.includes('insertBefore(clear, ok)') &&
      appSrc.includes('insertBefore(ok, clear)'),
      'Закрыть не после Поделиться / порядок кнопок не возвращается');
    assert.ok(diagSrc.includes("lines.push('Журнал:')") && trigSrc.includes("EBDiag.push('ошибка синка: "),
      'нет журнала синк-ошибок в диагностике');
    /* Постоянная («вечная») копия: кнопка + автокопия при обновлении версии. */
    assert.ok(storeSrc.includes('external-brain-pin-v1') && storeSrc.includes('external-brain-pin-ver-v1'),
      'нет ключей постоянной копии');
    assert.ok(storeSrc.includes('savePinNow') && storeSrc.includes('pinOnVersion') &&
      storeSrc.includes('restorePin'), 'нет API постоянной копии');
    assert.ok(html.includes('id="pinSaveBtn"') && appSrc.includes('on(\'pinSaveBtn\'') &&
      html.includes('id="pinRestoreBtn"') && appSrc.includes('on(\'pinRestoreBtn\''),
      'нет кнопок постоянной копии');
    assert.ok(appSrc.includes('pinOnVersion(APP_VERSION)') && diagSrc.includes('Постоянная копия: '),
      'нет авто-пина/диагностики постоянной копии');
    /* v66: в пине только задачи (без настроек/токена) + история ↩ в localStorage. */
    assert.ok(/function pinWrite[\s\S]{0,400}state: \{ tasks:/.test(storeSrc) &&
      !/function pinWrite[\s\S]{0,400}settings/.test(storeSrc),
      'в постоянной копии хранятся настройки/токен');
    assert.ok(historySrc.includes('external-brain-undo-v1') && historySrc.includes('external-brain-redo-v1') &&
      historySrc.includes('pushUndo') && historySrc.includes('histSave'),
      'история отмены не переживает перезагрузку');
    assert.ok(appSrc.includes('window.EBHistory.load()') &&
      appSrc.includes('function snapTasks() { return window.EBHistory.snapTasks(); }'),
      'app.js не ходит в историю через мост (вынос нечистый)');
    /* v67: задачи с пустым текстом — полноценные строки, не черновики. */
    assert.ok(!appSrc.includes("if (!t || t.deleted || !String(t.title || '').trim()) continue;"),
      'lineTasks фильтрует пустые задачи');
    assert.ok(!appSrc.includes('return !t.deleted && t.title;'),
      'fullList фильтрует пустые задачи');
    assert.ok(appSrc.includes("placeTaskAfter(newAnchor, '', putIndent, true)"),
      'нет создания пустой задачи по Enter');
    assert.ok(!appSrc.includes("return 'removed'") &&
      appSrc.includes("clarifyTask(state.tasks, taskId, { title: '' })"),
      'commitLine удаляет задачу с пустым текстом вместо очистки');
    assert.ok(rendSrc.includes("inp.placeholder = '…';") && !rendSrc.includes('Новая задача'),
      'у пустой задачи остался черновик-плейсхолдер');
    /* v69: grabDy — при захвате, иначе дыра недобирает вверх. */
    assert.ok(gestSrc.includes('grabDy = e.clientY - div.getBoundingClientRect().top') &&
      gestSrc.includes('if (grabDy == null)'),
      'grabDy меряется в pointerdown, а не при старте режима');
    /* no-draft: создания по потере фокуса больше нет — строка рождается
     * задачей сразу по Enter; недописанное живёт в задаче (автосейв). */
    assert.ok(!appSrc.includes('function createDraftOnBlur'),
      'blur-создание осталось (черновик не выкручен)');
    assert.ok(!appSrc.includes('createDraftOnBlur(inp, indent)'),
      'подписка blur на создание осталась');
    /* v70: каретка в начале ПУСТОЙ строки — не «вставка сверху»:
     * иначе вторая пустая прыгает выше первой. */
    assert.ok(/atStart = inp\.selectionStart === 0 && inp\.selectionEnd === 0 &&\s*\n\s*!!String\(inp\.value \|\| ''\)\.trim\(\)/.test(appSrc),
      'atStart считает пустую строку вставкой сверху');
    /* no-draft: поля-черновика нет — пересчёт его якоря после драга
     * не нужен, порядок пишется досдвиговым слепком. */
    assert.ok(gestSrc.includes('var reordered = persistLineOrder(preDrop)') &&
      !gestSrc.includes('dR.afterId = newAfterB'),
      'пересчёт якоря черновика остался');
    /* Отмена возвращает и отступ: слепок истории — до applyDropIndent,
     * иначе ↩ возвращал порядок, но не уровень (родитель не уходил с 1 на 0). */
    assert.ok(gestSrc.includes('var preDrop = (di !== -1 && di !== oldPos) ? C.snapFull() : null'),
      'нет досдвигового слепка перед applyDropIndent');
    assert.ok(gestSrc.includes('function persistLineOrder(beforeOverride)'),
      'persistLineOrder не принимает досдвиговый слепок');
    assert.ok(gestSrc.includes('if (!reordered && preDrop && C.snapTasks() !== preDrop.tasks)'),
      'чистое изменение отступа без сдвига порядка не пишется в историю');
    assert.ok(html.includes('id="repoBtn"') && settingsSrc.includes('on(\'repoBtn\''),
      'нет пункта «Репозиторий и токен»');
    assert.ok(!appSrc.includes('on(\'repoBtn\'') && !appSrc.includes('openRepoModal'),
      'настройки остались в app.js (вынос нечистый)');
    assert.ok(html.includes('id="repoModalBack"') && html.includes('#repoModalBack { display: none;'),
      'настройки — не модальное окно по центру');
    assert.ok(html.includes('id="repoModalInput"') && html.includes('id="repoSaveBtn"') &&
      html.includes('id="repoCancelBtn"'),
      'в окне настроек нет двух полей и кнопок Сохранить/Отмена');
    assert.ok(settingsSrc.includes('только для администратора'), 'нет предупреждения для администратора');
    /* v74: светофор «!» при 409/422 + тап по нему — принудительный синк; сеть ⇅ в шапке.
     * Движок и триггеры — модуль src/triggers.js (этап 5). */
    assert.ok(trigSrc.includes("color === 'red' && /github-put (409|422)/.test(err)") &&
      trigSrc.includes("n.style.color = alert ? '#fff' : '#ffb300'"),
      'нет «!» цветом по типу ошибки (белый — конфликт, жёлтый — обычная)');
    assert.ok(trigSrc.includes("on('syncLight', 'click', function () { doSync(true); })"),
      'нет тапа по светофору — принудительного синка');
    /* v121/v127: игры с яркостью отменены (v128) — обычные яркие цвета;
     * v136: оба «!» поверх квадратика (отдельного слева нет), цвет
     * различает ошибки — белый при конфликте, жёлтый при обычной. */
    assert.ok(trigSrc.includes('#4caf50') && trigSrc.includes('#ffc107') &&
      trigSrc.includes('#f44336') && trigSrc.includes('#bbb'),
      'цвета светофора не исходные яркие');
    assert.ok(!html.includes('id="syncAlert"') && !trigSrc.includes("el('syncAlert')"),
      'отдельный знак слева от квадратика остался');
    assert.ok(trigSrc.includes("n.textContent = '!'") &&
      trigSrc.includes("var warn = color === 'red';"),
      'нет «!» поверх квадратика при ошибке');
    assert.ok(trigSrc.includes('function renderNet()') && trigSrc.includes("net.textContent = '⇅'") &&
      trigSrc.includes("' МБ/с'") && trigSrc.includes("addEventListener('offline', renderNet)"),
      'нет индикатора сети (цвет/МБ/с) в шапке');
    assert.ok(html.includes('id="netStatus"') && html.includes('id="netType"'),
      'нет элементов сети в шапке');
    /* v75: журнал синка уходит на сервер при github-ошибке (как в purchases). */
    assert.ok(diagSrc.includes('function maybePublishJournal()') &&
      trigSrc.includes("if (/github-/.test(lastErrMsg)) window.EBDiag.maybePublishJournal();") &&
      diagSrc.includes("'logs/sync-'"),
      'нет публикации журнала в logs/');
    assert.ok(diagSrc.includes("now - lastJournalPublish < 15 * 60 * 1000"),
      'нет лимита 15 минут на публикацию журнала');
    assert.ok(diagSrc.includes('external-brain-device-v1') &&
      diagSrc.includes("'Публикация журнала: '") && diagSrc.includes("' · id '"),
      'нет deviceId/строк публикации в диагностике');
    assert.ok(trigSrc.includes('window.EBDiag.push(') && trigSrc.includes('window.EBDiag.save(') &&
      appSrc.includes('window.EBDiag.load()'),
      'движок синка не пишет в журнал модуля / метки не восстанавливаются');
    assert.ok(appSrc.includes('window.EBTriggers.restoreLog(window.EBDiag.load())'),
      'boot не отдаёт журнал модулю триггеров');
  });
});

describe('логика вызывается с state.tasks', () => {
  it('мутации получают state.tasks, а не state', () => {
    const fns = ['createTask', 'clarifyTask', 'completeTask', 'reopenBranch', 'removeTask', 'setIndent'];
    for (const fn of fns) {
      assert.ok(!new RegExp('L\\.' + fn + '\\(state[^.]').test(appSrc), 'найден вызов ' + fn + '(state, …)');
      assert.ok(!new RegExp('L\\.' + fn + '\\(state[^.]').test(gestSrc), 'найден вызов ' + fn + '(state, …) в жестах');
    }
    for (const fn of ['createTask', 'clarifyTask', 'removeTask', 'getTask', 'setIndent', 'reopenBranch']) {
      assert.ok(appSrc.includes('L.' + fn + '(state.tasks,'), 'нет вызова ' + fn + '(state.tasks, …)');
    }
  });
  it('стартовый экран: строки читаются из state.tasks', () => {
    for (const fn of ['shareText', 'doneList']) {
      assert.ok(appSrc.includes('L.' + fn + '(state.tasks'), 'нет ' + fn + '(state.tasks');
    }
    assert.ok(rendSrc.includes('L.stats(state.tasks'), 'нет stats(state.tasks');
    assert.ok(rendSrc.includes('renderLines'), 'нет renderLines');
    assert.ok(appSrc.includes("el('lines')"), 'нет lines в app.js');
    assert.ok(!appSrc.includes('focusTask(state.tasks'), 'фокус дня должен быть убран из UI');
  });
  it('стартовый экран: grip 6 точек + поле ввода', () => {
    assert.ok(html.includes('id="lines"'), 'нет lines в index.html');
    assert.ok(html.includes("class=\"grip\"") || html.includes('.grip'), 'нет grip в index.html');
    assert.ok(html.includes('tinput'), 'нет tinput в index.html/app');
    assert.ok(rendSrc.includes("className = 'tline'"), 'нет tline в src/render.js');
    assert.ok(rendSrc.includes("className = 'tinput'"), 'нет tinput в src/render.js');
    assert.ok(appSrc.includes('Enter'), 'нет Enter для новой строки');
  });
  it('отступ по месту отпускания: родители→0, внутри→от соседа', () => {
    assert.ok(gestSrc.includes('applyDropIndent'), 'нет пересчёта отступа при drop');
    assert.ok(gestSrc.includes('prevInd'), 'не смотрим соседа сверху');
    assert.ok(gestSrc.includes('nextInd'), 'не смотрим соседа снизу');
    assert.ok(gestSrc.includes('function nbrShown(r)') &&
      gestSrc.includes("rt.status === 'done'"),
      'соседи посадки — скрытые и выполненные (чужой отступ при drop)');
    assert.ok(gestSrc.includes('if (nbrShown(sibs[pi])) { prevRow = sibs[pi]; break; }'),
      'сосед сверху берётся без проверки видимости');
  });
  it('группы отступом: сдвиг за grip, наследование, потолок +1', () => {
    assert.ok(appSrc.includes('INDENT_STEP'), 'нет шага отступа');
    assert.ok(rendSrc.includes('marginLeft'), 'отступ не применяется к строке');
    assert.ok(appSrc.includes('lineIndent'), 'нет чтения уровня отступа');
    assert.ok(gestSrc.includes('indentBounds'), 'нет потолка «сосед сверху +1»');
    assert.ok(appSrc.includes('{ indent:'), 'новая строка не наследует отступ');
    assert.ok(/startIndent\(\)[\s\S]{0,1200}C\.lineIndent\(kt\) > lv0/.test(gestSrc),
      'сдвиг не собирает ветку — внучки отрываются');
    assert.ok(gestSrc.includes('C.lineIndent(kt) + delta'),
      'сдвиг двигает одну строку вместо ветки');
    assert.ok(gestSrc.includes('expandParentAbove(lvl)'),
      'сдвиг под свёрнутого прячет строку (родитель не разворачивается)');
    assert.ok(rendSrc.includes('function expandForAnchor(anchorId, indent)'),
      'создание под свёрнутым прячет задачу с рождения');
    assert.ok(rendSrc.includes('\nfunction expandForAnchor(anchorId, indent)'),
      'expandForAnchor внутри замыкания drag — из Enter не видна, Enter молча умирает');
  });
  it('уровни цветом, collapse, шапка с тремя кнопками', () => {
    assert.ok(html.includes('.tline[data-indent="1"]'), 'нет заливки уровней');
    assert.ok(html.includes('id="collapseAllBtn"'), 'нет кнопки свернуть всё');
    assert.ok(html.includes('id="expandAllBtn"'), 'нет кнопки развернуть всё');
    assert.ok(html.includes('id="deleteDoneBtn"'), 'нет кнопки удалить выполненные');
    assert.ok(appSrc.includes('toggleCollapse'), 'нет сворачивания по тапу');
    assert.ok(/function toggleCollapse\(id\)[\s\S]{0,800}e\.collapsed = bvCollapsed/.test(appSrc),
      'тап по точкам не пишет шаг истории — ↩ после разворота откатывает 📁 целиком');
    assert.ok(appSrc.includes('setAllCollapsed'), 'нет свернуть/развернуть всё');
    assert.ok(/function setAllCollapsed\(all\)[\s\S]{0,600}doneHidden = !!all/.test(appSrc),
      'свернуть/развернуть всё не трогает секцию выполненных');
    assert.ok(appSrc.includes('e.collapsed = bvCollapsed') && appSrc.includes('function setViewState'),
      '↩ после свернуть-всё не возвращает вид (только данные)');
    assert.ok(historySrc.includes('collapsed: vc') && historySrc.includes('setViewState'),
      'слепок истории без вида, возврат вида невозможен');
    assert.ok(appSrc.includes('askClearDone'), 'нет удаления выполненных с подтверждением');
    assert.ok(rendSrc.includes('collapsed-kid'), 'нет скрытия вложенных');
  });
  it('Корзина без выполненных не спрашивает подтверждение', () => {
    var iC = appSrc.indexOf('function askClearDone()');
    assert.ok(iC !== -1, 'нет askClearDone');
    var cBody = appSrc.slice(iC, appSrc.indexOf('function wire()', iC));
    assert.ok(cBody.includes('if (!L.doneList(state.tasks).length) return;'),
      'нет раннего выхода при пустой секции выполненных');
    assert.ok(cBody.indexOf('doneList(state.tasks).length') < cBody.indexOf('askConfirm'),
      'пустая корзина показывает окно подтверждения');
  });
  it('свайп-выполнено и секция под полем ввода', () => {
    assert.ok(html.includes('doneflag') || appSrc.includes('doneflag'), 'нет флага выполнено');
    assert.ok(gestSrc.includes('swiped'), 'нет раскрытия свайпом');
    assert.ok(appSrc.includes('toggleDoneSlide'), 'нет завершения со слайдом');
    assert.ok(appSrc.includes('L.doneList(state.tasks)'), 'нет секции выполненных');
    assert.ok(rendSrc.includes('done-sep'), 'нет разделителя выполненных');
    assert.ok(rendSrc.includes('if (done.length)'),
      'разделитель пропадает, когда все выполненные спрятаны в свёрнутых группах');
    assert.ok(rendSrc.includes("addEventListener('click'") && appSrc.includes('toggleDoneHidden'),
      'нет тапа по разделителю для скрытия выполненных');
    assert.ok(appSrc.includes('loadDoneHidden') && appSrc.includes('doneHidden'),
      'состояние скрытия выполненных не сохраняется');
    assert.ok(rendSrc.includes("'Выполнено · ' + done.length"),
      'счётчик показывает видимых, а не всех выполненных');
    assert.ok(/sep\.addEventListener\('click'[\s\S]{0,600}e\.collapsed = bvCollapsed/.test(rendSrc),
      'тап по разделителю не пишет шаг истории');
    assert.ok(!appSrc.includes('expandDoneParents') && !appSrc.includes('anyDoneShown'),
      'тап по разделителю трогает сворачивание живых веток');
    assert.ok(!appSrc.includes('fullOrdered'),
      'обход предков по своему порядку: tombstone сдвигают индексы');
    assert.ok(rendSrc.includes('is-done'), 'нет зачёркивания');
    assert.ok(html.includes('user-select'), 'свайп проигрывает выделению текста');
    assert.ok(gestSrc.includes('_swOpen'), 'состояние свайпа рассинхронизировано');
    assert.ok(html.includes('translateX(-200px)'), 'флаг наезжает на поле задачи');
    assert.ok(gestSrc.includes('activeElement'), 'курсор остаётся в поле после выполнения');
  });
  it('возврат из выполненных и история undo/redo', () => {
    assert.ok(rendSrc.includes('Не выполнено'), 'нет флага возврата');
    assert.ok(appSrc.includes('L.reopenBranch(state.tasks'), 'нет возврата задачи');
    assert.ok(appSrc.includes('completeBranch'), 'ветка не выполняется целиком');
    assert.ok(appSrc.includes('reopenBranch'), 'ветка не возвращается целиком');
    assert.ok(appSrc.includes('hasLiveParent'), 'нет проверки живого родителя при возврате ветки');
    assert.ok(appSrc.includes('setIndent(state.tasks, taskId, 0)'), 'отступ вернувшейся не сбрасывается');
    assert.ok(html.includes('id="undoBtn"'), 'нет стрелки назад');
    assert.ok(html.includes('id="redoBtn"'), 'нет стрелки вперёд');
    assert.ok(historySrc.includes('function doUndo') && historySrc.includes('function doRedo'),
      'нет undo/redo');
    assert.ok(historySrc.includes('HISTORY_MAX'), 'история без лимита');
    assert.ok(!appSrc.includes('function doUndo') && !appSrc.includes('function applySnapshot'),
      'логика отмены осталась в app.js');
    assert.ok(historySrc.includes('deleted = true'), 'отмена создания не переживёт синк');
  });
  it('пустые строки: удаление флагом, сдвиг, перетаскивание; выполненные не таскаем', () => {
    assert.ok(rendSrc.includes('✕ Удалить'), 'нет флага удаления на пустой строке');
    assert.ok(rendSrc.includes('C.deleteEmptyTask(id)'), 'флаг не удаляет пустую строку');
    assert.ok(appSrc.includes('function deleteEmptyTask'), 'нет удаления пустой строки');
    assert.ok(appSrc.includes('lineTasks().length <= 1'), 'последняя строка удаляема');
    assert.ok(appSrc.includes('Backspace'), 'нет сброса пустого поля');
    assert.ok(appSrc.includes('placeTaskTop'), 'нет создания в начало');
    assert.ok(gestSrc.includes('не таскаем'), 'нет запрета drag выполненных');
  });
  it('Backspace: сцепка с предыдущей, курсор уезжает вверх', () => {
    assert.ok(appSrc.includes('function mergeTaskIntoPrev'), 'нет сцепки строк по Backspace');
    assert.ok(!appSrc.includes('function backspaceCreateDraft'), 'создание черновика по Backspace осталось');
    assert.ok(appSrc.includes('String(prev.title || \'\') + \' \' + curText'),
      'между наименованиями нет пробела');
    var iM = appSrc.indexOf('function mergeTaskIntoPrev');
    var mBody = appSrc.slice(iM, appSrc.indexOf('function commitLine'));
    assert.ok(mBody.includes('if (idx <= 0) return;'), 'Backspace в первой строке что-то делает');
    assert.ok(mBody.includes('L.removeTask(state.tasks, cur.id)'), 'текущая строка не удаляется');
    assert.ok(mBody.includes('focusTaskEnd(prev.id, prevLen + 1)'),
      'курсор не встаёт на стык верхней и перенесённого');
    assert.ok(mBody.includes('liveVal'), 'сцепка идёт не по живому значению строки');
    assert.ok(mBody.indexOf('var prevLen = String(prev.title') < mBody.lastIndexOf('mutate(function'),
      'длина верхней не запомнена до склейки');
    var iK = appSrc.indexOf("inp.addEventListener('keydown'");
    var kBody = appSrc.slice(iK, iK + 1400);
    assert.ok(!kBody.includes('backspaceCreateDraft()') && kBody.includes('mergeTaskIntoPrev(taskId, inp.value)'),
      'Backspace не обрабатывается в keydown');
    assert.ok(kBody.includes('inp.selectionStart === 0 && inp.selectionEnd === 0'),
      'нет каретки в начале строки');
  });
  it('Backspace на полностью удалённой строке: удалить её, ничего не копировать', () => {
    var iM = appSrc.indexOf('function mergeTaskIntoPrev');
    var mBody = appSrc.slice(iM, appSrc.indexOf('function commitLine'));
    assert.ok(mBody.includes('if (!live.trim())'), 'нет ветки пустой строки');
    assert.ok(mBody.includes('focusTaskEnd(prev.id);'),
      'курсор не в конец предыдущей при пустой строке');
    assert.ok(!mBody.includes('curText = String(cur.title'),
      'пустая строка тащит старый заголовок из state в склейку');
    var emptyBranch = mBody.slice(mBody.indexOf('if (!live.trim())'),
      mBody.indexOf('var curText = live.trim()'));
    assert.ok(!emptyBranch.includes('clarifyTask'),
      'в пустой ветке что-то пишет в предыдущую строку');
    assert.ok(emptyBranch.includes('L.removeTask(state.tasks, cur.id)'),
      'пустая строка не удаляется');
  });
  it('Сворачивание: выполненные дети прячутся, точки и 📁 смотрят в полном порядке', () => {
    assert.ok(appSrc.includes('function hasKidsFull'), 'нет проверки детей в полном порядке');
    assert.ok(appSrc.includes('function fullList'), 'нет полного списка задач');
    var iF = gestSrc.indexOf('function finish(e)');
    var fBody = gestSrc.slice(iF, iF + 2600);
    assert.ok(fBody.includes('hasKidsFull(tapped.id)'),
      'тап по точкам смотрит только на живых детей');
    var iS = appSrc.indexOf('function setAllCollapsed');
    var sBody = appSrc.slice(iS, iS + 450);
    assert.ok(sBody.includes('hasKidsFull(tasks[i].id)'),
      'свернуть все смотрит только на живых детей');
    assert.ok(rendSrc.includes('function makeGrip(arrow)') &&
      rendSrc.includes("g.textContent = arrow") &&
      rendSrc.includes("g.className = 'grip'"),
      'у родителя нет треугольника / grip пересобран');
    assert.ok(rendSrc.includes("arrow: !kids ? null : (collapsed[t.id] ? '▶' : '▼')") &&
      rendSrc.includes('makeGrip(opts.arrow)'),
      'треугольники ставятся не по состоянию группы (▶/▼)');
    assert.ok(html.includes('.grip.arrow'),
      'нет стиля треугольника');
    var iD = rendSrc.indexOf('Выполненные — под полем добавления');
    var dBody = rendSrc.slice(iD, iD + 2200);
    assert.ok(!dBody.includes('isHiddenByCollapse(full, di, collapsed)'),
      'секция выполненных зависит от сворачивания живых групп');
    assert.ok(dBody.includes('var doneVis = done.slice();'),
      'секция показывает не всех выполненных');
  });
  it('в жестах черновика нет: захват сразу ведёт строку', () => {
    assert.ok(!gestSrc.includes('var draftRowG'), 'коммит черновика при захвате остался');
    assert.ok(!gestSrc.includes('data-trailing'), 'жесты ищут поле-черновик');
    assert.ok(!gestSrc.includes('refocusDraft'), 'возврат курсора в черновик остался');
    assert.ok(!gestSrc.includes('C.touchLastPD') && !gestSrc.includes('C.setDraftTapBusy'),
      'гард blur-создания остался');
    assert.ok(!gestSrc.includes('C.getDraft(') && !gestSrc.includes('C.setDraft('),
      'жесты читают черновик через контекст');
    assert.ok(!gestSrc.includes('function commitTrailingIntoBranch'),
      'доводка поля при завершении ветки осталась');
  });
  it('Enter в середине: хвост уходит в задачу ниже, курсор в её начало', () => {
    assert.ok(appSrc.includes('splitPos > 0 && splitPos < splitVal.length'),
      'нет сплита строки по позиции каретки');
    assert.ok(appSrc.includes('splitVal.slice(0, splitPos).trim()'),
      'левая часть не отделяется и не проверяется');
    assert.ok(appSrc.includes('splitVal.slice(splitPos).trim()'),
      'хвост не отделяется от каретки');
    assert.ok(appSrc.includes('insertTaskAfter(taskId, splitTail, spIndent'),
      'хвост не создаётся задачей ниже');
    assert.ok(appSrc.includes('focusLineStart(madeSplit.id)'),
      'курсор не встаёт в начало хвоста');
    assert.ok(!appSrc.includes('trailingAfterId === taskId') &&
      !gestSrc.includes('trailingAfterId === taskId'),
      'сплит переякоривает мёртвое поле');
    assert.ok(appSrc.includes('function focusLineStart'), 'нет фокуса в начало строки');
    var iSp = appSrc.indexOf('var splitPos = inp.selectionStart');
    var spBody = appSrc.slice(iSp, appSrc.indexOf('commitLine(taskId, inp.value', iSp));
    assert.ok(spBody.includes('clearTimeout(saveTimer)'),
      'отложенное сохранение ввода вернёт перенесённый хвост обратно');
    assert.ok(spBody.includes('splitVal.slice(0, splitPos).trim()'),
      'в левой части остаётся лишний пробел');
    assert.ok(spBody.includes('inputClosed = true'),
      'сплит не закрывает input от позднего change');
  });
  it('Поздний change со старого input не склеивает сплит/сцепку обратно', () => {
    var iW = appSrc.indexOf('function wireLineInput');
    assert.ok(iW !== -1, 'нет wireLineInput');
    var wBody = appSrc.slice(iW, iW + 700);
    assert.ok(wBody.includes('var inputClosed = false'), 'нет флага закрытого input');
    var iCh = appSrc.indexOf("inp.addEventListener('change'");
    assert.ok(iCh !== -1, 'нет обработчика change');
    var chBody = appSrc.slice(iCh, iCh + 220);
    assert.ok(chBody.includes('if (inputClosed) return;'),
      'change с заменённого input коммитит старое значение обратно');
    var iInp = appSrc.indexOf("inp.addEventListener('input'");
    var inBody = appSrc.slice(iInp, iInp + 220);
    assert.ok(inBody.includes('if (inputClosed) return;'),
      'поздний input взводит saveTimer после сплита');
    var iMg = appSrc.indexOf('mergeTaskIntoPrev(taskId, inp.value)');
    var mgBody = appSrc.slice(Math.max(0, iMg - 260), iMg);
    assert.ok(mgBody.includes('inputClosed = true'),
      'сцепка не закрывает input от позднего change');
  });
  it('Enter в строке рождает пустую задачу ниже, курсор в неё', () => {
    assert.ok(appSrc.includes("placeTaskAfter(newAnchor, '', putIndent, true)"),
      'нет вставки пустой задачи по месту');
    assert.ok(appSrc.includes("placeTaskTop('', true)"), 'нет вставки сверху через TOP');
    assert.ok(appSrc.includes('focusTaskEnd(madeEnter.id)'), 'курсор не встаёт в новую строку');
    assert.ok(!appSrc.includes('focusLineAfter'), 'старый фокус дальше остался');
    assert.ok(appSrc.includes('expandForAnchor(newAnchor, putIndent)'),
      'строка под свёрнутым родится невидимой');
    assert.ok(appSrc.includes('var putCap = anchorTask ? lineIndent(anchorTask) + 1 : newIndent;') &&
      appSrc.includes('if (putIndent > putCap) putIndent = putCap;'),
      'рождение выше потолка сдвига (строку тут же зажмёт)');
  });
  it('потолок сдвига смотрит на видимого соседа сверху', () => {
    var iB = gestSrc.indexOf('function indentBounds');
    assert.ok(iB !== -1, 'нет indentBounds');
    var bBody = gestSrc.slice(iB, gestSrc.indexOf('function expandParentAbove', iB));
    assert.ok(bBody.includes('if (!rowShown(rows[i])) continue;'),
      'скрытая строка раздувает потолок сдвига');
  });
  it('Enter продолжает уровень: дочерняя за дочерней', () => {
    assert.ok(appSrc.includes('var newIndent = lineIndent(moved)'), 'Enter в строке не даёт сестру');
    assert.ok(appSrc.includes("placeTaskAfter(newAnchor, '', putIndent, true)"),
      'цепочка не держит отступ');
  });
  it('отмена Enter: задача уходит одним шагом', () => {
    assert.ok(historySrc.includes('function snapFull'), 'нет полного слепка');
    assert.ok(!appSrc.includes('afterId: oldAnchor'), 'лишняя точка появления поля');
    assert.ok(!historySrc.includes('C.getDraft(') && !historySrc.includes('C.setDraft(') &&
      !historySrc.includes('getDraft: getDraft'),
      'черновик остался в слепке истории');
    assert.ok(historySrc.includes('snapTasks() !== tasksJson'), 'возврат дёргает метки синка');
  });
  it('отмена возвращает курсор', () => {
    assert.ok(appSrc.includes('focusTaskEnd'), 'курсор не возвращается в конец задачи');
    assert.ok(appSrc.includes('setSelectionRange'), 'курсор не ставится в конец');
    assert.ok(appSrc.includes('focusAfterHistory'), 'отмена не ведёт курсор');
    assert.ok(!appSrc.includes('snapChainLive') && !appSrc.includes('data-trailing'),
      'поиск вызванного поля остался');
  });
  it('перетаскивание пишется в историю досдвиговым слепком', () => {
    assert.ok(gestSrc.includes('var preDrop = (di !== -1 && di !== oldPos) ? C.snapFull() : null'),
      'нет досдвигового слепка перед applyDropIndent');
    assert.ok(!gestSrc.includes('dragUiBefore'), 'стартовый слепок поля остался');
  });
  it('показ стека ↩ в диагностике убран (v121)', () => {
    assert.ok(!diagSrc.includes('Стек ↩') && !diagSrc.includes('getHistoryPeek'),
      'строка стека осталась в диагностике');
    assert.ok(!historySrc.includes('function peek') && !appSrc.includes('getHistoryPeek'),
      'peek остался в истории/контексте');
  });
  it('стартер при пустом списке: некуда встать — строка рождается сама', () => {
    assert.ok(appSrc.includes('function ensureStarter'), 'нет стартера пустого списка');
    assert.ok(appSrc.includes("insertTaskTop('', Date.now(), true)"),
      'стартер не создаётся пустой задачей сверху');
  });
  it('Enter в родителе: пустая задача на уровне первой дочерней', () => {
    var iN = appSrc.indexOf('var newIndent');
    assert.ok(iN !== -1, 'нет расчёта отступа строки под строкой');
    var iA = appSrc.indexOf("placeTaskAfter(newAnchor, '', putIndent, true)", iN);
    assert.ok(iA > iN, 'пустая задача не создаётся на вычисленном месте');
    var block = appSrc.slice(iN, iA);
    assert.ok(block.includes('lineIndent(nx) > newIndent'),
      'первая дочерняя не подхватывается (строка уходит на уровень родителя)');
    assert.ok(block.includes('lineTasks()'), 'следующая строка не из живого списка');
    assert.ok(appSrc.includes('if (madeEnter) focusTaskEnd(madeEnter.id);'),
      'курсор не встаёт в новую строку');
  });
  it('Enter с кареткой в начале: строка над текущей', () => {
    assert.ok(appSrc.includes('inp.selectionStart === 0 && inp.selectionEnd === 0'),
      'нет распознавания каретки в начале текста');
    assert.ok(appSrc.includes("newAnchor = li > 0 ? lt[li - 1].id : 'TOP'"),
      'нет якоря перед текущей строкой (или TOP для первой)');
    assert.ok(appSrc.includes("placeTaskTop('', true)"), 'нет вставки сверху через TOP');
    assert.ok(appSrc.includes("placeTaskAfter(newAnchor, '', putIndent, true)"),
      'строка над текущей не создаётся на её отступе');
    assert.ok(appSrc.includes('if (madeEnter) focusTaskEnd(madeEnter.id);'),
      'курсор не встаёт в созданную строку');
  });
  it('захват grip не гасит клавиатуру, pin держит страницу, коммит не рендерит', () => {
    assert.ok(gestSrc.includes('var dragActive = false'), 'нет флага жеста');
    assert.ok(appSrc.includes('if (!isDragActive()) render()'), 'mutate рендерит во время жеста');
    var iP = gestSrc.indexOf("grip.addEventListener('pointerdown'");
    assert.ok(iP !== -1, 'нет обработчика захвата grip');
    var block = gestSrc.slice(iP, iP + 3400);
    assert.ok(block.includes('dragActive = true'), 'флаг не поднимается на захвате');
    assert.ok(!block.includes('.blur()'),
      'клавиатуру гасят на захвате — прыжок вьюпорта посреди touch роняет жест');
    assert.ok(block.includes('pinScroll()'), 'прокрутка не заперта на время жеста');
    assert.ok(block.includes("document.addEventListener('pointerup', finish)"),
      'нет document-страховки от зависшего pid (жест умирает без pointerup на grip)');
    var iF = gestSrc.indexOf('function finish(e)');
    assert.ok(iF !== -1 && gestSrc.slice(iF, iF + 700).includes('dragActive = false'),
      'флаг не снимается на финише жеста');
    var fin = gestSrc.slice(iF, iF + 2200);
    assert.ok(fin.includes('.blur()'), 'фокус не снимается на финише жеста');
    assert.ok(fin.includes('unpinScroll(500)'),
      'закрытие клавиатуры после жеста не подстраховано пином');
    assert.ok(fin.includes('!(kf && mode ===') && fin.includes('var kf = keepFocus;'),
      'сдвиг-отступ своей пустой гасит клавиатуру как чужой жест');
  });
  it('сдвиг-отступ своей пустой строки не гасит клавиатуру', () => {
    assert.ok(gestSrc.includes('keepFocus = !!(ae0') && gestSrc.includes("div.contains(ae0)"),
      'захват не запоминает фокус своей строки');
    assert.ok(gestSrc.includes("!String(ae0.value || '').trim()"),
      'условие срабатывает не только на пустой строке');
    assert.ok(gestSrc.includes('Курсор — в строку на новом месте'),
      'после сдвига курсор не возвращается в строку');
  });
  it('жест держит прокрутку, порог вертикали симметричен, захват перехватывается', () => {
    assert.ok(gestSrc.includes('function pinScroll'), 'нет pinScroll');
    assert.ok(gestSrc.includes("window.addEventListener('scroll', onPinScroll)"),
      'скролл не слушается на время пина');
    assert.ok(gestSrc.includes('window.scrollTo(0, pinY)'), 'пин не возвращает страницу на место');
    assert.ok(gestSrc.includes('unpinScroll(500)'),
      'закрытие клавиатуры после жеста не подстраховано пином');
    assert.ok(gestSrc.includes('Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx) * 2'),
      'порог вертикали не симметричен горизонтали — дрожь пальца лочит не тот режим');
    var iA = gestSrc.indexOf('function edgeTick');
    assert.ok(iA !== -1 && gestSrc.slice(iA, iA + 800).includes('pinY'),
      'автопрокрутка не двигает пин — страница дёрнется обратно');
    var iL = gestSrc.indexOf("grip.addEventListener('lostpointercapture'");
    assert.ok(iL !== -1 && gestSrc.slice(iL, iL + 400).includes('setPointerCapture'),
      'упавший захват не перехватывается заново');
  });
  it('свайп и отметка выполненной снимают фокус, поле уходит с веткой', () => {
    var iS = gestSrc.indexOf('function wireLineSwipe');
    var swBlock = gestSrc.slice(iS, gestSrc.indexOf('function toggleDoneSlide'));
    assert.ok(swBlock.includes('.blur()'), 'свайп не снимает фокус с полей');
    assert.ok(swBlock.includes('dragActive = true'), 'render во время свайпа не подавлен');
    assert.ok(swBlock.includes('dragActive = false'), 'подавление render не снимается на конце свайпа');
    assert.ok(swBlock.includes('setPointerCapture'), 'отпускание мимо строки оставляет флаг жеста');
    var iT = gestSrc.indexOf('function toggleDoneSlide');
    var tBlock = gestSrc.slice(iT, gestSrc.indexOf('function persistLineOrder'));
    assert.ok(tBlock.includes("tagName === 'TEXTAREA'"), 'отметка не снимает фокус с полей');
    assert.ok(tBlock.includes("row.classList.add('sliding-done')") &&
      !tBlock.includes("inp.classList.add('is-done')") &&
      tBlock.slice(tBlock.indexOf("row.classList.add('sliding-done')"))
        .includes('C.mutate(function () { C.toggleDoneNow'),
      'строка зачёркивается до переезда в секцию');
    assert.ok(tBlock.includes("classList.add('landed')"),
      'строка не проявляется на новом месте');
    assert.ok(tBlock.includes('var aeB = document.activeElement;') &&
      tBlock.slice(tBlock.indexOf('var aeB = document.activeElement;'))
        .includes('C.mutate(function () { C.toggleDoneNow'),
      'каретка переживает анимацию ухода в выполненные');
    assert.ok(html.includes('.tline.sliding-done') && html.includes('ebLand'),
      'нет затухания ухода / проявления при переезде');
  });
  it('Время задачи: метка в углу, свайп вправо, модалка со стрелками', () => {
    assert.ok(html.includes('id="durCtl"'), 'нет блока часов в модалке');
    assert.ok(html.includes('id="durHp"') && html.includes('id="durMm"'),
      'нет кнопок стрелок часов/минут');
    var iCss = html.indexOf('.durchip');
    assert.ok(iCss !== -1, 'нет стиля метки времени');
    var cssD = iCss === -1 ? '' : html.slice(iCss, iCss + 320);
    assert.ok(cssD.includes('position: absolute'), 'метка не наложением на поле задачи');
    assert.ok(cssD.includes('background: transparent'), 'фон метки не прозрачный');
    assert.ok(cssD.includes('right: 8px') && cssD.includes('bottom: 5px'),
      'метка не в правом нижнем углу поля');
    var iMk = rendSrc.indexOf('function makeLine');
    var mkBlock = rendSrc.slice(iMk, rendSrc.indexOf('function autosize'));
    assert.ok(mkBlock.includes('durchip'), 'строка не рисует метку времени');
    assert.ok(mkBlock.includes('L.fmtDur(opts.estMin)'), 'метка без формата из логики');
    assert.ok(mkBlock.includes('openDuration(id)'), 'тап по метке не открывает модалку');
    var iW = gestSrc.indexOf('function wireLineSwipe');
    var swBlock = gestSrc.slice(iW, gestSrc.indexOf('function toggleDoneSlide'));
    assert.ok(swBlock.includes('dx > 48'), 'нет порога свайпа вправо');
    assert.ok(swBlock.includes('C.openDuration(taskId)'), 'свайп вправо не открывает время');
    assert.ok(swBlock.includes('swHadFlag = true') && swBlock.includes('!swHadFlag'),
      'возврат из-под раскрытого флага не глушит открытие времени');
    assert.ok(appSrc.includes('var parent = hasKidsFull(taskId)') &&
      appSrc.includes('task.sumKids === false'),
      'родителю не открыта установка времени при снятом флаге суммы');
    assert.ok(rendSrc.includes('function lineEstMin') && rendSrc.includes('estMin: lineEstMin(t)'),
      'метка родителя не считается автоматически');
    assert.ok(rendSrc.includes('sum += lineEstMin(full[j])') && rendSrc.includes('ij === pin + 1'),
      'сумма идёт не по первому вложению');
    /* v71: выполненные вложения не входят в авто-сумму родителя. */
    assert.ok(rendSrc.includes("if (full[j].status === 'done') continue;"),
      'выполненные вложения считаются в метке времени родителя');
    assert.ok(swBlock.includes('_swBlockUntil'), 'клик после свайпа не заглушен (двойная модалка/фокус)');
    assert.ok(swBlock.includes('div._swRArm = false'), 'отменённый свайп не оставляет флаг');
    assert.ok(appSrc.includes('function askDuration'), 'нет модалки времени');
    assert.ok(appSrc.includes('function openDuration'), 'нет точки входа модалки времени');
    assert.ok(appSrc.includes("clearBtn.textContent = 'Убрать'"), 'нет кнопки снятия метки');
    assert.ok(appSrc.includes('var patch = { estMin: res.min };') &&
      appSrc.includes('L.clarifyTask(state.tasks, taskId, patch)'),
      'время не пишется в задачу');
    assert.ok(html.includes('id="durSumRow"') && html.includes('id="durSum"') &&
      html.includes('Суммировать из вложенных'),
      'нет флага суммы в модалке времени');
    assert.ok(appSrc.includes('function askDuration(initialMin, showSum, initialSum)') &&
      appSrc.includes('sumBox.checked = durSum') &&
      appSrc.includes("if (parent) patch.sumKids = res.sum;"),
      'флаг суммы не ходит из модалки в задачу');
    assert.ok(rendSrc.includes('|| t.sumKids === false'),
      'снятый флаг не возвращает родителю ручную метку');
    assert.ok(rendSrc.includes('estMin: lineEstMin(t)') &&
      rendSrc.includes('estMin: lineEstMin(doneVis[dv])'),
      'редендер не отдаёт estMin в строку');
    assert.ok(appSrc.includes("wireDurBtn('durHp'") && appSrc.includes("wireDurBtn('durMm'"),
      'стрелки модалки подписаны не через wireDurBtn()');
    assert.ok(appSrc.includes('function wireDurBtn') && appSrc.includes('pointerup') &&
      appSrc.includes('pointercancel'),
      'стрелки слушают только click — первый тап после жеста съедается');
    assert.ok(rendSrc.includes('function updateDurchip') && rendSrc.includes('function refreshDurchips'),
      'нет пересчёта фона метки по тексту поля');
    assert.ok(rendSrc.includes("chip.style.backgroundColor = 'transparent'") &&
      rendSrc.includes("bg !== 'transparent'"),
      'фон метки не переключается прозрачный/непрозрачный');
    assert.ok(rendSrc.includes('refreshDurchips(box)') &&
      appSrc.includes('if (chipN) updateDurchip(inp, chipN)'),
      'рендер/набор текста не пересчитывают фон метки');
    assert.ok(appSrc.includes("refreshDurchips(el('lines'))"),
      'ресайз (клавиатура/поворот) не пересчитывает фон метки');
  });
  it('компактные строки: высота уменьшена', () => {
    assert.ok(html.includes('padding: 6px 12px'), 'поле ввода не ужато');
  });
  it('перенос текста: многострочное поле', () => {
    assert.ok(rendSrc.includes('textarea'), 'нет textarea вместо input');
    assert.ok(appSrc.includes('autosize'), 'поле не растёт за текстом');
    assert.ok(appSrc.includes('shiftKey'), 'Shift+Enter не отделён от Enter');
    assert.ok(html.includes('resize: none'), 'поле можно растягивать вручную');
    assert.ok(html.includes('overflow-y'), 'нет скрытия скролла поля');
  });
  it('групповой drag: дети прячутся под родителя и едут с ним', () => {
    assert.ok(gestSrc.includes('kids'), 'дети не собираются при drag');
    assert.ok(gestSrc.includes('holeShift'), 'дыра не покрывает весь блок');
    assert.ok(gestSrc.includes("cr.classList.contains('done-sep')"),
      'разделитель выполненных вне каркаса покоя (уезжает при drag)');
    assert.ok(gestSrc.includes('if (fr[phi].sep) break;'),
      'дыра может уйти в раздел выполненных');
  });
  it('каркас drag не считает спрятанных классом: дыра не плывёт мимо свёрнутых', () => {
    assert.ok(rendSrc.includes('collapsed-kid') && gestSrc.includes('rowShown'),
      'нет проверки видимости ряда (класс collapsed-kid)');
    assert.ok(gestSrc.includes('if (!rowShown(cr)) continue'),
      'замороженный каркас включает спрятанные ряды (фантомные зазоры)');
    assert.ok(gestSrc.includes('visKids'),
      'зазоры дыры считаются по всем детям, включая невидимых');
    assert.ok(gestSrc.includes('if (row2 === div || !row2.parentNode || !rowShown(row2)) continue'),
      'слепок посадки включает спрятанные ряды');
  });
  it('позиция страницы не прыгает, автопрокрутка не дёргает', () => {
    assert.ok(rendSrc.includes('keepY'), 'скролл не сохраняется при перерисовке');
    assert.ok(rendSrc.includes('scrollTo(0, keepY)'), 'скролл не возвращается');
    assert.ok(gestSrc.includes('minHeight'), 'высота списка не фиксируется на время drag');
    assert.ok(gestSrc.includes('lastScrollTs'), 'автопрокрутка без троттлинга');
    assert.ok(gestSrc.includes('dragDist'), 'автопрокрутка без порога движения');
    assert.ok(gestSrc.includes('setInterval(edgeTick, 20)'),
      'автопрокрутка только по движению пальца — стоящий палец не крутит');
    assert.ok(gestSrc.includes('pinY = window.pageYOffset'),
      'пин убегает дальше клампа — дёргает страницу обратно');
    assert.ok(gestSrc.includes('updateHole(lastY)'),
      'дыра не едет за страницей на тиках автопрокрутки');
    assert.ok(/function finish\(e\)[\s\S]{0,300}stopEdge\(\);/.test(gestSrc),
      'таймер автопрокрутки не гасится на финише жеста');
  });
  it('перетаскивание: слепок на захвате, сдвиги соседей, посадка после', () => {
    assert.ok(gestSrc.includes('pointerdown'), 'нет pointerdown на grip');
    assert.ok(gestSrc.includes('pointermove'), 'нет pointermove для живого drag');
    assert.ok(gestSrc.includes('pointerup'), 'нет pointerup для завершения drag');
    assert.ok(gestSrc.includes('setPointerCapture'), 'нет захвата указателя');
    assert.ok(!appSrc.includes('phold') && !gestSrc.includes('phold'),
      'placeholder-раскладка вместо сдвигов');
    assert.ok(!appSrc.includes('cloneNode') && !gestSrc.includes('cloneNode'),
      'призрак вместо самой строки');
    assert.ok(gestSrc.includes('holeShift'), 'нет высоты блока для дыры');
    assert.ok(gestSrc.includes('setHole'), 'дыра не открывается сдвигами');
    assert.ok(gestSrc.includes('PEN'), 'нет порога въезда ведущим краем');
    assert.ok(gestSrc.includes('divH'), 'нет высоты тянущейся для симметрии вверх/вниз');
    assert.ok(gestSrc.includes('.18s linear'), 'анимация не линейная');
    assert.ok(gestSrc.includes('drag-active'), 'нет drag-active состояния');
    assert.ok(gestSrc.includes('persistLineOrder'), 'порядок не сохраняется');
    assert.ok(gestSrc.includes('lostpointercapture'), 'нет страховки завершения drag');
    assert.ok(gestSrc.includes('function dropMargins') && gestSrc.includes('dropMargins(div, kids)'),
      'посадка не ставит итоговый отступ в том же кадре (прыжок до render)');
  });
  it('сдвиги порядка двигают и выполненных, иначе зачёркивание гуляет', () => {
    assert.ok(appSrc.includes('sj && !sj.deleted && sj.createdAt > prev.createdAt'),
      'тесная вставка сдвигает только живых — перепрыг через замороженные done');
    assert.ok(appSrc.includes('sj && !sj.deleted && sj.createdAt >= slot'),
      'вставка сверху сдвигает только живых');
    assert.ok(gestSrc.includes('busyAt[t.createdAt] = true') &&
      gestSrc.includes('if (!busyAt[c0]) vals.unshift(c0)') &&
      gestSrc.includes('if (vals.length < m) vals = null;'),
      'посадка встаёт встык с чужими метками');
    assert.ok(gestSrc.includes('var all = state.tasks.filter(function (t) { return t && !t.deleted; });'),
      'перенумер затрагивает только живых');
  });
  it('поиск: кнопка, оверлей, проводка (модуль src/search.js)', () => {
    assert.ok(html.includes('id="searchBtn"'), 'нет кнопки поиска в шапке');
    for (const sid of ['searchBar', 'searchInput', 'searchTotal', 'searchPos', 'searchGo', 'searchCancel', 'searchUp', 'searchDown']) {
      assert.ok(html.includes('id="' + sid + '"'), 'нет ' + sid + ' в оверлее поиска');
    }
    for (const fn of ['openSearch', 'closeSearch', 'doSearch', 'gotoSearch', 'updateSearchUI', 'ensureSearchVisible', 'scrollToSearchRow']) {
      assert.ok(searchSrc.includes('function ' + fn), 'нет ' + fn + ' в src/search.js');
      assert.ok(!appSrc.includes('function ' + fn), fn + ' остался в app.js (вынос нечистый)');
    }
    assert.ok(searchSrc.includes("on('searchBtn'") && searchSrc.includes("on('searchGo'") &&
      searchSrc.includes("on('searchCancel'") && searchSrc.includes("on('searchUp'") &&
      searchSrc.includes("on('searchDown'"), 'кнопки поиска не подписаны');
    assert.ok(searchSrc.includes('searchScrollY'), 'Отмена не возвращает скролл');
    assert.ok(html.includes('search-hit') && searchSrc.includes('applySearchHit'),
      'нет подсветки текущего совпадения');
    assert.ok(html.includes('type="search"'), 'поле поиска не type=search (полоса автозаполнения)');
    assert.ok(searchSrc.includes('visualViewport') && searchSrc.includes('searchLift'),
      'оверлей не поднимается над клавиатурой — кнопки перекрыты');
    assert.ok(searchSrc.includes('searchLanded'),
      'Отмена всегда возвращает скролл, даже если поиск останавливался');
    assert.ok(searchSrc.includes('collapsed[lt[i].id]') || searchSrc.includes('delete collapsed'),
      'переход не разворачивает свёрнутые группы');
    assert.ok(searchSrc.includes('getState()') && searchSrc.includes('getCollapsed()') &&
      searchSrc.includes('isDoneHidden()'),
      'модуль читает общее состояние напрямую, а не через контекст');
    assert.ok(searchSrc.includes('syncSearchSpace') && searchSrc.includes('paddingBottom'),
      'низ страницы уходит под панель поиска');
    assert.ok(appSrc.includes('EBSearch.init({') && rendSrc.includes('window.EBSearch.currentId()'),
      'app.js не отдаёт контекст модулю и не дотягивает подсветку');
    assert.ok(html.includes('src/search.js') && swSrc.includes('src/search.js'),
      'модуль не подключён (index.html / sw.js)');
  });
  it('восстановление хоронит пропавших (синк не воскрешает)', () => {
    assert.ok(appSrc.includes('L.restoreWithTombstones(state.tasks, restored.tasks'),
      'восстановление без tombstone — синк вернёт удалённое');
  });
  it('резервные копии сгруппированы в подменю', () => {
    assert.ok(html.includes('id="backupBtn"') && html.includes('id="backupMenu"'),
      'нет пункта и подменю «Резервная копия»');
    assert.ok(html.includes('#backupMenu { display: none;'),
      'подменю копий видно сразу');
    assert.ok(html.includes('#backupMenu') && html.includes('rgba('),
      'у подменю нет подложки как в покупках');
    assert.ok(settingsSrc.includes("on('backupBtn'") && settingsSrc.includes("on('gearBtn'"),
      'подменю/меню не открываются');
    assert.ok(!appSrc.includes("on('backupBtn'") && !appSrc.includes("on('gearBtn'"),
      'подписки меню остались в app.js');
    for (const sid of ['restoreBtn', 'pinSaveBtn', 'pinRestoreBtn']) {
      assert.ok(html.includes('id="' + sid + '"'), 'нет ' + sid);
    }
  });
  it('очистка сгруппирована в подменю: выполненные + сжатие могил', () => {
    assert.ok(html.includes('id="cleanupBtn"') && html.includes('id="cleanupMenu"') &&
      html.includes('id="purgeBtn"'),
      'нет пункта и подменю «Очистка»');
    assert.ok(html.includes('#cleanupMenu { display: none;'),
      'подменю очистки видно сразу');
    assert.ok(settingsSrc.includes("on('cleanupBtn'"),
      'подменю очистки не открывается');
    assert.ok(appSrc.includes("on('purgeBtn'") && appSrc.includes('function askPurgeTombs'),
      'чистка могил не подписана');
    assert.ok(appSrc.includes('L.purgeTombstones(state.tasks, Date.now())'),
      'чистка идёт не через логику с историей');
    var iP = appSrc.indexOf('function askPurgeTombs');
    var pBody = appSrc.slice(iP, iP + 1600);
    assert.ok(pBody.includes('Мёртвых записей нет — сжимать нечего'),
      'нет честного «нечего сжимать»');
    assert.ok(diagSrc.includes('(живых ') && diagSrc.includes('· мёртвых '),
      'диагностика не показывает расклад живых/мёртвых');
    assert.ok(pBody.indexOf('askConfirm(') !== -1 &&
      pBody.indexOf('askConfirm(', pBody.indexOf('askConfirm(') + 1) !== -1,
      'нет двойного предупреждения');
  });
  it('меню не вылезает за маленький экран', () => {
    assert.ok(/#gearMenu\.open\s*\{[^}]*max-height:\s*calc\(100vh - 70px\)[^}]*overflow-y:\s*auto/.test(html),
      'меню без потолка высоты и прокрутки');
  });
  it('ввод на iOS: поле печатаемое (без user-select:none)', () => {
    assert.ok(/\.tinput\s*\{[^}]*-webkit-user-select:\s*text/.test(html),
      'поле с запретом выделения — на iOS клавиатура есть, а печати нет');
  });
  it('совместимость с Safari 15: без нового синтаксиса и API', () => {
    const logic = fs.readFileSync(path.join(root, 'src/logic.js'), 'utf8');
    for (const [name, src] of [['app.js', appSrc], ['store.js', storeSrc], ['sync.js', syncSrc], ['logic.js', logic], ['triggers.js', trigSrc], ['gestures.js', gestSrc], ['render.js', rendSrc]]) {
      assert.ok(!/\?\./.test(src) && !/\?\?/.test(src), 'опциональная цепочка в ' + name);
      assert.ok(!/async\s+function/.test(src), 'async/await в ' + name);
      assert.ok(!/replaceAll|matchAll|allSettled|structuredClone|randomUUID/.test(src),
        'слишком новые API в ' + name);
    }
    assert.ok(!/\(\?<=|\(\?<!/.test(appSrc), 'lookbehind в регэкспах (Safari <16.4)');
    assert.ok(html.includes('viewport-fit=cover'), 'нет viewport-fit для чёлки iPhone');
    assert.ok(html.includes('-webkit-sticky'), 'нет фолбэка липкой шапки для Safari');
  });
  it('у инструкции есть кнопка закрытия (iPhone)', () => {
    const guide = fs.readFileSync(path.join(__dirname, '..', 'docs/USER_GUIDE.html'), 'utf8');
    assert.ok(guide.includes('id="guideClose"'), 'нет кнопки закрытия инструкции');
    assert.ok(guide.includes('window.close()') && guide.includes('window.history.back()') &&
      guide.includes("window.location.href = '../'"),
      'закрытие без цепочки закрыть/назад/на главную');
  });
  it('инструкция — нативная ссылка в новой вкладке (без двойного открытия)', () => {
    assert.ok(html.includes('id="guideBtn"'), 'нет пункта инструкции в меню');
    assert.ok(html.includes('📖 Инструкция пользователя'), 'пункт называется не «Инструкция пользователя»');
    assert.ok(html.includes('target="_blank"'), 'инструкция не в новой вкладке');
    assert.ok(!appSrc.includes("window.open('./docs/USER_GUIDE.html'"),
      'window.open + location дают две страницы инструкции');
  });
  it('быстрый ввод и фокус дня убраны из оболочки', () => {
    assert.ok(!html.includes('id="focus"'), 'focus остался в index.html');
    assert.ok(!html.includes('id="quick"'), 'quick остался в index.html');
    assert.ok(!html.includes('id="quickInput"'), 'quickInput остался в index.html');
    assert.ok(!html.includes('id="quickAdd"'), 'quickAdd остался в index.html');
  });
});

describe('синк: триггеры и протокол', () => {
  it('возврат на вкладку слушается тремя событиями (модуль src/triggers.js)', () => {
    assert.ok(trigSrc.includes('visibilitychange'), 'нет visibilitychange');
    assert.ok(trigSrc.includes("addEventListener('focus'"), 'нет focus');
    assert.ok(trigSrc.includes('pageshow'), 'нет pageshow');
    assert.ok(!appSrc.includes('visibilitychange') && !appSrc.includes('pageshow'),
      'триггеры возврата остались в app.js (вынос нечистый)');
  });
  it('фоновый опрос раз в 60 сек, debounce 2 сек', () => {
    assert.ok(trigSrc.includes('60000'), 'нет опроса 60 сек');
    assert.ok(/2000/.test(trigSrc), 'нет debounce 2 сек');
    assert.ok(!appSrc.includes('60000'), 'фоновый опрос остался в app.js');
  });
  it('single-flight: летит один, повтор в очереди', () => {
    assert.ok(trigSrc.includes('syncFlying'), 'нет флага syncFlying');
    assert.ok(trigSrc.includes('syncQueued'), 'нет очереди syncQueued');
    assert.ok(!appSrc.includes('syncFlying'), 'флаги single-flight остались в app.js');
  });
  it('движок и триггеры — модуль src/triggers.js (этап 5)', () => {
    for (const fn of ['scheduleSync', 'doSync', 'setLight', 'renderNet', 'checkUpdate',
      'pokeSwUpdate', 'setupPolling', 'onReady', 'getSync', 'restoreLog', 'init']) {
      assert.ok(trigSrc.includes('function ' + fn), 'нет ' + fn + ' в src/triggers.js');
    }
    assert.ok(appSrc.includes('function doSync(force) { return window.EBTriggers.doSync(force); }') &&
      appSrc.includes('function scheduleSync() { return window.EBTriggers.scheduleSync(); }') &&
      appSrc.includes('function renderNet() { window.EBTriggers.renderNet(); }') &&
      appSrc.includes('function getSyncInfo() { return window.EBTriggers.getSync(); }'),
      'app.js не ходит в синк через тонкие алиасы (вынос нечистый)');
    assert.ok(!appSrc.includes('function setLight') && !appSrc.includes('function checkUpdate') &&
      !appSrc.includes('function pokeSwUpdate') && !appSrc.includes('function setupPolling'),
      'функции триггеров остались в app.js (вынос нечистый)');
    assert.ok(appSrc.includes('EBTriggers.init({') && appSrc.includes('EBTriggers.onReady()'),
      'app.js не отдаёт контекст модулю триггеров / не запускает первый синк');
    assert.ok(trigSrc.includes('getState()') && trigSrc.includes('renderStatus') &&
      trigSrc.includes('getVersion()'),
      'модуль читает общее состояние напрямую, а не через контекст');
    assert.ok(html.includes('src/triggers.js') && swSrc.includes('src/triggers.js'),
      'модуль не подключён (index.html / sw.js)');
  });
  it('жесты — модуль src/gestures.js (этап 6, без черновика)', () => {
    for (const fn of ['wireLineSwipe', 'wireLineDrag', 'toggleDoneSlide', 'persistLineOrder',
      'applyDropIndent', 'dropMargins', 'pinScroll', 'init']) {
      assert.ok(gestSrc.includes('function ' + fn), 'нет ' + fn + ' в src/gestures.js');
    }
    assert.ok(gestSrc.includes('isDragActive') && gestSrc.includes('window.EBGestures'),
      'нет флага жеста / UMD-экспорта модуля');
    assert.ok(appSrc.includes('window.EBGestures.wireLineSwipe(div, taskId)') &&
      appSrc.includes('window.EBGestures.wireLineDrag(div, grip, inp)') &&
      appSrc.includes('window.EBGestures.toggleDoneSlide(taskId)') &&
      appSrc.includes('window.EBGestures.isDragActive()'),
      'app.js не ходит в жесты через тонкие алиасы (вынос нечистый)');
    assert.ok(!appSrc.includes('function wireLineDrag(div, grip, inp) {\n  var pid') &&
      !appSrc.includes('function persistLineOrder') && !appSrc.includes('function dropMargins') &&
      !appSrc.includes('function applyDropIndent') && !appSrc.includes('function commitTrailingIntoBranch') &&
      !appSrc.includes('var dragActive = false') && !appSrc.includes('function pinScroll') &&
      !appSrc.includes("grip.addEventListener('pointerdown'"),
      'жесты остались в app.js (вынос нечистый)');
    assert.ok(appSrc.includes('EBGestures.init({') && appSrc.includes('toggleDoneNow: toggleDoneNow') &&
      appSrc.includes('openDuration: openDuration') && !appSrc.includes('touchLastPD: touchLastPD'),
      'app.js не отдаёт контекст модулю жестов / мосты черновика остались');
    assert.ok(!gestSrc.includes('C.getDraft()') && !gestSrc.includes('C.setDraft(') &&
      gestSrc.includes('C.getState()') && gestSrc.includes('C.getCollapsed()'),
      'модуль читает черновик / состояние не через контекст');
    assert.ok(html.includes('src/gestures.js') && swSrc.includes('src/gestures.js'),
      'модуль не подключён (index.html / sw.js)');
  });
  it('отрисовка — модуль src/render.js (этап 7, без черновика)', () => {
    for (const fn of ['render', 'renderLines', 'renderStatus', 'makeLine', 'makeGrip',
      'autosize', 'updateDurchip', 'refreshDurchips', 'lineEstMin', 'expandForAnchor',
      'init']) {
      assert.ok(rendSrc.includes('function ' + fn), 'нет ' + fn + ' в src/render.js');
    }
    assert.ok(rendSrc.includes('window.EBRender'),
      'нет UMD-экспорта модуля');
    assert.ok(appSrc.includes('window.EBRender.render()') &&
      appSrc.includes('window.EBRender.renderStatus()') &&
      !appSrc.includes('window.EBRender.focusTrailing()') &&
      appSrc.includes('window.EBRender.expandForAnchor(anchorId, indent)') &&
      appSrc.includes('window.EBRender.autosize(ta)') &&
      appSrc.includes('window.EBRender.updateDurchip(inp, chip)') &&
      appSrc.includes('window.EBRender.refreshDurchips(box)'),
      'app.js не ходит в отрисовку через тонкие алиасы (вынос нечистый)');
    assert.ok(!rendSrc.includes('function focusTrailing') &&
      !rendSrc.includes('function wireLineInput') &&
      !appSrc.includes('function renderLines') && !appSrc.includes('function makeLine') &&
      !appSrc.includes('function lineEstMin') && !appSrc.includes('function makeGrip'),
      'проводка ввода уехала в модуль / отрисовка осталась в app.js (вынос нечистый)');
    assert.ok(appSrc.includes('EBRender.init({') && appSrc.includes('deleteEmptyTask: deleteEmptyTask') &&
      appSrc.includes('toggleDoneHidden: toggleDoneHidden') && appSrc.includes('wireLineInput: wireLineInput'),
      'app.js не отдаёт контекст модулю отрисовки');
    assert.ok(!rendSrc.includes('C.getDraft()') && !rendSrc.includes('C.setDraft(') &&
      rendSrc.includes('C.getState()') && rendSrc.includes('C.getCollapsed()') &&
      rendSrc.includes('C.isDoneHidden()'),
      'модуль читает черновик напрямую / состояние не через контекст');
    assert.ok(html.includes('src/render.js') && swSrc.includes('src/render.js'),
      'модуль не подключён (index.html / sw.js)');
    assert.ok(!html.includes('testBanner'),
      'плашка тестовой версии осталась после конца рефакторинга');
  });
  it('шапка не уезжает за экран при открытой клавиатуре', () => {
    assert.ok(rendSrc.includes('function syncHeaderLift'), 'нет дотяжки шапки');
    assert.ok(rendSrc.includes('visualViewport') && rendSrc.includes('offsetTop') &&
      rendSrc.includes('translateY'),
      'шапка не едет за визуальным вьюпортом');
    assert.ok(rendSrc.includes("querySelector('header')"), 'дотяжка не той шапки');
    assert.ok(rendSrc.includes("tagName === 'TEXTAREA'") && rendSrc.includes('focusin') &&
      rendSrc.includes('focusout'),
      'шапка дотягивается не только пока идёт набор');
    assert.ok(rendSrc.includes("addEventListener('resize', syncHeaderLift") &&
      rendSrc.includes("addEventListener('scroll', syncHeaderLift"),
      'панелирование клавиатуры не слушается');
  });
  it('активная строка — в центр видимого места', () => {
    assert.ok(rendSrc.includes('function centerActiveLine'), 'нет центрирования активной строки');
    assert.ok(rendSrc.includes("addEventListener('focusin', centerActiveLine"),
      'центровка не на focusin');
    assert.ok(rendSrc.includes("closest('.tline')"),
      'центровка трогает не только строки задач');
    assert.ok(rendSrc.includes('offsetTop') && rendSrc.includes('innerHeight'),
      'центр считается не от видимой области');
    assert.ok(rendSrc.includes('if (visTop >= hh + gap && visBottom <= vh - gap) return;'),
      'видимое поле тоже двигают');
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
    for (const s of ['src/logic.js', 'src/search.js', 'src/diag.js', 'src/settings.js', 'src/history.js', 'src/triggers.js', 'src/gestures.js', 'src/render.js', 'store.js', 'sync.js', 'app.js']) {
      assert.ok(html.includes(s), 'нет ' + s + ' в index.html');
    }
  });
  it('все модули грузятся в Node (синтаксис браузерных скриптов)', () => {
    /* v154: правка комментария снесла `(function () {` в render.js —
     * строковые тесты зелёные, а приложение белый экран. require ловит. */
    for (const m of ['logic', 'search', 'diag', 'settings', 'history', 'triggers', 'gestures', 'render']) {
      assert.ok(require('../src/' + m + '.js'), 'не грузится src/' + m + '.js');
    }
  });
  it('токен живёт только в настройках', () => {
    assert.ok(!/type="password"/.test(html), 'постоянное поле пароля в html');
    assert.ok(settingsSrc.includes('tokenInput'), 'нет tokenInput');
    assert.ok(settingsSrc.includes('repoTokenBuild') && settingsSrc.includes('repoTokenDestroy'),
      'поле токена не создаётся/удаляется вместе с окном');
    assert.ok(settingsSrc.includes('getState()') && settingsSrc.includes('ctx.mutate') &&
      settingsSrc.includes('ctx.askConfirm') && settingsSrc.includes('ctx.doSync'),
      'модуль читает общее состояние напрямую, а не через контекст');
    assert.ok(appSrc.includes('EBSettings.init({'),
      'app.js не отдаёт контекст модулю настроек');
  });
  it('хранилище scoped под проект', () => {
    assert.ok(storeSrc.includes('external-brain-v1'), 'не тот LS-ключ');
    assert.ok(storeSrc.includes('normalizeTasks'), 'нет normalizeTasks в store');
  });
  it('service worker регистрируется, обновление перезагружает', () => {
    assert.ok(appSrc.includes('serviceWorker'), 'нет регистрации SW');
    assert.ok(appSrc.includes('controllerchange'), 'нет перезагрузки при смене контроллера');
  });
  it('поделиться приложением: ссылка страницы в системное меню', () => {
    assert.ok(html.includes('id="shareAppBtn"'), 'нет shareAppBtn в меню');
    assert.ok(appSrc.includes("on('shareAppBtn'"), 'нет подписки shareAppBtn');
    assert.ok(appSrc.includes('location.href'), 'шарится не ссылка страницы');
  });
});

describe('срок токена (v144–v145): поле, пороги 7/3, хинт 401', () => {
  it('поле срока в окне репозитория (не пароль, всегда в DOM)', () => {
    assert.ok(html.includes('id="repoExpInput"'), 'нет repoExpInput в index.html');
    assert.ok(html.includes('ДД.ММ.ГГГГ'), 'нет подсказки формата даты');
    assert.ok(!/id="repoExpInput"[^>]*type="password"/.test(html), 'поле срока — пароль');
  });
  it('срок хранится и пишется через нормализацию', () => {
    assert.ok(settingsSrc.includes('repoExpInput'), 'настройки не читают поле срока');
    assert.ok(settingsSrc.includes('normTokenExp'), 'срок пишется без нормализации');
    assert.ok(storeSrc.includes('tokenExp'), 'срок не хранится в store');
  });
  it('чистая логика: норма, дни, уровни 7/3', () => {
    for (const fn of ['normTokenExp', 'tokenDaysLeft', 'tokenWarnLevel']) {
      assert.ok(logicSrc.includes('function ' + fn), 'нет ' + fn + ' в src/logic.js');
    }
  });
  it('за 7 дней — строка в статусе, за 3 — окно раз в сутки', () => {
    assert.ok(rendSrc.includes('tokenWarnLevel'), 'статус не знает про срок токена');
    assert.ok(rendSrc.includes('Токен истекает!') && rendSrc.includes('Токен истёк'),
      'нет текстов порогов в статусе');
    assert.ok(trigSrc.includes('maybeWarnTokenExp'), 'нет разового окна о сроке');
    assert.ok(trigSrc.includes('external-brain-tokenwarn-v1'), 'окно без разового лимита в сутки');
    assert.ok(trigSrc.includes('tokenWarnLevel'), 'окно без проверки уровня 2');
  });
  it('срок виден в диагностике', () => {
    assert.ok(diagSrc.includes('tokenExp') || diagSrc.includes('срок вышел'),
      'нет срока токена в диагностике');
  });
  it('401 от GitHub расшифровывается человечески', () => {
    assert.ok(trigSrc.includes('401') && trigSrc.includes('токен истёк или отозван'),
      'нет хинта про истёкший токен при 401');
  });
  it('маска даты: только цифры, точки сами (вариант А)', () => {
    assert.ok(settingsSrc.includes('fmtExpDigits'), 'нет форматирования маски');
    assert.ok(settingsSrc.includes("ctx.on('repoExpInput', 'input'") &&
      settingsSrc.includes("ctx.on('repoExpInput', 'keydown'"),
      'маска не подписана на ввод/Backspace');
    assert.ok(settingsSrc.includes('expCaret'), 'каретка не держится за цифрой');
    assert.ok(html.includes('inputmode="numeric"'), 'нет цифровой клавиатуры у поля срока');
  });
});

describe('история версий (v148)', () => {
  it('пункт меню открывает страницу в новой вкладке (без двойного открытия)', () => {
    assert.ok(html.includes('id="versionsBtn"'), 'нет versionsBtn в меню');
    assert.ok(html.includes('docs/VERSIONS.html'), 'пункт не ведёт на VERSIONS.html');
    assert.ok(/id="versionsBtn"[^>]*target="_blank"/.test(html), 'история не в новой вкладке');
  });
  it('страница в офлайн-кэше и закрывается на iPhone', () => {
    const ver = fs.readFileSync(path.join(root, 'docs/VERSIONS.html'), 'utf8');
    assert.ok(ver.includes('id="guideClose"'), 'страницу не закрыть на iPhone');
    assert.ok(ver.includes("window.history.back()") && ver.includes("window.location.href = '../'"),
      'закрытие без цепочки закрыть/назад/на главную');
  });
  it('страница уезжает в прод (сборка Pages её копирует)', () => {
    assert.ok(pagesYml.includes('docs/VERSIONS.html'), 'VERSIONS.html нет в сборке _site — в проде будет 404');
  });
  it('история полная: от v1 до текущей версии', () => {
    const ver = fs.readFileSync(path.join(root, 'docs/VERSIONS.html'), 'utf8');
    const m = appSrc.match(/APP_VERSION\s*=\s*'([^']+)'/);
    const appV = m && m[1];
    assert.ok(ver.includes('<b>v1</b>'), 'нет первой версии');
    assert.ok(appV && ver.includes('<b>' + appV + '</b>'), 'нет текущей версии ' + appV);
  });
});

describe('удаление свайпом (v150)', () => {
  it('панель шире: зелёная + красная кнопки', () => {
    assert.ok(html.includes('.tline.swiped .delflag'), 'нет кнопки удаления в панели');
    assert.ok(html.includes('translateX(-200px)'), 'панель не расширена под две кнопки');
    assert.ok(rendSrc.includes("del.className = 'delflag'"), 'строка не строит кнопку удаления');
    assert.ok(rendSrc.includes('C.askDeleteTask(id)'), 'кнопка не зовёт удаление');
    assert.ok(rendSrc.includes("aria-label', 'Удалить задачу"), 'нет подсказки у кнопки');
  });
  it('удаление через историю, с подтверждением', () => {
    assert.ok(appSrc.includes('function askDeleteTask(taskId)'), 'нет askDeleteTask');
    assert.ok(appSrc.includes('L.removeTask(state.tasks, taskId)'), 'удаление не tombstone');
    assert.ok(appSrc.includes('askDeleteTask: askDeleteTask'), 'удаление не отдано отрисовке');
    assert.ok(/Удалить задачу/.test(appSrc), 'нет подтверждения удаления');
  });
  it('тап по кнопке не закрывает панель', () => {
    assert.ok(gestSrc.includes('.delflag'), 'тап по удалению закрывает панель');
  });
  it('пустая строка: одна кнопка удаления, сквозной клик глушится', () => {
    assert.ok(rendSrc.includes('if (!rowEmpty)'), 'красная кнопка и на пустой строке — две «Удалить»');
    assert.ok(rendSrc.includes('clickBlocked'), 'нет глушения сквозного клика');
    assert.ok(rendSrc.includes('_ebUIClickBlocked'), 'нет метки блокировки кликов');
    assert.ok(appSrc.includes('_ebUIClickBlocked'), 'удаление не взводит блокировку');
  });
});
