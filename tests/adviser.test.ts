import { describe, expect, it, vi } from 'vitest';
import {
  ADVISER_QUESTIONS,
  adviceScore,
  adviseCompaction,
  adviserSnapshot,
  choiceProbability,
  floorFor,
  type JevAsker,
  type Message,
} from '../src/index.js';
import { adviceLine } from '../hooks/fast-jev.ts';

function choice(probabilities: Record<string, number>) {
  const best = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]!;
  return { type: 'choice' as const, choice: best[0], confidence: best[1], probabilities };
}

function answers(finished: number, handsOn: number) {
  return {
    answers: {
      done: choice({ finished, not_finished: 1 - finished - 0.0, unclear: 0 }),
      shape: choice({ hands_on: handsOn, coordinating: 1 - handsOn, unclear: 0 }),
    },
  };
}

const transcript: Message[] = [
  { role: 'user', text: 'ship the fix', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'a', tool: 'Bash', input: { command: 'npm test' } }],
  },
  {
    role: 'user',
    text: '',
    toolUses: [],
    toolResults: [{ tool_use_id: 'a', text: 'x'.repeat(5000) }],
  },
  { role: 'assistant', text: 'done, mail antoine@evaneos.com', toolUses: [] },
];

describe('the score', () => {
  it('gates on finished and adds up to half again for hands-on work', () => {
    expect(adviceScore(1, 1)).toBeCloseTo(1);
    expect(adviceScore(1, 0)).toBeCloseTo(0.5);
    expect(adviceScore(0, 1)).toBeCloseTo(0);
    // Unfinished work never clears a floor, however hands-on it is.
    expect(adviceScore(0.2, 1)).toBeLessThan(0.5);
  });

  it('takes a coordination weight, 0 ignoring the shape question', () => {
    expect(adviceScore(0.8, 0, { coordinationWeight: 0 })).toBeCloseTo(0.8);
    expect(adviceScore(0.8, 0, { coordinationWeight: 1 })).toBeCloseTo(0);
  });
});

describe('the sliding floor', () => {
  it('is strict on an empty window and relaxes as it fills', () => {
    expect(floorFor(0)).toBe(0.9);
    expect(floorFor(0.1)).toBe(0.9);
    expect(floorFor(0.5)).toBe(0.7);
    expect(floorFor(0.9)).toBe(0.5);
    expect(floorFor(1)).toBe(0.5);
  });

  it('gives unknown usage the strictest floor', () => {
    expect(floorFor(Number.NaN)).toBe(0.9);
  });

  it('decreases monotonically', () => {
    let previous = 1;
    for (let u = 0; u <= 1.0001; u += 0.05) {
      const floor = floorFor(u);
      expect(floor).toBeLessThanOrEqual(previous);
      previous = floor;
    }
  });

  it('takes a custom profile', () => {
    expect(floorFor(0, { floorWhenEmpty: 0.8 })).toBe(0.8);
    expect(floorFor(1, { floorWhenFull: 0.3 })).toBe(0.3);
  });
});

describe('the snapshot', () => {
  it('masks it, bounds the tail, and abridges tool results', () => {
    const snapshot = adviserSnapshot(transcript, { tailMessages: 2, toolResultBytes: 64 });
    const json = JSON.stringify(snapshot);
    expect(snapshot.recent).toHaveLength(2);
    expect(snapshot.older_messages_omitted).toBe(2);
    expect(json).not.toContain('antoine@evaneos.com');
    expect(json).toContain('[email_1]');
    expect(json).not.toContain('x'.repeat(200));
    expect(json).toContain('omitted');
  });

  it('records whether a tool failed, which is what "finished" hinges on', () => {
    const failed: Message[] = [
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 'a', tool: 'Bash', input: {} }],
      },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: 'boom', isError: true }] },
    ];
    expect(JSON.stringify(adviserSnapshot(failed))).toContain('error: boom');
  });

  it('stays far smaller than a compaction state, and fast: it runs every turn', () => {
    const big: Message[] = Array.from({ length: 200 }, (_, i) => ({
      role: 'assistant' as const,
      text: '',
      toolUses: [{ tool_use_id: `t${i}`, tool: 'Read', input: { file_path: `f${i}.ts` } }],
      toolResults: [{ tool_use_id: `t${i}`, text: 'y'.repeat(20_000) }],
    }));
    const started = Date.now();
    const json = JSON.stringify(adviserSnapshot(big));
    expect(json.length).toBeLessThan(80_000);
    // Masking 200 untruncated 20kB results took 12s; only the kept part is masked.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('still masks a secret sitting right at the truncation boundary', () => {
    const secret = 'ping antoine@evaneos.com now';
    const padded: Message[] = [
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 'a', tool: 'Read', input: {} }],
        toolResults: [{ tool_use_id: 'a', text: `${'z'.repeat(400)}${secret}${'z'.repeat(4000)}` }],
      },
    ];
    const json = JSON.stringify(adviserSnapshot(padded, { toolResultBytes: 128 }));
    expect(json).not.toContain('antoine@evaneos.com');
  });
});

