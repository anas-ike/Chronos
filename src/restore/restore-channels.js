const prisma = require('../database/prisma');
const logger = require('../helpers/logger');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function restoreChannels(guild, backupId, roleRefMap, checkCancel, appendLog) {
    const backupChannels = await prisma.backupChannel.findMany({
        where: { backup_id: backupId },
        orderBy: { position: 'asc' }
    });

    if (backupChannels.length === 0) {
        await appendLog('No channels found in backup to restore.');
        return;
    }

    // 1. Delete existing channels
    await appendLog('Deleting current channels and categories...');
    const currentChannels = guild.channels.cache.values();
    for (const channel of currentChannels) {
        await checkCancel();
        try {
            await channel.delete('ChronosRestore: Clearing before unnuke');
            await delay(150);
        } catch (e) {
            logger.warn(`Could not delete channel ${channel.name}: ${e.message}`, 'RestoreChannels');
        }
    }

    await appendLog(`Creating ${backupChannels.length} channels and categories...`);

    // 2. Separate Categories and Standard Channels
    const categories = backupChannels.filter(c => c.type === 'category');
    const standardChannels = backupChannels.filter(c => c.type !== 'category');
    
    // Maps human-facing Category Name -> New Discord Category ID
    const categoryMap = new Map();

    const processChannel = async (bChannel, parentId = null) => {
        await checkCancel();

        // Translate permission overwrites using the ref map
        const finalOverwrites = [];
        if (bChannel.permission_overwrites && Array.isArray(bChannel.permission_overwrites)) {
            for (const overwrite of bChannel.permission_overwrites) {
                let targetId = overwrite.ref;

                if (overwrite.ref_type === 'role') {
                    // Try to resolve internal ref (e.g. role_1, everyone) -> New Discord Role ID
                    targetId = roleRefMap.get(overwrite.ref);
                }

                if (targetId) {
                    finalOverwrites.push({
                        id: targetId,
                        allow: BigInt(overwrite.allow),
                        deny: BigInt(overwrite.deny)
                    });
                }
            }
        }

        try {
            const channelTypeEnum = getChannelTypeEnum(bChannel.type);
            
            const newChannel = await guild.channels.create({
                name: bChannel.name,
                type: channelTypeEnum,
                parent: parentId,
                topic: bChannel.topic,
                nsfw: bChannel.nsfw,
                rateLimitPerUser: bChannel.slowmode,
                bitrate: bChannel.type === 'voice' && bChannel.bitrate ? bChannel.bitrate : undefined,
                userLimit: bChannel.type === 'voice' && bChannel.user_limit ? bChannel.user_limit : undefined,
                permissionOverwrites: finalOverwrites,
                reason: 'ChronosRestore: Restoration'
            });

            if (bChannel.type === 'category') {
                categoryMap.set(bChannel.name, newChannel.id);
            }

            await delay(400); // Throttling channel creation
        } catch (e) {
            logger.error(`Failed to create channel ${bChannel.name}: ${e.message}`, null, 'RestoreChannels');
            await appendLog(`Failed to create channel ${bChannel.name}.`);
        }
    };

    // 3. Create Categories First
    await appendLog('Creating categories...');
    for (const bCategory of categories) {
        await processChannel(bCategory);
    }

    // 4. Create Standard Channels and link to new Categories
    await appendLog('Creating text/voice/stage channels...');
    for (const bChannel of standardChannels) {
        let newParentId = null;
        if (bChannel.parent_category_name) {
            newParentId = categoryMap.get(bChannel.parent_category_name);
        }
        await processChannel(bChannel, newParentId);
    }

    await appendLog('Channel restoration complete.');
};

function getChannelTypeEnum(typeString) {
    // Discord.js ChannelType Enum Values
    switch(typeString) {
        case 'text': return 0; // GuildText
        case 'voice': return 2; // GuildVoice
        case 'category': return 4; // GuildCategory
        case 'announcement': return 5; // GuildAnnouncement
        case 'stage': return 13; // GuildStageVoice
        case 'forum': return 15; // GuildForum
        default: return 0;
    }
}
