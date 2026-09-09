import PostalMime from 'postal-mime';

const DAY = 86400000;
const RETENTION = 180 * DAY;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const HEADERS = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    // Hide the secret URL path without turning form POST Origin headers into null.
    'Referrer-Policy': 'strict-origin',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const token = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('');
const redirect = path => new Response(null, { status: 303, headers: { ...HEADERS, Location: path } });

export function easternTimestamp(timestamp) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(timestamp));
    const value = type => parts.find(part => part.type === type).value;
    return `${value('month')}/${value('day')}/${value('year')} ${value('hour')}:${value('minute')} ET`;
}

// Use only bounded, printable RFC-style IDs in outgoing headers. Never pass
// raw incoming headers through to the sending API.
function emailMessageId(value) {
    if (typeof value !== 'string') return null;
    let id = value.trim();
    if (id.startsWith('<') && id.endsWith('>')) id = id.slice(1, -1);
    if (id.length > 510 || !/^[\x21-\x7e]+$/.test(id) || !/^[^<>@]+@[^<>@]+$/.test(id)) return null;
    return `<${id}>`;
}

export function emailReferences(...values) {
    const ids = [...new Set(values.flatMap(value =>
        [...(value || '').matchAll(/<[^<>\s]+>/g)].map(match => emailMessageId(match[0])).filter(Boolean)))];
    // Preserve the root and newest ancestors within Cloudflare's 2,048-byte limit.
    while (ids.length > 32 || ids.join(' ').length > 1900) ids.splice(1, 1);
    return ids.join(' ');
}

