import { diffChars } from "diff";

export function textareaText(body: string) {
  let value = "";
  const sourceOffsets = [0];
  for (let offset = 0; offset < body.length;) {
    if (body[offset] === "\r") {
      value += "\n";
      offset += body[offset + 1] === "\n" ? 2 : 1;
    } else value += body[offset++];
    sourceOffsets.push(offset);
  }
  return { value, sourceOffsets };
}

export function editorOffset(body: string, sourceOffset: number) {
  return body.slice(0, sourceOffset).replace(/\r\n?/g, "\n").length;
}

export function editExactText(body: string, value: string) {
  const before = textareaText(body);
  if (before.value === value) return body;
  const newline = body.match(/\r\n|\n|\r/)?.[0] ?? "\n";
  const pieces: string[] = [];
  let offset = 0;
  for (const change of diffChars(before.value, value)) {
    if (change.added) pieces.push(change.value.replaceAll("\n", newline));
    else {
      const end = offset + change.value.length;
      if (!change.removed)
        pieces.push(
          body.slice(before.sourceOffsets[offset], before.sourceOffsets[end]),
        );
      offset = end;
    }
  }
  return pieces.join("");
}
