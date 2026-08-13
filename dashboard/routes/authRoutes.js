const router = require('express').Router();
const passport = require('passport');
const crypto = require('crypto');
const axios = require('axios');
const prisma = require('../../src/database/prisma');

// --- DASHBOARD LOGIN ---
router.get('/discord', passport.authenticate('discord'));
router.get('/discord/callback', passport.authenticate('discord', {
    failureRedirect: '/',
    successRedirect: '/dashboard'
}));
router.get('/logout', (req, res) => {
    req.logout(() => res.redirect('/'));
});

// --- MEMBER RESTORE CONSENT VERIFICATION CALLBACK ---
// Triggered when a user clicks the button from !verify
router.get('/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state) return res.send('Missing parameters.');

    try {
        // 1. Decode and verify the HMAC-signed state
        const stateBase64 = Buffer.from(state, 'base64url').toString('utf-8');
        const stateObj = JSON.parse(stateBase64);
        
        const hmac = crypto.createHmac('sha256', process.env.ENCRYPTION_KEY);
        hmac.update(stateObj.p);
        const expectedSignature = hmac.digest('hex');

        if (expectedSignature !== stateObj.s) return res.status(403).send('Invalid state signature. Link compromised.');

        const payload = JSON.parse(stateObj.p);
        if (Date.now() > payload.exp) return res.status(403).send('This verification link has expired. Generate a new one in the server.');

        const guildId = payload.g;
        const userId = payload.u;

        // 2. Exchange code for OAuth tokens
        const tokenParams = new URLSearchParams({
            client_id: process.env.CLIENT_ID,
            client_secret: process.env.CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: `${process.env.DASHBOARD_URL}/oauth/callback` // MUST match bot's exact generator
        });

        const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', tokenParams, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const tokens = tokenResponse.data;
        const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

        // 3. Encrypt the tokens at rest (AES-256-GCM)
        const encryptToken = (text) => {
            const iv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(process.env.ENCRYPTION_KEY, 'hex'), iv);
            let encrypted = cipher.update(text, 'utf8', 'hex');
            encrypted += cipher.final('hex');
            const authTag = cipher.getAuthTag().toString('hex');
            return `${iv.toString('hex')}:${encrypted}:${authTag}`;
        };

        const encryptedAccess = encryptToken(tokens.access_token);
        const encryptedRefresh = encryptToken(tokens.refresh_token);

        // 4. Save to DB
        await prisma.verifiedUser.upsert({
            where: { guild_id_user_id: { guild_id: guildId, user_id: userId } },
            update: {
                access_token: encryptedAccess,
                refresh_token: encryptedRefresh,
                token_expires_at: expiresAt,
                scopes: tokens.scope,
                verified_at: new Date()
            },
            create: {
                guild_id: guildId,
                user_id: userId,
                access_token: encryptedAccess,
                refresh_token: encryptedRefresh,
                token_expires_at: expiresAt,
                scopes: tokens.scope
            }
        });

        // Optional: Assign the verify_role_id via Discord API if configured in guild settings

        res.send('<h2>Verification Successful!</h2><p>Your account is now linked for restoration. You can close this window and return to Discord.</p>');

    } catch (error) {
        console.error('OAuth Callback Error:', error.response ? error.response.data : error.message);
        res.status(500).send('An error occurred during verification.');
    }
});

module.exports = router;
