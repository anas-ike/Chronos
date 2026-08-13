require('dotenv').config();
const { ShardingManager } = require('discord.js');
const path = require('path');
const logger = require('./src/helpers/logger');

// Import the Express app (it handles its own app.listen via app.js)
const expressApp = require('./dashboard/app'); 

console.log('Starting ChronosRestore Sharding Manager...');

const manager = new ShardingManager(path.join(__dirname, 'bot.js'), {
    token: process.env.BOT_TOKEN,
    totalShards: 'auto', 
    respawn: true       
});

// Pass the ShardingManager to the Express app so routes can cross-communicate with shards
expressApp.set('shardingManager', manager);

manager.on('shardCreate', shard => {
    logger.info(`[ShardingManager] Launched shard ${shard.id}`, 'Manager');
    
    shard.on('death', process => {
        logger.error(`[ShardingManager] Shard ${shard.id} died unexpectedly (PID: ${process.pid})`, 'Manager');
    });
    
    shard.on('disconnect', () => {
        logger.warn(`[ShardingManager] Shard ${shard.id} disconnected`, 'Manager');
    });
});

manager.spawn().then(() => {
    logger.info('[ShardingManager] All shards spawned successfully.', 'Manager');
}).catch(error => {
    logger.error('[ShardingManager] Fatal error spawning shards:', error, 'Manager');
    process.exit(1);
});
