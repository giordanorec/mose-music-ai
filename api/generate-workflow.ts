import type { VercelRequest, VercelResponse } from '@vercel/node';
import Anthropic from '@anthropic-ai/sdk';

export const config = { maxDuration: 60 };

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || 'grec@cin.ufpe.br,giordanorec@gmail.com')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// `jose` é ESM-only (v6); Vercel compila a function como CJS, então usamos dynamic import().
let _josePromise: Promise<typeof import('jose')> | null = null;
function loadJose() {
    if (!_josePromise) _josePromise = import('jose');
    return _josePromise;
}
let _jwksPromise: Promise<any> | null = null;
async function getJWKS() {
    if (!_jwksPromise) {
        _jwksPromise = loadJose().then(jose =>
            jose.createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))
        );
    }
    return _jwksPromise;
}

async function verifyGoogleJWT(token: string): Promise<{ email: string; name?: string }> {
    if (!GOOGLE_CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID env var não configurada');
    const jose = await loadJose();
    const jwks = await getJWKS();
    const { payload } = await jose.jwtVerify(token, jwks, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: GOOGLE_CLIENT_ID,
    });
    const p = payload as { email?: string; email_verified?: boolean; name?: string };
    if (!p.email_verified) throw new Error('email não verificado');
    if (!p.email) throw new Error('email ausente do token');
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
    try {
        return await innerHandler(req, res);
    } catch (err: any) {
        console.error('[generate-workflow] erro não tratado:', err);
        return res.status(500).json({
            error: 'Erro inesperado no servidor',
            detail: String(err?.message || err),
            stack: err?.stack ? String(err.stack).split('\n').slice(0, 5).join(' | ') : undefined,
        });
    }
}

async function innerHandler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const authHeader = (req.headers['authorization'] || '') as string;
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return res.status(401).json({ error: 'Faltando token de autenticação' });

    let userEmail: string;
    try {
        const verified = await verifyGoogleJWT(token);
        userEmail = verified.email;
    } catch (err: any) {
        return res.status(401).json({ error: 'Token inválido', detail: String(err?.message || err) });
    }

    if (!ALLOWED_EMAILS.includes(userEmail)) {
        return res.status(403).json({ error: `Acesso negado para ${userEmail}` });
    }

    const body = req.body as { prompt?: string; catalog?: Record<string, unknown> } || {};
    const prompt = (body.prompt || '').trim();
    const catalog = body.catalog;
    if (!prompt) return res.status(400).json({ error: 'Falta o prompt' });
    if (!catalog || typeof catalog !== 'object') return res.status(400).json({ error: 'Falta o catálogo' });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada' });

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
        return res.status(502).json({ error: 'Falha ao chamar Claude', detail: String(err?.message || err) });
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
        return res.status(502).json({ error: 'Claude retornou JSON inválido', raw: text });
    }

    if (!Array.isArray(workflow.modules) || !Array.isArray(workflow.connections)) {
        return res.status(502).json({ error: 'Estrutura do workflow inválida', raw: text });
    }

    return res.status(200).json({
        workflow,
        user: { email: userEmail },
        usage: response.usage,
    });
}
