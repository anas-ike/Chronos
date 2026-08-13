require('dotenv').config();
const { ShardingManager } = require('discord.js');
const path = require('path');

console.log('Starting ChronosRestore Sharding Manager...');

const manager = new ShardingManager(path.join(__dirname, 'bot.js'), {
    token: process.env.BOT_TOKEN,
    totalShards: 'auto', // Automatically calculates required shards based on guild count
    respawn: true       // Restarts shards if they die
});

manager.on('shardCreate', shard => {
    console.log(`[ShardingManager] Launched shard ${shard.id}`);
    
    shard.on('death', process => {
        console.error(`[ShardingManager] Shard ${shard.id} died unexpectedly (PID: ${process.pid})`);
    });
    
    shard.on('disconnect', () => {
        console.warn(`[ShardingManager] Shard ${shard.id} disconnected`);
    });
});

manager.spawn().catch(error => {
    console.error('[ShardingManager] Fatal error spawning shards:', error);
    process.exit(1);
});
