/**
 * Minimal multipart/form-data parser (RFC 7578), hand-rolled instead of a
 * dependency like busboy: the room-creation endpoint has exactly one shape
 * (one file field, one text field), and buffering the already-size-capped
 * body in memory before parsing (rather than streaming part-by-part) is
 * simple to get right for that one shape without pulling in a general
 * streaming-multipart library.
 */
export interface MultipartPart {
  name: string;
  filename: string | undefined;
  contentType: string | undefined;
  data: Buffer;
}

/** Extracts the boundary token from a `multipart/form-data; boundary=...` Content-Type header. */
export function parseBoundary(contentType: string | undefined): string | null {
  if (contentType === undefined) return null;
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (match === null) return null;
  return (match[1] ?? match[2] ?? "").trim();
}

function parseHeaders(headerText: string): { name: string | undefined; filename: string | undefined; contentType: string | undefined } {
  let name: string | undefined;
  let filename: string | undefined;
  let contentType: string | undefined;
  for (const line of headerText.split("\r\n")) {
    const [key, ...rest] = line.split(":");
    if (key === undefined) continue;
    const value = rest.join(":").trim();
    if (key.toLowerCase() === "content-disposition") {
      const nameMatch = /name="([^"]*)"/.exec(value);
      const filenameMatch = /filename="([^"]*)"/.exec(value);
      name = nameMatch?.[1];
      filename = filenameMatch?.[1];
    } else if (key.toLowerCase() === "content-type") {
      contentType = value;
    }
  }
  return { name, filename, contentType };
}

/**
 * Splits a full multipart body into its parts. Assumes the whole body is
 * already buffered (caller enforces the upload size cap before this runs).
 */
export function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: MultipartPart[] = [];

  let cursor = body.indexOf(delimiter);
  if (cursor === -1) return parts;

  while (true) {
    const partStart = cursor + delimiter.length;
    // The delimiter is immediately followed by "--" (final boundary) or
    // "\r\n" (another part follows).
    if (body.subarray(partStart, partStart + 2).toString("latin1") === "--") break;

    const next = body.indexOf(delimiter, partStart);
    if (next === -1) break;

    // Part content is between this delimiter's trailing CRLF and the next
    // delimiter's leading CRLF.
    const segment = body.subarray(partStart + 2, next - 2);
    const headerEnd = segment.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      cursor = next;
      continue;
    }
    const headerText = segment.subarray(0, headerEnd).toString("utf8");
    const data = segment.subarray(headerEnd + 4);
    const { name, filename, contentType } = parseHeaders(headerText);
    if (name !== undefined) {
      parts.push({ name, filename, contentType, data: Buffer.from(data) });
    }
    cursor = next;
  }

  return parts;
}
