# 🛠️ Developer Tools

**Free online tools for developers** - JSON comparison, text conversion, URL analysis, CSV viewing, and more!

[![Live Demo](https://img.shields.io/badge/Live%20Demo-avivliberman.github.io/developer--tools-blue?style=for-the-badge&logo=github)](https://avivliberman.github.io/developer-tools/)

## ✨ What You Can Do

### 🔍 **JSON Diff Tool**
- Compare two JSON files side-by-side
- Paste JSON content directly
- Visual diff highlighting
- Toggle to show only differences
- Drag & drop file support

### 🔤 **Text Case Converter**
- Convert between 14+ case formats
- camelCase, PascalCase, snake_case, kebab-case
- UPPER_SNAKE_CASE, Title Case, and more
- Click any result to copy to clipboard
- Works with any input format

### 📝 **JSON Keys Case Converter**
- Convert JSON object keys to any case format
- Support for nested objects and arrays
- Upload JSON files or paste content directly
- Preserve all values while converting keys
- One-click copy converted JSON

### 🔗 **URL Breakdown**
- Analyze any URL into components
- Extract protocol, hostname, path, query parameters
- Copy individual components
- Handle complex URLs with authentication
- Beautiful visual breakdown

### 📊 **JSON Analytics**
- Analyze JSON structure and complexity
- Validate JSON format
- Generate JSON schema
- Get detailed statistics
- Format and beautify JSON

### 📑 **CSV Viewer**
- Open CSV/TSV files by drag & drop, file picker, paste, or URL (`?url=<encoded-url>#csv`)
- Auto-detects the delimiter (comma, semicolon, tab, pipe) with manual override
- Handles quoted fields, multi-line cells, BOM and CRLF line endings
- Fast virtualized table for 100k+ rows; large files parse in a background worker with progress
- Sort (numeric-aware), search with match count, resize and hide columns
- Click any cell to copy it; export the current view as JSON or CSV
- Install as an app to open `.csv` files straight from Finder (see below)

## 🚀 Quick Start

1. **Visit the live site**: [https://aviv-liberman.github.io/developer-tools/](https://avivliberman.github.io/developer-tools/)
2. **Choose your tool** from the tab navigation
3. **Start using** - no registration required!

## 🍎 How to open CSV files from your Mac

The CSV Viewer can register itself as an app for `.csv`, `.tsv` and `.txt` files using the
[File Handling API](https://developer.chrome.com/docs/capabilities/web-apis/file-handling).
This needs **Chrome or Edge**. Safari does not support file handling for web apps, so it can't do this.

1. Open [the site](https://avivliberman.github.io/developer-tools/#csv) in Chrome or Edge.
2. Install it: click the install icon in the address bar, or use **⋮ → Cast, save and share → Install page as app…**
   (Edge: **… → Apps → Install this site as an app**).
3. In Finder, right-click a `.csv` file → **Open With** → **Developer Tools**.
   The first time, Chrome asks you to allow the app to open the file type. Approve it.
4. Optional: to always use it, select a `.csv` file, press **⌘I** (Get Info), choose **Developer Tools** under
   **Open with**, then click **Change All…**.

Files are read locally by the app and never uploaded.

## 💡 Use Cases

- **API Development**: Compare API responses, validate JSON schemas, convert API key formats
- **Data Analysis**: Convert text formats, analyze JSON structure, standardize data keys, explore CSV exports
- **Debugging**: Break down URLs, compare configuration files, normalize JSON keys
- **Documentation**: Format JSON for documentation, convert between naming conventions
- **Learning**: Understand JSON structure and URL components, practice case conversions

## 🌟 Features

- ✅ **100% Free** - No registration, no limits
- ✅ **Privacy-First** - All processing happens in your browser
- ✅ **Mobile-Friendly** - Works on all devices
- ✅ **Accessible** - Full keyboard navigation and screen reader support
- ✅ **Fast** - No server processing, instant results
- ✅ **Modern** - Built with latest web standards

## 🎯 Perfect For

- **Developers** working with JSON APIs
- **Data Scientists** analyzing structured data
- **Students** learning web development
- **QA Engineers** testing applications
- **Anyone** who works with text and data

## 🔧 Technical Details

- **Pure HTML/CSS/JavaScript** - No frameworks required
- **Responsive Design** - Works on desktop, tablet, and mobile
- **Accessibility Compliant** - WCAG guidelines followed
- **SEO Optimized** - Proper meta tags and structure
- **PWA Ready** - Can be installed as an app

## 📱 Browser Support

Works in all modern browsers:
- Chrome, Firefox, Safari, Edge
- Mobile browsers (iOS Safari, Chrome Mobile)
- No JavaScript frameworks required

---

**Made with ❤️ for the developer community**

*Need a feature or found a bug? [Open an issue](https://github.com/avivliberman/developer-tools/issues) on GitHub!*
