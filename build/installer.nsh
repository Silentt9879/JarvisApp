; JARVIS setup wording - plain and friendly. electron-builder calls customHeader before the pages are drawn.
!macro customHeader
  !define MUI_WELCOMEPAGE_TITLE "Welcome to JARVIS"
  !define MUI_WELCOMEPAGE_TEXT "This will set up JARVIS on your PC. It takes about a minute.$\r$\n$\r$\nJARVIS is your assistant for Claude Code. It does not need administrator rights, and it only installs into your own user account.$\r$\n$\r$\nClick Next to continue."
  !define MUI_FINISHPAGE_TITLE "JARVIS is ready"
  !define MUI_FINISHPAGE_TEXT "JARVIS is installed. You can open it from the desktop icon or the Start menu.$\r$\n$\r$\nTo get future updates, open Settings and press Update. Nothing is installed without you pressing it."
!macroend
