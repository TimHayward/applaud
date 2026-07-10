import type { RecordingAttachment } from "@applaud/shared";
import { mediaUrl } from "../api.js";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".svg"]);

function isImageAttachment(filename: string): boolean {
  const idx = filename.lastIndexOf(".");
  if (idx === -1) return false;
  return IMAGE_EXTENSIONS.has(filename.slice(idx).toLowerCase());
}

/** Sidebar card: image attachments as a thumbnail grid, other files as download links. */
export function AttachmentsCard({ attachments }: { attachments: RecordingAttachment[] }): JSX.Element | null {
  if (attachments.length === 0) return null;
  const images = attachments.filter((a) => isImageAttachment(a.filename));
  const files = attachments.filter((a) => !isImageAttachment(a.filename));
  return (
    <section className="card p-6">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-on-surface-variant font-label">
        Attachments
      </h2>
      <div className="space-y-4">
        {images.length > 0 && (
          <div className="grid grid-cols-3 gap-2">
            {images.map((a) => (
              <a
                key={a.filename}
                href={mediaUrl(a.url)}
                target="_blank"
                rel="noopener noreferrer"
                className="block aspect-square rounded-lg overflow-hidden bg-surface-container-highest hover:opacity-80 transition-opacity"
                title={a.filename}
              >
                <img src={mediaUrl(a.url)} alt={a.filename} className="w-full h-full object-cover" loading="lazy" />
              </a>
            ))}
          </div>
        )}
        {files.length > 0 && (
          <ul className="space-y-1.5">
            {files.map((a) => (
              <li key={a.filename}>
                <a href={mediaUrl(a.url)} className="text-sm text-primary hover:underline break-all" download>
                  {a.filename}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
