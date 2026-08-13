const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const prisma = require('../../database/prisma');
const discordHelper = require('../../helpers/discord');
const { restoreQueue } = require('../../restore/queue');
const logger = require('../../helpers/logger');

module.exports = {
    name: 'unnuke',
    aliases: ['restore'],
    permissionLevel: 'OWNER',
    expectedArgs: [],

    async execute(ctx) {
        // 1. Pre-flight Safety Checks
        if (!discordHelper.hasAdmin(ctx.guild)) {
            return ctx.reply('⚠️ **Critical Warning**: The bot lacks the `Administrator` permission. Restores will fail. Grant it and try again.');
        }

        if (!discordHelper.isBotHighestRole(ctx.guild)) {
            return ctx.reply('⚠️ **Role Hierarchy Error**: The bot\'s role is not at the top of the list. Move the ChronosRestore role above all other roles before restoring.');
        }

        // 2. Owner Cryptographic Verification Check
        // We query the DB, NEVER live Discord roles, because a nuke might have deleted the role itself.
        const ownerVerified = await prisma.verifiedUser.findUnique({
            where: {
                guild_id_user_id: {
                    guild_id: ctx.guild.id,
                    user_id: ctx.author.id
                }
            }
        });

        if (!ownerVerified || ownerVerified.token_expires_at < new Date()) {
            return ctx.reply('⛔ **Access Denied**: Server Owner must be fully verified via `!verify` before initiating a restore. Your OAuth token is missing or expired.');
        }

        // 3. State Machine & Cooldown Checks
        const guildData = await prisma.guild.findUnique({ where: { id: ctx.guild.id } });
        if (guildData.unnuke_state === 'in_progress') {
            return ctx.reply('⏳ A restoration job is currently in progress for this server. Please wait for it to complete.');
        }

        if (guildData.last_unnuke_completed_at) {
            const msSinceLast = Date.now() - guildData.last_unnuke_completed_at.getTime();
            const cooldownMs = guildData.unnuke_cooldown_hours * 60 * 60 * 1000;
            
            if (msSinceLast < cooldownMs) {
                const hoursLeft = ((cooldownMs - msSinceLast) / (1000 * 60 * 60)).toFixed(1);
                return ctx.reply(`⛔ **Cooldown Active**: You can only restore this server once every ${guildData.unnuke_cooldown_hours} hours. Please wait ${hoursLeft} hours.`);
            }
        }

        // 4. Fetch Available Backups
        const backups = await prisma.backup.findMany({
            where: { guild_id: ctx.guild.id },
            orderBy: { created_at: 'desc' },
            take: 10
        });

        if (backups.length === 0) {
            return ctx.reply('No backups found to restore from.');
        }

        // 5. Build Initial Selection UI
        const selectOptions = backups.map((b, index) => ({
            label: `Backup #${index + 1} (${b.trigger})`,
            description: b.created_at.toISOString().replace('T', ' ').substring(0, 16),
            value: b.id,
            emoji: b.pinned ? '📌' : '📁'
        }));

        const embed = new EmbedBuilder()
            .setTitle('ChronosRestore — Select Backup')
            .setColor('#0a0a0a')
            .setDescription('Select a backup version below to preview its contents and configure the restore scope.');

        const backupSelectRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('unnuke_backup_select')
                .setPlaceholder('Choose a backup...')
                .addOptions(selectOptions)
        );

        const responseMessage = await ctx.reply({ embeds: [embed], components: [backupSelectRow] });

        // 6. Interactive Session Collector
        const collector = responseMessage.createMessageComponentCollector({
            filter: i => i.user.id === ctx.author.id,
            time: 120000 // 2 minutes to navigate UI
        });

        let selectedBackupId = null;
        let selectedScopes = [];

        collector.on('collect', async (interaction) => {
            
            // --- STAGE A: Backup Selected -> Show Scopes ---
            if (interaction.customId === 'unnuke_backup_select') {
                selectedBackupId = interaction.values[0];
                
                const scopeRow = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId('unnuke_scope_select')
                        .setPlaceholder('Select exactly what to restore...')
                        .setMinValues(1)
                        .setMaxValues(6)
                        .addOptions([
                            { label: 'Unnuke All (Top Priority)', description: 'Restores absolutely everything available.', value: 'all', emoji: '⚠️' },
                            { label: 'Channels & Categories', description: 'Replaces all current channels with the backup.', value: 'channels' },
                            { label: 'Roles', description: 'Replaces all current roles with the backup.', value: 'roles' },
                            { label: 'Server Settings', description: 'Restores icon, banner, name, and config.', value: 'settings' },
                            { label: 'Bans (Re-ban / Unban)', description: 'Syncs ban list to match the backup state.', value: 'bans' },
                            { label: 'Members (Re-invite)', description: 'Pulls back all verified members via OAuth.', value: 'members' }
                        ])
                );

                const actionRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('unnuke_proceed').setLabel('Proceed to Confirmation').setStyle(ButtonStyle.Danger).setDisabled(true),
                    new ButtonBuilder().setCustomId('unnuke_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
                );

                const previewEmbed = new EmbedBuilder()
                    .setTitle('Configure Restoration Scope')
                    .setColor('#ff9900')
                    .setDescription(`Selected Backup: \`${selectedBackupId}\`\n\nChoose what elements you want to restore. Any scope selected will **delete current live assets** in that category and replace them with the backup data.`);

                await interaction.update({ embeds: [previewEmbed], components: [backupSelectRow, scopeRow, actionRow] });
            }

            // --- STAGE B: Scopes Selected -> Enable Proceed Button ---
            if (interaction.customId === 'unnuke_scope_select') {
                selectedScopes = interaction.values;
                // If they picked "all", format UI to reflect it overrides everything else
                if (selectedScopes.includes('all')) {
                    selectedScopes = ['all'];
                }

                // Enable the proceed button now that scopes are chosen
                const scopeRow = ActionRowBuilder.from(interaction.message.components[1]);
                const actionRow = ActionRowBuilder.from(interaction.message.components[2]);
                actionRow.components[0].setDisabled(false);

                const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
                    .spliceFields(0, 1, { name: 'Selected Scope', value: `\`${selectedScopes.join(', ').toUpperCase()}\`` });

                await interaction.update({ embeds: [updatedEmbed], components: [interaction.message.components[0], scopeRow, actionRow] });
            }

            // --- STAGE C: Proceed Clicked -> Open Typed Modal ---
            if (interaction.customId === 'unnuke_proceed') {
                const modal = new ModalBuilder()
                    .setCustomId(`modal_unnuke_${selectedBackupId}`)
                    .setTitle('Final Confirmation');

                const confirmInput = new TextInputBuilder()
                    .setCustomId('confirm_text')
                    .setLabel(`Type "CONFIRM" or "${ctx.guild.name}"`)
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);

                modal.addComponents(new ActionRowBuilder().addComponents(confirmInput));

                await interaction.showModal(modal);

                try {
                    const submitted = await interaction.awaitModalSubmit({
                        time: 60000,
                        filter: i => i.user.id === ctx.author.id && i.customId === `modal_unnuke_${selectedBackupId}`
                    });

                    const userInput = submitted.fields.getTextInputValue('confirm_text').trim();
                    if (userInput !== 'CONFIRM' && userInput !== ctx.guild.name) {
                        return submitted.reply({ content: '❌ Typed confirmation failed. Unnuke cancelled.', ephemeral: true });
                    }

                    // --- STAGE D: Validation Passed -> Queue Job ---
                    
                    // Create Job Record
                    const jobRecord = await prisma.restoreJob.create({
                        data: {
                            guild_id: ctx.guild.id,
                            backup_id: selectedBackupId,
                            requested_by: ctx.author.id,
                            scope: selectedScopes,
                            status: 'queued',
                            log: ['Job queued in background worker...']
                        }
                    });

                    // Lock guild state
                    await prisma.guild.update({
                        where: { id: ctx.guild.id },
                        data: { unnuke_state: 'in_progress', last_unnuke_started_at: new Date() }
                    });

                    // Dispatch to BullMQ
                    await restoreQueue.add('execute-restore', {
                        jobId: jobRecord.id,
                        guildId: ctx.guild.id,
                        backupId: selectedBackupId,
                        scopes: selectedScopes
                    }, { jobId: jobRecord.id });

                    logger.info(`Unnuke job ${jobRecord.id} queued for guild ${ctx.guild.id}`, 'Unnuke');

                    // Post Tracking UI
                    const trackingEmbed = new EmbedBuilder()
                        .setTitle('🛠️ Restoration Initiated')
                        .setColor('#ff0000')
                        .setDescription('The restoration process has been handed off to the background worker to bypass Discord\'s time limits. This may take several minutes depending on server size.')
                        .addFields(
                            { name: 'Job ID', value: `\`${jobRecord.id}\``, inline: true },
                            { name: 'Scope', value: `\`${selectedScopes.join(', ')}\``, inline: true }
                        )
                        .setFooter({ text: 'You can monitor live progress on the dashboard.' });

                    await submitted.reply({ embeds: [trackingEmbed] });
                    
                    // Kill the original menu
                    await responseMessage.delete().catch(() => {});
                    collector.stop();

                } catch (err) {
                    logger.warn('Unnuke confirmation modal timed out.', 'Unnuke');
                }
            }

            if (interaction.customId === 'unnuke_cancel') {
                await interaction.update({ content: '❌ Restoration cancelled.', embeds: [], components: [] });
                collector.stop();
            }
        });

        collector.on('end', (collected, reason) => {
            if (reason === 'time') {
                responseMessage.edit({ content: '⏱️ Menu timed out.', embeds: [], components: [] }).catch(() => {});
            }
        });
    }
};
