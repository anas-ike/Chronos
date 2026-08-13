const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const prisma = require('../../database/prisma');
const logger = require('../../helpers/logger');

// In-memory cooldown map for deletions (resets on bot restart)
const deleteCooldowns = new Map();

module.exports = {
    name: 'backup-delete',
    aliases: ['bdel'],
    permissionLevel: 'OWNER', // STRICTLY Owner only. Not Administrator.
    expectedArgs: [{ name: 'id', type: 'STRING' }],

    async execute(ctx) {
        const backupId = ctx.getString('id');
        if (!backupId) {
            return ctx.reply('Usage: `!backup-delete <Backup_ID>`');
        }

        // 1. Check strict 10-minute cooldown
        const lastDelete = deleteCooldowns.get(ctx.guild.id);
        if (lastDelete && Date.now() - lastDelete < 10 * 60 * 1000) {
            const minsLeft = Math.ceil((10 * 60 * 1000 - (Date.now() - lastDelete)) / 60000);
            return ctx.reply(`⏳ For safety, you can only delete one backup every 10 minutes. Please wait ${minsLeft} minutes.`);
        }

        // 2. Validate backup exists
        const backup = await prisma.backup.findFirst({
            where: { id: backupId, guild_id: ctx.guild.id }
        });

        if (!backup) {
            return ctx.reply('❌ Backup not found. Make sure the ID is correct and belongs to this server.');
        }

        // 3. Render protective warning UI with a gateway button for the modal
        const embed = new EmbedBuilder()
            .setTitle('⚠️ IRREVERSIBLE ACTION: Delete Backup')
            .setColor('#ff0000')
            .setDescription(`You are about to permanently delete the backup from **${backup.created_at.toUTCString()}**.\n\nChronosRestore relies on these backups to protect you. If a malicious admin convinced you to do this, **stop now**.\n\nTo proceed, click the button below and type the server name or backup ID.`);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`confirm_del_${backup.id}`)
                .setLabel('Proceed to Confirmation')
                .setStyle(ButtonStyle.Danger)
        );

        const responseMessage = await ctx.reply({ embeds: [embed], components: [row] });

        // 4. Collector for the gateway button
        const collector = responseMessage.createMessageComponentCollector({
            filter: i => i.user.id === ctx.author.id && i.customId === `confirm_del_${backup.id}`,
            time: 60000
        });

        collector.on('collect', async (interaction) => {
            // Build typed confirmation modal
            const modal = new ModalBuilder()
                .setCustomId(`modal_del_${backup.id}`)
                .setTitle('Confirm Deletion');

            const confirmInput = new TextInputBuilder()
                .setCustomId('confirm_text')
                .setLabel(`Type "${ctx.guild.name}" to confirm`)
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(confirmInput));

            // Show the modal
            await interaction.showModal(modal);

            // Wait for user to submit the modal
            try {
                const submitted = await interaction.awaitModalSubmit({
                    time: 60000,
                    filter: i => i.user.id === ctx.author.id && i.customId === `modal_del_${backup.id}`
                });

                const userInput = submitted.fields.getTextInputValue('confirm_text').trim();

                // Validate typed input
                if (userInput !== ctx.guild.name && userInput !== backup.id) {
                    return submitted.reply({ content: '❌ Confirmation failed. The typed text did not match the server name or backup ID. Deletion cancelled.', ephemeral: true });
                }

                // 5. Execution
                await prisma.backup.delete({ where: { id: backup.id } });
                deleteCooldowns.set(ctx.guild.id, Date.now()); // Set cooldown timer

                logger.warn(`Owner ${ctx.author.id} permanently deleted backup ${backup.id} for guild ${ctx.guild.id}.`, 'BackupEngine');

                await submitted.reply({ content: `✅ Backup \`${backup.id}\` has been permanently deleted.`, ephemeral: true });
                
                // Disable the original button
                const disabledRow = ActionRowBuilder.from(responseMessage.components[0]);
                disabledRow.components.forEach(c => c.setDisabled(true));
                await responseMessage.edit({ components: [disabledRow] }).catch(() => {});

            } catch (err) {
                // Modal timed out
                logger.warn('Backup deletion modal timed out.', 'BackupEngine');
            }
        });

        collector.on('end', () => {
            const disabledRow = ActionRowBuilder.from(responseMessage.components[0]);
            disabledRow.components.forEach(c => c.setDisabled(true));
            responseMessage.edit({ components: [disabledRow] }).catch(() => {});
        });
    }
};
