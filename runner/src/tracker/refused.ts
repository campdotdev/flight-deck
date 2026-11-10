// A Tracker call Linear refused: it answered, and said no, such as for a bad input, a status the team doesn't
// have, or a write the identity may not make. Trying again won't help, so the Outbox reports it as `failed`,
// unlike `TrackerUnavailable`, which leaves the outbox `unwritten` for a later try (spec 1, "Outbox").

export class TrackerRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrackerRefused";
  }
}
