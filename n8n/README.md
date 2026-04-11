# n8n workflows for Applaud

Importable [n8n](https://n8n.io) workflows that consume Applaud webhook events.

## applaud-transcript-email.json

Receives the Applaud webhook, filters for `transcript_ready` events, summarizes the transcript with Claude, and emails the result.

```
Webhook → Config → IF (transcript_ready) → Claude (HTTP) → Email
```

### Import

1. In n8n: **Workflows → Import from File** → pick `applaud-transcript-email.json`.
2. Open the **Config** node and edit the values — this is the only node you need to touch for normal tweaks:
   - `recipient_email` — where the summary is sent
   - `from_email` — SMTP From address
   - `subject_prefix` — prepended to the email subject
   - `claude_model` — e.g. `claude-sonnet-4-6` or `claude-opus-4-6`
   - `max_summary_tokens` — Claude `max_tokens`
3. Assign credentials (one-time):
   - **Summarize with Claude** node → Anthropic API credential
   - **Email Summary** node → SMTP credential
4. **Activate** the workflow, then copy the production webhook URL shown on the Webhook node.
5. In Applaud → **Settings → Webhook**, paste the URL and hit **Test**. The test fires a `transcript_ready`-shaped sample payload so you can inspect every field in n8n's editor before any real recording arrives.

### How the "single-node config" pattern works

The **Config** node is a `Set` node with `includeOtherFields: true`, so it injects user-editable variables alongside the raw webhook body. Downstream nodes reference them two ways:

- Immediately after Config, via `$json.claude_model`, `$json.max_summary_tokens`, etc.
- From anywhere later in the flow, via `$('Config').item.json.recipient_email` — this survives through the Claude HTTP node's response overwriting `$json`.

The original webhook body stays reachable anywhere via `$('Applaud Webhook').item.json.body`, which is how the email subject/footer pulls the recording filename and media URLs.

### Event shape reference

Applaud posts JSON with this shape (see `shared/src/recording.ts`):

```jsonc
{
  "event": "transcript_ready",       // or "audio_ready"
  "recording": { "id", "filename", "start_time_ms", "end_time_ms", "duration_ms", "filesize_bytes", "serial_number" },
  "files":      { "folder", "audio", "transcript", "summary" },
  "http_urls":  { "audio", "transcript", "summary" },
  "content":    { "transcript_text", "summary_markdown" }  // transcript_ready only
}
```

The `applaud.test` button on the Settings page posts a fully-populated sample of the above (with `test: true` and an `x-applaud-test: 1` header) so n8n's field mapper sees every key up front.
