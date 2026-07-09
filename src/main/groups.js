'use strict';

// Модель 4 фиксированных страновых групп: Украина — основная,
// Германия/Польша/Англия — вспомогательные (для разогрева UA-номеров).
const DEFAULT_GROUPS = [
  { id: 'ua', label: 'Украина',  country: 'UA', role: 'primary', lang: 'uk', proxy: '' },
  { id: 'de', label: 'Германия', country: 'DE', role: 'aux',     lang: 'de', proxy: '' },
  { id: 'pl', label: 'Польша',   country: 'PL', role: 'aux',     lang: 'pl', proxy: '' },
  { id: 'uk', label: 'Англия',   country: 'GB', role: 'aux',     lang: 'en', proxy: '' },
];

// более длинные префиксы проверяются раньше
const PREFIX_TO_GROUP = [['380', 'ua'], ['49', 'de'], ['48', 'pl'], ['44', 'uk']];

function detectGroupId(phone) {
  const d = String(phone || '').replace(/[^0-9]/g, '');
  for (const [pfx, id] of PREFIX_TO_GROUP) if (d.startsWith(pfx)) return id;
  return null;
}

const groupById = (groups, id) => groups.find((x) => x.id === id) || null;
const groupOf = (groups, acc) => groupById(groups, acc && acc.groupId) || groupById(groups, 'ua');

const LANG_TO_GROUP = { uk: 'ua', de: 'de', pl: 'pl', en: 'uk' };
const contentGroupIdForLang = (lang) => LANG_TO_GROUP[lang] || 'ua';

function pairLang(a, b) {
  if (a && b && a.id === b.id) return a.lang;   // одна группа → её язык
  return 'de';                                   // любая смешанная пара → немецкий
}

module.exports = { DEFAULT_GROUPS, detectGroupId, groupById, groupOf, pairLang, contentGroupIdForLang };
