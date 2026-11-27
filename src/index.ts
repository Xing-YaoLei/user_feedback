/**
 * Response body encoder with gzip / br / identity content-coding negotiation.
 *
 * The module is deliberately transport-agnostic: it takes request encoding
 * preferences and the *described* response (status code + headers) plus an
 * asynchronous source of body bytes, and returns either a 406 decision or a
 * new description plus a body stream whose bytes match it.
 *
 * Guarantees that matter to a gateway:
 *
 *  - **Negotiation.** The best acceptable coding wins by q value; ties are
 *    broken by configuration order. `identity` participates as a coding in its
 *    own right (q=1 unless excluded), so `Accept-Encoding: gzip` alone may
 *    still pick `identity` when gzip cannot be applied.
 *  - **Static responses are left alone.** 206 responses and responses that
 *    already carry a `Content-Encoding` are forwarded byte-for-byte, but only
 *    if that existing representation's coding is acceptable; otherwise the
 *    caller gets a 406 before any body bytes are read.
 *  - **Metadata follows the bytes.** When compression really happens, the
 *    stale `Content-Length` is dropped and a strong `ETag` is weakened.
 *    Otherwise length and validator are preserved untouched.
 *  - **Bounded memory.** The upstream is read at the pace of the downstream
 *    consumer through a bounded pipeline; the encoder never buffers the whole
 *    body.
 *  - **No speculative retries.** Once the first compressed byte has been
 *    handed to the caller, an upstream or compressor failure can only abort
 *    this response. Re-encoding would change bytes the caller already
 *    received.
 *  - **Honest completion.** `completion` settles only after the compressors
 *    have written their trailer, so a truncated gzip/br stream can never look
 *    like a complete one.
 */

export {
  ResponseHeaders,
  weakenEtag,
  type HeaderInput,
  type HeaderRecord,
  type HeaderValue,
} from './headers.ts';

export {
  parseAcceptEncoding,
  normalizePreferences,
  qualityFor,
  selectCoding,
  candidateCodings,
  WILDCARD,
  type AcceptEncodingInput,
  type CodingChoice,
  type EncodingPreference,
  type ParsedPreferences,
  type PreferenceEntry,
} from './preferences.ts';

export {
  NotAcceptableError,
  InvalidResponseError,
  BodyAbortedError,
} from './errors.ts';

export {
  encodeResponse,
  createResponseEncoder,
  negotiateResponse,
  type BodyChunk,
  type BodySource,
  type CompressorContext,
  type CompressorFactory,
  type EncodedResponse,
  type EncoderOptions,
  type EncodeRequest,
  type NegotiatedResponse,
  type ResponseBody,
  type ResponseDescription,
  type ResponseEncoder,
} from './encoder.ts';
