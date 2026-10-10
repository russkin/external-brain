/* diag.js — диагностика и журнал синка: кольцевой журнал, публикация
 * в logs/, текст диагностики, device id.
 * Вынесено из app.js (рефакторинг, этап 2): код перенесён как есть.
 * Движок синка пишет через push/save/maybePublishJournal; своё состояние
 * (syncStatus, метки времени, lastAction, bootError) живёт в приложении
 * и читается только через ctx. Своих глобалов не трогает.
 * UMD: браузер (window.EBDiag) + Node (module.exports) для тестов.
 *
 * Контекст ctx: on, L, showInfo, renderStatus — стабильные ссылки;
 *   getState, getSync() {status,at,errAt,err}, getLastAction,
 *   getBoot() {error,stack}, getHistoryCounts() {u,r},
 *   getCollapsed(), isDoneHidden(), getVersion() — изменяемое только так;
 *   fmtWhen — общая с диалогами пинов, живёт в приложении.
 */
(function () {
'use strict';

function el(id) { return document.getElementById(id); }

/* Диагностика синка: время последнего успеха/ошибки переживает
 * перезагрузку (иначе после F5 «когда был синк» не ответить). */
var SYNCLOG_KEY = 'external-brain-synclog-v1';
/* Кольцо последних синк-событий для «Журнал:» в диагностике —
 * как в purchases (там journal.js): успехи и ошибки, последние 50. */
var syncLog = [];

function push(text) {
  syncLog.push({ t: Date.now(), text: String(text).slice(0, 300) });
  if (syncLog.length > 50) syncLog.shift();
}

/* Восстанавливает кольцо и публикацию; метки времени движка (at/errAt/err)
 * живут в приложении — возвращаем их, boot сам разложит по переменным. */
function load() {
  var out = { at: 0, errAt: 0, err: '' };
  try {
    var r = JSON.parse(localStorage.getItem(SYNCLOG_KEY));
    if (r && typeof r === 'object') {
      out.at = +r.at || 0;
      out.errAt = +r.errAt || 0;
      out.err = String(r.err || '').slice(0, 120);
      syncLog = Array.isArray(r.log) ? r.log.slice(-50) : [];
      pubAt = +r.pubAt || 0;
      pubStatus = String(r.pub || '').slice(0, 120);
    }
  } catch (x) {}
  return out;
}

function save(extra) {
  extra = extra || {};
  try {
    localStorage.setItem(SYNCLOG_KEY, JSON.stringify({
      at: extra.at || 0,
      errAt: extra.errAt || 0,
      err: String(extra.err || '').slice(0, 120),
      log: syncLog.slice(-50),
      pubAt: pubAt, pub: pubStatus
    }));
  } catch (x) {}
}

/* Публикация журнала в logs/ при ошибке синка — как в purchases:
 * не чаще раза в 15 минут (иначе спам коммитами), имя в сутки
 * logs/sync-ГГГГ-ММ-ДД-<device>.json, обрывы сети (без github-) не публикуем. */
var lastJournalPublish = 0;
var pubAt = 0, pubStatus = '';
var DEVICE_KEY = 'external-brain-device-v1';

function journalDeviceId() {
  try {
    var id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = Math.random().toString(16).slice(2, 10);
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch (x) { return 'nodev'; }
}

function logFileName() {
  var d = new Date();
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return 'logs/sync-' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' +
    p(d.getDate()) + '-' + journalDeviceId() + '.json';
}

var C = null;

function maybePublishJournal() {
  try {
    var state = C.getState();
    var st = state && state.settings;
    if (!st || !st.repo || !st.token) return;
    var now = Date.now();
    if (now - lastJournalPublish < 15 * 60 * 1000) return;
    lastJournalPublish = now;
    var body = {
      device: journalDeviceId(),
      version: C.getVersion(),
      at: new Date(now).toISOString(),
      journal: syncLog.slice(-50)
    };
    window.EBSync.publishFile(st.repo, st.token, logFileName(), body).then(function (res) {
      pubAt = Date.now();
      pubStatus = String(res || '');
      push('публикация журнала: ' + pubStatus);
      save({});
      C.renderStatus();
    });
  } catch (x) {}
}

function fmtDT(ms) {
  try {
    var d = new Date(ms);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getDate()) + '.' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  } catch (x) { return '—'; }
}

function connLine() {
  try {
    var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!c) return 'н/д';
    var parts = [];
    if (c.effectiveType) parts.push(c.effectiveType);
    if (typeof c.downlink === 'number') parts.push(c.downlink + ' Мбит/с');
    return parts.length ? parts.join(' · ') : 'н/д';
  } catch (x) { return 'н/д'; }
}

function deviceLine() {
  try {
    var ua = navigator.userAgent || '';
    var os = 'Другое';
    if (/Android/i.test(ua)) os = 'Android';
    else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
    else if (/Windows/i.test(ua)) os = 'Windows';
    else if (/Mac OS X/i.test(ua)) os = 'macOS';
    else if (/Linux/i.test(ua)) os = 'Linux';
    var br = '';
    var m = ua.match(/(?:Chrome|Chromium|Edg)\/([\d.]+)/);
    if (m) br = 'Chrome ' + m[1].split('.')[0];
    else if ((m = ua.match(/Firefox\/([\d.]+)/))) br = 'Firefox ' + m[1].split('.')[0];
    else if ((m = ua.match(/Version\/([\d.]+).*Safari/))) br = 'Safari ' + m[1].split('.')[0];
    return os + (br ? ' · ' + br : '');
  } catch (x) { return 'н/д'; }
}

/* SW и версия кэша — асинхронно (caches.keys), поэтому diagText — промис. */
function diagSwInfo() {
  try {
    if (!('serviceWorker' in navigator)) return Promise.resolve('нет поддержки');
    var act = navigator.serviceWorker.controller ? 'активен' : 'не активен';
    if (typeof caches === 'undefined' || !caches || !caches.keys) {
      return Promise.resolve(act + ', кэш н/д');
    }
    return caches.keys().then(function (ks) {
      var hit = '';
      for (var i = 0; i < ks.length; i++) {
        if (String(ks[i]).indexOf('extbrain-') === 0) hit = String(ks[i]);
      }
      return act + (hit ? ', ' + hit : ', кэш пуст');
    }).catch(function () { return act; });
  } catch (x) { return Promise.resolve('н/д'); }
}

function backupLabel(fmtWhen) {
  var b = window.EBStore && window.EBStore.backupInfo ? window.EBStore.backupInfo() : null;
  if (!b) return 'нет';
  return fmtWhen(b.savedAt);
}

function pinLabel(fmtWhen) {
  var p = window.EBStore && window.EBStore.pinInfo ? window.EBStore.pinInfo() : null;
  if (!p) return 'нет';
  var src = (p.by === 'auto' && p.version) ? 'перед ' + p.version : 'вручную';
  return fmtWhen(p.savedAt) + ' (' + src + ')';
}

function diagText() {
  var state = C.getState();
  var sy = C.getSync();
  var st = state ? C.L.stats(state.tasks)
    : { inbox: 0, next: 0, done: 0 };
  var alive = (st.inbox || 0) + (st.next || 0);
  var recs = 0, bytes = 0;
  try {
    recs = state ? state.tasks.length : 0;
    bytes = JSON.stringify(state ? state.tasks : []).length;
  } catch (x) {}
  var collapsed = C.getCollapsed();
  var collapsedN = 0;
  for (var id in collapsed) if (collapsed[id]) collapsedN++;
  var lines = [
    'Внешний мозг ' + C.getVersion(),
    'Задач: ' + alive + ' · готово ' + (st.done || 0),
    'Размер: ' + recs + ' записей · ' +
      (bytes < 1024 ? bytes + ' Б' : (bytes / 1024).toFixed(1) + ' КБ'),
    'Синк: ' + (sy.status || '—') + (sy.at ? ' (в ' + fmtDT(sy.at) + ')' : '')
  ];
  if (sy.err) lines.push('Ошибка синка: ' + fmtDT(sy.errAt) + ' — ' + sy.err);
  lines.push('Данные: ' + (state && state.updatedAt ? fmtDT(state.updatedAt) + ' (изменены)' : '—'));
  lines.push('Локально: выполненные ' + (C.isDoneHidden() ? 'скрыты' : 'видны') +
    ' · свёрнуто групп ' + collapsedN);
  var h = C.getHistoryCounts();
  lines.push('История: ↩ ' + h.u + ' · ↪ ' + h.r);
  /* ВРЕМЕННОЕ (диагностика странной отмены): верх стека — что вернёт
   * следующая ↩. Убрать после выяснения. */
  try {
    var pk = C.getHistoryPeek ? C.getHistoryPeek() : [];
    for (var pi = 0; pi < pk.length; pi++) {
      lines.push('Стек ↩' + (pi + 1) + ': живые [' + pk[pi].alive.join(',') +
        '] мёртвые [' + pk[pi].dead.join(',') + '] черновик ' + pk[pi].draft);
    }
  } catch (x) {}
  lines.push('Сеть: ' + connLine());
  lines.push('Устройство: ' + deviceLine() + ' · id ' + journalDeviceId());
  lines.push('Repo: ' + (state ? state.settings.repo : '?'));
  lines.push('Ключ: ' + (state && state.settings.token ? 'введён' : 'выключен (нет ключа)'));
  /* При ошибке отправки дописываем, что локальный журнал цел: иначе
   * «log-error» читается как потеря диагностики. */
  var pubNote = pubStatus.indexOf('log-error') === 0 ? ' (локальный журнал цел)' : '';
  lines.push('Публикация журнала: ' +
    (pubAt ? fmtDT(pubAt) + ' · ' + pubStatus + pubNote : 'ещё не было'));
  lines.push('Локальная копия: ' + backupLabel(C.fmtWhen));
  lines.push('Постоянная копия: ' + pinLabel(C.fmtWhen));
  var lastAction = C.getLastAction();
  if (lastAction) lines.push('Последнее действие: ' + lastAction);
  /* Только непойманные JS-ошибки (window.onerror); ошибки синка живут
   * в «Ошибка синка» и журнале ниже — поэтому «Ошибок JS: нет» не спорит
   * с журналом. */
  var b = C.getBoot();
  lines.push(b.error ? b.error + ' ' + b.stack : 'Ошибок JS: нет');
  if (syncLog.length) {
    lines.push('Журнал:');
    var from = Math.max(0, syncLog.length - 12);
    for (var k = from; k < syncLog.length; k++) {
      lines.push('  ' + fmtDT(syncLog[k].t) + ' [sync] ' + syncLog[k].text);
    }
  }
  return diagSwInfo().then(function (sw) {
    lines.splice(1, 0, 'Обновление: SW ' + sw);
    return lines.join('\n');
  });
}

function init(ctx) {
  C = ctx;
  ctx.on('diagBtn', 'click', function () {
    diagText().then(function (txt) {
      ctx.showInfo('Диагностика', txt, txt);
    });
  });
}

var api = {
  init: init,
  push: push,
  save: save,
  load: load,
  maybePublishJournal: maybePublishJournal,
  diagText: diagText,
  journalDeviceId: journalDeviceId
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else if (typeof window !== 'undefined') {
  window.EBDiag = api;
}
})();
