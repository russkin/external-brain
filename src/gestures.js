/* gestures.js — жесты списка: свайп строки (флаг «Выполнено» слева,
 * модалка времени справа), перетаскивание за grip (вертикальный drag с дырой
 * и каркасом покоя + сдвиг отступа влево/вправо), отметка выполненной
 * со слайдом и сохранение порядка после посадки.
 * Вынесено из app.js (рефакторинг, этап 6): код перенесён как есть.
 * В app.js остались тонкие алиасы (wireLineSwipe/wireLineDrag/
 * toggleDoneSlide/isDragActive), чтобы вызовы в makeLine/mutate и
 * контексте истории не трогать.
 * Своё состояние (флаг жеста, возврат курсора в черновик, пин прокрутки)
 * живёт здесь; черновик (якорь/текст/отступ) и флаг blur-создания — в app.js
 * и идут сюда через контекст (getDraft/setDraft, setDraftTapBusy).
 * UMD: браузер (window.EBGestures) + Node (module.exports) для тестов.
 *
 * Контекст ctx: L, getState, render, save, mutate, lineIndent, lineTasks,
 *   effTrailingIndent, trailingAnchorId, getDraft, setDraft, getCollapsed,
 *   saveCollapsed, hasKidsFull, toggleCollapse, toggleDoneNow,
 *   placeTaskAfter, insertTaskTop, insertTaskAfter, focusTrailing,
 *   openDuration, snapFull, snapTasks, pushUndo, updateHistoryButtons,
 *   setDraftTapBusy, touchLastPD, INDENT_STEP, LINES_GAP —
 *   стабильные ссылки; изменяемое (state, черновик, карта свёрнутых)
 *   только через геттеры. L/INDENT_STEP/LINES_GAP фиксируются в init.
 */
