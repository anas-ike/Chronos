const logger = require('../helpers/logger');

module.exports = async function restoreSettings(guild, backupData, checkCancel, appendLog) {
    await appendLog('Restoring server settings...');
    await checkCancel();

    try {
        const settings = backupData.server_settings || {};
        
        await guild.edit({
            name: backupData.server_name,
            verificationLevel: settings.verificationLevel,
            explicitContentFilter: settings.explicitContentFilter,
            defaultMessageNotifications: settings.defaultMessageNotifications,
            afkTimeout: settings.afkTimeout,
            preferredLocale: settings.preferredLocale,
            reason: 'ChronosRestore: Server Settings Restoration'
        });

        // Note: Vanity URL and Boost Perks are not restorable. 
        // We log this for transparency.
        await appendLog('Notice: Icon, Banner, and Vanity URLs require manual intervention or specific boost levels and were skipped in automated API restoration.');

    } catch (e) {
        logger.error(`Failed to restore server settings: ${e.message}`, null, 'RestoreSettings');
        await appendLog(`Failed to restore some server settings: ${e.message}`);
    }

    await appendLog('Settings restoration complete.');
};
