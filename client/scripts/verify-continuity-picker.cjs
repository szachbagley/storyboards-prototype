// Run against a local build/preview with VITE_API_BASE_URL=http://mock.invalid.
// UI_ORIGIN=http://127.0.0.1:5183 CHROMIUM_PATH=/usr/bin/chromium node client/scripts/verify-continuity-picker.cjs
// Every browser request is intercepted; non-loopback and loopback /api requests fail closed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const screenshotDir = process.env.SCREENSHOT_DIR || path.join(os.tmpdir(), 'storyboards-issue14');
fs.mkdirSync(screenshotDir, { recursive: true });
const { chromium } = require('playwright');
const origin = process.env.UI_ORIGIN || 'http://127.0.0.1:5173';
const u = new URL(origin);
if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.origin !== origin)
    throw Error('UI_ORIGIN must be an HTTP loopback origin');
const mock = 'http://mock.invalid';
const clone = o => JSON.parse(JSON.stringify(o));
const wait = ms => new Promise(r => setTimeout(r, ms));
const timeout = (ms, message) => new Promise((_, reject) => {
    const timer = setTimeout(() => reject(Error(message)), ms);
    timer.unref();
});
const gate = () => {
    let release;
    const promise = Promise.race([
        new Promise(resolve => { release = resolve; }),
        timeout(8000, 'gate timeout'),
    ]);
    return { promise, release };
};
const eventually = async (fn, message) => {
    for (let i = 0; i < 100; i++) {
        if (await fn()) return;
        await wait(50);
    }
    throw Error(message);
};
const ids = {
    earlier: '11111111-1111-4111-8111-111111111111',
    target: '22222222-2222-4222-8222-222222222222',
    later: '33333333-3333-4333-8333-333333333333',
    unusable: '44444444-4444-4444-8444-444444444444',
    gen: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    gen2: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};
