#!/usr/bin/env node
/**
 * bin/poll-commands.js — CLI 진입점(수동 디버깅용). 로직은 lib/poll-commands.js 의 pollOnce().
 *
 * bin/loop.js 가 매 틱 자동 실행하는 것과 별개로, 큐의 다음 1건을 지금 당장 돌려보고
 *   결과를 관찰하고 싶을 때 `node bin/poll-commands.js` 로 단독 실행한다.
 */
import { pollOnce, logLine } from './lib/poll-commands.js'

pollOnce().catch((e) => {
  logLine({ event: 'fatal', error: e.message })
  process.exit(1)
})
