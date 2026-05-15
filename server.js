const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const JIRA_HOST = 'jirasegurosbolivar.atlassian.net';
const JIRA_EMAIL = process.env.JIRA_EMAIL || '';
const JIRA_TOKEN = process.env.JIRA_TOKEN || '';

const ALLOWED_ORIGINS = [
    'https://gestionincidentesti-sys.github.io',
    'https://dashboard-n1-sre.onrender.com',
    'http://dashboard-n1-sre.onrender.com',
    'http://localhost:3000',
    'http://localhost',
    'http://127.0.0.1'
];

const ALLOWED_METHODS = ['GET', 'OPTIONS'];
const rateLimitMap = new Map();
const RATE_LIMIT = 60;
const RATE_WINDOW = 60000;

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
    if (!origin) return true;
    return ALLOWED_ORIGINS.some(allowed => origin.startsWith(allowed));
}

const server = http.createServer((req, res) => {
    const origin = req.headers.origin || '';
    const referer = req.headers.referer || '';
    const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

    // Permitir acceso directo (sin origin) y desde orígenes permitidos
    const isSameOrigin = referer.includes('onrender.com') || referer.includes('localhost');
    const allowedOrigin = (!origin || isOriginAllowed(origin) || isSameOrigin) ? (origin || '*') : null;
    if (!allowedOrigin && origin) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Origin not allowed' }));
        return;
    }

    res.setHeader('Access-Control-Allow-Origin', allowedOrigin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    if (!ALLOWED_METHODS.includes(req.method)) {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }

    if (isRateLimited(clientIP)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return;
    }

    if (req.url === '/' || req.url === '/index.html') {
        const htmlPath = path.join(__dirname, 'dashboard-n1-tribus.html');
        if (fs.existsSync(htmlPath)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(fs.readFileSync(htmlPath, 'utf8'));
        } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<h1>Dashboard N1 Proxy - Running</h1>');
        }
        return;
    }

    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
        return;
    }

    // Endpoint de análisis de caso - consulta Jira y genera análisis extenso
    if (req.url.startsWith('/analizar/')) {
        if (!JIRA_EMAIL || !JIRA_TOKEN) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'JIRA credentials not configured' }));
            return;
        }

        const casoId = req.url.replace('/analizar/', '').split('?')[0];
        if (!casoId.match(/^MDSB-\d+$/)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid case ID format' }));
            return;
        }

        // Consultar issue con descripción, comentarios, historial
        const jiraPath = `/rest/api/2/issue/${casoId}?expand=changelog&fields=summary,description,status,priority,assignee,created,updated,comment,customfield_27826,components,labels`;

        const options = {
            hostname: JIRA_HOST,
            path: jiraPath,
            method: 'GET',
            headers: {
                'Authorization': 'Basic ' + Buffer.from(JIRA_EMAIL + ':' + JIRA_TOKEN).toString('base64'),
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        };

        const proxyReq = https.request(options, (proxyRes) => {
            let data = '';
            proxyRes.on('data', chunk => data += chunk);
            proxyRes.on('end', () => {
                try {
                    const issue = JSON.parse(data);
                    if (proxyRes.statusCode !== 200) {
                        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOrigin || '*' });
                        res.end(JSON.stringify({ error: 'Jira returned error', details: data }));
                        return;
                    }

                    // Buscar runbooks en Confluence y casos similares en Jira
                    const summary = (issue.fields && issue.fields.summary) || '';
                    const searchTerms = extraerTerminosBusqueda(summary, issue.fields ? issue.fields.description : '');
                    buscarConfluence(searchTerms, (runbooks) => {
                        buscarCasosSimilares(issue, casoId, (casosRelacionados) => {
                            const analisis = generarAnalisis(issue, casoId);
                            analisis.runbooks = runbooks;
                            analisis.casosRelacionados = casosRelacionados;
                            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOrigin || '*' });
                            res.end(JSON.stringify(analisis));
                        });
                    });
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOrigin || '*' });
                    res.end(JSON.stringify({ error: 'Parse error', message: e.message }));
                }
            });
        });

        proxyReq.on('error', (err) => {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Proxy error: ' + err.message }));
        });

        proxyReq.end();
        return;
    }

    // Proxy a Jira - pasa la peticion tal cual como GET a /rest/api/2/
    if (req.url.startsWith('/jira/')) {
        if (!JIRA_EMAIL || !JIRA_TOKEN) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'JIRA credentials not configured' }));
            return;
        }

        const jiraPath = req.url.replace('/jira/', '/rest/api/2/');

        const options = {
            hostname: JIRA_HOST,
            path: jiraPath,
            method: 'GET',
            headers: {
                'Authorization': 'Basic ' + Buffer.from(JIRA_EMAIL + ':' + JIRA_TOKEN).toString('base64'),
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-Atlassian-Token': 'no-check'
            }
        };

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

        proxyReq.end();
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
});

