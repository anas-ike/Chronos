const prisma = require('../database/prisma');
const snapshot = require('./snapshot');
const logger = require('../helpers/logger');

module.exports = async function createBackup(guild, takenBy, triggerType = 'manual') {
    logger.info(`Starting ${triggerType} backup for ${guild.name} (${guild.id})`, 'BackupEngine');

    // 1. Enforce FIFO limit (10 backups max per guild, excluding pinned)
    const existingBackups = await prisma.backup.findMany({
        where: { guild_id: guild.id, pinned: false },
        orderBy: { created_at: 'asc' }
    });

    if (existingBackups.length >= 10) {
        const toDeleteCount = (existingBackups.length - 10) + 1;
        const toDelete = existingBackups.slice(0, toDeleteCount);
        for (const backup of toDelete) {
            await prisma.backup.delete({ where: { id: backup.id } });
            logger.info(`FIFO evicted old backup ${backup.id} for guild ${guild.id}`, 'BackupEngine');
        }
    }

    // 2. Snapshot metadata and images
    const iconUrl = await snapshot.saveAsset(guild.iconURL({ size: 4096, extension: 'png' }));
    const bannerUrl = await snapshot.saveAsset(guild.bannerURL({ size: 4096, extension: 'png' }));

    const serverSettings = {
        verificationLevel: guild.verificationLevel,
        explicitContentFilter: guild.explicitContentFilter,
        defaultMessageNotifications: guild.defaultMessageNotifications,
        afkTimeout: guild.afkTimeout,
        preferredLocale: guild.preferredLocale
    };

    // AutoMod Rules
    let automodRules = [];
    if (guild.features.includes('AUTO_MODERATION')) {
        try {
            const rules = await guild.autoModerationRules.fetch();
            automodRules = rules.map(r => ({
                name: r.name,
                eventType: r.eventType,
                triggerType: r.triggerType,
                triggerMetadata: r.triggerMetadata,
                actions: r.actions,
                enabled: r.enabled,
                exemptRoles: r.exemptRoles.map(id => id), // Will map later during restore
                exemptChannels: r.exemptChannels.map(id => id)
            }));
        } catch (e) {
            logger.warn(`Failed to fetch automod rules for ${guild.name}`, 'BackupEngine');
        }
    }

    // 3. Create core backup record
    const backup = await prisma.backup.create({
        data: {
            guild_id: guild.id,
            taken_by: takenBy,
            trigger: triggerType,
            server_name: guild.name,
            server_icon_url: iconUrl,
            server_banner_url: bannerUrl,
            server_settings: serverSettings,
            automod_rules: automodRules,
            size_bytes: 0 // Will calculate at the end
        }
    });

    // 4. Capture Roles (by Position) & Map to internal refs
    const roles = guild.roles.cache.sort((a, b) => a.position - b.position).values();
    const roleIdToRefMap = new Map();
    let roleCounter = 1;
    const backupRolesData = [];

    for (const role of roles) {
        // Skip @everyone (managed natively) and bot managed roles
        if (role.id === guild.id || role.managed) continue;

        const ref = `role_${roleCounter++}`;
        roleIdToRefMap.set(role.id, ref);

        backupRolesData.push({
            backup_id: backup.id,
            backup_local_ref: ref,
            name: role.name,
            color: role.color,
            hoist: role.hoist,
            mentionable: role.mentionable,
            position: role.position,
            permissions_bitfield: role.permissions.bitfield.toString(),
            icon_url: null // Can integrate snapshot.saveAsset(role.iconURL()) later
        });
    }

    if (backupRolesData.length > 0) {
        await prisma.backupRole.createMany({ data: backupRolesData });
    }

    // 5. Capture Channels & Categories
    const channels = guild.channels.cache.sort((a, b) => a.position - b.position).values();
    let channelCounter = 1;
    const backupChannelsData = [];

    for (const channel of channels) {
        // Build overwrites mapping IDs to backup_local_refs
        const overwrites = [];
        for (const [id, overwrite] of channel.permissionOverwrites.cache) {
            const isRole = overwrite.type === 0;
            let ref = id; // Default to ID if member or unknown
            
            if (isRole && id === guild.id) {
                ref = 'everyone';
            } else if (isRole) {
                ref = roleIdToRefMap.get(id) || id;
            }

            overwrites.push({
                ref_type: isRole ? 'role' : 'member',
                ref: ref,
                allow: overwrite.allow.bitfield.toString(),
                deny: overwrite.deny.bitfield.toString()
            });
        }

        const parentCategoryName = channel.parentId ? guild.channels.cache.get(channel.parentId)?.name : null;

        backupChannelsData.push({
            backup_id: backup.id,
            backup_local_ref: `channel_${channelCounter++}`,
            type: resolveChannelType(channel.type),
            name: channel.name,
            position: channel.position,
            parent_category_name: parentCategoryName,
            topic: channel.topic || null,
            nsfw: channel.nsfw || false,
            slowmode: channel.rateLimitPerUser || 0,
            bitrate: channel.bitrate || null,
            user_limit: channel.userLimit || null,
            permission_overwrites: overwrites
        });
    }

    if (backupChannelsData.length > 0) {
        await prisma.backupChannel.createMany({ data: backupChannelsData });
    }

    // 6. Capture Bans
    try {
        const bans = await guild.bans.fetch();
        const backupBansData = bans.map(ban => ({
            backup_id: backup.id,
            user_id: ban.user.id,
            username_tag: ban.user.tag,
            reason: ban.reason || null
        }));

        if (backupBansData.length > 0) {
            await prisma.backupBan.createMany({ data: backupBansData });
        }
    } catch (e) {
        logger.warn(`Could not fetch bans for ${guild.name} (Missing Permission?)`, 'BackupEngine');
    }

    // Determine estimated size (stub, could serialize JSON for true byte count)
    const estSize = (backupRolesData.length * 150) + (backupChannelsData.length * 300) + 1024;
    await prisma.backup.update({ where: { id: backup.id }, data: { size_bytes: estSize } });

    logger.info(`Backup ${backup.id} completed successfully for ${guild.name}`, 'BackupEngine');
    
    return {
        id: backup.id,
        roleCount: backupRolesData.length,
        channelCount: backupChannelsData.length,
        created_at: backup.created_at
    };
};

// Discord.js Channel Type Enums to human readable
function resolveChannelType(type) {
    switch(type) {
        case 0: return 'text';
        case 2: return 'voice';
        case 4: return 'category';
        case 5: return 'announcement';
        case 13: return 'stage';
        case 15: return 'forum';
        default: return 'text';
    }
}
