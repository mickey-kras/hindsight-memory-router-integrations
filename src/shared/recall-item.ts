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

export function formatRecallItem(item: RecallItem): string {
  const type = typeof item.type === "string" ? ` [${item.type}]` : "";
  const doc = typeof item.document_id === "string" ? ` [doc:${item.document_id}]` : "";
  return `- ${recallItemText(item)}${type}${doc}`;
}
