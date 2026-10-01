/* logic.js — чистая логика «Внешнего мозга» без DOM.
 * Совместимость: ES2017 без optional chaining, работает в Node и в браузере.
 * Модель (джедайские техники, упрощённо):
 *   task = { id, title, status, project, frog, slicesTotal, slicesDone,
 *            indent, createdAt, updatedAt, doneAt, ts, deleted }
 *   status: 'inbox' (сбор) | 'next' (следующие действия) | 'waiting' (ожидание) |
 *           'someday' (когда-нибудь) | 'done' (готово)
 *   indent: уровень отступа 0..8 — задача с отступом входит в группу задачи
 *           без отступа (или с меньшим отступом) сверху.
 * Правила:
 *   - всё новое падает в инбокс (capture), цель — пустой инбокс;
 *   - прояснение (clarify) раскладывает инбокс по статусам/проектам;
 *   - лягушка (frog) — самая неприятная задача дня, идёт первой;
 *   - слон режется на бифштексы (slicesTotal/slicesDone), съел все — задача готова;
 *   - удаление — tombstone (deleted=true), чтобы синк не воскрешал/не терял.
 */
'use strict';

var STATUSES = ['inbox', 'next', 'waiting', 'someday', 'done'];

var _counter = 0;

function normTitle(s) {
  return String(s == null ? '' : s).trim().slice(0, 500);
}

