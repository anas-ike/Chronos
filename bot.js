require('dotenv').config();
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const path = require('path');

// Initialize client with required intents
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildBans,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildWebhooks,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent // Critical for strict prefix commands
    ]
});

// Initialize collections for prefix commands and aliases
client.commands = new Collection();
client.aliases = new Collection();
client.prefix = process.env.DEFAULT_PREFIX || '!';

// Handler Loaders
const loadCommands = require('./src/handlers/commandHandler');
const loadEvents = require('./src/handlers/eventHandler');
const initializeWorker = require('./src/backup/restoreBackup'); // BullMQ worker loader
const loadScheduler = require('./src/handlers/scheduler'); // Background scheduler

async function bootstrap() {
    try {
        // If spawned via ShardingManager, client.shard will be available
        const shardId = client.shard ? client.shard.ids.join(', ') : '0 (No Sharding)';
        console.log(`[Shard ${shardId}] Booting ChronosRestore...`);
        
        // Load core handlers
        // The command handler will recursively read all files in src/commands
        await loadCommands(client, path.join(__dirname, 'src', 'commands'));
        
        // Load event listeners (e.g., ready, guildCreate, interactionCreate)
        await loadEvents(client, path.join(__dirname, 'src', 'events'));
        
        // Boot the BullMQ worker daemon for this process
        initializeWorker(client);
        
        // Initialize the background scheduler for automated backups & OAuth token refresh
        loadScheduler(client);
        
        // Connect to Discord
        await client.login(process.env.BOT_TOKEN);
        console.log(`[Shard ${shardId}] Successfully logged in as ${client.user.tag}`);
    } catch (error) {
        console.error('Fatal error during startup:', error);
        process.exit(1);
    }
}

bootstrap();
