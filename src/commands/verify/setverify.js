const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const prisma = require('../../database/prisma');

module.exports = {
    name: 'setverify',
    aliases: ['sv'],
    permissionLevel: 'MANAGE_SERVER',
    expectedArgs: [
        { name: 'channel', type: 'STRING' },
        { name: 'role', type: 'STRING' }
    ],

    async execute(ctx) {
        // 1. Parse arguments using centralized args helper
        const channelArg = ctx.getString('channel');
        const roleArg = ctx.getString('role');

        if (!channelArg || !roleArg) {
            return ctx.reply("Usage: `!setverify <#channel> <@role>`");
        }

        const channelId = require('../../helpers/args').extractChannelId(channelArg);
        const roleId = require('../../helpers/args').extractRoleId(roleArg);

        const targetChannel = ctx.guild.channels.cache.get(channelId);
        const targetRole = ctx.guild.roles.cache.get(roleId);

        if (!targetChannel) return ctx.reply("Invalid channel provided.");
        if (!targetRole) return ctx.reply("Invalid role provided.");

        // 2. Save target config to DB
        await prisma.guild.update({
            where: { id: ctx.guild.id },
            data: { 
                verify_channel_id: targetChannel.id,
                verify_role_id: targetRole.id
            }
        });

        // 3. Post the setup container in the target channel
        const setupEmbed = new EmbedBuilder()
            .setTitle('Verification Panel Setup')
            .setDescription('Choose how you want your verification panel to look.')
            .setColor('#0a0a0a');

        const setupRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('verify_setup_default').setLabel('Use Default Message').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('verify_setup_custom').setLabel('Customize Message').setStyle(ButtonStyle.Primary)
        );

        const setupMessage = await targetChannel.send({ embeds: [setupEmbed], components: [setupRow] });
        await ctx.reply(`Setup initiated in <#${targetChannel.id}>. Please configure it there.`);

        // 4. Collector for the setup buttons in the target channel
        const collector = setupMessage.createMessageComponentCollector({
            filter: i => i.user.id === ctx.author.id,
            time: 300000 // 5 minutes to setup
        });

        const postFinalPanel = async (messageJson, interactionToReply) => {
            // Delete the setup message
            await setupMessage.delete().catch(() => {});
            
            // Build the final persistent row
            const finalRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('global_verify_button') // A global event handler will intercept this for all users
                    .setLabel('Verify Now')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('🔒')
            );

            // Post the final panel
            await targetChannel.send({ embeds: [messageJson], components: [finalRow] });
            
            // Save JSON to DB for persistence/future edits
            await prisma.guild.update({
                where: { id: ctx.guild.id },
                data: { verify_message: messageJson }
            });

            if (interactionToReply.replied || interactionToReply.deferred) {
                await interactionToReply.followUp({ content: 'Verification panel deployed successfully.', ephemeral: true });
            } else {
                await interactionToReply.reply({ content: 'Verification panel deployed successfully.', ephemeral: true });
            }
        };

        collector.on('collect', async (interaction) => {
            if (interaction.customId === 'verify_setup_default') {
                const defaultEmbed = new EmbedBuilder()
                    .setTitle(`Verify in ${ctx.guild.name}`)
                    .setDescription(`Click below to verify. This links your Discord account so you can be automatically restored to this server if it's ever wiped, and doesn't grant the bot any access beyond that.`)
                    .setColor('#0a0a0a')
                    .toJSON();
                
                await postFinalPanel(defaultEmbed, interaction);
            }

            if (interaction.customId === 'verify_setup_custom') {
                // Open a Modal for custom text
                const modal = new ModalBuilder()
                    .setCustomId('verify_custom_modal')
                    .setTitle('Customize Verification Panel');

                const titleInput = new TextInputBuilder().setCustomId('v_title').setLabel('Panel Title').setStyle(TextInputStyle.Short).setValue(`Verify in ${ctx.guild.name}`);
                const descInput = new TextInputBuilder().setCustomId('v_desc').setLabel('Description').setStyle(TextInputStyle.Paragraph).setValue('Click below to verify.');
                const colorInput = new TextInputBuilder().setCustomId('v_color').setLabel('Hex Color (e.g. #0a0a0a)').setStyle(TextInputStyle.Short).setValue('#0a0a0a').setRequired(false);

                modal.addComponents(
                    new ActionRowBuilder().addComponents(titleInput),
                    new ActionRowBuilder().addComponents(descInput),
                    new ActionRowBuilder().addComponents(colorInput)
                );

                await interaction.showModal(modal);

                // Wait for the modal submit
                const submitted = await interaction.awaitModalSubmit({
                    time: 120000,
                    filter: i => i.user.id === ctx.author.id,
                }).catch(() => null);

                if (submitted) {
                    const customEmbed = new EmbedBuilder()
                        .setTitle(submitted.fields.getTextInputValue('v_title'))
                        .setDescription(submitted.fields.getTextInputValue('v_desc'))
                        .setColor(submitted.fields.getTextInputValue('v_color') || '#0a0a0a')
                        .toJSON();

                    await postFinalPanel(customEmbed, submitted);
                }
            }
        });
    }
};