function extraerTerminosBusqueda(summary, description) {
    // Extraer palabras clave del resumen y descripción para buscar en Confluence
    const stopWords = ['inc', 'software', 'error', 'datos', 'contacto', 'reporte', 'procedimiento', 'usuario', 'indica', 'informa', 'solicitud', 'cambio', 'web', 'app'];
    const desc = (description || '').toLowerCase();
    
    // Extraer nombre de aplicación del summary
    let appName = summary.replace(/^(INC|IMAC|SER)-?(SOFTWARE|APP)?-?\s*/i, '').trim();
    
    // Buscar patrones conocidos
    const keywords = [];
    if (appName) keywords.push(appName.split(' ').slice(0, 3).join(' '));
    
    // Detectar sistemas específicos
    const sistemas = ['facil pro', 'sipab', 'simon', 'tronador', 'jelpit', 'sisalud', 'gomedisys', 'poliza digital', 'bolivar conmigo', 'portal arl', 'servicio deuda', 'comision', 'endoso', 'ciencuadras'];
    sistemas.forEach(s => {
        if (desc.includes(s) || summary.toLowerCase().includes(s)) {
            keywords.push(s);
        }
    });

    // Detectar errores específicos
    if (desc.includes('ora-')) {
        const oraMatch = desc.match(/ora-\d+/i);
        if (oraMatch) keywords.push(oraMatch[0]);
    }

    return keywords.length > 0 ? keywords.slice(0, 3) : [appName || 'incidente'];
}

function buscarConfluence(searchTerms, callback) {
    const CONFLUENCE_HOST = JIRA_HOST;
    const cql = encodeURIComponent(`type=page AND space=BDCT AND (title~"${searchTerms[0]}" OR text~"${searchTerms[0]}")`);
    const confluencePath = `/wiki/rest/api/content/search?cql=${cql}&limit=5&expand=metadata.labels`;

    const options = {
        hostname: CONFLUENCE_HOST,
        path: confluencePath,
        method: 'GET',
        headers: {
            'Authorization': 'Basic ' + Buffer.from(JIRA_EMAIL + ':' + JIRA_TOKEN).toString('base64'),
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }
    };

    const confReq = https.request(options, (confRes) => {
        let data = '';
        confRes.on('data', chunk => data += chunk);
        confRes.on('end', () => {
            try {
                const result = JSON.parse(data);
                const runbooks = (result.results || []).map(page => ({
                    title: page.title,
                    url: `https://${CONFLUENCE_HOST}/wiki${page._links && page._links.webui ? page._links.webui : '/spaces/BDCT'}`,
                    id: page.id
                }));
                callback(runbooks);
            } catch (e) {
                callback([]);
            }
        });
    });

    confReq.on('error', () => { callback([]); });
    confReq.end();
    confReq.setTimeout(5000, () => { confReq.destroy(); callback([]); });
}

