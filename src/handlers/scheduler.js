const prisma = require('../database/prisma');
const logger = require('../helpers/logger');
const createBackup = require('../backup/createBackup');
const crypto = require('crypto');
const axios = require('axios');

// Cryptography Helpers for OAuth Tokens
const decryptToken = (enc) => {
    try {
        const [ivHex, encryptedHex, authTagHex] = enc.split(':');
        const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(process.env.ENCRYPTION_KEY, 'hex'), Buffer.from(ivHex, 'hex'));
        decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
        let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) {
        return null;
    }
};

const encryptToken = (text) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(process.env.ENCRYPTION_KEY, 'hex'), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${encrypted}:${authTag}`;
};

module.exports = (client) => {
    logger.info('Initializing background scheduler for automated backups and OAuth refresh...', 'Scheduler');

    // =========================================================================
    // 1. AUTOMATED BACKUPS (Runs every 1 hour)
    // =========================================================================
    setInterval(async () => {
        try {
            // Because the bot is sharded, client.guilds.cache ONLY contains the guilds assigned to this specific process.
            // This natively prevents shards from duplicating backups for the same server.
            for (const [guildId, guild] of client.guilds.cache) {
                const guildConfig = await prisma.guild.findUnique({ where: { id: guildId } });
                if (!guildConfig || guildConfig.backup_frequency === 'manual') continue;

                // Check the last 'scheduled' backup to enforce the daily/weekly timing
                const lastScheduledBackup = await prisma.backup.findFirst({
                    where: { guild_id: guildId, trigger: 'scheduled' },
                    orderBy: { created_at: 'desc' }
                });

                const now = Date.now();
                let shouldBackup = false;

                if (!lastScheduledBackup) {
                    shouldBackup = true; // First time
                } else {
                    const msSinceLast = now - lastScheduledBackup.created_at.getTime();
                    
                    if (guildConfig.backup_frequency === 'daily' && msSinceLast >= (24 * 60 * 60 * 1000)) {
                        shouldBackup = true;
                    } else if (guildConfig.backup_frequency === 'weekly' && msSinceLast >= (7 * 24 * 60 * 60 * 1000)) {
                        shouldBackup = true;
                    }
                }

                if (shouldBackup) {
                    logger.info(`Running scheduled (${guildConfig.backup_frequency}) backup for ${guild.name}...`, 'Scheduler');
                    try {
                        const backupData = await createBackup(guild, client.user.id, 'scheduled');
                        
                        // Notify log channel if configured
                        if (guildConfig.backup_channel_id) {
                            const logChannel = guild.channels.cache.get(guildConfig.backup_channel_id);
                            if (logChannel) {
                                logChannel.send(`✅ **Automated Backup Complete**\nA ${guildConfig.backup_frequency} snapshot of the server was successfully stored. (ID: \`${backupData.id}\`)`).catch(() => {});
                            }
                        }
                    } catch (err) {
                        logger.error(`Automated backup failed for ${guild.name}:`, err, 'Scheduler');
                    }
                }
            }
        } catch (error) {
            logger.error('Error in automated backup interval loop:', error, 'Scheduler');
        }
    }, 60 * 60 * 1000); // 1 Hour

    // =========================================================================
    // 2. PROACTIVE OAUTH TOKEN REFRESH (Runs every 12 hours)
    // =========================================================================
    setInterval(async () => {
        try {
            // Find tokens expiring within the next 3 days
            const upcomingExpiryDate = new Date(Date.now() + (3 * 24 * 60 * 60 * 1000));
            
            const usersToRefresh = await prisma.verifiedUser.findMany({
                where: {
                    token_expires_at: {
                        lte: upcomingExpiryDate,
                        gt: new Date() // Skip already fully dead ones (which require manual re-verification)
                    }
                }
            });

            if (usersToRefresh.length === 0) return;
            logger.info(`Found ${usersToRefresh.length} OAuth tokens nearing expiry. Initiating proactive refresh...`, 'Scheduler');

            for (const userRecord of usersToRefresh) {
                const plainRefreshToken = decryptToken(userRecord.refresh_token);
                if (!plainRefreshToken) continue;

                try {
                    const tokenParams = new URLSearchParams({
                        client_id: process.env.CLIENT_ID,
                        client_secret: process.env.CLIENT_SECRET,
                        grant_type: 'refresh_token',
                        refresh_token: plainRefreshToken
                    });

                    const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', tokenParams, {
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                    });

                    const tokens = tokenResponse.data;
                    const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000);
                    
                    const encryptedAccess = encryptToken(tokens.access_token);
                    const encryptedRefresh = encryptToken(tokens.refresh_token);

                    await prisma.verifiedUser.update({
                        where: { id: userRecord.id },
                        data: {
                            access_token: encryptedAccess,
                            refresh_token: encryptedRefresh,
                            token_expires_at: newExpiresAt
                        }
                    });
                } catch (apiErr) {
                    logger.warn(`Failed to refresh token for user ${userRecord.user_id} in guild ${userRecord.guild_id}. They may need to manually re-verify.`, 'Scheduler');
                }
            }
        } catch (error) {
            logger.error('Error in proactive token refresh loop:', error, 'Scheduler');
        }
    }, 12 * 60 * 60 * 1000); // 12 Hours
};
