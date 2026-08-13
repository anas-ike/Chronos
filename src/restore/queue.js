const { Queue } = require('bullmq');
const logger = require('../helpers/logger');

const redisOptions = {
    connection: {
        url: process.env.REDIS_URL || 'redis://localhost:6379'
    }
};

const restoreQueue = new Queue('restore-jobs', redisOptions);

restoreQueue.on('error', (err) => {
    logger.error('BullMQ Redis connection error:', err, 'RestoreQueue');
});

module.exports = {
    restoreQueue,
    redisOptions
};
