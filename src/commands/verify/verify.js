const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const prisma = require('../../database/prisma');
const oauthHelper = require('../../helpers/oauth');

module.exports = {
    name: 'verify',
    aliases: ['v'],
    permissionLevel: null, // Public command
    expectedArgs: [],

    async execute(ctx) {
        // 1. Check if they are already verified in the database
        const existingRecord = await prisma.verifiedUser.findUnique({
            where: {
                guild_id_user_id: {
                    guild_id: ctx.guild.id,
                    user_id: ctx.author.id
                }
            }
        });

        if (existingRecord && existingRecord.token_expires_at > new Date()) {
            return ctx.reply("You're already verified in this server. Your backup access is secured.");
        }

        // 2. Build the standard UI container
        const embed = new EmbedBuilder()
            .setTitle(`Verify in ${ctx.guild.name}`)
            .setDescription(`Click below to verify. This links your Discord account so you can be automatically restored to this server if it's ever wiped, and doesn't grant the bot any access beyond that.`)
            .setColor('#0a0a0a');

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('generate_oauth_link') // The event handler will catch this customId
                .setLabel('Verify Now')
                .setStyle(ButtonStyle.Success)
                .setEmoji('🔒')
        );

        // 3. Send via prefix. The button click (Interaction) will provide the actual ephemeral link.
        const responseMessage = await ctx.reply({ embeds: [embed], components: [row] });

        // Setup an inline collector purely for this specific message instance to handle the button click
        const collector = responseMessage.createMessageComponentCollector({
            filter: i => i.user.id === ctx.author.id,
            time: 60000
        });

        collector.on('collect', async (interaction) => {
            if (interaction.customId === 'generate_oauth_link') {
                // Check abuse guard
                const timeLeft = oauthHelper.checkCooldown(ctx.author.id);
                if (timeLeft > 0) {
                    return interaction.reply({ 
                        content: `Please wait ${timeLeft} seconds before generating another link.`, 
                        ephemeral: true 
                    });
                }

                // Generate signed URL
                const signedUrl = oauthHelper.generateSignedUrl(ctx.guild.id, ctx.author.id);
                
                const linkRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setLabel('Click to Authenticate')
                        .setStyle(ButtonStyle.Link)
                        .setURL(signedUrl)
                );

                await interaction.reply({ 
                    content: 'Here is your unique, single-use verification link. It expires in 10 minutes.', 
                    components: [linkRow], 
                    ephemeral: true 
                });
            }
        });

        collector.on('end', () => {
            // Disable button after 60s to prevent old messages cluttering chat with active buttons
            const disabledRow = ActionRowBuilder.from(responseMessage.components[0]);
            disabledRow.components.forEach(c => c.setDisabled(true));
            responseMessage.edit({ components: [disabledRow] }).catch(() => {});
        });
    }
};
