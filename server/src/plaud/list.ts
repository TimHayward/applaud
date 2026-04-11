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

export async function listAll(pageSize = 50): Promise<PlaudListResponse["data_file_list"]> {
  const out: PlaudListResponse["data_file_list"] = [];
  let skip = 0;
  // Hard cap to avoid infinite loops if the API misbehaves.
  for (let i = 0; i < 200; i++) {
    const page = await listRecordings({ skip, limit: pageSize });
    if (!page.data_file_list || page.data_file_list.length === 0) break;
    out.push(...page.data_file_list);
    if (page.data_file_list.length < pageSize) break;
    skip += pageSize;
  }
  return out;
}