function buscarCasosSimilares(issue, casoId, callback) {
    const fields = issue.fields || {};
    const description = (fields.description || '').toLowerCase();
    const summary = (fields.summary || '').toLowerCase();

    // Extraer keywords para buscar casos similares
    const keywords = [];
    const sistemas = ['facil pro', 'sipab', 'simon', 'tronador', 'jelpit', 'sisalud', 'gomedisys', 'portal arl', 'servicio deuda', 'comision', 'endoso', 'cumplimiento', 'hogar', 'autos', 'vida', 'arl'];
    sistemas.forEach(s => {
        if (description.includes(s) || summary.includes(s)) keywords.push(s);
    });

    // Detectar producto
    const prodMatch = description.match(/producto?\s*(\d{3})/i);
    if (prodMatch) keywords.push('producto ' + prodMatch[1]);

    // Detectar tipo de error
    if (description.includes('cobro') || description.includes('prima')) keywords.push('cobro prima');
    if (description.includes('endoso nominativo') || description.includes('endoso informativo')) keywords.push('endoso nominativo');
    if (description.includes('factura')) keywords.push('factura');
    if (description.includes('devolucion') || description.includes('devolución')) keywords.push('devolucion');
    if (description.includes('cambio de clave')) keywords.push('cambio clave');

    const searchText = keywords.length > 0 ? keywords.slice(0, 3).join(' ') : summary.split(' ').slice(0, 4).join(' ');
    const jql = encodeURIComponent(`project = MDSB AND text ~ "${searchText}" AND key != ${casoId} AND status in (Resuelto, Cerrado) ORDER BY created DESC`);
    const jiraPath = `/rest/api/2/search?jql=${jql}&maxResults=5&fields=summary,status,resolution,created`;

    const options = {
        hostname: JIRA_HOST,
        path: jiraPath,
        method: 'GET',
        headers: {
            'Authorization': 'Basic ' + Buffer.from(JIRA_EMAIL + ':' + JIRA_TOKEN).toString('base64'),
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }
    };

    const jiraReq = https.request(options, (jiraRes) => {
        let data = '';
        jiraRes.on('data', chunk => data += chunk);
        jiraRes.on('end', () => {
            try {
                const result = JSON.parse(data);
                const casos = (result.issues || []).map(i => ({
                    key: i.key,
                    resumen: i.fields.summary || '',
                    estado: i.fields.status ? i.fields.status.name : 'Desconocido',
                    resolucion: i.fields.resolution ? i.fields.resolution.name : '',
                    fecha: i.fields.created ? new Date(i.fields.created).toLocaleDateString('es-CO') : ''
                }));
                callback(casos);
            } catch (e) {
                callback([]);
            }
        });
    });

    jiraReq.on('error', () => { callback([]); });
    jiraReq.end();
    jiraReq.setTimeout(8000, () => { jiraReq.destroy(); callback([]); });
}

