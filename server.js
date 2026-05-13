const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// === CONFIGURACIÓN ===
const PORT = process.env.PORT || 3000;
const JIRA_HOST = 'jirasegurosbolivar.atlassian.net';
const JIRA_EMAIL = process.env.JIRA_EMAIL || '';
const JIRA_TOKEN = process.env.JIRA_TOKEN || '';

// === SEGURIDAD ===
// Solo estos orígenes pueden usar el proxy
const ALLOWED_ORIGINS = [
    'https://gestionincidentesti-sys.github.io',
    'http://localhost:3000',
    'http://localhost',
    'http://127.0.0.1'
];

// Solo métodos de lectura
const ALLOWED_METHODS = ['GET', 'OPTIONS'];

// Rate limiting: máximo 60 peticiones por minuto por IP
const rateLimitMap = new Map();
const RATE_LIMIT = 60;
const RATE_WINDOW = 60000; // 1 minuto

function isRateLimited(ip) {
    const now = Date.now();
    const entry = rateLimitMap.get(ip);
    if (!entry || (now - entry.start) > RATE_WINDOW) {
        rateLimitMap.set(ip, { start: now, count: 1 });
        return false;
    }
    entry.count++;
    return entry.count > RATE_LIMIT;
}

function isOriginAllowed(origin) {
    if (!origin) return true; // Peticiones sin origin (ej: curl, Postman) — permitir en dev
    return ALLOWED_ORIGINS.some(allowed => origin.startsWith(allowed));
}

// Solo permitir rutas de API de Jira de lectura (search, issue, field)
function isPathAllowed(jiraPath) {
    const allowed = ['/rest/api/3/search', '/rest/api/3/issue/', '/rest/api/3/field', '/rest/api/2/search', '/rest/api/2/issue/', '/rest/api/2/field'];
    return allowed.some(p => jiraPath.startsWith(p));
}

// === SERVIDOR ===
const server = http.createServer((req, res) => {
    const origin = req.headers.origin || req.headers.referer || '';
    const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

    // CORS — solo orígenes permitidos
    const allowedOrigin = isOriginAllowed(origin) ? (origin || '*') : null;
    if (!allowedOrigin && origin) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Origin not allowed' }));
        return;
    }

    res.setHeader('Access-Control-Allow-Origin', allowedOrigin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Preflight
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    // Solo GET permitido
    if (!ALLOWED_METHODS.includes(req.method)) {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed. Only GET is permitted.' }));
        return;
    }

    // Rate limiting
    if (isRateLimited(clientIP)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Rate limit exceeded. Max 60 requests per minute.' }));
        return;
    }

    // Servir dashboard HTML
    if (req.url === '/' || req.url === '/index.html') {
        const htmlPath = path.join(__dirname, 'dashboard-n1-tribus.html');
        if (fs.existsSync(htmlPath)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(fs.readFileSync(htmlPath, 'utf8'));
        } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<h1>Dashboard N1 Proxy - Running</h1><p>Deploy dashboard-n1-tribus.html to use.</p>');
        }
        return;
    }

    // Health check
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
        return;
    }

    // Proxy a Jira API (SOLO LECTURA)
    if (req.url.startsWith('/jira/')) {
        const jiraPath = req.url.replace('/jira/', '/rest/api/2/');

        // Validar que la ruta sea permitida
        if (!isPathAllowed(jiraPath)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Path not allowed. Only search and read operations permitted.' }));
            return;
        }

        // Verificar credenciales configuradas
        if (!JIRA_EMAIL || !JIRA_TOKEN) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'JIRA_EMAIL and JIRA_TOKEN environment variables not configured.' }));
            return;
        }

        // Para /search, usar POST (Jira Cloud deprecó GET para search)
        const urlObj = new URL(jiraPath, `https://${JIRA_HOST}`);
        const isSearch = jiraPath.startsWith('/rest/api/2/search') || jiraPath.startsWith('/rest/api/3/search');
        
        let method = 'GET';
        let postBody = null;
        let finalPath = jiraPath;

        if (isSearch) {
            method = 'POST';
            finalPath = '/rest/api/3/search';
            // Convertir query params a body JSON
            const params = new URLSearchParams(urlObj.search);
            const body = {};
            if (params.get('jql')) body.jql = params.get('jql');
            if (params.get('maxResults')) body.maxResults = parseInt(params.get('maxResults'));
            if (params.get('fields')) body.fields = params.get('fields').split(',');
            if (params.get('startAt')) body.startAt = parseInt(params.get('startAt'));
            postBody = JSON.stringify(body);
        }

        const options = {
            hostname: JIRA_HOST,
            path: finalPath,
            method: method,
            headers: {
                'Authorization': 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64'),
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        };

        if (postBody) {
            options.headers['Content-Length'] = Buffer.byteLength(postBody);
        }

        const proxyReq = https.request(options, (proxyRes) => {
            let data = '';
            proxyRes.on('data', chunk => data += chunk);
            proxyRes.on('end', () => {
                res.writeHead(proxyRes.statusCode, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': allowedOrigin || '*'
                });
                res.end(data);
            });
        });

        proxyReq.on('error', (err) => {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Proxy error: ' + err.message }));
        });

        if (postBody) proxyReq.write(postBody);
        proxyReq.end();
        return;
    }

    // Servir archivos estáticos
    const filePath = path.join(__dirname, req.url);
    if (fs.existsSync(filePath) && !filePath.includes('..')) {
        const ext = path.extname(filePath);
        const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
        res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
        res.end(fs.readFileSync(filePath));
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
    console.log(`\n  ✅ Dashboard N1 Proxy corriendo en puerto ${PORT}`);
    console.log(`  🔒 Orígenes permitidos: ${ALLOWED_ORIGINS.join(', ')}`);
    console.log(`  🚫 Solo lectura (GET)`);
    console.log(`  ⏱  Rate limit: ${RATE_LIMIT} req/min\n`);
});