function page(title, content, status = 200) {
    return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="strict-origin"><title>${escape(title)} - LucentGPT</title><link rel="stylesheet" href="/styles.css"></head><body><main class="main-content"><h1>${escape(title)}</h1>${content}<p><a href="/">Back to LucentGPT</a></p></main></body></html>`, { status, headers: HEADERS });
}
const missing = () => page('Conversation not found', '<p>This link is incomplete, incorrect, or expired. Conversations expire 180 days after they start.</p>', 404);
const unavailable = () => page('LucentGPT is taking a break', '<p>Please go back and try again shortly. Keep your conversation link if you already have one.</p>', 503);

async function readBytes(stream, limit) {
    const reader = stream?.getReader();
    if (!reader) return new Uint8Array();
    const chunks = [];
    let size = 0;
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) { await reader.cancel(); throw new Error('Body too large'); }
        chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
}

async function conversation(env, access) {
    if (!TOKEN.test(access)) return null;
    return env.DB.prepare('SELECT * FROM conversations WHERE id = ? AND expires_at > ?').bind(await hash(access), Date.now()).first();
}

async function showConversation(env, access) {
    const thread = await conversation(env, access);
    if (!thread) return missing();
    const { results } = await env.DB.prepare('SELECT role, body, created_at, notified FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid LIMIT 200').bind(thread.id).all();
    const path = `/api/conversation/${access}`;
    const waiting = results.at(-1)?.role === 'visitor';
    const pending = results.some(m => m.role === 'visitor' && !m.notified);
    return page('LucentGPT', `<p><em>A large language human.</em></p>
<p><strong>Bookmark this page.</strong> This secret link is your conversation. Anyone with it can read and send messages. There is no email recovery.</p>
<p><a href="${path}">Check for replies</a> · Expires ${new Date(thread.expires_at).toISOString().slice(0, 10)} (UTC)</p>
${results.map(m => `<article><h2 class="message-author">${m.role === 'visitor' ? 'You' : 'Lucent'}</h2><small><time datetime="${new Date(m.created_at).toISOString()}">${new Date(m.created_at).toISOString().slice(0, 16).replace('T', ' ')} UTC</time></small><p class="message-body">${escape(m.body)}</p></article>`).join('')}
${pending ? '<p role="status">Your message is saved. Email notification is waiting to be sent; you do not need to submit it again.</p>' : waiting ? '<p role="status"><em>LucentGPT is thinking. Come back when I check my email.</em></p>' : ''}
${results.length >= 200 ? '<p>This conversation is full. You can start a new one from the homepage.</p>' : `<form action="${path}" method="post"><input type="hidden" name="request_id" value="${crypto.randomUUID()}"><p><label for="message">Your next message</label><br><textarea id="message" name="message" rows="6" maxlength="10000" required></textarea></p><div hidden aria-hidden="true"><label for="website">Leave this empty</label><input id="website" name="website" tabindex="-1" autocomplete="off"></div><button type="submit">Send to LucentGPT</button></form>`}`);
}

// A lease prevents normal HTTP/cron overlap. A crash after sending can still duplicate
// a notification, so incoming replies are independently deduplicated by Message-ID.
async function notify(env, id) {
    const now = Date.now();
    const row = await env.DB.prepare(`UPDATE messages SET next_attempt = ?, attempts = attempts + 1
        WHERE id = ? AND role = 'visitor' AND notified = 0 AND next_attempt <= ? RETURNING *`).bind(now + 300000, id, now).first();
    if (!row) return;
    try {
        const thread = await env.DB.prepare('SELECT reply_token, identifier FROM conversations WHERE id = ? AND expires_at > ?').bind(row.conversation_id, now).first();
        if (!thread) return;
        const [local, domain] = env.REPLY_EMAIL.split('@');
        const identifier = thread.identifier || 'Anonymous';
        const timestamp = easternTimestamp(row.created_at);
        const parent = await env.DB.prepare(`SELECT email_message_id, email_references FROM messages
            WHERE conversation_id = ? AND email_message_id IS NOT NULL
            ORDER BY email_recorded_at DESC, rowid DESC LIMIT 1`).bind(row.conversation_id).first();
        const parentId = emailMessageId(parent?.email_message_id);
        const references = parentId ? emailReferences(parent.email_references, parentId) : '';
        const sent = await env.EMAIL.send({
            from: { email: env.FROM_EMAIL, name: 'LucentGPT' },
            to: env.TO_EMAIL,
            replyTo: `${local}+${thread.reply_token}@${domain}`,
            subject: `${parentId ? 'Re: ' : ''}LucentGPT conversation ${row.conversation_id.slice(0, 12)}`,
            ...(parentId ? { headers: { 'In-Reply-To': parentId, References: references } } : {}),
            text: `${identifier} ${timestamp}:\n\n${row.body}`,
            html: `<div>${escape(identifier)} <small><em>${timestamp}:</em></small></div><br><div style="white-space: pre-wrap">${escape(row.body)}</div>`,
        });
        // Record the provider's actual Message-ID, not an invented ID. If an older
        // binding returns no usable ID, an incoming owner reply can anchor the chain.
        await env.DB.prepare(`UPDATE messages SET notified = 1, email_message_id = ?,
            email_references = ?, email_recorded_at = ? WHERE id = ?`)
            .bind(emailMessageId(sent?.messageId), references, Date.now(), id).run();
    } catch {
        await env.DB.prepare('UPDATE messages SET next_attempt = ? WHERE id = ?').bind(now + Math.min(3600000, 60000 * 2 ** Math.min(row.attempts, 6)), id).run();
    }
}

async function submit(request, env, access) {
    const origin = request.headers.get('Origin');
    const allowed = env.ALLOWED_ORIGINS.split(',').map(value => value.trim());
    if (!origin || !allowed.includes(origin)) return page('Unable to send', '<p>Please submit the form from lucentlu.com.</p>', 403);
    if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/x-www-form-urlencoded') return page('Unable to send', '<p>Please use the message form.</p>', 415);
    let form;
    try { form = new URLSearchParams(new TextDecoder().decode(await readBytes(request.body, 131072))); }
    catch { return page('Message too large', '<p>Please go back and shorten your message.</p>', 413); }
    if (form.get('website')) return page('Unable to send', '<p>Please go back and try again.</p>', 400);
    const body = (form.get('message') || '').trim();
    if (!body || body.length > 10000) return page('Check your message', '<p>Please go back and enter 1–10,000 characters.</p>', 400);
    const identifier = (form.get('identifier') || '').trim();
    if (!access && (identifier.length > 100 || /[\u0000-\u001f\u007f]/.test(identifier))) return page('Check your identifier', '<p>Please go back and use a single line of up to 100 characters, or leave it blank.</p>', 400);
    let thread;
    if (access) {
        thread = await conversation(env, access);
        if (!thread) return missing();
    }
    const requestId = form.get('request_id');
    if (access && !/^[a-f0-9-]{36}$/.test(requestId || '')) return page('Reload your conversation', '<p>Please go back and reload the page before sending.</p>', 400);
    const id = access ? `${thread.id}:${requestId}` : crypto.randomUUID();
    if (access && await env.DB.prepare('SELECT id FROM messages WHERE id = ?').bind(id).first()) return redirect(`/api/conversation/${access}`);
    const now = Date.now();
    // A global daily ceiling protects free-tier storage and the owner's inbox without retaining IP addresses.
    const quota = await env.DB.prepare(`INSERT INTO daily_submissions(day, count) VALUES (?, 1)
        ON CONFLICT(day) DO UPDATE SET count = count + 1 WHERE count < 500 RETURNING count`).bind(new Date(now).toISOString().slice(0, 10)).first();
    if (!quota) return page('LucentGPT is at capacity', '<p>Please come back tomorrow. The human has a daily message limit.</p>', 429);
    if (!access) {
        access = token();
        const key = await hash(access);
        await env.DB.batch([
            env.DB.prepare('INSERT INTO conversations(id, reply_token, created_at, expires_at, identifier) VALUES (?, ?, ?, ?, ?)').bind(key, token(), now, now + RETENTION, identifier),
            env.DB.prepare("INSERT INTO messages(id, conversation_id, role, body, created_at) VALUES (?, ?, 'visitor', ?, ?)").bind(id, key, body, now),
        ]);
    } else {
        const result = await env.DB.prepare(`INSERT OR IGNORE INTO messages(id, conversation_id, role, body, created_at)
            SELECT ?, ?, 'visitor', ?, ? WHERE
            (SELECT COUNT(*) FROM messages WHERE conversation_id = ?) < 200 AND
            NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = ? AND role = 'visitor' AND created_at > ?)`)
            .bind(id, thread.id, body, now, thread.id, thread.id, now - 30000).run();
        if (!result.meta.changes) {
            if (await env.DB.prepare('SELECT id FROM messages WHERE id = ?').bind(id).first()) return redirect(`/api/conversation/${access}`);
            return page('Give LucentGPT a moment', `<p>Please wait 30 seconds between messages. Each conversation can hold 200 messages.</p><p><a href="/api/conversation/${access}">Return to your conversation</a></p>`, 429);
        }
    }
    // Once saved, always return the secret link even if notification delivery fails.
    try { await notify(env, id); } catch { /* cron retries saved messages */ }
    return redirect(`/api/conversation/${access}`);
}

// Gmail/Apple Mail/Outlook top-posting conventions. Never render email HTML.
export function replyText(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const kept = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*>/.test(line) || /^\s*On\s.+wrote:\s*$/i.test(lines.slice(i, i + 3).join(' ')) ||
            /^\s*(?:-{2,}\s*(?:Original Message|Forwarded message)|--- LUCENTGPT ORIGINAL MESSAGE ---)/i.test(line) ||
            /^\s*From:\s/i.test(line) || /^\s*Reply above the quoted email to publish/.test(line) || /^--\s*$/.test(line)) break;
        kept.push(line);
    }
    return kept.join('\n').trim();
}

async function receiveEmail(message, env) {
    const reject = reason => message.setReject(reason);
    const [local, domain] = env.REPLY_EMAIL.split('@');
    const recipient = message.to;
    const prefix = `${local}+`;
    const suffix = `@${domain}`;
    if (!recipient.startsWith(prefix) || !recipient.endsWith(suffix)) return reject('Unknown reply address.');
    const key = recipient.slice(prefix.length, -suffix.length);
    if (!TOKEN.test(key) || message.from.toLowerCase() !== env.TO_EMAIL.toLowerCase()) return reject('Unauthorized reply.');
    const thread = await env.DB.prepare('SELECT id FROM conversations WHERE reply_token = ? AND expires_at > ?').bind(key, Date.now()).first();
    if (!thread) return reject('Unknown or expired conversation.');
    if (message.rawSize > 262144) return reject('Reply must be under 256 KiB. Remove attachments.');
    let parsed;
    try { parsed = await PostalMime.parse(await readBytes(message.raw, 262144)); }
    catch { return reject('Could not parse reply. Send plain text without attachments.'); }
    // The unguessable, email-only reply token is the primary credential; sender
    // checks are additional protection, not a claim that From headers authenticate mail.
    if (parsed.from?.address?.toLowerCase() !== env.TO_EMAIL.toLowerCase()) return reject('Unauthorized sender.');
    if (parsed.headers.some(h => h.key === 'auto-submitted' && h.value.toLowerCase() !== 'no')) return reject('Automatic replies are not published.');
    if (!parsed.messageId) return reject('A Message-ID is required.');
    const body = replyText(parsed.text || '');
    if (!body || body.length > 10000) return reject('Reply must contain 1–10,000 plain-text characters above the quoted email.');
    // Never publish the owner capability accidentally quoted by an email client.
    if (body.includes(key)) return reject('Reply includes the private reply address. Remove quoted headers and resend.');
    const id = `email:${await hash(`${thread.id}:${parsed.messageId}`)}`;
    if (await env.DB.prepare('SELECT id FROM messages WHERE id = ?').bind(id).first()) return;
    const result = await env.DB.prepare(`INSERT OR IGNORE INTO messages(id, conversation_id, role, body, created_at, notified,
        email_message_id, email_references, email_recorded_at)
        SELECT ?, ?, 'lucent', ?, ?, 1, ?, ?, ? WHERE (SELECT COUNT(*) FROM messages WHERE conversation_id = ?) < 200`)
        .bind(id, thread.id, body, Date.now(), emailMessageId(parsed.messageId),
            emailReferences(parsed.references, parsed.inReplyTo), Date.now(), thread.id).run();
    if (!result.meta.changes) return reject('Conversation is full.');
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const match = url.pathname.match(/^\/api\/conversation\/([A-Za-z0-9_-]{43})$/);
        if (url.pathname !== '/api/message' && !match) return missing();
        if (request.method !== 'POST' && !(match && request.method === 'GET')) {
            const response = page('Method not allowed', '<p>Please use the form to send a message.</p>', 405);
            response.headers.set('Allow', match ? 'GET, POST' : 'POST');
            return response;
        }
        try {
            if (request.method === 'GET') return await showConversation(env, match[1]);
            return await submit(request, env, match?.[1]);
        } catch { return unavailable(); }
    },
    email: receiveEmail,
    async scheduled(controller, env) {
        const now = Date.now();
        await env.DB.prepare('DELETE FROM conversations WHERE expires_at <= ?').bind(now).run();
        await env.DB.prepare('DELETE FROM daily_submissions WHERE day < ?').bind(new Date(now - DAY).toISOString().slice(0, 10)).run();
        const { results } = await env.DB.prepare("SELECT id FROM messages WHERE role = 'visitor' AND notified = 0 AND next_attempt <= ? ORDER BY next_attempt LIMIT 10").bind(now).all();
        for (const row of results) await notify(env, row.id);
    },
};
