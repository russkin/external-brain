/* app.js — интерфейс «Внешнего мозга»: инбокс + прояснение по джедайским техникам. */
'use strict';

(function () {
  var APP_VERSION = 'v44';
  var INDENT_STEP = 28;
  var LINES_GAP = 8;
  var COLLAPSED_KEY = 'external-brain-collapsed-v1';
  var L = window.EBLogic;
  var state = null;
  var syncStatus = '';
  var lastAction = '';
  var bootError = '';
  var bootStack = '';

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
      undoStack.push(before);
      if (undoStack.length > HISTORY_MAX) undoStack.shift();
      redoStack = [];
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
    applySnapshot(us);
    focusAfterHistory(us, false);
  }

  function doRedo() {
    if (!state || !redoStack.length) return;
    undoStack.push(snapFull());
    if (undoStack.length > HISTORY_MAX) undoStack.shift();
    var rs = redoStack.pop();
    applySnapshot(rs);
    focusAfterHistory(rs, true);
  }

  function updateHistoryButtons() {
    var u = el('undoBtn'), r = el('redoBtn');
    if (u) u.disabled = !undoStack.length;
    if (r) r.disabled = !redoStack.length;
  }

  /* Курсор в конец задачи по id (после отмены вызова поля). */
  function focusTaskEnd(taskId) {
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
          if (inp.setSelectionRange) inp.setSelectionRange(v.length, v.length);
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
        setLight('red', false);
        syncFails += 1;
        if (syncFails <= 5) {
          setTimeout(function () { doSync(); }, 2000);
        }
      } else {
        syncFails = 0;
        setLight(res.status === 'in-sync' ? 'green' : 'green', false);
        if (res.status === 'pulled' || res.status === 'merged') {
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
      setLight('red', false);
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
    n.classList.remove('alert');
  }

  function setAlert() {
    var n = el('syncLight');
    if (!n) return;
    n.classList.add('alert');
    n.style.background = '#f44336';
    n.textContent = '!';
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

  function taskRow(t, buttons) {
    var div = document.createElement('div');
    div.className = 'row';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = t.status === 'done';
    cb.setAttribute('aria-label', 'Готово');
    cb.addEventListener('change', function () {
      mutate(function () {
        if (cb.checked) L.completeTask(state.tasks, t.id);
        else L.reopenTask(state.tasks, t.id);
      });
    });
    div.appendChild(cb);
    var nm = document.createElement('span');
    nm.className = 'row-name' + (t.status === 'done' ? ' done' : '');
    var label = t.title;
    if (t.project) label += ' [' + t.project + ']';
    if (t.slicesTotal > 0) label += ' (' + t.slicesDone + '/' + t.slicesTotal + ')';
    if (t.frog) label = 'FROG ' + label;
    nm.textContent = label;
    div.appendChild(nm);
    buttons.forEach(function (b) {
      var btn = document.createElement('button');
      btn.textContent = b[0];
      btn.title = b[1] || b[0];
      btn.addEventListener('click', function () { b[2](t); });
      div.appendChild(btn);
    });
    return div;
  }

  function renderGroup(boxId, title, list, mkButtons) {
    var box = el(boxId);
    if (!box) return;
    box.innerHTML = '';
    if (!list.length) { box.style.display = 'none'; return; }
    box.style.display = '';
    var h = document.createElement('div');
    h.className = 'group-title';
    h.textContent = title + ' (' + list.length + ')';
    box.appendChild(h);
    list.forEach(function (t) {
      box.appendChild(taskRow(t, mkButtons(t)));
    });
  }

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
      if (!t || t.deleted || !String(t.title || '').trim()) continue;
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
        if (L.hasKids(tasks, i)) collapsed[tasks[i].id] = true;
      }
    }
    saveCollapsed();
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
  /* Жест перетаскивания: фокус с любой строки/поля сбрасывается на захвате
   * grip (иначе на старых устройствах открытая клавиатура живёт весь свайп,
   * а клик не успевает отстрелиться и blur не приходит). Пока флаг поднят,
   * render в mutate/commit не выполняется — узлы жеста не пересоздаются. */
  var dragActive = false;
  /* Курсор стоял в поле-черновике — после ЖЕСТА ПО САМОМУ ПОЛЮ возвращаем
   * его (клавиатуру закрыли для чистого свайпа, набирать-то надо). */
  var refocusDraft = false;

  /* Отступ строки в пикселях. Задача с отступом входит в группу задачи сверху. */
  function lineIndent(t) {
    var v = parseInt(t && t.indent, 10);
    if (!(v >= 0)) return 0;
    if (v > 8) return 8;
    return v;
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
    inp.placeholder = 'Новая задача…';
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

  /* Свайп строки справа налево: открыть флаг «Выполнено».
   * Тап по открытой строке (без сдвига) — закрыть флаг обратно. */
  function wireLineSwipe(div, taskId) {
    var swPid = null, swX0 = 0, swY0 = 0;
    var tapX0 = 0, tapY0 = 0;
    /* Состояние — на элементе, а не в closure: свайп делят обработчики
     * строки и старта drag'а, рассинхрон даёт залипший флаг. */
    div._swOpen = false;
    div.addEventListener('pointerdown', function (e) {
      tapX0 = e.clientX;
      tapY0 = e.clientY;
      if (e.target && e.target.closest && e.target.closest('.grip')) return;
      if (e.button != null && e.button !== 0) return;
      swPid = e.pointerId;
      swX0 = e.clientX;
      swY0 = e.clientY;
    });
    div.addEventListener('pointermove', function (e) {
      if (e.pointerId !== swPid) return;
      var dx = e.clientX - swX0;
      var dy = e.clientY - swY0;
      if (!div._swOpen && dx < -48 && Math.abs(dx) > Math.abs(dy) * 2) {
        div.classList.add('swiped');
        div._swOpen = true;
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
      }
    });
    function swEnd(e) {
      if (e && e.pointerId != null && e.pointerId !== swPid) return;
      swPid = null;
      dragActive = false;
    }
    div.addEventListener('pointerup', swEnd);
    div.addEventListener('pointercancel', swEnd);
    div.addEventListener('pointerup', function (e) {
      /* Тап по самому флагу сюда не входит: у него свой обработчик. */
      if (e.target && e.target.closest && e.target.closest('.doneflag')) return;
      if (div._swOpen && Math.abs(e.clientX - tapX0) < 12 && Math.abs(e.clientY - tapY0) < 12) {
        div.classList.remove('swiped');
        div._swOpen = false;
      }
    });
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
  function insertTaskAfter(prevId, title, indent, now) {
    var alive = lineTasks();
    var idx = -1;
    for (var i = 0; i < alive.length; i++) {
      if (alive[i].id === prevId) { idx = i; break; }
    }
    if (idx === -1) return L.createTask(state.tasks, title, now, { indent: indent || 0 });
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
    var created = L.createTask(state.tasks, title, now, { indent: indent || 0 });
    if (created) {
      created.createdAt = slot;
      created.ts = now;
      created.updatedAt = now;
    }
    return created;
  }

  function insertTaskTop(title, now) {
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
    var created = L.createTask(state.tasks, title, now, { indent: 0 });
    if (created) {
      created.createdAt = slot;
      created.ts = now;
      created.updatedAt = now;
    }
    return created;
  }

  function placeTaskAfter(prevId, title, indent) {
    var title0 = String(title == null ? '' : title).trim();
    if (!title0) return null;
    var now = Date.now();
    var created = null;
    mutate(function () {
      created = insertTaskAfter(prevId, title0, indent, now);
    });
    return created;
  }

  function placeTaskTop(title) {
    var title0 = String(title == null ? '' : title).trim();
    if (!title0) return null;
    var now = Date.now();
    var created = null;
    mutate(function () {
      created = insertTaskTop(title0, now);
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
    if (!title) return;
    var focusId = null;
    var fresh = (Date.now() - lastPDts) < 700;
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
      placeTaskTop(title) :
      placeTaskAfter(trailingAnchorId(), title, indent);
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
  function mergeTaskIntoPrev(taskId) {
    var lt = lineTasks();
    var idx = -1;
    for (var i = 0; i < lt.length; i++) {
      if (lt[i] && lt[i].id === taskId) { idx = i; break; }
    }
    if (idx <= 0) return;
    var prev = lt[idx - 1];
    var cur = lt[idx];
    var joined = String(prev.title || '') + String(cur.title || '');
    mutate(function () {
      L.clarifyTask(state.tasks, prev.id, { title: joined });
      L.removeTask(state.tasks, cur.id);
      if (trailingAfterId === cur.id) trailingAfterId = prev.id;
    });
    focusTaskEnd(prev.id);
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
      mutate(function () { L.removeTask(state.tasks, taskId); });
      return 'removed';
    }
    if (title !== task.title) {
      mutate(function () { L.clarifyTask(state.tasks, taskId, { title: title }); });
    }
    return task;
  }

  function wireLineInput(div, inp, taskId, isTrailing, indent) {
    var saveTimer = null;
    inp.addEventListener('input', function () {
      autosize(inp);
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
      if (isTrailing || !taskId) return;
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      var r = commitLine(taskId, inp.value, false);
      if (r === 'removed') { if (!dragActive) render(); }
      else renderStatus();
    });
    if (isTrailing) {
      /* Потеря фокуса с текстом = создание задачи. Отложенный запуск:
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
        mergeTaskIntoPrev(taskId);
        return;
      }
      if (e.key !== 'Enter' || e.shiftKey) return;
      e.preventDefault();
      if (isTrailing) {
        var oldAnchor = trailingAfterId;
        var oldIndent = trailingIndent;
        var created = (trailingAfterId === 'TOP') ?
          placeTaskTop(inp.value) :
          placeTaskAfter(trailingAnchorId(), inp.value, indent);
        if (created) {
          /* Вторая точка в истории: появление нового пустого поля —
           * отменяется отдельно (задача с текстом остаётся). */
          undoStack.push({
            tasks: snapTasks(),
            afterId: oldAnchor,
            text: '',
            indent: oldIndent,
            focusId: created.id
          });
          if (undoStack.length > HISTORY_MAX) undoStack.shift();
          redoStack = [];
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
      commitLine(taskId, inp.value, false);
      /* Позиция поля: каретка в начале текста — НАД текущей строкой на
       * её же отступе (вставка сверху, якорь — строка перед ней или
       * TOP); иначе — под строкой: у родителя (за ним первая дочерняя)
       * сразу на её отступе, у листа — свой уровень. Вызов поля —
       * отдельная точка в истории, иначе ↩ откатит чужое давнее
       * действие (вплоть до воскрешения удалённого в выполненных). */
      var moved = L.getTask(state.tasks, taskId);
      if (moved && moved.status !== 'done') {
        var atStart = inp.selectionStart === 0 && inp.selectionEnd === 0;
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
          undoStack.push({
            tasks: snapTasks(),
            afterId: trailingAfterId,
            text: trailingText,
            indent: trailingIndent,
            focusId: taskId
          });
          if (undoStack.length > HISTORY_MAX) undoStack.shift();
          redoStack = [];
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
  function persistLineOrder() {
    var box = el('lines');
    if (!box || !state) return;
    var domAlive = [];
    var rows = box.querySelectorAll ? box.querySelectorAll('.tline[data-id]') : [];
    for (var i = 0; i < rows.length; i++) {
      var id = rows[i].getAttribute('data-id');
      var t = id ? L.getTask(state.tasks, id) : null;
      if (t && !t.deleted && t.status !== 'done') domAlive.push(id);
    }
    if (!domAlive.length) return;
    var cur = lineTasks().map(function (t) { return t.id; });
    if (cur.length === domAlive.length) {
      var same = true;
      for (var k = 0; k < domAlive.length; k++) {
        if (domAlive[k] !== cur[k]) { same = false; break; }
      }
      if (same) return;
    }
    /* Уехавший блок — непрерывный отрезок отличий (drag двигает целиком). */
    var bs = -1, be = -1;
    for (var d = 0; d < domAlive.length && d < cur.length; d++) {
      if (domAlive[d] !== cur[d]) { if (bs === -1) bs = d; be = d; }
    }
    if (bs === -1) return;
    var before = snapFull();
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
    undoStack.push(before);
    if (undoStack.length > HISTORY_MAX) undoStack.shift();
    redoStack = [];
    save();
    updateHistoryButtons();
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
  /* Перетаскивание за grip двумя жестами (Pointer Events — мышь и тач):
   * - вверх/вниз: плавный вертикальный drag (призрак + соседи едут);
   * - вправо/влево: сдвиг на ширину отступа — задача входит в группу
   *   задачи сверху (уровень не глубже соседа сверху +1, первая — всегда 0).
   * Направление определяется первым движением: горизонталь (|dx|>|dy|*2). */
  function wireLineDrag(div, grip, inp) {
    var pid = null, grabDy = 0, divH = 0, holeH = 0, holeShift = 0, x0 = 0, y0 = 0;
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
      var rect = null;
      try { rect = div.getBoundingClientRect(); } catch (x) { rect = null; }
      var h = rect ? rect.height : div.offsetHeight || 56;
      grabDy = rect ? (e.clientY - rect.top) : h / 2;
      divH = h;
      order = rowsOf(box);
      /* Дети (вложенные с большим отступом) прячутся под родителя на время drag.
       * Высоту меряем ДО скрытия. */
      holeH = h;
      kids = [];
      var mine0 = myTask();
      if (mine0) {
        var lv0 = lineIndent(mine0);
        var started = false;
        for (var k = 0; k < order.length; k++) {
          if (order[k] === div) { started = true; continue; }
          if (!started) continue;
          var kidId = order[k].getAttribute ? order[k].getAttribute('data-id') : null;
          var kt = kidId ? L.getTask(state.tasks, kidId) : null;
          if (kt && lineIndent(kt) > lv0) {
            try { holeH += order[k].getBoundingClientRect().height; } catch (x) {}
            kids.push(order[k]);
          } else break;
        }
        for (var kh = 0; kh < kids.length; kh++) kids[kh].style.display = 'none';
      }
      /* Замороженный покой (как в присланном алгоритме): каркас из строк
       * (без тянущейся и спрятанных детей) с оффсетами за один проход.
       * Дыра = блок + съеденные потоком зазоры, чтобы захват не дёргал список. */
      holeShift = holeH + (kids.length + 1) * LINES_GAP;
      fr = [];
      frSh = [];
      phi = 0;
      var acc = 0;
      var chn = box.children;
      for (var ci = 0; ci < chn.length; ci++) {
        var cr = chn[ci];
        if (cr === div) { phi = fr.length; continue; }
        if (!cr.classList || !cr.classList.contains('tline') || cr.style.display === 'none') continue;
        var hr = 0;
        try { hr = cr.getBoundingClientRect().height; } catch (x) { hr = 0; }
        fr.push({ row: cr, off: acc, h: hr });
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
      lastDx = 0;
      lastScrollTs = 0;
      mode = null;
      kids = [];
      dragUiBefore = snapFull();
      try { grip.setPointerCapture(pid); } catch (x) {}
      /* Взялись за grip — фокус с любой строки/поля сбрасываем сразу:
       * старый Chrome держит его весь свайп (mousedown под preventDefault
       * не уходит, blur сам не приходит) — открытая клавиатура ломает
       * замеры и посадку. Коммит текста при этом не рендерит (dragActive),
       * текст черновика не теряется: его blur-создание видит grip в lastPD
       * и пропускает. */
      dragActive = true;
      var aeNow = document.activeElement;
      /* Возврат курсора — только когда тащат САМО поле: при жесте на
       * чужой строке (свайп родителя) фокус с набранного снимается
       * насовсем, иначе клавиатура тут же возвращается. */
      var focusInDraft = !!(aeNow && aeNow.closest && aeNow.closest('.tline[data-trailing]'));
      var dragIsDraft = !!(div.getAttribute && div.getAttribute('data-trailing'));
      refocusDraft = focusInDraft && dragIsDraft;
      if (aeNow && aeNow.blur && (aeNow.tagName === 'TEXTAREA' || aeNow.tagName === 'INPUT')) {
        try { aeNow.blur(); } catch (x) {}
      }
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
        } else if (Math.abs(dy) > 10) {
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
      /* Ведущие края тянущейся: низ идёт за пальцем со сдвигом grabDy. */
      var dt = e.clientY - grabDy;
      div.style.top = dt + 'px';
      /* Всё в покое: живой верх коробки (несмотря на скролл) + замороженные
       * оффсеты. Замеров рядов нет — недолётным анимациям нечего болтать. */
      var boxTop = 0;
      try { boxTop = box.getBoundingClientRect().top; } catch (x) { boxTop = 0; }
      /* Дыра липкая: стоит, пока ведущий край не въедет в следующий ряд
       * на PEN px. Усилие симметрично вверх и вниз при любой высоте строк. */
      var advanced = false;
      /* Дыра липкая: верх дыры следует за верхом тянущейся. Пороги —
       * замороженные оффсеты, строго монотонны: удерживаемый палец стабилен
       * всегда, усилие одинаково вверх/вниз при любой высоте строк. */
      while (phi < fr.length) {
        if (dt > boxTop + fr[phi].off + PEN) { phi++; setHole(phi); advanced = true; }
        else break;
      }
      while (phi > 0) {
        var pv = fr[phi - 1];
        if (dt < boxTop + pv.off + pv.h - PEN) { phi--; setHole(phi); advanced = true; }
        else break;
      }
      if (!advanced) return;
      /* Автопрокрутка у краёв — только при уверенном движении (иначе страница
       * сдвигается от лёгкого касания): дальше 40px от захвата, не чаще 90мс. */
      var dragDist = Math.abs(e.clientY - y0);
      var nowMs = Date.now();
      if (dragDist > 40 && nowMs - lastScrollTs > 90) {
        try {
          if (e.clientY < 70) { window.scrollBy(0, -12); lastScrollTs = nowMs; }
          else if (e.clientY > (window.innerHeight || 800) - 70) { window.scrollBy(0, 12); lastScrollTs = nowMs; }
        } catch (x) {}
      }
      if (e.cancelable) e.preventDefault();
    });
    function finish(e) {
      if (pid == null) return;
      if (e && e.pointerId != null && e.pointerId !== pid) return;
      pid = null;
      dragActive = false;
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
        if (tapped) {
          var lt = lineTasks();
          for (var ti = 0; ti < lt.length; ti++) {
            if (lt[ti].id === tapped.id && L.hasKids(lt, ti)) { toggleCollapse(tapped.id); return; }
          }
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
              undoStack.push({
                tasks: snapTasks(),
                afterId: trailingAfterId,
                text: trailingText,
                indent: trailingIndent
              });
              if (undoStack.length > HISTORY_MAX) undoStack.shift();
              redoStack = [];
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
          if (row2 === div || !row2.parentNode || row2.style.display === 'none') continue;
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
            undoStack.push({
              tasks: snapTasks(),
              afterId: oldAfter,
              text: dragUiBefore ? String(dragUiBefore.text || '') : trailingText,
              indent: dragUiBefore ? dragUiBefore.indent : trailingIndent
            });
            if (undoStack.length > HISTORY_MAX) undoStack.shift();
            redoStack = [];
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
        if (di !== -1 && di !== oldPos) {
          applyDropIndent(box, sibs, di, kids);
        }
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
      persistLineOrder();
      setTimeout(function () {
        div.style.transition = '';
        div.style.transform = '';
        render();
      }, 220);
    }
    grip.addEventListener('pointerup', finish);
    grip.addEventListener('pointercancel', finish);
    grip.addEventListener('lostpointercapture', finish);
  }

  function renderLines() {
    var box = el('lines');
    if (!box || !state) return;
    box.innerHTML = '';
    var tasks = lineTasks();
    /* Полный порядок (включая выполненных) — для наследования зачёркивания:
     * done-родитель ушёл в секцию ниже, но детей зачёркивает. */
    var full = L.normalizeTasks(state.tasks).filter(function (t) { return !t.deleted && t.title; });
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
        hidden: L.isHiddenByCollapse(tasks, i, collapsed)
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
    /* Выполненные — под полем добавления, новые выше старых. */
    var done = L.doneList(state.tasks);
    if (done.length) {
      var sep = document.createElement('div');
      sep.className = 'done-sep';
      sep.textContent = 'Выполнено · ' + done.length;
      box.appendChild(sep);
    }
    for (var d = 0; d < done.length; d++) {
      box.appendChild(makeLine(done[d].id, done[d].title, false, lineIndent(done[d]), { doneShown: true }));
    }
    /* Раскрыть многострочные по содержимому (в потоке, после вставки). */
    var areas = box.querySelectorAll ? box.querySelectorAll('.tinput') : [];
    for (var q = 0; q < areas.length; q++) autosize(areas[q]);
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
    var s = el('status');
    if (!s || !state) return;
    var st = L.stats(state.tasks);
    var parts = [
      'Инбокс: ' + st.inbox,
      'следующих: ' + st.next,
      'синк: ' + (syncStatus || '—')
    ];
    if (lastAction) parts.push(lastAction);
    if (bootError) parts.push(bootError);
    s.textContent = parts.join(' · ');
  }

  function diagText() {
    var st = state ? L.stats(state.tasks) : {};
    return [
      'Внешний мозг ' + APP_VERSION,
      'Задач: инбокс ' + st.inbox + ', следующих ' + st.next + ', ожидание ' + st.waiting + ', когда-нибудь ' + st.someday + ', готово ' + st.done,
      'Лягушка: ' + (st.hasFrog ? 'есть' : 'нет'),
      'Синк: ' + (syncStatus || '—'),
      'Repo: ' + (state ? state.settings.repo : '?'),
      'Ключ: ' + (state && state.settings.token ? 'введён' : 'выключен (нет ключа)'),
      bootError ? bootError + ' ' + bootStack : 'Ошибок: нет'
    ].join('\n');
  }

  /* Удалить выполненные — с подтверждением (кнопка в шапке и в ⚙). */
  function askClearDone() {
    askConfirm('Удалить все выполненные задачи?').then(function (ok) {
      if (!ok) return;
      mutate(function () {
        L.doneList(state.tasks).forEach(function (t) { L.removeTask(state.tasks, t.id); });
      });
    });
  }

  function wire() {
    var gear = el('gearMenu');
    on('gearBtn', 'click', function () {
      if (gear) gear.classList.toggle('open');
      ensureTokenInput();
    });
    on('diagBtn', 'click', function () {
      askText(diagText(), '', false).then(function () {});
    });
    on('syncNowBtn', 'click', function () { doSync(true); });
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
    on('clearDone', 'click', function () { askClearDone(); });
    on('deleteDoneBtn', 'click', function () { askClearDone(); });
    on('collapseAllBtn', 'click', function () { setAllCollapsed(true); });
    on('expandAllBtn', 'click', function () { setAllCollapsed(false); });
    on('undoBtn', 'click', function () { doUndo(); });
    on('redoBtn', 'click', function () { doRedo(); });
    on('saveSettings', 'click', function () {
      var repo = el('repoInput');
      var tok = document.getElementById('tokenInput');
      mutate(function () {
        if (repo && repo.value) state.settings.repo = repo.value.trim();
        if (tok) state.settings.token = tok.value.trim();
      });
      var tw = el('tokenWrap');
      if (tw) tw.innerHTML = '';
      if (gear) gear.classList.remove('open');
      doSync(true);
    });
    /* Поле токена живёт в DOM только при открытых настройках: иначе Chrome
     * видит пару «текст + пароль» и предлагает сохранить токен как логин. */
    function ensureTokenInput() {
      var wrap = el('tokenWrap');
      if (!wrap || document.getElementById('tokenInput')) return;
      var inp = document.createElement('input');
      inp.id = 'tokenInput';
      inp.type = 'password';
      inp.placeholder = 'GitHub token';
      inp.autocomplete = 'off';
      if (state && state.settings.token) inp.value = state.settings.token;
      wrap.appendChild(inp);
    }
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
    window.addEventListener('online', function () { doSync(true); });
  }

  function setupPolling() {
    setInterval(function () {
      if (!document.hidden && navigator.onLine && state && state.settings.token) doSync();
    }, 60000);
  }

  function boot() {
    wire();
    loadCollapsed();
    window.EBStore.load().then(function (s) {
      state = s;
      var repo = el('repoInput');
      if (repo && state.settings.repo) repo.value = state.settings.repo;
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
