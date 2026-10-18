/* gestures.js — жесты списка: свайп строки (флаг «Выполнено» слева,
 * модалка времени справа — на плане модалка даты), перетаскивание за grip (вертикальный drag с дырой
 * и каркасом покоя + сдвиг отступа влево/вправо), отметка выполненной
 * со слайдом и сохранение порядка после посадки.
 * Вынесено из app.js (рефакторинг, этап 6): код перенесён как есть.
 * В app.js остались тонкие алиасы (wireLineSwipe/wireLineDrag/
 * toggleDoneSlide/isDragActive), чтобы вызовы в makeLine/mutate и
 * контексте истории не трогать.
 * Своё состояние (флаг жеста, пин прокрутки) живёт здесь; изменяемое
 * (state, карта свёрнутых) — в app.js, только через контекст.
 * UMD: браузер (window.EBGestures) + Node (module.exports) для тестов.
 *
 * Контекст ctx: L, getState, render, save, mutate, lineIndent, lineTasks,
 *   planTasks, getCollapsed, saveCollapsed, hasLiveKids, toggleCollapse,
 *   toggleDoneNow, openDuration, openPlanDate, snapFull, snapTasks, pushUndo,
 *   updateHistoryButtons, INDENT_STEP, LINES_GAP —
 *   (planTasks — порядок планов для drag на #planPage, ФАЗА 1).
 *   стабильные ссылки; изменяемое (state, черновик, карта свёрнутых)
 *   только через геттеры. L/INDENT_STEP/LINES_GAP фиксируются в init.
 */
(function () {
'use strict';

function el(id) { return document.getElementById(id); }

/* Виден ли ряд в потоке: свёрнутые дети прячутся КЛАССОМ collapsed-kid
 * (index.html), а не инлайн-стилем — проверка только style.display их
 * не видит и считает занимающими место (дыра плывёт вверх по мере
 * движения вниз мимо свёрнутых групп; тот же класс подводят потолок
 * сдвига и соседи посадки — см. indentBounds/applyDropIndent). */
function rowShown(cr) {
  if (!cr) return false;
  if (cr.style && cr.style.display === 'none') return false;
  if (cr.classList && cr.classList.contains('collapsed-kid')) return false;
  return true;
}

/* Коробка строк для жеста (ФАЗА 1 планирования): основной список #lines
 * или страница плана #planLines. Строка знает свою коробку по DOM —
 * каркас drag'а, дыра и посадка строятся в той же коробке, код жестов
 * один (без дублей под план). Не план — как было (#lines). */
function boxOf(div) {
  try {
    if (div && div.parentNode && div.parentNode.id === 'planLines') {
      var pb = document.getElementById('planLines');
      if (pb) return pb;
    }
  } catch (x) {}
  return el('lines');
}

/* Строка по id в коробке (null — нет такой). */
function findRow(box, taskId) {
  if (!box || !box.querySelectorAll || !taskId) return null;
  var rows = box.querySelectorAll('.tline[data-id]');
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].getAttribute && rows[i].getAttribute('data-id') === taskId) return rows[i];
  }
  return null;
}

/* Скроллер, который едет при drag'е и держится пином (v200): у живого
 * списка — окно (null), у страницы плана — её контейнер #planScroll
 * (шапка и форма живут вне скроллера, как у живого списка). */
function dragScrollerOf(box) {
  try {
    if (box && box.id === 'planLines') return el('planScroll') || null;
  } catch (x) {}
  return null;
}

var C = null;
var L = null;
var INDENT_STEP = 0;
var LINES_GAP = 0;

/* Жест перетаскивания: пока флаг поднят, render в mutate/commit не
 * выполняется — узлы жеста не пересоздаются. Фокус при захвате НЕ
 * снимается: blur закрыл бы клавиатуру посреди touch, вьюпорт прыгнул,
 * содержимое уехало из-под пальца и жест глох (v51). Клавиатура
 * закрывается в finish — после pointerup. */
var dragActive = false;

