const form = document.getElementById('cloneForm');
const urlInput = document.getElementById('urlInput');
const statusDiv = document.getElementById('status');
const errorDiv = document.getElementById('error');

form.addEventListener('submit', async (event) => {
    event.preventDefault(); // Prevent default form submission
    statusDiv.textContent = 'Processing... Please wait.';
    errorDiv.textContent = '';

    const targetUrl = urlInput.value;

    try {
        const response = await fetch('/scrape', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ url: targetUrl }),
        });

        if (!response.ok) {
            // Try to read error message from backend
            let errorMsg = `Error: ${response.status} ${response.statusText}`;
            try {
                const errorData = await response.json();
                errorMsg = `Error: ${errorData.message || errorMsg}`;
            } catch (e) {
                // Ignore if error response is not JSON
            }
            throw new Error(errorMsg);
        }

        // Check if the response is a zip file
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/zip')) {
            statusDiv.textContent = 'Download starting...';

            // Get filename from content-disposition header if available
            let filename = 'website_data.zip';
            const disposition = response.headers.get('content-disposition');
            if (disposition && disposition.indexOf('attachment') !== -1) {
                const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/;
                const matches = filenameRegex.exec(disposition);
                if (matches != null && matches[1]) {
                  filename = matches[1].replace(/['"]/g, '');
                }
            }

            const blob = await response.blob();
            const downloadUrl = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = downloadUrl;
            a.download = filename; // Use the determined filename
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(downloadUrl);
            a.remove();
            statusDiv.textContent = 'Download complete!';

        } else {
             // Handle unexpected response type (e.g., HTML error page from server)
             throw new Error('Received unexpected response type from server.');
        }

    } catch (error) {
        console.error('Fetch error:', error);
        statusDiv.textContent = '';
        errorDiv.textContent = `Failed to process URL. ${error.message || 'Check console for details.'}`;
    }
});
