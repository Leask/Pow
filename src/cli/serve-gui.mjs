import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const host = '127.0.0.1';
const port = Number.parseInt(process.env.PORT ?? '8080', 10);

const mimeByExtension = {
    '.html': 'text/html; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.nes': 'application/octet-stream',
};

function resolveRequestPath(urlPath) {
    if (urlPath === '/' || urlPath === '' || urlPath === '/index.html') {
        return path.join(projectRoot, 'web', 'index.html');
    }

    // Compatibility for stale cached HTML that requests /app.mjs
    if (urlPath === '/app.mjs') {
        return path.join(projectRoot, 'web', 'app.mjs');
    }

    const safePath = path.normalize(urlPath).replace(/^\/+/, '');
    const fullPath = path.resolve(projectRoot, safePath);

    if (!fullPath.startsWith(projectRoot)) {
        return null;
    }

    return fullPath;
}

const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', `http://${host}:${port}`);
    const fullPath = resolveRequestPath(requestUrl.pathname);

    if (!fullPath) {
        response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Forbidden');
        return;
    }

    fs.stat(fullPath, (statError, stat) => {
        if (statError || !stat.isFile()) {
            response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            response.end('Not Found');
            return;
        }

        const extension = path.extname(fullPath);
        const contentType =
            mimeByExtension[extension] ?? 'application/octet-stream';

        response.writeHead(200, { 'content-type': contentType });
        const stream = fs.createReadStream(fullPath);
        stream.pipe(response);

        stream.on('error', () => {
            response.writeHead(500, {
                'content-type': 'text/plain; charset=utf-8',
            });
            response.end('Internal Server Error');
        });
    });
});

server.listen(port, host, () => {
    console.log(`GUI server running at http://${host}:${port}`);
    console.log('Open this URL in your browser, then load a .nes ROM file.');
});
