/* logic.js — чистая логика «Внешнего мозга» без DOM.
 * Совместимость: ES2017 без optional chaining, работает в Node и в браузере.
 * Модель (плоский список, как задачи в Google Keep): статусы 'inbox'/'next'
 *   УДАЛЕНЫ (T-cleanup-inbox-next, в UI не различались — всё живое теперь
 *   'todo'); старые данные с ними нормализация молча приводит к 'todo'.
  *   task = { id, title, status, estMin, sumKids, planDate, planFired,
  *            indent, createdAt, updatedAt, doneAt, ts, deleted }
  *   sumKids: у родителя — считать ли метку авто-суммой вложенных (по
  *            умолчанию true; false — своё estMin вручную, как у листа).
  *   planDate/planFired (ФАЗА 0 планирования, FR-95–FR-101): дата плана
  *            'ДД.ММ.ГГГГ' ('' — не план) + момент срабатывания (0 — ждёт);
  *            оба поля — в whitelist, смена даты сбрасывает planFired.
 *   status: 'todo' (живая) | 'done' (готово)
 *   indent: уровень отступа 0..8 — задача с отступом входит в группу задачи
 *           без отступа (или с меньшим отступом) сверху.
 * Правила:
 *   - всё новое падает в список живых, цель — пустой список;
 *   - правка полей задачи — через clarifyTask;
 *   - нарезка (slicesTotal/slicesDone) УДАЛЕНА в v77 — из UI не управлялась,
 *     в живых задачах не использовалась;
 *   - удаление — tombstone (deleted=true), чтобы синк не воскрешал/не терял.
 */
'use strict';

var STATUSES = ['todo', 'done'];

var _counter = 0;

function normTitle(s) {
  return String(s == null ? '' : s).trim().slice(0, 500);
}

function isStatus(s) {
  return STATUSES.indexOf(s) !== -1;
}

function toInt(n, fallback) {
  var v = parseInt(n, 10);
  if (!(v >= 0)) return fallback;
  return v;
}

var MAX_INDENT = 8;

/* Уровень отступа 0..MAX_INDENT. Мусор (строки, минусы, null) — в 0. */
function normIndent(n) {
  var v = toInt(n, 0);
  if (v > MAX_INDENT) return MAX_INDENT;
  return v;
}

function makeId(nowMs, hint) {
  _counter += 1;
  var t = toInt(nowMs, Date.now());
  var h = hint ? String(hint).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) : '';
  return 't' + t + '-' + _counter + (h ? '-' + h : '');
}

function blankTasks() {
  return [];
}

function getTask(tasks, id) {
  for (var i = 0; i < tasks.length; i++) {
    if (tasks[i] && tasks[i].id === id) return tasks[i];
  }
  return null;
}

/* Создать живую задачу. Пустой заголовок — вернуть null, ничего не трогать. */
function createTask(tasks, title, nowMs, opts) {
  opts = opts || {};
  var t = normTitle(title);
  if (!t && !opts.allowEmpty) return null;
  var now = toInt(nowMs, Date.now());
  var task = {
    id: opts.id ? String(opts.id) : makeId(now),
    title: t,
    status: 'todo',
    estMin: normEst(opts.estMin),
    sumKids: true,
    indent: normIndent(opts.indent),
    createdAt: now,
    updatedAt: now,
    doneAt: 0,
    ts: now,
    deleted: false
  };
  tasks.push(task);
  return task;
}

/* Правка полей задачи: patch
 * { status, title, indent, estMin, sumKids, planDate }. Невалидный status игнорируется.
 * Смена planDate ВСЕГДА сбрасывает planFired=0 (повторное срабатывание). */
function clarifyTask(tasks, id, patch, nowMs) {
  var task = getTask(tasks, id);
  if (!task || task.deleted) return null;
  var now = toInt(nowMs, Date.now());
  patch = patch || {};
  if (patch.status != null) {
    var s = String(patch.status);
    if (isStatus(s)) {
      task.status = s;
      task.doneAt = (s === 'done') ? now : 0;
    }
  }
  if (patch.title != null) task.title = normTitle(patch.title);
  if (patch.indent != null) task.indent = normIndent(patch.indent);
  if (patch.estMin != null) task.estMin = normEst(patch.estMin);
  if (patch.sumKids != null) task.sumKids = patch.sumKids !== false;
  if (patch.planDate != null) {
    var nd = normPlanDate(patch.planDate);
    if (nd !== normPlanDate(task.planDate)) {
      task.planDate = nd;
      task.planFired = 0;
    }
  }
  /* Повтор (v213): patch.repeat = объект (выставить/пересчитать) | null
   * (снять). Идёт ПОСЛЕ planDate — weekday-подгибка и якорный день
   * считают от уже записанной даты; сама подгибка сбрасывает planFired. */
  if (patch.repeat !== undefined) applyRepeatToTask(task, patch.repeat, now);
  task.updatedAt = now;
  task.ts = now;
  return task;
}

function completeTask(tasks, id, nowMs) {
  var task = getTask(tasks, id);
  if (!task || task.deleted) return null;
  var now = toInt(nowMs, Date.now());
  task.status = 'done';
  task.doneAt = now;
  task.updatedAt = now;
  task.ts = now;
  return task;
}

/* Выполнить ветку: задачу и всех вложенных ниже (по порядку массива —
 * передавать lineTasks()). doneAt убывает: родитель выше детей в секции
 * выполненных. Возвращает id выполненных. */
