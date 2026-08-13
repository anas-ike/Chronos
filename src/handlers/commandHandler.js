const fs = require('fs');
const path = require('path');
const permissionsCheck = require('../helpers/permissions');
const argsHelper = require('../helpers/args');

module.exports = async (client, commandsPath) => {
    // 1. Recursively load command files
    const loadDir = (dir) => {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);
            
            if (stat.isDirectory()) {
                loadDir(fullPath);
            } else if (file.endsWith('.js')) {
                const command = require(fullPath);
                
                if (command.name && command.execute) {
                    client.commands.set(command.name, command);
                    
                    if (command.aliases && Array.isArray(command.aliases)) {
                        command.aliases.forEach(alias => {
                            client.aliases.set(alias, command.name);
                        });
                    }
                } else {
                    console.warn(`[WARNING] Command at ${fullPath} is missing required 'name' or 'execute' properties.`);
                }
            }
        }
    };

    loadDir(commandsPath);
    console.log(`Loaded ${client.commands.size} prefix commands.`);

    // 2. Centralized Message Execution Pipeline
    client.on('messageCreate', async (message) => {
        // Ignore bots and webhooks
        if (message.author.bot || !message.guild) return;

        // Ensure the message starts with the prefix
        if (!message.content.startsWith(client.prefix)) return;

        // Parse command name and raw arguments
        const rawArgs = message.content.slice(client.prefix.length).trim().split(/ +/);
        const commandName = rawArgs.shift().toLowerCase();

        // Resolve command by name or alias
        const command = client.commands.get(commandName) || client.commands.get(client.aliases.get(commandName));
        if (!command) return;

        // 3. Global Permission Enforcement
        if (command.permissionLevel) {
            const hasPermission = await permissionsCheck.check(command.permissionLevel, message.member, message.guild);
            if (!hasPermission) {
                return message.reply(`You lack the required permission (\`${command.permissionLevel}\`) to use this command.`);
            }
        }

        // 4. Construct unified execution context (ctx)
        const ctx = {
            message,
            member: message.member,
            guild: message.guild,
            channel: message.channel,
            author: message.author,
            ephemeralSupported: false,
            _deferredMessage: null,

            async reply(payload) {
                return message.reply(payload);
            },

            async deferReply() {
                // Simulates interaction.deferReply() by sending a placeholder
                this._deferredMessage = await message.reply("Working on it...");
                return this._deferredMessage;
            },

            async editReply(payload) {
                // If deferred, edit the placeholder. Otherwise, fallback to a standard reply.
                if (this._deferredMessage) {
                    return this._deferredMessage.edit(payload);
                }
                return message.reply(payload);
            },

            getString(argName) {
                // Delegates argument parsing (mentions, quoted strings, etc.) to args helper
                return argsHelper.getString(command.expectedArgs, rawArgs, argName);
            }
        };

        // 5. Execute command
        try {
            await command.execute(ctx);
        } catch (error) {
            console.error(`Error executing command ${command.name}:`, error);
            ctx.reply("An unexpected error occurred while processing this command.").catch(console.error);
        }
    });
};
