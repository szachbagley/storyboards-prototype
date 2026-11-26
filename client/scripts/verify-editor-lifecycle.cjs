// Offline browser regression. Start Vite with VITE_API_BASE_URL=http://mock.invalid,
// then run CHROMIUM_PATH=/usr/bin/chromium node client/scripts/verify-editor-lifecycle.cjs.
// Every browser request except the loopback Vite origin is intercepted or blocked.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const origin = process.env.UI_ORIGIN || 'http://127.0.0.1:5173';
const apiOrigin = 'http://mock.invalid';
const parsedOrigin = new URL(origin);
if (parsedOrigin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsedOrigin.hostname) || parsedOrigin.origin !== origin) throw Error('UI_ORIGIN must be an exact HTTP loopback origin');
const clone = x => JSON.parse(JSON.stringify(x));
const wait = ms => new Promise(r => setTimeout(r, ms));
const timeout = (ms, message) => new Promise((_, reject) => {
  const timer = setTimeout(() => reject(Error(message)), ms);
  timer.unref();
});
const gate = () => {
  let release;
  const promise = Promise.race([new Promise(r => { release = r; }), timeout(8000, 'gate timed out')]);
  return { promise, release };
};
const spa = (page, id) => page.evaluate(path => {
  history.pushState({}, '', path);
  dispatchEvent(new PopStateEvent('popstate'));
}, `/stories/story/frames/${id}`);
const sourceA = '11111111-1111-4111-8111-111111111111';
const sourceB = '22222222-2222-4222-8222-222222222222';
const frame = (id = 'a') => ({ id, storyId: 'story', position: 1, description: 'Original scene',
  continuitySourceFrameId: null, continuitySourceSelectedGenerationId: null, continuityReferencedByCount: 0,
  selectedImageState: 'none', selectedGenerationId: null, imageUrl: null, concepts: [], generations: [] });
const generation = (id, status = 'pending') => ({ id, status, imageUrl: null, errorCode: null,
  errorMessage: null, continuity: { provenance: 'known', source: null }, createdAt: '2026-01-01T00:00:00Z', completedAt: null });

