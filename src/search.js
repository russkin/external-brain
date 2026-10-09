/* search.js — поиск по задачам: оверлей, навигация, подсветка.
 * Вынесен из app.js (рефакторинг, этап 1): код перенесён как есть,
 * всё общее — только через ctx (см. init). Своих глобалов не трогает.
 * UMD: браузер (window.EBSearch) + Node (module.exports) для тестов.
 *
 * Контекст ctx (всё обязательное, без значений по умолчанию нет работы):
 *   on, L, render — стабильные ссылки;
 *   getState() — state переназначается (boot/undo), читать только так;
 *   lineTasks, lineIndent — стабильные ссылки;
 *   getCollapsed() — collapsed переназначается (setAllCollapsed/load);
 *   saveCollapsed, isDoneHidden(), toggleDoneHidden.
 */
(function () {
'use strict';

var C = null;
var searchIds = [], searchIdx = -1, searchScrollY = 0, searchLanded = false;

function el(id) { return document.getElementById(id); }

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
  syncSearchSpace();
}
/* Низ страницы — на уровне верха окна поиска: иначе нижние задачи
 * уходят под панель (особенно когда клавиатура спряталась и панель
 * снова внизу). Отступ = высота панели, снимается при закрытии. */
function syncSearchSpace() {
  var main = null;
  try { main = document.querySelector('main'); } catch (x) { main = null; }
  if (!main) return;
  var bar = el('searchBar');
  if (bar && bar.classList.contains('open')) {
    var h = 0;
    try { h = bar.getBoundingClientRect().height; } catch (x) { h = 0; }
    if (h > 0) main.style.paddingBottom = (h + 12) + 'px';
  } else {
    main.style.paddingBottom = '';
  }
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
  var state = C.getState();
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
  syncSearchSpace();
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
  var state = C.getState();
  if (!state) return;
  var t = C.L.getTask(state.tasks, id);
  if (!t) return;
  if (t.status === 'done') {
    if (C.isDoneHidden()) C.toggleDoneHidden();
  } else {
    var lt = [];
    try { lt = C.lineTasks(); } catch (x) { lt = []; }
    var idx = -1, i;
    for (i = 0; i < lt.length; i++) {
      if (lt[i].id === id) { idx = i; break; }
    }
    if (idx !== -1) {
      var collapsed = C.getCollapsed();
      var minInd = 999, changed = false;
      for (i = idx; i >= 0; i--) {
        var ind = C.lineIndent(lt[i]);
        if (ind < minInd) {
          minInd = ind;
          if (i !== idx && collapsed[lt[i].id]) {
            delete collapsed[lt[i].id];
            changed = true;
          }
        }
      }
      if (changed) C.saveCollapsed();
    }
  }
  C.render();
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

/* Текущее совпадение для перерисовки из приложения (render). */
function currentId() {
  if (searchIdx >= 0 && searchIdx < searchIds.length) return searchIds[searchIdx];
  return null;
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
  var state = C.getState();
  if (!state) return;
  var inp = el('searchInput');
  var q = inp ? inp.value : '';
  /* Скрываем клавиатуру — дальше прыжок к первому совпадению. */
  if (inp) { try { inp.blur(); } catch (x) {} }
  var live = [], dn = [];
  try { live = C.lineTasks(); } catch (x) { live = []; }
  try { dn = C.L.doneList(state.tasks); } catch (x) { dn = []; }
  searchIds = C.L.searchTasks(live.concat(dn), q);
  searchIdx = searchIds.length ? 0 : -1;
  if (searchIds.length) gotoSearch(0);
  else { applySearchHit(null); updateSearchUI(); }
}

function init(ctx) {
  C = ctx;
  ctx.on('searchBtn', 'click', function () { openSearch(); });
  ctx.on('searchGo', 'click', function () { doSearch(); });
  ctx.on('searchCancel', 'click', function () { closeSearch(true); });
  ctx.on('searchUp', 'click', function () { if (searchIdx > 0) gotoSearch(searchIdx - 1); });
  ctx.on('searchDown', 'click', function () { if (searchIdx >= 0 && searchIdx < searchIds.length - 1) gotoSearch(searchIdx + 1); });
  ctx.on('searchInput', 'input', function () {
    /* Запрос поменялся — старые совпадения недействительны. */
    searchIds = [];
    searchIdx = -1;
    updateSearchUI();
  });
  ctx.on('searchInput', 'keydown', function (e) {
    if (e && e.key === 'Enter') {
      var inp = el('searchInput');
      if (inp && String(inp.value).trim()) {
        if (e.cancelable) e.preventDefault();
        doSearch();
      }
    }
  });
}

var api = {
  init: init,
  applySearchHit: applySearchHit,
  currentId: currentId
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else if (typeof window !== 'undefined') {
  window.EBSearch = api;
}
})();