function normProject(s) {
  return String(s == null ? '' : s).trim().slice(0, 120);
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

/* Создать задачу в инбоксе. Пустой заголовок — вернуть null, ничего не трогать. */
function createTask(tasks, title, nowMs, opts) {
  var t = normTitle(title);
  if (!t) return null;
  var now = toInt(nowMs, Date.now());
  opts = opts || {};
  var task = {
    id: opts.id ? String(opts.id) : makeId(now),
    title: t,
    status: 'inbox',
    project: normProject(opts.project),
    frog: !!opts.frog,
    slicesTotal: toInt(opts.slicesTotal, 0),
    slicesDone: 0,
    indent: normIndent(opts.indent),
    createdAt: now,
    updatedAt: now,
    doneAt: 0,
    ts: now,
    deleted: false
  };
  if (task.slicesTotal > 1000) task.slicesTotal = 1000;
  tasks.push(task);
  return task;
}

/* Прояснение: разложить задачу из инбокса (или любую) по полям.
 * patch: { status, project, frog, slicesTotal, title, indent }. Невалидный status игнорируется. */
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
  if (patch.project != null) task.project = normProject(patch.project);
  if (patch.frog != null) task.frog = !!patch.frog;
  if (patch.slicesTotal != null) {
    var st = toInt(patch.slicesTotal, task.slicesTotal);
    if (st > 1000) st = 1000;
    task.slicesTotal = st;
    if (task.slicesDone > st) task.slicesDone = st;
  }
  if (patch.title != null) {
    var nt = normTitle(patch.title);
    if (nt) task.title = nt;
  }
  if (patch.indent != null) task.indent = normIndent(patch.indent);
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
  if (task.status !== 'done') return task;
  task.status = 'next';
  task.doneAt = 0;
  task.updatedAt = now;
  task.ts = now;
  return task;
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

function setFrog(tasks, id, frog, nowMs) {
  var task = getTask(tasks, id);
  if (!task || task.deleted) return null;
  var now = toInt(nowMs, Date.now());
  task.frog = !!frog;
  task.updatedAt = now;
  task.ts = now;
  return task;
}

function setSlices(tasks, id, total, nowMs) {
  var task = getTask(tasks, id);
  if (!task || task.deleted) return null;
  var now = toInt(nowMs, Date.now());
  var st = toInt(total, 0);
  if (st > 1000) st = 1000;
  task.slicesTotal = st;
  if (task.slicesDone > st) task.slicesDone = st;
  task.updatedAt = now;
  task.ts = now;
  return task;
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

/* Съесть один бифштекс. Все съедены (total>0) — задача автоматически готова. */
function completeSlice(tasks, id, nowMs) {
  var task = getTask(tasks, id);
  if (!task || task.deleted) return null;
  var now = toInt(nowMs, Date.now());
  if (task.slicesTotal <= 0) return task;
  if (task.slicesDone < task.slicesTotal) task.slicesDone += 1;
  if (task.slicesDone >= task.slicesTotal) {
    task.status = 'done';
    task.doneAt = now;
  }
  task.updatedAt = now;
  task.ts = now;
  return task;
}

function isAlive(t) {
  return !!t && !t.deleted && !!t.title;
}

function byStatus(tasks, status) {
  return tasks.filter(function (t) { return isAlive(t) && t.status === status; });
}

function inboxList(tasks) {
  return byStatus(tasks, 'inbox').sort(function (a, b) { return a.createdAt - b.createdAt; });
}

/* Следующие: сначала лягушки, затем по времени создания. */
function nextList(tasks) {
  return byStatus(tasks, 'next').sort(function (a, b) {
    if (!!a.frog !== !!b.frog) return a.frog ? -1 : 1;
    return a.createdAt - b.createdAt;
  });
}

function waitingList(tasks) {
  return byStatus(tasks, 'waiting').sort(function (a, b) { return a.createdAt - b.createdAt; });
}

function somedayList(tasks) {
  return byStatus(tasks, 'someday').sort(function (a, b) { return a.createdAt - b.createdAt; });
}

function doneList(tasks) {
  return byStatus(tasks, 'done').sort(function (a, b) { return b.doneAt - a.doneAt; });
}

/* Фокус дня: первая лягушка из next, иначе первое next, иначе первый инбокс. */
function focusTask(tasks) {
  var nx = nextList(tasks);
  for (var i = 0; i < nx.length; i++) {
    if (nx[i].frog) return nx[i];
  }
  if (nx.length) return nx[0];
  var ib = inboxList(tasks);
  return ib.length ? ib[0] : null;
}

function inboxCount(tasks) {
  return inboxList(tasks).length;
}

function stats(tasks) {
  var nx = nextList(tasks);
  var hasFrog = false;
  for (var i = 0; i < nx.length; i++) {
    if (nx[i].frog) { hasFrog = true; break; }
  }
  return {
    inbox: inboxList(tasks).length,
    next: nx.length,
    waiting: waitingList(tasks).length,
    someday: somedayList(tasks).length,
    done: doneList(tasks).length,
    hasFrog: hasFrog
  };
}

/* Текст для «Поделиться»: как на экране — живые по порядку с отступами,
 * ниже выполненные (новые выше). */
function shareItem(t) {
  var pad = '';
  for (var k = 0; k < normIndent(t.indent); k++) pad += '  ';
  var s = pad + '- ' + (t.frog ? 'FROG ' : '') + t.title;
  if (t.project) s += ' [' + t.project + ']';
  if (t.slicesTotal > 0) s += ' (' + t.slicesDone + '/' + t.slicesTotal + ')';
  return s;
}

function shareText(tasks) {
  var lines = [];
  var all = normalizeTasks(tasks).filter(function (t) { return !t.deleted && t.title; });
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

function normalizeTask(t) {
  if (!t || typeof t !== 'object') return null;
  var id = String(t.id || '');
  if (!id) return null;
  var status = isStatus(t.status) ? t.status : 'inbox';
  var slicesTotal = toInt(t.slicesTotal, 0);
  if (slicesTotal > 1000) slicesTotal = 1000;
  var slicesDone = toInt(t.slicesDone, 0);
  if (slicesDone > slicesTotal) slicesDone = slicesTotal;
  var createdAt = toInt(t.createdAt, 0);
  var updatedAt = toInt(t.updatedAt, 0);
  var doneAt = (status === 'done') ? toInt(t.doneAt, updatedAt) : 0;
  var ts = toInt(t.ts, updatedAt);
  var indent = normIndent(t.indent);
  return {
    id: id.slice(0, 64),
    title: normTitle(t.title),
    status: status,
    project: normProject(t.project),
    frog: !!t.frog,
    slicesTotal: slicesTotal,
    slicesDone: slicesDone,
    indent: indent,
    createdAt: createdAt,
    updatedAt: updatedAt,
    doneAt: doneAt,
    ts: ts,
    deleted: !!t.deleted
  };
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
  return {
    id: t.id, title: t.title, status: t.status, project: t.project, frog: t.frog,
    slicesTotal: t.slicesTotal, slicesDone: t.slicesDone, indent: normIndent(t.indent),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt, doneAt: t.doneAt, ts: t.ts || 0, deleted: !!t.deleted
  };
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
    if (!n[i].deleted && n[i].title) return false;
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
  STATUSES: STATUSES,
  blankTasks: blankTasks,
  makeId: makeId,
  getTask: getTask,
  createTask: createTask,
  clarifyTask: clarifyTask,
  completeTask: completeTask,
  completeBranch: completeBranch,
  reopenTask: reopenTask,
  removeTask: removeTask,
  setFrog: setFrog,
  setSlices: setSlices,
  setIndent: setIndent,
  MAX_INDENT: MAX_INDENT,
  hasKids: hasKids,
  isDoneShown: isDoneShown,
  isHiddenByCollapse: isHiddenByCollapse,
  completeSlice: completeSlice,
  inboxList: inboxList,
  nextList: nextList,
  waitingList: waitingList,
  somedayList: somedayList,
  doneList: doneList,
  focusTask: focusTask,
  inboxCount: inboxCount,
  stats: stats,
  shareText: shareText,
  normalizeTask: normalizeTask,
  normalizeTasks: normalizeTasks,
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