function generarAnalisis(issue, casoId) {
    const fields = issue.fields || {};
    const summary = fields.summary || '';
    const description = fields.description || 'Sin descripción';
    const status = fields.status ? fields.status.name : 'Desconocido';
    const priority = fields.priority ? fields.priority.name : 'No definida';
    const assignee = fields.assignee ? fields.assignee.displayName : 'Sin asignar';
    const created = fields.created ? new Date(fields.created).toLocaleString('es-CO') : '';
    const updated = fields.updated ? new Date(fields.updated).toLocaleString('es-CO') : '';
    const tribu = fields.customfield_27826 ? fields.customfield_27826.value : 'No asignada';
    const comments = fields.comment ? fields.comment.comments || [] : [];

    // Extraer el reporte del campo descripción
    let reporte = '';
    const reporteMatch = description.match(/Reporte[:\s]*\n?"?([^"]*?)(?:\n(?:Procedimiento|Segundo filtro|\*\*Procedimiento)|$)/is);
    if (reporteMatch) {
        reporte = reporteMatch[1].trim().replace(/\\n/g, '\n');
    } else {
        reporte = description.substring(0, 500);
    }

    // Extraer procedimiento
    let procedimiento = '';
    const procMatch = description.match(/Procedimiento[s]?[:\s]*\n([\s\S]*?)(?:\n\n|!\[|$)/i);
    if (procMatch) {
        procedimiento = procMatch[1].trim().substring(0, 500);
    }

    // Historial de cambios de estado
    const changelog = issue.changelog ? issue.changelog.histories || [] : [];
    const statusChanges = [];
    changelog.forEach(history => {
        (history.items || []).forEach(item => {
            if (item.field === 'status') {
                statusChanges.push({
                    from: item.fromString,
                    to: item.toString,
                    date: new Date(history.created).toLocaleString('es-CO'),
                    author: history.author ? history.author.displayName : 'Sistema'
                });
            }
        });
    });

    // Últimos comentarios relevantes
    const lastComments = comments.slice(-3).map(c => ({
        author: c.author ? c.author.displayName : 'Desconocido',
        date: new Date(c.created).toLocaleString('es-CO'),
        body: (c.body || '').substring(0, 300)
    }));

    // Calcular antigüedad
    const createdDate = new Date(fields.created);
    const now = new Date();
    const diasAbierto = Math.floor((now - createdDate) / (1000 * 60 * 60 * 24));

    // Calcular Aging N1: desde que se asignó al grupo Especialistas N1
    let diasN1 = diasAbierto; // fallback a fecha de creación
    let fechaLlegadaN1 = null;
    changelog.forEach(history => {
        (history.items || []).forEach(item => {
            // Buscar asignación a grupo Especialistas N1 (campo assignee o group)
            if ((item.field === 'assignee' || item.field === 'group' || item.field === 'Equipo de trabajo') &&
                item.toString && item.toString.toLowerCase().includes('especialistas n1')) {
                if (!fechaLlegadaN1) { // tomar la primera vez que llegó a N1
                    fechaLlegadaN1 = new Date(history.created);
                }
            }
        });
    });
    if (fechaLlegadaN1) {
        diasN1 = Math.floor((now - fechaLlegadaN1) / (1000 * 60 * 60 * 24));
    }

    // Calcular Aging Escalado: desde que se creó un GD a tribu (se detecta en comentarios)
    let diasEscalado = null;
    let fechaEscalado = null;
    let gdKey = null;
    comments.forEach(comment => {
        const body = comment.body || '';
        // Buscar mención de GD en comentarios (patrón GDxxx-yyyy)
        const gdMatch = body.match(/\b(GD\d{1,4}-\d+)\b/i);
        if (gdMatch && !fechaEscalado) {
            fechaEscalado = new Date(comment.created);
            gdKey = gdMatch[1];
        }
    });
    // Fallback: si no hay GD en comentarios, buscar en changelog transición a Escalado
    if (!fechaEscalado) {
        changelog.forEach(history => {
            (history.items || []).forEach(item => {
                if (item.field === 'status' &&
                    item.toString && (item.toString.toLowerCase().includes('escalado') || item.toString.toLowerCase().includes('escalar'))) {
                    fechaEscalado = new Date(history.created);
                }
            });
        });
    }
    if (fechaEscalado) {
        diasEscalado = Math.floor((now - fechaEscalado) / (1000 * 60 * 60 * 24));
    }

    // Generar análisis contextual
    let analisisTexto = '';
    let solucionInmediata = '';
    let solucionDefinitiva = '';
    let causaRaiz = '';
    let prevencion = '';
    let riesgo = 'Medio';

    // Análisis basado en patrones del reporte
    if (description.toLowerCase().includes('ora-20005') || description.toLowerCase().includes('error en el calculo')) {
        causaRaiz = 'Error de base de datos Oracle (ORA-20005) en cálculo de coeficiente. Los datos de la tabla de coeficientes no son consistentes con los parámetros de la póliza (producto, sección, vigencia). Las pólizas afectadas tienen valores asegurados por debajo de la política mínima actual.';
        analisisTexto = 'El error se genera cuando el sistema intenta calcular prima/coeficiente para pólizas cuyo valor asegurado está por debajo del mínimo parametrizado. El procedimiento de cálculo no maneja esta excepción y lanza ORA-20005.';
        solucionInmediata = '1. Identificar las pólizas específicas y validar sus valores asegurados.\n2. Verificar en tabla de coeficientes si existen registros para el producto/sección.\n3. Si el valor asegurado está bajo política mínima, proceder con cancelación manual.\n4. Coordinar con DBA para intervención directa si el error persiste.';
        solucionDefinitiva = 'Modificar el procedimiento de cálculo para manejar la excepción cuando el valor asegurado está por debajo del mínimo, generando un mensaje descriptivo en lugar de un error no controlado.';
        prevencion = '1. Implementar validación previa al cálculo que verifique valor asegurado vs política mínima.\n2. Agregar monitoreo de errores ORA-20005 para detección temprana.\n3. Crear alerta cuando se detecten pólizas con valores bajo mínimo.';
        riesgo = 'Alto';
    } else if (description.toLowerCase().includes('facil pro') || description.toLowerCase().includes('fácil pro')) {
        causaRaiz = 'Problema en el microservicio de gestión de OTTs de Fácil Pro, posiblemente relacionado con el manejo de múltiples adjuntos o tamaño de payload excesivo.';
        analisisTexto = `Incidencia en plataforma Fácil Pro. ${reporte}. Los errores suelen estar relacionados con el microservicio de gestión de OTTs, especialmente cuando se manejan múltiples adjuntos o reportes pesados.`;
        solucionInmediata = '1. Aplicar workaround estándar: Limpiar trabajos desde Fácil-Pro Web.\n2. Reintentar con fecha/hora actual exacta sin interrumpir la carga.\n3. Si el usuario maneja muchos adjuntos (>50), dividir en lotes.';
        solucionDefinitiva = 'Optimizar el microservicio para manejar cargas masivas de adjuntos con procesamiento asíncrono y validación de tamaño previo al envío.';
        prevencion = '1. Implementar límite visible de adjuntos por OTT con mensaje informativo.\n2. Agregar procesamiento asíncrono para cargas >30 adjuntos.\n3. Monitorear latencia del microservicio en Datadog.';
        riesgo = 'Medio';
    } else if (description.toLowerCase().includes('sipab') || description.toLowerCase().includes('portal arl')) {
        causaRaiz = 'Problema de permisos/acceso en portales ARL. Puede estar relacionado con sesiones expiradas, permisos no propagados, o problemas en servicios backend de consulta.';
        analisisTexto = `Incidencia en portales ARL/SIPAB. ${reporte}. Los problemas de portales ARL frecuentemente están relacionados con permisos de usuario, sesiones expiradas, o problemas en los servicios backend.`;
        solucionInmediata = '1. Verificar estado del usuario en el sistema de autenticación del portal.\n2. Revisar si hay alertas activas en Datadog para servicios ARL.\n3. Validar que la empresa/póliza asociada esté activa y vigente.';
        solucionDefinitiva = 'Revisar la propagación de permisos en el sistema de autenticación y mejorar el manejo de sesiones para evitar estados inconsistentes.';
        prevencion = '1. Implementar health check periódico de permisos de usuarios delegados.\n2. Agregar logs detallados cuando un usuario no puede operar módulos.\n3. Crear alerta para detección de múltiples usuarios afectados simultáneamente.';
        riesgo = 'Medio';
    } else if (description.toLowerCase().includes('servicio de deuda') || description.toLowerCase().includes('deuda')) {
        causaRaiz = 'Inconsistencia en el servicio de deuda/cartera. Facturas duplicadas, procesos batch que no ejecutaron correctamente, o desincronización entre sistemas transaccional y de consulta.';
        analisisTexto = `Incidencia en servicio de deuda/cartera. ${reporte}. Problemas de deuda incorrecta suelen originarse por facturas duplicadas o desincronización entre sistemas.`;
        solucionInmediata = '1. Validar en sistema de cartera el origen de la factura/cobro incorrecto.\n2. Verificar si el proceso batch nocturno ejecutó correctamente.\n3. Comparar datos entre BD transaccional y el servicio de consulta.';
        solucionDefinitiva = 'Implementar reconciliación automática entre el sistema transaccional y el servicio de consulta de deuda para detectar y corregir inconsistencias.';
        prevencion = '1. Agregar validación de consistencia post-ejecución de batch nocturno.\n2. Implementar alerta cuando un cliente tiene facturas con valores divergentes.\n3. Crear proceso de reconciliación diaria automática.';
        riesgo = 'Alto';
    } else if ((description.toLowerCase().includes('endoso nominativo') || description.toLowerCase().includes('endoso informativo') || description.toLowerCase().includes('repaso')) && (description.toLowerCase().includes('cobro') || description.toLowerCase().includes('prima'))) {
        causaRaiz = 'Cuando se procesa un endoso de tipo informativo/nominativo (repaso, nota, cambio de dirección), el sistema ejecuta el recálculo de prima como parte del flujo estándar sin distinguir si el endoso es puramente informativo. El proceso de tarificación detecta diferencias (por redondeo o coberturas con valores mínimos) y genera un cobro adicional indebido.';
        analisisTexto = `Incidencia de cobro erróneo por endoso informativo. ${reporte}. El tipo de endoso (COD_END / SUB_COD_END) no tiene validación que impida la generación de movimientos de prima cuando la naturaleza del endoso es solo informativa.`;
        solucionInmediata = '1. Anular el cobro mediante ajuste/cruce de facturación para dejar saldo en cero.\n2. Verificar en A2990700 las facturas generadas por el endoso.\n3. Ejecutar cruce de facturas si aplica.';
        solucionDefinitiva = 'Modificar la lógica del proceso de endosos para que cuando el tipo sea nominativo/informativo (sin modificación de coberturas ni valores asegurados), el sistema no ejecute recálculo de prima.';
        prevencion = '1. Implementar validación que bloquee generación de prima cuando el endoso es informativo.\n2. En Simón Web, mostrar resumen de prima antes de confirmar y alertar si un endoso informativo genera cobro.\n3. Monitoreo: alerta para detectar endosos nominativos con prima > 0.';
        riesgo = 'Alto';
    } else if (description.toLowerCase().includes('simon') || description.toLowerCase().includes('tronador')) {
        causaRaiz = 'Incidencia en sistema core (SIMON/Tronador). Puede estar relacionada con parametrización, reglas de negocio, o lógica de cálculo en el módulo afectado.';
        analisisTexto = `Incidencia en sistema core. ${reporte}. Los errores en sistemas core pueden tener impacto en emisión, facturación o liquidación de pólizas.`;
        solucionInmediata = '1. Identificar el módulo específico afectado y el tipo de operación.\n2. Verificar si hay parametrización que limite la operación reportada.\n3. Validar datos de la póliza/producto en cuestión.';
        solucionDefinitiva = 'Revisar la lógica del módulo afectado y corregir la condición que genera el error. Coordinar con la tribu de desarrollo correspondiente.';
        prevencion = '1. Agregar validaciones preventivas en el flujo de la operación.\n2. Implementar logs detallados para facilitar diagnóstico futuro.\n3. Documentar el caso en runbook para resolución rápida si se repite.';
        riesgo = 'Alto';
    } else if (description.toLowerCase().includes('endoso') || description.toLowerCase().includes('provisorio')) {
        causaRaiz = 'Problema en el proceso de cierre/confirmación de endosos. Los endosos permanecen en estado provisorio cuando ya tienen factura cobrada, indicando una falla en el job batch de cierre o en la lógica de transición de estados.';
        analisisTexto = `Incidencia con endosos provisorios. ${reporte}. Los endosos que permanecen en estado provisorio cuando ya tienen factura cobrada indican un problema en el proceso de cierre.`;
        solucionInmediata = '1. Revisar la base de pólizas afectadas.\n2. Validar en BD el estado de cada endoso y su relación con facturas.\n3. Ejecutar proceso de actualización de estado (provisorio → definitivo).';
        solucionDefinitiva = 'Corregir el job batch de cierre de endosos para que procese correctamente los casos donde la factura ya fue cobrada.';
        prevencion = '1. Verificar que el job batch de cierre esté programado y ejecutando correctamente.\n2. Crear alerta para endosos en estado provisorio con más de 48h.\n3. Implementar reconciliación automática endoso vs factura.';
        riesgo = 'Alto';
    } else if (description.toLowerCase().includes('cambio de clave') && (description.toLowerCase().includes('comision') || description.toLowerCase().includes('comisión'))) {
        causaRaiz = 'Cuando se hace un cambio de clave (COD_END=900) sobre pólizas emitidas con convenio 3, el sistema no genera registros en A2000252 porque no encuentra información previa — ya que en emisiones con convenio 3 no se deja información en esa tabla.';
        analisisTexto = `Incidencia de comisiones por cambio de clave. ${reporte}. El procedimiento PRC_INSEXISTENTESEM no encuentra datos previos en A2000252 para emisiones con convenio 3, por lo que no genera la comisión.`;
        solucionInmediata = '1. Obtener datos de comisión desde A2000250.\n2. Calcular valor de comisión.\n3. Insertar manualmente en A2990701 y A2000252.\n4. Ejecutar cruce de facturas.';
        solucionDefinitiva = 'Modificar PRC_INSEXISTENTESEM para que cuando no encuentre datos previos en A2000252 pero SÍ exista información en A2000250, genere los registros de comisión igualmente.';
        prevencion = '1. Monitorear pólizas con cambio de clave que no generan comisión.\n2. Crear validación post-cambio de clave que verifique existencia de registros en A2990701.\n3. Documentar en runbook el procedimiento de corrección manual.';
        riesgo = 'Alto';
    } else {
        causaRaiz = 'Pendiente de análisis detallado. Se requiere revisión de logs y evidencias para determinar la causa raíz específica.';
        analisisTexto = `${reporte || summary}. Se requiere revisión detallada del caso para determinar causa raíz y plan de acción.`;
        solucionInmediata = '1. Revisar la descripción completa del caso y evidencias adjuntas.\n2. Verificar logs del servicio afectado en Datadog/Kibana.\n3. Consultar runbooks disponibles en Confluence.\n4. Si hay workaround conocido, aplicar y documentar.';
        solucionDefinitiva = 'Pendiente de diagnóstico completo. Escalar a la tribu de desarrollo con toda la evidencia recopilada.';
        prevencion = '1. Documentar el caso una vez resuelto para referencia futura.\n2. Evaluar si requiere alerta preventiva.\n3. Actualizar runbooks si se identifica un patrón nuevo.';
    }

    return {
        casoId,
        summary,
        tribu,
        status,
        priority,
        assignee,
        created,
        updated,
        diasAbierto,
        diasN1,
        diasEscalado,
        fechaLlegadaN1: fechaLlegadaN1 ? fechaLlegadaN1.toLocaleString('es-CO') : null,
        fechaEscalado: fechaEscalado ? fechaEscalado.toLocaleString('es-CO') : null,
        gdKey,
        riesgo,
        reporte: reporte.substring(0, 600),
        procedimiento: procedimiento.substring(0, 400),
        analisis: analisisTexto,
        causaRaiz,
        solucionInmediata,
        solucionDefinitiva,
        solucion: solucionInmediata,
        prevencion,
        statusChanges: statusChanges.slice(-5),
        lastComments,
        jiraUrl: `https://jirasegurosbolivar.atlassian.net/browse/${casoId}`
    };
}

server.listen(PORT, () => {
    console.log('Dashboard N1 Proxy corriendo en puerto ' + PORT);
});
