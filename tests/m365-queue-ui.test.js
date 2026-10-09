const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.listeners = {}; this.textContent = ''; }
  append(...children) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  addEventListener(event, fn) { this.listeners[event] = fn; }
}
const elements = Object.fromEntries(['m365QueueStatus', 'm365QueueList', 'refreshM365Queue', 'tabBtnM365', 'panelM365'].map(id => [id, new Element('div')]));
let job = {
  id: 'job1', userPrincipalName: '<unsafe>@example.invalid', status: 'failed', dueAt: '2026-01-01T12:00:00Z',
  steps: [{ name: '<script>test</script>', source: 'Exchange', done: false }], attempts: 36, lines: ['Waiting for recipient']
};
const requests = [];
let responseStatus = 200;
const context = {
  window: { _serverToken: 'test-token', _SERVER_BASE: 'http://localhost:7510' },
  document: { getElementById: id => elements[id], createElement: tag => new Element(tag) },
  setInterval: () => {},
  fetch: async (url, options) => {
    requests.push({ url, options });
    if (options.method === 'POST') { job.status = 'retry'; return { ok: true }; }
    return { ok: responseStatus === 200, status: responseStatus, json: async () => ({ jobs: [job] }) };
  }
};
vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../m365-queue.js'), 'utf8'), context);
(async () => {
  await new Promise(setImmediate); // Initial automatic load.
  await context.window.refreshM365Queue();
  const row = elements.m365QueueList.children[0];
  assert(row.children[0].textContent.includes('<unsafe>@example.invalid'));
  assert.equal(row.children[0].innerHTML, undefined, 'Untrusted values must remain plain text');
  const retry = row.children.find(child => child.tag === 'button');
  assert.equal(retry.textContent, 'Repetir etapas pendentes');
  await retry.listeners.click();
  const request = requests.find(entry => entry.options.method === 'POST');
  assert.equal(request.url, 'http://localhost:7510/api/m365/fila/acao');
  assert.equal(request.options.headers['X-Server-Token'], 'test-token');
  assert.deepEqual(JSON.parse(request.options.body), { id: 'job1', action: 'retry' });
  assert(elements.m365QueueList.children[0].children[0].textContent.includes('Aguardando nova tentativa'));
  responseStatus = 404;
  await context.window.refreshM365Queue();
  assert(elements.m365QueueStatus.textContent.includes('Reinicie o PowerShell'), 'Old backend must explain how to recover');
  context.window._serverToken = null;
  const before = requests.length;
  await context.window.refreshM365Queue();
  assert.equal(requests.length, before, 'No request without a server token');
  // Test the compatibility guard from the real application without running its UI.
  const source = fs.readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8');
  let ping = { token: 'old' };
  const guard = { window: { _SERVER_BASE: 'http://localhost:7510' }, AbortController, setTimeout, clearTimeout,
    fetch: async () => ({ ok: true, json: async () => ping }) };
  vm.runInNewContext(source.slice(0, source.indexOf('function escapeHTML')), guard);
  await assert.rejects(guard.window.ensureM365QueueReady(), /servidor aberto/);
  assert.equal(guard.window._serverToken, undefined);
  ping = { token: 'new', m365QueueVersion: 2 };
  await guard.window.ensureM365QueueReady();
  assert.equal(guard.window._serverToken, 'new');
  console.log('PASS: queue rendering, safe text, retry action, authentication, initial load, old-server error and compatibility guard.');
})().catch(error => { console.error(error); process.exitCode = 1; });
