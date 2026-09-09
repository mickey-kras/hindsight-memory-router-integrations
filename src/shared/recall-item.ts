export interface RecallItem {
  id?: string;
  content?: string;
  text?: string;
  score?: number;
  type?: string;
  [key: string]: unknown;
}

export function recallItemText(item: RecallItem): string {
  const value = item.text ?? item.content;
  return typeof value === "string" ? value : JSON.stringify(item);
}
