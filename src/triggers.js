/* triggers.js — триггеры и движок синка: single-flight (летит один, повтор
 * ждёт очереди), debounce 2 сек, фоновый опрос 60 сек, возврат на вкладку
 * (visibilitychange + focus + pageshow, троттл 15 сек), появление сети,
 * светофор и сеть ⇅ в шапке, проверка новой версии мимо кэша SW.
 * Вынесено из app.js (рефакторинг, этап 5): код перенесён как есть.
 * В app.js остались тонкие алиасы (doSync/scheduleSync/renderNet/getSyncInfo),
 * чтобы вызовы в save/renderStatus и контексте настроек не трогать.
 * Своё состояние (флаги, статус, метки времени синка) живёт здесь;
 * журнал и публикация — src/diag.js (этап 2), сюда пишем через него.
 * UMD: браузер (window.EBTriggers) + Node (module.exports) для тестов.
 *
 * Контекст ctx: on, getState, render, renderStatus, askConfirm, getVersion —
 *   стабильные ссылки; изменяемое (state) только через getState().
 */
(function () {
'use strict';

function el(id) { return document.getElementById(id); }

var C = null;

/* --- single-flight синк: летит один, повтор ждёт очереди --- */
var syncFlying = false;
var syncQueued = false;
var syncFails = 0;
var syncTimer = null;

/* Статус и метки времени последнего синка (диагностика читает через
 * getSync; время успеха/ошибки переживает перезагрузку через журнал
 * модуля diag — restoreLog раскладывает его по переменным). */
var syncStatus = '';
var lastSyncAt = 0;
var lastErrAt = 0;
var lastErrMsg = '';

function getSync() {
  return { status: syncStatus, at: lastSyncAt, errAt: lastErrAt, err: lastErrMsg };
}

function restoreLog(jt) {
  jt = jt || {};
  lastSyncAt = jt.at || 0;
  lastErrAt = jt.errAt || 0;
  lastErrMsg = jt.err || '';
}

function scheduleSync() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(function () { doSync(); }, 2000);
}

function doSync(force) {
  var state = C ? C.getState() : null;
  if (!state || !state.settings.token) {
    syncStatus = 'выключен (нет ключа)';
    C.renderStatus();
    return Promise.resolve('no-token');
  }
  if (syncFlying) { syncQueued = true; return Promise.resolve('queued'); }
  syncFlying = true;
  setLight('yellow', true);
  return window.EBSync.syncNow(state).then(function (res) {
    syncFlying = false;
    syncStatus = res.status;
    if (res.status === 'error') {
      lastErrAt = Date.now();
      lastErrMsg = String(res.error || 'ошибка').slice(0, 120);
      window.EBDiag.push('ошибка синка: ' + lastErrMsg);
      window.EBDiag.save({ at: lastSyncAt, errAt: lastErrAt, err: lastErrMsg });
      setLight('red', false);
      syncFails += 1;
      if (syncFails <= 5) {
        setTimeout(function () { doSync(); }, 2000);
      }
      /* Обрыв сети (без github-) публиковать бессмысленно — сети нет
       * и для самой публикации (как в purchases). */
      if (/github-/.test(lastErrMsg)) window.EBDiag.maybePublishJournal();
    } else {
      syncFails = 0;
      lastSyncAt = Date.now();
      lastErrMsg = '';
      lastErrAt = 0;
      window.EBDiag.push('синк: ' + res.status);
      window.EBDiag.save({ at: lastSyncAt, errAt: lastErrAt, err: lastErrMsg });
      setLight(res.status === 'in-sync' ? 'green' : 'green', false);
      if (res.status === 'pulled' || res.status === 'merged') {
        var st = C.getState();
        if (st) {
          st.updatedAt = Date.now();
          window.EBStore.save(st);
        }
        C.render();
      }
    }
    if (syncQueued) { syncQueued = false; doSync(); }
    else if (!force) { /* ждём следующий триггер */ }
    C.renderStatus();
    return res.status;
  }).catch(function (e) {
    syncFlying = false;
    syncStatus = 'error: ' + String(e && e.message || e).slice(0, 120);
    lastErrAt = Date.now();
    lastErrMsg = String(e && e.message || e).slice(0, 120);
    window.EBDiag.push('ошибка синка: ' + lastErrMsg);
    window.EBDiag.save({ at: lastSyncAt, errAt: lastErrAt, err: lastErrMsg });
    setLight('red', false);
    if (/github-/.test(lastErrMsg)) window.EBDiag.maybePublishJournal();
    C.renderStatus();
    return 'error';
  });
}

function setLight(color, blink) {
  var n = el('syncLight');
  if (!n) return;
  var map = { green: '#4caf50', yellow: '#ffc107', red: '#f44336', gray: '#bbb' };
  n.style.background = map[color] || map.gray;
  if (blink) n.classList.add('blink');
  else n.classList.remove('blink');
  /* Конфликт записи (409/422) — красный «!» (как в purchases); тап — синк. */
  var err = (syncStatus || '') + ' ' + (lastErrMsg || '');
  var alert = color === 'red' && /github-put (409|422)/.test(err);
  n.classList.toggle('alert', alert);
  n.textContent = alert ? '!' : '';
  if (color === 'yellow') n.title = 'Идёт синхронизация…';
  else if (alert) n.title = 'Конфликт записи (409/422). Нажми — принудительный синк.';
  else if (color === 'red') n.title = (syncStatus || 'Ошибка синка') + '. Нажми — попробовать снова.';
  else if (color === 'green') n.title = 'Синк: ' + (syncStatus || 'выполнено') + '. Нажми — синхронизировать.';
  else {
    var st = C ? C.getState() : null;
    n.title = st && st.settings.token
      ? 'Синк ещё не запускался. Нажми — синхронизировать.'
      : 'Синк выключен (нет ключа).';
  }
}

/* Шапка ⇅: цвет — online/offline, подпись — скорость (downlink → МБ/с,
 * отдаёт не каждый браузер, на iPhone пусто). */
function renderNet() {
  var net = el('netStatus');
  if (net) {
    net.textContent = '⇅';
    net.style.color = navigator.onLine ? '#2e9e44' : '#bbb';
    net.title = navigator.onLine ? 'Есть сеть' : 'Нет сети';
  }
  var speed = '';
  try {
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn && conn.downlink > 0) {
      speed = String(Math.round(conn.downlink / 8 * 100) / 100).replace('.', ',') + ' МБ/с';
    }
  } catch (e) { speed = ''; }
  var nt = el('netType');
  if (nt) nt.textContent = (navigator.onLine && speed) ? speed : '';
}

