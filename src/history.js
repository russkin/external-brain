/* history.js — история изменений (undo/redo стрелками в шапке, локально).
 * Слепок задач до каждой меняющей мутации; отмена применяется как новое
 * изменение со свежими метками (так честно и для синка): созданное после
 * превращается в tombstone, удалённое воскресает, правки побеждают.
 * В слепок входит и пустое поле (якорь/текст/сдвиг), чтобы Enter делился
 * на два шага отмены: сначала уходит новое поле (задача остаётся).
 * Вынесено из app.js (рефакторинг, этап 4): код перенесён как есть.
 * В app.js остались тонкие алиасы (snapTasks/snapFull/pushUndo/
 * updateHistoryButtons/mutate), чтобы десятки вызовов в жестах и вводе
 * не трогать. Изменяемое — только через ctx. Своих глобалов не трогает.
 * UMD: браузер (window.EBHistory) + Node (module.exports) для тестов.
 *
 * Контекст ctx: on, L, save, render, focusAfterHistory — стабильные ссылки;
 *   getState() (state переназначается), getDraft() {afterId,text,indent} /
 *   setDraft(d) (черновик переназначается), isDragActive() (флаг жеста),
 *   getCollapsed(), isDoneHidden(), setViewState(v) (вид переназначается).
 */
