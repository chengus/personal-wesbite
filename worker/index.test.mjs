import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, { replyText, easternTimestamp, emailReferences } from './index.mjs';

// Execute the actual migration and SQL against SQLite, with D1's small async API.
function setup({ mailFailure = false } = {}) {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec('PRAGMA foreign_keys = ON');
    sqlite.exec(readFileSync(new URL('./migrations/0001_conversations.sql', import.meta.url), 'utf8'));
    sqlite.exec(readFileSync(new URL('./migrations/0003_identifier.sql', import.meta.url), 'utf8'));
    sqlite.exec(readFileSync(new URL('./migrations/0004_email_threading.sql', import.meta.url), 'utf8'));
    const sent = [];
    const state = { mailFailure };
    const DB = {
        prepare(sql) {
            let values = [];
            return {
                bind(...args) { values = args; return this; },
                async first() { return sqlite.prepare(sql).get(...values) || null; },
                async all() { return { results: sqlite.prepare(sql).all(...values) }; },
                async run() { return { meta: sqlite.prepare(sql).run(...values) }; },
            };
        },
        async batch(statements) {
            sqlite.exec('BEGIN');
            try { const result = []; for (const s of statements) result.push(await s.run()); sqlite.exec('COMMIT'); return result; }
            catch (error) { sqlite.exec('ROLLBACK'); throw error; }
        },
    };
    const env = {
        ALLOWED_ORIGINS: 'https://lucentlu.com', FROM_EMAIL: 'lucentgpt@lucentlu.com',
        TO_EMAIL: 'owner@example.com', REPLY_EMAIL: 'replies@lucentlu.com', DB,
        EMAIL: { async send(mail) { if (state.mailFailure) throw new Error('Unavailable'); sent.push(mail); return { messageId: `<notification-${sent.length}@cloudflare.test>` }; } },
    };
    return { env, sent, sqlite, state };
}
function post(path = '/api/message', values = {}, origin = 'https://lucentlu.com') {
    return new Request(`https://lucentlu.com${path}`, {
        method: 'POST', headers: origin ? { Origin: origin } : {},
        body: new URLSearchParams({ message: 'Hello 世界 <script>alert(1)</script>', ...values }),
    });
}
const get = (path, env) => worker.fetch(new Request(`https://lucentlu.com${path}`), env);
async function start(ctx) {
    const response = await worker.fetch(post(), ctx.env);
    assert.equal(response.status, 303);
    return response.headers.get('Location');
}
async function incoming(ctx, { to = ctx.sent[0]?.replyTo, from = 'owner@example.com', headerFrom = from,
    text = 'Hello, anonymous human!\r\n\r\nOn Wed, Sep 9, 2026, LucentGPT wrote:\r\n> old question', id = '<reply-1@example.com>', extra = '', raw } = {}) {
    let rejection;
    const source = raw || `From: Lucent <${headerFrom}>\r\nTo: ${to}\r\nMessage-ID: ${id}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n${extra}\r\n${text}`;
    await worker.email({ from, to, rawSize: new TextEncoder().encode(source).length,
        raw: new Blob([source]).stream(), setReject(reason) { rejection = reason; } }, ctx.env);
    return rejection;
}

test('anonymous creation, private escaped page, independent reply capability and fixed email destination', async () => {
    const ctx = setup();
    const path = await start(ctx);
    assert.match(path, /^\/api\/conversation\/[A-Za-z0-9_-]{43}$/);
    const response = await get(path, ctx.env);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Hello 世界 &lt;script&gt;/);
    assert.match(html, /Bookmark this page/);
    assert.doesNotMatch(html, /<script|umami|type="email"/);
    assert.equal(response.headers.get('Referrer-Policy'), 'strict-origin');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.match(response.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
    assert.match(response.headers.get('X-Robots-Tag'), /noindex/);
    assert.equal(ctx.sent[0].to, 'owner@example.com');
    assert.match(ctx.sent[0].replyTo, /^replies\+[A-Za-z0-9_-]{43}@lucentlu.com$/);
    const key = ctx.sent[0].replyTo.split('+')[1].split('@')[0];
    assert.ok(!html.includes(key));
    assert.ok(!path.includes(key));
    assert.ok(!JSON.stringify(ctx.sqlite.prepare('SELECT * FROM conversations').get()).includes(path.split('/').at(-1)));
    assert.equal((await get(`/api/conversation/${key}`, ctx.env)).status, 404);
});

