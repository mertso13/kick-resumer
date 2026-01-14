# Kick Resumer

A lightweight web extension that automatically remembers and resumes your playback position on Kick.com VODs. Works on both Firefox and Chrome.

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) (for the build script)

### Build Instructions

To build the extension for both browsers:

```bash
node scripts/build.js
```

The output will be in the `dist/firefox` and `dist/chrome` directories.

## Installation

### Firefox

#### From Firefox Add-ons

[Kick Resumer - Firefox](https://addons.mozilla.org/en-US/firefox/addon/kick-resumer/)

#### Manual Installation

1.  Download or clone this repository.
2.  Open Firefox and go to `about:debugging`.
3.  Click **This Firefox** > **Load Temporary Add-on...**.
4.  Select the `manifest.json` file from the project folder.

### Chrome

#### From Chrome Web Store
[Kick Resumer - Chrome](https://chromewebstore.google.com/detail/kick-resumer/hcojicmdfemnlpncgefohmjinbnocinn)

#### Manual Installation

1. Build the extension.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable **Developer mode** in the top right.
4. Click **Load unpacked**.
5. Select the `dist/chrome/` folder.
