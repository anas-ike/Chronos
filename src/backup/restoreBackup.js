const { Worker } = require('bullmq');
const { redisOptions } = require('../restore/queue');
const prisma = require('../database/prisma');
const logger = require('../helpers/logger');
const discordHelper = require('../helpers/discord');
const createBackup = require('./createBackup');

// Internal restore modules (to be implemented next)
const restoreRoles = require('../restore/restore-roles');
const restoreChannels = require('../restore/restore-channels');
const restoreSettings = require('../restore/restore-settings');

module.exports = function initializeWorker(client) {
    const worker = new Worker('restore-jobs', async (job) => {
        const { jobId, guildId, backupId, scopes } = job.data;
        let jobRecord = await prisma.restoreJob.findUnique({ where: { id: jobId } });

        const appendLog = async (msg) => {
            logger.info(`[Job ${jobId}] ${msg}`, 'RestoreWorker');
            jobRecord = await prisma.restoreJob.update({
                where: { id: jobId },
                data: { log: { push: `[${new Date().toISOString()}] ${msg}` } }
            });
        };

        const checkCancel = async () => {
            const currentJob = await prisma.restoreJob.findUnique({ where: { id: jobId }, select: { cancel_requested: true } });
            if (currentJob && currentJob.cancel_requested) {
                throw new Error('CANCEL_REQUESTED');
            }
        };

        try {
            await prisma.restoreJob.update({ where: { id: jobId }, data: { status: 'running' } });
            await appendLog('Worker picked up job. Starting pre-flight checks...');

            // 1. DATA LAYER SAME-SERVER BINDING CHECK
            const backup = await prisma.backup.findUnique({ where: { id: backupId } });
            if (!backup) throw new Error('Backup record not found.');
            if (backup.guild_id !== guildId) {
                throw new Error('CRITICAL SECURITY HALT: Same-Server Binding violation. Backup does not belong to this guild.');
            }

            // 2. Fetch Guild and verify live permissions
            const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
            if (!guild) throw new Error('Guild not found or bot was kicked.');

            if (!discordHelper.hasAdmin(guild)) {
                throw new Error('Bot is missing Administrator permission. Halting.');
            }
            if (!discordHelper.isBotHighestRole(guild)) {
                throw new Error('Bot role is not at the top of the hierarchy. Halting.');
            }

            await checkCancel();

            // 3. AUTOMATIC PRE-RESTORE SAFETY SNAPSHOT
            await appendLog('Taking pre-restore safety snapshot of current server state...');
            const safetySnapshot = await createBackup(guild, client.user.id, 'pre_unnuke_safety');
            await appendLog(`Safety snapshot secured: ${safetySnapshot.id}`);

            await checkCancel();

            // 4. EXECUTE SCOPES (Order matters: Roles must exist before Channels map overwrites)
            let roleRefMap = new Map(); // Maps backup_local_ref -> new Discord Role ID
            const isAll = scopes.includes('all');

            if (isAll || scopes.includes('roles')) {
                await appendLog('Starting role restoration phase...');
                roleRefMap = await restoreRoles(guild, backupId, checkCancel, appendLog);
            }

            if (isAll || scopes.includes('channels')) {
                await appendLog('Starting channel restoration phase...');
                await restoreChannels(guild, backupId, roleRefMap, checkCancel, appendLog);
            }

            if (isAll || scopes.includes('settings')) {
                await appendLog('Starting settings restoration phase...');
                await restoreSettings(guild, backup, checkCancel, appendLog);
            }

            // TODO: Bans and Members (Re-invite via OAuth) modules would be invoked here.

            // 5. COMPLETION & COOLDOWN APPLICATION
            await appendLog('Restoration completed successfully.');
            
            // Only 'completed' triggers the cooldown timer
            await prisma.restoreJob.update({ 
                where: { id: jobId }, 
                data: { status: 'completed', completed_at: new Date() } 
            });

            await prisma.guild.update({
                where: { id: guildId },
                data: { 
                    unnuke_state: 'idle',
                    last_unnuke_completed_at: new Date() // <--- Timer starts NOW
                }
            });

            // Attempt to notify log channel if configured
            const guildData = await prisma.guild.findUnique({ where: { id: guildId } });
            if (guildData.backup_channel_id) {
                const logChannel = guild.channels.cache.get(guildData.backup_channel_id);
                if (logChannel) {
                    logChannel.send(`✅ **Restoration Complete**\nServer has been successfully restored from backup \`${backupId}\`. The cooldown timer has been activated.`).catch(() => {});
                }
            }

        } catch (error) {
            if (error.message === 'CANCEL_REQUESTED') {
                await appendLog('Job was gracefully cancelled by user.');
                await prisma.restoreJob.update({ where: { id: jobId }, data: { status: 'cancelled', completed_at: new Date() } });
            } else {
                logger.error(`Job ${jobId} failed:`, error, 'RestoreWorker');
                await appendLog(`❌ Job failed: ${error.message}`);
                await prisma.restoreJob.update({ where: { id: jobId }, data: { status: 'failed', completed_at: new Date() } });
            }

            // Reset guild state but DO NOT update last_unnuke_completed_at (no cooldown for failed/cancelled jobs)
            await prisma.guild.update({
                where: { id: guildId },
                data: { unnuke_state: 'idle' }
            });
        }
    }, redisOptions);

    worker.on('error', err => {
        logger.error('BullMQ Worker error:', err, 'RestoreWorker');
    });

    logger.info('Restore Worker daemon initialized and listening for jobs.', 'RestoreWorker');
};