function completeBranch(arr, id, nowMs) {
  if (!Array.isArray(arr)) return [];
  var idx = -1;
  for (var i = 0; i < arr.length; i++) {
    if (arr[i] && arr[i].id === id) { idx = i; break; }
  }
  if (idx === -1) return [];
  var now = toInt(nowMs, Date.now());
  var base = normIndent(arr[idx].indent);
  var done = [];
  for (var j = idx; j < arr.length; j++) {
    var t = arr[j];
    if (!t || t.deleted) continue;
    if (j > idx && normIndent(t.indent) <= base) break;
    if (t.status === 'done') continue;
    t.status = 'done';
    t.doneAt = now - done.length;
    t.updatedAt = now;
    t.ts = now;
    done.push(t.id);
  }
  return done;
}

function reopenTask(tasks, id, nowMs) {
  var task = getTask(tasks, id);
  if (!task || task.deleted) return null;
  var now = toInt(nowMs, Date.now());
  var planned = isPlanned(task);
  if (task.status !== 'done') {
    /* Сработавший план (v214): status остался todo, но строка показана
     * выполненной (planDoneShown). Без сброса planFired кнопка была бы
     * мёртвой (ранний return) и строка не ушла бы из секции выполненных:
     * «↩ Не выполнено» = вернуть в ожидание, как смена даты (FR-97). */
    if (planned && toInt(task.planFired, 0) !== 0) {
      task.planFired = 0;
      task.updatedAt = now;
      task.ts = now;
      return task;
    }
    return task;
  }
  task.status = 'todo';
  task.doneAt = 0;
  /* План снимаем и с галочки огня: выполненный вручную и сработавший
   * одновременно (старые версии) тоже должен снова ждать. */
  if (planned && toInt(task.planFired, 0) !== 0) task.planFired = 0;
  task.updatedAt = now;
  task.ts = now;
  return task;
}

/* Вернуть ветку: задачу и всех вложенных ниже — зеркало completeBranch.
 * Порядок структурный (createdAt, затем id): выполненные в секции done
 * лежат по doneAt и для отступов не годятся, поэтому массив-аргумент
 * не принимаем — работаем со всем списком по ссылкам (мутируем оригиналы).
 * Живые (не done) пропускаем, но ветку не обрываем. Возвращает id
 * возвращённых. Отступы не трогаем — это делает вызывающий UI. */
function reopenBranch(tasks, id, nowMs) {
  if (!Array.isArray(tasks)) return [];
  var now = toInt(nowMs, Date.now());
  var ordered = [];
  for (var k = 0; k < tasks.length; k++) {
    if (tasks[k] && tasks[k].id) ordered.push(tasks[k]);
  }
  ordered.sort(function (a, b) {
    var ca = toInt(a.createdAt, 0), cb = toInt(b.createdAt, 0);
    if (ca !== cb) return ca - cb;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  });
  var idx = -1;
  for (var i = 0; i < ordered.length; i++) {
    if (ordered[i].id === id) { idx = i; break; }
  }
  if (idx === -1) return [];
  var base = normIndent(ordered[idx].indent);
  var back = [];
  for (var j = idx; j < ordered.length; j++) {
    var t = ordered[j];
    if (!t || t.deleted) continue;
    if (j > idx && normIndent(t.indent) <= base) break;
    if (t.status !== 'done') continue;
    t.status = 'todo';
    t.doneAt = 0;
    t.updatedAt = now;
    t.ts = now;
    back.push(t.id);
  }
  return back;
}

/* Удаление — tombstone, чтобы LWW-синк не воскрешал задачу на других устройствах. */
function removeTask(tasks, id, nowMs) {
  var task = getTask(tasks, id);
  if (!task) return null;
  var now = toInt(nowMs, Date.now());
  task.deleted = true;
  task.updatedAt = now;
  task.ts = now;
  return task;
}

/* Сжатие могил: tombstone заменяется минимальным маркером
 * {id, deleted, ts/updatedAt, min:true} (флаг — чтобы диагностика
 * отличала сжатые от полных; whitelist его хранит, старые версии
 * вычищают) — вес файла составляют могилы (текст
 * и поля), поэтому сжимаются ВСЕ могилы, а не только с текстом: иначе
 * счёт «живые + сжатие» не сходится с размером файла и путает.
 * Маркер свежее (ts = max(now, старая)): забытое устройство с живой копией
 * его не воскресит (LWW побеждает свежий), могилы с других устройств сами
 * сойдутся в маркеры при слиянии. Возвращает число сжатых. */
function purgeTombstones(tasks, nowMs) {
  if (!Array.isArray(tasks)) return 0;
  var now = toInt(nowMs, Date.now());
  var n = 0;
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    if (!t || !t.id || !t.deleted) continue;
    var ts = toInt(t.ts, 0);
    if (now > ts) ts = now;
    tasks[i] = { id: String(t.id).slice(0, 64), deleted: true, ts: ts, updatedAt: ts, min: true };
    n++;
  }
  return n;
}

/* Отступ: задача с отступом входит в группу задачи сверху.
 * Уровень ограничен 0..MAX_INDENT; правило «не глубже соседа сверху +1»
 * держит UI, сюда приходит уже проверенное значение. */
function setIndent(tasks, id, level, nowMs) {
  var task = getTask(tasks, id);
  if (!task || task.deleted) return null;
  var now = toInt(nowMs, Date.now());
  task.indent = normIndent(level);
  task.updatedAt = now;
  task.ts = now;
  return task;
}

/* --- Группы: работа с упорядоченным массивом (порядок = экран сверху вниз) --- */

function indentOf(t) {
  return normIndent(t && t.indent);
}

/* Есть ли у строки idx вложенные (следующие с большим отступом до равного). */
function hasKids(arr, idx) {
  if (!arr || idx == null || !arr[idx]) return false;
  var base = indentOf(arr[idx]);
  for (var j = idx + 1; j < arr.length; j++) {
    var v = indentOf(arr[j]);
    if (v > base) return true;
    if (v <= base) return false;
  }
  return false;
}

