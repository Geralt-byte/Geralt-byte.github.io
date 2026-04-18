// Code copy functionality
document.addEventListener('DOMContentLoaded', function() {
  // Create copy button styles if they don't exist
  const style = document.createElement('style');
  style.textContent = `
    .copy-button {
      position: absolute;
      top: 0;
      right: 0;
      background-color: #4CAF50;
      color: white;
      border: none;
      border-radius: 0 2px 0 2px;
      padding: 4px 8px;
      font-size: 12px;
      cursor: pointer;
      z-index: 100;
      transition: background-color 0.3s;
    }

    .copy-button:hover {
      background-color: #45a049;
    }

    .copy-button.copied {
      background-color: #2e7d32;
    }

    .copy-button:active {
      transform: scale(0.95);
    }

    pre {
      position: relative;
    }

    pre.badge {
      padding-top: 24px;
    }
  `;
  document.head.appendChild(style);

  // Add copy buttons to all code blocks
  const codeBlocks = document.querySelectorAll('pre code');

  codeBlocks.forEach((codeBlock) => {
    const pre = codeBlock.parentElement;

    // Create copy button
    const copyButton = document.createElement('button');
    copyButton.className = 'copy-button';
    copyButton.textContent = 'Copy';

    // Add click event listener
    copyButton.addEventListener('click', async () => {
      const code = codeBlock.textContent;

      try {
        await navigator.clipboard.writeText(code);

        // Change button text to indicate success
        copyButton.textContent = 'Copied!';
        copyButton.classList.add('copied');

        // Reset button after 2 seconds
        setTimeout(() => {
          copyButton.textContent = 'Copy';
          copyButton.classList.remove('copied');
        }, 2000);

      } catch (err) {
        console.error('Failed to copy code:', err);
        copyButton.textContent = 'Failed';
        setTimeout(() => {
          copyButton.textContent = 'Copy';
        }, 2000);
      }
    });

    // Add button to pre element
    pre.appendChild(copyButton);
  });
});