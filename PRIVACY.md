# Privacy Policy: Configuration Companion

Last updated: 20 November 2026

Configuration Companion is an independent developer tool by Tassilo Heinemann for inspecting and editing Corporater BMP workspaces that you choose. It has no analytics, advertising, user accounts, or developer-operated data service.

## Data stored on your device

The extension stores its settings, server profiles, favourites, caches, activity history, drafts and optional credentials locally in the browser (extension storage and IndexedDB). It uses configuration data, code, object metadata and the BMP session only to provide its features.

- BMP session tokens, tickets and the cookies of a stored configuration login are kept in browser session storage and are cleared when the browser closes.
- Saved BMP passwords and AI API keys are encrypted with AES-GCM. This protects against casual inspection of browser storage, not against someone with access to your device or browser profile.
- If you choose to keep a copy of a server's Extended Code for Code Search, that copy stays in the browser and is not synced or sent anywhere.

## Data sent over the network

Data goes only to the places below.

- **Your BMP server.** Requests go to the BMP server and include the sign-in ticket or, for a stored configuration login, the saved user name and password. BMP's direct login and command requests carry these in the request address, so server access logs may record them; use HTTPS.
- **Your AI provider, if you set one up.** When you use the assistant, your API key, your messages, and the BMP objects, code and layout the assistant reads for the task are sent directly from the browser to the provider you selected, under its terms and privacy policy. They do not pass through the developer.
- **GitHub, for update checks.** The extension asks GitHub Releases for the latest version. No BMP content, credentials or AI messages are sent.
- **Your browser's speech service, if you turn on voice comments.** Voice comments are off by default. When on, the browser turns what you say into text; unless it does this on the device, the audio goes to the browser vendor's speech service. The extension does not record or keep audio.
- **Claude Desktop on this computer, only when you press Send to Claude.** The brief that Copy for AI would copy, and a picture, go over a connection to this computer's own address (127.0.0.1) to the Companion extension for Claude Desktop, if you installed it. The picture is a screenshot when the browser allows one without a prompt, and otherwise one that Companion draws from the page layout. While a sent sketch is open, and when you open the list of what you sent or the Claude Desktop page, the browser asks the same local address for the sketches' states and Claude's replies. The extension sends nothing elsewhere; what Claude Desktop does with it is under your Claude terms.
- **Files on this computer, written by the Companion extension for Claude Desktop (not by the browser extension).** Each sent sketch is also saved in your user folder under `Configuration Companion/Sessions`: its brief (page names, object IDs, the page address), its picture, and Claude's reply. They stay on this computer, are not synced by Companion, and are deleted after 7 days. The settings the browser extension gives it (the wording of its instructions to Claude, how long it waits, how many sketches it keeps; nothing about you or your pages) are kept in the same folder, in `.config.json`. The extension's own storage holds none of this beyond the browser session.
- **Code you run.** Live CVO preview runs code you choose with real BMP data. The preview's security policy blocks network requests made by that code.

The developer does not receive, sell or use extension data. The extension's use of data follows the Chrome Web Store User Data Policy, including its Limited Use requirements.

## Browser permissions

Site access applies only to sites you grant.

- **Scripting:** adds Companion's page tools to granted BMP sites.
- **Tabs:** reads the address of open tabs to find your BMP workspace and open Companion windows beside it.
- **Active tab:** lets Point and tell take a picture of the tab when you start it with its shortcut or from the right-click menu. The picture goes to your clipboard only.
- **Cookies:** checks whether a BMP session cookie is present, to notice sign-in and sign-out.
- **Web requests and request rules:** read the cookies BMP returns to Companion's own requests and attach them to its later requests. The cookies of the BMP page you are using are not changed.
- **Storage:** keeps the data described above on your device.

## Your control

You can delete a server profile or use "Reset all" to remove stored working data, remove the AI configuration, revoke site access in the browser's extension settings, or uninstall the extension.
