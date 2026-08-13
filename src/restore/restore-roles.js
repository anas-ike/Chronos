const prisma = require('../database/prisma');
const logger = require('../helpers/logger');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function restoreRoles(guild, backupId, checkCancel, appendLog) {
    const roleRefMap = new Map();
    // Default the 'everyone' ref to the current guild ID, as the @everyone role ID is always the guild ID.
    roleRefMap.set('everyone', guild.id);

    const backupRoles = await prisma.backupRole.findMany({
        where: { backup_id: backupId },
        orderBy: { position: 'asc' } // Create bottom-up to minimize position jumping
    });

    if (backupRoles.length === 0) {
        await appendLog('No roles found in backup to restore.');
        return roleRefMap;
    }

    // 1. Delete existing roles (that are deletable)
    await appendLog('Deleting current roles...');
    const currentRoles = guild.roles.cache.filter(r => !r.managed && r.id !== guild.id);
    for (const [id, role] of currentRoles) {
        await checkCancel();
        try {
            await role.delete('ChronosRestore: Clearing before unnuke');
            await delay(100); // Throttling deletion
        } catch (e) {
            logger.warn(`Could not delete role ${role.name}: ${e.message}`, 'RestoreRoles');
        }
    }

    // 2. Create roles from backup
    await appendLog(`Creating ${backupRoles.length} roles from backup...`);
    for (const bRole of backupRoles) {
        await checkCancel();
        try {
            const newRole = await guild.roles.create({
                name: bRole.name,
                color: bRole.color,
                hoist: bRole.hoist,
                mentionable: bRole.mentionable,
                permissions: BigInt(bRole.permissions_bitfield),
                reason: 'ChronosRestore: Restoration',
                // position: setting position directly on create can cause API instability with many roles, 
                // but Discord processes them sequentially if we insert bottom-up.
            });

            // Map the newly created Discord Role ID to the internal backup_local_ref
            roleRefMap.set(bRole.backup_local_ref, newRole.id);
            
            await delay(350); // Strict client-side rate limit throttling (Discord gets angry at burst role creates)
        } catch (e) {
            logger.error(`Failed to create role ${bRole.name}: ${e.message}`, null, 'RestoreRoles');
            await appendLog(`Failed to create role ${bRole.name}.`);
        }
    }

    await appendLog('Role restoration complete.');
    return roleRefMap;
};
