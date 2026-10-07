/* app.js — интерфейс «Внешнего мозга»: список дел по аналогии с Google Keep
 * (строки, выполнение, время) + свои фичи: поиск, заливка и многократный
 * отступ вложенных, сворачивание/разворачивание, история, копии, инструкция. */
'use strict';

(function () {
  var APP_VERSION = 'v95';
  var INDENT_STEP = 28;
  var LINES_GAP = 8;
  var COLLAPSED_KEY = 'external-brain-collapsed-v1';
  var DONE_HIDDEN_KEY = 'external-brain-done-hidden-v1';
  var L = window.EBLogic;
  var state = null;
  var syncStatus = '';
  var lastAction = '';
  var bootError = '';
  var bootStack = '';

  /* Диагностика синка: время последнего успеха/ошибки переживает
   * перезагрузку (иначе после F5 «когда был синк» не ответить). */
  var SYNCLOG_KEY = 'external-brain-synclog-v1';
  var lastSyncAt = 0;
  var lastErrAt = 0;
  var lastErrMsg = '';
  /* Кольцо последних синк-событий для «Журнал:» в диагностике —
   * как в purchases (там journal.js): успехи и ошибки, последние 50. */
  var syncLog = [];
  function syncLogPush(text) {
    syncLog.push({ t: Date.now(), text: String(text).slice(0, 300) });
    if (syncLog.length > 50) syncLog.shift();
  }
  function syncLogLoad() {
    try {
      var r = JSON.parse(localStorage.getItem(SYNCLOG_KEY));
      if (r && typeof r === 'object') {
        lastSyncAt = +r.at || 0;
        lastErrAt = +r.errAt || 0;
        lastErrMsg = String(r.err || '').slice(0, 120);
        syncLog = Array.isArray(r.log) ? r.log.slice(-50) : [];
        pubAt = +r.pubAt || 0;
        pubStatus = String(r.pub || '').slice(0, 120);
      }
    } catch (x) {}
  }
  function syncLogSave() {
    try {
      localStorage.setItem(SYNCLOG_KEY, JSON.stringify({
        at: lastSyncAt, errAt: lastErrAt, err: lastErrMsg, log: syncLog.slice(-50),
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
  function maybePublishJournal() {
    try {
      var st = state && state.settings;
      if (!st || !st.repo || !st.token) return;
      var now = Date.now();
      if (now - lastJournalPublish < 15 * 60 * 1000) return;
      lastJournalPublish = now;
      var body = {
        device: journalDeviceId(),
        version: APP_VERSION,
        at: new Date(now).toISOString(),
        journal: syncLog.slice(-50)
      };
      window.EBSync.publishFile(st.repo, st.token, logFileName(), body).then(function (res) {
        pubAt = Date.now();
        pubStatus = String(res || '');
        syncLogPush('публикация журнала: ' + pubStatus);
        syncLogSave();
        renderStatus();
      });
    } catch (x) {}
  }

  function el(id) { return document.getElementById(id); }

  /* Подписка, стойкая к рассинхрону кэшей: если index.html старый, а app.js новый,
   * элемента может не быть — пропускаем подписку, а не роняем всё приложение. */
  function on(id, ev, fn) {
    var n = el(id);
    if (n) n.addEventListener(ev, fn);
    return n;
  }

  window.addEventListener('error', function (e) {
    var msg = (e && e.message) ? e.message : String(e);
    var stack = '';
    try {
      if (e && e.error && e.error.stack) stack = String(e.error.stack);
    } catch (x) { stack = ''; }
    if (!stack) stack = 'at ' + ((e && e.filename) ? e.filename : '?') + ':' + ((e && e.lineno) ? e.lineno : '?');
    bootError = 'ОШИБКА: ' + msg;
    bootStack = stack.slice(0, 1500);
    try { renderStatus(); } catch (err) {
      var s = document.getElementById('status');
      if (s) s.textContent = bootError;
    }
  });

  /* Своя модалка: prompt/confirm на iOS Chrome вне user-activation блокируются. */
  function askText(title, initial, showClear) {
    return new Promise(function (resolve) {
      var back = el('modalBack'), text = el('modalText'), input = el('modalInput');
      var ok = el('modalOk'), clear = el('modalClear'), cancel = el('modalCancel');
      if (!back || !input || !ok || !cancel) { resolve(null); return; }
      text.textContent = title;
      input.style.display = '';
      input.value = initial || '';
      var clearBtn = el('modalClear');
      if (clearBtn) clearBtn.style.display = showClear ? '' : 'none';
      back.classList.add('open');
      setTimeout(function () { try { input.focus(); } catch (e) {} }, 50);
      function done(v) {
        back.classList.remove('open');
        ok.onclick = null; cancel.onclick = null;
        if (clearBtn) clearBtn.onclick = null;
        resolve(v);
      }
      ok.onclick = function () { done(input.value); };
      if (clearBtn) clearBtn.onclick = function () { done(''); };
      cancel.onclick = function () { done(null); };
    });
  }

  function askConfirm(title) {
    return new Promise(function (resolve) {
      var back = el('modalBack'), text = el('modalText'), input = el('modalInput');
      var ok = el('modalOk'), cancel = el('modalCancel'), clearBtn = el('modalClear');
      if (!back || !ok || !cancel) { resolve(false); return; }
      text.textContent = title;
      if (input) input.style.display = 'none';
      if (clearBtn) clearBtn.style.display = 'none';
      back.classList.add('open');
      function done(v) {
        back.classList.remove('open');
        ok.onclick = null; cancel.onclick = null;
        resolve(v);
      }
      ok.onclick = function () { done(true); };
      cancel.onclick = function () { done(false); };
    });
  }

  /* --- Время задачи (estMin, минуты): свайп вправо / тап по метке --- */
  var durTot = 0;
  function durRender() {
    var h = el('durHv'), m = el('durMv');
    if (h) h.textContent = String(Math.floor(durTot / 60));
    if (m) m.textContent = String(durTot % 60);
  }

  /* Модалка со стрелками: часы ±60, минуты ±5 (итог — общие минуты,
   * перенос разряда автоматический). OK — минуты, «Убрать» — 0,
   * Отмена — null. Статичные кнопки стрелок подписаны в wire() через on(). */
  function askDuration(initialMin) {
    return new Promise(function (resolve) {
      var back = el('modalBack'), text = el('modalText'), input = el('modalInput');
      var ok = el('modalOk'), cancel = el('modalCancel'), clearBtn = el('modalClear');
      var ctl = el('durCtl');
      if (!back || !ok || !cancel || !ctl) { resolve(null); return; }
      text.textContent = 'Сколько времени займёт?';
      if (input) input.style.display = 'none';
      durTot = Math.max(0, Math.min(59999, parseInt(initialMin, 10) || 0));
      durRender();
      ctl.style.display = 'flex';
      if (clearBtn) { clearBtn.textContent = 'Убрать'; clearBtn.style.display = ''; }
      back.classList.add('open');
      function done(v) {
        back.classList.remove('open');
        ok.onclick = null; cancel.onclick = null;
        ctl.style.display = 'none';
        if (clearBtn) {
          clearBtn.onclick = null;
          clearBtn.textContent = 'Очистить';
          clearBtn.style.display = 'none';
        }
        resolve(v);
      }
      ok.onclick = function () { done(durTot); };
      if (clearBtn) clearBtn.onclick = function () { done(0); };
      cancel.onclick = function () { done(null); };
    });
  }

  function openDuration(taskId) {
    if (!taskId || !state) return;
    var task = L.getTask(state.tasks, taskId);
    if (!task || task.deleted) return;
    /* Родителю время ставить нельзя (свайп вправо и тап по метке ведут
     * сюда): его метка — авто-сумма первого вложения, см. lineEstMin. */
    if (hasKidsFull(taskId)) return;
    var cur = task.estMin || 0;
    askDuration(cur).then(function (min) {
      if (min == null || min === cur) return;
      mutate(function () { L.clarifyTask(state.tasks, taskId, { estMin: min }); });
    });
  }

  function save() {
    if (!state) return Promise.resolve(false);
    return window.EBStore.save(state).then(function () {
      scheduleSync();
      return true;
    });
  }

  function mutate(fn) {
    return mutateWithHistory(fn);
  }

  /* --- История изменений (undo/redo стрелками в шапке, локально) ---
   * Слепок задач до каждой меняющей мутации; отмена применяется как новое
   * изменение со свежими метками (так честно и для синка): созданное после
   * превращается в tombstone, удалённое воскресает, правки побеждают.
   * В слепок входит и пустое поле (якорь/текст/сдвиг), чтобы Enter делился
   * на два шага отмены: сначала уходит новое пустое поле (задача остаётся),
   * затем — сама задача (текст возвращается в поле). */
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
  function histLoad() {
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
  histLoad();

  function snapTasks() {
    try { return JSON.stringify(state.tasks); } catch (x) { return '[]'; }
  }

  /* Полный слепок для истории: задачи + положение/текст/сдвиг пустого поля. */
  function snapFull() {
    return {
      tasks: snapTasks(),
      afterId: trailingAfterId,
      text: trailingText,
      indent: trailingIndent
    };
  }

  function mutateWithHistory(fn) {
    if (!state) return null;
    var before = snapFull();
    var r = fn();
    if (snapTasks() !== before.tasks) {
      pushUndo(before);
      state.updatedAt = Date.now();
    }
    if (!dragActive) render();
    save();
    updateHistoryButtons();
    return r;
  }

  function applySnapshot(s) {
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
        c = L.normalizeTask(t);
        if (!c) continue;
        c.ts = now;
        c.updatedAt = now;
        out.push(c);
      }
      for (i = 0; i < state.tasks.length; i++) {
        t = state.tasks[i];
        if (!t || !t.id || keep[t.id] || t.deleted) continue;
        c = L.normalizeTask(t);
        if (!c) continue;
        c.deleted = true;
        c.ts = now;
        c.updatedAt = now;
        out.push(c);
      }
      state.tasks = out;
      save();
    }
    if (s && typeof s === 'object') {
      trailingAfterId = s.afterId || null;
      trailingText = String(s.text || '');
      trailingIndent = (s.indent == null) ? null : s.indent;
    }
    render();
    updateHistoryButtons();
  }

  function doUndo() {
    if (!state || !undoStack.length) return;
    redoStack.push(snapFull());
    if (redoStack.length > HISTORY_MAX) redoStack.shift();
    var us = undoStack.pop();
    histSave();
    applySnapshot(us);
    focusAfterHistory(us, false);
  }

  function doRedo() {
    if (!state || !redoStack.length) return;
    undoStack.push(snapFull());
    if (undoStack.length > HISTORY_MAX) undoStack.shift();
    var rs = redoStack.pop();
    histSave();
    applySnapshot(rs);
    focusAfterHistory(rs, true);
  }

  function updateHistoryButtons() {
    var u = el('undoBtn'), r = el('redoBtn');
    if (u) u.disabled = !undoStack.length;
    if (r) r.disabled = !redoStack.length;
  }

  /* Курсор в задачу по id: по умолчанию в конец (после отмены вызова
   * поля), с pos — на точную позицию (сцепка: стык верхней и хвоста). */
  function focusTaskEnd(taskId, pos) {
    if (!taskId) return;
    var box = el('lines');
    if (!box || !box.querySelectorAll) return;
    var rows = box.querySelectorAll('.tline[data-id]');
    for (var i = 0; i < rows.length; i++) {
      if (!rows[i].getAttribute || rows[i].getAttribute('data-id') !== taskId) continue;
      var inp = rows[i].querySelector ? rows[i].querySelector('.tinput') : null;
      if (inp && inp.focus) {
        try {
          inp.focus();
          var v = inp.value || '';
          var p = (pos == null || pos > v.length) ? v.length : pos;
          if (inp.setSelectionRange) inp.setSelectionRange(p, p);
        } catch (x) {}
      }
      return;
    }
  }

  /* Курсор в НАЧАЛО задачи по id (после сплита Enter в середине:
   * набор продолжается перед хвостом, как в редакторе). */
  function focusLineStart(taskId) {
    if (!taskId) return;
    var box = el('lines');
    if (!box || !box.querySelectorAll) return;
    var rows = box.querySelectorAll('.tline[data-id]');
    for (var i = 0; i < rows.length; i++) {
      if (!rows[i].getAttribute || rows[i].getAttribute('data-id') !== taskId) continue;
      var inp = rows[i].querySelector ? rows[i].querySelector('.tinput') : null;
      if (inp && inp.focus) {
        try {
          inp.focus();
          if (inp.setSelectionRange) inp.setSelectionRange(0, 0);
        } catch (x) {}
      }
      return;
    }
  }

  /* Жива ли цепочка из слепка: якорь TOP или живая задача. */
  function snapChainLive(s) {
    if (!s || !s.afterId) return false;
    if (s.afterId === 'TOP') return true;
    var a = state ? L.getTask(state.tasks, s.afterId) : null;
    return !!(a && !a.deleted && a.status !== 'done');
  }

  /* После отмены/возврата курсор — в осмысленное поле. Отмена точки
   * с фокусом убирает вызванное поле → курсор в конец той задачи,
   * даже если концевое поле списка видно (оно тут ни при чём).
   * Остальное: возврат — в видимое поле (или задачу из точки). */
  function focusAfterHistory(s, isRedo) {
    var box = el('lines');
    var draft = (box && box.querySelector) ? box.querySelector('.tline[data-trailing] .tinput') : null;
    if (!isRedo && s && s.focusId && !snapChainLive(s)) {
      focusTaskEnd(s.focusId);
      return;
    }
    if (draft && draft.focus) {
      try { draft.focus(); } catch (x) {}
      return;
    }
    if (s && s.focusId) focusTaskEnd(s.focusId);
  }

  /* --- single-flight синк: летит один, повтор ждёт очереди --- */
  var syncFlying = false;
  var syncQueued = false;
  var syncFails = 0;
  var syncTimer = null;

  function scheduleSync() {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(function () { doSync(); }, 2000);
  }

  function doSync(force) {
    if (!state || !state.settings.token) {
      syncStatus = 'выключен (нет ключа)';
      renderStatus();
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
        syncLogPush('ошибка синка: ' + lastErrMsg);
        syncLogSave();
        setLight('red', false);
        syncFails += 1;
        if (syncFails <= 5) {
          setTimeout(function () { doSync(); }, 2000);
        }
        /* Обрыв сети (без github-) публиковать бессмысленно — сети нет
         * и для самой публикации (как в purchases). */
        if (/github-/.test(lastErrMsg)) maybePublishJournal();
      } else {
        syncFails = 0;
        lastSyncAt = Date.now();
        lastErrMsg = '';
        lastErrAt = 0;
        syncLogPush('синк: ' + res.status);
        syncLogSave();
        setLight(res.status === 'in-sync' ? 'green' : 'green', false);
        if (res.status === 'pulled' || res.status === 'merged') {
          state.updatedAt = Date.now();
          window.EBStore.save(state);
          render();
        }
      }
      if (syncQueued) { syncQueued = false; doSync(); }
      else if (!force) { /* ждём следующий триггер */ }
      renderStatus();
      return res.status;
    }).catch(function (e) {
      syncFlying = false;
      syncStatus = 'error: ' + String(e && e.message || e).slice(0, 120);
      lastErrAt = Date.now();
      lastErrMsg = String(e && e.message || e).slice(0, 120);
      syncLogPush('ошибка синка: ' + lastErrMsg);
      syncLogSave();
      setLight('red', false);
      if (/github-/.test(lastErrMsg)) maybePublishJournal();
      renderStatus();
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
    else n.title = state && state.settings.token
      ? 'Синк ещё не запускался. Нажми — синхронизировать.'
      : 'Синк выключен (нет ключа).';
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
      if (m && m[1] !== APP_VERSION) {
        askConfirm('Вышла новая версия (' + m[1] + ') — обновить?').then(function (ok) {
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

  /* --- Рендер --- */

  function render() {
    if (!state) return;
    /* Позиция страницы: перестроение схлопывает список на кадр и браузер
     * увозит скролл наверх — запоминаем и возвращаем обратно. */
    var keepY = 0;
    try { keepY = window.pageYOffset || document.documentElement.scrollTop || 0; } catch (x) { keepY = 0; }
    var v = el('appVerHead');
    if (v) v.textContent = APP_VERSION;
    var v2 = el('appVer');
    if (v2) v2.textContent = APP_VERSION;
    renderLines();
    renderStatus();
    updateHistoryButtons();
    /* Подсветка поиска переживает перерисовки (фоновый синк): строка
     * та же (по id), скролл не трогаем — только класс. */
    if (searchIdx >= 0 && searchIdx < searchIds.length) applySearchHit(searchIds[searchIdx]);
    try {
      var curY = window.pageYOffset || 0;
      if (curY !== keepY) window.scrollTo(0, keepY);
    } catch (x) {}
  }

  /* --- Стартовый экран: строки «grip 6 точек + поле ввода» --- */

  function lineTasks() {
    var out = [];
    for (var i = 0; i < state.tasks.length; i++) {
      var t = state.tasks[i];
      if (!t || t.deleted) continue;
      if (t.status === 'done') continue;
      out.push(t);
    }
    out.sort(function (a, b) {
      var ca = a.createdAt || 0, cb = b.createdAt || 0;
      if (ca !== cb) return ca - cb;
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });
    return out;
  }

  /* Полный порядок (включая выполненных) — как в renderLines. */
  function fullList() {
    return L.normalizeTasks(state.tasks).filter(function (t) { return !t.deleted; });
  }

  /* Есть ли вложенные у id в ПОЛНОМ порядке: тап по точкам и «свернуть
   * все» должны работать, даже если дети уже выполнены — они живут в
   * отдельной секции и должны прятаться вместе с группой. */
  function hasKidsFull(id) {
    if (!id) return false;
    var full = fullList();
    for (var i = 0; i < full.length; i++) {
      if (full[i].id === id) return L.hasKids(full, i);
    }
    return false;
  }

  function makeGrip() {
    var g = document.createElement('span');
    g.className = 'grip';
    g.title = 'Тащить / свернуть группу';
    g.setAttribute('aria-label', 'Тащить');
    for (var i = 0; i < 6; i++) {
      var d = document.createElement('span');
      d.className = 'dot';
      g.appendChild(d);
    }
    return g;
  }

  /* Свёрнутые группы: локально на устройстве (в синк не ходит). */
  var collapsed = {};
  function loadCollapsed() {
    collapsed = {};
    try {
      var raw = null;
      if (typeof localStorage !== 'undefined') raw = localStorage.getItem(COLLAPSED_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      for (var i = 0; i < arr.length; i++) collapsed[String(arr[i])] = true;
    } catch (x) { collapsed = {}; }
  }
  function saveCollapsed() {
    try {
      if (typeof localStorage === 'undefined') return;
      var arr = [];
      for (var id in collapsed) {
        if (collapsed[id]) arr.push(id);
      }
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(arr));
    } catch (x) {}
  }
  function toggleCollapse(id) {
    if (!id) return;
    if (collapsed[id]) delete collapsed[id];
    else collapsed[id] = true;
    saveCollapsed();
    render();
  }
  function setAllCollapsed(all) {
    collapsed = {};
    if (all && state) {
      var tasks = lineTasks();
      for (var i = 0; i < tasks.length; i++) {
        if (hasKidsFull(tasks[i].id)) collapsed[tasks[i].id] = true;
      }
    }
    saveCollapsed();
    render();
  }

  /* Скрытая секция выполненных: локально на устройстве (в синк не ходит).
   * Разделитель «Выполнено · N» остаётся всегда — он же точка возврата. */
  var doneHidden = false;
  function loadDoneHidden() {
    try {
      doneHidden = typeof localStorage !== 'undefined' &&
        localStorage.getItem(DONE_HIDDEN_KEY) === '1';
    } catch (x) { doneHidden = false; }
  }
  function saveDoneHidden() {
    try {
      if (typeof localStorage === 'undefined') return;
      if (doneHidden) localStorage.setItem(DONE_HIDDEN_KEY, '1');
      else localStorage.removeItem(DONE_HIDDEN_KEY);
    } catch (x) {}
  }
  /* Полный порядок задач (живые + выполненные) для обхода предков. */
  function fullOrdered() {
    var a = [], i;
    for (i = 0; i < state.tasks.length; i++) {
      if (state.tasks[i] && state.tasks[i].id) a.push(state.tasks[i]);
    }
    a.sort(function (x, y) {
      var cx = x.createdAt || 0, cy = y.createdAt || 0;
      if (cx !== cy) return cx - cy;
      return x.id < y.id ? -1 : (x.id > y.id ? 1 : 0);
    });
    return a;
  }
  /* Виден ли хоть один выполненный прямо сейчас: секция не скрыта
   * тумблером и хотя бы один не спрятан сворачиванием групп. */
  function anyDoneShown() {
    if (!state || doneHidden) return false;
    var dn = [];
    try { dn = L.doneList(state.tasks); } catch (x) { dn = []; }
    if (!dn.length) return false;
    var full = fullOrdered();
    function idxOf(id) {
      for (var i = 0; i < full.length; i++) if (full[i].id === id) return i;
      return -1;
    }
    for (var d = 0; d < dn.length; d++) {
      var di = idxOf(dn[d].id);
      if (di !== -1 && !L.isHiddenByCollapse(full, di, collapsed)) return true;
    }
    return false;
  }
  /* Развернуть предков всех выполненных (свёрнутые группы), чтобы после
   * тапа по разделителю секция действительно стала видна. */
  function expandDoneParents() {
    if (!state) return false;
    var dn = [];
    try { dn = L.doneList(state.tasks); } catch (x) { dn = []; }
    var full = fullOrdered();
    var changed = false, d, i;
    function idxOf(id) {
      for (var k = 0; k < full.length; k++) if (full[k].id === id) return k;
      return -1;
    }
    for (d = 0; d < dn.length; d++) {
      var di = idxOf(dn[d].id);
      if (di === -1) continue;
      var minInd = 99999;
      for (i = di; i >= 0; i--) {
        var ind = lineIndent(full[i]);
        if (ind < minInd) {
          minInd = ind;
          if (i !== di && collapsed[full[i].id]) {
            delete collapsed[full[i].id];
            changed = true;
          }
        }
      }
    }
    if (changed) saveCollapsed();
    return changed;
  }
  function toggleDoneHidden() {
    /* Тап по разделителю: видно — прячем тумблером; не видно (тумблер
     * или свёрнутые группы) — показываем всё: тумблер off + разворот. */
    if (anyDoneShown()) {
      doneHidden = true;
    } else {
      doneHidden = false;
      expandDoneParents();
    }
    saveDoneHidden();
    render();
  }

  /* Пустое поле ввода: одно на весь список, но живёт под той строкой,
   * где был нажат Enter (цепочка ввода вниз). Текст переживает перерисовки. */
  var trailingAfterId = null;
  var trailingText = '';
  var trailingIndent = null;
  /* Защита от двойного тапа по флагу черновика: pointerup+click приходят
   * парой и без гарда создают две задачи вместо одной. */
  var draftTapBusy = false;

  /* Последний pointerdown (захват — до смены фокуса): по нему blur черновика
   * отличает «тап по флагу/грипу/строке» (у их жестов своя логика — не мешаем)
   * от настоящей потери фокуса (задача создаётся). */
  var lastPDTarget = null, lastPDts = 0;
  document.addEventListener('pointerdown', function (e) {
    lastPDTarget = e.target;
    lastPDts = Date.now();
  }, true);

  var draftBlurTimer = null;
  /* Жест перетаскивания: пока флаг поднят, render в mutate/commit не
   * выполняется — узлы жеста не пересоздаются. Фокус при захвате НЕ
   * снимается: blur закрыл бы клавиатуру посреди touch, вьюпорт прыгнул,
   * содержимое уехало из-под пальца и жест глох (v51). Клавиатура
   * закрывается в finish — после pointerup. */
  var dragActive = false;
  /* Курсор стоял в поле-черновике — после ЖЕСТА ПО САМОМУ ПОЛЮ возвращаем
   * его (поле на месте — набирать-то надо). */
  var refocusDraft = false;

  /* Пин прокрутки: пока жест жив, страница не уезжает — автоскролы
   * (фокус, закрытие клавиатуры) держатся на месте, содержимое не
   * уходит из-под пальца. Свой автоскрол руками двигает pinY. */
  var pinY = null, pinTimer = null, pinOn = false;
  function onPinScroll() {
    if (pinY == null) return;
    if (window.pageYOffset !== pinY) {
      try { window.scrollTo(0, pinY); } catch (x) {}
    }
  }
  function pinScroll() {
    if (pinTimer) { clearTimeout(pinTimer); pinTimer = null; }
    pinY = window.pageYOffset;
    if (!pinOn) {
      pinOn = true;
      window.addEventListener('scroll', onPinScroll);
      window.addEventListener('resize', onPinScroll);
    }
  }
  function unpinScroll(delay) {
    if (pinTimer) { clearTimeout(pinTimer); pinTimer = null; }
    if (delay) {
      pinTimer = setTimeout(function () { pinTimer = null; unpinScroll(); }, delay);
      return;
    }
    pinY = null;
    if (pinOn) {
      pinOn = false;
      window.removeEventListener('scroll', onPinScroll);
      window.removeEventListener('resize', onPinScroll);
    }
  }

  /* Отступ строки в пикселях. Задача с отступом входит в группу задачи сверху. */
  function lineIndent(t) {
    var v = parseInt(t && t.indent, 10);
    if (!(v >= 0)) return 0;
    if (v > 8) return 8;
    return v;
  }

  /* Метка времени строки (opts.estMin в makeLine): у обычной задачи — своё
   * estMin; у РОДИТЕЛЯ — авто-сумма первого вложения (дети уровня indent+1;
   * у вложенных-родителей — их такая же сумма, т.е. итог по всем своим).
   * Выполненные вложения в сумму НЕ входят (v71): чип родителя — только
   * остаток невыполненного; когда всё закрыто — сумма 0 и метки нет.
   * Своё estMin родителя в вёрстку не идёт — ему время ставить нельзя
   * (openDuration закрыт), данные не трогаем на случай расформировки группы:
   * без детей задача снова показывает своё время. Появление метки у родителя
   * — только если сумма > 0 (хотя бы у одной задачи первого вложения
   * задано время). */
  function lineEstMin(t) {
    if (!t) return 0;
    var full = fullList();
    var pi = -1;
    for (var i = 0; i < full.length; i++) {
      if (full[i].id === t.id) { pi = i; break; }
    }
    if (pi === -1 || !L.hasKids(full, pi)) return t.estMin || 0;
    var pin = lineIndent(full[pi]);
    var sum = 0;
    for (var j = pi + 1; j < full.length; j++) {
      var ij = lineIndent(full[j]);
      if (ij <= pin) break;
      if (full[j].status === 'done') continue;
      if (ij === pin + 1) sum += lineEstMin(full[j]);
    }
    return sum;
  }

  function makeLine(taskId, value, isTrailing, indent, opts) {
    opts = opts || {};
    var div = document.createElement('div');
    div.className = 'tline';
    if (taskId) div.setAttribute('data-id', taskId);
    else div.setAttribute('data-trailing', '1');
    indent = lineIndent({ indent: indent });
    div.setAttribute('data-indent', String(indent));
    div._indent = indent;
    if (indent) div.style.marginLeft = (indent * INDENT_STEP) + 'px';
    if (opts.hidden) div.classList.add('collapsed-kid');
    var body = document.createElement('div');
    body.className = 'tbody';
    div.appendChild(body);
    var grip = makeGrip();
    body.appendChild(grip);
    var inp = document.createElement('textarea');
    inp.className = 'tinput';
    inp.value = value || '';
    inp.rows = 1;
    inp.placeholder = isTrailing ? 'Новая задача…' : '…';
    inp.autocomplete = 'off';
    inp.setAttribute('aria-label', 'Задача');
    if (opts.doneShown) inp.classList.add('is-done');
    body.appendChild(inp);
    autosize(inp);
    if (!isTrailing) {
      var flag = document.createElement('button');
      flag.className = 'doneflag';
      if (opts.doneShown) {
        flag.textContent = '↩ Не выполнено';
        flag.setAttribute('aria-label', 'Вернуть в работу');
      } else {
        flag.textContent = '✓ Выполнено';
        flag.setAttribute('aria-label', 'Отметить выполненной');
      }
      (function (id, fl) {
        /* Тап срабатывает и по click, и по pointerup: если браузер съел
         * одно событие — дойдёт второе. Двойное выполнение отсекает guard
         * внутри toggleDoneSlide. Тап со сдвигом (скролл) игнорируется. */
        var flagDownX = 0, flagDownY = 0, flagDown = false;
        fl.addEventListener('pointerdown', function (ev) {
          flagDownX = ev.clientX;
          flagDownY = ev.clientY;
          flagDown = true;
        });
        fl.addEventListener('pointerup', function (ev) {
          if (!flagDown) return;
          flagDown = false;
          if (Math.abs(ev.clientX - flagDownX) > 12 || Math.abs(ev.clientY - flagDownY) > 12) return;
          toggleDoneSlide(id);
        });
        fl.addEventListener('pointercancel', function () { flagDown = false; });
        fl.addEventListener('click', function () { toggleDoneSlide(id); });
      })(taskId, flag);
      div.appendChild(flag);
      wireLineSwipe(div, taskId);
    } else {
      /* Черновик — та же кнопка, что у остальных строк: свайп открывает
       * флаг «✓ Выполнено». Тап по флагу: есть текст — создать и сразу
       * выполнить (поле очищается), пусто — убрать поле вниз. */
      var dflag = document.createElement('button');
      dflag.className = 'doneflag';
      dflag.textContent = '✓ Выполнено';
      dflag.setAttribute('aria-label', 'Отметить выполненной');
      (function (fl) {
        var fDownX = 0, fDownY = 0, fDown = false;
        fl.addEventListener('pointerdown', function (ev) {
          fDownX = ev.clientX;
          fDownY = ev.clientY;
          fDown = true;
        });
        function draftGo(ev) {
          if (!fDown) return;
          fDown = false;
          if (ev && (Math.abs(ev.clientX - fDownX) > 12 || Math.abs(ev.clientY - fDownY) > 12)) return;
          tapDraftFlag();
        }
        fl.addEventListener('pointerup', draftGo);
        fl.addEventListener('pointercancel', function () { fDown = false; });
        fl.addEventListener('click', function () { tapDraftFlag(); });
      })(dflag);
      div.appendChild(dflag);
      wireLineSwipe(div, null);
    }
    /* Метка времени — НАЛОЖЕНИЕ в правом нижнем углу поля задачи
     * (position: absolute против .tline): тап — та же модалка, что свайп
     * вправо. Фон прозрачный, пока текст не доходит до метки (см.
     * updateDurchip — при пересчёте становится непрозрачным). Пустое
     * время (estMin=0) — метки нет, угол поля свободен. */
    if (!isTrailing && taskId && opts.estMin > 0) {
      var chip = document.createElement('button');
      chip.className = 'durchip';
      chip.type = 'button';
      chip.textContent = L.fmtDur(opts.estMin);
      chip.setAttribute('aria-label', 'Время задачи: ' + L.fmtDur(opts.estMin));
      (function (id, c) {
        c.addEventListener('click', function (ev) {
          ev.stopPropagation();
          openDuration(id);
        });
      })(taskId, chip);
      body.appendChild(chip);
    }
    wireLineInput(div, inp, taskId, isTrailing, indent);
    wireLineDrag(div, grip, inp);
    return div;
  }

  /* Многострочность: поле растёт за текстом, переносы сохраняются в задачу. */
  function autosize(ta) {
    if (!ta || !ta.style) return;
    ta.style.height = 'auto';
    try { ta.style.height = ta.scrollHeight + 'px'; } catch (x) {}
  }

  /* Фон метки времени: прозрачный, пока текст поля под ней не мешает;
   * если последняя строка текста доезжает до метки — непрозрачный (цвета
   * поля), иначе два текста слипаются. Замер зеркалом поля (как в
   * getCaretCoordinates): браузер сам переносит строки, берём X конца
   * текста и сравниваем с левым краем метки. */
  function updateDurchip(inp, chip) {
    if (!inp || !chip || !chip.style) return;
    chip.style.backgroundColor = 'transparent';
    var text = inp.value || '';
    if (!text) return;
    var m = document.createElement('div');
    try {
      var ir = inp.getBoundingClientRect();
      var cr = chip.getBoundingClientRect();
      /* Нет вёрстки (jsdom, скрытая строка) — остаёмся прозрачными. */
      if (!ir.width || !cr.width) return;
      var cs = window.getComputedStyle(inp);
      var props = ['font-family', 'font-size', 'font-weight', 'font-style',
        'line-height', 'letter-spacing', 'word-spacing', 'text-indent',
        'text-align', 'text-transform', 'white-space', 'word-break',
        'overflow-wrap', 'direction', 'padding-top', 'padding-right',
        'padding-bottom', 'padding-left', 'box-sizing'];
      m.style.position = 'absolute';
      m.style.left = (ir.left + (window.pageXOffset || 0)) + 'px';
      m.style.top = (ir.top + (window.pageYOffset || 0)) + 'px';
      m.style.width = ir.width + 'px';
      m.style.visibility = 'hidden';
      m.style.pointerEvents = 'none';
      for (var i = 0; i < props.length; i++) {
        var v = cs.getPropertyValue(props[i]);
        if (v) m.style.setProperty(props[i], v);
      }
      m.appendChild(document.createTextNode(text));
      /* Пустой маркер после текста: его X = позиция конца последней строки. */
      var marker = document.createElement('span');
      m.appendChild(marker);
      document.body.appendChild(m);
      var mr = marker.getBoundingClientRect();
      if (mr.left >= cr.left - 2) {
        var bg = cs.getPropertyValue('background-color') || '';
        chip.style.backgroundColor =
          (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') ? bg : '#fff';
      }
    } catch (x) {} finally {
      if (m.parentNode) m.parentNode.removeChild(m);
    }
  }

  /* Пересчитать метки внутри списка: после рендера, набора и ресайза. */
  function refreshDurchips(box) {
    if (!box || !box.querySelectorAll) return;
    var chips = box.querySelectorAll('.durchip');
    for (var c = 0; c < chips.length; c++) {
      var rw = chips[c].closest ? chips[c].closest('.tline') : null;
      updateDurchip(rw && rw.querySelector('.tinput'), chips[c]);
    }
  }

  /* Свайп строки справа налево: открыть флаг «Выполнено»; слева направо
   * (вправо): модалка времени задачи — НО не если в этом жесте задет
   * раскрытый флаг (тогда возврат вправо только закрывает флаг, swHadFlag).
   * Тап по открытой строке (без сдвига) — закрыть флаг обратно. */
  function wireLineSwipe(div, taskId) {
    var swPid = null, swX0 = 0, swY0 = 0;
    var tapX0 = 0, tapY0 = 0;
    /* Флаг «✓» был открыт на старте жеста или раскрыт этим же жестом:
     * возврат пальца вправо — закрытие флага, не открытие времени. */
    var swHadFlag = false;
    /* Состояние — на элементе, а не в closure: свайп делят обработчики
     * строки и старта drag'а, рассинхрон даёт залипший флаг. */
    div._swOpen = false;
    div._swRArm = false;
    div.addEventListener('pointerdown', function (e) {
      tapX0 = e.clientX;
      tapY0 = e.clientY;
      if (e.target && e.target.closest && e.target.closest('.grip')) return;
      if (e.button != null && e.button !== 0) return;
      swPid = e.pointerId;
      swX0 = e.clientX;
      swY0 = e.clientY;
      swHadFlag = div._swOpen;
    });
    div.addEventListener('pointermove', function (e) {
      if (e.pointerId !== swPid) return;
      var dx = e.clientX - swX0;
      var dy = e.clientY - swY0;
      if (!div._swOpen && !div._swRArm && dx < -48 && Math.abs(dx) > Math.abs(dy) * 2) {
        div.classList.add('swiped');
        div._swOpen = true;
        swHadFlag = true;
        /* Свайп — чужое действие: фокус снимаем сразу (на старых
         * устройствах blur сам не приходит — с клавиатурой уезжают
         * в свайп). Пока жест идёт, render подавлен (dragActive) —
         * узлы строки не пересоздаются. Тап по строке при этом не
         * должен сработать как blur-создание черновика (draftTapBusy,
         * как у флага): текст поля остаётся на месте. */
        dragActive = true;
        draftTapBusy = true;
        setTimeout(function () { draftTapBusy = false; }, 400);
        /* Захват указателя: pointerup доедет до строки даже при
         * отпускании мимо — иначе dragActive залипнет и render
         * подавится навсегда. */
        try { div.setPointerCapture(e.pointerId); } catch (x) {}
        var aeS = document.activeElement;
        if (aeS && aeS.blur && (aeS.tagName === 'TEXTAREA' || aeS.tagName === 'INPUT')) {
          try { aeS.blur(); } catch (x) {}
        }
      } else if (div._swOpen && dx > -16) {
        div.classList.remove('swiped');
        div._swOpen = false;
      } else if (!div._swOpen && !div._swRArm && !swHadFlag && dx > 48 &&
                 Math.abs(dx) > Math.abs(dy) * 2 && taskId) {
        /* Свайп вправо: флагирует открытие модалки времени на pointerup
         * (модалка посреди жеста мешала бы пальцу). swHadFlag — если флаг
         * открыт/раскрыт в этом жесте, возврат вправо его только закрывает.
         * Те же подстраховки, что у левого свайпа: blur, render подавлен,
         * захват указателя. */
        div._swRArm = true;
        dragActive = true;
        try { div.setPointerCapture(e.pointerId); } catch (x) {}
        var aeR = document.activeElement;
        if (aeR && aeR.blur && (aeR.tagName === 'TEXTAREA' || aeR.tagName === 'INPUT')) {
          try { aeR.blur(); } catch (x) {}
        }
      } else if (div._swRArm && dx < 16) {
        /* Палец вернулся к старту — жест отменён, модалка не откроется. */
        div._swRArm = false;
      }
    });
    div.addEventListener('pointerup', function (e) {
      var openR = false;
      if (!(e && e.pointerId != null && e.pointerId !== swPid)) {
        openR = div._swRArm;
        swPid = null;
        dragActive = false;
      }
      if (openR) {
        div._swRArm = false;
        /* Клик, который браузер дошлёт следом за жестом (в т.ч. по
         * метке в углу — отпускание часто попадает именно в неё),
         * не должен вернуть фокус в поле или открыть вторую модалку. */
        div._swBlockUntil = Date.now() + 400;
        openDuration(taskId);
      }
      /* Тап по самому флагу сюда не входит: у него свой обработчик. */
      if (e.target && e.target.closest && e.target.closest('.doneflag')) return;
      if (div._swOpen && Math.abs(e.clientX - tapX0) < 12 && Math.abs(e.clientY - tapY0) < 12) {
        div.classList.remove('swiped');
        div._swOpen = false;
      }
    });
    div.addEventListener('pointercancel', function (e) {
      if (e && e.pointerId != null && e.pointerId !== swPid) return;
      swPid = null;
      dragActive = false;
      div._swRArm = false;
    });
    div.addEventListener('click', function (e) {
      if (div._swBlockUntil && Date.now() < div._swBlockUntil) {
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);
  }

  /* Поле-черновик с текстом, чей якорь — внутри завершаемой ветки:
   * до-создаём задачу на её месте, иначе набранное не улетает
   * в выполненные вместе с веткой, а поле свисает внизу живого списка.
   * Отступ — свой; если вдруг не глубже родителя ветки, принудительно
   * делаем дочерним — иначе completeBranch оборвётся на такой строке
   * и ветка не завершится целиком. */
  function commitTrailingIntoBranch(rootId) {
    var text = String(trailingText || '').trim();
    if (!text) return;
    var anchor = trailingAnchorId();
    var lt = lineTasks();
    var rootIdx = -1;
    for (var i = 0; i < lt.length; i++) {
      if (lt[i] && lt[i].id === rootId) { rootIdx = i; break; }
    }
    if (rootIdx === -1) return;
    var base = lineIndent(lt[rootIdx]);
    var inside = false;
    if (anchor && anchor === rootId) inside = true;
    else if (anchor) {
      for (var j = rootIdx + 1; j < lt.length; j++) {
        if (lineIndent(lt[j]) <= base) break;
        if (lt[j].id === anchor) { inside = true; break; }
      }
    }
    if (!inside) return;
    var fi = effTrailingIndent();
    if (fi <= base) fi = base >= 8 ? 8 : base + 1;
    var created = placeTaskAfter(anchor, text, fi);
    if (!created) return;
    trailingText = '';
    trailingAfterId = null;
    trailingIndent = null;
  }

  /* Выполнить с анимацией: строка возвращается на место уже зачёркнутой,
   * затем спускается в секцию выполненных под полем ввода. */
  /* Выполнить/вернуть с анимацией: строка возвращается на место уже
   * зачёркнутой (или расчеркнутой), затем переезжает в свою секцию —
   * выполненные под поле ввода, вернувшаяся — на своё место в списке
   * (createdAt не трогаем, persist чужие метки не переписывает). */
  function toggleDoneSlide(taskId) {
    var task = L.getTask(state.tasks, taskId);
    if (!task || task.deleted) return;
    /* Фокус с любой строки/поля снимаем сразу (свайп уже снял — тут
     * no-op): отметка выполненной — чужое действие, клавиатура не должна
     * пережить её ни в задаче, ни в поле-черновике. */
    var aeF = document.activeElement;
    if (aeF && aeF.blur && (aeF.tagName === 'TEXTAREA' || aeF.tagName === 'INPUT')) {
      try { aeF.blur(); } catch (x) {}
    }
    var toDone = task.status !== 'done';
    /* Набранное в поле внутри ветки: создаём задачу ДО completeBranch —
     * иначе поле не улетает в выполненные вместе с родителем. */
    if (toDone) commitTrailingIntoBranch(taskId);
    var box = el('lines');
    var row = null;
    if (box && box.querySelectorAll) {
      var rows = box.querySelectorAll('.tline[data-id]');
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].getAttribute('data-id') === taskId) { row = rows[i]; break; }
      }
    }
    if (!row || (row.classList && row.classList.contains('sliding-done'))) {
      if (!row) {
        dragActive = false;
        mutate(function () { toggleDoneNow(taskId, toDone); });
      }
      return;
    }
    row.classList.add('sliding-done');
    var inp = row.querySelector ? row.querySelector('.tinput') : null;
    if (inp) {
      if (toDone) inp.classList.add('is-done');
      else inp.classList.remove('is-done');
    }
    row.classList.remove('swiped');
    row._swOpen = false;
    setTimeout(function () {
      dragActive = false;
      mutate(function () { toggleDoneNow(taskId, toDone); });
      /* Курсор не должен остаться в поле: фокус могла увести кнопка. */
      try {
        var ae = document.activeElement;
        if (ae && ae.tagName === 'BUTTON' && ae.blur) ae.blur();
      } catch (x) {}
    }, 260);
  }

  /* Есть ли у задачи живой структурный родитель: идём вверх по порядку
   * createdAt через всех предков с меньшим отступом (как isDoneShown) —
   * все должны быть живыми (не done). Пустые/удалённые — не в счёт. */
  function hasLiveParent(t) {
    if (!t || !state) return false;
    var base = lineIndent(t);
    if (base === 0) return true;
    var ord = state.tasks.slice().sort(function (a, b) {
      var ca = (a && a.createdAt) || 0, cb = (b && b.createdAt) || 0;
      if (ca !== cb) return ca - cb;
      var ia = a && a.id, ib = b && b.id;
      return ia < ib ? -1 : (ia > ib ? 1 : 0);
    });
    var idx = -1;
    for (var i = 0; i < ord.length; i++) {
      if (ord[i] && ord[i].id === t.id) { idx = i; break; }
    }
    if (idx === -1) return false;
    var cur = base;
    for (var j = idx - 1; j >= 0; j--) {
      var u = ord[j];
      if (!u || u.deleted || !String(u.title || '').trim()) continue;
      if (lineIndent(u) < cur) {
        if (u.status === 'done') return false;
        cur = lineIndent(u);
        if (cur === 0) return true;
      }
    }
    return cur === 0;
  }

  function toggleDoneNow(taskId, toDone) {
    if (toDone) {
      L.completeBranch(lineTasks(), taskId, Date.now());
      return L.getTask(state.tasks, taskId);
    }
    /* Возврат — всей веткой: дети возвращаются к родителю в невыполненные. */
    var ids = L.reopenBranch(state.tasks, taskId, Date.now());
    var t = L.getTask(state.tasks, taskId);
    /* Вернувшаяся ветка без живого родителя: уводим всю ветку в 0
     * с сохранением относительных отступов — иначе висят чужой
     * отступ и чужое зачёркивание от done-группы. */
    if (t && ids.length && lineIndent(t) !== 0 && !hasLiveParent(t)) {
      var delta = lineIndent(t);
      L.setIndent(state.tasks, taskId, 0);
      for (var i = 0; i < ids.length; i++) {
        if (ids[i] === taskId) continue;
        var c = L.getTask(state.tasks, ids[i]);
        if (c) L.setIndent(state.tasks, c.id, lineIndent(c) - delta);
      }
    }
    return t;
  }

  /* Создать задачу сразу под prevId (той же цепочкой Enter вниз).
   * createdAt втискиваем между соседями целым числом; тесно — сдвигаем
   * всех выше на 1 (редко, ms-метки почти всегда с зазором). */
  function insertTaskAfter(prevId, title, indent, now, allowEmpty) {
    var alive = lineTasks();
    var idx = -1;
    for (var i = 0; i < alive.length; i++) {
      if (alive[i].id === prevId) { idx = i; break; }
    }
    var copts = { indent: indent || 0, allowEmpty: !!allowEmpty };
    if (idx === -1) return L.createTask(state.tasks, title, now, copts);
    var prev = alive[idx];
    var next = alive[idx + 1] || null;
    var slot;
    if (!next || next.createdAt - prev.createdAt > 1) {
      slot = next ? prev.createdAt + Math.floor((next.createdAt - prev.createdAt) / 2) : now;
    } else {
      for (var j = 0; j < alive.length; j++) {
        if (alive[j].createdAt > prev.createdAt) {
          alive[j].createdAt += 1;
          alive[j].ts = now;
          alive[j].updatedAt = now;
        }
      }
      slot = prev.createdAt + 1;
    }
    var created = L.createTask(state.tasks, title, now, copts);
    if (created) {
      created.createdAt = slot;
      created.ts = now;
      created.updatedAt = now;
    }
    return created;
  }

  function insertTaskTop(title, now, allowEmpty) {
    var alive = lineTasks();
    var slot = now;
    if (alive.length) {
      slot = alive[0].createdAt;
      for (var j = 0; j < alive.length; j++) {
        if (alive[j].createdAt >= slot) {
          alive[j].createdAt += 1;
          alive[j].ts = now;
          alive[j].updatedAt = now;
        }
      }
    }
    /* Первая строка всегда без отступа (правило потолка). */
    var created = L.createTask(state.tasks, title, now, { indent: 0, allowEmpty: !!allowEmpty });
    if (created) {
      created.createdAt = slot;
      created.ts = now;
      created.updatedAt = now;
    }
    return created;
  }

  function placeTaskAfter(prevId, title, indent, allowEmpty) {
    var title0 = String(title == null ? '' : title).trim();
    if (!title0 && !allowEmpty) return null;
    var now = Date.now();
    var created = null;
    mutate(function () {
      created = insertTaskAfter(prevId, title0, indent, now, allowEmpty);
    });
    return created;
  }

  function placeTaskTop(title, allowEmpty) {
    var title0 = String(title == null ? '' : title).trim();
    if (!title0 && !allowEmpty) return null;
    var now = Date.now();
    var created = null;
    mutate(function () {
      created = insertTaskTop(title0, now, allowEmpty);
    });
    return created;
  }

  /* Эффективный отступ черновика: ручной сдвиг, иначе 0.
   * Отступ строки сверху НЕ наследуем: новое поле всегда начинается
   * без отступа, в группу входит только сдвигом за grip. */
  function effTrailingIndent() {
    if (trailingIndent != null) return lineIndent({ indent: trailingIndent });
    return 0;
  }

  /* Тап по флагу черновика: есть текст — создать и сразу выполнить,
   * пусто — убрать поле вниз. Одна запись в истории. Поле очищается
   * ДО мутации, иначе render внутри mutate покажет старый текст рядом
   * с улетевшей в выполненные копией (дубль при одной задаче). */
  function tapDraftFlag() {
    if (draftTapBusy) return;
    var title = String(trailingText || '').trim();
    if (!title) { dismissDraft(); return; }
    draftTapBusy = true;
    var atTop = trailingAfterId === 'TOP';
    var anchor = atTop ? null : trailingAnchorId();
    var ind = effTrailingIndent();
    trailingAfterId = null;
    trailingText = '';
    trailingIndent = null;
    mutate(function () {
      var now = Date.now();
      var created = atTop ?
        insertTaskTop(title, now) :
        insertTaskAfter(anchor, title, ind, now);
      if (created) L.completeTask(state.tasks, created.id, now);
    });
    render();
    focusTrailing();
    setTimeout(function () { draftTapBusy = false; }, 400);
  }

  function trailingAnchorId() {
    if (!trailingAfterId) return null;
    var t = L.getTask(state.tasks, trailingAfterId);
    if (!t || t.deleted || t.status === 'done') return null;
    return trailingAfterId;
  }

  /* Убрать поле-черновик с текущего места: текст стёрт, поле — вниз. */
  function dismissDraft() {
    trailingAfterId = null;
    trailingText = '';
    trailingIndent = null;
    render();
    focusTrailing();
  }

  /* Потеря фокуса поля с текстом = создание задачи, но поле-продолжение
   * НЕ оставляем: новое пустое поле вызывается Enter в любой строке
   * (фокус не воруем — клавиатуру закрыли неслучайно). Тап по флагу/грипу
   * своей строки — их жест (создание+выполнение, drag) сам разберётся;
   * тап по другой строке — задача создаётся и фокус возвращается в неё
   * (render пересоздаёт строки, старый узел мёртв). История — одна точка
   * (само создание, её пишет mutate): отмена снимает задачу и возвращает
   * текст в поле. */
  function createDraftOnBlur(inp, indent) {
    if (draftTapBusy) return;
    if (!inp || !document.contains(inp)) return;
    var title = String(trailingText || '').trim();
    var fresh = (Date.now() - lastPDts) < 700;
    /* Пустое поле фиксируем ТОЛЬКО по настоящему тапу мимо (свежий
     * pointerdown): программный blur (снятие фокуса при отметке
     * выполненной, клавиатура ушла) не должен плодить пустые задачи. */
    if (!title && !fresh) return;
    var focusId = null;
    if (fresh && lastPDTarget && lastPDTarget.closest) {
      if (lastPDTarget.closest('.grip') || lastPDTarget.closest('.doneflag')) return;
      var row = lastPDTarget.closest('.tline');
      if (row) {
        if (row.getAttribute('data-trailing')) return;
        if (!lastPDTarget.closest('.tinput')) return;
        focusId = row.getAttribute('data-id');
      }
    } else {
      var ae = document.activeElement;
      if (ae && ae.classList && ae.classList.contains('tinput') && ae.closest) {
        var arow = ae.closest('.tline');
        if (arow && arow.getAttribute('data-trailing')) return;
        if (arow && arow.getAttribute('data-id')) focusId = arow.getAttribute('data-id');
      }
    }
    var created = (trailingAfterId === 'TOP') ?
      placeTaskTop(title, true) :
      placeTaskAfter(trailingAnchorId(), title, indent, true);
    if (!created) return;
    /* Поле гасим ДО следующего render (mutate уже отрендерил с текстом
     * рядом с новой задачей — дубль живёт один кадр, как у Enter). */
    trailingText = '';
    trailingAfterId = null;
    trailingIndent = null;
    render();
    if (focusId) focusTaskEnd(focusId);
  }

  /* Backspace в начале набранного черновика: как потеря фокуса — задача
   * создаётся (текст не теряется), потом курсор уезжает в конец задачи
   * сверху. Если поле стоит под TOP — сверху некуда, фокус остаётся на
   * только что созданной (она и есть верхняя). Одна точка истории. */
  function backspaceCreateDraft() {
    var title = String(trailingText || '').trim();
    if (!title) { dismissDraft(); return; }
    var atTop = trailingAfterId === 'TOP';
    var anchor = atTop ? null : trailingAnchorId();
    var created = atTop ?
      placeTaskTop(title) :
      placeTaskAfter(anchor, title, effTrailingIndent());
    if (!created) return;
    /* Поле гасим ДО следующего render (дубль — один кадр, как у blur). */
    trailingText = '';
    trailingAfterId = null;
    trailingIndent = null;
    render();
    focusTaskEnd(anchor || created.id);
  }

  /* Backspace в начале строки задачи: сцепка с предыдущей живой — её
   * текст пополняется текущим, текущая удаляется (дети остаются на
   * месте: отступ не трогаем, вложением их держит сцепленная строка).
   * Одна точка истории: отмена возвращает и разъединение, и строку.
   * Поле-черновик, стоявшее под удаляемой строкой, якорится на
   * сцепленную — висеть на мёртвом якоре не должно. */
  function mergeTaskIntoPrev(taskId, liveVal) {
    var lt = lineTasks();
    var idx = -1;
    for (var i = 0; i < lt.length; i++) {
      if (lt[i] && lt[i].id === taskId) { idx = i; break; }
    }
    if (idx <= 0) return;
    var prev = lt[idx - 1];
    var cur = lt[idx];
    /* Живое значение строки (null → из state): нажатие могло прийти
     * раньше, чем отложенное сохранение последнего ввода (800 мс). */
    var live = liveVal == null ? String(cur.title || '') : String(liveVal);
    if (!live.trim()) {
      /* Текст строки удалён полностью: в склейку старый заголовок из
       * state НЕ тащим — строку просто удаляем, курсор — в конец
       * предыдущей. Отложенное сохранение удаляемой — no-op. */
      mutate(function () {
        L.removeTask(state.tasks, cur.id);
        if (trailingAfterId === cur.id) trailingAfterId = prev.id;
      });
      focusTaskEnd(prev.id);
      return;
    }
    var curText = live.trim();
    var prevLen = String(prev.title || '').length;
    var joined = (String(prev.title || '') + ' ' + curText).trim();
    mutate(function () {
      L.clarifyTask(state.tasks, prev.id, { title: joined });
      L.removeTask(state.tasks, cur.id);
      if (trailingAfterId === cur.id) trailingAfterId = prev.id;
    });
    /* Курсор — на стык: конец текста верхней, пробел, дальше перенесённый.
     * Длину верхней запоминаем ДО mutate (после — там уже склейка). */
    focusTaskEnd(prev.id, prevLen + 1);
  }

  function commitLine(taskId, value, isTrailing, indent) {
    var title = String(value == null ? '' : value).trim();
    if (isTrailing || !taskId) {
      if (!title) return null;
      var created = null;
      /* Отступ берём из поля черновика (по умолчанию 0, правит сдвиг). */
      mutate(function () { created = L.createTask(state.tasks, title, Date.now(), { indent: indent || 0 }); });
      return created;
    }
    var task = L.getTask(state.tasks, taskId);
    if (!task) return null;
    if (!title) {
      /* Пустой текст — задача остаётся пустой (полноценная строка),
       * а не удаляется: удаление — явный жест (Backspace в пустой). */
      if (String(task.title || '') !== '') {
        mutate(function () { L.clarifyTask(state.tasks, taskId, { title: '' }); });
      }
      return task;
    }
    if (title !== task.title) {
      mutate(function () { L.clarifyTask(state.tasks, taskId, { title: title }); });
    }
    return task;
  }

  function wireLineInput(div, inp, taskId, isTrailing, indent) {
    var saveTimer = null;
    /* Строка расщеплена (Enter-сплит) или склеена/удалена (Backspace-merge):
     * render() сносит этот input, а Chrome шлёт с него поздний change со
     * СТАРЫМ значением — commitLine вернул бы в задачу уже перенесённый
     * хвост (правка пробела выставляет dirty-флаг, без правки change нет). */
    var inputClosed = false;
    inp.addEventListener('input', function () {
      if (inputClosed) return;
      autosize(inp);
      var chipN = div.querySelector ? div.querySelector('.durchip') : null;
      if (chipN) updateDurchip(inp, chipN);
      if (isTrailing) { trailingText = inp.value; return; }
      if (!taskId) return;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        var title = inp.value.trim();
        if (!title || title === (L.getTask(state.tasks, taskId) || {}).title) return;
        L.clarifyTask(state.tasks, taskId, { title: title });
        save();
        renderStatus();
      }, 800);
    });
    inp.addEventListener('change', function () {
      if (inputClosed) return;
      if (isTrailing || !taskId) return;
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      var r = commitLine(taskId, inp.value, false);
      if (r === 'removed') { if (!dragActive) render(); }
      else renderStatus();
    });
    if (isTrailing) {
      /* Потеря фокуса = создание задачи: с набранной текстом — задача,
       * с пустым полем — пустая задача (v70). Отложенный запуск:
       * focus нового элемента и lastPD должны успеть устаканиться. */
      inp.addEventListener('blur', function () {
        if (draftBlurTimer) clearTimeout(draftBlurTimer);
        draftBlurTimer = setTimeout(function () {
          draftBlurTimer = null;
          createDraftOnBlur(inp, indent);
        }, 0);
      });
    }
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Backspace' && isTrailing) {
        if (!inp.value) {
          dismissDraft();
          e.preventDefault();
          return;
        }
        /* Курсор в начале набранного: backspace работает как потеря
         * фокуса — задача создаётся (текст не теряется), а курсор
         * переезжает в конец задачи сверху. Середка текста — обычная
         * правка, браузер удаляет символ сам. */
        if (inp.selectionStart === 0 && inp.selectionEnd === 0) {
          e.preventDefault();
          backspaceCreateDraft();
        }
        return;
      }
      if (e.key === 'Backspace' && !isTrailing && taskId &&
          inp.selectionStart === 0 && inp.selectionEnd === 0) {
        /* Курсор в начале строки: backspace сцепляет её с предыдущей
         * живой — текст приклеивается вверх, текущая строка удаляется. */
        e.preventDefault();
        inputClosed = true;
        mergeTaskIntoPrev(taskId, inp.value);
        return;
      }
      if (e.key !== 'Enter' || e.shiftKey) return;
      e.preventDefault();
      if (isTrailing) {
        var oldAnchor = trailingAfterId;
        var oldIndent = trailingIndent;
        var created = (trailingAfterId === 'TOP') ?
          placeTaskTop(inp.value, true) :
          placeTaskAfter(trailingAnchorId(), inp.value, indent, true);
        if (created) {
          /* Вторая точка в истории: появление нового пустого поля —
           * отменяется отдельно (задача с текстом остаётся). */
          pushUndo({
            tasks: snapTasks(),
            afterId: oldAnchor,
            text: '',
            indent: oldIndent,
            focusId: created.id
          });
          trailingText = '';
          /* Продолжаем на том же уровне: следующее поле — с отступом
           * только что созданной (дети набираются подряд). */
          trailingIndent = lineIndent(created);
          trailingAfterId = created.id;
          render();
          updateHistoryButtons();
          focusTrailing();
        }
        return;
      }
      /* Набранный, но не созданный черновик висит где-то с текстом (фокус
       * уже ушёл — blur-создание на grip/флажке не сработало): Enter в
       * строке сначала ДОВОДИТ его до конца — задача встаёт на своём
       * месте, — иначе поле просто переезжает сюда и старая «седьмая»
       * улетает вниз. Потом под строкой вызывается свежее пустое поле. */
      var lingering = String(trailingText || '').trim();
      if (lingering) {
        if (trailingAfterId === 'TOP') placeTaskTop(lingering);
        else placeTaskAfter(trailingAnchorId(), lingering, effTrailingIndent());
        trailingText = '';
        trailingAfterId = null;
        trailingIndent = null;
      }
      /* Enter в середине текста: левая часть остаётся задачей, хвост
       * (от каретки до конца) уходит в новую задачу ниже — как в
       * редакторе. Отступ — по правилу поля под строкой: у родителя
       * хвост встаёт на уровень первой дочерней, чтобы не сорвать
       * вложенность. Одна точка истории, курсор — в начало хвоста
       * (набор продолжается перед ним). Поле-продолжение, стоявшее
       * под строкой, переякоривается на хвост. */
      var splitPos = inp.selectionStart;
      var splitVal = String(inp.value == null ? '' : inp.value);
      var splitCur = L.getTask(state.tasks, taskId);
      if (splitPos > 0 && splitPos < splitVal.length &&
          splitVal.slice(0, splitPos).trim() && splitVal.slice(splitPos).trim() &&
          splitCur && splitCur.status !== 'done') {
        /* Отложенное сохранение последнего ввода (saveTimer, 800 мс)
         * позже вернуло бы в задачу уже перенесённый хвост — гасим,
         * как и поздний change с этого же input (см. inputClosed);
         * обе части сплита берутся из inp.value, терять нечего. */
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        inputClosed = true;
        var splitLeft = splitVal.slice(0, splitPos).trim();
        var splitTail = splitVal.slice(splitPos).trim();
        var spIndent = lineIndent(splitCur);
        var ltSp = lineTasks();
        for (var si = 0; si < ltSp.length; si++) {
          if (!ltSp[si] || ltSp[si].id !== taskId) continue;
          var nxSp = ltSp[si + 1];
          if (nxSp && lineIndent(nxSp) > spIndent) spIndent = lineIndent(nxSp);
          break;
        }
        var madeSplit = null;
        mutate(function () {
          L.clarifyTask(state.tasks, taskId, { title: splitLeft });
          madeSplit = insertTaskAfter(taskId, splitTail, spIndent, Date.now());
          if (madeSplit && trailingAfterId === taskId) trailingAfterId = madeSplit.id;
        });
        if (madeSplit) focusLineStart(madeSplit.id);
        return;
      }
      commitLine(taskId, inp.value, false);
      /* Позиция поля: каретка в начале текста — НАД текущей строкой на
       * её же отступе (вставка сверху, якорь — строка перед ней или
       * TOP); иначе — под строкой: у родителя (за ним первая дочерняя)
       * сразу на её отступе, у листа — свой уровень. Вызов поля —
       * отдельная точка в истории, иначе ↩ откатит чужое давнее
       * действие (вплоть до воскрешения удалённого в выполненных). */
      var moved = L.getTask(state.tasks, taskId);
      if (moved && moved.status !== 'done') {
        /* Пустое поле у пустой задачи: каретка и так в «начале» — это не
         * «вставка сверху», а следующее поле ПОД строкой (иначе вторая
         * пустая прыгает выше первой). Вставка сверху — только при
         * каретке в начале НАБРАННОГО текста. */
        var atStart = inp.selectionStart === 0 && inp.selectionEnd === 0 &&
          !!String(inp.value || '').trim();
        var newIndent = lineIndent(moved);
        var newAnchor = taskId;
        var lt = lineTasks();
        for (var li = 0; li < lt.length; li++) {
          if (lt[li].id !== taskId) continue;
          if (atStart) {
            newAnchor = li > 0 ? lt[li - 1].id : 'TOP';
          } else {
            var nx = lt[li + 1];
            if (nx && lineIndent(nx) > newIndent) newIndent = lineIndent(nx);
          }
          break;
        }
        if (trailingAfterId !== newAnchor || effTrailingIndent() !== newIndent) {
          pushUndo({
            tasks: snapTasks(),
            afterId: trailingAfterId,
            text: trailingText,
            indent: trailingIndent,
            focusId: taskId
          });
          updateHistoryButtons();
        }
        trailingAfterId = newAnchor;
        trailingIndent = newIndent;
      }
      render();
      focusTrailing();
    });
  }

  /* Порядок строк после drag: перенумеровываем createdAt ТОЛЬКО уехавшему
   * блоку, втискивая его между соседями (целыми, с запасом). Чужие метки
   * не трогаем — поэтому вернувшаяся из выполненных встаёт на своё место,
   * а синк не дёргается лишний раз. Тесно (зазор исчерпан) — перенумеровать
   * всех живых. Выполненные и tombstone не трогаем никогда. */
  /* beforeOverride — слепок ДО мутации отступа (applyDropIndent): финиш
   * вызывает persist уже после неё, и свежий snapFull() нёс бы новый отступ —
   * отмена возвращала бы порядок, но не отступ. */
  function persistLineOrder(beforeOverride) {
    var box = el('lines');
    if (!box || !state) return;
    var domAlive = [];
    var rows = box.querySelectorAll ? box.querySelectorAll('.tline[data-id]') : [];
    for (var i = 0; i < rows.length; i++) {
      var id = rows[i].getAttribute('data-id');
      var t = id ? L.getTask(state.tasks, id) : null;
      if (t && !t.deleted && t.status !== 'done') domAlive.push(id);
    }
    if (!domAlive.length) return false;
    var cur = lineTasks().map(function (t) { return t.id; });
    if (cur.length === domAlive.length) {
      var same = true;
      for (var k = 0; k < domAlive.length; k++) {
        if (domAlive[k] !== cur[k]) { same = false; break; }
      }
      if (same) return false;
    }
    /* Уехавший блок — непрерывный отрезок отличий (drag двигает целиком). */
    var bs = -1, be = -1;
    for (var d = 0; d < domAlive.length && d < cur.length; d++) {
      if (domAlive[d] !== cur[d]) { if (bs === -1) bs = d; be = d; }
    }
    if (bs === -1) return false;
    var before = beforeOverride || snapFull();
    var now = Date.now();
    function at(idx) {
      var tt = L.getTask(state.tasks, domAlive[idx]);
      return tt ? tt.createdAt : 0;
    }
    var m = be - bs + 1;
    var P = bs > 0 ? at(bs - 1) : null;
    var N = be < domAlive.length - 1 ? at(be + 1) : null;
    var vals = null;
    if (P !== null || N !== null) {
      if (P === null) { vals = []; for (var a = 0; a < m; a++) vals.push(N - m + a); }
      else if (N === null) { vals = []; for (var b = 0; b < m; b++) vals.push(P + 1 + b); }
      else if (N - P > m) { vals = []; for (var c = 0; c < m; c++) vals.push(P + 1 + c); }
    }
    if (vals) {
      for (var v = 0; v < m; v++) {
        var bt = L.getTask(state.tasks, domAlive[bs + v]);
        if (!bt) continue;
        bt.createdAt = vals[v];
        bt.ts = now;
        bt.updatedAt = now;
      }
    } else {
      /* Зазор исчерпан: перенумеровать всех живых (выполненных не трогаем). */
      var base = now - domAlive.length;
      domAlive.forEach(function (id, idx) {
        var t2 = L.getTask(state.tasks, id);
        if (!t2) return;
        t2.createdAt = base + idx;
        t2.ts = now;
        t2.updatedAt = now;
      });
    }
    var byId = {};
    state.tasks.forEach(function (t) { if (t) byId[t.id] = t; });
    var ordered = [];
    domAlive.forEach(function (id) { if (byId[id]) { ordered.push(byId[id]); delete byId[id]; } });
    Object.keys(byId).forEach(function (id) { ordered.push(byId[id]); });
    state.tasks = ordered;
    pushUndo(before);
    save();
    updateHistoryButtons();
    return true;
  }

  /* Отступ строки после вертикального перетаскивания: смотрят соседи
   * на новом месте. Нет соседа сверху — уровень родителей (0).
   * Сосед сверху без отступа, а следующий уходит вглубь — встаём первым
   * вложенным (отступ соседа +1). Иначе — отступ соседа сверху.
   * Весь перетащенный блок (родитель + дети) сдвигается на одну дельту. */
  function applyDropIndent(box, sibs, di, kids) {
    function indOf(row) {
      var id = row.getAttribute ? row.getAttribute('data-id') : null;
      var t = id ? L.getTask(state.tasks, id) : null;
      return t ? lineIndent(t) : 0;
    }
    var prevRow = di > 0 ? sibs[di - 1] : null;
    /* Следующий сосед — вне перетащенного блока: свои дети не считаются
     * чужим вложением, иначе родитель втянется под соседа. */
    var nextRow = null;
    for (var ni = di + 1; ni < sibs.length; ni++) {
      if (kids.indexOf(sibs[ni]) === -1) { nextRow = sibs[ni]; break; }
    }
    var prevInd = prevRow ? indOf(prevRow) : 0;
    var nextInd = nextRow ? indOf(nextRow) : -1;
    var want = !prevRow ? 0 : (nextInd === prevInd + 1 ? nextInd : prevInd);
    var myRow = sibs[di];
    var myId = myRow.getAttribute ? myRow.getAttribute('data-id') : null;
    var myT = myId ? L.getTask(state.tasks, myId) : null;
    if (!myT) return;
    var delta = want - lineIndent(myT);
    if (!delta) return;
    L.setIndent(state.tasks, myId, want);
    /* Дети едут вместе с родителем на ту же дельту (setIndent клампит 0..8). */
    for (var i = 0; i < kids.length; i++) {
      var kid = kids[i];
      var kidId = kid.getAttribute ? kid.getAttribute('data-id') : null;
      var kt = kidId ? L.getTask(state.tasks, kidId) : null;
      if (kt) L.setIndent(state.tasks, kidId, lineIndent(kt) + delta);
    }
  }
  /* Отступ строки и детей — по данным задач, В КАДРЕ посадки (сразу после
   * applyDropIndent): style.margin снят при возврате в поток, а render
   * только через 220мс — без этого вёрстка отстала бы от данных и строка
   * (и дети) отсидели бы с отступом 0/старым всю мягкую посадку. */
  function dropMargins(row, kidRows) {
    function indOfDrop(r) {
      var rid = r.getAttribute ? r.getAttribute('data-id') : null;
      if (rid) {
        var rt = L.getTask(state.tasks, rid);
        if (rt) return lineIndent(rt);
      }
      if (r.getAttribute && r.getAttribute('data-trailing')) return effTrailingIndent();
      return 0;
    }
    function setDrop(r) {
      if (!r || !r.style) return;
      var iv = indOfDrop(r);
      r.style.marginLeft = iv ? (iv * INDENT_STEP) + 'px' : '';
    }
    setDrop(row);
    for (var dm = 0; dm < (kidRows || []).length; dm++) setDrop(kidRows[dm]);
  }
  /* Перетаскивание за grip двумя жестами (Pointer Events — мышь и тач):
   * - вверх/вниз: плавный вертикальный drag (призрак + соседи едут);
   * - вправо/влево: сдвиг на ширину отступа — задача входит в группу
   *   задачи сверху (уровень не глубже соседа сверху +1, первая — всегда 0).
   * Направление определяется первым движением: горизонталь (|dx|>|dy|*2). */
  function wireLineDrag(div, grip, inp) {
    var pid = null, grabDy = 0, divH = 0, holeH = 0, holeShift = 0, x0 = 0, y0 = 0;
    /* Автопрокрутка у краёв — по таймеру: стоящий палец pointermove не шлёт,
     * и прокрутка только по движению глохла после пары рывков. */
    var edgeTimer = null, lastY = 0, edgeStart = 0;
    function edgeZone(y) {
      if (y < 110) return -1;
      if (y > (window.innerHeight || 800) - 110) return 1;
      return 0;
    }
    function stopEdge() {
      if (edgeTimer) { try { clearInterval(edgeTimer); } catch (x) {} }
      edgeTimer = null;
    }
    /* Пересчёт дыры по координате пальца: живой верх коробки + замороженные
     * оффсеты. Вынесено отдельно, чтобы тик автопрокрутки двигал дыру вслед
     * за уезжающей из-под неподвижного пальца страницей. */
    function updateHole(clientY) {
      var box = el('lines');
      if (!box || !order) return false;
      var dt = clientY - grabDy;
      div.style.top = dt + 'px';
      var boxTop = 0;
      try { boxTop = box.getBoundingClientRect().top; } catch (x) { boxTop = 0; }
      var advanced = false;
      while (phi < fr.length) {
        if (fr[phi].sep) break;
        if (dt > boxTop + fr[phi].off + PEN) { phi++; setHole(phi); advanced = true; }
        else break;
      }
      while (phi > 0) {
        var pv = fr[phi - 1];
        if (dt < boxTop + pv.off + pv.h - PEN) { phi--; setHole(phi); advanced = true; }
        else break;
      }
      return advanced;
    }
    function edgeTick() {
      if (pid == null || mode !== 'vertical' || !order) { stopEdge(); return; }
      var dir = edgeZone(lastY);
      if (!dir) { stopEdge(); return; }
      /* Плавно и тихо: мелкие шаги 3→5px, но часто (тик 20мс) —
       * как строки под тянущейся (у них transition .18s). Редкие крупные
       * шаги давали дёрганье. */
      var hold = Date.now() - edgeStart;
      var step = 3 + Math.min(2, Math.floor(hold / 600));
      try {
        window.scrollBy(0, dir * step);
        /* Пин — с РЕАЛЬНОГО смещения, а не += шаг: у края scrollBy
         * клампится (страница стоит), а пин убегал бы дальше — потом
         * onPinScroll дёргал страницу обратно и вверх было не уехать. */
        if (pinY != null) pinY = window.pageYOffset;
        lastScrollTs = Date.now();
      } catch (x) {}
      updateHole(lastY);
    }
    var mode = null, lastDx = 0, lastScrollTs = 0, phi = 0;
    var order = null, kids = [], fr = [], frSh = [];
    var indentCur = 0, indentMax = 0;
    /* Поле и задачи на старте жеста: перестановка пишется в историю,
     * отмена возвращает всё на места, а не трогает чужое. */
    var dragUiBefore = null;
    var PEN = 14;
    /* Открыть дыру на позиции np: ряды ниже отходят на высоту блока,
     * ряды выше возвращаются. Трогаем только изменившиеся (иначе дёргание).
     * Transition сглаживает движение дыры, но ПЕРВАЯ дыра открывается
     * мгновенно (instant): строка вынута из потока в том же кадре, и
     * анимированное открытие видно как прыжок строк ниже вверх-вниз. */
    function setHole(np, instant) {
      for (var i = 0; i < fr.length; i++) {
        var want = i >= np ? holeShift : 0;
        if (frSh[i] === want) continue;
        frSh[i] = want;
        fr[i].row.style.transition = instant ? 'none' : 'transform .18s linear';
        fr[i].row.style.transform = want ? 'translateY(' + want + 'px)' : '';
      }
    }
    function rowsOf(box) {
      return Array.prototype.slice.call(box.querySelectorAll('.tline'));
    }
    /* Виден ли ряд в потоке: свёрнутые дети прячутся КЛАССОМ collapsed-kid
     * (index.html), а не инлайн-стилем — проверка только style.display их
     * не видит и считает занимающими место (дыра плывёт вверх по мере
     * движения вниз мимо свёрнутых групп). */
    function rowShown(cr) {
      if (!cr) return false;
      if (cr.style && cr.style.display === 'none') return false;
      if (cr.classList && cr.classList.contains('collapsed-kid')) return false;
      return true;
    }
    function myTask() {
      var id = div.getAttribute ? div.getAttribute('data-id') : null;
      return id ? L.getTask(state.tasks, id) : null;
    }
    /* Потолок отступа: первая строка — 0, иначе отступ соседа сверху +1.
     * Черновик — та же rule: свой текущий уровень и тот же потолок,
     * иначе у нового поля отступ не меняется вообще. */
    function indentBounds() {
      var cur = 0, prev = 0, first = true;
      var box = el('lines');
      if (box) {
        var rows = rowsOf(box);
        for (var i = 0; i < rows.length; i++) {
          if (rows[i] === div) break;
          first = false;
          var id = rows[i].getAttribute ? rows[i].getAttribute('data-id') : null;
          var t = id ? L.getTask(state.tasks, id) : null;
          prev = t ? lineIndent(t) : 0;
        }
      }
      var mine = myTask();
      cur = mine ? lineIndent(mine) : (div._indent || 0);
      var max = first ? 0 : prev + 1;
      if (max > 8) max = 8;
      if (max < 0) max = 0;
      return { cur: cur, max: max };
    }
    function startIndent() {
      var b = indentBounds();
      indentCur = b.cur;
      indentMax = b.max;
      mode = 'indent';
    }
    function startVertical(e) {
      var box = el('lines');
      if (!box) return;
      mode = 'vertical';
      /* Высота контейнера фиксируется: вынутая из потока строка ужмёт
       * документ на кадр, браузер клампнет скролл вверх — и не вернёт.
       * Меряем до любых изменений, снимаем на финише (там высоты те же). */
      try {
        var boxH = box.getBoundingClientRect().height;
        if (boxH > 0) box.style.minHeight = boxH + 'px';
      } catch (x) {}
      /* Снэп хвостов прошлой посадки: замер покоя обязан быть чистым. */
      var _all = rowsOf(box);
      for (var _si = 0; _si < _all.length; _si++) {
        _all[_si].style.transition = '';
        _all[_si].style.transform = '';
      }
      var _sep0 = box.querySelector ? box.querySelector('.done-sep') : null;
      if (_sep0) { _sep0.style.transition = ''; _sep0.style.transform = ''; }
      var rect = null;
      try { rect = div.getBoundingClientRect(); } catch (x) { rect = null; }
      var h = rect ? rect.height : div.offsetHeight || 56;
      if (grabDy == null) grabDy = rect ? (e.clientY - rect.top) : h / 2;
      divH = h;
      order = rowsOf(box);
      /* Дети (вложенные с большим отступом) прячутся под родителя на время drag.
       * Высоту меряем ДО скрытия. */
      holeH = h;
      kids = [];
      /* Видимых детей — для зазоров дыры: уже спрятанные (свёрнутые) места
       * не занимают, их зазоры в holeShift не считаем. Сами скрытые дети
       * в kids[] остаются — финиш возвращает блок в DOM целиком. */
      var mine0 = myTask();
      var visKids = 0;
      if (mine0) {
        var lv0 = lineIndent(mine0);
        var started = false;
        for (var k = 0; k < order.length; k++) {
          if (order[k] === div) { started = true; continue; }
          if (!started) continue;
          var kidId = order[k].getAttribute ? order[k].getAttribute('data-id') : null;
          var kt = kidId ? L.getTask(state.tasks, kidId) : null;
          if (kt && lineIndent(kt) > lv0) {
            if (rowShown(order[k])) visKids++;
            try { holeH += order[k].getBoundingClientRect().height; } catch (x) {}
            kids.push(order[k]);
          } else break;
        }
        for (var kh = 0; kh < kids.length; kh++) kids[kh].style.display = 'none';
      }
      /* Замороженный покой (как в присланном алгоритме): каркас из строк
       * (без тянущейся и спрятанных детей) с оффсетами за один проход.
       * Дыра = блок + съеденные потоком зазоры, чтобы захват не дёргал список. */
      holeShift = holeH + (visKids + 1) * LINES_GAP;
      fr = [];
      frSh = [];
      phi = 0;
      var acc = 0;
      var chn = box.children;
      for (var ci = 0; ci < chn.length; ci++) {
        var cr = chn[ci];
        if (cr === div) { phi = fr.length; continue; }
        if (!cr.classList) continue;
        /* Разделитель «Выполнено» — тоже часть потока: без него в каркасе
         * он не получает сдвиг дыры и во время drag'а уезжает вверх на
         * holeShift (перекрывает пересечённые строки — выглядят как
         * улетевшие в выполненные). */
        var isSep = cr.classList.contains('done-sep');
        if (!isSep && !cr.classList.contains('tline')) continue;
        if (!rowShown(cr)) continue;
        var hr = 0;
        try { hr = cr.getBoundingClientRect().height; } catch (x) { hr = 0; }
        fr.push({ row: cr, off: acc, h: hr, sep: isSep });
        frSh.push(0);
        acc += hr + LINES_GAP;
      }
      /* Сама строка вынимается из потока и едет под пальцем. */
      div.classList.add('dragging');
      div.style.position = 'fixed';
      div.style.width = (rect ? rect.width : div.offsetWidth) + 'px';
      div.style.left = (rect ? rect.left : 0) + 'px';
      div.style.top = (e.clientY - grabDy) + 'px';
      div.style.margin = '0';
      div.style.pointerEvents = 'none';
      div.classList.remove('swiped');
      div._swOpen = false;
      box.classList.add('drag-active');
      /* Дыра сразу на месте строки: захват не схлопывает список.
       * Мгновенно, в том же кадре изъятия строки — иначе строки ниже
       * прыгают вверх и возвращаются анимацией дыры. */
      setHole(phi, true);
    }
    grip.addEventListener('pointerdown', function (e) {
      if (pid != null) return;
      if (e.button != null && e.button !== 0) return;
      /* Выполненные не таскаем: ни в свой раздел, ни тем более в живые.
       * Проверка до взятия pid, иначе мув стартует drag мимо гарда. */
      var mt0 = myTask();
      if (mt0 && mt0.status === 'done') return;
      var box = el('lines');
      if (!box) return;
      pid = e.pointerId;
      x0 = e.clientX;
      y0 = e.clientY;
      /* grabDy меряем ЗДЕСЬ — по позиции захвата. При старте режима палец
       * уже уехал на 14+px (первый pointermove на таче ещё крупнее), и
       * замер там сдвигал dt вниз: дыра не досекала целевой слот, задача
       * садилась строкой ниже (или на своё место — «перетаскивание ничего
       * не делает»). */
      try { grabDy = e.clientY - div.getBoundingClientRect().top; }
      catch (x) { grabDy = null; }
      lastDx = 0;
      lastScrollTs = 0;
      mode = null;
      kids = [];
      dragUiBefore = snapFull();
      try { grip.setPointerCapture(pid); } catch (x) {}
      pinScroll();
      document.addEventListener('pointerup', finish);
      document.addEventListener('pointercancel', finish);
      /* Взялись за grip — фокус НЕ трогаем: blur на захвате закрывал
       * клавиатуру посреди touch — вьюпорт прыгал, содержимое уезжало
       * из-под пальца и жест глох («сдвиг влево ничего не делает»).
       * Клавиатура закрывается в finish. Коммит текста не рендерит
       * (dragActive); blur-создание чужого черновика видит grip в lastPD
       * и пропускает, а черновик СВОЕЙ строки с текстом создаётся задачей
       * ниже. */
      dragActive = true;
      /* Черновик с текстом: захват точек сразу делает из него задачу —
       * поле теряет фокус насовсем (курсор сюда не возвращается), а сам
       * жест идёт уже по настоящей строке: отступ применяется setIndent
       * к задаче, а не уходит в черновик (trailingIndent), который при
       * следующем рендере/blur ведёт себя иначе. Рендер поднят
       * (dragActive) — узлы не пересоздаются, узел жеста помечается
       * data-id, поэтому myTask() и indentBounds() работают сразу. */
      var draftRowG = !!(div.getAttribute && div.getAttribute('data-trailing'));
      var commitTxt = draftRowG ? String(trailingText || '').trim() : '';
      if (commitTxt) {
        var atTopG = trailingAfterId === 'TOP';
        var anchorG = atTopG ? null : trailingAnchorId();
        var indG = effTrailingIndent();
        var madeG = null;
        mutate(function () {
          madeG = atTopG ?
            insertTaskTop(commitTxt, Date.now()) :
            insertTaskAfter(anchorG, commitTxt, indG, Date.now());
        });
        if (madeG) {
          trailingText = '';
          trailingAfterId = null;
          trailingIndent = null;
          div.setAttribute('data-id', madeG.id);
          div.removeAttribute('data-trailing');
        }
      }
      var aeNow = document.activeElement;
      /* Возврат курсор — только когда тащат САМО поле: при жесте на
       * чужой строке (свайп родителя) фокус с набранного снимается
       * насовсем (в finish), иначе клавиатура тут же возвращается. */
      var focusInDraft = !!(aeNow && aeNow.closest && aeNow.closest('.tline[data-trailing]'));
      var dragIsDraft = !!(div.getAttribute && div.getAttribute('data-trailing'));
      refocusDraft = focusInDraft && dragIsDraft;
      if (e.cancelable) e.preventDefault();
    });
    grip.addEventListener('pointermove', function (e) {
      if (pid == null || e.pointerId !== pid) return;
      var dx = e.clientX - x0;
      var dy = e.clientY - y0;
      if (!mode) {
        if (Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy) * 2) {
          /* Черновик сдвигается так же, как остальные строки; запрет —
           * только для выполненных. Раньше черновик отфутболивался здесь
           * и отступ у нового поля не менялся вообще. */
          var _mt = myTask();
          if (!_mt && !(div.getAttribute && div.getAttribute('data-trailing'))) return;
          if (_mt && _mt.status === 'done') return;
          startIndent();
        } else if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx) * 2) {
          startVertical(e);
          if (mode !== 'vertical') return;
        } else return;
      }
      var box = el('lines');
      if (!box) return;
      if (mode === 'indent') {
        lastDx = dx;
        /* Живой предпросмотр: строка едет за пальцем в пределах уровней. */
        var lo = -indentCur * INDENT_STEP;
        var hi = (indentMax - indentCur) * INDENT_STEP;
        var cx = dx < lo ? lo : (dx > hi ? hi : dx);
        div.style.transition = 'none';
        div.style.transform = 'translateX(' + cx + 'px)';
        if (e.cancelable) e.preventDefault();
        return;
      }
      if (!order) return;
      lastY = e.clientY;
      /* Дыра липкая: стоит, пока ведущий край не въедет в следующий ряд
       * на PEN px. Усилие симметрично вверх и вниз при любой высоте строк. */
      updateHole(e.clientY);
      /* Автопрокрутка у краёв — только при уверенном движении (иначе страница
       * сдвигается от лёгкого касания): дальше 40px от захвата. Дальше едет
       * таймер edgeTick, а не движения пальца. */
      var dragDist = Math.abs(e.clientY - y0);
      if (dragDist > 40 && edgeZone(e.clientY)) {
        if (!edgeTimer) {
          edgeStart = Date.now();
          try { edgeTimer = setInterval(edgeTick, 20); } catch (x) { edgeTimer = null; }
        }
      } else stopEdge();
      if (e.cancelable) e.preventDefault();
    });
    function finish(e) {
      if (pid == null) return;
      if (e && e.pointerId != null && e.pointerId !== pid) return;
      pid = null;
      /* Таймер краевой прокрутки гасим всегда — иначе страница уедет сама
       * после отпускания пальца. */
      stopEdge();
      dragActive = false;
      document.removeEventListener('pointerup', finish);
      document.removeEventListener('pointercancel', finish);
      /* Фокус и клавиатура — только на финише: blur на захвате закрывал
       * клавиатуру посреди touch — вьюпорт прыгал, содержимое уезжало
       * из-под пальца и жест глох (v51). lastPD перед blur оживляем:
       * долгий жест (>700мс) иначе уводит blur-создание чужого черновика
       * мимо гарда grip и набранный текст превращается в задачу. */
      if (!refocusDraft) {
        lastPDts = Date.now();
        lastPDTarget = grip;
        var aeEnd = document.activeElement;
        var didBlur = false;
        if (aeEnd && aeEnd.blur && (aeEnd.tagName === 'TEXTAREA' || aeEnd.tagName === 'INPUT')) {
          try { aeEnd.blur(); didBlur = true; } catch (x) {}
        }
        /* Закрытие клавиатуры двигает страницу уже ПОСЛЕ жеста:
         * держим пин ещё полсекунды, чтобы итог не дёргался. */
        if (didBlur) unpinScroll(500); else unpinScroll();
      } else {
        unpinScroll();
      }
      /* Курсор был в поле-черновике: возвращаем его после финального
       * render (220мс), когда поле уже пересоздано на новом месте. */
      if (refocusDraft) {
        refocusDraft = false;
        setTimeout(function () {
          focusTrailing();
          var bx = el('lines');
          var ix = bx && bx.querySelector ? bx.querySelector('.tline[data-trailing] .tinput') : null;
          if (ix && ix.setSelectionRange) {
            try { var vv = ix.value; ix.setSelectionRange(vv.length, vv.length); } catch (x) {}
          }
        }, 240);
      }
      /* Тап по многоточию родителя (без движения): свернуть/развернуть детей. */
      if (mode === null && e && e.type === 'pointerup') {
        var tapped = myTask();
        if (tapped && hasKidsFull(tapped.id)) {
          toggleCollapse(tapped.id);
          return;
        }
      }
      if (mode === 'indent') {
        mode = null;
        div.style.transition = '';
        div.style.transform = '';
        var bou = indentBounds();
        var lvl = bou.cur + Math.round(lastDx / INDENT_STEP);
        if (lvl < 0) lvl = 0;
        if (lvl > bou.max) lvl = bou.max;
        var task = myTask();
        if (!task) {
          if (div.getAttribute && div.getAttribute('data-trailing')) {
            /* Сдвиг пустого поля — тоже перестановка: пишем в историю,
             * иначе отмена после сдвига откатит чужое действие. */
            if (effTrailingIndent() !== lvl) {
              pushUndo({
                tasks: snapTasks(),
                afterId: trailingAfterId,
                text: trailingText,
                indent: trailingIndent
              });
              updateHistoryButtons();
            }
            trailingIndent = lvl;
            render();
          }
          return;
        }
        if (lvl !== bou.cur) {
          (function (id, l) {
            mutate(function () { L.setIndent(state.tasks, id, l); });
          })(task.id, lvl);
        }
        render();
        return;
      }
      mode = null;
      var box = el('lines');
      var firstTop = null;
      try { firstTop = div.getBoundingClientRect().top; } catch (x) { firstTop = null; }
      /* Посадка ровно в дыру: где preview — там и место. Пересчёт не нужен,
       * поэтому промаха между preview и посадкой нет в принципе. */
      var preTops = [];
      if (box && order) {
        for (var j = 0; j < order.length; j++) {
          var row2 = order[j];
          if (row2 === div || !row2.parentNode || !rowShown(row2)) continue;
          var r = row2.getBoundingClientRect();
          preTops.push({ el: row2, top: r.top });
        }
        /* Посадка ровно в дыру: якорь — первый ряд под ней из слепка.
         * Пересчёт не нужен, промаха между preview и посадкой нет. */
        var anchor = phi < fr.length ? fr[phi].row : null;
        /* Дыру снимаем мгновенно ДО перестановки: старая трансформа дыры,
         * сложенная с новым потоком (строка+дети вернулись), даёт прыжок
         * строк ниже вверх с возвратом. Замер preTops выше — со старой
         * дырой, замер nt ниже — уже на чистом потоке, FLIP честный. */
        for (var hc = 0; hc < fr.length; hc++) {
          fr[hc].row.style.transition = 'none';
          fr[hc].row.style.transform = '';
        }
        try { void box.offsetHeight; } catch (x) {}
        /* Родитель едет вместе с детьми: весь блок встаёт на итоговое место,
         * дети снова принимают прежний вид вложений. */
        var sibs0 = box.querySelectorAll ? box.querySelectorAll('.tline[data-id]') : [];
        var oldPos = -1;
        for (var p0 = 0; p0 < sibs0.length; p0++) {
          if (sibs0[p0] === div) oldPos = p0;
        }
        box.insertBefore(div, anchor);
        var ref = div.nextSibling;
        for (var m = kids.length - 1; m >= 0; m--) {
          kids[m].style.display = '';
          box.insertBefore(kids[m], ref);
          ref = kids[m];
        }
        /* Черновик перетащили: запоминаем новое место (id соседа сверху
         * или TOP) и берём отступ по новому месту — тот же закон, что
         * у настоящих задач (applyDropIndent строку без data-id не видит,
         * поэтому поле после переноса держало старый отступ: между
         * дочерними оставалось на 0). Данные задач не трогаем. */
        if (!myTask() && div.getAttribute && div.getAttribute('data-trailing')) {
          var prevRow = div.previousSibling;
          var prevId = null;
          while (prevRow) {
            if (prevRow.getAttribute && prevRow.getAttribute('data-id')) {
              prevId = prevRow.getAttribute('data-id');
              break;
            }
            prevRow = prevRow.previousSibling;
          }
          var nextRow2 = div.nextSibling;
          var nextId = null;
          while (nextRow2) {
            if (nextRow2.getAttribute && nextRow2.getAttribute('data-id')) {
              nextId = nextRow2.getAttribute('data-id');
              break;
            }
            nextRow2 = nextRow2.nextSibling;
          }
          var newAfter = prevId || 'TOP';
          var pT = prevId ? L.getTask(state.tasks, prevId) : null;
          var nT = nextId ? L.getTask(state.tasks, nextId) : null;
          var pInd = pT ? lineIndent(pT) : 0;
          var nInd = nT ? lineIndent(nT) : -1;
          var wantInd = !pT ? 0 : (nInd === pInd + 1 ? nInd : pInd);
          var oldAfter = dragUiBefore ? dragUiBefore.afterId : trailingAfterId;
          var oldInd = effTrailingIndent();
          if (newAfter !== oldAfter || wantInd !== oldInd) {
            pushUndo({
              tasks: snapTasks(),
              afterId: oldAfter,
              text: dragUiBefore ? String(dragUiBefore.text || '') : trailingText,
              indent: dragUiBefore ? dragUiBefore.indent : trailingIndent
            });
            updateHistoryButtons();
          }
          trailingAfterId = newAfter;
          trailingIndent = wantInd;
        }
        /* Только теперь возвращаем строку в поток — место уже измерено. */
        div.style.position = '';
        div.style.top = '';
        div.style.left = '';
        div.style.width = '';
        div.style.margin = '';
        div.style.pointerEvents = '';
        /* Отступ по новому месту (только если блок реально переехал):
         * на уровне родителей — убираем, внутри чужого вложения —
         * берём отступ соседа сверху; весь блок сдвигается целиком. */
        var sibs = box.querySelectorAll ? box.querySelectorAll('.tline[data-id]') : [];
        var di = -1;
        for (var p1 = 0; p1 < sibs.length; p1++) {
          if (sibs[p1] === div) di = p1;
        }
        /* Слепок ДО мутации отступа: persistLineOrder позовём ниже, а его
         * свежий snapFull() уже содержал бы новый отступ — отмена вернула
         * бы порядок, но не уровень (родитель не возвращался на отступ 0). */
        var preDrop = (di !== -1 && di !== oldPos) ? snapFull() : null;
        if (di !== -1 && di !== oldPos) {
          applyDropIndent(box, sibs, di, kids);
        }
        /* Итоговый отступ — в этом же кадре, без ожидания render:
         * строка и дети встают сразу на место алгоритма. */
        dropMargins(div, kids);
      }
      div.classList.remove('dragging');
      /* Мягкая посадка: строка и соседи доезжают 200мс, затем сохраняем. */
      if (box && order) {
        if (firstTop != null) {
          var newR = null;
          try { newR = div.getBoundingClientRect(); } catch (x) { newR = null; }
          if (newR) {
            var dy = firstTop - newR.top;
            if (dy) {
              div.style.transition = 'none';
              div.style.transform = 'translateY(' + dy + 'px)';
              void div.offsetHeight;
              div.style.transition = 'transform .2s linear';
              div.style.transform = '';
            }
          }
        }
        for (var q = 0; q < preTops.length; q++) {
          var nt = preTops[q].el.getBoundingClientRect().top;
          var ddy = preTops[q].top - nt;
          if (!ddy) continue;
          preTops[q].el.style.transition = 'none';
          preTops[q].el.style.transform = 'translateY(' + ddy + 'px)';
          void preTops[q].el.offsetHeight;
          preTops[q].el.style.transition = 'transform .2s linear';
          preTops[q].el.style.transform = '';
        }
        box.classList.remove('drag-active');
        box.style.minHeight = '';
      }
      order = null;
      kids = [];
      var reordered = persistLineOrder(preDrop);
      /* Порядок не сдвинулся, а отступ — да: изменение есть, а шага истории
       * нет (persist вернул false). Пушим досдвиговый слепок, иначе ↩
       * откатит чужое более раннее действие вместо отступа. */
      if (!reordered && preDrop && snapTasks() !== preDrop.tasks) {
        pushUndo(preDrop);
        updateHistoryButtons();
        reordered = true;
      }
      /* Задачу тащили ЧЕРЕЗ черновик (или мимо него): data-id-порядок мог
       * не измениться — persist no-op, а render вернул бы поле на старый
       * якорь («всё возвращается на свои места»). Якорь поля — живая
       * строка непосредственно над ним (или TOP), отступ — по соседям,
       * как при переносе самого поля. Если порядок задач уже переставлен,
       * его undo-слепок (snapFull) несёт и старый якорь — второй шаг
       * истории не плодим. */
      var dRowB = box && box.querySelector ? box.querySelector('.tline[data-trailing]') : null;
      if (dRowB && myTask()) {
        var prB = dRowB.previousSibling, pIdB = null;
        while (prB) {
          if (prB.getAttribute && prB.getAttribute('data-id')) { pIdB = prB.getAttribute('data-id'); break; }
          prB = prB.previousSibling;
        }
        var newAfterB = pIdB || 'TOP';
        var pTB = pIdB ? L.getTask(state.tasks, pIdB) : null;
        var nRB = dRowB.nextSibling, nIdB = null;
        while (nRB) {
          if (nRB.getAttribute && nRB.getAttribute('data-id')) { nIdB = nRB.getAttribute('data-id'); break; }
          nRB = nRB.nextSibling;
        }
        var nTB = nIdB ? L.getTask(state.tasks, nIdB) : null;
        var pIndB = pTB ? lineIndent(pTB) : 0;
        var nIndB = nTB ? lineIndent(nTB) : -1;
        var wantIndB = !pTB ? 0 : (nIndB === pIndB + 1 ? nIndB : pIndB);
        if (newAfterB !== trailingAfterId || wantIndB !== trailingIndent) {
          if (!reordered) { pushUndo(snapFull()); updateHistoryButtons(); }
          trailingAfterId = newAfterB;
          trailingIndent = wantIndB;
        }
      }
      setTimeout(function () {
        div.style.transition = '';
        div.style.transform = '';
        render();
      }, 220);
    }
    grip.addEventListener('pointerup', finish);
    grip.addEventListener('pointercancel', finish);
    grip.addEventListener('lostpointercapture', function (e) {
      if (pid == null) return;
      /* Захват упал сам — жест жив, берём снова; не вышло (указателя
       * больше нет) — штатный финиш, слушатели снимаются в нём. */
      try { grip.setPointerCapture(e.pointerId); } catch (x) { finish(e); }
    });
  }

  function renderLines() {
    var box = el('lines');
    if (!box || !state) return;
    box.innerHTML = '';
    var tasks = lineTasks();
    /* Полный порядок (включая выполненных) — для наследования зачёркивания:
     * done-родитель ушёл в секцию ниже, но детей зачёркивает. */
    var full = fullList();
    var fullIdx = {};
    for (var fi = 0; fi < full.length; fi++) fullIdx[full[fi].id] = fi;
    /* Пустое поле живёт под строкой trailingAfterId (цепочка Enter вниз),
     * иначе — в конце живых. Отступ — свой ручной, по умолчанию 0.
     * Лишнее поле не показываем: при более чем одной живой задаче
     * (без цепочки и без набранного текста) его нет — новое поле
     * вызывается через Enter в строке. При пустом/единичном списке
     * поле всегда под рукой; набранный текст показываем всегда,
     * иначе ввод потеряется. Все живые выполнены — остаётся одно
     * пустое поле + секция выполненных. */
    var anchorIdx = -1;
    if (trailingAfterId) {
      for (var ai = 0; ai < tasks.length; ai++) {
        if (tasks[ai].id === trailingAfterId) { anchorIdx = ai; break; }
      }
    }
    var tailIndent = effTrailingIndent();
    var hasDraftText = String(trailingText || '').trim() !== '';
    var showDraft = (trailingAfterId === 'TOP') || (anchorIdx !== -1) ||
      (tasks.length <= 1) || hasDraftText;
    if (!showDraft) {
      /* Поля нет на экране — сбрасываем протухший якорь/сдвиг,
       * чтобы пустое поле не воскресало в случайном месте. */
      trailingAfterId = null;
      trailingIndent = null;
    }
    function taskRow(t, i) {
      return makeLine(t.id, t.title, false, lineIndent(t), {
        doneShown: L.isDoneShown(full, fullIdx[t.id]),
        hidden: L.isHiddenByCollapse(tasks, i, collapsed),
        estMin: lineEstMin(t)
      });
    }
    if (showDraft && trailingAfterId === 'TOP') {
      box.appendChild(makeLine(null, trailingText, true, tailIndent));
    }
    for (var i = 0; i < tasks.length; i++) {
      box.appendChild(taskRow(tasks[i], i));
      if (showDraft && i === anchorIdx) box.appendChild(makeLine(null, trailingText, true, tailIndent));
    }
    if (showDraft && anchorIdx === -1 && trailingAfterId !== 'TOP') {
      box.appendChild(makeLine(null, trailingText, true, tailIndent));
    }
    /* Выполненные — под полем добавления, новые выше старых. Строка под
     * свёрнутым родителем прячется вместе с живыми детьми (иначе
     * последняя дочерняя висит под свёрнутой группой). Сепаратор — пока
     * есть хоть один выполненный, даже если все спрятаны в свёрнутых
     * группах (счётчик показывает видимых). */
    var done = L.doneList(state.tasks);
    var doneVis = [];
    for (var d = 0; d < done.length; d++) {
      var di = fullIdx[done[d].id];
      var dHide = (di != null) ? L.isHiddenByCollapse(full, di, collapsed) : false;
      if (!dHide) doneVis.push(done[d]);
    }
    if (done.length) {
      var sep = document.createElement('div');
      sep.className = 'done-sep';
      /* Тап — скрыть/показать все выполненные разом. Стрелка показывает
       * состояние (▸ скрыты, ▾ видны), разделитель в скрытом состоянии
       * остаётся: он же точка возврата и кламп дыры при перетаскивании. */
      sep.textContent = 'Выполнено · ' + done.length + (doneHidden ? ' ▸' : ' ▾');
      sep.setAttribute('title', doneHidden ? 'Показать выполненные' : 'Скрыть выполненные');
      sep.addEventListener('click', function () { toggleDoneHidden(); });
      box.appendChild(sep);
      if (!doneHidden) {
        for (var dv = 0; dv < doneVis.length; dv++) {
          box.appendChild(makeLine(doneVis[dv].id, doneVis[dv].title, false, lineIndent(doneVis[dv]), { doneShown: true, estMin: lineEstMin(doneVis[dv]) }));
        }
      }
    }
    /* Раскрыть многострочные по содержимому (в потоке, после вставки). */
    var areas = box.querySelectorAll ? box.querySelectorAll('.tinput') : [];
    for (var q = 0; q < areas.length; q++) autosize(areas[q]);
    refreshDurchips(box);
  }

  function focusTrailing() {
    var box = el('lines');
    if (!box || !box.querySelector) return;
    var inp = box.querySelector('.tline[data-trailing] .tinput');
    if (inp && inp.focus) {
      try { inp.focus(); } catch (x) {}
    }
  }

  function renderStatus() {
    renderNet();
    var s = el('status');
    if (!s || !state) return;
    var st = L.stats(state.tasks);
    var parts = [
      'Задач: ' + ((st.inbox || 0) + (st.next || 0)),
      'выполненных: ' + (st.done || 0),
      'синхр: ' + (syncStatus || '—')
    ];
    if (lastAction) parts.push(lastAction);
    if (bootError) parts.push(bootError);
    s.textContent = parts.join(' · ');
  }

  /* Дата локальной копии (store.js) для диагностики. */
  function fmtWhen(ms) {
    try { return new Date(ms).toLocaleString('ru-RU'); } catch (x) { return 'есть'; }
  }
  function backupLabel() {
    var b = window.EBStore && window.EBStore.backupInfo ? window.EBStore.backupInfo() : null;
    if (!b) return 'нет';
    return fmtWhen(b.savedAt);
  }
  function pinLabel() {
    var p = window.EBStore && window.EBStore.pinInfo ? window.EBStore.pinInfo() : null;
    if (!p) return 'нет';
    var src = (p.by === 'auto' && p.version) ? 'перед ' + p.version : 'вручную';
    return fmtWhen(p.savedAt) + ' (' + src + ')';
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

  function diagText() {
    var st = state ? L.stats(state.tasks)
      : { inbox: 0, next: 0, done: 0 };
    var alive = (st.inbox || 0) + (st.next || 0);
    var recs = 0, bytes = 0;
    try {
      recs = state ? state.tasks.length : 0;
      bytes = JSON.stringify(state ? state.tasks : []).length;
    } catch (x) {}
    var collapsedN = 0;
    for (var id in collapsed) if (collapsed[id]) collapsedN++;
    var lines = [
      'Внешний мозг ' + APP_VERSION,
      'Задач: ' + alive + ' · готово ' + (st.done || 0),
      'Размер: ' + recs + ' записей · ' +
        (bytes < 1024 ? bytes + ' Б' : (bytes / 1024).toFixed(1) + ' КБ'),
      'Синк: ' + (syncStatus || '—') + (lastSyncAt ? ' (в ' + fmtDT(lastSyncAt) + ')' : '')
    ];
    if (lastErrMsg) lines.push('Ошибка синка: ' + fmtDT(lastErrAt) + ' — ' + lastErrMsg);
    lines.push('Каталог: ' + (state && state.updatedAt ? fmtDT(state.updatedAt) : '—'));
    lines.push('Локально: выполненные ' + (doneHidden ? 'скрыты' : 'видны') +
      ' · свёрнуто групп ' + collapsedN);
    lines.push('История: ↩ ' + undoStack.length + ' · ↪ ' + redoStack.length);
    lines.push('Сеть: ' + connLine());
    lines.push('Устройство: ' + deviceLine() + ' · id ' + journalDeviceId());
    lines.push('Repo: ' + (state ? state.settings.repo : '?'));
    lines.push('Ключ: ' + (state && state.settings.token ? 'введён' : 'выключен (нет ключа)'));
    lines.push('Публикация журнала: ' +
      (pubAt ? fmtDT(pubAt) + ' · ' + pubStatus : 'ещё не было'));
    lines.push('Локальная копия: ' + backupLabel());
    lines.push('Постоянная копия: ' + pinLabel());
    if (lastAction) lines.push('Последнее действие: ' + lastAction);
    lines.push(bootError ? bootError + ' ' + bootStack : 'Ошибок: нет');
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

  /* Окно диагностики как в purchases (showInfo): OK + Поделиться,
   * поле ввода и «Отмена» скрыты. Закрытие возвращает дефолты кнопок,
   * чтобы askText/askConfirm не показывали «Поделиться» вместо «Очистить». */
  function showInfo(title, body, shareable) {
    var back = el('modalBack'), text = el('modalText'), input = el('modalInput');
    var ok = el('modalOk'), clear = el('modalClear'), cancel = el('modalCancel');
    if (!back || !ok || !text) return Promise.resolve();
    text.textContent = title + '\n\n' + body;
    if (input) input.style.display = 'none';
    ok.textContent = 'OK';
    if (clear) {
      clear.textContent = 'Поделиться';
      clear.style.display = shareable ? '' : 'none';
    }
    if (cancel) cancel.style.display = 'none';
    back.classList.add('open');
    return new Promise(function (resolve) {
      function done() {
        back.classList.remove('open');
        ok.onclick = null;
        if (clear) { clear.onclick = null; clear.textContent = 'Очистить'; clear.style.display = 'none'; }
        if (cancel) { cancel.onclick = null; cancel.style.display = ''; }
        if (input) input.style.display = '';
        resolve();
      }
      ok.onclick = done;
      if (cancel) cancel.onclick = done;
      if (clear) {
        clear.onclick = function () {
          var t = shareable;
          done();
          shareDiag(t);
        };
      }
    });
  }

  /* Отправка текста наружу: системное меню, иначе буфер, иначе окно. */
  function shareDiag(text) {
    if (navigator.share) {
      try {
        var p = navigator.share({ title: 'Диагностика', text: text });
        if (p && p.catch) p.catch(function () {});
        return;
      } catch (e) {}
    }
    function manual(title, body) { showInfo(title, body, null); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        manual('Готово', 'Скопировано — вставь в мессенджер.\n\n' + text);
      }, function () { manual('Скопируй вручную', text); });
    } else manual('Скопируй вручную', text);
  }

  /* Удалить выполненные — с подтверждением (кнопка в шапке и в ⚙). */
  function askClearDone() {
    /* Выполненных нет — и корзина, и пункт меню ничего не удаляют:
     * пустое окно подтверждения только мешает (тап по 🗑 в шапке). */
    if (!L.doneList(state.tasks).length) return;
    askConfirm('Удалить все выполненные задачи?').then(function (ok) {
      if (!ok) return;
      mutate(function () {
        L.doneList(state.tasks).forEach(function (t) { L.removeTask(state.tasks, t.id); });
      });
    });
  }

  /* Поиск по задачам: кнопка 🔍 в шапке открывает нижний оверлей
   * (поле + Поиск/Отмена/Вверх/Вниз + счётчики). Ищем везде: живые,
   * свёрнутые, выполненные. Поиск — только по кнопке (не живой), при
   * нажатии клавиатура прячется и прыгаем к первому совпадению.
   * Переход разворачивает предков и секцию выполненных. Зелёной рамки
   * нет — текущее совпадение видно по центру экрана и счётчику i/N. */
  var searchIds = [], searchIdx = -1, searchScrollY = 0, searchLanded = false;
  /* Оверлей над клавиатурой: сама клавиатура (и её полоса с картой/
   * ключом/геопозицией) — системная, кнопки оверлея она перекрывает.
   * Поднимаем оверлей на высоту клавиатуры через visualViewport. */
  function searchLift() {
    var bar = el('searchBar');
    if (!bar || !bar.classList.contains('open')) return;
    var off = 0;
    try {
      if (window.visualViewport) {
        off = (window.innerHeight || 0) - window.visualViewport.height -
          (window.visualViewport.offsetTop || 0);
        if (!(off > 0)) off = 0;
      }
    } catch (x) { off = 0; }
    bar.style.bottom = off ? off + 'px' : '';
  }
  function searchUnlift() {
    try {
      if (window.visualViewport) window.visualViewport.removeEventListener('resize', searchLift);
    } catch (x) {}
    var bar = el('searchBar');
    if (bar) bar.style.bottom = '';
  }
  function searchSetDisabled(id, v) {
    var b = el(id);
    if (b) b.disabled = !!v;
  }
  function updateSearchUI() {
    var inp = el('searchInput');
    var has = !!(inp && String(inp.value).trim());
    var n = searchIds.length;
    searchSetDisabled('searchGo', !has);
    searchSetDisabled('searchUp', !has || searchIdx <= 0);
    searchSetDisabled('searchDown', !has || searchIdx < 0 || searchIdx >= n - 1);
    var tot = el('searchTotal'), pos = el('searchPos');
    if (tot) tot.textContent = 'Совпадений: ' + n;
    if (pos) pos.textContent = n ? (searchIdx + 1) + '/' + n : '0/0';
  }
  function openSearch() {
    if (!state) return;
    try { searchScrollY = window.pageYOffset; } catch (x) { searchScrollY = 0; }
    searchIds = [];
    searchIdx = -1;
    searchLanded = false;
    var bar = el('searchBar');
    if (bar) bar.classList.add('open');
    var gm = el('gearMenu');
    if (gm) gm.classList.remove('open');
    try {
      if (window.visualViewport) window.visualViewport.addEventListener('resize', searchLift);
    } catch (x) {}
    searchLift();
    var inp = el('searchInput');
    if (inp) { inp.value = ''; try { inp.focus(); } catch (x) {} }
    updateSearchUI();
  }
  function closeSearch(restore) {
    applySearchHit(null);
    searchUnlift();
    var bar = el('searchBar');
    if (bar) bar.classList.remove('open');
    var inp = el('searchInput');
    if (inp) { try { inp.blur(); } catch (x) {} }
    searchIds = [];
    searchIdx = -1;
    /* Отмена: ничего не искали — вернуть страницу на место открытия;
     * поиск останавливался на задаче — оставить как есть. */
    if (restore && !searchLanded) { try { window.scrollTo(0, searchScrollY); } catch (x) {} }
    searchLanded = false;
  }
  /* Цель видна: разворачиваем предков (свёрнутые группы) и секцию
   * выполненных, если совпадение там. */
  function ensureSearchVisible(id) {
    if (!state) return;
    var t = L.getTask(state.tasks, id);
    if (!t) return;
    if (t.status === 'done') {
      if (doneHidden) toggleDoneHidden();
    } else {
      var lt = [];
      try { lt = lineTasks(); } catch (x) { lt = []; }
      var idx = -1, i;
      for (i = 0; i < lt.length; i++) {
        if (lt[i].id === id) { idx = i; break; }
      }
      if (idx !== -1) {
        var minInd = 999, changed = false;
        for (i = idx; i >= 0; i--) {
          var ind = lineIndent(lt[i]);
          if (ind < minInd) {
            minInd = ind;
            if (i !== idx && collapsed[lt[i].id]) {
              delete collapsed[lt[i].id];
              changed = true;
            }
          }
        }
        if (changed) saveCollapsed();
      }
    }
    render();
  }
  /* Строка — в середину между шапкой и верхом окна поиска. */
  function scrollToSearchRow(id) {
    var box = el('lines');
    if (!box || !box.querySelectorAll) return;
    var rows = box.querySelectorAll('.tline[data-id]');
    var row = null, i;
    for (i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('data-id') === id) { row = rows[i]; break; }
    }
    if (!row) return;
    var headB = 0, barTop = 0, rh = 0;
    try {
      var hd = document.querySelector('header');
      headB = hd ? hd.getBoundingClientRect().bottom : 0;
      var bar = el('searchBar');
      barTop = bar ? bar.getBoundingClientRect().top : (window.innerHeight || 800);
      rh = row.getBoundingClientRect().height;
    } catch (x) {}
    var want = headB + (barTop - headB) / 2 - rh / 2;
    var y = 0;
    try { y = window.pageYOffset + row.getBoundingClientRect().top - want; } catch (x) { y = 0; }
    if (y < 0) y = 0;
    try { window.scrollTo(0, y); } catch (x) {}
  }
  /* Подсветка текущего совпадения: снять со старой, поставить на новую.
   * Только классы — вёрстка не едет. Вызывать после каждого render(),
   * иначе фоновый синк снесут подсветку вместе со строками. */
  function applySearchHit(id) {
    var box = el('lines');
    if (!box || !box.querySelectorAll) return;
    var marked = box.querySelectorAll('.tline.search-hit');
    var i;
    for (i = 0; i < marked.length; i++) marked[i].classList.remove('search-hit');
    if (!id) return;
    var rows = box.querySelectorAll('.tline[data-id]');
    for (i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('data-id') === id) { rows[i].classList.add('search-hit'); break; }
    }
  }
  function gotoSearch(i) {
    if (!searchIds.length) return;
    if (i < 0) i = 0;
    if (i > searchIds.length - 1) i = searchIds.length - 1;
    searchIdx = i;
    searchLanded = true;
    ensureSearchVisible(searchIds[i]);
    scrollToSearchRow(searchIds[i]);
    applySearchHit(searchIds[i]);
    updateSearchUI();
  }
  function doSearch() {
    if (!state) return;
    var inp = el('searchInput');
    var q = inp ? inp.value : '';
    /* Скрываем клавиатуру — дальше прыжок к первому совпадению. */
    if (inp) { try { inp.blur(); } catch (x) {} }
    var live = [], dn = [];
    try { live = lineTasks(); } catch (x) { live = []; }
    try { dn = L.doneList(state.tasks); } catch (x) { dn = []; }
    searchIds = L.searchTasks(live.concat(dn), q);
    searchIdx = searchIds.length ? 0 : -1;
    if (searchIds.length) gotoSearch(0);
    else { applySearchHit(null); updateSearchUI(); }
  }

  function wire() {
    var gear = el('gearMenu');
    on('gearBtn', 'click', function () {
      if (gear) gear.classList.toggle('open');
      if (gear && !gear.classList.contains('open')) {
        var bm = el('backupMenu');
        if (bm) bm.classList.remove('open');
      }
    });
    /* Подменю «Резервная копия»: три пункта-копии в одном. */
    on('backupBtn', 'click', function () {
      var bm = el('backupMenu');
      if (bm) bm.classList.toggle('open');
    });
    on('diagBtn', 'click', function () {
      diagText().then(function (txt) {
        showInfo('Диагностика', txt, txt);
      });
    });
    /* Репозиторий и токен — только для администратора: сначала предупреждение,
     * затем модальное окно по центру с двумя полями и кнопками
     * Сохранить/Отмена (в маленьком экране меню не переполняется). */
    on('repoBtn', 'click', function () {
      askConfirm('Настройки репозитория и токена — только для администратора. ' +
        'Неверные значения нарушат синхронизацию на этом устройстве. Открыть?').then(function (ok) {
          if (!ok) return;
          openRepoModal();
        });
    });
    /* Поле токена живёт в DOM только пока открыто окно настроек: иначе Chrome
     * видит пару «текст + пароль» и предлагает сохранить токен как логин. */
    function repoTokenBuild() {
      var wrap = el('repoTokenWrap');
      if (!wrap) return;
      wrap.innerHTML = '';
      var inp = document.createElement('input');
      inp.id = 'tokenInput';
      inp.type = 'password';
      inp.placeholder = 'GitHub token';
      inp.autocomplete = 'off';
      inp.setAttribute('aria-label', 'Токен');
      if (state && state.settings.token) inp.value = state.settings.token;
      wrap.appendChild(inp);
    }
    function repoTokenDestroy() {
      var wrap = el('repoTokenWrap');
      if (wrap) wrap.innerHTML = '';
    }
    function openRepoModal() {
      var repo = el('repoModalInput');
      if (repo) repo.value = (state && state.settings.repo) || '';
      repoTokenBuild();
      var back = el('repoModalBack');
      if (back) back.classList.add('open');
    }
    function closeRepoModal() {
      repoTokenDestroy();
      var back = el('repoModalBack');
      if (back) back.classList.remove('open');
    }
    on('syncNowBtn', 'click', function () { doSync(true); });
    /* Тап по светофору — принудительный синк (как в purchases). */
    on('syncLight', 'click', function () { doSync(true); });
    on('installBtn', 'click', function () {
      if (window._deferredPrompt) {
        window._deferredPrompt.prompt();
        window._deferredPrompt = null;
      } else {
        askConfirm('Установка: в меню браузера выберите «Установить приложение» / «На экран Домой». Понятно?').then(function () {});
      }
    });
    on('shareBtn', 'click', function () {
      var txt = L.shareText(state.tasks);
      if (navigator.share) navigator.share({ text: txt }).catch(function () {});
      else if (navigator.clipboard) navigator.clipboard.writeText(txt).then(function () { lastAction = 'скопировано'; renderStatus(); });
      else askText(txt, '', false).then(function () {});
    });
    on('shareAppBtn', 'click', function () {
      var url = window.location.href;
      if (navigator.share) navigator.share({ text: url }).catch(function () {});
      else if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { lastAction = 'скопировано'; renderStatus(); });
      else askText(url, '', false).then(function () {});
    });
    on('searchBtn', 'click', function () { openSearch(); });
    on('searchGo', 'click', function () { doSearch(); });
    on('searchCancel', 'click', function () { closeSearch(true); });
    on('searchUp', 'click', function () { if (searchIdx > 0) gotoSearch(searchIdx - 1); });
    on('searchDown', 'click', function () { if (searchIdx >= 0 && searchIdx < searchIds.length - 1) gotoSearch(searchIdx + 1); });
    on('searchInput', 'input', function () {
      /* Запрос поменялся — старые совпадения недействительны. */
      searchIds = [];
      searchIdx = -1;
      updateSearchUI();
    });
    on('searchInput', 'keydown', function (e) {
      if (e && e.key === 'Enter') {
        var inp = el('searchInput');
        if (inp && String(inp.value).trim()) {
          if (e.cancelable) e.preventDefault();
          doSearch();
        }
      }
    });
    on('clearDone', 'click', function () { askClearDone(); });
    on('deleteDoneBtn', 'click', function () { askClearDone(); });
    on('restoreBtn', 'click', function () {
      if (!state) return;
      var info = window.EBStore.backupInfo ? window.EBStore.backupInfo() : null;
      if (!info) {
        askText('Локальная копия пока не создавалась', '', false).then(function () {});
        return;
      }
      askConfirm('Заменить текущие задачи локальной копией (состояние до последнего сохранения)? Отменить можно стрелкой ↩.')
        .then(function (yes) {
          if (!yes || !state) return;
          var restored = window.EBStore.restoreBackup ? window.EBStore.restoreBackup() : null;
          if (!restored) return;
          mutate(function () {
            state.tasks = L.normalizeTasks(restored.tasks);
            state.updatedAt = Date.now();
          });
          lastAction = 'копия восстановлена';
          renderStatus();
        });
    });
    on('pinSaveBtn', 'click', function () {
      if (!state) return;
      var info = window.EBStore.pinInfo ? window.EBStore.pinInfo() : null;
      function doPin() {
        if (window.EBStore.savePinNow) window.EBStore.savePinNow(state, APP_VERSION);
        lastAction = 'постоянная копия сохранена';
        renderStatus();
      }
      if (!info) { doPin(); return; }
      askConfirm('Заменить постоянную копию от ' + fmtWhen(info.savedAt) + '?')
        .then(function (yes) { if (yes) doPin(); });
    });
    on('pinRestoreBtn', 'click', function () {
      if (!state) return;
      var info = window.EBStore.pinInfo ? window.EBStore.pinInfo() : null;
      if (!info) {
        askText('Постоянная копия не создавалась (кнопка «Сделать постоянную копию» ' +
          'или автокопия при обновлении приложения)', '', false).then(function () {});
        return;
      }
      askConfirm('Заменить текущие задачи постоянной копией от ' + fmtWhen(info.savedAt) + '? Отменить можно стрелкой ↩.')
        .then(function (yes) {
          if (!yes || !state) return;
          var restored = window.EBStore.restorePin ? window.EBStore.restorePin() : null;
          if (!restored) return;
          mutate(function () {
            state.tasks = L.normalizeTasks(restored.tasks);
            state.updatedAt = Date.now();
          });
          lastAction = 'постоянная копия восстановлена';
          renderStatus();
        });
    });
    on('collapseAllBtn', 'click', function () { setAllCollapsed(true); });
    on('expandAllBtn', 'click', function () { setAllCollapsed(false); });
    on('undoBtn', 'click', function () { doUndo(); });
    on('redoBtn', 'click', function () { doRedo(); });
    /* Стрелки модалки времени (часы ±60, минуты ±5 от общего итога). */
    on('durHp', 'click', function () { durTot = Math.min(durTot + 60, 59999); durRender(); });
    on('durHm', 'click', function () { durTot = Math.max(durTot - 60, 0); durRender(); });
    on('durMp', 'click', function () { durTot = Math.min(durTot + 5, 59999); durRender(); });
    on('durMm', 'click', function () { durTot = Math.max(durTot - 5, 0); durRender(); });
    on('repoSaveBtn', 'click', function () {
      var repo = el('repoModalInput');
      var tok = document.getElementById('tokenInput');
      mutate(function () {
        if (repo && repo.value) state.settings.repo = repo.value.trim();
        if (tok) state.settings.token = tok.value.trim();
      });
      closeRepoModal();
      if (gear) gear.classList.remove('open');
      doSync(true);
    });
    on('repoCancelBtn', 'click', function () {
      closeRepoModal();
    });
    var sl = el('syncLight');
    if (sl) sl.addEventListener('click', function () { doSync(true); });
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      window._deferredPrompt = e;
    });
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

  function setupPolling() {
    setInterval(function () {
      if (!document.hidden && navigator.onLine && state && state.settings.token) doSync();
    }, 60000);
  }

  function boot() {
    wire();
    /* Клавиатура/поворот меняют ширину поля: перенос строк другой —
     * пересчитываем, накрыт ли текст меткой времени. */
    var chipResizeT = null;
    window.addEventListener('resize', function () {
      if (chipResizeT) clearTimeout(chipResizeT);
      chipResizeT = setTimeout(function () {
        chipResizeT = null;
        refreshDurchips(el('lines'));
      }, 120);
    });
    loadCollapsed();
    loadDoneHidden();
    syncLogLoad();
    window.EBStore.load().then(function (s) {
      state = s;
      /* Первая загрузка новой версии: авто-пин «перед обновлением». */
      try {
        if (window.EBStore.pinOnVersion) window.EBStore.pinOnVersion(APP_VERSION);
      } catch (e) {}
      render();
      setLight(state.settings.token ? 'gray' : 'gray', false);
      syncStatus = state.settings.token ? '' : 'выключен (нет ключа)';
      renderStatus();
      doSync();
      checkUpdate();
      setupPolling();
    }).catch(function (e) {
      bootError = 'ОШИБКА загрузки: ' + String(e && e.message || e);
      var s = el('status');
      if (s) s.textContent = bootError;
    });
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('./sw.js').catch(function () {});
        navigator.serviceWorker.addEventListener('controllerchange', function () {
          if (!window._ebReloaded) { window._ebReloaded = true; location.reload(); }
        });
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
