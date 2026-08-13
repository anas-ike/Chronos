const { PermissionsBitField } = require('discord.js');

module.exports = {
    /**
     * Checks if a member has the required permission level to execute a command.
     * 
     * @param {String} permissionLevel - 'OWNER', 'ADMINISTRATOR', 'MANAGE_SERVER', or null
     * @param {GuildMember} member - The member executing the command
     * @param {Guild} guild - The guild where the command was executed
     * @returns {Boolean}
     */
    async check(permissionLevel, member, guild) {
        if (!member || !guild) return false;
        
        // The server owner fundamentally bypasses all checks
        if (member.id === guild.ownerId) return true;

        switch (permissionLevel) {
            case 'OWNER':
                return member.id === guild.ownerId; // Strict check
            case 'ADMINISTRATOR':
                return member.permissions.has(PermissionsBitField.Flags.Administrator);
            case 'MANAGE_SERVER':
                return member.permissions.has(PermissionsBitField.Flags.ManageGuild) || 
                       member.permissions.has(PermissionsBitField.Flags.Administrator);
            default:
                // Public command (no permission level specified)
                return true;
        }
    }
};
