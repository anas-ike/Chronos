const router = require('express').Router();
const prisma = require('../../src/database/prisma');
const createBackup = require('../../src/backup/createBackup'); // Internal Bot Engine

// Middleware to check if logged in
const isAuth = (req, res, next) => req.isAuthenticated() ? next() : res.redirect('/');

// Utility: Check if user has MANAGE_GUILD (0x20)
const hasManageGuild = (permissions) => (BigInt(permissions) & BigInt(0x20)) === BigInt(0x20);

// --- MARKETING / SPAWN PAGE ---
router.get('/', (req, res) => {
    res.render('index', { 
        user: req.user,
        commands: [
            { name: '!backup', desc: 'Trigger a manual backup.' },
            { name: '!backup-list', desc: 'View all saved backups.' },
            { name: '!unnuke', desc: 'Owner only: Initiate the restoration engine.' },
            { name: '!verify', desc: 'Generates a secure OAuth link for members.' }
        ]
    });
});

// --- SERVER SELECTOR ---
router.get('/dashboard', isAuth, async (req, res) => {
    // Filter user's guilds to only those where they have MANAGE_GUILD
    const managedGuilds = req.user.guilds.filter(g => hasManageGuild(g.permissions));
    
    // Fetch bot's database rows to see which of these servers the bot is actually in
    const botGuildIds = (await prisma.guild.findMany({ select: { id: true } })).map(g => g.id);

    const readyGuilds = managedGuilds.filter(g => botGuildIds.includes(g.id));
    const pendingGuilds = managedGuilds.filter(g => !botGuildIds.includes(g.id));

    res.render('dashboard/selector', { user: req.user, readyGuilds, pendingGuilds });
});

// --- SERVER VIEW ---
router.get('/dashboard/:guildId', isAuth, async (req, res) => {
    const { guildId } = req.params;
    
    // Server-Side Authorization Check
    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild || !hasManageGuild(userGuild.permissions)) {
        return res.status(403).send('Unauthorized. You lack MANAGE_GUILD permissions.');
    }

    const guildData = await prisma.guild.findUnique({ where: { id: guildId } });
    if (!guildData) return res.redirect('/dashboard');

    const backups = await prisma.backup.findMany({ 
        where: { guild_id: guildId },
        orderBy: { created_at: 'desc' }
    });
    
    const verifiedCount = await prisma.verifiedUser.count({ where: { guild_id: guildId } });

    res.render('dashboard/server', { 
        user: req.user, 
        userGuild, 
        guildData, 
        backups,
        verifiedCount,
        isOwner: userGuild.owner // Used to conditionally render the "Create Backup" button
    });
});

// --- DASHBOARD API: TRIGGER BACKUP ---
router.post('/api/dashboard/:guildId/backup', isAuth, async (req, res) => {
    const { guildId } = req.params;
    
    // Server-Side Strict Owner Check
    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild || !userGuild.owner) {
        return res.status(403).json({ error: 'Only the server owner can trigger backups from the dashboard.' });
    }

    try {
        // We must fetch the actual Discord.js Guild object from the bot client
        const client = req.app.get('discordClient'); // Assume we attach client to app in main bot file
        const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId);
        
        if (!guild) return res.status(404).json({ error: 'Bot is not in this server.' });

        // Reuse the exact same engine the bot command uses
        const backupData = await createBackup(guild, req.user.id, 'manual');
        
        res.json({ success: true, backup: backupData });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
