const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

// Ensure the local storage directory exists
const STORAGE_DIR = path.join(__dirname, '..', '..', 'storage', 'snapshots');
if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

module.exports = {
    /**
     * Downloads an image from a URL and saves it to local disk.
     * In a production environment, this could be adapted to upload to Cloudflare R2.
     * 
     * @param {String} url - The Discord CDN URL
     * @returns {Promise<String|null>} - The local file path or identifier
     */
    async saveAsset(url) {
        if (!url) return null;

        return new Promise((resolve) => {
            const ext = url.split('.').pop().split('?')[0] || 'png';
            const fileName = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
            const filePath = path.join(STORAGE_DIR, fileName);

            const file = fs.createWriteStream(filePath);
            
            https.get(url, (response) => {
                if (response.statusCode === 200) {
                    response.pipe(file);
                    file.on('finish', () => {
                        file.close();
                        // Return a relative URL path that the Express dashboard can serve
                        resolve(`/snapshots/${fileName}`);
                    });
                } else {
                    file.close();
                    fs.unlink(filePath, () => {});
                    resolve(null);
                }
            }).on('error', () => {
                fs.unlink(filePath, () => {});
                resolve(null);
            });
        });
    }
};
