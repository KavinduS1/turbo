import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio'; // Correct Cheerio import for ES Modules
import archiver from 'archiver';
import fsPromises from 'fs/promises'; // <--- Import promise-based API
import { createWriteStream, createReadStream } from 'fs'; // <--- Import stream functions from core fs
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import crypto from 'crypto'; // For unique temp directory

// --- ES Module setup for __dirname ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// ---

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware ---
app.use(express.json()); // Parse JSON request bodies
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files

// --- Helper Function: Sanitize filename ---
function sanitizeFilename(filename) {
    // Remove invalid characters, limit length, handle edge cases
    if (!filename) return `file_${crypto.randomBytes(4).toString('hex')}`;
    return filename
        .replace(/[^a-zA-Z0-9_\-\.]/g, '_') // Replace invalid chars with _
        .replace(/_{2,}/g, '_') // Replace multiple underscores
        .replace(/^_|_$/g, '') // Trim leading/trailing underscores
        .substring(0, 100); // Limit length
}


// --- Route to handle scraping and zipping ---
app.post('/scrape', async (req, res) => {
    const targetUrl = req.body.url;

    if (!targetUrl) {
        return res.status(400).json({ message: 'URL is required' });
    }

    let tempDir = ''; // To store path for cleanup
    let zipFilePath = ''; // Define zip path outside try for finally block access
    const uniqueId = Date.now() + '_' + crypto.randomBytes(4).toString('hex');

    try {
        // Define paths using uniqueId
        tempDir = path.join(__dirname, `data-${uniqueId}`);
        const imagesDir = path.join(tempDir, 'images');
        const textFilePath = path.join(tempDir, 'text.txt');
        zipFilePath = path.join(__dirname, `website_data_${uniqueId}.zip`); // Temporary zip path on server

        console.log(`[${uniqueId}] Processing URL: ${targetUrl}`);
        console.log(`[${uniqueId}] Temp directory: ${tempDir}`);
        console.log(`[${uniqueId}] Zip file path: ${zipFilePath}`);


        // 1. Create temporary directories using fsPromises
        await fsPromises.mkdir(tempDir);
        await fsPromises.mkdir(imagesDir);
        console.log(`[${uniqueId}] Created directories.`);

        // 2. Fetch HTML content
        console.log(`[${uniqueId}] Fetching HTML...`);
        const { data: htmlContent, request: finalRequest } = await axios.get(targetUrl, {
            headers: { // Pretend to be a browser
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 15000 // 15 second timeout
        });
        const baseUrl = finalRequest.res.responseUrl || targetUrl; // Use final URL after redirects
        console.log(`[${uniqueId}] HTML fetched. Base URL: ${baseUrl}`);


        // 3. Save HTML content to text.txt using fsPromises
        await fsPromises.writeFile(textFilePath, htmlContent);
        console.log(`[${uniqueId}] Saved text.txt.`);

        // 4. Parse HTML and find images (using cheerio correctly)
        const $ = cheerio.load(htmlContent);
        const imageUrls = [];
        $('img').each((index, element) => {
            let imgSrc = $(element).attr('src');
            if (imgSrc) {
                try {
                    // Resolve relative URLs against the base URL
                    const absoluteUrl = new URL(imgSrc, baseUrl).href;
                    imageUrls.push(absoluteUrl);
                } catch (urlError) {
                    console.warn(`[${uniqueId}] Skipping invalid image src: ${imgSrc} - ${urlError.message}`);
                }
            }
        });
        console.log(`[${uniqueId}] Found ${imageUrls.length} potential image URLs.`);

        // 5. Download images
        const downloadedImages = [];
        let imageCounter = 0;
        for (const imgUrl of imageUrls) {
            imageCounter++;
            try {
                console.log(`[${uniqueId}] Downloading image ${imageCounter}/${imageUrls.length}: ${imgUrl}`);
                const response = await axios.get(imgUrl, {
                    responseType: 'arraybuffer', // Get image data as buffer
                    timeout: 10000 // 10 second timeout per image
                 });

                // Basic check for image content type (optional but good)
                const contentType = response.headers['content-type'];
                if (!contentType || !contentType.startsWith('image/')) {
                   console.warn(`[${uniqueId}] Skipping non-image content type (${contentType}) for URL: ${imgUrl}`);
                   continue;
                }

                // --- Create a filename ---
                const parsedUrl = new URL(imgUrl);
                let filename = path.basename(parsedUrl.pathname);
                // Handle cases like '/' or empty pathname
                if (!filename || filename === '/') {
                    filename = `image_${imageCounter}`; // Fallback name
                }
                // Try to get extension, add default if missing
                const ext = path.extname(filename);
                if (!ext) {
                    // Guess extension from content type
                    const guessedExt = contentType.split('/')[1]?.split(';')[0]; // e.g. png from image/png;charset=utf-8
                    filename += guessedExt ? `.${guessedExt}` : '.jpg'; // Default to .jpg if guessing fails
                }

                const safeFilename = sanitizeFilename(filename);
                const imagePath = path.join(imagesDir, safeFilename);

                // Save image using fsPromises
                await fsPromises.writeFile(imagePath, response.data);
                downloadedImages.push(safeFilename);
                console.log(`[${uniqueId}] Saved image: ${safeFilename}`);

            } catch (imgError) {
                console.error(`[${uniqueId}] Failed to download image ${imgUrl}: ${imgError.message}`);
                // Continue to the next image even if one fails
            }
        }
        console.log(`[${uniqueId}] Downloaded ${downloadedImages.length} images successfully.`);

        // 6. Create ZIP file
        console.log(`[${uniqueId}] Creating ZIP file...`);
        // Use createWriteStream directly (imported from 'fs')
        const output = createWriteStream(zipFilePath);
        const archive = archiver('zip', {
            zlib: { level: 9 } // Sets the compression level.
        });

        // --- Setup Promise for Archiving Completion ---
        // This helps ensure finalize() completes before we proceed in the finally block
        // Although piping to 'res' handles backpressure, knowing the archive itself is done is useful.
        const archivePromise = new Promise((resolve, reject) => {
            output.on('close', () => {
                console.log(`[${uniqueId}] ZIP file stream closed: ${zipFilePath} (${archive.pointer()} total bytes)`);
                // 7. Send the ZIP file to the client
                res.setHeader('Content-Type', 'application/zip');
                res.setHeader('Content-Disposition', `attachment; filename="website_data_${uniqueId}.zip"`);
                // Use createReadStream directly (imported from 'fs')
                const readStream = createReadStream(zipFilePath);
                readStream.pipe(res);
                console.log(`[${uniqueId}] Piping ZIP file to client.`);
                // Resolve the promise *after* starting the pipe to the response
                resolve();
            });

            archive.on('warning', (err) => {
                if (err.code === 'ENOENT') {
                    console.warn(`[${uniqueId}] Archiver warning: ${err}`); // File not found etc.
                } else {
                    console.error(`[${uniqueId}] Archiver critical warning: ${err}`);
                     // Don't reject on warning, but log it. Let finalize handle critical errors.
                }
            });

            archive.on('error', (err) => {
                 console.error(`[${uniqueId}] Archiver error: ${err}`);
                reject(err); // Reject the promise on archiver error
            });
        });


        // Pipe archive data to the file
        archive.pipe(output);

        // Add text.txt to the root of the zip
        archive.file(textFilePath, { name: 'text.txt' });

        // Add the entire 'images' directory to the zip, under an 'images' folder
        if (downloadedImages.length > 0) {
             archive.directory(imagesDir, 'images');
        } else {
            console.log(`[${uniqueId}] No images downloaded, skipping images directory in zip.`);
        }

        // Finalize the archive (triggers 'close' on output stream when done)
        await archive.finalize();
        console.log(`[${uniqueId}] Archive finalize() called.`);

        // Wait for the archive process (including piping to response) to signal completion or error
        await archivePromise;
        console.log(`[${uniqueId}] Archive promise resolved (piping likely started/finished).`);


    } catch (error) {
        console.error(`[${uniqueId}] Error during processing:`, error.message, error.stack); // Log stack trace
        // Check if response has already been partially sent (e.g., headers)
        if (!res.headersSent) {
             res.status(500).json({ message: `Failed to process URL: ${error.message}` });
        } else {
            console.error(`[${uniqueId}] Headers already sent, cannot send JSON error response.`);
            // If headers sent, we can't send JSON, just end the response abruptly
            res.end();
        }
    } finally {
        // 8. Cleanup (Attempt to remove temp directory and zip AFTER response finishes/closes)
        const cleanup = async () => {
             console.log(`[${uniqueId}] Starting cleanup for ${uniqueId}...`);
            let tempDirRemoved = false;
            let zipFileRemoved = false;
            try {
                if (tempDir) {
                    // Use fsPromises for removal
                    await fsPromises.rm(tempDir, { recursive: true, force: true });
                    console.log(`[${uniqueId}] Removed temporary directory: ${tempDir}`);
                    tempDirRemoved = true;
                } else {
                     console.log(`[${uniqueId}] No tempDir path to remove.`);
                }
            } catch (cleanupError) {
                console.error(`[${uniqueId}] Error removing temporary directory ${tempDir}: ${cleanupError.message}`);
            }
             try {
                 if (zipFilePath) {
                    // Use fsPromises for removal
                    await fsPromises.unlink(zipFilePath);
                    console.log(`[${uniqueId}] Removed temporary zip file: ${zipFilePath}`);
                    zipFileRemoved = true;
                 } else {
                      console.log(`[${uniqueId}] No zipFilePath to remove.`);
                 }
            } catch (cleanupError) {
                // Check error code, ENOENT (file not found) might be acceptable if download failed early
                if (cleanupError.code !== 'ENOENT') {
                     console.error(`[${uniqueId}] Error removing temporary zip file ${zipFilePath}: ${cleanupError.message}`);
                } else {
                    console.log(`[${uniqueId}] Temporary zip file ${zipFilePath} not found for removal (may not have been created).`);
                    zipFileRemoved = true; // Consider it "removed" if it never existed
                }
            }
            if (tempDirRemoved && zipFileRemoved) {
                 console.log(`[${uniqueId}] Cleanup attempt finished successfully.`);
            } else {
                 console.log(`[${uniqueId}] Cleanup attempt finished (potential issues).`);
            }
        };

        // Ensure cleanup happens after the response stream is fully finished or closed
        if (res.writableEnded || res.closed) {
             console.log(`[${uniqueId}] Response already ended/closed in finally block. Running cleanup immediately.`);
             await cleanup(); // Await if running immediately
        } else {
             console.log(`[${uniqueId}] Scheduling cleanup on response finish/close.`);
             res.on('finish', () => {
                console.log(`[${uniqueId}] Response finished event.`);
                cleanup(); // Don't need await here as it's event-driven
            });
             res.on('close', () => {
                if (!res.writableEnded) {
                     console.log(`[${uniqueId}] Response closed prematurely event.`);
                     cleanup(); // Don't need await here
                }
            });
        }
         console.log(`[${uniqueId}] Request handler finished, cleanup scheduled or executed.`);
    }
});

// --- Start Server ---
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});