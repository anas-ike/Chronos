const crypto = require('crypto');

module.exports = {
    /**
     * Generates a single-use, HMAC-signed OAuth URL valid for 10 minutes.
     */
    generateSignedUrl(guildId, userId) {
        const clientId = process.env.CLIENT_ID;
        const redirectUri = encodeURIComponent(`${process.env.DASHBOARD_URL}/oauth/callback`);
        
        // 10-minute expiry
        const expiresAt = Date.now() + 10 * 60 * 1000;
        const payload = JSON.stringify({ g: guildId, u: userId, exp: expiresAt });
        
        // Sign the payload
        const hmac = crypto.createHmac('sha256', process.env.ENCRYPTION_KEY);
        hmac.update(payload);
        const signature = hmac.digest('hex');
        
        // Base64Url encode the combined state object
        const stateObj = JSON.stringify({ p: payload, s: signature });
        const stateBase64 = Buffer.from(stateObj).toString('base64url');
        
        return `https://discord.com/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=identify+guilds.join&state=${stateBase64}`;
    },

    /**
     * Abuse Guard: 10-second cooldown memory map
     */
    cooldowns: new Map(),

    checkCooldown(userId) {
        const now = Date.now();
        const lastGenerated = this.cooldowns.get(userId);
        
        if (lastGenerated && now - lastGenerated < 10000) {
            return Math.ceil((10000 - (now - lastGenerated)) / 1000); // Returns seconds left
        }
        
        this.cooldowns.set(userId, now);
        return 0; // No cooldown
    }
};
