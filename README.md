<div align="center">

<img src="build/icon.png" width="110" alt="JARVIS">

# JARVIS

**Claude Code on your desktop, and in your pocket.**

A Windows app for the Bantu Apps workspace that you can also drive from your phone over Telegram.

![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D6?logo=windows&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-app-47848F?logo=electron&logoColor=white)
![Claude](https://img.shields.io/badge/Claude-Agent%20SDK-D97757)
![Telegram](https://img.shields.io/badge/Telegram-remote-26A5E4?logo=telegram&logoColor=white)

</div>

---

## ✨ What it does

| | |
|---|---|
| 💬 **Chat** | Talk to JARVIS. Attach images and files, pick the model and effort level, and approve each action |
| 📱 **Telegram remote** | Send messages, photos, files and voice notes from your phone, and approve actions with one tap |
| 🔀 **Source Control** | Changes, commits, branches, push and pull, plus pull requests and checks from GitHub |
| ✅ **Tasks** | Your ClickUp board, synced and grouped by sprint |
| 📂 **Files** | Read any workspace file, and double-click to open it in VS Code |
| 📲 **Devices** | Live phone screens with `flutter run`, and web apps with `dotnet watch` |
| ↩️ **Undo** | Undo every file change made since any message, in one click |

---

## 📱 From your phone

> Set up once in **Settings → Phone alerts**: create a bot with @BotFather, press **Check token**, then press **Find my chat**.

| Send | You get |
|---|---|
| A message | It runs on the PC, just as if you typed it there |
| 📷 A photo or 📎 a file | It's saved in `Downloads\JARVIS from phone` and shown in the PC chat |
| 🎙 A voice note | It's transcribed on the PC (nothing goes to the cloud), then run |
| `/status` `/stop` `/new` | What JARVIS is doing, stop the current turn, start fresh |
| `/sessions` `/switch` | Pick up an earlier conversation |
| `/screen` | A screenshot of the PC |
| `/diff` | What has changed in each repo |
| `/brief` | The morning brief (sent automatically on weekdays at 08:00) |

**PC → phone:** with mirroring on, what you type and attach on the PC shows up in Telegram too.

👋 **Hello on startup:** when JARVIS opens on the PC, your phone gets a "Good morning / afternoon / evening" message, so you know it's online.

💤 **Power down / Wake up:** say "Power down" (phone or PC) and JARVIS goes to sleep in the tray. Say "Wake up" in Telegram, or click the tray icon, to bring it back. Quitting from the tray shuts it down fully, and Telegram tells you it's offline.

🖥️ **More than one PC:** give each PC its own bot and a name (Home-PC, Work-PC…), then put all the bots in one Telegram group with you. "Wake up" there wakes the only PC that's asleep, or asks which one with a button per PC. Add a name to pick one directly: "Wake up Work-PC".

🔒 Only *your* Telegram account is obeyed. Messages sent while JARVIS was off never run later, and every approval still needs your tap.

---

## ⌨️ Shortcuts

| Keys | Action |
|---|---|
| `Ctrl` + `1`…`6` | Switch view |
| `Ctrl` + `N` | New session |
| `Ctrl` + `K` | Search everything |
| `Ctrl` + `,` | Settings |
| `Esc` | Stop JARVIS |

---

## 🚀 Run it

```powershell
npm install        # first time
npm start          # run from source
npm test           # tests (no network needed)
npm run pack       # build -> dist\win-unpacked\JARVIS.exe
```

> 💡 From a VS Code terminal, first run `Remove-Item Env:ELECTRON_RUN_AS_NODE`.

---

<div align="center">

📖 **[Full technical details →](docs/DETAILS.md)**

<sub>Built on the Claude Agent SDK · Electron · Telegram Bot API</sub>

</div>
