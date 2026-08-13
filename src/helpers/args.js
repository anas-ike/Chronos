module.exports = {
    /**
     * Extracts a specific string argument based on expected command layout.
     * 
     * @param {Array} expectedArgs - Array of objects, e.g., [{name: 'id', type: 'STRING'}]
     * @param {Array} rawArgs - Array of space-separated strings from message content
     * @param {String} argName - The name of the argument to extract
     * @returns {String|null}
     */
    getString(expectedArgs, rawArgs, argName) {
        if (!expectedArgs || !rawArgs || rawArgs.length === 0) return null;
        
        const argIndex = expectedArgs.findIndex(a => a.name === argName);
        if (argIndex === -1 || argIndex >= rawArgs.length) return null;

        const argDef = expectedArgs[argIndex];

        // If it's the last expected argument, it might span multiple words (e.g., a reason or title)
        if (argIndex === expectedArgs.length - 1 && argDef.type === 'STRING') {
            return rawArgs.slice(argIndex).join(' ').trim();
        }

        return rawArgs[argIndex].trim();
    },

    /**
     * Parses a channel mention (<#id>) and returns the raw Snowflake ID.
     */
    extractChannelId(mention) {
        if (!mention) return null;
        const match = mention.match(/^<#(\d+)>$/);
        return match ? match[1] : mention; // Fallback to raw string if it's already an ID
    },

    /**
     * Parses a role mention (<@&id>) and returns the raw Snowflake ID.
     */
    extractRoleId(mention) {
        if (!mention) return null;
        const match = mention.match(/^<@&(\d+)>$/);
        return match ? match[1] : mention; // Fallback to raw string if it's already an ID
    }
};
