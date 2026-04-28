import Anthropic from '@anthropic-ai/sdk';
import { jwtVerify, createRemoteJWKSet } from 'jose';

export const config = { runtime: 'nodejs', maxDuration: 60 };

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || 'grec@cin.ufpe.br,giordanorec@gmail.com')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

async function verifyGoogleJWT(token: string): Promise<{ email: string; name?: string }> {
    if (!GOOGLE_CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID env var not set');
    const { payload } = await jwtVerify(token, JWKS, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: GOOGLE_CLIENT_ID,
    });
    const p = payload as { email?: string; email_verified?: boolean; name?: string };
    if (!p.email_verified) throw new Error('email not verified');
    if (!p.email) throw new Error('no email in token');
    return { email: p.email.toLowerCase(), name: p.name };
}

const SYSTEM_PROMPT = `Você é um arquiteto de workflows da plataforma Music.AI.
Dado um pedido em linguagem natural, monte um workflow visual usando os módulos do catálogo e cabos conectando-os.

REGRAS RÍGIDAS:
1. Use APENAS puckIds que existem no catálogo (case-sensitive). Não invente módulos.
2. SEMPRE inclua pelo menos um módulo de input (categoria "input") e um de output (categoria "output").
3. Conecte respeitando tipos compatíveis (mesmo \`t\`). Se for inevitável conectar tipos diferentes, marque needsAdapter=true.
4. Inputs com req=true devem estar conectados; inputs req=false são opcionais.
5. Coordenadas: x cresce da esquerda (entrada) pra direita (saída). Espaçe ~200px no x. Y entre 100 e 600, espaçe ~140px no y entre módulos paralelos da mesma coluna.
6. fromIdx/toIdx referenciam o índice (0-based) no array "modules". fromOutput/toInput são índices 0-based dos pinos no array "outputs"/"inputs" do módulo.
7. Retorne APENAS o JSON, sem markdown, sem comentário.

CATÁLOGO (formato {puckId: {name, type, desc, inputs:[{t,req}], outputs:[{t,req}]}}):
{{CATALOG}}

TIPOS: audio | midi | text | video | data | ctrl | chord

ESTRUTURA DA RESPOSTA (estritamente esse JSON):
{
  "title": "string curta (até 60 chars)",
  "description": "1-2 frases explicando o fluxo",
  "modules": [
    { "puckId": "audio-up", "x": 100, "y": 200 }
  ],
  "connections": [
    { "fromIdx": 0, "fromOutput": 0, "toIdx": 1, "toInput": 0, "needsAdapter": false, "label": "" }
  ]
}`;

interface AIWorkflow {
    title: string;
    description: string;
    modules: Array<{ puckId: string; x: number; y: number }>;
    connections: Array<{ fromIdx: number; fromOutput: number; toIdx: number; toInput: number; needsAdapter?: boolean; label?: string }>;
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

export default async function handler(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const authHeader = request.headers.get('authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return jsonResponse({ error: 'Faltando token de autenticação' }, 401);

    let userEmail: string;
    try {
        const verified = await verifyGoogleJWT(token);
        userEmail = verified.email;
    } catch (err: any) {
        return jsonResponse({ error: 'Token inválido', detail: String(err.message || err) }, 401);
    }

    if (!ALLOWED_EMAILS.includes(userEmail)) {
        return jsonResponse({ error: `Acesso negado para ${userEmail}` }, 403);
    }

    let body: { prompt?: string; catalog?: Record<string, unknown> };
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: 'Corpo JSON inválido' }, 400);
    }

    const prompt = (body.prompt || '').trim();
    const catalog = body.catalog;
    if (!prompt) return jsonResponse({ error: 'Falta o prompt' }, 400);
    if (!catalog || typeof catalog !== 'object') return jsonResponse({ error: 'Falta o catálogo' }, 400);

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return jsonResponse({ error: 'ANTHROPIC_API_KEY não configurada' }, 500);

    const client = new Anthropic({ apiKey });

    const systemPrompt = SYSTEM_PROMPT.replace('{{CATALOG}}', JSON.stringify(catalog));

    let response;
    try {
        response = await client.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 4096,
            system: systemPrompt,
            messages: [{ role: 'user', content: prompt }],
        });
    } catch (err: any) {
        return jsonResponse({ error: 'Falha ao chamar Claude', detail: String(err.message || err) }, 502);
    }

    const text = response.content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('\n')
        .trim();

    let workflow: AIWorkflow;
    try {
        const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        workflow = JSON.parse(cleaned);
    } catch {
        return jsonResponse({ error: 'Claude retornou JSON inválido', raw: text }, 502);
    }

    if (!Array.isArray(workflow.modules) || !Array.isArray(workflow.connections)) {
        return jsonResponse({ error: 'Estrutura do workflow inválida', raw: text }, 502);
    }

    return jsonResponse({
        workflow,
        user: { email: userEmail },
        usage: response.usage,
    });
}
