const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const section = source.slice(source.indexOf('  /* ── Importação Inteligente (Desabilitar em Lote)'));
const handler = section.slice(section.indexOf("smartBtn.addEventListener('click', function () {"), section.indexOf('\n  if (smartClear)'));
const counters = source.slice(source.indexOf('  function updateCounters() {'), source.indexOf('  /* ── Eventos de busca ── */', source.indexOf('  function updateCounters() {')));
const users = [{ samAccountName: 'kamilly.monteiro', displayName: 'Kamilly Fernandes Monteiro', enabled: true }];
const queueMap = new Map();
const listWrap = { style: { display: 'none' } };
const listLabel = {};
const countBadge = { style: { display: 'none' } };
const genBtn = { disabled: true };
const listEl = { innerHTML: '', children: [], appendChild(item) { this.children.push(item); } };
const smartText = { value: 'KAMILLY FERNANDES MONTEIRO' };
let click;
const context = {
  queueMap, listWrap, listLabel, countBadge, genBtn, listEl, smartText,
  smartBtn: { addEventListener(event, fn) { click = fn; } },
  smartRes: { style: {} }, smartBody: { style: {} }, smartCaret: { style: {} },
  smartToggle: { classList: { remove() {} } },
  getUsers: () => users, getInitials: () => 'KM', showToast() {}, removeFromQueue() {}, console,
  document: { createElement() { return { querySelector() { return { addEventListener() {} }; } }; } }
};
vm.runInNewContext(counters + '\nif (true) {\n' + handler, context);
click();
assert.equal(queueMap.size, 1);
assert.equal(listEl.children.length, 1);
assert.equal(listWrap.style.display, '');
assert.equal(listLabel.textContent, '1 usuário na fila');
assert.equal(countBadge.textContent, 1);
assert.equal(countBadge.style.display, 'inline-flex');
assert.equal(genBtn.disabled, false);
console.log('Bulk disable import: imported user is visible and generation is enabled.');
