const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const JIRA_BASE = 'https://jirasegurosbolivar.atlassian.net';
const JIRA_EMAIL = 'bryan.romero@segurosbolivar.com';
const JIRA_TOKEN = 'ATATT3xFfGF0IjR_h4E8_4kOdHAL7gjPnt_l-YOeEWtMI3jgvQHFNgY89yd3lvY2vOWSmMfundKyayyxsnLfG8FjNwiIOxG96T4AOy7gNw90iWtaLh4X3e4lrnTn0uQB72aRrm12pOlzD5P6hwklm-YppUI1-d-GH_h8HhIJ4eC0wRIoyj9t7Hg=A25B8C11';

const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    // Serve dashboard HTML
    if (req.url === '/' || req.url === '/index.html') {
        const html = fs.readFileSync(path.join(__dirname, 'dashboard-n1-tribus.html'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
    }

    // Proxy to Jira API
    if (req.url.startsWith('/jira/')) {
        const jiraPath = req.url.replace('/jira/', '/rest/api/2/');
        const options = {
            hostname: 'jirasegurosbolivar.atlassian.net',
            path: jiraPath,
            method: 'GET',
            headers: {
                'Authorization': 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64'),
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        };

        const proxyReq = https.request(options, (proxyRes) => {
            let data = '';
            proxyRes.on('data', chunk => data += chunk);
            proxyRes.on('end', () => {
                res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
                res.end(data);
            });
        });

        proxyReq.on('error', (err) => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        });

        proxyReq.end();
        return;
    }

    // Serve other static files
    const filePath = path.join(__dirname, req.url);
    if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath);
        const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
        res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
        res.end(fs.readFileSync(filePath));
        return;
    }

    res.writeHead(404);
    res.end('Not found');
});

server.listen(PORT, () => {
    console.log(`\n  Dashboard N1 corriendo en: http://localhost:${PORT}\n`);
    console.log(`  Abre tu navegador en esa URL.\n`);
    console.log(`  Para detener: Ctrl+C\n`);
});
