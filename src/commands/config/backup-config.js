const { ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, ComponentType, EmbedBuilder } = require('discord.js');
const prisma = require('../../database/prisma');

module.exports = {
    name: 'backup-config',
    aliases: ['bconfig', 'config'],
    permissionLevel: 'MANAGE_SERVER',
    expectedArgs: [],
    
    async execute(ctx) {
        // 1. Fetch or create the guild configuration
        let guildConfig = await prisma.guild.upsert({
            where: { id: ctx.guild.id },
            update: {},
            create: {
                id: ctx.guild.id,
                owner_id: ctx.guild.ownerId,
                backup_frequency: 'manual'
            }
        });

        // 2. Build the UI Components
        const buildUI = (config) => {
            const embed = new EmbedBuilder()
                .setTitle(`🛡️ Backup Configuration for ${ctx.guild.name}`)
                .setColor('#0a0a0a')
                .setDescription('Use the menu below to configure your automated backups and logging channels.')
                .addFields(
                    { name: 'Frequency', value: `\`${config.backup_frequency.toUpperCase()}\``, inline: true },
                    { name: 'Log Channel', value: config.backup_channel_id ? `<#${config.backup_channel_id}>` : '`Not Set`', inline: true },
                    { name: 'Verify Channel', value: config.verify_channel_id ? `<#${config.verify_channel_id}>` : '`Not Set`', inline: true }
                )
                .setFooter({ text: 'Changes save automatically.' });

            const row1 = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('select_frequency')
                    .setPlaceholder('Select Backup Frequency...')
                    .addOptions([
                        { label: 'Manual Only', description: 'Backups must be triggered manually.', value: 'manual', emoji: '🖐️' },
                        { label: 'Daily', description: 'Automated backup every 24 hours.', value: 'daily', emoji: '📅' },
                        { label: 'Weekly', description: 'Automated backup every 7 days.', value: 'weekly', emoji: '📆' }
                    ])
            );

            const row2 = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('set_log_channel')
                    .setLabel('Set Log Channel Here')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('📁'),
                new ButtonBuilder()
                    .setCustomId('jump_setverify')
                    .setLabel('Configure Verification')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('✅')
            );

            return { embeds: [embed], components: [row1, row2] };
        };

        // 3. Send the initial interactive message
        const responseMessage = await ctx.reply(buildUI(guildConfig));

        // 4. Create an interaction collector bound to this message
        const collector = responseMessage.createMessageComponentCollector({ 
            filter: i => i.user.id === ctx.author.id, 
            time: 60000 
        });

        collector.on('collect', async (interaction) => {
            if (interaction.customId === 'select_frequency') {
                const newFreq = interaction.values[0];
                guildConfig = await prisma.guild.update({
                    where: { id: ctx.guild.id },
                    data: { backup_frequency: newFreq }
                });
                await interaction.update(buildUI(guildConfig));
            }

            if (interaction.customId === 'set_log_channel') {
                guildConfig = await prisma.guild.update({
                    where: { id: ctx.guild.id },
                    data: { backup_channel_id: ctx.channel.id }
                });
                await interaction.reply({ content: `✅ Log channel bound to <#${ctx.channel.id}>.`, ephemeral: true });
                await responseMessage.edit(buildUI(guildConfig));
            }

            if (interaction.customId === 'jump_setverify') {
                await interaction.reply({ content: 'Use the `!setverify` command to configure the verification panel.', ephemeral: true });
            }
        });

        collector.on('end', () => {
            // Disable components on timeout
            const disabledRow1 = ActionRowBuilder.from(responseMessage.components[0]);
            const disabledRow2 = ActionRowBuilder.from(responseMessage.components[1]);
            disabledRow1.components.forEach(c => c.setDisabled(true));
            disabledRow2.components.forEach(c => c.setDisabled(true));
            responseMessage.edit({ components: [disabledRow1, disabledRow2] }).catch(() => {});
        });
    }
};