/* Показывать ли зачёркнутой: своя done или done у родителя выше по цепочке. */
function isDoneShown(arr, idx) {
  var t = arr ? arr[idx] : null;
  if (!t) return false;
  if (t.status === 'done') return true;
  var ind = indentOf(t);
  for (var j = idx - 1; j >= 0; j--) {
    if (indentOf(arr[j]) < ind) return isDoneShown(arr, j);
  }
  return false;
}

/* Спрятана ли строка под свёрнутого родителя (collapsed: {id:true}). */
function isHiddenByCollapse(arr, idx, collapsed) {
  if (!arr || !arr[idx]) return false;
  var ind = indentOf(arr[idx]);
  for (var j = idx - 1; j >= 0; j--) {
    var pj = indentOf(arr[j]);
    if (pj < ind) {
      if (collapsed && arr[j].id && collapsed[arr[j].id]) return true;
      ind = pj;
    }
  }
  return false;
}

function isAlive(t) {
  return !!t && !t.deleted;
}

/* Поиск: регистр не важен, ё=е. Пустой запрос — пусто. Возвращает id
 * в порядке переданного массива (порядок экрана готовит вызывающий). */
function normSearch(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/ё/g, 'е');
}

function searchTasks(tasks, query) {
  var q = normSearch(query).trim();
  if (!q || !Array.isArray(tasks)) return [];
  var out = [];
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    if (!t || t.deleted || !t.title) continue;
    if (isPlanned(t)) continue;
    if (normSearch(t.title).indexOf(q) !== -1) out.push(t.id);
  }
  return out;
}

function byStatus(tasks, status) {
  return tasks.filter(function (t) { return isAlive(t) && t.status === status; });
}

/* Живые задачи по времени создания (T-cleanup-inbox-next: inbox/next
 * слиты в todo — списков по ним больше нет). */
function todoList(tasks) {
  return byStatus(tasks, 'todo').sort(function (a, b) { return a.createdAt - b.createdAt; });
}

function doneList(tasks) {
  return byStatus(tasks, 'done').sort(function (a, b) { return b.doneAt - a.doneAt; });
}

/* Корзина (v215): всё, что ПОКАЗАНО выполненным — вручную отмеченные
 * задачи И сработавшие планы (planDoneShown). Планы на первой странице
 * не видны (lineTasks их пропускает), но лежат в «Выполнено» на
 * второй — без этого списка 🗑 со страницы 1 их не трогал вовсе. */
function doneShownList(tasks) {
  var out = [];
  if (!tasks) return out;
  for (var i = 0; i < tasks.length; i++) {
    if (isAlive(tasks[i]) && planDoneShown(tasks[i])) out.push(tasks[i]);
  }
  return out;
}

function todoCount(tasks) {
  return todoList(tasks).filter(function (t) { return !!t.title && !isPlanned(t); }).length;
}

function stats(tasks) {
  var tl = [];
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    if (t && !t.deleted && t.title && !isPlanned(t)) tl.push(t);
  }
  return {
    todo: todoList(tl).length,
    done: doneList(tl).length
  };
}

/* Текст для «Поделиться»: как на экране — живые по порядку с отступами,
 * ниже выполненные (новые выше). */
function shareItem(t) {
  var pad = '';
  for (var k = 0; k < normIndent(t.indent); k++) pad += '  ';
  var s = pad + '- ' + t.title;
  return s;
}

function shareText(tasks) {
  var lines = [];
  var all = normalizeTasks(tasks).filter(function (t) { return !t.deleted && t.title && !isPlanned(t); });
  var i, t;
  for (i = 0; i < all.length; i++) {
    t = all[i];
    if (t.status === 'done') continue;
    lines.push(shareItem(t));
  }
  var done = [];
  for (i = 0; i < all.length; i++) {
    if (all[i].status === 'done') done.push(all[i]);
  }
  done.sort(function (a, b) { return (b.doneAt || 0) - (a.doneAt || 0); });
  if (done.length) {
    if (lines.length) lines.push('');
    lines.push('Выполнено:');
    for (i = 0; i < done.length; i++) lines.push(shareItem(done[i]));
  }
  return lines.join('\n');
}

/* --- Нормализация (защита от битых данных старых версий/синка) --- */

/* Оценка времени в минутах: целое 0..59999 (99ч 59м — потолок модалки). */
function normEst(v) {
  var n = toInt(v, 0);
  if (n < 0) n = 0;
  if (n > 59999) n = 59999;
  return n;
}

/* Срок действия токена синка (настройка settings.tokenExp, 'ДД.ММ.ГГГГ'):
 * необязательное поле — GitHub показывает срок при создании токена.
 * Пустое/битое — '' (предупреждений нет). Только календарные даты.
 * Старый формат 'ГГГГ-ММ-ДД' (v144) молча приводим к новому. */
function normTokenExp(s) {
  var v = String(s == null ? '' : s).trim();
  var d, m, y;
  var iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (iso) {
    y = parseInt(iso[1], 10); m = parseInt(iso[2], 10); d = parseInt(iso[3], 10);
  } else {
    var dm = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(v);
    if (!dm) return '';
    d = parseInt(dm[1], 10); m = parseInt(dm[2], 10); y = parseInt(dm[3], 10);
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) return '';
  var back = new Date(Date.UTC(y, m - 1, d));
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return '';
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return p(d) + '.' + p(m) + '.' + y;
}

/* Полных дней до даты exp (по UTC-полуночам — часовой пояс не влияет).
 * Пустое/битое — 9999 (предупреждений нет). Прошлое — 0 и меньше. */
