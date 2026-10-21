/** A problem with an audio file, with the HTTP status and code the library answers with. */
export class AudioError extends Error {
  constructor(
    public readonly status: 415 | 422,
    public readonly code: 'unsupported_audio' | 'audio_unreadable',
    message: string,
  ) {
    super(message);
  }
}
