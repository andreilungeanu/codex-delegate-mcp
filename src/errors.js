/**
 * An error a caller tells apart by `code`, without parsing the message.
 *
 * @param {string} code
 * @param {string} message
 */
export function codedError(code, message) {
  const err = /** @type {Error & { code: string }} */ (new Error(message));
  err.code = code;
  return err;
}
