/* settings.js — меню ⚙ и окно «Репозиторий и токен»: открытие/закрытие
 * меню и подменю копий, модальное окно с двумя полями и кнопками
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
  repoTokenBuild();
  var back = el('repoModalBack');
  if (back) back.classList.add('open');
}

function closeRepoModal() {
  repoTokenDestroy();
  var back = el('repoModalBack');
  if (back) back.classList.remove('open');
}

function init(ctx) {
  C = ctx;
  ctx.on('gearBtn', 'click', function () {
    var gear = el('gearMenu');
    if (gear) gear.classList.toggle('open');
    if (gear && !gear.classList.contains('open')) {
      var bm = el('backupMenu');
      if (bm) bm.classList.remove('open');
    }
  });
  /* Подменю «Резервная копия»: три пункта-копии в одном. */
  ctx.on('backupBtn', 'click', function () {
    var bm = el('backupMenu');
    if (bm) bm.classList.toggle('open');
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
    var state = C.getState();
    ctx.mutate(function () {
      if (repo && repo.value) state.settings.repo = repo.value.trim();
      if (tok) state.settings.token = tok.value.trim();
    });
    closeRepoModal();
    var gear = el('gearMenu');
    if (gear) gear.classList.remove('open');
    ctx.doSync(true);
  });
  ctx.on('repoCancelBtn', 'click', function () {
    closeRepoModal();
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
