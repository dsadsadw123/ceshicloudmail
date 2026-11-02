import { DurableObject } from 'cloudflare:workers';

/**
 * A single global WebSocket hub for every external project.
 * All clients connected to the same Durable Object receive every accepted
 * inbound-mail notification. Do not add user/email partitioning here.
 */
export class MailSocket extends DurableObject {
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === '/ws' && request.method === 'GET') {
			if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
				return new Response('Expected WebSocket', { status: 426 });
			}

			const pair = new WebSocketPair();
			const client = pair[0];
			const server = pair[1];
			this.ctx.acceptWebSocket(server);
			server.send(JSON.stringify({
				event: 'connected',
					data: { message: 'CloudMail WebSocket connected' },
					timestamp: new Date().toISOString()
			}));

			return new Response(null, { status: 101, webSocket: client });
		}

		if (url.pathname === '/publish' && request.method === 'POST') {
			const suppliedSecret = request.headers.get('X-CloudMail-Internal') || '';
			if (!this.env.WS_TOKEN || suppliedSecret !== this.env.WS_TOKEN) {
				return new Response('Forbidden', { status: 403 });
			}
			let payload;
			try {
				payload = await request.json();
			} catch {
				return Response.json({ success: false, message: 'Invalid JSON' }, { status: 400 });
			}

			const message = JSON.stringify({
				event: 'mail.received',
				data: payload,
				timestamp: new Date().toISOString()
			});

			let connections = 0;
			for (const socket of this.ctx.getWebSockets()) {
				if (socket.readyState !== WebSocket.OPEN) continue;
				try {
					socket.send(message);
					connections++;
				} catch (error) {
					console.error('CloudMail WebSocket broadcast failed:', error);
				}
			}

			return Response.json({ success: true, connections });
		}

		return new Response('Not Found', { status: 404 });
	}

	async webSocketMessage(socket, message) {
		if (message === 'ping') {
			socket.send('pong');
			return;
		}
		// The public service is push-only. Ignore other client messages.
	}

	async webSocketClose(socket, code, reason) {
		console.log('External WebSocket client disconnected:', code, reason);
	}

	async webSocketError(socket, error) {
		console.error('External WebSocket client error:', error);
	}
}
