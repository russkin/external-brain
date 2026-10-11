/* render.js — отрисовка списка: построение строк (makeLine/makeGrip),
 * проводка уже созданных строк жестами и вводом, пересчёт меток времени,
 * порядок строк и секция выполненных (renderLines), статусная строка,
 * фокус черновика и разворот предков при создании.
 * Вынесено из app.js (рефакторинг, этап 7): код перенесён как есть.
 * В app.js остались тонкие алиасы (render/renderStatus/focusTrailing/
 * expandForAnchor/autosize/updateDurchip/refreshDurchips), чтобы десятки
 * вызовов во вводе, истории, жестах и boot не трогать. Проводка ввода
 * (wireLineInput) и мутации черновика остались в app.js и идут сюда
 * через контекст.
 * Своё состояние модуль не держит (карта свёрнутых, черновик, doneHidden —
 * в app.js, читаются через геттеры контекста).
 * UMD: браузер (window.EBRender) + Node (module.exports) для тестов.
 *
 * Контекст ctx: L, getState, getVersion, renderNet, getSyncInfo,
 *   getLastAction, getBoot, updateHistoryButtons, lineTasks, fullList,
 *   lineIndent, getCollapsed, isDoneHidden, toggleDoneHidden, snapFull,
 *   pushUndo, wireLineInput, deleteEmptyTask, openDuration, toggleDoneSlide,
 *   wireLineSwipe, wireLineDrag, INDENT_STEP —
 *   стабильные ссылки; изменяемое (state, черновик, карта свёрнутых)
 *   только через геттеры. L/INDENT_STEP фиксируются в init.
 */