describe('adviseCompaction', () => {
  it('compacts a finished hands-on unit and holds off mid-task', async () => {
    const asker = (f: number, h: number): JevAsker => ({ ask: async () => answers(f, h) });
    const finished = await adviseCompaction(transcript, 0.5, asker(0.95, 0.9));
    expect(finished).toMatchObject({ compact: true, floor: 0.7 });
    const midTask = await adviseCompaction(transcript, 0.5, asker(0.2, 0.9));
    expect(midTask.compact).toBe(false);
  });

  it('lets the same judgment through once the window is fuller', async () => {
    const asker: JevAsker = { ask: async () => answers(0.8, 0.5) };
    // 0.6 score: under the 0.7 floor at half full, over the 0.5 floor at 90%.
    expect((await adviseCompaction(transcript, 0.5, asker)).compact).toBe(false);
    expect((await adviseCompaction(transcript, 0.9, asker)).compact).toBe(true);
  });

  it('sends the two questions and a snapshot, not the whole transcript', async () => {
    const ask = vi.fn(async () => answers(0.9, 0.9));
    await adviseCompaction(transcript, 0.5, { ask });
    const [state, questions] = ask.mock.calls[0]!;
    expect(Object.keys(questions)).toEqual(['done', 'shape']);
    expect(questions).toEqual(ADVISER_QUESTIONS);
    expect(state).toHaveProperty('recent');
  });

  it('never compacts on a judgment it could not get', async () => {
    const advice = await adviseCompaction(transcript, 0.95, {
      ask: async () => {
        throw new Error('Jev request failed (401)');
      },
    });
    expect(advice.compact).toBe(false);
    expect(advice.error).toContain('401');
  });

  it('refuses a malformed distribution rather than scoring it', async () => {
    const advice = await adviseCompaction(transcript, 0.5, {
      ask: async () => ({ answers: { done: { probabilities: { finished: 0.2 } }, shape: choice({ hands_on: 1, coordinating: 0, unclear: 0 }) } }) as never,
    });
    expect(advice.compact).toBe(false);
    expect(advice.error).toContain('sum to 1');
  });

  it('reads a probability only out of a well-formed answer', () => {
    const ok = { done: choice({ finished: 0.7, not_finished: 0.3, unclear: 0 }) };
    expect(choiceProbability(ok, 'done', 'finished')).toBeCloseTo(0.7);
    expect(choiceProbability(ok, 'done', 'missing_option')).toBe(0);
    expect(() => choiceProbability({}, 'done', 'finished')).toThrow('no probabilities');
  });
});

describe('the log line', () => {
  it('says what was decided and on what numbers', async () => {
    const yes = await adviseCompaction(transcript, 0.5, { ask: async () => answers(0.95, 0.9) });
    expect(adviceLine(yes)).toContain('boundary reached');
    expect(adviceLine(yes)).toMatch(/score 0\.9\d vs floor 0\.70/);
    const no = await adviseCompaction(transcript, 0.5, { ask: async () => answers(0.1, 0.1) });
    expect(adviceLine(no)).toContain('mid-task, postponed');
    const failed = await adviseCompaction(transcript, 0.5, {
      ask: async () => {
        throw new Error('offline');
      },
    });
    expect(adviceLine(failed)).toContain('no judgment: offline');
  });
});
