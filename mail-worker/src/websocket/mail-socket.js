import { DurableObject } from 'cloudflare:workers';

const MAX_DOMAINS_PER_CONNECTION = 100;
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function normalizeDomain(value) {
	if (typeof value !== 'string') return null;
	const domain = value.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
	if (!DOMAIN_RE.test(domain)) return null;
	return domain;
}

function getRecipientDomain(address) {
	if (typeof address !== 'string') return null;
	// CloudMail stores the SMTP envelope recipient in toEmail. Be defensive
	// if a display-name form is ever supplied by a caller.
	const match = address.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/);
	const email = (match ? match[1] : address).trim().toLowerCase();
	const at = email.lastIndexOf('@');
	if (at <= 0 || at === email.length - 1) return null;
	return normalizeDomain(email.slice(at + 1));
}

function readSubscriptions(socket) {
	try {
		const attachment = socket.deserializeAttachment();
		return Array.isArray(attachment?.domains) ? attachment.domains : [];
	} catch {
		return [];
	}
}

/**
 * Durable Object WebSocket hub. Clients authenticate at the Worker endpoint,
 * recipient domains are supplied in the WebSocket URL query string:
 * /ws?domain=example.com,example.org
 * Only mail addressed to a supplied domain is delivered to that socket.
 */
export class MailSocket extends DurableObject {
	async fetch(request) {
		const url = new URL(request.url);

		if (url.pathname === '/ws' && request.method === 'GET') {
			if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
				return new Response('Expected WebSocket', { status: 426 });
			}

			// Domains are supplied at handshake time, e.g. ?domain=example.com,test.com.
			const rawDomains = url.searchParams.get('domain') || '';
			const requestedDomains = rawDomains.split(',').map(value => value.trim()).filter(Boolean);
			if (requestedDomains.length === 0) {
				return Response.json({
					success: false,
					message: 'The domain query parameter is required, e.g. ?domain=example.com,test.com'
				}, { status: 400 });
			}
			if (requestedDomains.length > MAX_DOMAINS_PER_CONNECTION) {
				return Response.json({
					success: false,
					message: `Maximum ${MAX_DOMAINS_PER_CONNECTION} domains per connection`
				}, { status: 400 });
			}

			const normalizedDomains = requestedDomains.map(normalizeDomain);
			if (normalizedDomains.some(domain => !domain)) {
				return Response.json({ success: false, message: 'Invalid domain supplied' }, { status: 400 });
			}
			const domains = [...new Set(normalizedDomains)];

			const pair = new WebSocketPair();
			const client = pair[0];
			const server = pair[1];
			this.ctx.acceptWebSocket(server);
			// Persist URL-provided subscriptions across Durable Object hibernation.
			server.serializeAttachment({ domains });
			server.send(JSON.stringify({
				event: 'connected',
				data: {
					message: 'CloudMail WebSocket connected',
					domains
				},
				timestamp: new Date().toISOString()
			}));

			return new Response(null, { status: 101, webSocket: client });
		}

		if (url.pathname === '/publish' && request.method === 'POST') {
			const suppliedSecret = request.headers.get('X-CloudMail-Internal') || '';
			if (!this.env.jwt_secret || suppliedSecret !== this.env.jwt_secret) {
				return new Response('Forbidden', { status: 403 });
			}

			let payload;
			try {
				payload = await request.json();
			} catch {
				return Response.json({ success: false, message: 'Invalid JSON' }, { status: 400 });
			}

			const domain = getRecipientDomain(payload?.to);
			if (!domain) {
				return Response.json({ success: true, domain: null, connections: 0, message: 'Recipient domain unavailable' });
			}

			const message = JSON.stringify({
				event: 'mail.received',
				domain,
				data: payload,
				timestamp: new Date().toISOString()
			});

			let connections = 0;
			for (const socket of this.ctx.getWebSockets()) {
				if (socket.readyState !== WebSocket.OPEN) continue;
				const domains = readSubscriptions(socket);
				if (!domains.includes(domain)) continue;
				try {
					socket.send(message);
					connections++;
				} catch (error) {
					console.error('CloudMail WebSocket domain push failed:', error);
				}
			}

			return Response.json({ success: true, domain, connections });
		}

		return new Response('Not Found', { status: 404 });
	}

	async webSocketMessage(socket, message) {
		if (message === 'ping') {
			socket.send('pong');
			return;
		}

		// Domains are fixed for this connection and are supplied in the URL.
		try {
			socket.send(JSON.stringify({
				event: 'error',
				data: {
					code: 'URL_SUBSCRIPTION_REQUIRED',
					message: 'Pass domains in the WebSocket URL: /ws?domain=example.com,test.com'
				}
			}));
		} catch (error) {
			console.error('CloudMail WebSocket response failed:', error);
		}
	}

	async webSocketClose(socket, code, reason) {
		console.log('External WebSocket client disconnected:', code, reason);
	}

	async webSocketError(socket, error) {
		console.error('External WebSocket client error:', error);
	}
}