/* Пин прокрутки: пока жест жив, страница не уезжает — автоскролы
 * (фокус, закрытие клавиатуры) держатся на месте, содержимое не
 * уходит из-под пальца. Свой автоскрол руками двигает pinY.
 * v200: пинится РЕАЛЬНЫЙ скроллер жеста — у живого списка окно, у
 * страницы плана её контейнер #planScroll (шапка там вне скроллера,
 * как у живого списка). Скролл элемента не всплывает — слушаем window
 * с capture, одним обработчиком на оба случая. */
var pinY = null, pinTimer = null, pinOn = false, pinEl = null;
function pinGet() {
  return pinEl ? (pinEl.scrollTop || 0) : (window.pageYOffset || 0);
}
function pinSet(v) {
  if (pinEl) pinEl.scrollTop = v;
  else window.scrollTo(0, v);
}
function onPinScroll() {
  if (pinY == null) return;
  if (pinGet() !== pinY) {
    try { pinSet(pinY); } catch (x) {}
  }
}
function pinScroll(elSc) {
  if (pinTimer) { clearTimeout(pinTimer); pinTimer = null; }
  pinEl = elSc || null;
  pinY = pinGet();
  if (!pinOn) {
    pinOn = true;
    window.addEventListener('scroll', onPinScroll, true);
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
  pinEl = null;
  if (pinOn) {
    pinOn = false;
    window.removeEventListener('scroll', onPinScroll, true);
    window.removeEventListener('resize', onPinScroll);
  }
}

/* Свайп строки справа налево: открыть флаг «Выполнено»; слева направо
 * (вправо): модалка времени задачи, а на строке плана — модалка даты
 * (v205) — НО не если в этом жесте задет раскрытый флаг (тогда возврат
 * вправо только закрывает флаг, swHadFlag).
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
       * узлы строки не пересоздаются. */
      dragActive = true;
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
      /* Свайп вправо: флагирует открытие модалки на pointerup (модалка
       * посреди жеста мешала бы пальцу). Что откроется — решает pointerup:
       * обычной строке время, плану — дата (v205, меток времени у планов
       * нет). swHadFlag — если флаг открыт/раскрыт в этом жесте, возврат
       * вправо его только закрывает.
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
      /* Строка плана (v205): свайп вправо меняет ДАТУ, а не время —
       * у плана поле времени не бывает (v197). */
      if (div.getAttribute && div.getAttribute('data-src') === 'plan') {
        C.openPlanDate(taskId);
      } else {
        C.openDuration(taskId);
      }
    }
    /* Тап по самим кнопкам сюда не входит: у них свои обработчики. */
    if (e.target && e.target.closest &&
        (e.target.closest('.doneflag') || e.target.closest('.delflag'))) return;
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


/* Выполнить/вернуть с анимацией: строка сначала уходит из своей секции
 * (затухание без смены вида), затем мутация — и появление уже в нужном
 * виде в своей секции (выполненные внизу, вернувшаяся — на своём месте;
 * createdAt не трогаем, persist чужие метки не переписывает). */