test('email reply publishes plain text, strips quoted history, and deduplicates delivery', async () => {
    const ctx = setup(); const path = await start(ctx);
    assert.equal(await incoming(ctx), undefined);
    assert.equal(await incoming(ctx), undefined);
    const html = await (await get(path, ctx.env)).text();
    assert.match(html, /Hello, anonymous human!/);
    assert.doesNotMatch(html, /old question/);
    assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'lucent'").get().n, 1);
    assert.equal(ctx.sent.length, 1); // No visitor email or reply loop.
});

test('followups stay in the same conversation and repeated POSTs are idempotent', async () => {
    const ctx = setup(); const path = await start(ctx);
    ctx.sqlite.exec('UPDATE messages SET created_at = created_at - 31000');
    const request_id = crypto.randomUUID();
    const response = await worker.fetch(post(path, { request_id, message: 'A followup' }), ctx.env);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('Location'), path);
    assert.equal((await worker.fetch(post(path, { request_id, message: 'A followup' }), ctx.env)).status, 303);
    assert.equal(ctx.sent.length, 2);
    assert.equal(ctx.sent[0].replyTo, ctx.sent[1].replyTo);
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 2);
});

test('failed notification preserves message and access link, then cron retries once', async () => {
    const ctx = setup({ mailFailure: true }); const path = await start(ctx);
    assert.match(await (await get(path, ctx.env)).text(), /message is saved/);
    assert.equal(ctx.sent.length, 0);
    ctx.state.mailFailure = false;
    ctx.sqlite.exec('UPDATE messages SET next_attempt = 0');
    await worker.scheduled({}, ctx.env);
    await worker.scheduled({}, ctx.env);
    assert.equal(ctx.sent.length, 1);
    assert.match(await (await get(path, ctx.env)).text(), /LucentGPT is thinking/);
});

test('invalid input, oversized body, cross-site requests, absent origins and spam trap do not save or send', async () => {
    const ctx = setup();
    for (const values of [{ message: '' }, { message: ' ' }, { message: 'x'.repeat(10001) }, { website: 'spam' }]) {
        assert.equal((await worker.fetch(post('/api/message', values), ctx.env)).status, 400);
    }
    assert.equal((await worker.fetch(post('/api/message', { message: 'x'.repeat(140000) }), ctx.env)).status, 413);
    for (const origin of ['https://evil.example', null]) assert.equal((await worker.fetch(post('/api/message', {}, origin), ctx.env)).status, 403);
    assert.equal(ctx.sent.length, 0);
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 0);
});

test('allows 10,000 non-ASCII characters in a URL-encoded form', async () => {
    const ctx = setup();
    assert.equal((await worker.fetch(post('/api/message', { message: '世'.repeat(10000) }), ctx.env)).status, 303);
});

test('unknown links and methods cannot disclose conversations or send mail', async () => {
    const ctx = setup(); await start(ctx);
    assert.equal((await get('/api/conversation/' + 'A'.repeat(43), ctx.env)).status, 404);
    assert.equal((await get('/api/conversation/invalid', ctx.env)).status, 404);
    assert.equal((await get('/api/message', ctx.env)).status, 405);
    assert.equal(ctx.sent.length, 1);
});

test('visitor token, wrong owner, spoofed From, automatic mail and leaked reply credentials are rejected', async () => {
    const ctx = setup(); const path = await start(ctx);
    const visitorToken = path.split('/').at(-1);
    for (const options of [
        { to: `replies+${visitorToken}@lucentlu.com` },
        { from: 'attacker@example.com' }, { headerFrom: 'attacker@example.com' },
        { extra: 'Auto-Submitted: auto-replied\r\n' },
        { text: `Accidentally quoting ${ctx.sent[0].replyTo}` }, { text: '' },
        { id: '' },
    ]) assert.ok(await incoming(ctx, options));
    assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'lucent'").get().n, 0);
});

test('real MIME parsing handles multipart and base64 UTF-8 while never publishing HTML or attachments', async () => {
    const ctx = setup(); const path = await start(ctx);
    const raw = `From: owner@example.com\r\nTo: ${ctx.sent[0].replyTo}\r\nMessage-ID: <mime@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="boundary"\r\n\r\n--boundary\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from('你好 <img src=x onerror=alert(1)>').toString('base64')}\r\n--boundary\r\nContent-Type: text/html\r\n\r\n<script>untrusted html</script>\r\n--boundary--\r\n`;
    assert.equal(await incoming(ctx, { raw }), undefined);
    const html = await (await get(path, ctx.env)).text();
    assert.match(html, /你好 &lt;img/);
    assert.doesNotMatch(html, /untrusted html/);
});

