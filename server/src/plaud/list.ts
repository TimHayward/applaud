import type { PlaudListResponse } from "@applaud/shared";
import { plaudJson } from "./client.js";

export interface ListOptions {
  skip?: number;
  limit?: number;
  sortBy?: "start_time" | "edit_time";
  isDesc?: boolean;
  isTrash?: 0 | 1 | 2;
}

export async function listRecordings(
  opts: ListOptions = {},
): Promise<PlaudListResponse> {
  const skip = opts.skip ?? 0;
  const limit = opts.limit ?? 50;
  const sortBy = opts.sortBy ?? "start_time";
  const isDesc = opts.isDesc ?? true;
  const isTrash = opts.isTrash ?? 2;
  const q = new URLSearchParams({
    skip: String(skip),
    limit: String(limit),
    is_trash: String(isTrash),
    sort_by: sortBy,
    is_desc: String(isDesc),
  });
  return plaudJson<PlaudListResponse>(`/file/simple/web?${q.toString()}`);
}