function tokenDaysLeft(exp, nowMs) {
  var n = normTokenExp(exp);
  if (!n) return 9999;
  var now = toInt(nowMs, Date.now());
  var p = n.split('.');
  var end = Date.UTC(parseInt(p[2], 10), parseInt(p[1], 10) - 1, parseInt(p[0], 10));
  var nd = new Date(now);
  var start = Date.UTC(nd.getUTCFullYear(), nd.getUTCMonth(), nd.getUTCDate());
  return Math.floor((end - start) / 86400000);
}

/* Уровень предупреждения о сроке токена: 0 — тихо, 1 — за 7 дней
 * (строка в статусе/диагностике), 2 — за 3 дня и после срока
 * (плюс разовое окно). */
function tokenWarnLevel(exp, nowMs) {
  var left = tokenDaysLeft(exp, nowMs);
  if (left <= 3) return 2;
  if (left <= 7) return 1;
  return 0;
}

/* --- Планирование, ФАЗА 0 (FR-95–FR-101): только модель и изоляция,
 * страницы плана и срабатывания-побочки здесь НЕТ. --- */

/* Дата плана 'ДД.ММ.ГГГГ' (по образцу normTokenExp): мусор, битые даты,
 * 29.02 невисокосного года → ''. Старый ISO 'ГГГГ-ММ-ДД' молча приводим. */
function normPlanDate(s) {
  var v = String(s == null ? '' : s).trim();
  var d, m, y;
  var iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (iso) {
    y = parseInt(iso[1], 10); m = parseInt(iso[2], 10); d = parseInt(iso[3], 10);
  } else {
    var dm = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(v);
    if (!dm) return '';
    d = parseInt(dm[1], 10); m = parseInt(dm[2], 10); y = parseInt(dm[3], 10);
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) return '';
  var back = new Date(Date.UTC(y, m - 1, d));
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return '';
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return p(d) + '.' + p(m) + '.' + y;
}

/* Час срабатывания планов (настройка settings.planFireHour): целое 0..23,
 * битое/пустое → 5 (порог по умолчанию — 05:00 локального времени). */
function normFireHour(v) {
  var n = parseInt(v, 10);
  if (!(n >= 0) || n > 23) return 5;
  return n;
}

/* Плановая ли задача: стоит дата плана (могилы — не планы). */
function isPlanned(t) {
  return !!t && !t.deleted && normPlanDate(t.planDate) !== '';
}

/* План показывается выполненным (v214): вручную (status done) ИЛИ уже
 * сработал (planFired !== 0 — дочка уже положена). Повтор после огня
 * перевооружён и planFired=0 → снова активен, пока не наступит новая
 * дата. Одна метрика на всё: разбиение секций, зачёркивание, кнопка
 * флага и направление переключения в жестах (иначе «↩ Не выполнено»
 * помечало бы сработавший план выполненным). */
function planDoneShown(t) {
  return !!t && (t.status === 'done' || toInt(t.planFired, 0) !== 0);
}

/* Создать план (ФАЗА 1, FR-95): название + дата ОБЯЗАТЕЛЬНЫ — планов
 * без даты не бывает, пустой title не создаётся. Невалидно → null,
 * массив не трогаем. Запись плоская (indent 0), в конец списка
 * (порядок планов — по createdAt, как у живых). */
function createPlan(tasks, title, planDate, nowMs, opts) {
  if (!Array.isArray(tasks)) return null;
  var t = normTitle(title);
  /* Потолок 460 (ФАЗА 2, FR-98): суффикс дочки « (ДД.ММ.ГГГГ)» — ещё
   * 13 символов, normTitle режет на 500 — дата ушла бы под нож и
   * заголовок дочки остался бы без неё. */
  if (t.length > 460) t = t.slice(0, 460);
  var pd = normPlanDate(planDate);
  if (!t || !pd) return null;
  opts = opts || {};
  var now = toInt(nowMs, Date.now());
  var task = {
    id: opts.id ? String(opts.id).slice(0, 64) : makeId(now),
    title: t,
    status: 'todo',
    estMin: 0,
    sumKids: true,
    planDate: pd,
    planFired: 0,
    indent: 0,
    createdAt: now,
    updatedAt: now,
    doneAt: 0,
    ts: now,
    deleted: false
  };
  /* Повтор (v213): opts.repeat = {every, unit, ...} (подгибка weekday/
   * якорный день идут внутри applyRepeatToTask). */
  if (opts.repeat !== undefined) {
    applyRepeatToTask(task, opts.repeat, now);
    if (task.repeatUnit === 'week' && !task.repeatWeekday) {
      task.repeatWeekday = computeWeekday(task.planDate);
    }
  }
  tasks.push(task);
  return task;
}

/* Текст метки даты для строки плана (ФАЗА 1, вёрстка): '' — не план
 * (метки нет); иначе дата, у сработавшей (planFired!==0) — с галочкой
 * (только индикатор, кнопок нет). */
function planChipText(t) {
  if (!isPlanned(t)) return '';
  var pd = normPlanDate(t.planDate);
  if (!pd) return '';
  return toInt(t.planFired, 0) !== 0 ? pd + ' ✓' : pd;
}

/* ===================== Повторение планов (v213) =====================
 * Модель: repeatEvery 1..99 + repeatUnit ('day'|'week'|'month'|'year'|
 * 'weekday') + для month/year — repeatDay (якорный день, без дрейфа
 * 31-го) + для weekday — repeatOrdinal (1..4, 5=последняя) и
 * repeatWeekday (0=Вс..6=Сб, как Date.getDay). Поля пишутся ТОЛЬКО когда
 * повтор есть (файл не пухнет у невозвращающихся задач), поэтому идут в
 * белый список normalizeTask/cloneTask/clarifyTask. */
var REPEAT_UNITS = { day: 1, week: 1, month: 1, year: 1, weekday: 1 };