test('reply extraction handles Gmail wrapped attribution, Outlook history and signature delimiters', () => {
    assert.equal(replyText('Answer\n\nOn Wednesday, September 9,\n2026, LucentGPT wrote:\n> question'), 'Answer');
    assert.equal(replyText('Answer\n\nFrom: LucentGPT\nSent: Wednesday'), 'Answer');
    assert.equal(replyText('Answer\n\n-- \nSignature'), 'Answer');
    assert.equal(replyText('Answer\n\n--- LUCENTGPT ORIGINAL MESSAGE ---\nquestion'), 'Answer');
});

test('expired conversations cannot be read, appended or answered, and cron removes their messages', async () => {
    const ctx = setup(); const path = await start(ctx);
    ctx.sqlite.exec('UPDATE conversations SET expires_at = 0');
    assert.equal((await get(path, ctx.env)).status, 404);
    assert.equal((await worker.fetch(post(path, { request_id: crypto.randomUUID() }), ctx.env)).status, 404);
    assert.ok(await incoming(ctx));
    await worker.scheduled({}, ctx.env);
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
});

test('conversation cooldown and daily ceiling prevent excess sends', async () => {
    const ctx = setup(); const path = await start(ctx);
    assert.equal((await worker.fetch(post(path, { request_id: crypto.randomUUID() }), ctx.env)).status, 429);
    ctx.sqlite.exec('UPDATE daily_submissions SET count = 500');
    assert.equal((await worker.fetch(post(), ctx.env)).status, 429);
    assert.equal(ctx.sent.length, 1);
});

test('database outage returns an honest error rather than claiming a message was saved', async () => {
    const ctx = setup(); ctx.env.DB.prepare = () => { throw new Error('Unavailable'); };
    assert.equal((await worker.fetch(post(), ctx.env)).status, 503);
    assert.equal(ctx.sent.length, 0);
});

test('MIME parser preserves declared legacy charsets instead of decoding all raw mail as UTF-8', async () => {
    const ctx = setup(); const path = await start(ctx);
    const raw = Buffer.from(`From: owner@example.com\r\nTo: ${ctx.sent[0].replyTo}\r\nMessage-ID: <latin1@example.com>\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\nUn café`, 'latin1');
    let rejection;
    await worker.email({ from: 'owner@example.com', to: ctx.sent[0].replyTo, rawSize: raw.length,
        raw: new Blob([raw]).stream(), setReject(reason) { rejection = reason; } }, ctx.env);
    assert.equal(rejection, undefined);
    assert.match(await (await get(path, ctx.env)).text(), /Un café/);
});

test('conversation message cap applies to both visitor posts and owner replies', async () => {
    const ctx = setup(); const path = await start(ctx);
    const thread = ctx.sqlite.prepare('SELECT id FROM conversations').get();
    const insert = ctx.sqlite.prepare("INSERT INTO messages(id, conversation_id, role, body, created_at, notified) VALUES (?, ?, 'lucent', 'Earlier reply', 0, 1)");
    for (let i = 0; i < 199; i++) insert.run(`filler-${i}`, thread.id);
    ctx.sqlite.exec('UPDATE messages SET created_at = 0');
    assert.equal((await worker.fetch(post(path, { request_id: crypto.randomUUID() }), ctx.env)).status, 429);
    assert.equal(await incoming(ctx), 'Conversation is full.');
    assert.match(await (await get(path, ctx.env)).text(), /conversation is full/);
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 200);
});

test('new conversations expire after 180 days; migration extends existing 90-day conversations', async () => {
    const ctx = setup();
    await start(ctx);
    const thread = ctx.sqlite.prepare('SELECT * FROM conversations').get();
    assert.equal(thread.expires_at - thread.created_at, 180 * 86400000);
    ctx.sqlite.prepare('UPDATE conversations SET expires_at = created_at + ?').run(90 * 86400000);
    ctx.sqlite.exec(readFileSync(new URL('./migrations/0002_retention_180_days.sql', import.meta.url), 'utf8'));
    assert.equal(ctx.sqlite.prepare('SELECT expires_at FROM conversations').get().expires_at, thread.expires_at);
});

