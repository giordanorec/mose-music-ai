import type { VercelRequest, VercelResponse } from '@vercel/node';

export default function handler(_req: VercelRequest, res: VercelResponse) {
    res.setHeader('cache-control', 'public, max-age=60');
    res.status(200).json({
        googleClientId: process.env.GOOGLE_CLIENT_ID || '',
        allowedEmails: (process.env.ALLOWED_EMAILS || 'grec@cin.ufpe.br,giordanorec@gmail.com')
            .split(',').map(e => e.trim().toLowerCase()).filter(Boolean),
    });
}