/* --- Проверка новой версии: качает app.js мимо кэша SW --- */
var lastCheck = 0;
function checkUpdate() {
  var now = Date.now();
  if (now - lastCheck < 5 * 60 * 1000) return;
  lastCheck = now;
  fetch('./app.js?nocache=' + now).then(function (r) {
    if (!r.ok) return null;
    return r.text();
  }).then(function (txt) {
    if (!txt) return;
    var m = txt.match(/APP_VERSION\s*=\s*'([^']+)'/);
    if (m && m[1] !== C.getVersion()) {
      C.askConfirm('Вышла новая версия (' + m[1] + ') — обновить?').then(function (ok) {
        if (!ok) return;
        if ('caches' in window) {
          caches.keys().then(function (keys) {
            return Promise.all(keys.map(function (k) { return caches.delete(k); }));
          }).then(function () { location.reload(); });
        } else location.reload();
      });
    }
  }).catch(function () {});
}

function pokeSwUpdate() {
  try {
    if ('serviceWorker' in navigator && navigator.serviceWorker.getRegistration) {
      navigator.serviceWorker.getRegistration().then(function (reg) {
        if (reg && reg.update) reg.update();
      }).catch(function () {});
    }
  } catch (e) {}
}

function setupPolling() {
  setInterval(function () {
    var state = C ? C.getState() : null;
    if (!document.hidden && navigator.onLine && state && state.settings.token) doSync();
  }, 60000);
}

/* Первый запуск после загрузки состояния (boot): светофор, статус без
 * ключа, первый синк, проверка версии, фоновый опрос. */
function onReady() {
  var state = C ? C.getState() : null;
  setLight('gray', false);
  syncStatus = (state && state.settings.token) ? '' : 'выключен (нет ключа)';
  doSync();
  checkUpdate();
  setupPolling();
}

function init(ctx) {
  C = ctx;
  ctx.on('syncNowBtn', 'click', function () { doSync(true); });
  /* Тап по светофору — принудительный синк (как в purchases). */
  ctx.on('syncLight', 'click', function () { doSync(true); });

  /* Возврат на вкладку: три события (visibilitychange + focus + pageshow),
   * иначе bfcache/focus без visibility оставляет старое. */
  var lastFg = 0;
  function onForeground() {
    var now = Date.now();
    if (now - lastFg < 15000) return;
    lastFg = now;
    pokeSwUpdate();
    checkUpdate();
    doSync();
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) onForeground();
  });
  window.addEventListener('focus', onForeground);
  window.addEventListener('pageshow', onForeground);
  window.addEventListener('online', function () { renderNet(); doSync(true); });
  window.addEventListener('offline', renderNet);
  if (navigator.connection && navigator.connection.addEventListener) {
    navigator.connection.addEventListener('change', renderNet);
  }
}

var api = {
  init: init,
  doSync: doSync,
  scheduleSync: scheduleSync,
  setLight: setLight,
  renderNet: renderNet,
  checkUpdate: checkUpdate,
  pokeSwUpdate: pokeSwUpdate,
  setupPolling: setupPolling,
  onReady: onReady,
  getSync: getSync,
  restoreLog: restoreLog
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else if (typeof window !== 'undefined') {
  window.EBTriggers = api;
}
})();
