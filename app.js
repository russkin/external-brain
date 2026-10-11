/* app.js — интерфейс «Внешнего мозга»: список дел по аналогии с Google Keep
 * (строки, выполнение, время) + свои фичи: поиск, заливка и многократный
 * отступ вложенных, сворачивание/разворачивание, история, копии, инструкция. */
'use strict';

(function () {
  var APP_VERSION = 'v122';
  var INDENT_STEP = 28;
  var LINES_GAP = 8;
  var COLLAPSED_KEY = 'external-brain-collapsed-v1';
  var DONE_HIDDEN_KEY = 'external-brain-done-hidden-v1';
  var L = window.EBLogic;
  var state = null;
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
  /* История — модуль src/history.js (этап 4): стопки, слепки, отмена там.
   * Здесь тонкие алиасы, чтобы десятки вызовов в жестах и вводе
   * не трогать: реализация живёт в модуле. */
  function snapTasks() { return window.EBHistory.snapTasks(); }
  function snapFull() { return window.EBHistory.snapFull(); }
  function pushUndo(entry) { return window.EBHistory.pushUndo(entry); }
  function updateHistoryButtons() { return window.EBHistory.updateHistoryButtons(); }
  function mutateWithHistory(fn) { return window.EBHistory.mutateWithHistory(fn); }
  try { if (window.EBHistory) window.EBHistory.load(); } catch (x) {}

  /* doUndo/doRedo/applySnapshot — в модуле (вызываются из его init);
   * focusAfterHistory остаётся здесь (курсор — рядом с focusTaskEnd). */

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

  /* Синк и его триггеры — модуль src/triggers.js (этап 5): single-flight,
   * debounce 2 сек, фоновый опрос, возврат на вкладку, сеть, светофор,
   * проверка версии. Здесь тонкие алиасы, чтобы вызовы в save/renderStatus
   * и контексте настроек не трогать; своё состояние (флаги/статус/метки) — там. */
  function doSync(force) { return window.EBTriggers.doSync(force); }
  function scheduleSync() { return window.EBTriggers.scheduleSync(); }
  function renderNet() { window.EBTriggers.renderNet(); }
  function getSyncInfo() { return window.EBTriggers.getSync(); }

  /* --- Рендер --- */

  /* Отрисовка списка — модуль src/render.js (рефакторинг, этап 7):
   * здесь только тонкие алиасы, чтобы десятки вызовов во вводе, истории,
   * жестах и boot не трогать. Проводка ввода (wireLineInput) и мутации
   * черновика остались здесь и идут в модуль через контекст. */
  function render() {
    if (window.EBRender) window.EBRender.render();
  }
  function renderStatus() {
    if (window.EBRender) window.EBRender.renderStatus();
  }
  function focusTrailing() {
    if (window.EBRender) window.EBRender.focusTrailing();
  }
  function expandForAnchor(anchorId, indent) {
    if (window.EBRender) window.EBRender.expandForAnchor(anchorId, indent);
  }
  function autosize(ta) {
    if (window.EBRender) window.EBRender.autosize(ta);
  }
  function updateDurchip(inp, chip) {
    if (window.EBRender) window.EBRender.updateDurchip(inp, chip);
  }
  function refreshDurchips(box) {
    if (window.EBRender) window.EBRender.refreshDurchips(box);
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
  /* Тап по точкам — тоже действие для истории: иначе ↩ после разворота
   * одной группы откатывал бы 📁 целиком (разворачивал всё), а не возврат
   * этой группы. Шаг несёт вид до тапа; данные те же. */
  function toggleCollapse(id) {
    if (!id) return;
    var bvCollapsed = {}, k;
    for (k in collapsed) if (collapsed[k]) bvCollapsed[k] = true;
    var bvHidden = !!doneHidden;
    if (collapsed[id]) delete collapsed[id];
    else collapsed[id] = true;
    saveCollapsed();
    var e = snapFull();
    e.collapsed = bvCollapsed;
    e.doneHidden = bvHidden;
    pushUndo(e);
    updateHistoryButtons();
    render();
  }
  /* Свернуть/развернуть всё касается и секции выполненных — тоже флагом,
   * без обходов предков (обходы по createdAt-порядку для выполненных
   * бессмысленны: метки старые). Разделитель при этом работает как раньше. */
  /* Вид для истории: ↩ после 📁/📂 должен вернуть вид, а не только данные. */
  function setViewState(v) {
    if (!v || typeof v !== 'object') return;
    if (v.collapsed && typeof v.collapsed === 'object') {
      collapsed = {};
      for (var id in v.collapsed) if (v.collapsed[id]) collapsed[id] = true;
      saveCollapsed();
    }
    if (typeof v.doneHidden === 'boolean') {
      doneHidden = v.doneHidden;
      saveDoneHidden();
    }
  }
  function setAllCollapsed(all) {
    var bvCollapsed = {}, bvId;
    for (bvId in collapsed) if (collapsed[bvId]) bvCollapsed[bvId] = true;
    var bvHidden = !!doneHidden;
    collapsed = {};
    if (all && state) {
      var tasks = lineTasks();
      for (var i = 0; i < tasks.length; i++) {
        if (hasKidsFull(tasks[i].id)) collapsed[tasks[i].id] = true;
      }
    }
    saveCollapsed();
    doneHidden = !!all;
    saveDoneHidden();
    /* Шаг истории — только если вид реально изменился, иначе повторный
     * тап по 📁/📂 плодит пустые шаги и ↩ срабатывает вхолостую. */
    var same = (bvHidden === doneHidden), n = 0, m = 0, k;
    if (same) {
      for (k in bvCollapsed) if (bvCollapsed[k]) { n++; if (!collapsed[k]) same = false; }
      for (k in collapsed) if (collapsed[k]) m++;
      if (n !== m) same = false;
    }
    if (!same) {
      var e = snapFull();
      e.collapsed = bvCollapsed;
      e.doneHidden = bvHidden;
      pushUndo(e);
      updateHistoryButtons();
    }
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
  /* Тап по разделителю — обычный тумблер секции. Сворачивание групп
   * живых на секцию не влияет (см. выше): живые ветки тап не трогает. */
  function toggleDoneHidden() {
    doneHidden = !doneHidden;
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
  /* Окно коммита из черновика: пока задача рождается, сам черновик не
   * рисуем — иначе кадр успевает показать и задачу, и поле (дубль
   * на долю секунды). Счётчик (не флаг): создания вкладываются. */
  var draftCommitting = 0;

  /* Последний pointerdown (захват — до смены фокуса): по нему blur черновика
   * отличает «тап по флагу/грипу/строке» (у их жестов своя логика — не мешаем)
   * от настоящей потери фокуса (задача создаётся). */
  var lastPDTarget = null, lastPDts = 0;
  document.addEventListener('pointerdown', function (e) {
    lastPDTarget = e.target;
    lastPDts = Date.now();
  }, true);

  var draftBlurTimer = null;
  /* Жесты списка (свайп, drag за grip, отметка со слайдом) — модуль
   * src/gestures.js (рефакторинг, этап 6): здесь только тонкие алиасы,
   * чтобы вызовы в makeLine/mutate и контексте истории не трогать.
   * Флаг жеста живёт в модуле — render в mutate его спрашивает. */
  function wireLineSwipe(div, taskId) {
    if (window.EBGestures) window.EBGestures.wireLineSwipe(div, taskId);
  }
  function wireLineDrag(div, grip, inp) {
    if (window.EBGestures) window.EBGestures.wireLineDrag(div, grip, inp);
  }
  function toggleDoneSlide(taskId) {
    if (window.EBGestures) window.EBGestures.toggleDoneSlide(taskId);
  }
  function isDragActive() {
    return window.EBGestures ? window.EBGestures.isDragActive() : false;
  }
  /* Мосты черновика и гарда blur-создания в контекст модуля жестов:
   * сами переменные (якорь/текст/отступ, draftTapBusy, lastPD) остались
   * здесь — десятки читателей ввода их трогать не нужно. */
  function getDraft() {
    return { afterId: trailingAfterId, text: trailingText, indent: trailingIndent };
  }
  function setDraft(d) {
    trailingAfterId = d.afterId;
    trailingText = d.text;
    trailingIndent = d.indent;
  }
  function setDraftTapBusy(v) { draftTapBusy = !!v; }
  function touchLastPD(target) { lastPDTarget = target; lastPDts = Date.now(); }
  function isDraftCommitting() { return draftCommitting > 0; }

  /* Отступ строки в пикселях. Задача с отступом входит в группу задачи сверху. */
  function lineIndent(t) {
    var v = parseInt(t && t.indent, 10);
    if (!(v >= 0)) return 0;
    if (v > 8) return 8;
    return v;
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
    draftCommitting++;
    try {
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
    } finally { draftCommitting--; }
  }

  function insertTaskTop(title, now, allowEmpty) {
    draftCommitting++;
    try {
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
    } finally { draftCommitting--; }
  }

  function placeTaskAfter(prevId, title, indent, allowEmpty) {
    draftCommitting++;
    try {
    var title0 = String(title == null ? '' : title).trim();
    if (!title0 && !allowEmpty) return null;
    var now = Date.now();
    var created = null;
    mutate(function () {
      created = insertTaskAfter(prevId, title0, indent, now, allowEmpty);
    });
    return created;
    } finally { draftCommitting--; }
  }

  function placeTaskTop(title, allowEmpty) {
    draftCommitting++;
    try {
    var title0 = String(title == null ? '' : title).trim();
    if (!title0 && !allowEmpty) return null;
    var now = Date.now();
    var created = null;
    mutate(function () {
      created = insertTaskTop(title0, now, allowEmpty);
    });
    return created;
    } finally { draftCommitting--; }
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
      if (lastPDTarget.closest('.doneflag')) return;
      if (lastPDTarget.closest('.grip')) {
        /* Тап по чужому grip: набранное не теряем — тихо создаём задачу.
         * Без render (идёт жест, DOM под пальцем святой — dragActive его
         * подавляет в mutate); флаг — нет: у его тапа своя логика. */
        if (title) {
          placeTaskAfter(trailingAnchorId(), title, indent, true);
          trailingText = '';
          trailingAfterId = null;
          trailingIndent = null;
        }
        return;
      }
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
      if (r === 'removed') { if (!isDragActive()) render(); }
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
        expandForAnchor(newAnchor, newIndent);
      }
      render();
      focusTrailing();
    });
  }

  /* Дата локальной копии (store.js) для диагностики. */
  function fmtWhen(ms) {
    try { return new Date(ms).toLocaleString('ru-RU'); } catch (x) { return 'есть'; }
  }
  /* Текст диагностики и журнал — модуль src/diag.js (этап 2).
   * Здесь остаются только общая модалка (showInfo/shareDiag) и fmtWhen
   * (нужен ещё диалогам пинов). */

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

  /* Поиск — отдельным модулем src/search.js (рефакторинг, этап 1):
   * состояние внутри модуля, общее — только через контекст в init.
   * Подсветка дотягивается из render() через EBSearch.currentId(). */

  function wire() {
    /* Настройки — модуль src/settings.js (этап 3): меню ⚙, подменю копий,
     * модалка репозитория. Сюда отдаём только контекст. */
    if (window.EBSettings) window.EBSettings.init({
      on: on,
      getState: function () { return state; },
      mutate: mutate,
      askConfirm: askConfirm,
      doSync: doSync
    });
    /* Диагностика — модуль src/diag.js (этап 2): кнопка и текст там,
     * сюда отдаём только контекст. */
    if (window.EBDiag) window.EBDiag.init({
      on: on, L: L, showInfo: showInfo, renderStatus: renderStatus, fmtWhen: fmtWhen,
      getState: function () { return state; },
      getVersion: function () { return APP_VERSION; },
      getSync: getSyncInfo,
      getLastAction: function () { return lastAction; },
      getBoot: function () { return { error: bootError, stack: bootStack }; },
      getHistoryCounts: function () { return window.EBHistory.counts(); },
      getCollapsed: function () { return collapsed; },
      isDoneHidden: function () { return doneHidden; }
    });

    /* Триггеры синка — модуль src/triggers.js (этап 5): кнопки синка,
     * светофор, возврат на вкладку, сеть. Сюда отдаём только контекст. */
    if (window.EBTriggers) window.EBTriggers.init({
      on: on,
      getState: function () { return state; },
      render: render,
      renderStatus: renderStatus,
      askConfirm: askConfirm,
      getVersion: function () { return APP_VERSION; }
    });

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
    /* Поиск — модуль src/search.js (этап 1): подписки внутри init,
     * сюда отдаём только контекст (всё изменяемое — через геттеры). */
    if (window.EBSearch) window.EBSearch.init({
      on: on, L: L, render: render,
      getState: function () { return state; },
      lineTasks: lineTasks, lineIndent: lineIndent,
      getCollapsed: function () { return collapsed; },
      saveCollapsed: saveCollapsed,
      isDoneHidden: function () { return doneHidden; },
      toggleDoneHidden: toggleDoneHidden
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
            /* Пропавшие хоронятся tombstone'ом, иначе синк воскресит их. */
            state.tasks = L.restoreWithTombstones(state.tasks, restored.tasks, Date.now());
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
            /* Пропавшие хоронятся tombstone'ом, иначе синк воскресит их. */
            state.tasks = L.restoreWithTombstones(state.tasks, restored.tasks, Date.now());
            state.updatedAt = Date.now();
          });
          lastAction = 'постоянная копия восстановлена';
          renderStatus();
        });
    });
    on('collapseAllBtn', 'click', function () { setAllCollapsed(true); });
    on('expandAllBtn', 'click', function () { setAllCollapsed(false); });
    /* История — модуль src/history.js (этап 4): кнопки и логика там,
     * сюда отдаём только контекст. */
    if (window.EBHistory) window.EBHistory.init({
      on: on, L: L, save: save, render: render, focusAfterHistory: focusAfterHistory,
      getState: function () { return state; },
      getDraft: getDraft,
      setDraft: setDraft,
      isDragActive: isDragActive,
      getCollapsed: function () { return collapsed; },
      isDoneHidden: function () { return doneHidden; },
      setViewState: setViewState
    });
    /* Жесты списка — модуль src/gestures.js (этап 6): свайп, drag за grip,
     * отметка со слайдом, сохранение порядка. Сюда отдаём только контекст. */
    if (window.EBGestures) window.EBGestures.init({
      L: L,
      getState: function () { return state; },
      render: render,
      save: save,
      mutate: mutate,
      lineIndent: lineIndent,
      lineTasks: lineTasks,
      effTrailingIndent: effTrailingIndent,
      trailingAnchorId: trailingAnchorId,
      getDraft: getDraft,
      setDraft: setDraft,
      getCollapsed: function () { return collapsed; },
      saveCollapsed: saveCollapsed,
      hasKidsFull: hasKidsFull,
      toggleCollapse: toggleCollapse,
      toggleDoneNow: toggleDoneNow,
      placeTaskAfter: placeTaskAfter,
      insertTaskTop: insertTaskTop,
      insertTaskAfter: insertTaskAfter,
      focusTrailing: focusTrailing,
      openDuration: openDuration,
      snapFull: snapFull,
      snapTasks: snapTasks,
      pushUndo: pushUndo,
      updateHistoryButtons: updateHistoryButtons,
      setDraftTapBusy: setDraftTapBusy,
      touchLastPD: touchLastPD,
      INDENT_STEP: INDENT_STEP,
      LINES_GAP: LINES_GAP
    });
    /* Отрисовка списка — модуль src/render.js (этап 7): строки, порядок,
     * секция выполненных, статус. Сюда отдаём только контекст. */
    if (window.EBRender) window.EBRender.init({
      L: L,
      getState: function () { return state; },
      getVersion: function () { return APP_VERSION; },
      renderNet: renderNet,
      getSyncInfo: getSyncInfo,
      getLastAction: function () { return lastAction; },
      getBoot: function () { return { error: bootError, stack: bootStack }; },
      updateHistoryButtons: updateHistoryButtons,
      lineTasks: lineTasks,
      fullList: fullList,
      lineIndent: lineIndent,
      effTrailingIndent: effTrailingIndent,
      getDraft: getDraft,
      setDraft: setDraft,
      isDraftCommitting: isDraftCommitting,
      getCollapsed: function () { return collapsed; },
      isDoneHidden: function () { return doneHidden; },
      toggleDoneHidden: toggleDoneHidden,
      snapFull: snapFull,
      pushUndo: pushUndo,
      wireLineInput: wireLineInput,
      tapDraftFlag: tapDraftFlag,
      openDuration: openDuration,
      toggleDoneSlide: toggleDoneSlide,
      wireLineSwipe: wireLineSwipe,
      wireLineDrag: wireLineDrag,
      INDENT_STEP: INDENT_STEP
    });
    /* Стрелки модалки времени (часы ±60, минуты ±5 от общего итога). */
    on('durHp', 'click', function () { durTot = Math.min(durTot + 60, 59999); durRender(); });
    on('durHm', 'click', function () { durTot = Math.max(durTot - 60, 0); durRender(); });
    on('durMp', 'click', function () { durTot = Math.min(durTot + 5, 59999); durRender(); });
    on('durMm', 'click', function () { durTot = Math.max(durTot - 5, 0); durRender(); });

    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      window._deferredPrompt = e;
    });
    /* Возврат на вкладку/сеть — подписки модуля triggers (этап 5):
     * три события возврата (в т.ч. bfcache), online/offline/connection. */
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
    /* Журнал — модуль (этап 2); метки движка забирает модуль триггеров. */
    try { window.EBTriggers.restoreLog(window.EBDiag.load()); } catch (x) {}
    window.EBStore.load().then(function (s) {
      state = s;
      /* Первая загрузка новой версии: авто-пин «перед обновлением». */
      try {
        if (window.EBStore.pinOnVersion) window.EBStore.pinOnVersion(APP_VERSION);
      } catch (e) {}
      render();
      /* Светофор/статус/первый синк/проверка версии/опрос — модуль
       * триггеров (этап 5); статус строки рисуем после. */
      if (window.EBTriggers) window.EBTriggers.onReady();
      renderStatus();
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