function toggleDoneSlide(taskId) {
  var state = C.getState();
  var task = L.getTask(state.tasks, taskId);
  if (!task || task.deleted) return;
  /* Фокус с любой строки/поля снимаем сразу (свайп уже снял — тут
   * no-op): отметка выполненной — чужое действие, клавиатура не должна
   * пережить её ни в задаче, ни в поле ввода. */
  var aeF = document.activeElement;
  if (aeF && aeF.blur && (aeF.tagName === 'TEXTAREA' || aeF.tagName === 'INPUT')) {
    try { aeF.blur(); } catch (x) {}
  }
  var toDone = task.status !== 'done';
  /* Строку ищем сначала в основном списке, затем на странице плана. */
  var box = el('lines');
  var row = findRow(box, taskId);
  if (!row) {
    var pbox = el('planLines');
    var prow = findRow(pbox, taskId);
    if (prow) { box = pbox; row = prow; }
  }
  if (!row || (row.classList && row.classList.contains('sliding-done'))) {
    if (!row) {
      dragActive = false;
      C.mutate(function () { C.toggleDoneNow(taskId, toDone); });
    }
    return;
  }
  /* Сначала строка уходит из своего раздела (затухание, БЕЗ зачёркивания),
   * затем — мутация и появление уже в нужном виде в своём разделе. */
  row.classList.add('sliding-done');
  row.classList.remove('swiped');
  row._swOpen = false;
  setTimeout(function () {
    dragActive = false;
    /* Тап мог сесть мимо флага в поле (или лупа долгого нажатия): каретка
     * не должна жить анимацию ухода — гасим текстовые тоже. */
    try {
      var aeB = document.activeElement;
      if (aeB && aeB.blur && (aeB.tagName === 'TEXTAREA' || aeB.tagName === 'INPUT')) aeB.blur();
    } catch (x) {}
    C.mutate(function () { C.toggleDoneNow(taskId, toDone); });
    /* Курсор не должен остаться в поле: фокус могла увести кнопка. */
    try {
      var ae = document.activeElement;
      if (ae && ae.tagName === 'BUTTON' && ae.blur) ae.blur();
    } catch (x) {}
    /* Встречаем строку на новом месте коротким проявлением. */
    try {
      var box2 = box;
      var rows2 = box2 && box2.querySelectorAll ? box2.querySelectorAll('.tline[data-id]') : [];
      for (var k = 0; k < rows2.length; k++) {
        if (rows2[k].getAttribute && rows2[k].getAttribute('data-id') === taskId) {
          rows2[k].classList.add('landed');
          (function (rr) {
            setTimeout(function () {
              try { rr.classList.remove('landed'); } catch (x) {}
            }, 300);
          })(rows2[k]);
          break;
        }
      }
    } catch (x) {}
  }, 260);
}

/* Порядок строк после drag: перенумеровываем createdAt ТОЛЬКО уехавшему
 * блоку, втискивая его между соседями (целыми, с запасом). Чужие метки
 * не трогаем — поэтому вернувшаяся из выполненных встаёт на своё место,
 * а синк не дёргается лишний раз. Тесно (зазор исчерпан) — перенумеровать
 * всех живых. Выполненные и tombstone не трогаем никогда. */
/* beforeOverride — слепок ДО мутации отступа (applyDropIndent): финиш
 * вызывает persist уже после неё, и свежий snapFull() нёс бы новый отступ —
 * отмена возвращала бы порядок, но не отступ. */