function normRepeatEvery(v) {
  var n = toInt(v, 0);
  if (n < 1) return 0;
  if (n > 99) return 99;
  return n;
}
function normRepeatUnit(v) {
  var s = String(v == null ? '' : v);
  return REPEAT_UNITS[s] ? s : '';
}
function normRepeatOrdinal(v) {
  var n = toInt(v, 1);
  if (n < 1) return 1;
  if (n > 5) return 5;
  return n;
}
function normRepeatWeekday(v) {
  var n = toInt(v, 0);
  if (n < 0 || n > 6) return 0;
  return n;
}
function normRepeatDay(v) {
  var n = toInt(v, 0);
  if (n < 1) return 0;
  if (n > 31) return 31;
  return n;
}

/* Нормализация объекта повтора. Невалидно (нет every или unit) → null. */
function normRepeatObj(r) {
  if (!r || typeof r !== 'object') return null;
  var every = normRepeatEvery(r.every);
  var unit = normRepeatUnit(r.unit);
  if (!every || !unit) return null;
  var o = { every: every, unit: unit, ordinal: 1, weekday: 0, day: 0 };
  if (unit === 'weekday') {
    o.ordinal = normRepeatOrdinal(r.ordinal);
    o.weekday = normRepeatWeekday(r.weekday);
  } else if (unit === 'month' || unit === 'year') {
    o.day = normRepeatDay(r.day);
  } else if (unit === 'week') {
    o.weekday = normRepeatWeekday(r.weekday);
  }
  return o;
}

/* Повтор задачи или null (повтора нет / битый). */
function getRepeat(t) {
  if (!t) return null;
  return normRepeatObj({
    every: t.repeatEvery, unit: t.repeatUnit,
    ordinal: t.repeatOrdinal, weekday: t.repeatWeekday, day: t.repeatDay
  });
}

/* Вычислить день недели для еженедельного повтора из даты плана. */
function computeWeekday(planDate) {
  var pd = normPlanDate(planDate);
  if (!pd) return 0;
  var parts = pd.split('.');
  if (parts.length !== 3) return 0;
  var dt = new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
  return dt.getDay();
}

