const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8')
  .split('<script>')[1].split('</script>')[0];

function createContext(fetch) {
  const elements = new Map();
  const context = {
    fetch,
    AbortSignal,
    window: {},
    localStorage: { getItem: () => null },
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, { value: '', style: {} });
        return elements.get(id);
      }
    },
    alert(message) { throw new Error(message); }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context;
}

function response(data, status = 200) {
  return { ok: status === 200, status, json: async () => data };
}

function modelList() {
  return response({ models: ['gemini-3.8-flash', 'gemini-2.0-flash'].map(baseModelId => ({
    baseModelId, supportedGenerationMethods: ['generateContent']
  })) });
}

function chapterResponse() {
  return response({ candidates: [{ content: { parts: [{ text: JSON.stringify({
    title: 'A small surprise', paragraphs: ['A gentle adventure.'], choices: [], photoKeyword: 'stars'
  }) }] } }] });
}

test('later chapters reuse discovery and try the successful fallback first', async () => {
  const calls = [];
  const context = createContext(async (url, options) => {
    calls.push(url);
    assert.ok(options.signal);
    if (url.includes('/models?')) return modelList();
    if (url.includes('gemini-3.8-flash')) return response({ error: { message: 'Busy' } }, 503);
    return chapterResponse();
  });
  await context.callGeminiWithFallback('fake-key', 'chapter one');
  await context.callGeminiWithFallback('fake-key', 'chapter two');
  assert.equal(calls.length, 4);
  assert.ok(calls[3].includes('gemini-2.0-flash'));
  assert.equal(calls.filter(url => url.includes('/models?')).length, 1);
  await context.callGeminiWithFallback('different-fake-key', 'new story');
  assert.equal(calls.filter(url => url.includes('/models?')).length, 2);
});

test('timeouts fall back and authentication failures stop further attempts', async () => {
  let attempts = 0;
  const context = createContext(async url => {
    if (url.includes('/models?')) return modelList();
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('slow'), { name: 'TimeoutError' });
    return chapterResponse();
  });
  await context.callGeminiWithFallback('fake-key', 'test');
  assert.equal(attempts, 2);
  attempts = 0;
  context.fetch = async url => {
    if (url.includes('/models?')) return modelList();
    attempts += 1;
    return response({ error: { message: 'Permission denied' } }, 403);
  };
  await assert.rejects(context.callGeminiWithFallback('fake-key', 'test'), /Permission denied/);
  assert.equal(attempts, 1);
});

test('all 18 templates use available image keys and the prompt requests balanced prose', async () => {
  const context = createContext();
  const themes = vm.runInContext('STORY_THEMES', context);
  const photos = vm.runInContext('Object.keys(SCENE_PHOTOS)', context);
  assert.equal(themes.length, 18);
  assert.equal(new Set(themes.map(theme => theme.name)).size, 18);
  for (const theme of themes) {
    assert.ok(theme.photoKeywords.every(keyword => photos.includes(keyword)));
  }
  context.document.getElementById('apiKeyInput').value = 'fake-key';
  context.document.getElementById('customPrompt').value = themes[10].prompt;
  let prompt;
  context.callGeminiWithFallback = async (key, text) => {
    prompt = text;
    return { paragraphs: ['A gentle adventure.'] };
  };
  context.displayChapter = () => {};
  await context.generateNextChapter(1, '');
  assert.ok(prompt.includes('130-170 words'));
  assert.ok(prompt.includes('both ages (2 and 5)'));
  assert.ok(prompt.includes('Pirate') || prompt.includes('friendly pirates'));
  assert.ok(prompt.includes('a small surprise or obstacle'));
  assert.ok(!prompt.includes('usually 4-8 words'));
});