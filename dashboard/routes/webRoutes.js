const router = require('express').Router();
const prisma = require('../../src/database/prisma');
const { restoreQueue } = require('../../src/restore/queue');
const logger = require('../../src/helpers/logger');

// In-memory cooldown map for dashboard backup deletions (10 min per guild)
const deleteCooldowns = new Map();

// Middleware: Require Discord Passport Session
const isAuth = (req, res, next) => {
    if (req.isAuthenticated()) return next();
    res.redirect('/auth/discord');
};

// Permission bitfields: MANAGE_GUILD (0x20) or ADMINISTRATOR (0x8)
const hasManageGuild = (permissions) => {
    const permBigInt = BigInt(permissions);
    return (permBigInt & BigInt(0x20)) === BigInt(0x20) || (permBigInt & BigInt(0x8)) === BigInt(0x8);
};

// ==============================================================================
// 1. MARKETING & LANDING PAGE
// ==============================================================================
router.get('/', (req, res) => {
    const botInviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${process.env.CLIENT_ID}&permissions=8&scope=bot%20applications.commands`;

    const commandList = [
        {
            name: '!verify',
            aliases: ['!v'],
            permission: 'Public',
            description: 'Generates a secure, single-use 10-minute OAuth link for server members to authorize backup re-entry.'
        },
        {
            name: '!setverify <#channel> <@role>',
            aliases: ['!sv'],
            permission: 'Manage Server',
            description: 'Deploys a customizable, persistent verification panel with interactive buttons to automatically link members.'
        },
        {
            name: '!backup',
            aliases: ['!b'],
            permission: 'Manage Server',
            description: 'Triggers an immediate full snapshot of server structure, roles, channels, permissions, bans, settings, and media assets.'
        },
        {
            name: '!backup-list',
            aliases: ['!blist'],
            permission: 'Manage Server',
            description: 'Lists up to 10 stored backups for the server with interactive drop-downs to inspect details and metrics.'
        },
        {
            name: '!backup-view <id>',
            aliases: ['!bview'],
            permission: 'Manage Server',
            description: 'Provides a complete breakdown of a specific backup and calculates a diff against current live server state.'
        },
        {
            name: '!backup-delete <id>',
            aliases: ['!bdel'],
            permission: 'Server Owner',
            description: 'Permanently deletes a backup slot with a strict 10-minute cooldown and modal-based typed confirmation.'
        },
        {
            name: '!backup-config',
            aliases: ['!bconfig'],
            permission: 'Manage Server',
            description: 'Opens an interactive panel to configure automated backup frequency (Manual/Daily/Weekly) and logging channels.'
        },
        {
            name: '!backup-schedule',
            aliases: ['!bschedule'],
            permission: 'Manage Server',
            description: 'Configures auto-backup intervals and adjusts the strict unnuke cooldown limit (24h to 48h).'
        },
        {
            name: '!unnuke',
            aliases: ['!restore'],
            permission: 'Server Owner',
            description: 'Initiates background server restoration. Requires owner OAuth verification, multi-scope selection, and typed confirmation.'
        }
    ];

    res.render('index', {
        user: req.user,
        botInviteUrl,
        commands: commandList,
        dashboardUrl: process.env.DASHBOARD_URL
    });
});

// ==============================================================================
// 2. SERVER SELECTOR
// ==============================================================================
router.get('/dashboard', isAuth, async (req, res) => {
    try {
        // Filter user's guilds to only those where they have MANAGE_GUILD or ADMIN permissions
        const userGuilds = req.user.guilds || [];
        const managedGuilds = userGuilds.filter(g => hasManageGuild(g.permissions));

        // Fetch registered guild IDs from the database
        const botGuildRows = await prisma.guild.findMany({ select: { id: true } });
        const botGuildIds = new Set(botGuildRows.map(g => g.id));

        // Separate servers into ready (bot present) and pending (bot needs to be invited)
        const readyGuilds = managedGuilds.filter(g => botGuildIds.has(g.id));
        const pendingGuilds = managedGuilds.filter(g => !botGuildIds.has(g.id));

        res.render('dashboard/selector', {
            user: req.user,
            readyGuilds,
            pendingGuilds,
            clientId: process.env.CLIENT_ID
        });
    } catch (error) {
        logger.error('Error rendering dashboard selector:', error, 'Dashboard');
        res.status(500).send('Internal Server Error loading dashboard.');
    }
});

// ==============================================================================
// 3. SERVER HOME DASHBOARD
// ==============================================================================
router.get('/dashboard/:guildId', isAuth, async (req, res) => {
    const { guildId } = req.params;

    // Server-Side Authorization Check
    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild || !hasManageGuild(userGuild.permissions)) {
        return res.status(403).send('Unauthorized: You lack Manage Server permissions for this guild.');
    }

    try {
        const guildData = await prisma.guild.findUnique({
            where: { id: guildId }
        });

        if (!guildData) {
            return res.redirect('/dashboard');
        }

        // Fetch backups for this server
        const backups = await prisma.backup.findMany({
            where: { guild_id: guildId },
            orderBy: { created_at: 'desc' }
        });

        // Calculate storage used
        const totalStorageBytes = backups.reduce((acc, b) => acc + (b.size_bytes || 0), 0);
        const storageUsedMb = (totalStorageBytes / (1024 * 1024)).toFixed(2);

        // Fetch verified members count
        const verifiedCount = await prisma.verifiedUser.count({
            where: { guild_id: guildId }
        });

        // Check for active restore job
        const activeRestoreJob = await prisma.restoreJob.findFirst({
            where: {
                guild_id: guildId,
                status: { in: ['queued', 'running'] }
            },
            orderBy: { started_at: 'desc' }
        });

        res.render('dashboard/server', {
            user: req.user,
            userGuild,
            guildData,
            backups,
            storageUsedMb,
            verifiedCount,
            activeRestoreJob,
            isOwner: !!userGuild.owner
        });
    } catch (error) {
        logger.error(`Error loading dashboard for guild ${guildId}:`, error, 'Dashboard');
        res.status(500).send('Error loading server dashboard.');
    }
});

// ==============================================================================
// 4. BACKUP PREVIEW / INSPECTOR PAGE
// ==============================================================================
router.get('/dashboard/:guildId/backup/:backupId', isAuth, async (req, res) => {
    const { guildId, backupId } = req.params;

    // Server-Side Authorization Check
    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild || !hasManageGuild(userGuild.permissions)) {
        return res.status(403).send('Unauthorized: You lack Manage Server permissions.');
    }

    try {
        // Enforce Same-Server Binding at data layer
        const backup = await prisma.backup.findFirst({
            where: { id: backupId, guild_id: guildId },
            include: {
                channels: { orderBy: { position: 'asc' } },
                roles: { orderBy: { position: 'desc' } },
                bans: true
            }
        });

        if (!backup) {
            return res.status(404).send('Backup not found or does not belong to this server.');
        }

        // Organize channels into categories and standalone channels for the preview UI
        const categories = backup.channels.filter(c => c.type === 'category');
        const channelMap = new Map();

        // Initialize category buckets
        categories.forEach(cat => {
            channelMap.set(cat.name, []);
        });
        channelMap.set('Uncategorized', []);

        // Sort channels into their category buckets
        backup.channels.filter(c => c.type !== 'category').forEach(ch => {
            if (ch.parent_category_name && channelMap.has(ch.parent_category_name)) {
                channelMap.get(ch.parent_category_name).push(ch);
            } else {
                channelMap.get('Uncategorized').push(ch);
            }
        });

        res.render('dashboard/backup-preview', {
            user: req.user,
            userGuild,
            backup,
            categories,
            channelMap,
            isOwner: !!userGuild.owner
        });
    } catch (error) {
        logger.error(`Error previewing backup ${backupId}:`, error, 'Dashboard');
        res.status(500).send('Error loading backup preview.');
    }
});

// ==============================================================================
// 5. SERVER SETTINGS PAGE & UPDATE ROUTE
// ==============================================================================
router.get('/dashboard/:guildId/settings', isAuth, async (req, res) => {
    const { guildId } = req.params;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild || !hasManageGuild(userGuild.permissions)) {
        return res.status(403).send('Unauthorized.');
    }

    const guildData = await prisma.guild.findUnique({ where: { id: guildId } });
    if (!guildData) return res.redirect('/dashboard');

    res.render('dashboard/settings', {
        user: req.user,
        userGuild,
        guildData
    });
});

router.post('/dashboard/:guildId/settings', isAuth, async (req, res) => {
    const { guildId } = req.params;
    const { backup_frequency, backup_channel_id, verify_channel_id, verify_role_id, unnuke_cooldown_hours } = req.body;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild || !hasManageGuild(userGuild.permissions)) {
        return res.status(403).send('Unauthorized.');
    }

    try {
        const cooldown = parseInt(unnuke_cooldown_hours, 10);
        const validCooldown = [24, 36, 48].includes(cooldown) ? cooldown : 24;

        await prisma.guild.update({
            where: { id: guildId },
            data: {
                backup_frequency: ['manual', 'daily', 'weekly'].includes(backup_frequency) ? backup_frequency : 'manual',
                backup_channel_id: backup_channel_id ? backup_channel_id.trim() : null,
                verify_channel_id: verify_channel_id ? verify_channel_id.trim() : null,
                verify_role_id: verify_role_id ? verify_role_id.trim() : null,
                unnuke_cooldown_hours: validCooldown
            }
        });

        res.redirect(`/dashboard/${guildId}/settings?success=1`);
    } catch (error) {
        logger.error(`Error updating settings for ${guildId}:`, error, 'Dashboard');
        res.status(500).send('Failed to update settings.');
    }
});

// ==============================================================================
// 6. DASHBOARD API: TRIGGER BACKUP (SHARDING COMPATIBLE)
// ==============================================================================
router.post('/api/dashboard/:guildId/backup', isAuth, async (req, res) => {
    const { guildId } = req.params;

    // Server-Side Strict Owner Check
    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild || !userGuild.owner) {
        return res.status(403).json({ error: 'Only the server owner can trigger manual backups.' });
    }

    // 24-Hour Cooldown Check
    const lastManualBackup = await prisma.backup.findFirst({
        where: { guild_id: guildId, trigger: 'manual' },
        orderBy: { created_at: 'desc' }
    });

    if (lastManualBackup) {
        const msSinceLast = Date.now() - lastManualBackup.created_at.getTime();
        const cooldownMs = 24 * 60 * 60 * 1000;
        if (msSinceLast < cooldownMs) {
            const hoursLeft = ((cooldownMs - msSinceLast) / (1000 * 60 * 60)).toFixed(1);
            return res.status(429).json({ error: `Manual backup cooldown active. Please wait ${hoursLeft} hours.` });
        }
    }

    try {
        const manager = req.app.get('shardingManager');
        if (!manager) {
            return res.status(500).json({ error: 'ShardingManager is not bound to web server.' });
        }

        // broadcastEval delegates backup execution to the specific child shard holding the guild
        const results = await manager.broadcastEval(async (client, context) => {
            const guild = client.guilds.cache.get(context.guildId);
            if (guild) {
                const createBackup = require('./src/backup/createBackup');
                const backupData = await createBackup(guild, context.userId, 'manual');
                return backupData;
            }
            return null;
        }, {
            context: { guildId, userId: req.user.id }
        });

        const backupData = results.find(result => result !== null);

        if (!backupData) {
            return res.status(404).json({ error: 'Guild not found on any shard or bot missing from server.' });
        }

        res.json({ success: true, backup: backupData });
    } catch (error) {
        logger.error(`Dashboard Backup Error for ${guildId}:`, error, 'Dashboard');
        res.status(500).json({ error: error.message || 'Failed to create backup.' });
    }
});

// ==============================================================================
// 7. DASHBOARD API: DELETE BACKUP (OWNER ONLY + TYPED CONFIRMATION)
// ==============================================================================
router.post('/api/dashboard/:guildId/backup/:backupId/delete', isAuth, async (req, res) => {
    const { guildId, backupId } = req.params;
    const { confirmText } = req.body;

    // Strict Owner Check
    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild || !userGuild.owner) {
        return res.status(403).json({ error: 'STRICT ACTION: Only the server owner can delete backups.' });
    }

    // Cooldown Check (1 deletion per 10 mins)
    const lastDelete = deleteCooldowns.get(guildId);
    if (lastDelete && Date.now() - lastDelete < 10 * 60 * 1000) {
        const minsLeft = Math.ceil((10 * 60 * 1000 - (Date.now() - lastDelete)) / 60000);
        return res.status(429).json({ error: `Deletion cooldown active. Please wait ${minsLeft} minutes.` });
    }

    // Verify Backup Exists and Same-Server Binding
    const backup = await prisma.backup.findFirst({
        where: { id: backupId, guild_id: guildId }
    });

    if (!backup) {
        return res.status(404).json({ error: 'Backup not found.' });
    }

    // Typed Confirmation Check
    if (confirmText !== userGuild.name && confirmText !== backup.id) {
        return res.status(400).json({ error: 'Typed confirmation text failed to match server name or backup ID.' });
    }

    try {
        await prisma.backup.delete({ where: { id: backupId } });
        deleteCooldowns.set(guildId, Date.now());

        logger.warn(`Owner ${req.user.id} deleted backup ${backupId} for guild ${guildId} via dashboard.`, 'Dashboard');
        res.json({ success: true, message: 'Backup permanently deleted.' });
    } catch (error) {
        logger.error(`Error deleting backup ${backupId}:`, error, 'Dashboard');
        res.status(500).json({ error: 'Failed to delete backup.' });
    }
});

// ==============================================================================
// 8. DASHBOARD API: TRIGGER UNNUKE RESTORE (OWNER ONLY)
// ==============================================================================
router.post('/api/dashboard/:guildId/restore', isAuth, async (req, res) => {
    const { guildId } = req.params;
    const { backupId, scopes, confirmText } = req.body;

    // Strict Owner Check
    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild || !userGuild.owner) {
        return res.status(403).json({ error: 'RESTRICTED: Only the server owner can initiate a restoration.' });
    }

    // Check Typed Confirmation
    if (confirmText !== 'CONFIRM' && confirmText !== userGuild.name) {
        return res.status(400).json({ error: 'Confirmation string invalid. You must type "CONFIRM" or the server name.' });
    }

    try {
        // Owner Cryptographic Verification Check in DB
        const ownerVerified = await prisma.verifiedUser.findUnique({
            where: {
                guild_id_user_id: { guild_id: guildId, user_id: req.user.id }
            }
        });

        if (!ownerVerified || ownerVerified.token_expires_at < new Date()) {
            return res.status(403).json({ error: 'Access Denied: Server Owner must verify account via !verify command first.' });
        }

        // State Machine and Cooldown Check
        const guildData = await prisma.guild.findUnique({ where: { id: guildId } });
        if (guildData.unnuke_state === 'in_progress') {
            return res.status(409).json({ error: 'A restoration job is currently in progress for this server.' });
        }

        if (guildData.last_unnuke_completed_at) {
            const msSinceLast = Date.now() - guildData.last_unnuke_completed_at.getTime();
            const cooldownMs = guildData.unnuke_cooldown_hours * 60 * 60 * 1000;
            if (msSinceLast < cooldownMs) {
                const hoursLeft = ((cooldownMs - msSinceLast) / (1000 * 60 * 60)).toFixed(1);
                return res.status(429).json({ error: `Cooldown active. Please wait ${hoursLeft} hours.` });
            }
        }

        // Validate Backup Same-Server Binding
        const backup = await prisma.backup.findFirst({
            where: { id: backupId, guild_id: guildId }
        });
        if (!backup) {
            return res.status(404).json({ error: 'Invalid backup selection or Same-Server Binding check failed.' });
        }

        // Create Job Record
        const jobRecord = await prisma.restoreJob.create({
            data: {
                guild_id: guildId,
                backup_id: backupId,
                requested_by: req.user.id,
                scope: Array.isArray(scopes) ? scopes : [scopes],
                status: 'queued',
                log: ['Restoration job queued via Web Dashboard...']
            }
        });

        // Set state to in_progress
        await prisma.guild.update({
            where: { id: guildId },
            data: { unnuke_state: 'in_progress', last_unnuke_started_at: new Date() }
        });

        // Dispatch BullMQ background job
        await restoreQueue.add('execute-restore', {
            jobId: jobRecord.id,
            guildId,
            backupId,
            scopes: Array.isArray(scopes) ? scopes : [scopes]
        }, { jobId: jobRecord.id });

        logger.info(`Unnuke restore job ${jobRecord.id} queued via Dashboard for guild ${guildId}`, 'Dashboard');

        res.json({ success: true, jobId: jobRecord.id });
    } catch (error) {
        logger.error(`Restore trigger error for ${guildId}:`, error, 'Dashboard');
        res.status(500).json({ error: error.message || 'Failed to queue restore job.' });
    }
});

module.exports = router;
