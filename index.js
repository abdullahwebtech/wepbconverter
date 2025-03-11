const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const fsPromises = require('fs').promises;
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const app = express();

// Configure multer for file uploads
const upload = multer({
    dest: 'uploads/',
    limits: {
        fileSize: 100 * 1024 * 1024, // 100MB per file
        files: 100 // Max 100 files per request
    },
    fileFilter: (req, file, cb) => {
        const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
        if (validTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only JPEG, PNG, WebP, and GIF are allowed.'));
        }
    }
});

const PORT = 3000;

// Utility to ensure directory exists
const ensureDir = async (dir) => {
    try {
        await fsPromises.mkdir(dir, { recursive: true });
        console.log(`Directory created: ${dir}`);
    } catch (err) {
        if (err.code !== 'EEXIST') throw err;
    }
};

// Serve static files from 'public' directory
app.use(express.static('public'));

// Download individual file
app.get('/download/:session/:filename', async (req, res) => {
    const filePath = path.join(__dirname, 'public', req.params.session, req.params.filename);
    console.log(`Download requested: ${filePath}`);
    try {
        await fsPromises.access(filePath);
        res.download(filePath, req.params.filename, (err) => {
            if (err) {
                console.error(`Download error: ${err.message}`);
                res.status(500).json({ error: 'Failed to download file' });
            }
        });
    } catch (err) {
        console.error(`File not found: ${filePath}`);
        res.status(404).json({ error: 'File not found' });
    }
});

// Download ZIP of all session files
app.get('/download-zip/:session', async (req, res) => {
    const sessionDir = path.join(__dirname, 'public', req.params.session);
    const zipPath = path.join(__dirname, 'public', `${req.params.session}.zip`);
    console.log(`Zipping directory: ${sessionDir}`);

    try {
        const files = await fsPromises.readdir(sessionDir);
        if (!files.length) {
            console.warn(`No files found in ${sessionDir}`);
            return res.status(404).json({ error: 'No files available to zip' });
        }

        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        const zipPromise = new Promise((resolve, reject) => {
            output.on('close', () => {
                console.log(`ZIP created: ${zipPath}, size: ${archive.pointer()} bytes`);
                resolve();
            });
            archive.on('error', (err) => {
                console.error(`Archiver error: ${err.message}`);
                reject(err);
            });
        });

        archive.pipe(output);
        archive.directory(sessionDir, false);
        archive.finalize();

        await zipPromise;

        res.download(zipPath, 'converted_images.zip', (err) => {
            if (err) {
                console.error(`ZIP download error: ${err.message}`);
                res.status(500).json({ error: 'Failed to download ZIP' });
            }
            fsPromises.unlink(zipPath).catch(err => console.error(`Failed to delete ZIP: ${err.message}`));
        });
    } catch (err) {
        console.error(`ZIP creation error: ${err.message}`);
        res.status(500).json({ error: `Failed to create ZIP: ${err.message}` });
    }
});

// Optimize WebP conversion with aggressive quality adjustment
const optimizeWebP = async (inputPath, outputPath, originalSize, isWebP) => {
    let quality = isWebP ? 50 : 70; // Aggressive starting quality
    let convertedSize;
    let attempts = 0;
    const maxAttempts = 3; // Allow up to 3 tries

    do {
        const startTime = Date.now();
        await sharp(inputPath)
            .webp({
                quality,             // Dynamic quality
                effort: 1,           // Balanced speed and compression
                nearLossless: false, // Disable for aggressive reduction
                smartSubsample: true,// Optimize subsampling
                alphaQuality: 80     // Slightly lower for more reduction
            })
            .toFile(outputPath);

        convertedSize = (await fsPromises.stat(outputPath)).size;
        const processingTime = (Date.now() - startTime) / 1000;
        console.log(`Attempt ${attempts + 1} at quality ${quality}: ${convertedSize} bytes in ${processingTime} seconds`);

        if (convertedSize >= originalSize && quality > 10 && attempts < maxAttempts) {
            await fsPromises.unlink(outputPath);
            quality -= 20; // Aggressive step down
            attempts++;
            console.log(`Size ${convertedSize} >= ${originalSize}, retrying with quality ${quality}`);
        } else if (convertedSize < 512) {
            throw new Error('Converted file size too small');
        } else {
            break;
        }
    } while (attempts < maxAttempts);

    // Final fallback: if still no reduction, force quality 20
    if (convertedSize >= originalSize) {
        const startTime = Date.now();
        await sharp(inputPath)
            .webp({
                quality: 20,          // Lowest quality for max reduction
                effort: 1,
                nearLossless: false,
                smartSubsample: true,
                alphaQuality: 80
            })
            .toFile(outputPath);

        convertedSize = (await fsPromises.stat(outputPath)).size;
        console.log(`Final attempt at quality 20: ${convertedSize} bytes in ${(Date.now() - startTime) / 1000} seconds`);
    }

    return convertedSize;
};

// Image conversion endpoint
app.post('/convert', upload.array('image'), async (req, res) => {
    try {
        console.log('Files received:', req.files.map(f => ({ name: f.originalname, size: f.size, mimetype: f.mimetype })));
        if (!req.files || req.files.length === 0) {
            console.warn('No files uploaded');
            return res.status(400).json({ error: 'No files uploaded' });
        }

        const sessionId = req.headers['x-session-id'] || `session_${Date.now()}`;
        const outputDir = path.join(__dirname, 'public', sessionId);
        await ensureDir(outputDir);

        const fileSizes = [];
        const downloadUrls = [];

        for (const file of req.files) {
            const outputFilename = `${path.basename(file.originalname, path.extname(file.originalname))}.webp`;
            const outputPath = path.join(outputDir, outputFilename);
            console.log(`Processing ${file.originalname} to ${outputPath}`);

            try {
                const originalSize = (await fsPromises.stat(file.path)).size;
                const isWebP = file.mimetype === 'image/webp';

                const convertedSize = await optimizeWebP(file.path, outputPath, originalSize, isWebP);

                if (convertedSize >= originalSize) {
                    console.log(`Final size ${convertedSize} >= ${originalSize}, skipping conversion`);
                    await fsPromises.unlink(outputPath);
                    fileSizes.push({ originalName: file.originalname, originalSize, convertedSize: originalSize, skipped: true });
                    downloadUrls.push('');
                } else {
                    fileSizes.push({ originalName: file.originalname, originalSize, convertedSize });
                    downloadUrls.push(`/download/${sessionId}/${outputFilename}`);
                }

                await fsPromises.unlink(file.path);
            } catch (err) {
                console.error(`Error processing ${file.originalname}: ${err.message}`);
                fileSizes.push({
                    originalName: file.originalname,
                    originalSize: file.size,
                    convertedSize: file.size,
                    error: true,
                    errorDetail: err.message
                });
                downloadUrls.push('');
                await fsPromises.unlink(file.path).catch(err => console.error(`Cleanup failed: ${err.message}`));
            }
        }

        const zipDownloadUrl = fileSizes.length && !fileSizes.every(f => f.error || f.skipped) ? `/download-zip/${sessionId}` : '';

        console.log('Response prepared:', { downloadUrls, zipDownloadUrl, fileSizes });
        res.status(200).json({ downloadUrls, zipDownloadUrl, fileSizes });
    } catch (err) {
        console.error(`Conversion endpoint error: ${err.message}`);
        res.status(500).json({ error: `Server error: ${err.message}` });
    }
});

// Handle 404 for undefined routes
app.use((req, res) => {
    console.warn(`404: Route not found - ${req.method} ${req.url}`);
    res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error(`Unhandled error: ${err.message}`, err.stack);
    res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});