async function fixture(browser, { unavailableStorage = false } = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [], requests = [], captures = [], frames = { a: frame('a'), b: frame('b') }, lookup = new Map();
  const state = { frames, requests, captures, lookup, concepts: [], account: 'account-a', postMode: 'accept', pollStatus: 'pending',
    failNextPatch: false, dispatches: 0, nextGetGate: null, nextPatchGate: null, nextPollGate: null, counter: 0 };
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(({ unavailable }) => {
    if (!sessionStorage.getItem('fixture.initialized')) {
      localStorage.setItem('storyboards.session', 'fixture-a');
      sessionStorage.setItem('fixture.initialized', 'yes');
    }
    if (unavailable) Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
  }, { unavailable: unavailableStorage });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin === origin && !url.pathname.startsWith('/api/')) return route.continue();
    if (url.origin !== apiOrigin) {
      errors.push(`Blocked outbound ${url.origin}`);
      return route.abort();
    }
    const path = url.pathname;
    let body, status = 200;
    const payload = request.postDataJSON();
    requests.push({ method, path, body: payload, account: state.account });
    if (path === '/api/auth/me') body = { id: state.account, username: state.account, hasGeminiKey: true };
    else if (path === '/api/auth/logout') status = 204;
    else if (path === '/api/auth/login') {
      state.account = 'account-b';
      body = { token: 'fixture-b', user: { id: state.account, username: state.account, hasGeminiKey: true } };
    }
    else if (path === '/api/concepts') body = clone(state.concepts);
    else if (path === '/api/stories/story') body = { id: 'story', title: 'Fixture story' };
    else if (path === '/api/stories/story/frames') body = Object.values(frames).map(({ concepts, generations, ...f }) => f);
    else if (/^\/api\/frames\/[^/]+$/.test(path)) {
      const id = path.split('/')[3];
      if (method === 'GET') {
        body = clone(frames[id]);
        if (state.nextGetGate) {
          const g = state.nextGetGate;
          state.nextGetGate = null;
          g.seen?.();
          await g.promise;
        }
      } else if (method === 'PATCH') {
        if (state.nextPatchGate) {
          const g = state.nextPatchGate;
          state.nextPatchGate = null;
          g.seen?.();
          await g.promise;
        }
        if (state.failNextPatch) {
          state.failNextPatch = false;
          status = 503;
          body = { error: { code: 'fixture_failure', message: 'Save failed; try again.' } };
        }
        else {
          Object.assign(frames[id], payload);
          body = clone(frames[id]);
        }
      }
    } else if (/\/generation-requests\//.test(path)) {
      const id = path.split('/').pop();
      if (lookup.has(id)) body = { generationId: lookup.get(id) };
      else {
        status = 404;
        body = { error: { code: 'not_found', message: 'Not found' } };
      }
    } else if (/\/generate$/.test(path) && method === 'POST') {
      const id = path.split('/')[3];
      captures.push({ frameId: id, description: frames[id].description, source: frames[id].continuitySourceFrameId, body: clone(payload) });
      const saved = requests.findLast(entry => entry.path === `/api/frames/${id}` && entry.method === 'PATCH');
      assert.ok(saved, 'every Generate must follow its acknowledged frame PATCH');
      assert.deepEqual(saved.body, { description: frames[id].description, continuitySourceFrameId: payload.expectedContinuitySourceFrameId });
      if (lookup.has(payload.requestId)) {
        status = 202;
        body = { generationId: lookup.get(payload.requestId) };
      } else if (state.postMode === 'config409') {
        frames[id].continuitySourceFrameId = sourceB;
        status = 409;
        body = { error: { code: 'continuity_configuration_changed', message: 'The source frame changed. Refresh and review it.' } };
      }
      else if (state.postMode === 'pending409') {
        status = 409;
        body = { error: { code: 'generation_in_progress', message: 'Already running', details: { generationId: 'existing' } } };
      }
      else {
        const gen = `aaaaaaaa-aaaa-4aaa-8aaa-${String(++state.counter).padStart(12, '0')}`;
        if (state.postMode !== 'lost-never') {
          state.dispatches++;
          lookup.set(payload.requestId, gen);
          frames[id].generations.unshift(generation(gen));
        }
        if (state.postMode.startsWith('lost-')) return route.abort('failed');
        body = { generationId: gen };
        status = 202;
      }
    } else if (/^\/api\/generations\//.test(path)) {
      if (state.nextPollGate) {
        const g = state.nextPollGate;
        state.nextPollGate = null;
        g.seen?.();
        await g.promise;
      }
      const id = path.split('/').pop();
      const historical = Object.values(frames).flatMap(f => f.generations).find(item => item.id === id);
      body = { ...generation(id, state.pollStatus), ...(historical && { continuity: historical.continuity }) };
      if (state.pollStatus !== 'pending') for (const f of Object.values(frames)) {
        const found = f.generations.find(g => g.id === id);
        if (found) Object.assign(found, body);
      }
    } else {
      errors.push(`Unexpected ${method} ${path}`);
      return route.abort();
    }
    if (body === undefined && status !== 204) {
      errors.push(`Unhandled ${method} ${path}`);
      return route.abort();
    }
    return route.fulfill({ status, ...(status === 204 ? {} : { json: body }) }).catch(() => {});
  });
  const open = id => page.goto(`${origin}/stories/story/frames/${id}`);
  const close = async () => {
    assert.deepEqual(errors, []);
    await context.close();
  };
  return { page, state, open, close };
}
const textarea = page => page.getByRole('textbox', { name: 'Frame description' });
const generate = page => page.getByRole('button', { name: /^Generate frame$/ });
const eventually = async (fn, message) => {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await wait(50);
  }
  throw Error(message);
};
const clickGenerate = async page => generate(page).click();