test('conversation form preserves browser origin without leaking the secret path through referrers', async () => {
    const ctx = setup(); const path = await start(ctx);
    const response = await get(path, ctx.env);
    const html = await response.text();
    // Both policies matter: a conflicting meta tag overrides the response header.
    assert.equal(response.headers.get('Referrer-Policy'), 'strict-origin');
    assert.match(html, /<meta name="referrer" content="strict-origin">/);
    assert.doesNotMatch(html, /no-referrer/);
    const request_id = html.match(/name="request_id" value="([^"]+)"/)[1];
    ctx.sqlite.exec('UPDATE messages SET created_at = created_at - 31000');
    // Null/cross-site origins must still be rejected, not treated as trusted.
    for (const origin of ['null', 'https://evil.example']) {
        assert.equal((await worker.fetch(post(path, { request_id }, origin), ctx.env)).status, 403);
    }
    const sent = await worker.fetch(post(path, { request_id, message: 'Browser followup' }), ctx.env);
    assert.equal(sent.status, 303);
    assert.equal(sent.headers.get('Location'), path);
    assert.match(await (await get(path, ctx.env)).text(), /Browser followup/);
});

test('identifier and original ET submission time appear in safe HTML and plain-text notifications', async () => {
    const ctx = setup({ mailFailure: true });
    const identifier = '<img src=x> & "a role"';
    const response = await worker.fetch(post('/api/message', { identifier, message: 'First line\n<script>second line</script>' }), ctx.env);
    assert.equal(response.status, 303);
    const path = response.headers.get('Location');
    const originalTime = Date.parse('2026-09-09T19:05:00Z');
    ctx.sqlite.prepare('UPDATE messages SET created_at = ?, next_attempt = 0').run(originalTime);
    ctx.state.mailFailure = false;
    await worker.scheduled({}, ctx.env);
    assert.equal(ctx.sent[0].text, `${identifier} 09/09/2026 15:05 ET:\n\nFirst line\n<script>second line</script>`);
    assert.match(ctx.sent[0].html, /&lt;img src=x&gt; &amp; &quot;a role&quot;/);
    assert.match(ctx.sent[0].html, /<small><em>09\/09\/2026 15:05 ET:<\/em><\/small>/);
    assert.doesNotMatch(ctx.sent[0].html, /<script>|<img/);
    assert.doesNotMatch(ctx.sent[0].text, /LUCENTGPT ORIGINAL MESSAGE/);
    ctx.sqlite.exec('UPDATE messages SET created_at = 0');
    assert.equal((await worker.fetch(post(path, { request_id: crypto.randomUUID(), identifier: 'Changed name' }), ctx.env)).status, 303);
    assert.ok(ctx.sent[1].text.startsWith(identifier + ' '));
});

test('blank identifiers stay anonymous and invalid identifiers are rejected', async () => {
    const ctx = setup();
    await start(ctx);
    assert.ok(ctx.sent[0].text.startsWith('Anonymous '));
    for (const identifier of ['x'.repeat(101), 'first\nsecond', 'first\u0000second']) {
        assert.equal((await worker.fetch(post('/api/message', { identifier }), ctx.env)).status, 400);
    }
    assert.equal(ctx.sent.length, 1);
});

test('Eastern timestamps follow daylight saving time and use 24-hour midnight', () => {
    assert.equal(easternTimestamp(Date.parse('2026-01-10T05:05:00Z')), '01/10/2026 00:05 ET');
    assert.equal(easternTimestamp(Date.parse('2026-07-10T04:05:00Z')), '07/10/2026 00:05 ET');
    assert.equal(easternTimestamp(Date.parse('2026-03-08T06:59:00Z')), '03/08/2026 01:59 ET');
    assert.equal(easternTimestamp(Date.parse('2026-03-08T07:00:00Z')), '03/08/2026 03:00 ET');
});

async function followup(ctx, path) {
    ctx.sqlite.exec("UPDATE messages SET created_at = 0 WHERE role = 'visitor'");
    const response = await worker.fetch(post(path, { request_id: crypto.randomUUID(), message: 'Followup in the email chain' }), ctx.env);
    assert.equal(response.status, 303);
    return ctx.sent.at(-1);
}

