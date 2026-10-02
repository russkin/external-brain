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
    const fns = ['createTask', 'clarifyTask', 'completeTask', 'reopenTask', 'removeTask', 'setFrog', 'setSlices', 'completeSlice', 'setIndent'];
    for (const fn of fns) {
      assert.ok(!new RegExp('L\\.' + fn + '\\(state[^.]').test(appSrc), 'найден вызов ' + fn + '(state, …)');
    }
    for (const fn of ['createTask', 'clarifyTask', 'removeTask', 'getTask', 'setIndent', 'reopenTask']) {
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
  it('отступ по месту отпускания: родители→0, внутри→от соседа', () => {
    assert.ok(appSrc.includes('applyDropIndent'), 'нет пересчёта отступа при drop');
    assert.ok(appSrc.includes('prevInd'), 'не смотрим соседа сверху');
    assert.ok(appSrc.includes('nextInd'), 'не смотрим соседа снизу');
  });
  it('группы отступом: сдвиг за grip, наследование, потолок +1', () => {
    assert.ok(appSrc.includes('INDENT_STEP'), 'нет шага отступа');
    assert.ok(appSrc.includes('marginLeft'), 'отступ не применяется к строке');
    assert.ok(appSrc.includes('lineIndent'), 'нет чтения уровня отступа');
    assert.ok(appSrc.includes('indentBounds'), 'нет потолка «сосед сверху +1»');
    assert.ok(appSrc.includes('{ indent:'), 'новая строка не наследует отступ');
  });
  it('уровни цветом, collapse, шапка с тремя кнопками', () => {
    assert.ok(html.includes('.tline[data-indent="1"]'), 'нет заливки уровней');
    assert.ok(html.includes('id="collapseAllBtn"'), 'нет кнопки свернуть всё');
    assert.ok(html.includes('id="expandAllBtn"'), 'нет кнопки развернуть всё');
    assert.ok(html.includes('id="deleteDoneBtn"'), 'нет кнопки удалить выполненные');
    assert.ok(appSrc.includes('toggleCollapse'), 'нет сворачивания по тапу');
    assert.ok(appSrc.includes('setAllCollapsed'), 'нет свернуть/развернуть всё');
    assert.ok(appSrc.includes('askClearDone'), 'нет удаления выполненных с подтверждением');
    assert.ok(appSrc.includes('collapsed-kid'), 'нет скрытия вложенных');
  });
  it('свайп-выполнено и секция под полем ввода', () => {
    assert.ok(html.includes('doneflag') || appSrc.includes('doneflag'), 'нет флага выполнено');
    assert.ok(appSrc.includes('swiped'), 'нет раскрытия свайпом');
    assert.ok(appSrc.includes('toggleDoneSlide'), 'нет завершения со слайдом');
    assert.ok(appSrc.includes('L.doneList(state.tasks)'), 'нет секции выполненных');
    assert.ok(appSrc.includes('done-sep'), 'нет разделителя выполненных');
    assert.ok(appSrc.includes('is-done'), 'нет зачёркивания');
    assert.ok(html.includes('user-select'), 'свайп проигрывает выделению текста');
    assert.ok(appSrc.includes('_swOpen'), 'состояние свайпа рассинхронизировано');
    assert.ok(html.includes('translateX(-108px)'), 'флаг наезжает на поле задачи');
    assert.ok(appSrc.includes('activeElement'), 'курсор остаётся в поле после выполнения');
  });
  it('возврат из выполненных и история undo/redo', () => {
    assert.ok(appSrc.includes('Не выполнено'), 'нет флага возврата');
    assert.ok(appSrc.includes('L.reopenTask(state.tasks'), 'нет возврата задачи');
    assert.ok(appSrc.includes('completeBranch'), 'ветка не выполняется целиком');
    assert.ok(appSrc.includes('reopenBranch'), 'ветка не возвращается целиком');
    assert.ok(appSrc.includes('hasLiveParent'), 'нет проверки живого родителя при возврате ветки');
    assert.ok(appSrc.includes('setIndent(state.tasks, taskId, 0)'), 'отступ вернувшейся не сбрасывается');
    assert.ok(html.includes('id="undoBtn"'), 'нет стрелки назад');
    assert.ok(html.includes('id="redoBtn"'), 'нет стрелки вперёд');
    assert.ok(appSrc.includes('doUndo'), 'нет undo');
    assert.ok(appSrc.includes('doRedo'), 'нет redo');
    assert.ok(appSrc.includes('HISTORY_MAX'), 'история без лимита');
    assert.ok(appSrc.includes('deleted = true'), 'отмена создания не переживёт синк');
  });
  it('черновик: удаление, сдвиг, перетаскивание; выполненные не таскаем', () => {
    assert.ok(appSrc.includes('dismissDraft'), 'черновик нельзя убрать');
    assert.ok(appSrc.includes('trailingIndent'), 'у черновика нет своего отступа');
    assert.ok(appSrc.includes('Backspace'), 'нет сброса пустого поля');
    assert.ok(appSrc.includes('placeTaskTop'), 'нет создания в начало');
    assert.ok(appSrc.includes('не таскаем'), 'нет запрета drag выполненных');
  });
  it('Backspace: сцепка с предыдущей, черновик создаётся и курсор уезжает вверх', () => {
    assert.ok(appSrc.includes('function mergeTaskIntoPrev'), 'нет сцепки строк по Backspace');
    assert.ok(appSrc.includes('function backspaceCreateDraft'), 'нет создания черновика по Backspace');
    assert.ok(appSrc.includes('String(prev.title || \'\') + \' \' + curText'),
      'между наименованиями нет пробела');
    var iM = appSrc.indexOf('function mergeTaskIntoPrev');
    var mBody = appSrc.slice(iM, appSrc.indexOf('function commitLine'));
    assert.ok(mBody.includes('L.removeTask(state.tasks, cur.id)'), 'текущая строка не удаляется');
    assert.ok(mBody.includes('trailingAfterId === cur.id'), 'поле под строкой остаётся на мёртвом якоре');
    assert.ok(mBody.includes('focusTaskEnd(prev.id, prevLen + 1)'),
      'курсор не встаёт на стык верхней и перенесённого');
    assert.ok(mBody.includes('liveVal'), 'сцепка идёт не по живому значению строки');
    assert.ok(mBody.indexOf('var prevLen = String(prev.title') < mBody.lastIndexOf('mutate(function'),
      'длина верхней не запомнена до склейки');
    var iB = appSrc.indexOf('function backspaceCreateDraft');
    var bBody = appSrc.slice(iB, iB + 700);
    assert.ok(bBody.includes('focusTaskEnd(anchor || created.id)'), 'курсор не уезжает в задачу сверху');
    var iK = appSrc.indexOf("inp.addEventListener('keydown'");
    var kBody = appSrc.slice(iK, iK + 1400);
    assert.ok(kBody.includes('backspaceCreateDraft()') && kBody.includes('mergeTaskIntoPrev(taskId, inp.value)'),
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
    assert.ok(appSrc.includes('trailingAfterId === taskId'),
      'поле-продолжение не переякоривается на хвост');
    assert.ok(appSrc.includes('function focusLineStart'), 'нет фокуса в начало строки');
    var iSp = appSrc.indexOf('var splitPos = inp.selectionStart');
    var spBody = appSrc.slice(iSp, appSrc.indexOf('commitLine(taskId, inp.value', iSp));
    assert.ok(spBody.includes('clearTimeout(saveTimer)'),
      'отложенное сохранение ввода вернёт перенесённый хвост обратно');
    assert.ok(spBody.includes('splitVal.slice(0, splitPos).trim()'),
      'в левой части остаётся лишний пробел');
  });
  it('Enter в строке даёт пустое поле ниже, а не фокус дальше', () => {
    assert.ok(appSrc.includes('trailingAfterId'), 'пустое поле не переезжает');
    assert.ok(appSrc.includes('placeTaskAfter'), 'нет вставки по месту');
    assert.ok(!appSrc.includes('focusLineAfter'), 'старый фокус дальше остался');
    assert.ok(appSrc.includes('trailingText'), 'текст поля теряется при перерисовке');
  });
  it('пустое поле не висит при длинном списке', () => {
    assert.ok(appSrc.includes('showDraft'), 'нет гейта пустого поля');
    assert.ok(appSrc.includes('tasks.length <= 1'), 'поле не ограничено коротким списком');
    assert.ok(appSrc.includes('hasDraftText'), 'набранный текст поля может потеряться');
  });
  it('Enter продолжает уровень: дочерняя за дочерней', () => {
    assert.ok(appSrc.includes('trailingIndent = lineIndent(created)'), 'цепочка не держит отступ');
    assert.ok(appSrc.includes('var newIndent = lineIndent(moved)'), 'Enter в строке не даёт сестру');
  });
  it('отмена Enter: сначала поле, потом задача', () => {
    assert.ok(appSrc.includes('function snapFull'), 'нет полного слепка с полем');
    assert.ok(appSrc.includes('afterId: oldAnchor'), 'появление поля не делится в истории');
    assert.ok(appSrc.includes('snapTasks() !== tasksJson'), 'возврат поля дёргает метки синка');
  });
  it('отмена убирает вызванное поле и возвращает курсор', () => {
    assert.ok(appSrc.includes('focusId: taskId'), 'Enter не пишет точку с фокусом');
    assert.ok(appSrc.includes('focusTaskEnd'), 'курсор не возвращается в конец задачи');
    assert.ok(appSrc.includes('setSelectionRange'), 'курсор не ставится в конец');
    assert.ok(appSrc.includes('focusAfterHistory'), 'отмена не ведёт курсор');
    assert.ok(appSrc.includes('snapChainLive'), 'курсор путает концевое поле с вызванным');
  });
  it('перетаскивание пустого поля пишется в историю', () => {
    assert.ok(appSrc.includes('dragUiBefore'), 'старт drag не запоминает поле');
    assert.ok(appSrc.includes('dragUiBefore.afterId'), 'возврат поля не знает старое место');
  });
  it('перенос черновика берёт отступ соседа сверху', () => {
    assert.ok(appSrc.includes('var wantInd'), 'нет расчёта отступа при посадке поля');
    assert.ok(appSrc.includes('trailingIndent = wantInd'), 'перенос поля не ставит отступ по месту');
    assert.ok(appSrc.includes('wantInd !== oldInd'), 'смена только отступа не пишется в историю');
  });
  it('потеря фокуса поля создаёт задачу', () => {
    assert.ok(appSrc.includes("addEventListener('blur'"), 'нет blur-обработчика поля');
    assert.ok(appSrc.includes('createDraftOnBlur'), 'нет создания по потере фокуса');
    assert.ok(appSrc.includes('draftBlurTimer'), 'blur не отложен до смены фокуса');
    assert.ok(appSrc.includes("closest('.grip') || lastPDTarget.closest('.doneflag')"),
      'жесты флага/грипа не защищены от blur-создания');
    assert.ok(appSrc.includes('document.contains(inp)'), 'создание не ждёт удалённое поле');
    var blurBody = appSrc.slice(appSrc.indexOf('function createDraftOnBlur'),
      appSrc.indexOf('function commitLine'));
    assert.ok(blurBody.includes('trailingAfterId = null'),
      'после blur-create поле-продолжение остаётся');
    assert.ok(!blurBody.includes('undoStack.push'),
      'лишняя точка истории в blur-create (должна быть одна — от mutate)');
  });
  it('Enter в строке доводит висячий черновик до конца', () => {
    var idxL = appSrc.indexOf('var lingering');
    assert.ok(idxL !== -1, 'нет доводки набранного черновика');
    var idxP = appSrc.indexOf('placeTaskAfter', idxL);
    var idxC = appSrc.indexOf('commitLine(taskId', idxL);
    assert.ok(idxP > idxL && idxC > idxP, 'черновик создаётся не на своём месте до commitLine');
    var block = appSrc.slice(idxL, idxC);
    assert.ok(block.includes('trailingAfterId = null'), 'после создания черновик не очищен');
    assert.ok(block.includes('effTrailingIndent()'), 'отступ висячего черновика не из состояния');
    assert.ok(block.includes('trailingText = \'\''), 'текст висячего черновика не стёрт');
  });
  it('Enter в родителе: поле на уровне первой дочерней', () => {
    var iN = appSrc.indexOf('var newIndent');
    assert.ok(iN !== -1, 'нет расчёта отступа поля под строкой');
    var iA = appSrc.indexOf('trailingIndent = newIndent', iN);
    assert.ok(iA > iN, 'отступ не считается до присваивания');
    var block = appSrc.slice(iN, iA);
    assert.ok(block.includes('lineIndent(nx) > newIndent'),
      'первая дочерняя не подхватывается (поле уходит на уровень родителя)');
    assert.ok(block.includes('lineTasks()'), 'следующая строка не из живого списка');
    assert.ok(block.includes('effTrailingIndent() !== newIndent'),
      'повторный вызов поля пишет лишнюю точку истории');
  });
  it('Enter с кареткой в начале: поле над текущей строкой', () => {
    assert.ok(appSrc.includes('inp.selectionStart === 0 && inp.selectionEnd === 0'),
      'нет распознавания каретки в начале текста');
    assert.ok(appSrc.includes("newAnchor = li > 0 ? lt[li - 1].id : 'TOP'"),
      'нет якоря перед текущей строкой (или TOP для первой)');
    assert.ok(appSrc.includes('trailingAfterId = newAnchor'), 'поле не ставится по новому якорю');
    assert.ok(appSrc.includes('trailingIndent = newIndent'),
      'поле над строкой не берёт её отступ');
    var iTop = appSrc.indexOf("showDraft && trailingAfterId === 'TOP'");
    assert.ok(iTop !== -1 && appSrc.slice(iTop, iTop + 220).includes('tailIndent'),
      'поле сверху игнорирует отступ из состояния');
  });
  it('захват grip сбрасывает фокус, коммит не рендерит во время жеста', () => {
    assert.ok(appSrc.includes('var dragActive = false'), 'нет флага жеста');
    assert.ok(appSrc.includes('if (!dragActive) render()'), 'mutate рендерит во время жеста');
    var iP = appSrc.indexOf("grip.addEventListener('pointerdown'");
    assert.ok(iP !== -1, 'нет обработчика захвата grip');
    var block = appSrc.slice(iP, iP + 2400);
    assert.ok(block.includes('dragActive = true'), 'флаг не поднимается на захвате');
    assert.ok(block.includes('.blur()'), 'фокус не сбрасывается при захвате grip');
    assert.ok(block.includes('refocusDraft'), 'черновик не запоминается для возврата курсора');
    assert.ok(block.includes("div.getAttribute('data-trailing')"),
      'возврат курсора не привязан к переносу самого поля (чужой жест возвращает фокус)');
    var iF = appSrc.indexOf('function finish(e)');
    assert.ok(iF !== -1 && appSrc.slice(iF, iF + 700).includes('dragActive = false'),
      'флаг не снимается на финише жеста');
    assert.ok(appSrc.slice(iF, iF + 700).includes('focusTrailing()'),
      'поле не возвращает курсор после переноса');
  });
  it('свайп и отметка выполненной снимают фокус, поле уходит с веткой', () => {
    var iS = appSrc.indexOf('function wireLineSwipe');
    var swBlock = appSrc.slice(iS, appSrc.indexOf('function commitTrailingIntoBranch'));
    assert.ok(swBlock.includes('draftTapBusy = true'), 'свайп не гасит blur-создание черновика');
    assert.ok(swBlock.includes('.blur()'), 'свайп не снимает фокус с полей');
    assert.ok(swBlock.includes('dragActive = true'), 'render во время свайпа не подавлен');
    assert.ok(swBlock.includes('dragActive = false'), 'подавление render не снимается на конце свайпа');
    assert.ok(swBlock.includes('setPointerCapture'), 'отпускание мимо строки оставляет флаг жеста');
    assert.ok(appSrc.includes('function commitTrailingIntoBranch'), 'нет доводки поля при завершении ветки');
    assert.ok(appSrc.includes('fi <= base'), 'отступ поля не углубляется под родителем ветки');
    var iT = appSrc.indexOf('function toggleDoneSlide');
    var tBlock = appSrc.slice(iT, appSrc.indexOf('function hasLiveParent'));
    assert.ok(tBlock.includes('commitTrailingIntoBranch(taskId)'), 'поле не до-создаётся при отметке');
    assert.ok(tBlock.includes("tagName === 'TEXTAREA'"), 'отметка не снимает фокус с полей');
  });
  it('компактные строки: высота уменьшена', () => {
    assert.ok(html.includes('padding: 6px 12px'), 'поле ввода не ужато');
  });
  it('перенос текста: многострочное поле', () => {
    assert.ok(appSrc.includes('textarea'), 'нет textarea вместо input');
    assert.ok(appSrc.includes('autosize'), 'поле не растёт за текстом');
    assert.ok(appSrc.includes('shiftKey'), 'Shift+Enter не отделён от Enter');
    assert.ok(html.includes('resize: none'), 'поле можно растягивать вручную');
    assert.ok(html.includes('overflow-y'), 'нет скрытия скролла поля');
  });
  it('групповой drag: дети прячутся под родителя и едут с ним', () => {
    assert.ok(appSrc.includes('kids'), 'дети не собираются при drag');
    assert.ok(appSrc.includes('holeShift'), 'дыра не покрывает весь блок');
  });
  it('позиция страницы не прыгает, автопрокрутка не дёргает', () => {
    assert.ok(appSrc.includes('keepY'), 'скролл не сохраняется при перерисовке');
    assert.ok(appSrc.includes('scrollTo(0, keepY)'), 'скролл не возвращается');
    assert.ok(appSrc.includes('minHeight'), 'высота списка не фиксируется на время drag');
    assert.ok(appSrc.includes('lastScrollTs'), 'автопрокрутка без троттлинга');
    assert.ok(appSrc.includes('dragDist'), 'автопрокрутка без порога движения');
  });
  it('перетаскивание: слепок на захвате, сдвиги соседей, посадка после', () => {
    assert.ok(appSrc.includes('pointerdown'), 'нет pointerdown на grip');
    assert.ok(appSrc.includes('pointermove'), 'нет pointermove для живого drag');
    assert.ok(appSrc.includes('pointerup'), 'нет pointerup для завершения drag');
    assert.ok(appSrc.includes('setPointerCapture'), 'нет захвата указателя');
    assert.ok(!appSrc.includes('phold'), 'placeholder-раскладка вместо сдвигов');
    assert.ok(!appSrc.includes('cloneNode'), 'призрак вместо самой строки');
    assert.ok(appSrc.includes('holeShift'), 'нет высоты блока для дыры');
    assert.ok(appSrc.includes('setHole'), 'дыра не открывается сдвигами');
    assert.ok(appSrc.includes('PEN'), 'нет порога въезда ведущим краем');
    assert.ok(appSrc.includes('divH'), 'нет высоты тянущейся для симметрии вверх/вниз');
    assert.ok(appSrc.includes('.18s linear'), 'анимация не линейная');
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
