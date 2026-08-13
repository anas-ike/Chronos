const prisma = require('../database/prisma');
const logger = require('../helpers/logger');

module.exports = {
    name: 'guildCreate',
    once: false,
    async execute(guild) {
        try {
            await prisma.guild.upsert({
                where: { id: guild.id },
                update: {}, // Do nothing if it already exists
                create: {
                    id: guild.id,
                    owner_id: guild.ownerId,
                    backup_frequency: 'manual',
                    unnuke_cooldown_hours: 24,
                    unnuke_state: 'idle'
                }
            });
            logger.info(`Joined new guild: ${guild.name} (${guild.id}) - DB provisioned.`);
        } catch (error) {
            logger.error(`Failed to provision DB for new guild ${guild.id}:`, error);
        }
    },
};
