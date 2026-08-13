const logger = require('../helpers/logger');

module.exports = {
    name: 'ready',
    once: true,
    async execute(client) {
        logger.info(`ChronosRestore is online and ready as ${client.user.tag}!`);
        
        // Set presence
        client.user.setPresence({
            activities: [{ name: 'Anti-Nuke | !backup-config' }],
            status: 'online',
        });
    },
};
