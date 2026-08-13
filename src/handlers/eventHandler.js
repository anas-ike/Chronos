const fs = require('fs');
const path = require('path');

module.exports = async (client, eventsPath) => {
    if (!fs.existsSync(eventsPath)) {
        console.warn(`[WARNING] Events directory at ${eventsPath} does not exist.`);
        return;
    }

    const loadDir = (dir) => {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                loadDir(fullPath);
            } else if (file.endsWith('.js')) {
                const event = require(fullPath);

                if (event.name && typeof event.execute === 'function') {
                    if (event.once) {
                        client.once(event.name, (...args) => event.execute(...args, client));
                    } else {
                        client.on(event.name, (...args) => event.execute(...args, client));
                    }
                } else {
                    console.warn(`[WARNING] Event file at ${fullPath} is missing 'name' or 'execute' function.`);
                }
            }
        }
    };

    loadDir(eventsPath);
    console.log('Event handler loaded successfully.');
};
