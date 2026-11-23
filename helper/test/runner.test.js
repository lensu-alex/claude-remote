import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanEffort, cleanModel, clip, endsWithQuestion, normalize, splitAnswers, summarize, toUsage } from '../src/runner.js';

test('init line yields the session id and no events', () => {
  const out = normalize({ type: 'system', subtype: 'init', session_id: 'abc' });
  assert.equal(out.sessionId, 'abc');
  assert.deepEqual(out.events, []);
});

test('assistant text and tool calls become events; thinking is dropped', () => {
  const out = normalize(
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'Running the tests.' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test\necho done' } },
          { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/p/app/src/a.ts', old_string: 'x'.repeat(5000) } },
        ],
      },
    },
    '/p/app',
  );
  assert.deepEqual(out.events.map((e) => e.kind), ['text', 'tool', 'tool']);
  assert.equal(out.events[1].body.summary, 'npm test');
  assert.equal(out.events[2].body.summary, 'src/a.ts');
  assert.ok(out.events[2].body.input.old_string.length < 2200);
});

test('tool results are paired by id and clipped', () => {
  const out = normalize({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'y'.repeat(20000) }], is_error: true },
      ],
    },
  });
  assert.equal(out.events[0].kind, 'tool_result');
  assert.equal(out.events[0].body.tool_id, 't1');
  assert.equal(out.events[0].body.is_error, true);
  assert.ok(out.events[0].body.text.length < 6100);
});

test('sub-agent steps are skipped', () => {
  const out = normalize({
    type: 'assistant',
    parent_tool_use_id: 't9',
    message: { content: [{ type: 'text', text: 'inner' }] },
  });
  assert.deepEqual(out.events, []);
});

test('result lines: success, failure, usage limit', () => {
  const ok = normalize({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', duration_ms: 5, num_turns: 2 });
  assert.deepEqual(ok.final, { ok: true, text: 'Done.', limit: false, question: false });
  assert.equal(ok.events[0].kind, 'result');

  const bad = normalize({ type: 'result', subtype: 'error_during_execution', is_error: true });
  assert.equal(bad.final.ok, false);
  assert.equal(bad.events[0].kind, 'error');

  const limit = normalize({ type: 'result', subtype: 'success', is_error: true, result: 'Claude usage limit reached. Your limit will reset at 5pm.' });
  assert.equal(limit.final.limit, true);
  assert.equal(limit.events[0].body.limit, true);
});

test('unknown lines are ignored', () => {
  assert.deepEqual(normalize({ type: 'rate_limit_event' }).events, []);
  assert.deepEqual(normalize(null).events, []);
});

test('clip and summarize helpers', () => {
  assert.equal(clip('short', 10), 'short');
  assert.ok(clip('z'.repeat(100), 20).includes('characters hidden'));
  assert.equal(summarize('WebSearch', { query: 'weather' }), 'weather');
  assert.equal(summarize('Read', { file_path: '/elsewhere/x.md' }, '/p/app'), '/elsewhere/x.md');
});

test('a reply that ends by asking is flagged as a question', () => {
  assert.equal(endsWithQuestion('I fixed it.\n\nShould I also bump the version?'), true);
  assert.equal(endsWithQuestion('Done.\n\n**Want me to commit this?**'), true);
  assert.equal(endsWithQuestion('Why did it fail? Because the port was taken.'), false);
  assert.equal(endsWithQuestion(''), false);
  const out = normalize({ type: 'result', subtype: 'success', is_error: false, result: 'Which folder do you mean?' });
  assert.equal(out.final.question, true);
  assert.equal(out.events[0].body.question, true);
});

test('usage windows are read from the limit report', () => {
  const out = normalize({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed',
      unifiedWindows: {
        five_hour: { utilization: 0.02, resetsAt: 1795371000 },
        seven_day: { utilization: 0.21, resetsAt: 1795525200 },
      },
    },
  });
  assert.deepEqual(out.usage, {
    limited: false,
    five_hour: { used: 0.02, resets_at: '2026-11-22T18:10:00.000Z' },
    seven_day: { used: 0.21, resets_at: '2026-11-24T13:00:00.000Z' },
  });
  assert.equal(toUsage({ status: 'allowed' }), null);
  assert.equal(toUsage({ status: 'rejected' }).limited, true);
});

test('a closing answers line becomes one-tap answers and is not shown', () => {
  assert.deepEqual(splitAnswers('Done.\n\nShould I deploy?\n[[answers: Yes | No | Only the website]]'), {
    text: 'Done.\n\nShould I deploy?',
    answers: ['Yes', 'No', 'Only the website'],
  });
  assert.deepEqual(splitAnswers('No such line here?').answers, []);
  // Only as the last line, at most four, and nothing overlong.
  assert.deepEqual(splitAnswers('[[answers: A | B]]\nmore text').answers, []);
  assert.equal(splitAnswers(`x\n[[answers: 1 | 2 | 3 | 4 | 5 | ${'long '.repeat(20)}]]`).answers.length, 4);

  const reply = normalize({ type: 'assistant', message: { content: [{ type: 'text', text: 'Ready.\n[[answers: Deploy | Wait]]' }] } });
  assert.deepEqual(reply.events[0].body, { text: 'Ready.', answers: ['Deploy', 'Wait'] });

  const end = normalize({ type: 'result', subtype: 'success', is_error: false, result: 'Ready.\n[[answers: Deploy | Wait]]' });
  assert.equal(end.final.text, 'Ready.');
  assert.equal(end.final.question, true);
  assert.deepEqual(end.events[0].body.answers, ['Deploy', 'Wait']);
});

test('only plain model names and known effort levels are accepted', () => {
  assert.equal(cleanModel('opus'), 'opus');
  assert.equal(cleanModel('claude-fable-5-2'), 'claude-fable-5-2');
  assert.equal(cleanModel('--settings'), null);
  assert.equal(cleanModel('a b'), null);
  assert.equal(cleanModel(undefined), null);
  assert.equal(cleanEffort('xhigh'), 'xhigh');
  assert.equal(cleanEffort('extreme'), null);
});
