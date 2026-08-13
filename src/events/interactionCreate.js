const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const prisma = require('../database/prisma');
const oauthHelper = require('../helpers/oauth');
const logger = require('../helpers/logger');

module.exports = {
    name: 'interactionCreate',
    once: false,
    async execute(interaction) {
        // Since we explicitly bypass slash commands in this architecture, 
        // we only care about message components and modal submits here.
        if (!interaction.isMessageComponent() && !interaction.isModalSubmit()) return;

        try {
            // ----------------------------------------------------------------
            // GLOBAL VERIFY BUTTON (Deployed by !setverify)
            // ----------------------------------------------------------------
            if (interaction.isButton() && interaction.customId === 'global_verify_button') {
                
                // 1. Check if the user is already actively verified
                const existingRecord = await prisma.verifiedUser.findUnique({
                    where: {
                        guild_id_user_id: {
                            guild_id: interaction.guild.id,
                            user_id: interaction.user.id
                        }
                    }
                });

                if (existingRecord && existingRecord.token_expires_at > new Date()) {
                    return interaction.reply({
                        content: "You're already verified in this server. Your backup access is secured.",
                        ephemeral: true
                    });
                }

                // 2. Enforce the 10-second abuse guard to prevent OAuth link flooding
                const timeLeft = oauthHelper.checkCooldown(interaction.user.id);
                if (timeLeft > 0) {
                    return interaction.reply({ 
                        content: `Please wait ${timeLeft} seconds before generating another link.`, 
                        ephemeral: true 
                    });
                }

                // 3. Generate the signed, single-use OAuth URL
                const signedUrl = oauthHelper.generateSignedUrl(interaction.guild.id, interaction.user.id);
                
                const linkRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setLabel('Click to Authenticate')
                        .setStyle(ButtonStyle.Link)
                        .setURL(signedUrl)
                );

                // 4. Serve the link ephemerally so only the clicking user can see it
                await interaction.reply({ 
                    content: 'Here is your unique, single-use verification link. It expires in 10 minutes.', 
                    components: [linkRow], 
                    ephemeral: true 
                });
            }
            
            // Note: Add any future global component handlers below this line

        } catch (error) {
            logger.error(`Error handling interaction [${interaction.customId}]:`, error);
            
            // Failsafe reply to ensure the Discord API doesn't mark the interaction as failed/hanging
            const errorMessage = { content: 'An error occurred while processing this action.', ephemeral: true };
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(errorMessage).catch(() => {});
            } else {
                await interaction.reply(errorMessage).catch(() => {});
            }
        }
    }
};
