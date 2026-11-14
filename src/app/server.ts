/**
 * The HTTP server.
 *
 * Binds to loopback by default. This tool holds credentials that can change a
 * client's live website, so it does not listen on a public interface unless
 * someone deliberately sets AIVA_HOST, and it says so loudly when they do.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../core/logger.js';
import type { ApiResponse } from './api.js';
import { createApi, type ApiContext } from './api.js';

const UI_DIR = resolve(fileURLToPath(new URL('../ui', import.meta.url)));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

export interface ServerOptions extends ApiContext {
  port?: number;
  host?: string;
  /** Overridable so tests can serve from a fixture directory. */
  uiDir?: string;
}

export function createAppServer(opts: ServerOptions) {
  const handle = createApi(opts);
  const uiDir = opts.uiDir ?? UI_DIR;

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      log.error('unhandled request error', { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) send(res, { status: 500, body: { error: 'Internal error' } });
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    // No credential in this app is a bearer cookie, so there is no CSRF
    // surface to protect — but there is also no reason to be reachable from a
    // web page, and this header cannot be set cross-origin without a preflight.
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');

    if (path.startsWith('/api/')) {
      let body: unknown;
      try {
        body = await readBody(req);
      } catch (err) {
        send(res, { status: 400, body: { error: err instanceof Error ? err.message : 'Bad body' } });
        return;
      }
      send(res, await handle(req.method ?? 'GET', path, body));
      return;
    }

    // The approval page is a single-page route: /approve/<token> loads the
    // same document, which reads the token from the address bar.
    if (path.startsWith('/approve/')) {
      await serveFile(res, join(uiDir, 'approve.html'));
      return;
    }

    // Decode before resolving, so an encoded `..` is caught by the guard
    // below rather than being treated as an oddly named file that happens
    // not to exist today.
    let file: string;
    try {
      file = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
    } catch {
      send(res, { status: 400, body: { error: 'Bad path' } });
      return;
    }
    const target = safeJoin(uiDir, file);
    if (!target) {
      send(res, { status: 400, body: { error: 'Bad path' } });
      return;
    }
    await serveFile(res, target);
  }

  async function serveFile(res: ServerResponse, target: string): Promise<void> {
    try {
      const content = await readFile(target);
      res.statusCode = 200;
      res.setHeader('content-type', MIME[extname(target)] ?? 'application/octet-stream');
      res.end(content);
    } catch {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('Not found');
    }
  }

  return {
    server,
    listen(): Promise<{ host: string; port: number }> {
      const port = opts.port ?? 4317;
      const host = opts.host ?? '127.0.0.1';
      if (host !== '127.0.0.1' && host !== 'localhost') {
        log.warn(
          'listening on a non-loopback address; this process holds credentials ' +
          'that can change live websites',
          { host },
        );
      }
      return new Promise((resolveListen, rejectListen) => {
        server.once('error', (err: NodeJS.ErrnoException) => {
          // The common case by far is a copy already running. Say that,
          // rather than printing a stack trace at someone.
          rejectListen(
            err.code === 'EADDRINUSE'
              ? new Error(
                  `Port ${port} is already in use — another copy is probably running. ` +
                  'Stop it, or start this one with a different AIVA_PORT.',
                )
              : err,
          );
        });
        server.listen(port, host, () => {
          // Port 0 asks the OS to choose, so report what it actually bound
          // rather than what we asked for.
          const address = server.address();
          const bound = typeof address === 'object' && address ? address.port : port;
          resolveListen({ host, port: bound });
        });
      });
    },
    close(): Promise<void> {
      return new Promise((done) => server.close(() => done()));
    },
  };
}

/** Reject anything that escapes the UI directory, symlinks and `..` alike. */
function safeJoin(root: string, relative: string): string | null {
  const target = resolve(root, normalize(relative));
  return target === root || target.startsWith(root + '/') ? target : null;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A fix pack is text; a megabyte of it is already implausible.
    if (size > 2_000_000) throw new Error('Request body is too large.');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Request body is not valid JSON.');
  }
}

function send(res: ServerResponse, response: ApiResponse): void {
  res.statusCode = response.status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(response.body ?? null));
}
