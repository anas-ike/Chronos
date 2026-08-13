const { EmbedBuilder } = require('discord.js');
const prisma = require('../../database/prisma');
const createBackup = require('../../backup/createBackup');
const discordHelper = require('../../helpers/discord');

module.exports = {
    name: 'backup',
    aliases: ['b'],
    permissionLevel: 'MANAGE_SERVER',
    expectedArgs: [],

    async execute(ctx) {
        // 1. Safety Pre-flight
        if (!discordHelper.hasAdmin(ctx.guild)) {
            return ctx.reply('⚠️ **Critical Warning**: The bot does not have the `Administrator` permission. Backups and Restores require this to function without silent failures. Please grant it and try again.');
        }

        // 2. Cooldown check: 24 hours between manual backups
        const lastManualBackup = await prisma.backup.findFirst({
            where: { 
                guild_id: ctx.guild.id, 
                trigger: 'manual' 
            },
            orderBy: { created_at: 'desc' }
        });

        if (lastManualBackup) {
            const msSinceLast = Date.now() - lastManualBackup.created_at.getTime();
            const cooldownMs = 24 * 60 * 60 * 1000;
            
            if (msSinceLast < cooldownMs) {
                const hoursLeft = ((cooldownMs - msSinceLast) / (1000 * 60 * 60)).toFixed(1);
                return ctx.reply(`⏳ A manual backup was already taken recently. Please wait ${hoursLeft} hours before taking another one, or wait for the automated schedule.`);
            }
        }

        // 3. Defer reply (Backup can take several seconds to a minute on large servers)
        await ctx.deferReply();

        try {
            // 4. Run the backup engine
            const backupData = await createBackup(ctx.guild, ctx.author.id, 'manual');

            // 5. Fetch verified member count for the summary
            const verifiedCount = await prisma.verifiedUser.count({
                where: { guild_id: ctx.guild.id }
            });

            const banCount = await prisma.backupBan.count({
                where: { backup_id: backupData.id }
            });

            // 6. Output Summary Embed
            const embed = new EmbedBuilder()
                .setTitle('ChronosRestore — Backup Complete')
                .setColor('#0a0a0a')
                .setDescription(`A new snapshot of **${ctx.guild.name}** was saved successfully.`)
                .addFields(
                    { name: 'Channels & Categories', value: `${backupData.channelCount}`, inline: true },
                    { name: 'Roles', value: `${backupData.roleCount}`, inline: true },
                    { name: 'Bans', value: `${banCount}`, inline: true },
                    { name: 'Verified Members Captured', value: `${verifiedCount}`, inline: true },
                    { name: 'Backup ID', value: `\`${backupData.id}\``, inline: false }
                )
                .setFooter({ text: `Taken ${new Date().toUTCString()}` });

            await ctx.editReply({ content: null, embeds: [embed] });

            // Optional: Post to log channel if configured
            const guildConfig = await prisma.guild.findUnique({ where: { id: ctx.guild.id } });
            if (guildConfig && guildConfig.backup_channel_id) {
                const logChannel = ctx.guild.channels.cache.get(guildConfig.backup_channel_id);
                if (logChannel) {
                    await logChannel.send({ embeds: [embed] }).catch(() => {});
                }
            }
            
        } catch (error) {
            console.error('Backup generation failed:', error);
            await ctx.editReply({ content: '❌ A critical error occurred while generating the backup. Check bot logs.' });
        }
    }
};
