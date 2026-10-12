/* settings.js — меню ⚙ и окно «Репозиторий и токен»: открытие/закрытие
 * меню и подменю копий и очистки, модальное окно с двумя полями и кнопками
 * Сохранить/Отмена.
 * Вынесено из app.js (рефакторинг, этап 3): код перенесён как есть,
 * общее — только через ctx. Своих глобалов не трогает.
 * UMD: браузер (window.EBSettings) + Node (module.exports) для тестов.
 *
 * Контекст ctx: on — стабильная ссылка; getState() (state переназначается);
 *   mutate(fn) — мутация с историей; askConfirm(text) — модалка;
 *   doSync(force) — стабильная ссылка.
 */
(function () {
'use strict';

function el(id) { return document.getElementById(id); }

var C = null;

/* Поле токена живёт в DOM только пока открыто окно настроек: иначе Chrome
 * видит пару «текст + пароль» и предлагает сохранить токен как логин. */
function repoTokenBuild() {
  var wrap = el('repoTokenWrap');
  if (!wrap) return;
  var state = C.getState();
  wrap.innerHTML = '';
  var inp = document.createElement('input');
  inp.id = 'tokenInput';
  inp.type = 'password';
  inp.placeholder = 'GitHub token';
  inp.autocomplete = 'off';
  inp.setAttribute('aria-label', 'Токен');
  var state = C.getState();
  if (state && state.settings.token) inp.value = state.settings.token;
  wrap.appendChild(inp);
}

function repoTokenDestroy() {
  var wrap = el('repoTokenWrap');
  if (wrap) wrap.innerHTML = '';
}

function openRepoModal() {
  var state = C.getState();
  var repo = el('repoModalInput');
  if (repo) repo.value = (state && state.settings.repo) || '';
  /* Срок токена — обычное текстовое поле (не пароль): в DOM постоянно,
   * Chrome его как логин не считает. Битое при открытии чистим видом. */
  var expN = el('repoExpInput');
  if (expN) expN.value = (state && state.settings.tokenExp) || '';
  repoTokenBuild();
  var back = el('repoModalBack');
  if (back) back.classList.add('open');
}

function closeRepoModal() {
  repoTokenDestroy();
  var back = el('repoModalBack');
  if (back) back.classList.remove('open');
}

/* Маска даты «ДД.ММ.ГГГГ» (v146, вариант А): человек жмёт только цифры,
 * точки подставляются сами (`12` → `12.`, `12122026` → `12.12.2026`).
 * Плейсхолдер серым виден, пока поле пустое; набранное — обычным цветом.
 * Вставка целой даты и Backspace через авто-точку обрабатываются, каретка
 * держится за той же по счёту цифрой. Финальный судья — normTokenExp. */
function fmtExpDigits(d) {
  d = String(d == null ? '' : d).replace(/\D/g, '').slice(0, 8);
  if (d.length > 4) return d.slice(0, 2) + '.' + d.slice(2, 4) + '.' + d.slice(4);
  if (d.length > 2) return d.slice(0, 2) + '.' + d.slice(2);
  return d;
}

/* Поставить каретку за n-й по счёту цифрой (через авто-точку — перепрыгнуть). */
function expCaret(inp, fmt, n) {
  var np = 0, seen = 0;
  while (np < fmt.length && seen < n) {
    if (/\d/.test(fmt.charAt(np))) seen++;
    np++;
  }
  if (fmt.charAt(np) === '.') np++;
  try { inp.setSelectionRange(np, np); } catch (x) {}
}

function init(ctx) {
  C = ctx;
  ctx.on('gearBtn', 'click', function () {
    var gear = el('gearMenu');
    if (gear) gear.classList.toggle('open');
    if (gear && !gear.classList.contains('open')) {
      var bm = el('backupMenu');
      if (bm) bm.classList.remove('open');
      var cm = el('cleanupMenu');
      if (cm) cm.classList.remove('open');
    }
  });
  /* Подменю «Резервная копия»: три пункта-копии в одном. */
  ctx.on('backupBtn', 'click', function () {
    var bm = el('backupMenu');
    if (bm) bm.classList.toggle('open');
  });
  /* Подменю «Очистка»: удаление выполненных + сжатие могил. */
  ctx.on('cleanupBtn', 'click', function () {
    var cm = el('cleanupMenu');
    if (cm) cm.classList.toggle('open');
  });
  /* Репозиторий и токен — только для администратора: сначала предупреждение,
   * затем модальное окно по центру с двумя полями и кнопками
   * Сохранить/Отмена (в маленьком экране меню не переполняется). */
  ctx.on('repoBtn', 'click', function () {
    ctx.askConfirm('Настройки репозитория и токена — только для администратора. ' +
      'Неверные значения нарушат синхронизацию на этом устройстве. Открыть?').then(function (ok) {
        if (!ok) return;
        openRepoModal();
      });
  });
  ctx.on('repoSaveBtn', 'click', function () {
    var repo = el('repoModalInput');
    var tok = document.getElementById('tokenInput');
    var expN = el('repoExpInput');
    var state = C.getState();
    ctx.mutate(function () {
      if (repo && repo.value) state.settings.repo = repo.value.trim();
      if (tok) state.settings.token = tok.value.trim();
      /* Срок — через нормализацию логики (битое станет пустым = без срока). */
      if (expN) {
        var raw = expN.value;
        if (typeof window !== 'undefined' && window.EBLogic && window.EBLogic.normTokenExp) {
          state.settings.tokenExp = window.EBLogic.normTokenExp(raw);
        } else {
          state.settings.tokenExp = String(raw == null ? '' : raw).trim();
        }
      }
    });
    closeRepoModal();
    var gear = el('gearMenu');
    if (gear) gear.classList.remove('open');
    ctx.doSync(true);
  });
  ctx.on('repoCancelBtn', 'click', function () {
    closeRepoModal();
  });
  /* Маска срока: только цифры с клавиатуры, точки сами (см. выше). */
  ctx.on('repoExpInput', 'input', function () {
    var inp = el('repoExpInput');
    if (!inp) return;
    var pos = null;
    try { pos = inp.selectionStart; } catch (x) { pos = null; }
    var before = inp.value;
    var digitsBefore = 0;
    if (pos != null) digitsBefore = before.slice(0, pos).replace(/\D/g, '').length;
    var fmt = fmtExpDigits(before);
    if (fmt !== before) {
      inp.value = fmt;
      if (pos != null) expCaret(inp, fmt, digitsBefore);
    }
  });
  ctx.on('repoExpInput', 'keydown', function (e) {
    if (!e || e.key !== 'Backspace') return;
    var inp = el('repoExpInput');
    if (!inp) return;
    var s = null, en = null;
    try { s = inp.selectionStart; en = inp.selectionEnd; } catch (x) { return; }
    if (s == null || s !== en || s === 0) return;
    if (inp.value.charAt(s - 1) !== '.') return;
    /* Каретка сразу за авто-точкой: стираем цифру перед ней, а не точку. */
    if (e.preventDefault) e.preventDefault();
    var digits = inp.value.replace(/\D/g, '');
    var dc = inp.value.slice(0, s).replace(/\D/g, '').length;
    inp.value = fmtExpDigits(digits.slice(0, dc - 1) + digits.slice(dc));
    expCaret(inp, inp.value, dc - 1);
  });
}

var api = {
  init: init
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else if (typeof window !== 'undefined') {
  window.EBSettings = api;
}
})();
