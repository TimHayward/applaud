# Applaud browser extension

Sends the speaker names you have confirmed in your own Applaud to Plaud, so that Plaud AI uses them. It works through your own Plaud sign-in in the browser.

> **Unofficial.** This extension is not affiliated with, endorsed or supported by Plaud. It changes your recordings in your own Plaud account by doing what the Plaud web app does when you rename a speaker. Use it at your own discretion.

## How a send works

1. **Dry run** reads the recording's transcript, polished transcript and summary from your Plaud tab and shows exactly what would change. Nothing is written.
2. **Send to Plaud** reads Plaud again, has Applaud build the new documents, and writes them in the order the Plaud web app does: transcript, polished transcript, summary. Only names you confirmed in Applaud are sent; automatic matches are not.
3. Each write carries the version of the document it replaces, and Plaud refuses it if the document changed since. The extension also checks the version just before writing.
4. If a send stops part-way (a refusal, a lost connection), sending again completes it: it re-reads Plaud and writes only what is still missing.
5. Applaud keeps the previous version of every document for 30 days. **Undo** (on the result, or under **Recently sent**) restores what the most recent send replaced, and is refused in the same way if Plaud changed since. Undoing again goes back one more send.
6. Applaud's next sync confirms the names in Plaud through Plaud's official API.

One recording at a time. See [the plan](../docs/plans/plaud-write-back-extension.md) for the design.

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
5. Open [web.plaud.ai](https://web.plaud.ai) in a tab and sign in. The extension lists the recordings Plaud is missing names for; **Dry run** shows what would change, and **Send to Plaud** writes it.

## What it can reach

| Permission | Why |
| --- | --- |
| `https://web.plaud.ai/*` | Reads and, when you choose Send or Undo, writes your recordings' transcript, polished transcript and summary from inside the Plaud tab, using the tab's own sign-in. |
| Your Applaud address only | Asked for when you pair. The extension's token works on Applaud's `/api/plaud-writeback/*` routes and nothing else. |
| `storage` | Keeps Applaud's address and the extension's token. |

Your Plaud sign-in token is read inside the Plaud tab only when needed. It is never stored by the extension and never sent to Applaud.

Writes send the same headers the Plaud web app sends, including your device id and workspace id, which the extension reads from the Plaud tab when needed.

**Check the Plaud tab** in the popup reports whether the tab is signed in, which Plaud API address it uses, whether the device and workspace ids were found, and the *names* of a few storage keys, never their values. It exists to help diagnose problems.

## Remove

Choose **Unpair** in the popup, or **Remove** next to the extension in Applaud's settings, then remove the extension in `edge://extensions`.
