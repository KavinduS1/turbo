// Cloudflare Worker implementation of web scraper & zipper
import JSZip from 'jszip';
import { DOMParser } from 'linkedom';

// Configure the fetcher to use in our worker
const fetchWithTimeout = (url, options = {}, timeout = 15000) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  return fetch(url, {
    ...options,
    signal: controller.signal,
  }).finally(() => clearTimeout(timeoutId));
};

// Sanitize filename function (adapted from original)
function sanitizeFilename(filename) {
  if (!filename) return `file_${crypto.randomUUID().substring(0, 8)}`;
  return filename
    .replace(/[^a-zA-Z0-9_\-\.]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 100);
}

// Route handling for the worker
async function handleRequest(request, env) {
  const url = new URL(request.url);
  
  // Serve static files from KV for the frontend
  if (request.method === "GET") {
    // Handle root path
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(await env.STATIC_ASSETS.get("index.html"), {
        headers: { "Content-Type": "text/html" }
      });
    }
    
    // Handle other static assets 
    if (url.pathname === "/script.js") {
      return new Response(await env.STATIC_ASSETS.get("script.js"), {
        headers: { "Content-Type": "application/javascript" }
      });
    }
    
    // Return 404 for other paths
    return new Response("Not found", { status: 404 });
  }
  
  // Handle POST request to /scrape endpoint
  if (request.method === "POST" && url.pathname === "/scrape") {
    try {
      // Parse the JSON body
      const { url: targetUrl } = await request.json();
      
      if (!targetUrl) {
        return new Response(JSON.stringify({ message: 'URL is required' }), { 
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
      
      // Create a unique ID for this request
      const uniqueId = `${Date.now()}_${crypto.randomUUID().substring(0, 8)}`;
      console.log(`[${uniqueId}] Processing URL: ${targetUrl}`);
      
      // 1. Fetch HTML content
      console.log(`[${uniqueId}] Fetching HTML...`);
      const htmlResponse = await fetchWithTimeout(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });
      
      if (!htmlResponse.ok) {
        throw new Error(`Failed to fetch HTML: ${htmlResponse.status} ${htmlResponse.statusText}`);
      }
      
      const htmlContent = await htmlResponse.text();
      const baseUrl = htmlResponse.url || targetUrl; // Use the final URL after redirects
      console.log(`[${uniqueId}] HTML fetched. Base URL: ${baseUrl}`);
      
      // 2. Parse HTML and find images using linkedom
      const document = new DOMParser().parseFromString(htmlContent, 'text/html');
      const imageElements = document.querySelectorAll('img');
      
      const imageUrls = [];
      imageElements.forEach(img => {
        let imgSrc = img.getAttribute('src');
        if (imgSrc) {
          try {
            // Resolve relative URLs against the base URL
            const absoluteUrl = new URL(imgSrc, baseUrl).href;
            imageUrls.push(absoluteUrl);
          } catch (urlError) {
            console.warn(`[${uniqueId}] Skipping invalid image src: ${imgSrc}`);
          }
        }
      });
      console.log(`[${uniqueId}] Found ${imageUrls.length} potential image URLs.`);
      
      // 3. Create ZIP file using JSZip
      const zip = new JSZip();
      
      // Add HTML content to the ZIP
      zip.file("text.txt", htmlContent);
      
      // Create images folder in ZIP
      const imagesFolder = zip.folder("images");
      
      // 4. Download images and add to ZIP
      const downloadedImages = [];
      let imageCounter = 0;
      
      for (const imgUrl of imageUrls) {
        imageCounter++;
        try {
          console.log(`[${uniqueId}] Downloading image ${imageCounter}/${imageUrls.length}: ${imgUrl}`);
          
          const imgResponse = await fetchWithTimeout(imgUrl, {
            timeout: 10000
          });
          
          if (!imgResponse.ok) {
            console.warn(`[${uniqueId}] Skipping image with status ${imgResponse.status}: ${imgUrl}`);
            continue;
          }
          
          // Check content type
          const contentType = imgResponse.headers.get('content-type');
          if (!contentType || !contentType.startsWith('image/')) {
            console.warn(`[${uniqueId}] Skipping non-image content type (${contentType}): ${imgUrl}`);
            continue;
          }
          
          // Create filename
          const parsedUrl = new URL(imgUrl);
          let filename = parsedUrl.pathname.split('/').pop();
          
          // Handle cases like '/' or empty pathname
          if (!filename || filename === '/') {
            filename = `image_${imageCounter}`;
          }
          
          // Try to get extension, add default if missing
          const filenameParts = filename.split('.');
          const ext = filenameParts.length > 1 ? filenameParts.pop() : '';
          
          if (!ext) {
            // Guess extension from content type
            const guessedExt = contentType.split('/')[1]?.split(';')[0];
            filename += guessedExt ? `.${guessedExt}` : '.jpg';
          } else {
            filename = `${filenameParts.join('.')}.${ext}`;
          }
          
          const safeFilename = sanitizeFilename(filename);
          
          // Add image to ZIP
          const imgBuffer = await imgResponse.arrayBuffer();
          imagesFolder.file(safeFilename, imgBuffer);
          
          downloadedImages.push(safeFilename);
          console.log(`[${uniqueId}] Saved image: ${safeFilename}`);
          
        } catch (imgError) {
          console.error(`[${uniqueId}] Failed to download image ${imgUrl}: ${imgError.message}`);
          // Continue to next image
        }
      }
      
      console.log(`[${uniqueId}] Downloaded ${downloadedImages.length} images successfully.`);
      
      // 5. Generate the ZIP file
      console.log(`[${uniqueId}] Creating ZIP file...`);
      const zipBlob = await zip.generateAsync({
        type: "arraybuffer",
        compression: "DEFLATE",
        compressionOptions: { level: 9 }
      });
      
      // 6. Return the ZIP file
      console.log(`[${uniqueId}] Sending ZIP file to client (${zipBlob.byteLength} bytes)`);
      
      return new Response(zipBlob, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="website_data_${uniqueId}.zip"`
        }
      });
      
    } catch (error) {
      console.error(`Error processing request: ${error.message}`);
      return new Response(JSON.stringify({ message: `Failed to process URL: ${error.message}` }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
  
  // Return 404 for other paths/methods
  return new Response("Not found", { status: 404 });
}

// Export the main handler function for Cloudflare Workers
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env);
  }
};
