import { plaudJson } from "./client.js";

export interface ContentListItem {
  data_id: string;
  data_type: "transaction" | "outline" | "transaction_polish" | "auto_sum_note" | string;
  task_status: number;
  err_code: string;
  err_msg: string;
  data_title: string;
  data_tab_name: string;
  data_link: string;
}

export interface FileDetailData {
  file_id: string;
  file_name: string;
  file_version: number;
  duration: number;
  is_trash: boolean;
  start_time: number;
  scene: number;
  serial_number: string;
  session_id: number;
  filetag_id_list: string[];
  content_list: ContentListItem[];
  embeddings?: Record<string, unknown>;
  download_path_mapping?: Record<string, string>;
  pre_download_content_list?: unknown[];
  extra_data?: unknown;
  has_thought_partner?: boolean;
}

export interface FileDetailResponse {
  status: number;
  msg: string;
  request_id?: string;
  data: FileDetailData;
}

export async function getFileDetail(id: string): Promise<FileDetailData> {
  const res = await plaudJson<FileDetailResponse>(`/file/detail/${id}`);
  return res.data;
}
