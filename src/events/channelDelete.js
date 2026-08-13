const prisma = require('../database/prisma');
const logger = require('../helpers/logger');

// Simple rate limiter map to detect mass deletions (nukes)
const deleteCounters = new Map();

module.exports = {
    name: 'channelDelete',
    once: false,
    async execute(channel, client) {
        if (!channel.guild) return;

        const guildId = channel.guild.id;
        const now = Date.now();

        // 1. Get or initialize counter for this guild
        if (!deleteCounters.has(guildId)) {
            deleteCounters.set(guildId, { count: 0, firstDelete: now });
        }

        const stats = deleteCounters.get(guildId);
        stats.count++;

        // Reset counter if more than 10 seconds have passed since the first deletion
        if (now - stats.firstDelete > 10000) {
            stats.count = 1;
            stats.firstDelete = now;
        }

        // 2. Alert on Suspicious Activity (e.g., 4+ channels deleted in 10 seconds)
        if (stats.count === 4) {
            logger.warn(`Potential nuke detected in ${channel.guild.name} (${guildId}). Multiple channels deleted rapidly.`, 'AntiNuke');
            
            try {
                const guildConfig = await prisma.guild.findUnique({ where: { id: guildId } });
                if (guildConfig && guildConfig.backup_channel_id) {
                    const logChannel = channel.guild.channels.cache.get(guildConfig.backup_channel_id);
                    if (logChannel) {
                        logChannel.send('⚠️ **WARNING: Mass channel deletion detected.** If the server is being nuked, use `!unnuke` to restore it.').catch(() => {});
                    }
                }
            } catch (err) {
                // Ignore DB fetch errors during a rapid deletion event
            }
        }
    }
};