(function () {
'use strict';

function el(id) { return document.getElementById(id); }

var C = null;
var L = null;
var INDENT_STEP = 0;

function render() {
  var state = C.getState();
  if (!state) return;
  /* Позиция страницы: перестроение схлопывает список на кадр и браузер
   * увозит скролл наверх — запоминаем и возвращаем обратно. */
  var keepY = 0;
  try { keepY = window.pageYOffset || document.documentElement.scrollTop || 0; } catch (x) { keepY = 0; }
  var v = el('appVerHead');
  if (v) v.textContent = C.getVersion();
  var v2 = el('appVer');
  if (v2) v2.textContent = C.getVersion();
  renderLines();
  renderStatus();
  C.updateHistoryButtons();
  /* Подсветка поиска переживает перерисовки (фоновый синк): строка
   * та же (по id), скролл не трогаем — только класс. Состояние живёт
   * в модуле поиска (этап 1), модуля может не быть — гард. */
  if (window.EBSearch) {
    var sid = window.EBSearch.currentId();
    if (sid) window.EBSearch.applySearchHit(sid);
  }
  try {
    var curY = window.pageYOffset || 0;
    if (curY !== keepY) window.scrollTo(0, keepY);
  } catch (x) {}
}

/* Разворот при создании через Enter — на уровне модуля (а не внутри
 * wireLineDrag): вызывается из обработчика Enter, где замыкания жеста
 * не видно (иначе ReferenceError роняет создание поля целиком). */
function expandForAnchor(anchorId, indent) {
  var state = C.getState();
  var collapsed = C.getCollapsed();
  if (!anchorId || anchorId === 'TOP' || !(indent > 0)) return;
  var box = el('lines');
  if (!box || !box.querySelectorAll) return;
  var rows = Array.prototype.slice.call(box.querySelectorAll('.tline'));
  var ai = -1, i;
  for (i = 0; i < rows.length; i++) {
    var aid = rows[i].getAttribute ? rows[i].getAttribute('data-id') : null;
    if (aid === anchorId) { ai = i; break; }
  }
  if (ai === -1) return;
  var minInd = indent, changed = false;
  for (i = ai; i >= 0; i--) {
    var pid = rows[i].getAttribute ? rows[i].getAttribute('data-id') : null;
    var pt = pid ? L.getTask(state.tasks, pid) : null;
    if (!pt) continue;
    var ind = C.lineIndent(pt);
    if (ind < minInd) {
      minInd = ind;
      if (collapsed[pt.id]) { delete collapsed[pt.id]; changed = true; }
    }
  }
  if (changed) C.saveCollapsed();
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

/* Метка времени строки (opts.estMin в makeLine): у обычной задачи — своё
 * estMin; у РОДИТЕЛЯ — авто-сумма первого вложения (дети уровня indent+1;
 * у вложенных-родителей — их такая же сумма, т.е. итог по всем своим).
 * Выполненные вложения в сумму НЕ входят (v71): чип родителя — только
 * остаток невыполненного; когда всё закрыто — сумма 0 и метки нет.
 * Своё estMin родителя в вёрстку не идёт — ему время ставить нельзя
 * (openDuration закрыт), данные не трогаем на случай расформировки группы:
 * без детей задача снова показывает своё время. Появление метки у родителя
 * — только если сумма > 0 (хотя бы у одной задачи первого вложения
 * задано время).
 * Флаг «Суммировать из вложенных» снят (sumKids === false) — родитель
 * показывает своё estMin вручную, как лист, поддерево не считается. */
function lineEstMin(t) {
  if (!t) return 0;
  var full = C.fullList();
  var pi = -1;
  for (var i = 0; i < full.length; i++) {
    if (full[i].id === t.id) { pi = i; break; }
  }
  if (pi === -1 || !L.hasKids(full, pi) || t.sumKids === false) return t.estMin || 0;
  var pin = C.lineIndent(full[pi]);
  var sum = 0;
  for (var j = pi + 1; j < full.length; j++) {
    var ij = C.lineIndent(full[j]);
    if (ij <= pin) break;
    if (full[j].status === 'done') continue;
    if (ij === pin + 1) sum += lineEstMin(full[j]);
  }
  return sum;
}

function makeLine(taskId, value, indent, opts) {
  opts = opts || {};
  var div = document.createElement('div');
  div.className = 'tline';
  div.setAttribute('data-id', taskId);
  indent = C.lineIndent({ indent: indent });
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
  inp.placeholder = '…';
  inp.autocomplete = 'off';
  inp.setAttribute('aria-label', 'Задача');
  if (opts.doneShown) inp.classList.add('is-done');
  body.appendChild(inp);
  autosize(inp);
  /* Пустая строка (кроме выполненных): вместо «✓ Выполнено» — «✕ Удалить».
   * Пустота для поведения — по живому тексту поля в момент тапа (набранное,
   * но не сохранённое за 800 мс, удалять нельзя); текст кнопки — на момент
   * отрисовки и может отставать на кадр. */
  var rowEmpty = !opts.doneShown && !String(value || '').trim();
  var flag = document.createElement('button');
  flag.className = 'doneflag';
  if (opts.doneShown) {
    flag.textContent = '↩ Не выполнено';
    flag.setAttribute('aria-label', 'Вернуть в работу');
  } else if (rowEmpty) {
    flag.textContent = '✕ Удалить';
    flag.setAttribute('aria-label', 'Удалить строку');
  } else {
    flag.textContent = '✓ Выполнено';
    flag.setAttribute('aria-label', 'Отметить выполненной');
  }
  (function (id, fl, field, noDel) {
    /* Тап срабатывает и по click, и по pointerup: если браузер съел
     * одно событие — дойдёт второе. Двойное выполнение отсекает guard
     * внутри toggleDoneSlide (удаление идемпотентно через deleted). */
    var flagDownX = 0, flagDownY = 0, flagDown = false;
    fl.addEventListener('pointerdown', function (ev) {
      flagDownX = ev.clientX;
      flagDownY = ev.clientY;
      flagDown = true;
    });
    function flagGo(ev) {
      if (!flagDown) return;
      flagDown = false;
      if (ev && (Math.abs(ev.clientX - flagDownX) > 12 || Math.abs(ev.clientY - flagDownY) > 12)) return;
      var live = field && field.value != null ? String(field.value).trim() : '';
      if (!noDel && !live) { C.deleteEmptyTask(id); return; }
      C.toggleDoneSlide(id);
    }
    fl.addEventListener('pointerup', flagGo);
    fl.addEventListener('pointercancel', function () { flagDown = false; });
    fl.addEventListener('click', function () { flagGo(null); });
  })(taskId, flag, inp, !!opts.doneShown);
  div.appendChild(flag);
  C.wireLineSwipe(div, taskId);
  /* Метка времени — НАЛОЖЕНИЕ в правом нижнем углу поля задачи
   * (position: absolute против .tline): тап — та же модалка, что свайп
   * вправо. Фон прозрачный, пока текст не доходит до метки (см.
   * updateDurchip — при пересчёте становится непрозрачным). Пустое
   * время (estMin=0) — метки нет, угол поля свободен. */
  if (taskId && opts.estMin > 0) {
    var chip = document.createElement('button');
    chip.className = 'durchip';
    chip.type = 'button';
    chip.textContent = L.fmtDur(opts.estMin);
    chip.setAttribute('aria-label', 'Время задачи: ' + L.fmtDur(opts.estMin));
    (function (id, c) {
      c.addEventListener('click', function (ev) {
        ev.stopPropagation();
        C.openDuration(id);
      });
    })(taskId, chip);
    body.appendChild(chip);
  }
  C.wireLineInput(div, inp, taskId, indent);
  C.wireLineDrag(div, grip, inp);
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

function renderLines() {
  var state = C.getState();
  var collapsed = C.getCollapsed();
  var box = el('lines');
  if (!box || !state) return;
  box.innerHTML = '';
  var tasks = C.lineTasks();
  /* Полный порядок (включая выполненных) — для наследования зачёркивания:
   * done-родитель ушёл в секцию ниже, но детей зачёркивает. */
  var full = C.fullList();
  var fullIdx = {};
  for (var fi = 0; fi < full.length; fi++) fullIdx[full[fi].id] = fi;
  function taskRow(t, i) {
    return makeLine(t.id, t.title, C.lineIndent(t), {
      doneShown: L.isDoneShown(full, fullIdx[t.id]),
      hidden: L.isHiddenByCollapse(tasks, i, collapsed),
      estMin: lineEstMin(t)
    });
  }
  for (var i = 0; i < tasks.length; i++) {
    box.appendChild(taskRow(tasks[i], i));
  }
  /* Выполненные — под полем добавления, новые выше старых. Сворачивание
   * групп секцию НЕ прячет: видимость — только тумблером разделителя.
   * (Прятали обходом предков по createdAt-порядку, но у выполненных метки
   * старые — позиции бессмысленны: тап разворачивал чужие живые ветки,
   * а выполненные оставались скрыты.) */
  var done = L.doneList(state.tasks);
  var doneVis = done.slice();
  if (done.length) {
    var sep = document.createElement('div');
    sep.className = 'done-sep';
    /* Тап — скрыть/показать все выполненные разом. Стрелка показывает
     * состояние (▸ скрыты, ▾ видны), разделитель в скрытом состоянии
     * остаётся: он же точка возврата и кламп дыры при перетаскивании. */
    sep.textContent = 'Выполнено · ' + done.length + (C.isDoneHidden() ? ' ▸' : ' ▾');
    sep.setAttribute('title', C.isDoneHidden() ? 'Показать выполненные' : 'Скрыть выполненные');
    /* Тап — тоже шаг истории (как 📁/точки): иначе ↩ после показа
     * секции вернул бы более раннее действие, а не скрытие. */
    sep.addEventListener('click', function () {
      var bvCollapsed = {}, bvId;
      for (bvId in collapsed) if (collapsed[bvId]) bvCollapsed[bvId] = true;
      var bvHidden = !!C.isDoneHidden();
      C.toggleDoneHidden();
      var e = C.snapFull();
      e.collapsed = bvCollapsed;
      e.doneHidden = bvHidden;
      C.pushUndo(e);
      C.updateHistoryButtons();
    });
    box.appendChild(sep);
    if (!C.isDoneHidden()) {
      for (var dv = 0; dv < doneVis.length; dv++) {
        box.appendChild(makeLine(doneVis[dv].id, doneVis[dv].title, C.lineIndent(doneVis[dv]), { doneShown: true, estMin: lineEstMin(doneVis[dv]) }));
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

/* Шапка над клавиатурой: в оверлейном режиме (iOS Safari, часть Android)
 * браузер везёт к полю ВИЗУАЛЬНЫЙ вьюпорт (visualViewport.offsetTop > 0),
 * а липкая шапка привязана к верху РАСКЛАДКИ — и уезжает вверх за экран,
 * когда работаешь с задачей в нижней половине списка. Пока идёт набор
 * (фокус в поле), дотягиваем шапку вниз на величину сдвига; без клавиатуры
 * и вне набора — без transform. Как searchLift в src/search.js. */
var lastHeadLift = null;
function syncHeaderLift() {
  var h = null;
  try { h = document.querySelector('header'); } catch (x) { h = null; }
  if (!h || !h.style) return;
  var off = 0;
  try {
    var ae = document.activeElement;
    if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT') && window.visualViewport) {
      off = Math.round(window.visualViewport.offsetTop || 0);
      if (!(off > 1)) off = 0;
    }
  } catch (x) { off = 0; }
  var lift = off ? 'translateY(' + off + 'px)' : '';
  if (lift === lastHeadLift) return;
  lastHeadLift = lift;
  h.style.transform = lift;
}

/* Активная строка — в центр видимого места: браузер подвозит поле минимумом,
 * и оно остаётся под шапкой или под клавиатурой, а работать надо глазами.
 * На focusin (браузерный скролл ещё не отработал — полю уже видно, ему
 * нечего двигать) подвозим страницу так, чтобы середина поля встала
 * в середину видимой области. Только если поле реально перекрыто
 * (верх — под шапкой, низ — под клавиатурой); уже видимое не трогаем.
 * Только строки задач (.tline): модалки и поиск живут своей жизнью. */
function centerActiveLine() {
  var ae = null;
  try { ae = document.activeElement; } catch (x) { ae = null; }
  if (!ae || !ae.getBoundingClientRect) return;
  if (ae.tagName !== 'TEXTAREA' && ae.tagName !== 'INPUT') return;
  var row = null;
  try { row = ae.closest ? ae.closest('.tline') : null; } catch (x) { row = null; }
  if (!row) return;
  var r = ae.getBoundingClientRect();
  var fh = r.height || 0;
  if (!(fh > 0)) return;
  var vv = null;
  try { vv = window.visualViewport || null; } catch (x) { vv = null; }
  /* rect — от верха раскладки, видимая позиция — минус пан клавиатуры. */
  var pan = vv ? (vv.offsetTop || 0) : 0;
  var vh = vv ? (vv.height || 0) : 0;
  if (!(vh > 0)) vh = window.innerHeight || 0;
  if (!(vh > 0)) return;
  var h = null;
  try { h = document.querySelector('header'); } catch (x) { h = null; }
  var hh = 0;
  try { hh = h && h.offsetHeight ? h.offsetHeight : 0; } catch (x) { hh = 0; }
  var gap = 8;
  var visTop = r.top - pan;
  var visBottom = visTop + fh;
  if (visTop >= hh + gap && visBottom <= vh - gap) return;
  var y = 0;
  try { y = window.pageYOffset || 0; } catch (x) { y = 0; }
  var target;
  if (fh > vh - hh - gap * 2) {
    /* Поле выше видимого места: верх — под шапку с зазором. */
    target = y + r.top - (hh + gap);
  } else {
    target = y + r.top + fh / 2 - (pan + vh / 2);
  }
  try { window.scrollTo(0, Math.round(target)); } catch (x) {}
}

function renderStatus() {
  var state = C.getState();
  C.renderNet();
  var s = el('status');
  if (!s || !state) return;
  var st = L.stats(state.tasks);
  var parts = [
    'Задач: ' + ((st.inbox || 0) + (st.next || 0)),
    'выполненных: ' + (st.done || 0),
    'синхр: ' + (C.getSyncInfo().status || '—')
  ];
  var la = C.getLastAction();
  if (la) parts.push(la);
  var be = C.getBoot().error;
  if (be) parts.push(be);
  s.textContent = parts.join(' · ');
}

function init(ctx) {
  C = ctx;
  L = ctx.L;
  INDENT_STEP = ctx.INDENT_STEP;
  /* Клавиатура/панелирование: везём шапку за визуальным вьюпортом,
   * только пока идёт набор. Прямые подписки (как в жестах): id нет. */
  try {
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', syncHeaderLift);
      window.visualViewport.addEventListener('scroll', syncHeaderLift);
    }
    document.addEventListener('focusin', syncHeaderLift);
    document.addEventListener('focusout', syncHeaderLift);
    document.addEventListener('focusin', centerActiveLine);
  } catch (x) {}
}

var api = {
  init: init,
  render: render,
  renderStatus: renderStatus,
  focusTrailing: focusTrailing,
  expandForAnchor: expandForAnchor,
  autosize: autosize,
  updateDurchip: updateDurchip,
  refreshDurchips: refreshDurchips
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else if (typeof window !== 'undefined') {
  window.EBRender = api;
}
})();