const summary = (id, position, description, state = 'ready') => ({
    id, storyId: 'story', position, description,
    continuitySourceFrameId: null, continuitySourceSelectedGenerationId: null,
    continuityReferencedByCount: 0, selectedImageState: state,
    selectedGenerationId: state === 'ready' ? ids.gen : null, imageUrl: null,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
});
const generation = (id, continuity) => ({
    id, status: 'succeeded', imageUrl: null, errorCode: null, errorMessage: null,
    continuity, createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:01Z',
});
const concept = (n, type = 'prop') => ({
    id: `concept-${n}`, name: `Fixture ${n}`, type, description: '', imageUrl: null,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
});
async function fixture(browser, options = {}) {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: options.mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
    const page = await context.newPage();
    const rows = [summary(ids.earlier, 1, 'Earlier scene'), summary(ids.target, 2, 'Target scene'), summary(ids.later, 3, 'Later scene'), summary(ids.unusable, 4, 'Unusable scene', 'none')];
    const target = { ...rows[1], continuityEnabled: options.enabled !== false, concepts: [], generations: [] };
    if (options.enabled === undefined)
        delete target.continuityEnabled;
    const state = { rows, target, requests: [], dispatches: 0, captures: [], listGate: null, listFailure: false, invalidSources: new Set(), closeGateBeforeCapture: false, failNextPatch: false, failPreflight: false, deleteCount: 0, conceptList: [], nextPatchGate: null };
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => localStorage.setItem('storyboards.session', 'fixture-token'));
    await page.route('**/*', async (route) => {
        const req = route.request(), url = new URL(req.url()), method = req.method();
        if (url.origin === origin && !url.pathname.startsWith('/api/'))
            return route.continue();
        if (url.origin !== mock) {
            errors.push(`Blocked outbound ${url.origin}`);
            return route.abort();
        }
        const path = url.pathname, payload = req.postDataJSON();
        state.requests.push({ method, path, query: url.search, body: payload });
        let body, status = 200;
        if (path === '/api/auth/me')
            body = { id: 'fixture-user', username: 'fixture', hasGeminiKey: true };
        else if (path === '/api/concepts')
            body = clone(state.conceptList);
        else if (path === '/api/stories/story')
            body = { id: 'story', title: 'Fixture story' };
        else if (path === '/api/stories/story/frames') {
            body = clone([...state.rows].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)));
            if (state.listGate) {
                const hold = state.listGate;
                state.listGate = null;
                hold.seen?.();
                await hold.promise;
            }
            if (state.listFailure) {
                status = 503;
                body = { error: { code: 'unavailable', message: 'Fixture source list unavailable' } };
            }
        }
        else if (path === `/api/frames/${ids.target}` && method === 'GET')
            body = clone(state.target);
        else if (path === `/api/frames/${ids.target}` && method === 'PATCH') {
            if (state.nextPatchGate) {
                const hold = state.nextPatchGate;
                state.nextPatchGate = null;
                hold.seen?.();
                await hold.promise;
            }
            if (state.invalidSources.has(payload.continuitySourceFrameId)) {
                status = 422;
                body = { error: { code: 'invalid_continuity_source', message: 'Choose another frame in this story.' } };
            } else if (payload.continuitySourceFrameId && state.target.continuityEnabled !== true) {
                status = 422;
                body = { error: { code: 'continuity_unavailable', message: 'Continuity unavailable.' } };
            } else if (state.failNextPatch) {
                state.failNextPatch = false;
                status = 503;
                body = { error: { code: 'fixture_failure', message: 'Could not save source. Try again.' } };
            } else {
                Object.assign(state.target, payload);
                body = clone(state.target);
            }
        }
        else if (path === `/api/frames/${ids.target}` && method === 'DELETE') {
            state.deleteCount++;
            if (state.deleteCount <= 2) {
                status = 409;
                body = { error: { code: 'continuity_source_in_use', message: 'Deleting clears 2 source links. Existing images and copied continuity inputs remain with their targets. Accepted work may still be billed.', details: { referencedByCount: 2, referenceSetToken: (state.deleteCount === 1 ? 'a' : 'b').repeat(64) } } };
            }
            else
                status = 204;
        }
        else if (path === `/api/frames/${ids.target}/generate` && method === 'POST') {
            state.captures.push({ description: state.target.description, source: state.target.continuitySourceFrameId, body: payload });
            if (state.closeGateBeforeCapture) {
                state.closeGateBeforeCapture = false;
                state.target.continuitySourceFrameId = ids.later;
                state.target.continuityEnabled = false;
                status = 409;
                body = { error: { code: 'continuity_configuration_changed', message: 'The source frame changed.' } };
            } else if (state.failPreflight) {
                state.failPreflight = false;
                status = 503;
                body = { error: { code: 'reference_storage_unavailable', message: 'Reference storage is temporarily unavailable. Try again.' } };
            } else {
                state.dispatches++;
                status = 202;
                body = { generationId: ids.gen2 };
            }
        }
        else if (path === `/api/generations/${ids.gen2}`)
            body = { ...generation(ids.gen2, { provenance: 'known', source: null }), status: 'pending' };
        else {
            errors.push(`Unexpected ${method} ${path}`);
            return route.abort();
        }
        return route.fulfill({ status, ...(status === 204 ? {} : { json: body }) }).catch(() => { });
    });
    const open = () => page.goto(`${origin}/stories/story/frames/${ids.target}`);
    const close = async () => { assert.deepEqual(errors, []); await context.close(); };
    return { page, state, open, close };
}
const scene = page => page.getByRole('textbox', { name: 'Frame description' });
const generate = page => page.getByRole('button', { name: 'Generate frame', exact: true });
const radio = (page, name) => page.getByRole('radio', { name });
const run = async (name, fn) => { process.stdout.write(`${name} ... `); await fn(); console.log('PASS'); };
async function main() {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] });
    try {
        await run('legacy and disabled capability do not fetch candidates', async () => {
            for (const enabled of [undefined, false]) {
                const f = await fixture(browser, { enabled });
                await f.open();
                await scene(f.page).waitFor();
                await wait(200);
                assert.equal(await f.page.getByRole('radio').count(), 0);
                assert.equal(f.state.requests.filter(r => r.path === '/api/stories/story/frames').length, 0);
                assert.equal(f.state.dispatches, 0);
                await f.close();
            }
        });
        await run('picker readiness, keyboard selection, save barrier and clear', async () => {
            const f = await fixture(browser, { enabled: true }), { page, state } = f;
            await f.open();
            await radio(page, /Frame 1.*Earlier/i).waitFor();
            assert.equal(await radio(page, /Frame 4.*Later/i).isDisabled(), true);
            assert.equal(await radio(page, /Frame 2/).count(), 0);
            assert.equal(await radio(page, /Frame 3.*Later/i).isEnabled(), true);
            await scene(page).fill('Dirty scene survives source change');
            await radio(page, /Frame 1.*Earlier/i).focus();
            await page.keyboard.press('Space');
            await eventually(() => state.target.continuitySourceFrameId === ids.earlier, 'source change not saved');
            assert.equal(state.dispatches, 0);
            assert.equal(await scene(page).inputValue(), 'Dirty scene survives source change');
            await radio(page, 'None').check();
            await eventually(() => state.target.continuitySourceFrameId === null, 'clear did not save');
            assert.equal(state.dispatches, 0);
            await f.close();
        });
        await run('source select then immediate Generate captures intent', async () => {
            const f = await fixture(browser, { enabled: true }), { page, state } = f;
            await f.open();
            await radio(page, /Frame 3.*Later/i).waitFor();
            await scene(page).fill('Generate this dirty scene');
            const hold = gate();
            state.nextPatchGate = hold;
            await radio(page, /Frame 3.*Later/i).check();
            await eventually(() => state.requests.some(r => r.method === 'PATCH'), 'source PATCH missing');
            const click = generate(page).click();
            hold.release();
            await click;
            await eventually(() => state.dispatches === 1, 'generation not admitted');
            assert.equal(state.captures[0].description, 'Generate this dirty scene');
            assert.equal(state.captures[0].source, ids.later);
            assert.equal(state.captures[0].body.expectedContinuitySourceFrameId, ids.later);
            await f.close();
        });
        for (const scenario of ['generate after save', 'generate while queued', 'latest save fails']) {
            await run(`obsolete source failure: ${scenario}`, async () => {
                const f = await fixture(browser, { enabled: true });
                const { page, state } = f;
                await f.open();
                const first = radio(page, /Frame 1.*Earlier/i);
                const second = radio(page, /Frame 3.*Later/i);
                await first.waitFor();
                const hold = gate();
                state.nextPatchGate = hold;
                state.invalidSources.add(ids.earlier);
                if (scenario === 'latest save fails') state.invalidSources.add(ids.later);
                await first.check();
                await eventually(() => state.requests.some(r => r.method === 'PATCH'), 'first save never started');
                await second.check();
                if (scenario !== 'generate after save') await generate(page).click();
                assert.equal(state.captures.length, 0);
                hold.release();

                const review = page.getByText('Review the source before generating.', { exact: false });
                if (scenario === 'latest save fails') {
                    await review.waitFor();
                    await page.getByText(`Intended source: ${ids.later}`, { exact: false }).waitFor();
                    assert.equal(await generate(page).isDisabled(), true);
                    assert.equal(state.captures.length, 0);
                    assert.equal(state.dispatches, 0);
                } else {
                    await eventually(() => state.target.continuitySourceFrameId === ids.later, 'latest choice was not saved');
                    if (scenario === 'generate after save') {
                        await page.getByText('Saved', { exact: true }).waitFor();
                        assert.equal(await review.count(), 0);
                        assert.equal(state.captures.length, 0);
                        await generate(page).click();
                    }
                    await eventually(() => state.dispatches === 1, 'explicit generation did not use the saved choice');
                    assert.equal(await second.isChecked(), true);
                    assert.equal(await review.count(), 0);
                    assert.equal(state.captures.length, 1);
                    assert.equal(state.captures[0].source, ids.later);
                    assert.equal(state.captures[0].body.expectedContinuitySourceFrameId, ids.later);
                }
                await f.close();
            });
        }
        await run('source conflict after gate closure allows explicit clear and later generation', async () => {
            const f = await fixture(browser, { enabled: true });
            const { page, state } = f;
            state.target.continuitySourceFrameId = ids.earlier;
            state.closeGateBeforeCapture = true;
            await f.open();
            await radio(page, /Frame 1.*Earlier/i).waitFor();
            await scene(page).fill('Preserve this scene when clearing the source');
            await generate(page).click();
            await page.getByText(`Current source: ${ids.later}`, { exact: false }).waitFor();
            assert.equal(state.captures.length, 1);
            assert.equal(state.dispatches, 0);
            assert.equal(await generate(page).isDisabled(), true);
            await page.getByRole('button', { name: 'Clear source and save scene' }).click();
            await eventually(async () => state.target.continuitySourceFrameId === null && await generate(page).isEnabled(), 'clear did not resolve review');
            assert.equal(state.target.description, 'Preserve this scene when clearing the source');
            assert.equal(await scene(page).inputValue(), state.target.description);
            assert.equal(state.captures.length, 1);
            assert.equal(state.dispatches, 0);
            await generate(page).click();
            await eventually(() => state.dispatches === 1, 'manual no-source generation did not start');
            assert.equal(state.captures.length, 2);
            assert.equal(state.captures[1].body.expectedContinuitySourceFrameId, null);
            assert.equal(state.captures[1].description, state.target.description);
            await f.close();
        });
        await run('focus/manual refresh reorders labels and ignores stale response', async () => {
            const f = await fixture(browser, { enabled: true }), { page, state } = f;
            await f.open();
            await radio(page, /Frame 1.*Earlier/i).waitFor();
            await scene(page).fill('Unsaved while candidates refresh');
            const hold = gate();
            let seen;
            const started = new Promise(r => seen = r);
            hold.seen = seen;
            state.listGate = hold;
            await page.getByRole('button', { name: 'Refresh sources' }).click();
            await started;
            state.rows[0].position = 5;
            state.rows[2].position = 1;
            await page.evaluate(() => dispatchEvent(new Event('focus')));
            hold.release();
            await eventually(async () => await radio(page, /Frame 1.*Earlier/i).count() > 0, 'new list missing');
            await eventually(async () => await radio(page, /Frame 1.*Earlier.*Later scene/i).count() > 0, 'reordered candidate label missing');
            assert.equal(await scene(page).inputValue(), 'Unsaved while candidates refresh');
            assert.equal(state.dispatches, 0);
            await f.close();
        });
        await run('current unusable remains visible, temporary errors and refresh recover', async () => {
            const f = await fixture(browser, { enabled: true }), { page, state } = f;
            state.target.continuitySourceFrameId = ids.unusable;
            await f.open();
            await radio(page, /Frame 4.*Later/i).waitFor();
            assert.equal(await radio(page, /Frame 4.*Later/i).isChecked(), true);
            assert.equal(await generate(page).isDisabled(), true);
            state.listFailure = true;
            await page.getByRole('button', { name: 'Refresh sources' }).click();
            await page.getByText(/unavailable|could not load/i).first().waitFor();
            state.listFailure = false;
            await page.getByRole('button', { name: 'Refresh sources' }).click();
            await radio(page, /Frame 4.*Later/i).waitFor();
            assert.equal(state.dispatches, 0);
            await f.close();
        });
        await run('rollback blocks configured source until explicit clear', async () => {
            for (const enabled of [false, undefined]) {
                const f = await fixture(browser, { enabled });
                const { page, state } = f;
                state.target.continuitySourceFrameId = ids.earlier;
                await f.open();
                await page.getByRole('button', { name: 'Clear source' }).waitFor();
                assert.equal(await generate(page).isDisabled(), true);
                assert.equal(state.requests.filter(r => r.path === '/api/stories/story/frames').length, 0);
                await page.getByRole('button', { name: 'Clear source' }).click();
                await eventually(() => state.target.continuitySourceFrameId === null, 'clear source failed');
                assert.equal(state.dispatches, 0);
                await f.close();
            }
        });
        await run('failed source save preserves choice and allows explicit retry', async () => {
            const f = await fixture(browser, { enabled: true });
            const { page, state } = f;
            await f.open();
            await radio(page, /Frame 1.*Earlier/i).waitFor();
            state.failNextPatch = true;
            await radio(page, /Frame 1.*Earlier/i).check();
            await page.getByText(/Could not save source/i).first().waitFor();
            assert.equal(await radio(page, /Frame 1.*Earlier/i).isChecked(), true);
            assert.equal(state.dispatches, 0);
            await page.getByRole('button', { name: /retry.*source|save.*source/i }).click();
            await eventually(() => state.target.continuitySourceFrameId === ids.earlier, 'source retry failed');
            assert.equal(state.dispatches, 0);
            await f.close();
        });
        await run('storage preflight error preserves source and draft for explicit retry', async () => {
            const f = await fixture(browser, { enabled: true });
            const { page, state } = f;
            state.target.continuitySourceFrameId = ids.earlier;
            state.failPreflight = true;
            await f.open();
            await radio(page, /Frame 1.*Earlier/i).waitFor();
            await scene(page).fill('Scene retained after storage error');
            await generate(page).click();
            await page.getByText(/Reference storage is temporarily unavailable/i).waitFor();
            assert.equal(state.dispatches, 0);
            assert.equal(state.captures.length, 1);
            assert.equal(await scene(page).inputValue(), 'Scene retained after storage error');
            assert.equal(await radio(page, /Frame 1.*Earlier/i).isChecked(), true);
            await generate(page).click();
            await eventually(() => state.dispatches === 1, 'explicit retry did not submit');
            assert.equal(state.captures.length, 2);
            assert.equal(state.captures[1].source, ids.earlier);
            assert.equal(state.captures[1].description, 'Scene retained after storage error');
            await f.close();
        });
        await run('attachment budgets retain over-budget drafts and do not dispatch', async () => {
            for (const [count, characters, source, disabled] of [[9, 4, true, false], [10, 4, true, true], [10, 4, false, false], [9, 5, false, true]]) {
                const f = await fixture(browser, { enabled: true }), { page, state } = f;
                state.target.concepts = Array.from({ length: count }, (_, i) => concept(i, i < characters ? 'character' : 'prop'));
                state.conceptList = clone(state.target.concepts);
                state.target.continuitySourceFrameId = source ? ids.earlier : null;
                await f.open();
                await radio(page, /Frame 1.*Earlier/i).waitFor();
                if (!disabled) await eventually(async () => await generate(page).isEnabled(), 'valid budget did not become ready');
                assert.equal(await generate(page).isDisabled(), disabled, `count=${count}, characters=${characters}, source=${source}`);
                assert.equal(await page.getByRole('button', { name: /^Remove Fixture / }).count(), count);
                assert.equal(state.dispatches, 0);
                await f.close();
            }
        });
        await run('frozen/current mismatch and legacy, unknown, deleted provenance', async () => {
            const f = await fixture(browser, { enabled: true }), { page, state } = f;
            state.target.continuitySourceFrameId = ids.earlier;
            state.target.continuitySourceSelectedGenerationId = ids.gen2;
            state.target.generations = [generation('g1', { provenance: 'known', source: { frameId: ids.earlier, generationId: ids.gen, sourceFrameDeleted: false } }), generation('g2', { provenance: 'legacy' }), generation('g3', { provenance: 'unknown' }), generation('g4', { provenance: 'known', source: { frameId: ids.later, generationId: ids.gen, sourceFrameDeleted: true } })];
            state.target.selectedGenerationId = 'g1';
            await f.open();
            await page.getByText(/current source selection differs/i).first().waitFor();
            await page.getByText(/legacy generation/i).first().waitFor();
            await page.getByText(/provenance unknown/i).first().waitFor();
            await page.getByText(/deleted source frame/i).first().waitFor();
            assert.equal(state.dispatches, 0);
            await f.close();
        });
        await run('exact-set re-confirm and story billing warning', async () => {
            const f = await fixture(browser, { enabled: true }), { page, state } = f;
            await f.open();
            await page.getByRole('button', { name: 'Delete frame', exact: true }).click();
            await page.getByRole('button', { name: 'Delete frame permanently' }).click();
            await page.getByRole('button', { name: 'Confirm deletion' }).waitFor();
            await page.getByRole('button', { name: 'Confirm deletion' }).click();
            await page.getByText(/changed/i).first().waitFor();
            assert.equal(state.deleteCount, 2);
            await page.getByRole('button', { name: 'Confirm deletion' }).click();
            await page.waitForURL(`${origin}/stories/story`);
            const deletes = state.requests.filter(r => r.method === 'DELETE');
            assert.equal(deletes.length, 3);
            assert.match(deletes[1].query, new RegExp(`referenceSetToken=${'a'.repeat(64)}`));
            assert.match(deletes[2].query, new RegExp(`referenceSetToken=${'b'.repeat(64)}`));
            assert.equal(state.dispatches, 0);
            await page.getByRole('button', { name: 'Delete story', exact: true }).click();
            await page.getByText(/saved continuity inputs/i).waitFor();
            await page.getByText(/bill/i).first().waitFor();
            await f.close();
        });
        await run('sanitized desktop and mobile screenshots', async () => {
            for (const mobile of [false, true]) {
                const f = await fixture(browser, { enabled: true, mobile }), { page, state } = f;
                state.target.continuitySourceFrameId = ids.earlier;
                state.target.continuitySourceSelectedGenerationId = ids.gen;
                const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#7199ab"/><circle cx="80" cy="45" r="24" fill="#f0d4a0"/></svg>';
                const thumbnail = 'data:image/svg+xml,' + encodeURIComponent(svg);
                state.rows[0].imageUrl = thumbnail;
                const selected = generation('selected-fixture', { provenance: 'known', source: { frameId: ids.earlier, generationId: ids.gen, sourceFrameDeleted: false } });
                selected.imageUrl = thumbnail;
                state.target.generations = [selected];
                state.target.selectedGenerationId = selected.id;
                state.target.concepts = [concept(1, 'character'), concept(2)];
                state.conceptList = clone(state.target.concepts);
                await f.open();
                await radio(page, /Frame 1.*Earlier/i).waitFor();
                if (mobile) {
                    await radio(page, /Frame 3.*Later/i).focus();
                    await page.keyboard.press('Space');
                    await eventually(() => state.target.continuitySourceFrameId === ids.later, 'mobile keyboard selection failed');
                    await radio(page, /Frame 1.*Earlier/i).focus();
                    await page.keyboard.press('Space');
                    await eventually(() => state.target.continuitySourceFrameId === ids.earlier, 'mobile keyboard restore failed');
                }
                const candidateImage = page.locator('label').filter({ has: radio(page, /Frame 1.*Earlier/i) }).locator('img');
                await eventually(async () => await candidateImage.evaluate(img => img.complete && img.naturalWidth > 0), 'synthetic source thumbnail did not load');
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'horizontal overflow');
                await page.getByRole('region', { name: 'Selected output' }).getByText(/used current source selection/i).waitFor();
                await page.screenshot({ path: path.join(screenshotDir, `${mobile ? 'mobile' : 'desktop'}-picker.png`), fullPage: true });
                assert.equal(state.dispatches, 0);
                await f.close();
            }
        });
    }
    finally {
        await browser.close();
    }
    console.log('All picker fixtures passed. All model dispatches were mocked; no non-loopback requests escaped interception.');
}
Promise.race([main(), timeout(120000, 'overall verification timeout')]).catch(e => { console.error(e); process.exitCode = 1; });