(function () {
'use strict';

var C = null;
var undoStack = [];
var redoStack = [];
var HISTORY_MAX = 50;

/* История переживает перезагрузку и обновление приложения: обе стопки
 * держим в localStorage (слепки — сырые JSON задач, до 50 шагов каждая).
 * histLoad() чистит битые записи; pushUndo — ЕДИНСТВЕННАЯ точка записи
 * нового шага (сбрасывает redo и сохраняет обе стопки). */
var UNDO_KEY = 'external-brain-undo-v1';
var REDO_KEY = 'external-brain-redo-v1';

function histSave() {
  try {
    localStorage.setItem(UNDO_KEY, JSON.stringify(undoStack));
    localStorage.setItem(REDO_KEY, JSON.stringify(redoStack));
  } catch (e) {}
}

function histClean(arr) {
  var out = [];
  if (!Array.isArray(arr)) return out;
  for (var i = 0; i < arr.length; i++) {
    var e = arr[i];
    if (e && typeof e === 'object' && typeof e.tasks === 'string') out.push(e);
  }
  return out;
}

function load() {
  try {
    var u = JSON.parse(localStorage.getItem(UNDO_KEY) || '[]');
    var r = JSON.parse(localStorage.getItem(REDO_KEY) || '[]');
    u = histClean(u).slice(-HISTORY_MAX);
    r = histClean(r).slice(-HISTORY_MAX);
    undoStack = u;
    redoStack = r;
  } catch (e) {}
}

function pushUndo(entry) {
  undoStack.push(entry);
  if (undoStack.length > HISTORY_MAX) undoStack.shift();
  redoStack = [];
  histSave();
}

function counts() {
  return { u: undoStack.length, r: redoStack.length };
}
/* ВРЕМЕННОЕ (диагностика странной отмены): сводка верхних шагов —
 * какие задачи живы/мёртвы и есть ли текст черновика. Убрать после выяснения. */
function peek(n) {
  var out = [], i, k, t, arr;
  n = n || 3;
  for (i = undoStack.length - 1; i >= 0 && out.length < n; i--) {
    var e = undoStack[i], alive = [], dead = [];
    try { arr = JSON.parse(e.tasks); } catch (x) { arr = []; }
    if (Array.isArray(arr)) {
      for (k = 0; k < arr.length; k++) {
        t = arr[k];
        if (!t || !t.id) continue;
        if (t.deleted) dead.push(t.id);
        else alive.push(t.id + ':' + String(t.title || '').slice(0, 12));
      }
    }
    out.push({ alive: alive, dead: dead, draft: e.text ? '+' : '-' });
  }
  return out;
}

function snapTasks() {
  if (!C) return '[]';
  var state = C.getState();
  try { return JSON.stringify(state.tasks); } catch (x) { return '[]'; }
}

/* Полный слепок для истории: задачи + положение/текст/сдвиг пустого поля
 * + вид (карта сворачивания, флаг секции). Без вида ↩ после 📁/📂 возвращал
 * бы данные под чужое сворачивание — строки прыгали как попало. */
function snapFull() {
  if (!C) return { tasks: '[]', afterId: null, text: '', indent: null };
  var d = C.getDraft();
  var vc = {};
  try {
    var cm = C.getCollapsed();
    for (var id in cm) if (cm[id]) vc[id] = true;
  } catch (x) {}
  return {
    tasks: snapTasks(),
    afterId: d.afterId,
    text: d.text,
    indent: d.indent,
    collapsed: vc,
    doneHidden: C.isDoneHidden()
  };
}

function mutateWithHistory(fn) {
  if (!C) return null;
  var state = C.getState();
  if (!state) return null;
  var before = snapFull();
  var r = fn();
  if (snapTasks() !== before.tasks) {
    pushUndo(before);
    state.updatedAt = Date.now();
  }
  if (!C.isDragActive()) C.render();
  C.save();
  updateHistoryButtons();
  return r;
}

function applySnapshot(s) {
  var state = C.getState();
  var tasksJson = (s && typeof s === 'object') ? s.tasks : s;
  var now = Date.now(), snap = [];
  try { snap = JSON.parse(tasksJson); } catch (x) { snap = []; }
  if (!Array.isArray(snap)) snap = [];
  if (snapTasks() !== tasksJson) {
    state.updatedAt = now;
    var keep = {}, out = [], i, t, c;
    for (i = 0; i < snap.length; i++) {
      t = snap[i];
      if (!t || !t.id) continue;
      keep[t.id] = true;
      c = C.L.normalizeTask(t);
      if (!c) continue;
      c.ts = now;
      c.updatedAt = now;
      out.push(c);
    }
    for (i = 0; i < state.tasks.length; i++) {
      t = state.tasks[i];
      if (!t || !t.id || keep[t.id] || t.deleted) continue;
      c = C.L.normalizeTask(t);
      if (!c) continue;
      c.deleted = true;
      c.ts = now;
      c.updatedAt = now;
      out.push(c);
    }
    state.tasks = out;
    C.save();
  }
  if (s && typeof s === 'object') {
    C.setDraft({
      afterId: s.afterId || null,
      text: String(s.text || ''),
      indent: (s.indent == null) ? null : s.indent
    });
    /* Вид восстанавливаем только если он есть в слепке: старые записи
     * (без collapsed/doneHidden) оставляют текущий вид как есть. */
    if (s.collapsed || typeof s.doneHidden === 'boolean') {
      C.setViewState({ collapsed: s.collapsed, doneHidden: s.doneHidden });
    }
  }
  C.render();
  updateHistoryButtons();
}

function doUndo() {
  if (!C) return;
  var state = C.getState();
  if (!state || !undoStack.length) return;
  redoStack.push(snapFull());
  if (redoStack.length > HISTORY_MAX) redoStack.shift();
  var us = undoStack.pop();
  histSave();
  applySnapshot(us);
  C.focusAfterHistory(us, false);
}

function doRedo() {
  if (!C) return;
  var state = C.getState();
  if (!state || !redoStack.length) return;
  undoStack.push(snapFull());
  if (undoStack.length > HISTORY_MAX) undoStack.shift();
  var rs = redoStack.pop();
  histSave();
  applySnapshot(rs);
  C.focusAfterHistory(rs, true);
}

function updateHistoryButtons() {
  var u = document.getElementById('undoBtn'), r = document.getElementById('redoBtn');
  if (u) u.disabled = !undoStack.length;
  if (r) r.disabled = !redoStack.length;
}

function init(ctx) {
  C = ctx;
  ctx.on('undoBtn', 'click', function () { doUndo(); });
  ctx.on('redoBtn', 'click', function () { doRedo(); });
}

var api = {
  init: init,
  load: load,
  counts: counts,
  peek: peek,
  snapTasks: snapTasks,
  snapFull: snapFull,
  pushUndo: pushUndo,
  updateHistoryButtons: updateHistoryButtons,
  mutateWithHistory: mutateWithHistory
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else if (typeof window !== 'undefined') {
  window.EBHistory = api;
}
})();
