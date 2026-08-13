module.exports = {
    info(message, context = 'App') {
        console.log(`[${new Date().toISOString()}] [INFO] [${context}] ${message}`);
    },
    warn(message, context = 'App') {
        console.warn(`[${new Date().toISOString()}] [WARN] [${context}] ${message}`);
    },
    error(message, error = null, context = 'App') {
        console.error(`[${new Date().toISOString()}] [ERROR] [${context}] ${message}`);
        if (error) console.error(error);
    }
};
