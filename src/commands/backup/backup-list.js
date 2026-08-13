const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const prisma = require('../../database/prisma');

module.exports = {
    name: 'backup-list',
    aliases: ['blist'],
    permissionLevel: 'MANAGE_SERVER',
    expectedArgs: [],

    async execute(ctx) {
        const backups = await prisma.backup.findMany({
            where: { guild_id: ctx.guild.id },
            orderBy: { created_at: 'desc' },
            take: 10
        });

        if (backups.length === 0) {
            return ctx.reply('No backups found for this server. Use `!backup` to create one.');
        }

        const embed = new EmbedBuilder()
            .setTitle(`Backups for ${ctx.guild.name}`)
            .setColor('#0a0a0a')
            .setDescription('Here are the most recent backups stored. Select one from the menu below to view its details.');

        const selectOptions = [];

        backups.forEach((b, index) => {
            const dateStr = b.created_at.toISOString().replace('T', ' ').substring(0, 16);
            const sizeMb = (b.size_bytes / (1024 * 1024)).toFixed(2);
            const pinStr = b.pinned ? '📌 ' : '';

            embed.addFields({
                name: `${pinStr}${index + 1}. [${b.trigger.toUpperCase()}] ${dateStr}`,
                value: `ID: \`${b.id}\`\nSize: ${sizeMb} MB`,
                inline: false
            });

            selectOptions.push({
                label: `Preview #${index + 1} (${b.trigger})`,
                description: `Date: ${dateStr}`,
                value: b.id,
                emoji: b.pinned ? '📌' : '📁'
            });
        });

        const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('preview_backup_select')
                .setPlaceholder('Select a backup to preview...')
                .addOptions(selectOptions)
        );

        const responseMessage = await ctx.reply({ embeds: [embed], components: [row] });

        // Handle the select menu inline
        const collector = responseMessage.createMessageComponentCollector({
            filter: i => i.user.id === ctx.author.id,
            time: 60000
        });

        collector.on('collect', async (interaction) => {
            if (interaction.customId === 'preview_backup_select') {
                const selectedId = interaction.values[0];
                // Execute the view command programmatically
                const viewCommand = ctx.message.client.commands.get('backup-view');
                if (viewCommand) {
                    await interaction.deferReply({ ephemeral: true });
                    // Mock a context for the programmatic call
                    const mockCtx = {
                        ...ctx,
                        getString: () => selectedId, // Override args to return the selected ID
                        reply: (payload) => interaction.editReply(payload),
                        deferReply: async () => {},
                        editReply: (payload) => interaction.editReply(payload)
                    };
                    await viewCommand.execute(mockCtx);
                }
            }
        });
        
        collector.on('end', () => {
            const disabledRow = ActionRowBuilder.from(responseMessage.components[0]);
            disabledRow.components.forEach(c => c.setDisabled(true));
            responseMessage.edit({ components: [disabledRow] }).catch(() => {});
        });
    }
};