function persistLineOrder(beforeOverride, boxOverride) {
  var state = C.getState();
  /* Коробку даёт финиш жеста (boxOf): план переупорядочивается в своём
   * порядке planTasks, основной список — как было в lineTasks. */
  var box = boxOverride || el('lines');
  if (!box || !state) return;
  var wantPlan = box.id === 'planLines';
  var domAlive = [];
  var rows = box.querySelectorAll ? box.querySelectorAll('.tline[data-id]') : [];
  for (var i = 0; i < rows.length; i++) {
    var id = rows[i].getAttribute('data-id');
    var t = id ? L.getTask(state.tasks, id) : null;
    /* На странице плана выполненные видны (с зачёркиванием) — они часть
     * порядка; в основном списке их секция отдельно и в порядок не входит. */
    if (t && !t.deleted && (wantPlan || t.status !== 'done')) domAlive.push(id);
  }
  if (!domAlive.length) return false;
  var wantTasks = (wantPlan && C.planTasks) ? C.planTasks() : C.lineTasks();
  var cur = wantTasks.map(function (t) { return t.id; });
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
  var before = beforeOverride || C.snapFull();
  var now = Date.now();
  function at(idx) {
    var tt = L.getTask(state.tasks, domAlive[idx]);
    return tt ? tt.createdAt : 0;
  }
  var m = be - bs + 1;
  var P = bs > 0 ? at(bs - 1) : null;
  var N = be < domAlive.length - 1 ? at(be + 1) : null;
  /* Занятые метки чужих (вне двигаемого отрезка): вставать встык с ними
   * нельзя — обход предков (isDoneShown) увидит чужого done-родителя
   * и зачёркивание «загуляет» (см. insertTaskAfter в app.js). */
  var inSeg = {};
  for (var sgi = 0; sgi < m; sgi++) inSeg[domAlive[bs + sgi]] = true;
  var busyAt = {};
  state.tasks.forEach(function (t) {
    if (t && !t.deleted && !inSeg[t.id]) busyAt[t.createdAt] = true;
  });
  var vals = null;
  if (P === null && N !== null) {
    vals = [];
    for (var c0 = N - 1; vals.length < m; c0--) {
      if (!busyAt[c0]) vals.unshift(c0);
    }
  } else if (N === null && P !== null) {
    vals = [];
    for (var c1 = P + 1; vals.length < m; c1++) {
      if (!busyAt[c1]) vals.push(c1);
    }
  } else if (P !== null && N !== null && N - P > m) {
    vals = [];
    for (var c = P + 1; c < N && vals.length < m; c++) {
      if (!busyAt[c]) vals.push(c);
    }
    if (vals.length < m) vals = null;
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
    /* Зазор исчерпан: перенумеровать ВСЕ видимые подряд в текущем порядке
     * (живых и выполненных) — относительный порядок не меняется, перепрыгнуть
     * через замороженные метки негде. */
    var all = state.tasks.filter(function (t) { return t && !t.deleted; });
    all.sort(function (a, b) {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });
    var base = now - all.length;
    all.forEach(function (t2, idx) {
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
  C.pushUndo(before);
  C.save();
  C.updateHistoryButtons();
  return true;
}

/* Отступ строки после вертикального перетаскивания: смотрят соседи
 * на новом месте. Нет соседа сверху — уровень родителей (0).
 * Сосед сверху без отступа, а следующий уходит вглубь — встаём первым
 * вложенным (отступ соседа +1). Иначе — отступ соседа сверху.
 * Весь перетащенный блок (родитель + дети) сдвигается на одну дельту. */
function applyDropIndent(box, sibs, di, kids) {
  var state = C.getState();
  function indOf(row) {
    var id = row.getAttribute ? row.getAttribute('data-id') : null;
    var t = id ? L.getTask(state.tasks, id) : null;
    return t ? C.lineIndent(t) : 0;
  }
  /* Соседи — только видимые живые строки: скрытые свёрнутые и выполненные
   * (вне своей секции) дают чужой отступ — тот же класс бага, что потолок
   * в indentBounds. Свои дети не считаются чужим вложением, иначе родитель
   * втянется под соседа. */
  function nbrShown(r) {
    if (!r || !r.getAttribute) return false;
    var rid = r.getAttribute('data-id');
    var rt = rid ? L.getTask(state.tasks, rid) : null;
    if (!rt || rt.deleted || rt.status === 'done') return false;
    return rowShown(r);
  }
  var prevRow = null;
  for (var pi = di - 1; pi >= 0; pi--) {
    if (nbrShown(sibs[pi])) { prevRow = sibs[pi]; break; }
  }
  var nextRow = null;
  for (var ni = di + 1; ni < sibs.length; ni++) {
    if (kids.indexOf(sibs[ni]) === -1 && nbrShown(sibs[ni])) { nextRow = sibs[ni]; break; }
  }
  var prevInd = prevRow ? indOf(prevRow) : 0;
  var nextInd = nextRow ? indOf(nextRow) : -1;
  /* Страница плана плоская: любой сброс — в 0 (вдруг в данных завалялся). */
  var want = (box && box.id === 'planLines') ? 0 :
    (!prevRow ? 0 : (nextInd === prevInd + 1 ? nextInd : prevInd));
  var myRow = sibs[di];
  var myId = myRow.getAttribute ? myRow.getAttribute('data-id') : null;
  var myT = myId ? L.getTask(state.tasks, myId) : null;
  if (!myT) return;
  var delta = want - C.lineIndent(myT);
  if (!delta) return;
  L.setIndent(state.tasks, myId, want);
  /* Дети едут вместе с родителем на ту же дельту (setIndent клампит 0..8). */
  for (var i = 0; i < kids.length; i++) {
    var kid = kids[i];
    var kidId = kid.getAttribute ? kid.getAttribute('data-id') : null;
    var kt = kidId ? L.getTask(state.tasks, kidId) : null;
    if (kt) L.setIndent(state.tasks, kidId, C.lineIndent(kt) + delta);
  }
}
/* Отступ строки и детей — по данным задач, В КАДРЕ посадки (сразу после
 * applyDropIndent): style.margin снят при возврате в поток, а render
 * только через 220мс — без этого вёрстка отстала бы от данных и строка
 * (и дети) отсидели бы с отступом 0/старым всю мягкую посадку. */
function dropMargins(row, kidRows) {
  var state = C.getState();
  function indOfDrop(r) {
    var rid = r.getAttribute ? r.getAttribute('data-id') : null;
    if (rid) {
      var rt = L.getTask(state.tasks, rid);
      if (rt) return C.lineIndent(rt);
    }
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
  var state = C.getState();
  var pid = null, grabDy = 0, divH = 0, holeH = 0, holeShift = 0, x0 = 0, y0 = 0;
  /* Автопрокрутка у краёв — по таймеру: стоящий палец pointermove не шлёт,
   * и прокрутка только по движению глохла после пары рывков. dragSc —
   * скроллер жеста (null — окно; #planScroll у страницы плана, v200). */
  var edgeTimer = null, lastY = 0, edgeStart = 0, dragSc = null;
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
    var box = boxOf(div);
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
      /* Скроллер жеста: у страницы плана — её контейнер, у живого
       * списка — окно (v200, как и пин). */
      if (dragSc) dragSc.scrollTop = (dragSc.scrollTop || 0) + dir * step;
      else window.scrollBy(0, dir * step);
      /* Пин — с РЕАЛЬНОГО смещения, а не += шаг: у края scrollBy
       * клампится (страница стоит), а пин убегал бы дальше — потом
       * onPinScroll дёргал страницу обратно и вверх было не уехать. */
      if (pinY != null) pinY = pinGet();
      lastScrollTs = Date.now();
    } catch (x) {}
    updateHole(lastY);
  }
  var mode = null, lastDx = 0, lastScrollTs = 0, phi = 0;
  var keepFocus = false;
  var order = null, kids = [], fr = [], frSh = [];
  var indentCur = 0, indentMax = 0;
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
    var box = boxOf(div);
    if (box) {
      var rows = rowsOf(box);
      for (var i = 0; i < rows.length; i++) {
        if (rows[i] === div) break;
        /* Спрятанные (свёрнутые) ряды места не занимают: сосед сверху —
         * ближайший ВИДИМЫЙ, иначе невидимый глубокий ряд раздувает
         * потолок и короткий флик даёт второй уровень вместо первого. */
        if (!rowShown(rows[i])) continue;
        first = false;
        var id = rows[i].getAttribute ? rows[i].getAttribute('data-id') : null;
        var t = id ? L.getTask(state.tasks, id) : null;
        prev = t ? C.lineIndent(t) : 0;
      }
    }
    var mine = myTask();
    cur = mine ? C.lineIndent(mine) : (div._indent || 0);
    var max = first ? 0 : prev + 1;
    if (max > 8) max = 8;
    if (max < 0) max = 0;
    return { cur: cur, max: max };
  }
  /* Явно положенное под свёрнутого видно сразу: разворачиваем всю
   * цепочку предков (по DOM-порядку — он визуально честный, в отличие
   * от createdAt). Отмена при этом сворачивание не возвращает: строка
   * остаётся на месте и видимой, иначе ↩ прятала бы её с глаз. */
  function expandParentAbove(finalLvl) {
    var collapsed = C.getCollapsed();
    var box = boxOf(div);
    if (!box) return;
    var rows = rowsOf(box);
    var self = -1, i;
    for (i = 0; i < rows.length; i++) {
      if (rows[i] === div) { self = i; break; }
    }
    if (self === -1 || !(finalLvl > 0)) return;
    var minInd = finalLvl, changed = false;
    for (i = self - 1; i >= 0; i--) {
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
  /* То же для Enter-создания: новое поле встаёт за якорем на вычисленном
   * уровне — если там свёрнуто, поле видно (черновик всегда рисуется),
   * а родившаяся задача спрячется. Разворачиваем сразу. */
  function startIndent() {
    var b = indentBounds();
    indentCur = b.cur;
    indentMax = b.max;
    mode = 'indent';
    /* Ветка едет целиком (как при вертикальной посадке): собираем
     * вложенных ниже по DOM-порядку — иначе сдвиг родителя отрывал
     * бы детей (внучки оставались на старом отступе). */
    kids = [];
    var mine = myTask();
    var box = boxOf(div);
    if (mine && box) {
      var lv0 = C.lineIndent(mine);
      var rows = rowsOf(box);
      var started = false;
      for (var k = 0; k < rows.length; k++) {
        if (rows[k] === div) { started = true; continue; }
        if (!started) continue;
        var kidId = rows[k].getAttribute ? rows[k].getAttribute('data-id') : null;
        var kt = kidId ? L.getTask(state.tasks, kidId) : null;
        if (kt && C.lineIndent(kt) > lv0) kids.push(rows[k]);
        else break;
      }
    }
  }
  function startVertical(e) {
    var box = boxOf(div);
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
      var lv0 = C.lineIndent(mine0);
      var started = false;
      for (var k = 0; k < order.length; k++) {
        if (order[k] === div) { started = true; continue; }
        if (!started) continue;
        var kidId = order[k].getAttribute ? order[k].getAttribute('data-id') : null;
        var kt = kidId ? L.getTask(state.tasks, kidId) : null;
        if (kt && C.lineIndent(kt) > lv0) {
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
    var box = boxOf(div);
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
    try { grip.setPointerCapture(pid); } catch (x) {}
    dragSc = dragScrollerOf(box);
    pinScroll(dragSc);
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
    /* Взялись за grip — фокус НЕ трогаем: blur на захвате закрывал
     * клавиатуру посреди touch — вьюпорт прыгал, содержимое уезжало
     * из-под пальца и жест глох («сдвиг влево ничего не делает»).
     * Клавиатура закрывается в finish. */
    dragActive = true;
    /* Своя пустая строка была в фокусе на захвате (набор идёт): после
     * сдвига-отступа вернём курсор в строку — клавиатура фактически
     * не пропадает. Вертикаль/тап — как было. */
    var ae0 = document.activeElement;
    keepFocus = !!(ae0 && ae0.tagName === 'TEXTAREA' && div.contains &&
      div.contains(ae0) && !String(ae0.value || '').trim());
    if (e.cancelable) e.preventDefault();
  });
  grip.addEventListener('pointermove', function (e) {
    if (pid == null || e.pointerId !== pid) return;
    var dx = e.clientX - x0;
    var dy = e.clientY - y0;
    if (!mode) {
      if (Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy) * 2) {
        var _mt = myTask();
        if (!_mt || _mt.status === 'done') return;
        /* Сдвигов на странице плана нет вообще (v197, плоский список):
         * preview не едет, отскока нет; вертикаль ниже стартует как обычно. */
        var _pb = boxOf(div);
        if (_pb && _pb.id === 'planLines') return;
        startIndent();
      } else if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx) * 2) {
        startVertical(e);
        if (mode !== 'vertical') return;
      } else return;
    }
    var box = boxOf(div);
    if (!box) return;
    if (mode === 'indent') {
      lastDx = dx;
      /* Живой предпросмотр: за пальцем едет вся ветка в пределах уровней. */
      var lo = -indentCur * INDENT_STEP;
      var hi = (indentMax - indentCur) * INDENT_STEP;
      var cx = dx < lo ? lo : (dx > hi ? hi : dx);
      div.style.transition = 'none';
      div.style.transform = 'translateX(' + cx + 'px)';
      for (var ki = 0; ki < kids.length; ki++) {
        if (!kids[ki] || !kids[ki].style) continue;
        kids[ki].style.transition = 'none';
        kids[ki].style.transform = 'translateX(' + cx + 'px)';
      }
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
     * из-под пальца и жест глох (v51). Сдвиг-отступ своей пустой строки
     * фокус не снимает (вернём ниже после render). */
    var kf = keepFocus;
    keepFocus = false;
    var aeEnd = document.activeElement;
    var didBlur = false;
    if (!(kf && mode === 'indent') && aeEnd && aeEnd.blur &&
        (aeEnd.tagName === 'TEXTAREA' || aeEnd.tagName === 'INPUT')) {
      try { aeEnd.blur(); didBlur = true; } catch (x) {}
    }
    /* Закрытие клавиатуры двигает страницу уже ПОСЛЕ жеста:
     * держим пин ещё полсекунды, чтобы итог не дёргался. */
    if (didBlur) unpinScroll(500); else unpinScroll();
    dragSc = null;
    /* Тап по многоточию родителя (без движения): свернуть/развернуть детей. */
    if (mode === null && e && e.type === 'pointerup') {
      var tapped = myTask();
      /* Выполненные не сворачиваем: их записи в карте всё равно никто
       * не читает, а мусор копился бы и путал обходы. */
      if (tapped && tapped.status !== 'done' && C.hasLiveKids(tapped.id)) {
        C.toggleCollapse(tapped.id);
        return;
      }
    }
    if (mode === 'indent') {
      mode = null;
      div.style.transition = '';
      div.style.transform = '';
      for (var kc = 0; kc < kids.length; kc++) {
        if (!kids[kc] || !kids[kc].style) continue;
        kids[kc].style.transition = '';
        kids[kc].style.transform = '';
      }
      /* На странице плана отступов нет (плоский список): сдвиг — no-op,
       * только вернуть вид. Вертикальный порядок правит persist. */
      if (boxOf(div) && boxOf(div).id === 'planLines') {
        kids = [];
        C.render();
        return;
      }
      var bou = indentBounds();
      var lvl = bou.cur + Math.round(lastDx / INDENT_STEP);
      if (lvl < 0) lvl = 0;
      if (lvl > bou.max) lvl = bou.max;
      var task = myTask();
      if (!task) return;
      /* Разворот — всегда, а не только при смене уровня: строка могла
       * родиться под свёрнутым уже на своём уровне (черновик виден,
       * задача — нет), и сдвиг вхолостую её бы не показал. */
      expandParentAbove(lvl);
      if (lvl !== bou.cur) {
        /* Сдвиг везёт всю ветку на ту же дельту (кламп 0..8 — внутри
         * setIndent): одна точка истории, внучки не отрываются. */
        (function (id, l, delta) {
          C.mutate(function () {
            L.setIndent(state.tasks, id, l);
            for (var k = 0; k < kids.length; k++) {
              var kidRow = kids[k];
              var kidId = kidRow && kidRow.getAttribute ? kidRow.getAttribute('data-id') : null;
              var kt = kidId ? L.getTask(state.tasks, kidId) : null;
              if (kt) L.setIndent(state.tasks, kidId, C.lineIndent(kt) + delta);
            }
          });
        })(task.id, lvl, lvl - bou.cur);
      }
      expandParentAbove(lvl);
      kids = [];
      C.render();
      if (kf) {
        /* Курсор — в строку на новом месте (узел пересоздан render):
         * клавиатура не успевает закрыться, набор продолжается. */
        var brow = null;
        var bx = boxOf(div);
        if (bx && bx.querySelectorAll) {
          var brows = bx.querySelectorAll('.tline[data-id]');
          for (var bi = 0; bi < brows.length; bi++) {
            if (brows[bi].getAttribute('data-id') === task.id) { brow = brows[bi]; break; }
          }
        }
        var binp = brow && brow.querySelector ? brow.querySelector('.tinput') : null;
        if (binp && binp.focus) { try { binp.focus(); } catch (x) {} }
      }
      return;
    }
    mode = null;
    var box = boxOf(div);
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
      var preDrop = (di !== -1 && di !== oldPos) ? C.snapFull() : null;
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
    var reordered = persistLineOrder(preDrop, box);
    /* Порядок не сдвинулся, а отступ — да: изменение есть, а шага истории
     * нет (persist вернул false). Пушим досдвиговый слепок, иначе ↩
     * откатит чужое более раннее действие вместо отступа. */
    if (!reordered && preDrop && C.snapTasks() !== preDrop.tasks) {
      C.pushUndo(preDrop);
      C.updateHistoryButtons();
      reordered = true;
    }
    setTimeout(function () {
      div.style.transition = '';
      div.style.transform = '';
      C.render();
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

function init(ctx) {
  C = ctx;
  L = ctx.L;
  INDENT_STEP = ctx.INDENT_STEP;
  LINES_GAP = ctx.LINES_GAP;
}

var api = {
  init: init,
  wireLineSwipe: wireLineSwipe,
  wireLineDrag: wireLineDrag,
  toggleDoneSlide: toggleDoneSlide,
  isDragActive: function () { return dragActive; }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else if (typeof window !== 'undefined') {
  window.EBGestures = api;
}
})();