async function run(name, fn) {
  process.stdout.write(`${name} ... `);
  await fn();
  console.log('PASS');
}
async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] });
  try {
    await run('save barrier, same-tick double click, editing during admission and after 202', async () => {
      const f = await fixture(browser), { page, state } = f;
      const concept = id => ({ id, name: id, type: 'prop', description: '', imageUrl: null });
      state.frames.a.concepts = [concept('one'), concept('two')];
      state.concepts = [...state.frames.a.concepts, concept('three')];
      state.frames.a.generations = [generation('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'succeeded')];
      await f.open('a');
      await textarea(page).fill('Click intent');
      const hold = gate();
      state.nextPatchGate = hold;
      await generate(page).evaluate(button => {
        button.click();
        button.click();
      });
      await eventually(() => state.requests.some(r => r.method === 'PATCH'), 'save was not attempted');
      assert.equal(await textarea(page).isDisabled(), true);
      for (const button of ['Delete frame', 'Remove one', 'Move one down', 'Move two up', 'Attach', 'Use this generation']) {
        const control = button === 'Use this generation' ? page.getByTitle(button) : page.getByRole('button', { name: button, exact: true });
        assert.equal(await control.isDisabled(), true, `${button} must be disabled during admission`);
      }
      assert.equal(state.captures.length, 0);
      hold.release();
      await eventually(() => state.captures.length === 1, 'one generation was not submitted');
      assert.equal(state.captures[0].description, 'Click intent');
      assert.equal(state.captures[0].source, null);
      assert.equal(state.captures[0].body.expectedContinuitySourceFrameId, null);
      assert.match(state.captures[0].body.requestId, /^[0-9a-f-]{36}$/i);
      await eventually(async () => !(await textarea(page).isDisabled()), 'editing did not resume after admission');
      assert.equal(await page.getByRole('button', { name: 'Attach', exact: true }).isEnabled(), true);
      assert.equal(await page.getByRole('button', { name: 'Remove one' }).isEnabled(), true);
      assert.equal(await page.getByTitle('Use this generation').isEnabled(), true);
      await textarea(page).fill('Later draft');
      assert.equal(await textarea(page).inputValue(), 'Later draft');
      await f.close();
    });
    await run('in-flight blur save failure blocks Generate even if later PATCH would succeed', async () => {
      const f = await fixture(browser), { page, state } = f;
      await f.open('a');
      const hold = gate();
      state.nextPatchGate = hold;
      state.failNextPatch = true;
      await textarea(page).fill('Unsaved draft');
      await textarea(page).blur();
      await eventually(() => state.requests.some(r => r.method === 'PATCH'), 'blur PATCH missing');
      await clickGenerate(page);
      hold.release();
      await page.getByText(/save failed|could not save/i).first().waitFor();
      await wait(200);
      assert.equal(state.captures.length, 0);
      assert.equal(state.dispatches, 0);
      assert.equal(await textarea(page).inputValue(), 'Unsaved draft');
      await clickGenerate(page);
      await eventually(() => state.captures.length === 1, 'retry did not submit');
      assert.equal(state.captures[0].description, 'Unsaved draft');
      await f.close();
    });
    await run('acknowledgement cannot mark a later edit matching original as saved', async () => {
      const f = await fixture(browser), { page, state } = f;
      await f.open('a');
      const hold = gate();
      state.nextPatchGate = hold;
      await textarea(page).fill('Intermediate B');
      await textarea(page).blur();
      await eventually(() => state.requests.some(r => r.method === 'PATCH'), 'blur PATCH missing');
      await textarea(page).fill('Original scene');
      hold.release();
      await eventually(() => state.frames.a.description === 'Intermediate B', 'held save not acknowledged');
      await wait(100);
      assert.equal(await textarea(page).inputValue(), 'Original scene');
      await clickGenerate(page);
      await eventually(() => state.captures.length === 1, 'submission missing');
      assert.equal(state.captures[0].description, 'Original scene');
      await f.close();
    });
    await run('terminal refresh preserves later draft; second success refreshes too', async () => {
      const f = await fixture(browser), { page, state } = f;
      await f.open('a');
      const base = state.requests.filter(r => r.path === '/api/frames/a' && r.method === 'GET').length;
      await textarea(page).fill('First');
      await clickGenerate(page);
      await eventually(() => state.captures.length === 1, 'first submission missing');
      await eventually(async () => !(await textarea(page).isDisabled()), 'first admission did not finish');
      await textarea(page).fill('Draft during polling');
      state.pollStatus = 'succeeded';
      await eventually(() => state.requests.filter(r => r.path === '/api/frames/a' && r.method === 'GET').length >= base + 1, 'first terminal refresh missing');
      assert.equal(await textarea(page).inputValue(), 'Draft during polling');
      await eventually(async () => await generate(page).isEnabled(), 'first completion did not unlock Generate');
      state.pollStatus = 'pending';
      await clickGenerate(page);
      await eventually(() => state.captures.length === 2, 'second submission missing');
      assert.equal(state.captures[1].description, 'Draft during polling');
      assert.notEqual(state.captures[0].body.requestId, state.captures[1].body.requestId);
      state.pollStatus = 'succeeded';
      await eventually(() => state.requests.filter(r => r.path === '/api/frames/a' && r.method === 'GET').length >= base + 2, 'second terminal refresh missing');
      assert.equal(await textarea(page).inputValue(), 'Draft during polling');
      await f.close();
    });
    await run('delayed pre-save read cannot overwrite acknowledged clean draft', async () => {
      const f = await fixture(browser), { page, state } = f;
      await f.open('a');
      await textarea(page).fill('Submitted');
      await clickGenerate(page);
      await eventually(() => state.captures.length === 1, 'submission missing');
      const hold = gate();
      let seen;
      const started = new Promise(r => { seen = r; });
      hold.seen = seen;
      state.nextGetGate = hold;
      state.pollStatus = 'succeeded';
      await started;
      await textarea(page).fill('Saved after read began');
      await textarea(page).blur();
      await eventually(() => state.frames.a.description === 'Saved after read began', 'save not acknowledged');
      hold.release();
      await wait(500);
      assert.equal(await textarea(page).inputValue(), 'Saved after read began');
      await eventually(() => state.requests.filter(r => r.method === 'GET' && r.path === '/api/frames/a').length >= 3, 'fresh read after stale read missing');
      await f.close();
    });
    await run('navigate away while old read and poll are pending', async () => {
      const f = await fixture(browser), { page, state } = f;
      await f.open('a');
      const holdPoll = gate();
      state.nextPollGate = holdPoll;
      await clickGenerate(page);
      await eventually(() => state.requests.some(r => r.path.startsWith('/api/generations/')), 'poll missing');
      await spa(page, 'b');
      await textarea(page).waitFor();
      assert.equal(await textarea(page).inputValue(), 'Original scene');
      await textarea(page).fill('Frame B draft');
      holdPoll.release();
      await wait(300);
      assert.equal(await textarea(page).inputValue(), 'Frame B draft');
      assert.equal(state.captures.length, 1);
      assert.equal(state.captures[0].frameId, 'a');
      await f.close();
    });
    await run('old frame read cannot replace new frame after navigation', async () => {
      const f = await fixture(browser), { page, state } = f;
      const hold = gate();
      let seen;
      const started = new Promise(r => { seen = r; });
      hold.seen = seen;
      state.nextGetGate = hold;
      await f.open('a');
      await started;
      state.frames.b.description = 'Frame B only';
      await spa(page, 'b');
      await eventually(async () => (await textarea(page).inputValue()) === 'Frame B only', 'frame B not loaded');
      hold.release();
      await wait(250);
      assert.equal(await textarea(page).inputValue(), 'Frame B only');
      assert.equal(state.captures.length, 0);
      await f.close();
    });
    await run('pending polls do not overlap', async () => {
      const f = await fixture(browser), { page, state } = f;
      await page.clock.install();
      const hold = gate();
      state.nextPollGate = hold;
      await f.open('a');
      await clickGenerate(page);
      await eventually(() => state.requests.filter(r => r.path.startsWith('/api/generations/')).length === 1, 'first poll missing');
      await page.clock.fastForward(12_000);
      await wait(100);
      assert.equal(state.requests.filter(r => r.path.startsWith('/api/generations/')).length, 1);
      hold.release();
      await f.close();
    });
    await run('server source refresh is reasserted in final save and submission', async () => {
      const f = await fixture(browser), { page, state } = f;
      state.frames.a.continuitySourceFrameId = sourceA;
      state.pollStatus = 'pending';
      await f.open('a');
      await clickGenerate(page);
      await eventually(() => state.captures.length === 1, 'first post missing');
      state.frames.a.continuitySourceFrameId = sourceB;
      state.pollStatus = 'succeeded';
      await eventually(() => state.requests.filter(r => r.path === '/api/frames/a' && r.method === 'GET').length >= 2, 'refresh missing');
      await eventually(async () => await generate(page).isEnabled(), 'first completion did not unlock');
      state.pollStatus = 'pending';
      await clickGenerate(page);
      await eventually(() => state.captures.length === 2, 'second post missing');
      assert.equal(state.captures[1].source, sourceB);
      assert.equal(state.captures[1].body.expectedContinuitySourceFrameId, sourceB);
      await f.close();
    });
    await run('configuration conflict requires review and explicit new submission', async () => {
      const f = await fixture(browser), { page, state } = f;
      state.frames.a.continuitySourceFrameId = sourceA;
      state.postMode = 'config409';
      await f.open('a');
      await textarea(page).fill('Preserved on conflict');
      await clickGenerate(page);
      await page.getByRole('button', { name: 'Use current source' }).waitFor();
      assert.equal(state.captures.length, 1);
      assert.equal(await textarea(page).inputValue(), 'Preserved on conflict');
      state.postMode = 'accept';
      await page.getByRole('button', { name: 'Use current source' }).click();
      await wait(200);
      assert.equal(state.captures.length, 1);
      await clickGenerate(page);
      await eventually(() => state.captures.length === 2, 'explicit submit missing');
      assert.equal(state.captures[1].description, 'Preserved on conflict');
      assert.equal(state.captures[1].source, sourceB);
      assert.equal(state.captures[1].body.expectedContinuitySourceFrameId, sourceB);
      await f.close();
    });
    await run('lost 202 found on reload via lookup, without second POST', async () => {
      const f = await fixture(browser), { page, state } = f;
      state.postMode = 'lost-found';
      await f.open('a');
      await clickGenerate(page);
      await page.getByRole('button', { name: 'Check request' }).waitFor();
      assert.equal(state.captures.length, 1);
      await page.reload();
      await eventually(() => state.requests.some(r => r.path.includes('/generation-requests/')), 'lookup missing');
      await eventually(() => state.requests.some(r => r.path.startsWith('/api/generations/')), 'found request not polled');
      await page.getByText('Recovered generation pending. This attempt used no continuity source.').waitFor();
      assert.equal(state.captures.length, 1);
      assert.equal(state.dispatches, 1);
      await f.close();
    });
    await run('lost request not found: lookup only until explicit same-token resubmit', async () => {
      const f = await fixture(browser), { page, state } = f;
      state.postMode = 'lost-never';
      await f.open('a');
      await clickGenerate(page);
      await page.getByRole('button', { name: 'Check request' }).waitFor();
      await page.reload();
      await page.getByRole('button', { name: 'Resubmit request' }).waitFor();
      assert.equal(state.captures.length, 1);
      assert.equal(state.dispatches, 0);
      const id = state.captures[0].body.requestId;
      state.postMode = 'accept';
      await page.getByRole('button', { name: 'Resubmit request' }).click();
      await eventually(() => state.captures.length === 2, 'resubmit missing');
      assert.equal(state.captures[1].body.requestId, id);
      assert.equal(state.captures[1].description, state.captures[0].description);
      assert.equal(state.dispatches, 1);
      await f.close();
    });
    await run('late original admission wins explicit same-token resubmission', async () => {
      const f = await fixture(browser);
      const { page, state } = f;
      state.frames.a.continuitySourceFrameId = sourceA;
      state.postMode = 'lost-never';
      await f.open('a');
      await clickGenerate(page);
      await page.getByRole('button', { name: 'Check request' }).click();
      const resubmit = page.getByRole('button', { name: 'Resubmit request' });
      await resubmit.waitFor();
      const requestId = state.captures[0].body.requestId;
      assert.equal(state.dispatches, 0);

      // The original request finishes preflight after lookup. Its frozen
      // source remains authoritative when the browser later replays the UUID.
      const originalId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      const original = generation(originalId, 'succeeded');
      original.continuity.source = { frameId: sourceA, generationId: sourceB, sourceFrameDeleted: false };
      state.lookup.set(requestId, originalId);
      state.frames.a.generations.unshift(original);
      state.dispatches++;
      state.postMode = 'accept';
      state.pollStatus = 'succeeded';
      await textarea(page).fill('Newly saved scene');
      await resubmit.click();
      await page.getByText(`Recovered generation succeeded. Recorded source frame ${sourceA}, image generation ${sourceB}.`).waitFor();
      assert.deepEqual(state.captures.map(post => post.body.requestId), [requestId, requestId]);
      assert.equal(state.captures[1].description, 'Newly saved scene');
      assert.equal(await textarea(page).inputValue(), 'Newly saved scene');
      assert.equal(state.dispatches, 1);
      await f.close();
    });
    await run('409 existing pending resumes polling without redispatch', async () => {
      const f = await fixture(browser), { page, state } = f;
      state.postMode = 'pending409';
      await f.open('a');
      await clickGenerate(page);
      await eventually(() => state.requests.some(r => r.path === '/api/generations/existing'), 'existing generation not polled');
      assert.equal(state.captures.length, 1);
      await f.close();
    });
    await run('poll ceiling offers manual check without new POST', async () => {
      const f = await fixture(browser), { page, state } = f;
      await page.clock.install();
      await f.open('a');
      await clickGenerate(page);
      await eventually(() => state.captures.length === 1, 'submission missing');
      await eventually(() => state.requests.some(r => r.path.startsWith('/api/generations/')), 'initial poll missing');
      await page.clock.fastForward(106_000);
      await page.getByRole('button', { name: 'Check again' }).waitFor();
      const before = state.requests.filter(r => r.path.startsWith('/api/generations/')).length;
      await page.getByRole('button', { name: 'Check again' }).click();
      await eventually(() => state.requests.filter(r => r.path.startsWith('/api/generations/')).length > before, 'manual check did not poll');
      assert.equal(state.captures.length, 1);
      await f.close();
    });
    await run('known terminal failure retries with new request UUID', async () => {
      const f = await fixture(browser), { page, state } = f;
      state.pollStatus = 'failed';
      await f.open('a');
      await clickGenerate(page);
      await page.getByRole('button', { name: 'Retry' }).waitFor();
      const first = state.captures[0].body.requestId;
      state.pollStatus = 'pending';
      await page.getByRole('button', { name: 'Retry' }).click();
      await eventually(() => state.captures.length === 2, 'retry did not submit');
      assert.notEqual(state.captures[1].body.requestId, first);
      assert.equal(state.dispatches, 2);
      await f.close();
    });
    await run('non-newest pending history resumes without POST', async () => {
      const f = await fixture(browser), { state } = f;
      const pending = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      state.frames.a.generations = [generation('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'succeeded'), generation(pending)];
      await f.open('a');
      await eventually(() => state.requests.some(r => r.path === `/api/generations/${pending}`), 'older pending history not resumed');
      assert.equal(state.captures.length, 0);
      assert.equal(state.dispatches, 0);
      await f.close();
    });
    await run('unavailable session storage discloses recovery limit', async () => {
      const f = await fixture(browser, { unavailableStorage: true }), { page, state } = f;
      state.postMode = 'lost-never';
      await f.open('a');
      await clickGenerate(page);
      await page.getByText(/reload cannot resolve an unknown submission/i).waitFor();
      assert.equal(state.captures.length, 1);
      await f.close();
    });
    await run('sign-out and account switch do not reuse pending metadata', async () => {
      const f = await fixture(browser), { page, state } = f;
      state.postMode = 'lost-never';
      await f.open('a');
      await clickGenerate(page);
      await page.getByRole('button', { name: 'Check request' }).waitFor();
      const beforeSignout = await page.evaluate(() => Object.keys(sessionStorage).filter(k => k !== 'fixture.initialized'));
      assert.ok(beforeSignout.length > 0, 'no pending metadata before sign-out');
      await page.getByRole('link', { name: 'Settings' }).click();
      await page.getByRole('button', { name: 'Sign out' }).click();
      await page.getByRole('textbox', { name: 'Username' }).fill('other');
      await page.getByRole('textbox', { name: 'Password' }).fill('password');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await eventually(async () => await page.evaluate(() => localStorage.getItem('storyboards.session')) === 'fixture-b', 'new account login missing');
      const remaining = await page.evaluate(() => Object.keys(sessionStorage));
      assert.ok(beforeSignout.every(k => !remaining.includes(k)), 'pending metadata survived sign-out');
      await f.open('a');
      await textarea(page).waitFor();
      await wait(300);
      assert.equal(state.requests.filter(r => r.account === 'account-b' && r.path.includes('/generation-requests/')).length, 0);
      assert.equal(state.captures.length, 1);
      await f.close();
    });
  } finally { await browser.close(); }
  console.log('Offline lifecycle scenarios passed; no browser request reached a non-loopback origin.');
}
const deadline = setTimeout(() => {
  console.error('Overall browser verification timed out.');
  process.exit(1);
}, 120_000);
deadline.unref();
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => clearTimeout(deadline));
