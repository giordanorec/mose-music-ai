export const config = { runtime: 'nodejs' };

export default async function handler() {
    return new Response(
        JSON.stringify({
            googleClientId: process.env.GOOGLE_CLIENT_ID || '',
            allowedEmails: (process.env.ALLOWED_EMAILS || 'grec@cin.ufpe.br,giordanorec@gmail.com')
                .split(',').map(e => e.trim().toLowerCase()).filter(Boolean),
        }),
        {
            status: 200,
            headers: {
                'content-type': 'application/json',
                'cache-control': 'public, max-age=60',
            },
        }
    );
}
