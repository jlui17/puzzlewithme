/**
 * Durable storage for uploaded room images (§6.1.4). A room's image never
 * changes after creation (FR-4), so the interface has no update method.
 */
export interface ImageStore {
  put(id: string, bytes: Buffer, contentType: string): Promise<void>;
  get(id: string): Promise<{ bytes: Buffer; contentType: string } | null>;
  delete?(id: string): Promise<void>;
}
