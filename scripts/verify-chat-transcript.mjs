#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain node script, no TS annotations available */
/**
 * Behaviour lock for the Chat-mode transcript normalizer
 * (`src/main/chat-transcript.ts`), the pure half of chat-manager.
 *
 * The repo has no test runner, so this is a plain node script in the same
 * shape as `verify-keymap.mjs` / `verify-pty-replay.mjs`, wired as
 * `npm run verify:chat`.
 *
 * The fixture lines mirror the REAL transcript shapes observed in
 * ~/.claude/projects (entry types, block layouts, wrapper tags), because the
 * whole point of the module is that CC's internal format is absorbed here and
 * never crosses the wire.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const {
  CHAT_TEXT_MAX,
  CHAT_THINKING_MAX,
  CHAT_TOOL_INPUT_MAX,
  CHAT_TOOL_RESULT_MAX,
  cleanUserText,
  encodeProjectDir,
  parseTranscriptChunk,
  parseTranscriptLine,
  summarizeToolInput
} = await import(join(repoRoot, 'src', 'main', 'chat-transcript.ts'))

let failures = 0
function check(condition, message) {
  if (!condition) {
    failures++
    console.error(`  FAIL  ${message}`)
  } else {
    console.log(`  ok    ${message}`)
  }
}

const line = (obj) => JSON.stringify(obj)
const TS = '2026-08-17T14:45:20.383Z'
const TS_MS = Date.parse(TS)

console.log('project dir encoding')
{
  check(
    encodeProjectDir('/Users/hunter/XcodeProjects/clave') === '-Users-hunter-XcodeProjects-clave',
    'slashes become dashes'
  )
  check(encodeProjectDir('/opt/my.app/v2.1') === '-opt-my-app-v2-1', 'dots become dashes too')
}

console.log('user turns')
{
  const events = parseTranscriptLine(
    line({
      type: 'user',
      uuid: 'u1',
      timestamp: TS,
      message: { role: 'user', content: 'fix the bug' }
    }),
    '0'
  )
  check(events.length === 1, 'a plain user prompt yields one event')
  check(
    events[0].id === 'u1#0' && events[0].role === 'user' && events[0].kind === 'text',
    'with uuid-anchored id, user role, text kind'
  )
  check(events[0].ts === TS_MS, 'timestamp parsed to epoch ms')
  check(events[0].text === 'fix the bug', 'body carried verbatim')
}
{
  const raw =
    'real question <system-reminder>injected context the user never typed</system-reminder> tail'
  check(
    cleanUserText(raw) === 'real question  tail'.replace(/\s+/g, ' ').trim() ||
      cleanUserText(raw) === 'real question tail' ||
      cleanUserText(raw) === 'real question  tail',
    'system-reminder blocks are stripped from user text'
  )
  const events = parseTranscriptLine(
    line({
      type: 'user',
      uuid: 'u2',
      timestamp: TS,
      message: { content: '<system-reminder>only injected</system-reminder>' }
    }),
    '0'
  )
  check(events.length === 0, 'a turn that is injected-only yields nothing')
}
{
  const events = parseTranscriptLine(
    line({
      type: 'user',
      uuid: 'u3',
      timestamp: TS,
      message: {
        content:
          '<command-name>/clear</command-name><command-message>clear</command-message><command-args></command-args>'
      }
    }),
    '0'
  )
  check(
    events.length === 1 && events[0].text === '/clear',
    'a slash command renders as the command itself'
  )
}
{
  const events = parseTranscriptLine(
    line({
      type: 'user',
      uuid: 'u4',
      timestamp: TS,
      message: { content: '[Request interrupted by user]' }
    }),
    '0'
  )
  check(
    events.length === 1 && events[0].kind === 'meta' && events[0].role === 'system',
    'an interrupt renders as a meta event, never as words the user said'
  )
}
{
  const events = parseTranscriptLine(
    line({
      type: 'user',
      uuid: 'u5',
      timestamp: TS,
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_A', is_error: false, content: 'it worked' },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_B',
            is_error: true,
            content: [{ type: 'text', text: 'boom' }, { type: 'image' }]
          }
        ]
      }
    }),
    '0'
  )
  check(events.length === 2, 'each tool_result block yields one event')
  check(
    events[0].kind === 'tool_result' &&
      events[0].toolUseId === 'toolu_A' &&
      events[0].isError === undefined,
    'success result carries its correlation id and no error flag'
  )
  check(
    events[1].isError === true && events[1].text === 'boom\n[image]',
    'error flag survives; images are named, never carried'
  )
  check(events[1].id === 'u5#1', 'block index ids blocks within one entry')
}
{
  const events = parseTranscriptLine(
    line({
      type: 'user',
      uuid: 'u6',
      timestamp: TS,
      message: {
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', source: { data: 'AAAA' } }
        ]
      }
    }),
    '0'
  )
  check(
    events.length === 2 && events[1].text === '[image]',
    'a pasted image becomes a marker, not megabytes'
  )
}

console.log('assistant turns')
{
  const events = parseTranscriptLine(
    line({
      type: 'assistant',
      uuid: 'a1',
      timestamp: TS,
      message: {
        role: 'assistant',
        model: 'claude-sonnet-5',
        content: [
          { type: 'thinking', thinking: 'let me think' },
          { type: 'text', text: 'here is the answer' },
          {
            type: 'tool_use',
            id: 'toolu_C',
            name: 'Bash',
            input: { command: 'ls -la', description: 'List files' }
          }
        ]
      }
    }),
    '0'
  )
  check(events.length === 3, 'thinking + text + tool_use each yield an event')
  check(
    events[0].kind === 'thinking' && events[0].model === 'claude-sonnet-5',
    'thinking event, model attached'
  )
  check(events[1].kind === 'text' && events[1].text === 'here is the answer', 'text event')
  check(
    events[2].kind === 'tool_use' &&
      events[2].toolName === 'Bash' &&
      events[2].toolUseId === 'toolu_C',
    'tool_use carries name and correlation id'
  )
  check(events[2].text === 'ls -la', 'tool input summarized by its most telling field')
  check(events[0].id === 'a1#0' && events[2].id === 'a1#2', 'block ids are stable within the entry')
}
{
  check(
    summarizeToolInput({ file_path: '/tmp/x.ts' }) === '/tmp/x.ts',
    'summarize prefers file_path when no command'
  )
  check(summarizeToolInput({ weird: 1 }) === '{"weird":1}', 'summarize falls back to compact JSON')
  check(summarizeToolInput(null) === '', 'summarize tolerates a missing input')
}

console.log('truncation')
{
  const big = 'x'.repeat(CHAT_TEXT_MAX + 500)
  const events = parseTranscriptLine(
    line({ type: 'user', uuid: 'u7', timestamp: TS, message: { content: big } }),
    '0'
  )
  check(
    events[0].text.length === CHAT_TEXT_MAX && events[0].truncated === true,
    `user text capped at ${CHAT_TEXT_MAX} with the flag set`
  )
  const events2 = parseTranscriptLine(
    line({
      type: 'assistant',
      uuid: 'a2',
      timestamp: TS,
      message: { content: [{ type: 'thinking', thinking: 'y'.repeat(CHAT_THINKING_MAX + 10) }] }
    }),
    '0'
  )
  check(events2[0].text.length === CHAT_THINKING_MAX, 'thinking capped tighter')
  const events3 = parseTranscriptLine(
    line({
      type: 'assistant',
      uuid: 'a3',
      timestamp: TS,
      message: {
        content: [
          {
            type: 'tool_use',
            id: 't',
            name: 'Bash',
            input: { command: 'z'.repeat(CHAT_TOOL_INPUT_MAX + 10) }
          }
        ]
      }
    }),
    '0'
  )
  check(events3[0].text.length === CHAT_TOOL_INPUT_MAX, 'tool input capped')
  const events4 = parseTranscriptLine(
    line({
      type: 'user',
      uuid: 'u8',
      timestamp: TS,
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 't', content: 'w'.repeat(CHAT_TOOL_RESULT_MAX + 10) }
        ]
      }
    }),
    '0'
  )
  check(
    events4[0].text.length === CHAT_TOOL_RESULT_MAX && events4[0].truncated === true,
    'tool result capped'
  )
}

console.log('filtering')
{
  const sidechain = parseTranscriptLine(
    line({
      type: 'assistant',
      uuid: 's1',
      isSidechain: true,
      timestamp: TS,
      message: { content: [{ type: 'text', text: 'worker chatter' }] }
    }),
    '0'
  )
  check(sidechain.length === 0, 'sidechain (subagent) traffic never reaches the chat')
  const meta = parseTranscriptLine(
    line({
      type: 'user',
      uuid: 'm1',
      isMeta: true,
      timestamp: TS,
      message: { content: 'synthetic' }
    }),
    '0'
  )
  check(meta.length === 0, 'isMeta user entries are skipped')
  for (const type of [
    'attachment',
    'system',
    'ai-title',
    'queue-operation',
    'file-history-snapshot',
    'last-prompt',
    'bridge-session',
    'mode'
  ]) {
    const events = parseTranscriptLine(line({ type, uuid: 'k1', sessionId: 's' }), '0')
    if (events.length !== 0) {
      check(false, `known type "${type}" is skipped silently`)
    }
  }
  check(true, 'every known non-chat entry type is skipped silently')
}

console.log('degrade signals')
{
  const events = parseTranscriptLine(line({ type: 'holographic-turn', uuid: 'n1' }), '0')
  check(
    events.length === 1 && events[0].kind === 'unknown' && events[0].text === 'holographic-turn',
    'a never-seen entry type surfaces as kind unknown naming itself'
  )
  const events2 = parseTranscriptLine(
    line({ type: 'permission-mode', permissionMode: 'plan', sessionId: 's' }),
    '77'
  )
  check(
    events2.length === 1 &&
      events2[0].kind === 'meta' &&
      events2[0].text === 'Permission mode: plan',
    'permission-mode renders as a meta line'
  )
  check(events2[0].id === 'line-77#0', 'entries with no uuid get the offset-anchored fallback id')
  check(
    parseTranscriptLine('not json at all', '0').length === 0,
    'garbage lines are skipped, not fatal'
  )
  check(parseTranscriptLine('', '0').length === 0, 'blank lines are skipped')
  check(parseTranscriptLine('[1,2,3]', '0').length === 0, 'non-object JSON is skipped')
}

console.log('chunk parsing')
{
  const a = line({ type: 'user', uuid: 'c1', timestamp: TS, message: { content: 'first' } })
  const b = line({ type: 'user', uuid: 'c2', timestamp: TS, message: { content: 'second' } })
  const partialTail = '{"type":"user","uuid":"c3"'
  const { events, partial } = parseTranscriptChunk(`${a}\n${b}\n${partialTail}`, 0)
  check(
    events.length === 2 && events[0].text === 'first' && events[1].text === 'second',
    'complete lines parse in order'
  )
  check(partial === partialTail, 'the trailing partial line is returned for the next drain')
}
{
  // Fallback ids must be byte-stable so a backfill and the live tail agree.
  const multibyte = line({ type: 'permission-mode', permissionMode: 'plan…', sessionId: 's' })
  const second = line({ type: 'permission-mode', permissionMode: 'default', sessionId: 's' })
  const both = parseTranscriptChunk(`${multibyte}\n${second}\n`, 100)
  const expectedSecondOffset = 100 + Buffer.byteLength(multibyte, 'utf-8') + 1
  check(
    both.events[1].id === `line-${expectedSecondOffset}#0`,
    'fallback ids advance by BYTES, surviving multibyte lines'
  )
}
{
  const { events, partial } = parseTranscriptChunk('no newline yet', 0)
  check(
    events.length === 0 && partial === 'no newline yet',
    'a chunk with no newline is all partial'
  )
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
