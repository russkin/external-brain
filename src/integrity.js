/* integrity.js — система проверки целостности данных (FR-105, v247).
 * Слепок счётчиков/id-карт ДО операции (память сессии, НИКАКИХ новых
 * localStorage-ключей — грабля 53), сравнение ПОСЛЕ по op-таблице
 * (L.integrityCheck / L.integritySyncCheck), окно тревоги с «↩ Отменить».
 * Дедуп: не чаще раза в 5 минут, максимум 3 окна за сессию; массовые
 * операции склеиваются в одно сводное окно; во время drag и при открытой
 * модалке показ откладывается (defer), не рвёт жест.
 * UMD: браузер (window.EBIntegrity) + Node (module.exports) для тестов.
 *
 * Контекст ctx: getState(), L, isDragActive(), askIntegrity(text) —
 *   окно с кнопками «↩ Отменить»/«Понятно» (паттерн askPlanNotify);
 *   doUndo() — отмена последнего шага истории; onModalOpen/onModalClose
 *   не нужны — defer читает modalBack сам.
 */
(function () {
'use strict';

function el(id) { return document.getElementById(id); }

var C = null;

/* --- Слепок: одна точка входа, op приходит снаружи --- */
var pendingSnap = null;   /* { snap, op, at } — до завершения операции */
var depth = 0;            /* вложенность begin/end (mutate внутри mutate) */

/* --- Дедуп показа (память сессии) --- */
var lastShownAt = 0;
var shownCount = 0;
var COOLDOWN_MS = 5 * 60 * 1000;
var MAX_SHOWN = 3;
var deferred = [];        /* очередь отложенных тревог (defer/дедуп) */
var deferTimer = null;
var lastInfo = null;      /* { at, op, reason, shown, pending } для ⓘ */

function now() { return Date.now(); }

function L() {
  return (C && C.L) || (typeof window !== 'undefined' ? window.EBLogic : null);
}

function tasksNow() {
  var st = C && C.getState ? C.getState() : null;
  return st ? st.tasks : null;
}

/* Начало операции: слепок в память. Вложенные begin игнорируют (держит
 * внешний) — end отдаёт последний завершённый уровень. */
function begin(op) {
  depth++;
  if (depth !== 1) return;
  var LB = L();
  var tasks = tasksNow();
  if (!LB || !tasks || !LB.integritySnapshot) { pendingSnap = null; return; }
  try {
    pendingSnap = { snap: LB.integritySnapshot(tasks), op: String(op || 'edit'), at: now() };
  } catch (x) { pendingSnap = null; }
}

/* Конец операции: сравнить слепок с текущим. op можно уточнить снаружи
 * (например, mutate(fn) → end('delete')). */
function end(op) {
  if (depth > 0) depth--;
  if (depth !== 0) return;
  var p = pendingSnap;
  pendingSnap = null;
  if (!p) return;
  if (op) p.op = String(op);
  var LB = L();
  var tasks = tasksNow();
  if (!LB || !tasks || !LB.integrityCheck) return;
  var after;
  try { after = LB.integritySnapshot(tasks); } catch (x) { return; }
  var bad = null;
  try { bad = LB.integrityCheck(p.snap, after, p.op); } catch (x) { return; }
  if (bad) note(bad, p.op);
}

/* Синк: слепок до merge уже снят (begin('sync') в doSync), remote и
 * localBefore приходят из res. */
function endSync(res) {
  if (depth > 0) depth--;
  if (depth !== 0) return;
  var p = pendingSnap;
  pendingSnap = null;
  if (!p) return;
  var LB = L();
  var tasks = tasksNow();
  if (!LB || !tasks || !LB.integritySyncCheck) return;
  var after;
  try { after = LB.integritySnapshot(tasks); } catch (x) { return; }
  var remote = res && res._remote;
  var localBefore = res && res._localBefore;
  if (!remote || !localBefore) return; /* in-sync/push без merge — нечего ловить */
  var bad = null;
  try { bad = LB.integritySyncCheck(p.snap, after, remote, localBefore); } catch (x) { return; }
  if (bad) note(bad, 'sync');
}

/* Тревога: положить в очередь и попытаться показать (defer/дедуп). */
function note(bad, op) {
  lastInfo = {
    at: now(),
    op: String(op || '?'),
    reason: String(bad && bad.reason || '?'),
    shown: shownCount,
    pending: deferred.length
  };
  deferred.push({
    reason: String(bad && bad.reason || 'Неизвестная ошибка'),
    ids: (bad && bad.sampleIds) || [],
    op: String(op || '?')
  });
  /* Сводка массовых: не плодим строки — уже в очереди. */
  scheduleShow(0);
}

function canShow() {
  if (shownCount >= MAX_SHOWN) return false;
  if (now() - lastShownAt < COOLDOWN_MS) return false;
  return true;
}

function modalOpen() {
  var back = el('modalBack');
  return !!(back && back.classList && back.classList.contains('open'));
}

function dragOn() {
  try { return !!(C && C.isDragActive && C.isDragActive()); } catch (x) { return false; }
}

function scheduleShow(delay) {
  if (deferTimer) return;
  deferTimer = setTimeout(function () {
    deferTimer = null;
    tryShow();
  }, delay || 0);
}

function tryShow() {
  if (!deferred.length) return;
  /* Жест или чужая модалка — отложить, не рвать (defer). */
  if (dragOn() || modalOpen()) { scheduleShow(400); return; }
  if (!canShow()) {
    /* Дедуп/потолок: окно не показываем, но помним в lastInfo (ⓘ). */
    deferred = [];
    return;
  }
  var items = deferred;
  deferred = [];
  shownCount++;
  lastShownAt = now();
  if (lastInfo) { lastInfo.shown = shownCount; lastInfo.pending = 0; }
  showWindow(items);
}

/* Одно сводное окно на порцию тревог (массовые операции). */
function showWindow(items) {
  if (!items || !items.length) return;
  var LB = L();
  var title = items.length === 1
    ? '⚠ Целостность данных: ' + items[0].reason
    : '⚠ Целостность данных: ' + items.length + ' проблемы';
  if (items.length > 1) {
    for (var i = 0; i < items.length && i < 5; i++) {
      title += '\n— ' + items[i].reason;
    }
  }
  var ids = items[0].ids || [];
  if (ids.length) {
    title += '\nЗатронуты id: ' + ids.slice(0, 5).join(', ') +
      (ids.length > 5 ? '…' : '');
  }
  title += '\n\nДанные могли измениться не так, как ожидали. ' +
    'Отменить последнее действие?';
  if (!C || typeof C.askIntegrity !== 'function') return;
  C.askIntegrity(title).then(function (undo) {
    if (undo && typeof C.doUndo === 'function') {
      try { C.doUndo(); } catch (x) {}
    }
  });
}

/* Строка для ⓘ (diag). */
function info() {
  if (!lastInfo) return 'нет (проверок 0)';
  var d = Math.round((now() - lastInfo.at) / 1000);
  var when = d < 60 ? d + ' сек назад'
    : d < 3600 ? Math.round(d / 60) + ' мин назад'
    : Math.round(d / 3600) + ' ч назад';
  var s = lastInfo.op + ': ' + lastInfo.reason +
    ' (' + when + ', показано ' + shownCount + '/' + MAX_SHOWN;
  if (deferred.length) s += ', в очереди ' + deferred.length;
  s += ')';
  return s;
}

/* Тесты/сброс сессии. */
function resetSession() {
  depth = 0;
  pendingSnap = null;
  deferred = [];
  if (deferTimer) { clearTimeout(deferTimer); deferTimer = null; }
  lastShownAt = 0;
  shownCount = 0;
  lastInfo = null;
}

function init(ctx) {
  C = ctx;
}

var api = {
  init: init,
  begin: begin,
  end: end,
  endSync: endSync,
  note: note,
  info: info,
  resetSession: resetSession,
  /* Для тестов: canShow/tryShow без DOM. */
  _canShow: canShow,
  _deferredLen: function () { return deferred.length; },
  _shown: function () { return shownCount; }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else if (typeof window !== 'undefined') {
  window.EBIntegrity = api;
}
})();