test('website followups reference the provider Message-ID before and after an owner reply', async () => {
    const ctx = setup(); const path = await start(ctx);
    assert.equal(ctx.sent[0].headers, undefined);
    const follow = await followup(ctx, path);
    assert.deepEqual(follow.headers, {
        'In-Reply-To': '<notification-1@cloudflare.test>', References: '<notification-1@cloudflare.test>',
    });
    assert.equal(follow.subject, 'Re: ' + ctx.sent[0].subject);
    assert.equal(await incoming(ctx, { extra: 'References: <notification-1@cloudflare.test>\r\nIn-Reply-To: <notification-2@cloudflare.test>\r\n' }), undefined);
    const next = await followup(ctx, path);
    assert.deepEqual(next.headers, {
        'In-Reply-To': '<reply-1@example.com>',
        References: '<notification-1@cloudflare.test> <notification-2@cloudflare.test> <reply-1@example.com>',
    });
    const again = await followup(ctx, path);
    assert.equal(again.headers['In-Reply-To'], '<notification-3@cloudflare.test>');
    assert.match(again.headers.References, /^<notification-1@cloudflare.test>/);
    const html = await (await get(path, ctx.env)).text();
    assert.doesNotMatch(html, /notification-\d@cloudflare\.test|reply-1@example\.com/);
});

test('a reply to a pre-upgrade email anchors an existing conversation; duplicate mail cannot move it backward', async () => {
    const ctx = setup(); const path = await start(ctx);
    ctx.sqlite.exec('UPDATE messages SET email_message_id = NULL, email_recorded_at = NULL');
    const options = { extra: 'References: <old-root@gmail.com>\r\nIn-Reply-To: <old-notification@cloudflare.test>\r\n' };
    assert.equal(await incoming(ctx, options), undefined);
    const follow = await followup(ctx, path);
    assert.equal(follow.headers['In-Reply-To'], '<reply-1@example.com>');
    assert.equal(follow.headers.References, '<old-root@gmail.com> <old-notification@cloudflare.test> <reply-1@example.com>');
    assert.equal(await incoming(ctx, options), undefined);
    assert.equal((await followup(ctx, path)).headers['In-Reply-To'], '<notification-2@cloudflare.test>');
});

test('failed sends retain the previous anchor and retry with valid threading headers', async () => {
    const ctx = setup(); const path = await start(ctx);
    ctx.state.mailFailure = true;
    await followup(ctx, path);
    assert.equal(ctx.sent.length, 1);
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM messages WHERE email_message_id IS NOT NULL').get().n, 1);
    ctx.sqlite.exec('UPDATE messages SET next_attempt = 0 WHERE notified = 0');
    ctx.state.mailFailure = false;
    await worker.scheduled({}, ctx.env);
    assert.equal(ctx.sent[1].headers['In-Reply-To'], '<notification-1@cloudflare.test>');
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM messages WHERE email_message_id IS NOT NULL').get().n, 2);
});

test('long and malformed reference chains are reduced to safe bounded headers', () => {
    const root = '<root@example.com>';
    const recent = Array.from({ length: 100 }, (_, i) => `<${i}-${'x'.repeat(80)}@example.com>`);
    const references = emailReferences(root, recent.join(' '), '\r\nBcc: victim@example.com', '<bad id@example.com>', root);
    assert.ok(references.startsWith(root + ' '));
    assert.ok(references.endsWith(recent.at(-1)));
    assert.ok(references.length <= 1900);
    assert.doesNotMatch(references, /[\r\n]|Bcc|victim|bad id/);
});

test('an older binding without returned Message-ID does not retry a successful send or invent a thread ID', async () => {
    const ctx = setup();
    ctx.env.EMAIL.send = async mail => { ctx.sent.push(mail); return {}; };
    const path = await start(ctx);
    await worker.scheduled({}, ctx.env);
    assert.equal(ctx.sent.length, 1);
    assert.equal(await incoming(ctx, { extra: 'In-Reply-To: <real-root@cloudflare.test>\r\n' }), undefined);
    const follow = await followup(ctx, path);
    assert.equal(follow.headers['In-Reply-To'], '<reply-1@example.com>');
    assert.equal(follow.headers.References, '<real-root@cloudflare.test> <reply-1@example.com>');
});

test('thread anchors are isolated by conversation', async () => {
    const ctx = setup(); const first = await start(ctx); const second = await start(ctx);
    assert.equal(ctx.sent[1].headers, undefined);
    assert.equal((await followup(ctx, first)).headers['In-Reply-To'], '<notification-1@cloudflare.test>');
    assert.equal((await followup(ctx, second)).headers['In-Reply-To'], '<notification-2@cloudflare.test>');
});
