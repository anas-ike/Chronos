const { ActionRowBuilder, StringSelectMenuBuilder, EmbedBuilder } = require('discord.js');
const prisma = require('../../database/prisma');

module.exports = {
    name: 'backup-schedule',
    aliases: ['bschedule'],
    permissionLevel: 'MANAGE_SERVER',
    expectedArgs: [],
    
    async execute(ctx) {
        let guildConfig = await prisma.guild.findUnique({ where: { id: ctx.guild.id } });
        if (!guildConfig) {
            return ctx.reply('⚠️ Guild configuration not found. Please run `!backup-config` first.');
        }

        const buildUI = (config) => {
            const embed = new EmbedBuilder()
                .setTitle(`⏳ Schedule & Cooldowns for ${ctx.guild.name}`)
                .setColor('#0a0a0a')
                .addFields(
                    { name: 'Auto-Backup Frequency', value: `\`${config.backup_frequency.toUpperCase()}\``, inline: true },
                    { name: 'Unnuke Cooldown', value: `\`${config.unnuke_cooldown_hours} Hours\``, inline: true }
                );

            const row1 = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('select_cooldown')
                    .setPlaceholder('Set Unnuke Cooldown Limit...')
                    .addOptions([
                        { label: '24 Hours (Default)', description: 'Can only restore once per day.', value: '24' },
                        { label: '36 Hours', description: 'Can only restore once per 1.5 days.', value: '36' },
                        { label: '48 Hours', description: 'Can only restore once per 2 days.', value: '48' }
                    ])
            );

            return { embeds: [embed], components: [row1] };
        };

        const responseMessage = await ctx.reply(buildUI(guildConfig));

        const collector = responseMessage.createMessageComponentCollector({ 
            filter: i => i.user.id === ctx.author.id, 
            time: 60000 
        });

        collector.on('collect', async (interaction) => {
            if (interaction.customId === 'select_cooldown') {
                const hours = parseInt(interaction.values[0], 10);
                guildConfig = await prisma.guild.update({
                    where: { id: ctx.guild.id },
                    data: { unnuke_cooldown_hours: hours }
                });
                await interaction.update(buildUI(guildConfig));
            }
        });

        collector.on('end', () => {
            const disabledRow = ActionRowBuilder.from(responseMessage.components[0]);
            disabledRow.components.forEach(c => c.setDisabled(true));
            responseMessage.edit({ components: [disabledRow] }).catch(() => {});
        });
    }
};
