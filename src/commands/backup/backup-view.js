const { EmbedBuilder } = require('discord.js');
const prisma = require('../../database/prisma');

module.exports = {
    name: 'backup-view',
    aliases: ['bview'],
    permissionLevel: 'MANAGE_SERVER',
    expectedArgs: [{ name: 'id', type: 'STRING' }],

    async execute(ctx) {
        const backupId = ctx.getString('id');
        if (!backupId) {
            return ctx.reply('Usage: `!backup-view <Backup_ID>`');
        }

        const backup = await prisma.backup.findFirst({
            where: { id: backupId, guild_id: ctx.guild.id },
            include: {
                _count: { select: { channels: true, roles: true, bans: true } }
            }
        });

        if (!backup) {
            return ctx.reply('❌ Backup not found. Make sure the ID is correct and belongs to this server.');
        }

        // Fetch current live metrics for the Diff
        const currentChannels = ctx.guild.channels.cache.size;
        const currentRoles = ctx.guild.roles.cache.filter(r => !r.managed && r.id !== ctx.guild.id).size;
        let currentBans = 0;
        try {
            const bans = await ctx.guild.bans.fetch();
            currentBans = bans.size;
        } catch (e) { /* Ignore if no ban access */ }
        
        const verifiedMembersCount = await prisma.verifiedUser.count({
            where: { guild_id: ctx.guild.id }
        });

        // Format Diff text
        const diffText = (backupCount, currentCount) => {
            const diff = backupCount - currentCount;
            if (diff === 0) return 'No Change';
            return diff > 0 ? `+${diff}` : `${diff}`;
        };

        const embed = new EmbedBuilder()
            .setTitle(`Backup Details — ${backup.server_name}`)
            .setColor('#0a0a0a')
            .setDescription(`**ID:** \`${backup.id}\`\n**Trigger:** \`${backup.trigger.toUpperCase()}\`\n**Taken:** ${backup.created_at.toUTCString()}`)
            .addFields(
                { 
                    name: 'Channels & Categories', 
                    value: `Backup: **${backup._count.channels}**\nCurrent: ${currentChannels}\nDiff: \`${diffText(backup._count.channels, currentChannels)}\``, 
                    inline: true 
                },
                { 
                    name: 'Roles', 
                    value: `Backup: **${backup._count.roles}**\nCurrent: ${currentRoles}\nDiff: \`${diffText(backup._count.roles, currentRoles)}\``, 
                    inline: true 
                },
                { 
                    name: 'Bans', 
                    value: `Backup: **${backup._count.bans}**\nCurrent: ${currentBans}\nDiff: \`${diffText(backup._count.bans, currentBans)}\``, 
                    inline: true 
                },
                {
                    name: 'Verified Members',
                    value: `Available to Restore: **${verifiedMembersCount}**`,
                    inline: false
                }
            )
            .setFooter({ text: 'Use !unnuke to restore this state.' });

        await ctx.reply({ embeds: [embed] });
    }
};
