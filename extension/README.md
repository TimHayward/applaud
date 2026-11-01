# Applaud browser extension

Sends the speaker names you have confirmed in your own Applaud to Plaud, so that Plaud AI uses them. It works through your own Plaud sign-in in the browser.

> **Unofficial.** This extension is not affiliated with, endorsed or supported by Plaud. It changes your recordings in your own Plaud account by doing what the Plaud web app does when you rename a speaker. Use it at your own discretion.

**This version is read only (Phase 2).** It pairs with Applaud and shows, for each recording, exactly what it would change in Plaud. It contains no code that writes to Plaud. Writing arrives in a later release; see [the plan](../docs/plans/plaud-write-back-extension.md).

## Install (Microsoft Edge; other Chromium browsers work the same way)

1. Build it from the repository root:
   ```bash
   pnpm install
   ```
   ```bash
   pnpm build:extension
   ```
2. Open `edge://extensions`, switch on **Developer mode**, choose **Load unpacked** and select `extension/dist`.
3. In Applaud, switch on **Settings → Speaker identification → Send names to Plaud** and choose **Pair an extension**.
4. Click the extension's icon, enter Applaud's address (for example `http://192.168.1.20:44471`) and the pairing code, and choose **Pair**. The browser asks for permission to reach that address.
5. Open [web.plaud.ai](https://web.plaud.ai) in a tab and sign in. The extension lists the recordings Plaud is missing names for; **Dry run** shows what would change.

## What it can reach

| Permission | Why |
| --- | --- |
| `https://web.plaud.ai/*` | Reads your recordings' transcript, polished transcript and summary from inside the Plaud tab, using the tab's own sign-in. |
| Your Applaud address only | Asked for when you pair. The extension's token works on Applaud's `/api/plaud-writeback/*` routes and nothing else. |
| `storage` | Keeps Applaud's address and the extension's token. |

Your Plaud sign-in token is read inside the Plaud tab only when needed. It is never stored by the extension and never sent to Applaud.

**Check the Plaud tab** in the popup reports whether the tab is signed in, which Plaud API address it uses, and the *names* of a few storage keys, never their values. It exists to help diagnose problems.

## Remove

Choose **Unpair** in the popup, or **Remove** next to the extension in Applaud's settings, then remove the extension in `edge://extensions`.
