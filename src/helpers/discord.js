const { PermissionsBitField } = require('discord.js');

module.exports = {
    /**
     * Checks if the bot itself has the Administrator permission.
     * Restores will fail unpredictably without this.
     */
    hasAdmin(guild) {
        if (!guild || !guild.members.me) return false;
        return guild.members.me.permissions.has(PermissionsBitField.Flags.Administrator);
    },

    /**
     * Verifies the bot's highest role is physically above the target role in the hierarchy.
     */
    isBotRoleAbove(guild, targetRoleId) {
        if (!guild || !guild.members.me) return false;
        
        const targetRole = guild.roles.cache.get(targetRoleId);
        if (!targetRole) return false; // If role doesn't exist, it's a non-issue
        
        return guild.members.me.roles.highest.position > targetRole.position;
    },
    
    /**
     * Checks if the bot's highest role is above ALL roles it needs to manage.
     */
    isBotHighestRole(guild) {
        if (!guild || !guild.members.me) return false;
        
        const botHighestPos = guild.members.me.roles.highest.position;
        // Check if there are any roles (other than the guild owner's managed roles) higher than the bot
        const higherRoles = guild.roles.cache.filter(role => role.position >= botHighestPos && !role.managed);
        
        // If the only role higher is @everyone (position 0), which shouldn't happen based on the filter, we are good.
        return higherRoles.size === 0;
    }
};