/* Даты чистыми компонентами (без TZ-сюрпризов): 'ДД.ММ.ГГГГ' ↔ дней. */
function ymdParts(s) {
  var p = String(s == null ? '' : s).split('.');
  return { y: parseInt(p[2], 10), m: parseInt(p[1], 10), d: parseInt(p[0], 10) };
}
function ymdStr(o) {
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return p(o.d) + '.' + p(o.m) + '.' + o.y;
}
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function ymdToDays(o) { return Math.floor(Date.UTC(o.y, o.m - 1, o.d) / 86400000); }
function strToDays(s) { var o = ymdParts(s); return o.y ? ymdToDays(o) : 0; }
function daysToYmd(n) {
  var dt = new Date(n * 86400000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
function msToYmd(ms) {
  var d = new Date(ms);
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
}

/* День месяца для k-го (1..4) или последнего (5) заданного дня недели. */
function weekdayOccurrence(y, m, weekday, ordinal) {
  var first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  var firstOcc = 1 + ((weekday - first + 7) % 7);
  var dim = daysInMonth(y, m);
  if (ordinal >= 5) return firstOcc + 7 * Math.floor((dim - firstOcc) / 7);
  var day = firstOcc + (ordinal - 1) * 7;
  return day > dim ? 0 : day;
}

/* Один шаг повтора от текущей даты. */
function addRepeatStep(dateStr, r) {
  var o = ymdParts(dateStr);
  var n = r.every;
  if (r.unit === 'day') return ymdStr(daysToYmd(ymdToDays(o) + n));
  if (r.unit === 'week') return ymdStr(daysToYmd(ymdToDays(o) + n * 7));
  if (r.unit === 'month') {
    var tm = o.y * 12 + (o.m - 1) + n;
    var y = Math.floor(tm / 12), m = tm % 12 + 1;
    var d = r.day || o.d;
    if (d > daysInMonth(y, m)) d = daysInMonth(y, m);
    return ymdStr({ y: y, m: m, d: d });
  }
  if (r.unit === 'year') {
    var y2 = o.y + n;
    var d2 = r.day || o.d;
    if (d2 > daysInMonth(y2, o.m)) d2 = daysInMonth(y2, o.m);
    return ymdStr({ y: y2, m: o.m, d: d2 });
  }
  if (r.unit === 'weekday') {
    var tm2 = o.y * 12 + (o.m - 1) + n;
    var y3 = Math.floor(tm2 / 12), m3 = tm2 % 12 + 1;
    var day = weekdayOccurrence(y3, m3, r.weekday, r.ordinal);
    if (!day) return dateStr;
    return ymdStr({ y: y3, m: m3, d: day });
  }
  return dateStr;
}

/* Следующая дата строго ПОСЛЕ локального дня nowMs (Вариант А: пропущенные
 * за простой не плодят дочек — прыжок на ближайшую будущую). Пусто на
 * битых входе. */
function nextPlanDate(dateStr, r, nowMs) {
  if (!r || !dateStr) return '';
  var today = ymdToDays(msToYmd(toInt(nowMs, Date.now())));
  var cur = dateStr, guard = 0;
  while (guard++ < 100000) {
    cur = addRepeatStep(cur, r);
    var o = ymdParts(cur);
    if (!o.y) return '';
    if (ymdToDays(o) > today) return cur;
  }
  return cur;
}

/* Первое вхождение weekday-паттерна НЕ РАНЬШЕ dateStr (подгибка даты). */
function snapToWeekdayPattern(dateStr, r) {
  var o = ymdParts(dateStr);
  if (!o.y || !r) return dateStr;
  var from = ymdToDays(o), y = o.y, m = o.m;
  for (var i = 0; i < 1200; i++) {
    var day = weekdayOccurrence(y, m, r.weekday, r.ordinal);
    if (day && ymdToDays({ y: y, m: m, d: day }) >= from) return ymdStr({ y: y, m: m, d: day });
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return dateStr;
}

/* Дни недели: 2-буквое сокращение (метка повтора узкая, v214) + род
 * (м/ж/с) для согласования порядкового («3-я сб», «1-й пн», «1-е вс»). */
var WD = [
  { n: 'вс', g: 'n' }, { n: 'пн', g: 'm' },
  { n: 'вт', g: 'm' }, { n: 'ср', g: 'f' },
  { n: 'чт', g: 'm' }, { n: 'пт', g: 'f' },
  { n: 'сб', g: 'f' }
];

/* Понятная метка повтора (короткая, v217): «кажд. д.», «кажд. 5 дн.»,
 * «3-я сб мес.», «посл. вт мес.» — «каждый/каждые/каждую» → «кажд.»,
 * «день/дня/дней» → «д.»/«дн.», «неделя…» → «нед.», «год/года/лет» →
 * «г.», «последний…» → «посл.», интервал weekday → «· N мес.»
 * (просьба хозяина 21.10.2026). Смысл сокращений сохранён. */
function repeatLabel(r) {
  r = normRepeatObj(r);
  if (!r) return '';
  var n = r.every;
  if (r.unit === 'day') return n === 1 ? 'кажд. д.'
    : 'кажд. ' + n + ' дн.';
  if (r.unit === 'week') {
    if (n === 1 && r.weekday >= 0) {
      var wd = WD[r.weekday] || WD[0];
      return 'кажд. ' + wd.n;
    }
    return 'кажд. ' + n + ' нед.';
  }
  if (r.unit === 'month') return n === 1 ? 'кажд. мес.'
    : 'кажд. ' + n + ' мес.';
  if (r.unit === 'year') return n === 1 ? 'кажд. г.'
    : 'кажд. ' + n + ' г.';
  /* weekday */
  var wd = WD[r.weekday] || WD[0];
  var suf = r.ordinal >= 5 ? 'посл.'
    : r.ordinal + '-' + (wd.g === 'f' ? 'я' : wd.g === 'n' ? 'е' : 'й');
  var base = suf + ' ' + wd.n + ' мес.';
  return n === 1 ? base : base + ' · ' + n + ' мес.';
}

/* Копия повтора в задачу-приёмник (нормализованный белый список). */
function copyRepeat(src, dst) {
  var r = getRepeat(src);
  if (!r) return;
  dst.repeatEvery = r.every;
  dst.repeatUnit = r.unit;
  if (r.unit === 'weekday') {
    dst.repeatOrdinal = r.ordinal;
    dst.repeatWeekday = r.weekday;
  } else if (r.unit === 'month' || r.unit === 'year') {
    dst.repeatDay = r.day;
  }
}

function clearRepeat(task) {
  delete task.repeatEvery;
  delete task.repeatUnit;
  delete task.repeatOrdinal;
  delete task.repeatWeekday;
  delete task.repeatDay;
}

/* Применить patch.repeat к задаче: weekday подгибает дату к паттерну,
 * month/year проставляют якорный день из даты, уже сработавший план с
 * прошедшей датой подвигается вперёд (иначе повтор «повисит» навсегда).
 * rp: объект → выставить; null/0/пустое → снять. */
function applyRepeatToTask(task, rp, nowMs) {
  if (rp === undefined) return;
  var now = toInt(nowMs, Date.now());
  if (!rp || typeof rp !== 'object') { clearRepeat(task); return; }
  var r = normRepeatObj(rp);
  if (!r) { clearRepeat(task); return; }
  var pd = normPlanDate(task.planDate);
  if (r.unit === 'weekday' && pd) {
    var snapped = snapToWeekdayPattern(pd, r);
    if (snapped && snapped !== pd) { task.planDate = snapped; task.planFired = 0; pd = snapped; }
  }
  if ((r.unit === 'month' || r.unit === 'year') && pd) {
    r.day = parseInt(pd.split('.')[0], 10) || 0;
  }
  task.repeatEvery = r.every;
  task.repeatUnit = r.unit;
  if (r.unit === 'weekday') {
    task.repeatOrdinal = r.ordinal;
    task.repeatWeekday = r.weekday;
    delete task.repeatDay;
  } else if (r.unit === 'month' || r.unit === 'year') {
    task.repeatDay = r.day;
    delete task.repeatOrdinal;
    delete task.repeatWeekday;
  } else if (r.unit === 'week' && pd) {
    var parts = pd.split('.');
    if (parts.length === 3) {
      var dt = new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
      task.repeatWeekday = dt.getDay();
    }
    delete task.repeatDay;
    delete task.repeatOrdinal;
  } else {
    delete task.repeatDay;
    delete task.repeatOrdinal;
    delete task.repeatWeekday;
  }
  if (task.planFired && pd && strToDays(pd) <= ymdToDays(msToYmd(now))) {
    var np = nextPlanDate(pd, r, now);
    if (np) { task.planDate = np; task.planFired = 0; }
  }
}

/* Чистый детект сроков (без побочек — само срабатывание НЕ здесь):
 * план ждёт, если дата <= локальный день устройства И локальный час
 * >= planFireHour (граница >=: ровно в час порога — уже пора).
 * Только planFired===0 (сработавшие/битые planFired≠0 — skip),
 * битая дата — skip. Возвращает ссылки (массив новый, задачи те же). */
function planDueTasks(tasks, settings, nowMs) {
  if (!Array.isArray(tasks)) return [];
  var hour = 5;
  if (settings && typeof settings === 'object') hour = normFireHour(settings.planFireHour);
  var now = toInt(nowMs, Date.now());
  var d = new Date(now);
  var ty = d.getFullYear(), tm = d.getMonth(), td = d.getDate();
  if (d.getHours() < hour) return [];
  var out = [];
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    if (!t || t.deleted) continue;
    var pd = normPlanDate(t.planDate);
    if (!pd) continue;
    /* Выполненный план не срабатывает и не создаёт живых задач
     * (v213, требование хозяина 20.10.2026): done-строка — она уже
     * закрыта, дочка из неё не нужна. Возврат ↩ (status todo) снова
     * ставит план в очередь. */
    if (t.status === 'done') continue;
    if (toInt(t.planFired, 0) !== 0) continue;
    var p = pd.split('.');
    var py = parseInt(p[2], 10), pm = parseInt(p[1], 10) - 1, pdd = parseInt(p[0], 10);
    if (py < ty || (py === ty && (pm < tm || (pm === tm && pdd <= td)))) out.push(t);
  }
  return out;
}

/* Заголовок дочки плана (ФАЗА 2, FR-98): «<Название> (ДД.ММ.ГГГГ)» —
 * без «до». Название режется до 460 ДО суффикса (см. createPlan):
 * normTitle обрезает на 500, дата обязана целой. Битая дата или пустое
 * название → '' (дочку не создаём). */
function planChildTitle(title, planDate) {
  var pd = normPlanDate(planDate);
  var base = String(title == null ? '' : title).trim().slice(0, 460);
  if (!base || !pd) return '';
  return normTitle(base + ' (' + pd + ')');
}

/* Отступ дочки под целевой: +1, потолок 8 (цель на 8 — дочка рядом с
 * ней на том же уровне, глубже некуда). Битые значения → 1. */
function planChildIndent(indent) {
  var v = parseInt(indent, 10);
  if (!(v >= 0)) v = 0;
  if (v > 8) v = 8;
  return v < 8 ? v + 1 : 8;
}

/* Метка времени для строки: 0 → '', 30 → '30м', 60 → '1ч', 90 → '1ч 30м'. */
function fmtDur(mins) {
  var m = toInt(mins, 0);
  if (m <= 0) return '';
  var h = Math.floor(m / 60), r = m % 60;
  if (h && r) return h + 'ч ' + r + 'м';
  if (h) return h + 'ч';
  return r + 'м';
}

function normalizeTask(t) {
  if (!t || typeof t !== 'object') return null;
  var id = String(t.id || '');
  if (!id) return null;
  /* Сжатая могила — форму НЕ раздуваем (v171): иначе каждая загрузка
   * и каждое слияние превращали маркер ~100 Б в полную могилу ~200 Б,
   * и файл рос обратно сразу после сжатия (91.6 КБ при всех сжатых).
   * Возвращаем канонический минимум; ts/updatedAt страхуют друг друга. */
  if (t.min === true && t.deleted) {
    var mts = toInt(t.ts, toInt(t.updatedAt, 0));
    return { id: id.slice(0, 64), deleted: true, ts: mts,
      updatedAt: toInt(t.updatedAt, mts), min: true };
  }
  /* Живой статус один — 'todo' (T-cleanup-inbox-next): 'done' остаётся,
   * всё остальное ('inbox', 'next', 'waiting', 'someday', мусор) — в 'todo'.
   * Старые устройства пишут 'inbox'/'next' — после обновления читаются
   * как живые, данные не теряются. */
  var status = (t.status === 'done') ? 'done' : 'todo';
  var createdAt = toInt(t.createdAt, 0);
  var updatedAt = toInt(t.updatedAt, 0);
  var doneAt = (status === 'done') ? toInt(t.doneAt, updatedAt) : 0;
  var ts = toInt(t.ts, updatedAt);
  var indent = normIndent(t.indent);
  var n = {
    id: id.slice(0, 64),
    title: normTitle(t.title),
    status: status,
    estMin: normEst(t.estMin),
    sumKids: t.sumKids !== false,
    planDate: normPlanDate(t.planDate),
    planFired: toInt(t.planFired, 0),
    indent: indent,
    createdAt: createdAt,
    updatedAt: updatedAt,
    doneAt: doneAt,
    ts: ts,
    deleted: !!t.deleted
  };
  /* Флаг сжатой могилы (v167): только если стоит — обычным задачам
   * и полным могилам лишнего ключа не пишем (файл не пухнет, тесты
   * с deepEqual целы). Старые версии флаг вычищают — их сжатые могилы
   * считаются полными, лечится повторным сжатием на новой версии. */
  if (t.min === true) n.min = true;
  copyRepeat(t, n);
  return n;
}

/* Восстановление из копии: пропавшие живые задачи хоронятся tombstone'ом
 * со свежей меткой — иначе следующий синк воскресит их с сервера
 * (union-семантика слияния: нет локально + есть удалённо = добавить).
 * Присутствующие едут как есть (нормализованные). */
function restoreWithTombstones(currentTasks, incomingTasks, nowMs) {
  var now = toInt(nowMs, Date.now());
  var out = normalizeTasks(incomingTasks);
  var have = {}, i;
  for (i = 0; i < out.length; i++) have[out[i].id] = true;
  var cur = Array.isArray(currentTasks) ? currentTasks : [];
  for (i = 0; i < cur.length; i++) {
    var t = cur[i];
    if (!t || !t.id || have[t.id]) continue;
    /* Уже похороненные — несём могилу дальше, иначе стирается память
     * об удалении и чужое старое живое их воскресит. */
    if (t.deleted) { out.push(t); continue; }
    out.push({
      id: String(t.id).slice(0, 64),
      title: '', status: 'todo', estMin: 0, indent: 0,
      createdAt: 0, updatedAt: now, doneAt: 0, ts: now, deleted: true
    });
  }
  return out;
}

/* Любой вход -> массив нормализованных задач с id. Без id — отбрасывается. */
function normalizeTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  var out = [];
  var seen = {};
  for (var i = 0; i < tasks.length; i++) {
    var n = normalizeTask(tasks[i]);
    if (!n || seen[n.id]) continue;
    seen[n.id] = true;
    out.push(n);
  }
  out.sort(function (a, b) {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  });
  return out;
}

/* --- Позадачное слияние LWW --- */

function cloneTask(t) {
  /* Маркер копируем минимумом (v171, та же причина, что в normalizeTask). */
  if (t.min === true && t.deleted) {
    var mts = toInt(t.ts, toInt(t.updatedAt, 0));
    return { id: t.id, deleted: true, ts: mts,
      updatedAt: toInt(t.updatedAt, mts), min: true };
  }
  var c = {
    id: t.id, title: t.title, status: t.status, indent: normIndent(t.indent),
    estMin: normEst(t.estMin), sumKids: t.sumKids !== false,
    planDate: normPlanDate(t.planDate), planFired: toInt(t.planFired, 0),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt, doneAt: t.doneAt, ts: t.ts || 0, deleted: !!t.deleted
  };
  if (t.min === true) c.min = true;
  copyRepeat(t, c);
  return c;
}

/* Для каждой задачи побеждает свежая ts; при равных — локальная. */
function mergeTask(local, remote) {
  var lt = local.ts || 0;
  var rt = remote.ts || 0;
  if (rt > lt) return cloneTask(remote);
  return cloneTask(local);
}

function mergeTasks(localTasks, remoteTasks) {
  var a = normalizeTasks(localTasks);
  var b = normalizeTasks(remoteTasks);
  var map = {};
  var i, t;
  for (i = 0; i < a.length; i++) { t = a[i]; map[t.id] = { local: t, remote: null }; }
  for (i = 0; i < b.length; i++) {
    t = b[i];
    if (map[t.id]) map[t.id].remote = t;
    else map[t.id] = { local: null, remote: t };
  }
  var out = [];
  var ids = Object.keys(map).sort();
  for (i = 0; i < ids.length; i++) {
    var e = map[ids[i]];
    if (e.local && e.remote) out.push(mergeTask(e.local, e.remote));
    else out.push(cloneTask(e.local || e.remote));
  }
  out.sort(function (x, y) {
    if (x.createdAt !== y.createdAt) return x.createdAt - y.createdAt;
    return x.id < y.id ? -1 : (x.id > y.id ? 1 : 0);
  });
  return out;
}

function tasksEqual(a, b) {
  return JSON.stringify(normalizeTasks(a)) === JSON.stringify(normalizeTasks(b));
}

function isTasksEmpty(tasks) {
  var n = normalizeTasks(tasks);
  for (var i = 0; i < n.length; i++) {
    if (!n[i].deleted) return false;
  }
  return true;
}

/* Пустое состояние никогда не затирает непустое: 'pull' | 'push' | 'in-sync'. */
function mergeDecision(localState, remoteState) {
  var localEmpty = isTasksEmpty(localState.tasks);
  var remoteEmpty = isTasksEmpty(remoteState.tasks);
  if (localEmpty && !remoteEmpty) return 'pull';
  if (!localEmpty && remoteEmpty) return 'push';
  var rTime = remoteState.updatedAt || 0;
  var lTime = localState.updatedAt || 0;
  if (rTime > lTime) return 'pull';
  if (lTime > rTime) return 'push';
  return 'in-sync';
}

var api = {
  blankTasks: blankTasks,
  getTask: getTask,
  createTask: createTask,
  clarifyTask: clarifyTask,
  completeTask: completeTask,
  completeBranch: completeBranch,
  reopenTask: reopenTask,
  reopenBranch: reopenBranch,
  removeTask: removeTask,
  purgeTombstones: purgeTombstones,
  setIndent: setIndent,
  hasKids: hasKids,
  isDoneShown: isDoneShown,
  isHiddenByCollapse: isHiddenByCollapse,
  todoList: todoList,
  doneList: doneList,
  doneShownList: doneShownList,
  todoCount: todoCount,
  stats: stats,
  shareText: shareText,
  searchTasks: searchTasks,
  fmtDur: fmtDur,
  normTokenExp: normTokenExp,
  tokenDaysLeft: tokenDaysLeft,
  tokenWarnLevel: tokenWarnLevel,
  normPlanDate: normPlanDate,
  normFireHour: normFireHour,
  normRepeatEvery: normRepeatEvery,
  normRepeatUnit: normRepeatUnit,
  normRepeatOrdinal: normRepeatOrdinal,
  normRepeatWeekday: normRepeatWeekday,
  normRepeatDay: normRepeatDay,
  normRepeatObj: normRepeatObj,
  getRepeat: getRepeat,
  applyRepeatToTask: applyRepeatToTask,
  nextPlanDate: nextPlanDate,
  snapToWeekdayPattern: snapToWeekdayPattern,
  weekdayOccurrence: weekdayOccurrence,
  repeatLabel: repeatLabel,
  isPlanned: isPlanned,
  planDoneShown: planDoneShown,
  createPlan: createPlan,
  planChipText: planChipText,
  planDueTasks: planDueTasks,
  planChildTitle: planChildTitle,
  planChildIndent: planChildIndent,
  normalizeTask: normalizeTask,
  normalizeTasks: normalizeTasks,
  cloneTask: cloneTask,
  restoreWithTombstones: restoreWithTombstones,
  mergeTask: mergeTask,
  mergeTasks: mergeTasks,
  tasksEqual: tasksEqual,
  isTasksEmpty: isTasksEmpty,
  mergeDecision: mergeDecision
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else if (typeof window !== 'undefined') {
  window.EBLogic = api;
}
