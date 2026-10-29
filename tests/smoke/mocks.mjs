/**
 * Stand-ins for the outside services of a smoke test, so it runs without
 * accounts or network:
 *   :4011  OpenAI-compatible API (key "smoke-key", models smoke-chat and smoke-embed)
 *   :2525  SMTP server that keeps every message
 *   :4012  GET /messages returns the kept messages as JSON
 */
import http from 'node:http';
import net from 'node:net';

const messages = [];

http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== 'Bearer smoke-key') {
      res.statusCode = 401;
      return res.end('{"error":"invalid key"}');
    }
    if (req.url === '/v1/models') {
      return res.end(JSON.stringify({ data: [{ id: 'smoke-chat' }, { id: 'smoke-embed' }] }));
    }
    if (req.url === '/v1/chat/completions') {
      return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }));
    }
    if (req.url === '/v1/embeddings') {
      return res.end(JSON.stringify({ data: [{ embedding: Array(768).fill(0.1) }] }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
}).listen(4011);

net.createServer((socket) => {
  let buffer = '';
  let data = null;
  socket.write('220 smoke ESMTP\r\n');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\r\n')) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (data !== null) {
        if (line === '.') {
          messages.push({ receivedAt: new Date().toISOString(), raw: data.join('\n') });
          data = null;
          socket.write('250 queued\r\n');
        } else {
          data.push(line.startsWith('..') ? line.slice(1) : line);
        }
        continue;
      }
      if (/^(EHLO|HELO)/i.test(line)) socket.write('250-smoke\r\n250 AUTH PLAIN LOGIN\r\n');
      else if (/^AUTH/i.test(line)) socket.write('235 ok\r\n');
      else if (/^DATA/i.test(line)) { data = []; socket.write('354 go ahead\r\n'); }
      else if (/^QUIT/i.test(line)) socket.end('221 bye\r\n');
      else socket.write('250 OK\r\n');
    }
  });
}).listen(2525);

http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(req.url === '/messages' ? messages : []));
}).listen(4012);

console.log('smoke mocks listening');
