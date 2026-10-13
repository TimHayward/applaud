import { useQuery } from "@tanstack/react-query";
import { api, getLanToken, withTicket } from "../api.js";

/**
 * Returns a function that turns a `/media/...` path into a URL the browser can
 * load directly (`<audio>`, `<img>`, download links), or `null` while the
 * signed ticket it needs is still loading.
 *
 * With no LAN token configured there is nothing to sign and paths pass through
 * unchanged. Otherwise one ticket is shared app-wide and renewed once half its
 * lifetime has passed, but only when a new page mounts — never under a page
 * that's open — so an `<audio>` element's src doesn't change mid-playback.
 */
export function useMediaUrl(): ((path: string) => string) | null {
  const needsTicket = getLanToken() !== null;
  const ticket = useQuery({
    queryKey: ["media-ticket"],
    queryFn: api.mediaTicket,
    enabled: needsTicket,
    staleTime: ({ state }) =>
      state.data?.expiresAt ? Math.max(0, (state.data.expiresAt - state.dataUpdatedAt) / 2) : 0,
  });
  if (!needsTicket) return (path) => path;
  if (!ticket.data) return null;
  const t = ticket.data.ticket;
  return (path) => withTicket(path, t);
}
