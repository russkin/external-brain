/* app.js — интерфейс «Внешнего мозга»: инбокс + прояснение по джедайским техникам. */
'use strict';

(function () {
  var APP_VERSION = 'v9';
  var INDENT_STEP = 28;
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
    var r = fn();
    render();
    save();
    return r;
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
    var v = el('appVerHead');
    if (v) v.textContent = APP_VERSION;
    var v2 = el('appVer');
    if (v2) v2.textContent = APP_VERSION;
    renderLines();
    renderStatus();
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
    g.title = 'Перетащить (вверх/вниз — порядок, вправо/влево — отступ)';
    g.setAttribute('aria-label', 'Перетащить');
    for (var i = 0; i < 6; i++) {
      var d = document.createElement('span');
      d.className = 'dot';
      g.appendChild(d);
    }
    return g;
  }

  /* Отступ строки в пикселях. Задача с отступом входит в группу задачи сверху. */
  function lineIndent(t) {
    var v = parseInt(t && t.indent, 10);
    if (!(v >= 0)) return 0;
    if (v > 8) return 8;
    return v;
  }

  function makeLine(taskId, value, isTrailing, indent) {
    var div = document.createElement('div');
    div.className = 'tline';
    if (taskId) div.setAttribute('data-id', taskId);
    else div.setAttribute('data-trailing', '1');
    indent = lineIndent({ indent: indent });
    if (indent) div.style.marginLeft = (indent * INDENT_STEP) + 'px';
    var grip = makeGrip();
    div.appendChild(grip);
    var inp = document.createElement('input');
    inp.className = 'tinput';
    inp.value = value || '';
    inp.placeholder = 'Новая задача…';
    inp.autocomplete = 'off';
    inp.setAttribute('aria-label', 'Задача');
    div.appendChild(inp);
    wireLineInput(div, inp, taskId, isTrailing, indent);
    wireLineDrag(div, grip, inp);
    return div;
  }

  function commitLine(taskId, value, isTrailing, indent) {
    var title = String(value == null ? '' : value).trim();
    if (isTrailing || !taskId) {
      if (!title) return null;
      var created = null;
      /* Новая строка наследует отступ строки сверху — так собираются группы. */
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
      if (isTrailing || !taskId) return;
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
      if (r === 'removed') render();
      else renderStatus();
    });
    inp.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (isTrailing) {
        var created = commitLine(null, inp.value, true, indent);
        if (created) {
          render();
          focusTrailing();
        }
        return;
      }
      commitLine(taskId, inp.value, false);
      render();
      focusLineAfter(taskId);
    });
  }

  function persistLineOrder() {
    var box = el('lines');
    if (!box || !state) return;
    var ids = [];
    var rows = box.querySelectorAll ? box.querySelectorAll('.tline[data-id]') : [];
    for (var i = 0; i < rows.length; i++) {
      var id = rows[i].getAttribute('data-id');
      if (id && L.getTask(state.tasks, id)) ids.push(id);
    }
    if (!ids.length) return;
    /* Порядок не менялся (тап без движения) — метки не трогаем, синк не дёргаем. */
    var cur = lineTasks().map(function (t) { return t.id; });
    if (cur.length === ids.length) {
      var same = true;
      for (var k = 0; k < ids.length; k++) {
        if (ids[k] !== cur[k]) { same = false; break; }
      }
      if (same) return;
    }
    var now = Date.now();
    var byId = {};
    state.tasks.forEach(function (t) { if (t) byId[t.id] = t; });
    var ordered = [];
    ids.forEach(function (id) { if (byId[id]) { ordered.push(byId[id]); delete byId[id]; } });
    Object.keys(byId).forEach(function (id) { ordered.push(byId[id]); });
    var base = now - ordered.length;
    ordered.forEach(function (t, i) { t.createdAt = base + i; t.ts = now; t.updatedAt = now; });
    state.tasks = ordered;
    save();
  }

  /* Перетаскивание за grip двумя жестами (Pointer Events — мышь и тач):
   * - вверх/вниз: плавный вертикальный drag (призрак + соседи едут);
   * - вправо/влево: сдвиг на ширину отступа — задача входит в группу
   *   задачи сверху (уровень не глубже соседа сверху +1, первая — всегда 0).
   * Направление определяется первым движением: горизонталь (|dx|>|dy|*2). */
  function wireLineDrag(div, grip, inp) {
    var pid = null, grabDy = 0, x0 = 0, y0 = 0, mode = null, lastDx = 0;
    var order = null, shift = {}, ghost = null;
    var indentCur = 0, indentMax = 0;
    function rowsOf(box) {
      return Array.prototype.slice.call(box.querySelectorAll('.tline'));
    }
    function myTask() {
      var id = div.getAttribute ? div.getAttribute('data-id') : null;
      return id ? L.getTask(state.tasks, id) : null;
    }
    /* Потолок отступа: первая строка — 0, иначе отступ соседа сверху +1. */
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
      cur = mine ? lineIndent(mine) : 0;
      var max = first ? 0 : prev + 1;
      if (max > 8) max = 8;
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
      if (!box || !document.body) return;
      mode = 'vertical';
      shift = {};
      var rect = null;
      try { rect = div.getBoundingClientRect(); } catch (x) { rect = null; }
      var h = rect ? rect.height : div.offsetHeight || 56;
      grabDy = rect ? (e.clientY - rect.top) : h / 2;
      order = rowsOf(box);
      /* Призрак едет, оригинал держит место — список не прыгает на захвате. */
      ghost = div.cloneNode(true);
      ghost.removeAttribute('data-id');
      ghost.removeAttribute('data-trailing');
      ghost.classList.add('dragging');
      ghost.style.position = 'fixed';
      ghost.style.width = (rect ? rect.width : div.offsetWidth) + 'px';
      ghost.style.left = (rect ? rect.left : 0) + 'px';
      ghost.style.top = (e.clientY - grabDy) + 'px';
      ghost.style.margin = '0';
      ghost.style.pointerEvents = 'none';
      var gInp = ghost.querySelector ? ghost.querySelector('.tinput') : null;
      if (gInp) { gInp.setAttribute('readonly', 'readonly'); gInp.tabIndex = -1; }
      document.body.appendChild(ghost);
      div.style.visibility = 'hidden';
      box.classList.add('drag-active');
    }
    grip.addEventListener('pointerdown', function (e) {
      if (pid != null) return;
      if (e.button != null && e.button !== 0) return;
      var box = el('lines');
      if (!box) return;
      pid = e.pointerId;
      x0 = e.clientX;
      y0 = e.clientY;
      lastDx = 0;
      mode = null;
      try { grip.setPointerCapture(pid); } catch (x) {}
      if (e.cancelable) e.preventDefault();
    });
    grip.addEventListener('pointermove', function (e) {
      if (pid == null || e.pointerId !== pid) return;
      var dx = e.clientX - x0;
      var dy = e.clientY - y0;
      if (!mode) {
        if (Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy) * 2) {
          if (!myTask()) return;
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
      if (!order || !ghost) return;
      ghost.style.top = (e.clientY - grabDy) + 'px';
      var d = null;
      try { d = ghost.getBoundingClientRect(); } catch (x) { return; }
      var idx = order.indexOf(div);
      for (var i = 0; i < order.length; i++) {
        var row = order[i];
        if (row === div || !row.parentNode) continue;
        var r = row.getBoundingClientRect();
        var off = 0;
        if (i > idx) {
          /* Сосед снизу: низ призрака въехал в него — едет вверх под него. */
          var pen = d.bottom - r.top;
          if (pen > 0) off = -Math.min(pen, r.height + 10);
        } else {
          /* Сосед сверху: верх призрака въехал в него — едет вниз под него. */
          var pen2 = r.bottom - d.top;
          if (pen2 > 0) off = Math.min(pen2, r.height + 10);
        }
        shift[i] = off;
        if (off) {
          row.style.transition = 'none';
          row.style.transform = 'translateY(' + off + 'px)';
        } else {
          row.style.transition = '';
          row.style.transform = '';
        }
      }
      /* Автопрокрутка у краёв экрана. */
      try {
        if (e.clientY < 90) window.scrollBy(0, -10);
        else if (e.clientY > (window.innerHeight || 800) - 90) window.scrollBy(0, 10);
      } catch (x) {}
      if (e.cancelable) e.preventDefault();
    });
    function finish(e) {
      if (pid == null) return;
      if (e && e.pointerId != null && e.pointerId !== pid) return;
      pid = null;
      if (mode === 'indent') {
        mode = null;
        div.style.transition = '';
        div.style.transform = '';
        var bou = indentBounds();
        var lvl = bou.cur + Math.round(lastDx / INDENT_STEP);
        if (lvl < 0) lvl = 0;
        if (lvl > bou.max) lvl = bou.max;
        var task = myTask();
        if (task && lvl !== bou.cur) {
          (function (id, l) {
            mutate(function () { L.setIndent(state.tasks, id, l); });
          })(task.id, lvl);
        }
        render();
        return;
      }
      mode = null;
      var box = el('lines');
      var firstTop = null, firstH = 0;
      if (ghost) {
        try {
          var gr = ghost.getBoundingClientRect();
          firstTop = gr.top;
          firstH = gr.height;
        } catch (x) { firstTop = null; }
        if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
      }
      ghost = null;
      div.style.visibility = '';
      /* Итоговое место: сколько соседей (по их местам в покое) выше центра. */
      var cy = (firstTop != null) ? firstTop + firstH / 2 : 0;
      var below = [];
      if (box && order) {
        for (var i = 0; i < order.length; i++) {
          var row = order[i];
          if (row === div || !row.parentNode) continue;
          var r = row.getBoundingClientRect();
          var rest = r.top - (shift[i] || 0);
          if (rest + r.height / 2 < cy) below.push(row);
        }
        /* Переставляем строку в потоке на итоговое место. */
        if (below.length) box.insertBefore(div, below[below.length - 1].nextSibling);
        else box.insertBefore(div, box.firstChild);
      }
      div.classList.remove('dragging');
      /* Мягкая посадка: все доезжают 200мс, затем сохраняем и рисуем. */
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
              div.style.transition = 'transform .2s ease';
              div.style.transform = '';
            }
          }
        }
        for (var j = 0; j < order.length; j++) {
          var rw = order[j];
          if (rw === div || !rw.parentNode) continue;
          if (shift[j]) {
            rw.style.transition = 'transform .2s ease';
            rw.style.transform = '';
          }
        }
        box.classList.remove('drag-active');
      }
      order = null;
      shift = {};
      setTimeout(function () {
        div.style.transition = '';
        div.style.transform = '';
        persistLineOrder();
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
    tasks.forEach(function (t) {
      box.appendChild(makeLine(t.id, t.title, false, lineIndent(t)));
    });
    /* Хвостовая пустая строка наследует отступ последней — группы растут сами. */
    var tail = tasks.length ? lineIndent(tasks[tasks.length - 1]) : 0;
    box.appendChild(makeLine(null, '', true, tail));
  }

  function focusTrailing() {
    var box = el('lines');
    if (!box || !box.querySelector) return;
    var inp = box.querySelector('.tline[data-trailing] .tinput');
    if (inp && inp.focus) {
      try { inp.focus(); } catch (x) {}
    }
  }

  function focusLineAfter(taskId) {
    var box = el('lines');
    if (!box || !box.querySelectorAll) { focusTrailing(); return; }
    var rows = box.querySelectorAll('.tline');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute && rows[i].getAttribute('data-id') === taskId) {
        var next = rows[i + 1];
        var inp = next ? next.querySelector('.tinput') : null;
        if (inp && inp.focus) { try { inp.focus(); return; } catch (x) {} }
        break;
      }
    }
    focusTrailing();
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
    on('clearDone', 'click', function () {
      askConfirm('Удалить все выполненные задачи?').then(function (ok) {
        if (!ok) return;
        mutate(function () {
          L.doneList(state.tasks).forEach(function (t) { L.removeTask(state.tasks, t.id); });
        });
      });
    });
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
