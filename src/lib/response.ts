const ACKS = [
  'got it.',
  'landed.',
  'captured.',
  'noted.',
  'in your brain.',
  'on it.',
];

const FOLLOWS = [
  'anything else?',
  'keep going.',
  'more?',
  "what's next?",
  "tell me more.",
  null,
  null,
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function craftReply(transcript: string): string {
  const t = transcript.trim();
  if (!t) return "i didn't catch that. try again?";

  const ack = pick(ACKS);
  const follow = pick(FOLLOWS);

  if (t.length < 80) {
    const echo = t.replace(/\.$/, '').toLowerCase();
    return follow ? `${ack} ${echo}. ${follow}` : `${ack} ${echo}.`;
  }

  return follow ? `${ack} ${follow}` : ack;
}
