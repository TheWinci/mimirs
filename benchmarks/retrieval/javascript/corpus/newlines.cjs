/** Normalize Windows line endings before computing a content hash. */
export default function (text) {
  return text.replace(/\r\n/g, "\n");
}