(function () {
'use strict';

function el(id) { return document.getElementById(id); }

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
      C.setDraftTapBusy(true);
      setTimeout(function () { C.setDraftTapBusy(false); }, 400);
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
      C.openDuration(taskId);
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
  var dT = C.getDraft();
  var text = String(dT.text || '').trim();
  if (!text) return;
  var anchor = C.trailingAnchorId();
  var lt = C.lineTasks();
  var rootIdx = -1;
  for (var i = 0; i < lt.length; i++) {
    if (lt[i] && lt[i].id === rootId) { rootIdx = i; break; }
  }
  if (rootIdx === -1) return;
  var base = C.lineIndent(lt[rootIdx]);
  var inside = false;
  if (anchor && anchor === rootId) inside = true;
  else if (anchor) {
    for (var j = rootIdx + 1; j < lt.length; j++) {
      if (C.lineIndent(lt[j]) <= base) break;
      if (lt[j].id === anchor) { inside = true; break; }
    }
  }
  if (!inside) return;
  var fi = C.effTrailingIndent();
  if (fi <= base) fi = base >= 8 ? 8 : base + 1;
  var created = C.placeTaskAfter(anchor, text, fi);
  if (!created) return;
  C.setDraft({ afterId: null, text: '', indent: null });
}

/* Выполнить с анимацией: строка возвращается на место уже зачёркнутой,
 * затем спускается в секцию выполненных под полем ввода. */
/* Выполнить/вернуть с анимацией: строка возвращается на место уже
 * зачёркнутой (или расчеркнутой), затем переезжает в свою секцию —
 * выполненные под поле ввода, вернувшаяся — на своё место в списке
 * (createdAt не трогаем, persist чужие метки не переписывает). */
function toggleDoneSlide(taskId) {
  var state = C.getState();
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
      C.mutate(function () { C.toggleDoneNow(taskId, toDone); });
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
    C.mutate(function () { C.toggleDoneNow(taskId, toDone); });
    /* Курсор не должен остаться в поле: фокус могла увести кнопка. */
    try {
      var ae = document.activeElement;
      if (ae && ae.tagName === 'BUTTON' && ae.blur) ae.blur();
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
function persistLineOrder(beforeOverride) {
  var state = C.getState();
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
  var cur = C.lineTasks().map(function (t) { return t.id; });
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
    if (r.getAttribute && r.getAttribute('data-trailing')) return C.effTrailingIndent();
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
    var box = el('lines');
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
    var box = el('lines');
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
    dragUiBefore = C.snapFull();
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
    var dG = C.getDraft();
    var commitTxt = draftRowG ? String(dG.text || '').trim() : '';
    if (commitTxt) {
      var atTopG = dG.afterId === 'TOP';
      var anchorG = atTopG ? null : C.trailingAnchorId();
      var indG = C.effTrailingIndent();
      var madeG = null;
      C.mutate(function () {
        madeG = atTopG ?
          C.insertTaskTop(commitTxt, Date.now()) :
          C.insertTaskAfter(anchorG, commitTxt, indG, Date.now());
      });
      if (madeG) {
        C.setDraft({ afterId: null, text: '', indent: null });
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
     * из-под пальца и жест глох (v51). lastPD перед blur оживляем:
     * долгий жест (>700мс) иначе уводит blur-создание чужого черновика
     * мимо гарда grip и набранный текст превращается в задачу. */
    if (!refocusDraft) {
      C.touchLastPD(grip);
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
        C.focusTrailing();
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
      /* Выполненные не сворачиваем: их записи в карте всё равно никто
       * не читает, а мусор копился бы и путал обходы. */
      if (tapped && tapped.status !== 'done' && C.hasKidsFull(tapped.id)) {
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
      var bou = indentBounds();
      var lvl = bou.cur + Math.round(lastDx / INDENT_STEP);
      if (lvl < 0) lvl = 0;
      if (lvl > bou.max) lvl = bou.max;
      var task = myTask();
      if (!task) {
        if (div.getAttribute && div.getAttribute('data-trailing')) {
          /* Сдвиг пустого поля — тоже перестановка: пишем в историю,
           * иначе отмена после сдвига откатит чужое действие. */
          var dI = C.getDraft();
          if (C.effTrailingIndent() !== lvl) {
            C.pushUndo({
              tasks: C.snapTasks(),
              afterId: dI.afterId,
              text: dI.text,
              indent: dI.indent
            });
            C.updateHistoryButtons();
          }
          dI.indent = lvl;
          C.setDraft(dI);
          expandParentAbove(lvl);
          C.render();
        }
        return;
      }
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
        var pInd = pT ? C.lineIndent(pT) : 0;
        var nInd = nT ? C.lineIndent(nT) : -1;
        var wantInd = !pT ? 0 : (nInd === pInd + 1 ? nInd : pInd);
        var dL = C.getDraft();
        var oldAfter = dragUiBefore ? dragUiBefore.afterId : dL.afterId;
        var oldInd = C.effTrailingIndent();
        if (newAfter !== oldAfter || wantInd !== oldInd) {
          C.pushUndo({
            tasks: C.snapTasks(),
            afterId: oldAfter,
            text: dragUiBefore ? String(dragUiBefore.text || '') : dL.text,
            indent: dragUiBefore ? dragUiBefore.indent : dL.indent
          });
          C.updateHistoryButtons();
        }
        dL.afterId = newAfter;
        dL.indent = wantInd;
        C.setDraft(dL);
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
    var reordered = persistLineOrder(preDrop);
    /* Порядок не сдвинулся, а отступ — да: изменение есть, а шага истории
     * нет (persist вернул false). Пушим досдвиговый слепок, иначе ↩
     * откатит чужое более раннее действие вместо отступа. */
    if (!reordered && preDrop && C.snapTasks() !== preDrop.tasks) {
      C.pushUndo(preDrop);
      C.updateHistoryButtons();
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
      var pIndB = pTB ? C.lineIndent(pTB) : 0;
      var nIndB = nTB ? C.lineIndent(nTB) : -1;
      var wantIndB = !pTB ? 0 : (nIndB === pIndB + 1 ? nIndB : pIndB);
      var dR = C.getDraft();
      if (newAfterB !== dR.afterId || wantIndB !== dR.indent) {
        if (!reordered) { C.pushUndo(C.snapFull()); C.updateHistoryButtons(); }
        dR.afterId = newAfterB;
        dR.indent = wantIndB;
        C.setDraft(dR);
      }
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
